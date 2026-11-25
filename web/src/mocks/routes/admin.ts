// Admin workspace. Numbers are derived from the fixtures plus a fixed wave, so charts look alive and stay stable.

import type { AccountRow, AdminRun, AdminSettings, Disposition, OversightClass, Permission, Role, RxOutcome, UsageDay } from "../../api/types.ts";
import { addDays } from "../../lib/format.ts";
import { uuid } from "../../lib/ids.ts";
import { ROLE_PERMISSIONS } from "../../lib/permissions.ts";
import { badField, checkRevision, created, DONE, fail, must, ok, page, personOr, type Route, route, type UserCtx } from "../core.ts";
import type { AccountRec } from "../db.ts";
import { CLASSES, DRUGS, formulary, L, protocolSet, RED_FLAG_ROWS, REFILL_ROWS, SCOPE_ROWS } from "../rules.ts";
import { audit, todayOf } from "../views.ts";
import { evalSummary, removeAccount } from "./account.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const ROLES: readonly Role[] = ["patient", "physician", "pharmacist", "coordinator", "admin"];
const PERMISSION_TEXT: Record<Permission, [string, string, string, string]> = {
  "visit.own": ["自己的預問診", "Own previsits", "建立、查看自己的預問診。", "Create and read their own previsits."],
  "rx.own": ["自己的用藥與申請", "Own medicines and requests", "查看用藥、送出領藥預約與續開申請。", "See medicines, send refill and renewal requests."],
  "profile.own": ["自己的健康檔案", "Own health profile", "維護自己的病史、過敏與量測。", "Keep their own history, allergies and readings."],
  "appt.own": ["自己的約診", "Own appointments", "預約與取消。", "Book and cancel."],
  "visit.read": ["讀取預問診", "Read previsits", "讀取病人的預問診，每次讀取都會留下紀錄。", "Read patients' previsits; every read is logged."],
  "visit.review": ["審閱預問診", "Review previsits", "編寫筆記、指派、整理清單。", "Write notes, assign, work the list."],
  "note.sign": ["簽署筆記", "Sign notes", "簽署後鎖定，並通知病人。", "Signing locks the note and notifies the patient."],
  "thread.reply": ["回覆對話", "Reply in threads", "接手對話並回覆病人。", "Take over and answer patients."],
  "ticket.handle": ["處理轉交單", "Handle tickets", "查看與結案。", "See and resolve."],
  "patient.read": ["讀取病人資料", "Read patient records", "藥師只看得到用藥與過敏。", "Pharmacists only see medicines and allergies."],
  "patient.manage": ["管理病人", "Manage patients", "標籤、追蹤狀態、備註、聯絡。", "Tags, care status, notes, contact."],
  "appt.manage": ["管理門診表", "Manage the schedule", "查看與安排門診。", "See and arrange clinics."],
  "rx.read": ["讀取申請", "Read requests", "查看送出後的申請。", "See requests after they are sent."],
  "rx.decide": ["決定續開", "Decide renewals", "逐項同意、不同意、回診或補充。", "Decide each item."],
  "rx.dispense": ["調劑", "Dispense", "核對、備藥、確認領藥、退回。", "Check, prepare, hand out, return."],
  "account.manage": ["管理帳號", "Manage accounts", "新增、停用、改角色、重設密碼。", "Add, disable, change role, reset password."],
  "settings.manage": ["系統設定", "Settings", "AI、額度、時限與保留天數。", "AI, limits, deadlines, retention."],
  "audit.read": ["稽核紀錄", "Audit log", "查看操作與讀取紀錄。", "See actions and reads."],
  "oversight.read": ["監督指標", "Oversight", "引擎與醫師的一致率。", "Agreement between engine and doctors."],
  "rules.read": ["規則", "Rules", "查看紅旗、慢箋、續方協定與藥品範圍。", "See all rule sets."],
  "demo.reset": ["重設示範資料", "Reset demo data", "重建示範病人與申請。", "Rebuild demo patients and requests."],
};

const accountRow = (c: UserCtx, a: AccountRec): AccountRow => ({
  id: a.id,
  username: a.username,
  display_name: L(c.locale, a.display_name, a.display_name_en),
  role: a.role,
  title: a.title,
  status: a.status,
  is_guest: a.is_guest,
  is_demo: a.is_demo,
  created_at: a.created_at,
  last_login_at: a.last_login_at,
  sessions: c.db.sessions.filter((s) => s.account_id === a.id).length,
});
const oneTime = () => `mock-${uuid().slice(0, 8)}`;

function series(c: UserCtx, days: number): UsageDay[] {
  const today = todayOf(c.now);
  return Array.from({ length: days }, (_, i): UsageDay => {
    const day = addDays(today, i - days + 1);
    const weekend = [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());
    const wave = Math.abs(Math.sin(i * 1.3) * 7 + Math.cos(i * 0.5) * 4);
    const visits = Math.round((weekend ? 4 : 13) + wave);
    const model_calls = visits * 9 + (i % 5);
    const input_tokens = model_calls * 2350;
    const output_tokens = model_calls * 150;
    return { day, visits, model_calls, input_tokens, output_tokens, cost_usd: Number(((input_tokens * 0.1 + output_tokens * 0.4) / 1e6).toFixed(4)), red_flags: i % 4 === 1 ? 1 : i % 9 === 0 ? 2 : 0, rx: Math.round((weekend ? 1 : 5) + wave / 3) };
  });
}

const runRows = (c: UserCtx): AdminRun[] =>
  c.db.visits
    .flatMap((v) =>
      v.runs.map((r): AdminRun => ({
        ...r,
        visit_id: v.id,
        cost_usd: Number(((r.usage.input_tokens * 0.1 + r.usage.output_tokens * 0.4) / 1e6).toFixed(6)),
        tools: v.tool_calls.filter((t) => t.run_id === r.id).map((t) => ({ name: t.name, source: t.source, status: t.status, step: t.step, duration_ms: t.duration_ms })),
      })),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

function oversightClass(c: UserCtx, classId: string, i: number): OversightClass | null {
  const items = c.db.rx
    .filter((r) => r.kind === "renewal" && r.submitted_at)
    .flatMap((r) => r.items)
    .filter((x) => {
      const p = c.db.prescriptions.find((y) => y.id === x.prescription_id);
      return DRUGS.get(p?.drug_id ?? "")?.class_id === classId;
    });
  // Earlier months, so the share of 250 reviews per class is visible.
  const before = [48, 31, 22, 9, 64, 57, 18, 6, 4, 27, 12, 35, 29, 8, 14, 11][i] ?? 5;
  const engine: Record<Disposition, number> = { ready: Math.round(before * 0.52), review: Math.round(before * 0.31), in_person: Math.round(before * 0.13), urgent: Math.round(before * 0.02), excluded: 0 };
  const decisions: Record<RxOutcome, number> = { approve: Math.round(before * 0.7), decline: Math.round(before * 0.05), visit_required: Math.round(before * 0.14), more_info: Math.round(before * 0.08) };
  for (const x of items) {
    if (x.engine) engine[x.engine.disposition] += 1;
    if (x.decision) decisions[x.decision.outcome] += 1;
  }
  const decided = decisions.approve + decisions.decline + decisions.visit_required;
  const agreed = Math.min(engine.ready, decisions.approve) + Math.min(engine.in_person + engine.urgent, decisions.visit_required + decisions.decline);
  return { class_id: classId, class: L(c.locale, CLASSES.get(classId)!.title_zh, CLASSES.get(classId)!.title_en), total: before + items.length, engine, decisions, agreement_rate: decided ? Number((agreed / decided).toFixed(3)) : null, review_decided: Math.min(engine.review, decided), threshold_total: 250 };
}

export const adminRoutes: Route[] = [
  route("GET /admin/overview", ["oversight.read"], (c) => {
    const days = Math.min(90, Math.max(1, Number(c.q("days")) || 14));
    const rows = series(c, days);
    const sum = (k: Exclude<keyof UsageDay, "day">) => Number(rows.reduce((n, r) => n + r[k], 0).toFixed(4));
    return ok({
      totals: { visits: sum("visits"), model_calls: sum("model_calls"), input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"), cost_usd: sum("cost_usd"), red_flags: sum("red_flags"), rx: sum("rx"), patients: c.db.accounts.filter((a) => a.role === "patient" && !a.is_guest).length, guests: c.db.accounts.filter((a) => a.is_guest).length, staff: c.db.accounts.filter((a) => a.role !== "patient").length, month_cost_usd: Number((sum("cost_usd") * 1.6).toFixed(2)), month_budget_usd: c.db.settings.ai.monthly_budget_usd, calls_today: rows.at(-1)?.model_calls ?? 0, daily_call_limit: c.db.settings.ai.daily_call_limit },
      series: rows,
      queues: {
        visits_pending: c.db.visits.filter((v) => v.status === "submitted").length,
        red_flag: c.db.visits.filter((v) => v.status === "red_flag").length,
        rx_review: c.db.rx.filter((r) => r.status === "submitted" || r.status === "in_review").length,
        rx_overdue: c.db.rx.filter((r) => (r.status === "submitted" || r.status === "in_review") && r.sla_due_at !== null && r.sla_due_at < c.now).length,
        rx_more_info: c.db.rx.filter((r) => r.status === "more_info").length,
        rx_pharmacy: c.db.rx.filter((r) => ["at_pharmacy", "ready"].includes(r.status)).length,
        tickets_open: c.db.tickets.filter((t) => t.status === "open").length,
      },
      system: { version: "0.2.0-mock", model_ready: true, uptime_s: 273_640, db_ok: true, ai_enabled: c.db.settings.ai.enabled },
    });
  }),

  route("GET /admin/accounts", ["account.manage"], (c) => {
    const q = (c.q("q") ?? "").toLowerCase();
    return page(
      c,
      c.db.accounts
        .filter((a) => (!c.q("role") || a.role === c.q("role")) && (!c.q("status") || a.status === c.q("status")) && (!q || `${a.username ?? ""} ${a.display_name} ${a.display_name_en}`.toLowerCase().includes(q)))
        .sort((a, b) => ROLES.indexOf(b.role) - ROLES.indexOf(a.role) || a.created_at.localeCompare(b.created_at))
        .map((a) => accountRow(c, a)),
    );
  }),
  route("POST /admin/accounts", ["account.manage"], (c) => {
    const username = str(c.body.username).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username)) badField("username", L(c.locale, "只能用英文字母、數字和 . _ -，3 到 32 個字元。", "3 to 32 letters, digits or . _ -"));
    if (c.db.accounts.some((a) => a.username === username)) badField("username", L(c.locale, "這個帳號名稱已經有人使用。", "That username is already taken."));
    const role = ROLES.find((r) => r === c.body.role) ?? badField("role", "role");
    const display_name = str(c.body.display_name).trim();
    if (!display_name) badField("display_name", L(c.locale, "這一欄要填。", "Required."));
    const a: AccountRec = { id: uuid(), username, display_name, display_name_en: display_name, role, title: str(c.body.title) || null, title_en: str(c.body.title) || null, avatar: null, status: "active", is_guest: false, is_demo: false, locale: "zh-TW", preferences: {}, must_change_password: true, created_at: c.now, last_login_at: null, expires_at: null };
    c.db.accounts.push(a);
    audit(c, "admin", "account.create", `account:${username}`, { role });
    return created({ account: accountRow(c, a), password: oneTime() });
  }),
  route("GET /admin/accounts/:id", ["account.manage"], (c) => ok({ account: accountRow(c, must(c.db.accounts.find((a) => a.id === c.params.id))) })),
  route("PATCH /admin/accounts/:id", ["account.manage"], (c) => {
    const a = must(c.db.accounts.find((x) => x.id === c.params.id));
    const self = a.id === c.account.id;
    const lastAdmin = a.role === "admin" && c.db.accounts.filter((x) => x.role === "admin" && x.status === "active").length === 1;
    const losing = (c.body.status === "disabled" && a.status === "active") || (c.body.role !== undefined && c.body.role !== a.role);
    if (losing && (self || lastAdmin)) fail("invalid_state");
    if (typeof c.body.display_name === "string" && c.body.display_name.trim()) a.display_name = c.body.display_name.trim();
    if ("title" in c.body) a.title = str(c.body.title) || null;
    const role = ROLES.find((r) => r === c.body.role);
    if (role && role !== a.role) {
      a.role = role;
      c.db.sessions = c.db.sessions.filter((s) => s.account_id !== a.id);
    }
    if (c.body.status === "active" || c.body.status === "disabled") {
      a.status = c.body.status;
      if (a.status === "disabled") c.db.sessions = c.db.sessions.filter((s) => s.account_id !== a.id);
    }
    audit(c, "admin", "account.update", `account:${a.username ?? a.id}`, { changed: Object.keys(c.body) });
    return ok({ account: accountRow(c, a) });
  }),
  route("POST /admin/accounts/:id/reset-password", ["account.manage"], (c) => {
    const a = must(c.db.accounts.find((x) => x.id === c.params.id));
    a.must_change_password = true;
    c.db.sessions = c.db.sessions.filter((s) => s.account_id !== a.id || s.token === c.session.token);
    audit(c, "admin", "account.reset_password", `account:${a.username ?? a.id}`);
    return ok({ account: accountRow(c, a), password: oneTime() });
  }),
  route("POST /admin/accounts/:id/revoke-sessions", ["account.manage"], (c) => {
    const a = must(c.db.accounts.find((x) => x.id === c.params.id));
    c.db.sessions = c.db.sessions.filter((s) => s.account_id !== a.id || s.token === c.session.token);
    audit(c, "admin", "account.revoke_sessions", `account:${a.username ?? a.id}`);
    return DONE;
  }),

  route("GET /admin/permissions", ["account.manage"], (c) =>
    ok({
      roles: ROLES,
      permissions: (Object.keys(PERMISSION_TEXT) as Permission[]).map((id) => {
        const [lz, le, dz, de] = PERMISSION_TEXT[id];
        return { id, label: L(c.locale, lz, le), description: L(c.locale, dz, de) };
      }),
      matrix: ROLE_PERMISSIONS,
    }),
  ),

  route("GET /admin/settings", ["settings.manage"], (c) => ok(c.db.settings)),
  route("PUT /admin/settings", ["settings.manage"], (c) => {
    checkRevision(c, c.db.settings.revision, () => c.db.settings);
    const next = c.body as unknown as AdminSettings;
    if (!(next.ai?.temperature >= 0 && next.ai.temperature <= 2)) badField("ai.temperature", L(c.locale, "要在 0 到 2 之間。", "Between 0 and 2."));
    if (!(next.retention_days >= 1)) badField("retention_days", L(c.locale, "至少 1 天。", "At least 1 day."));
    c.db.settings = { ...next, revision: c.db.settings.revision + 1, rx: { ...next.rx, oversight_phase: 1 } };
    audit(c, "admin", "settings.update", "settings");
    return ok(c.db.settings);
  }),
  route("GET /admin/models", ["settings.manage"], () => ok({ items: ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.1-flash-lite"] })),

  route("GET /admin/oversight", ["oversight.read"], (c) => {
    const by_class = c.server.config.empty ? [] : [...CLASSES.keys()].map((id, i) => oversightClass(c, id, i)).filter((x) => x !== null);
    return ok({
      phase: 1,
      by_class,
      turnaround: { median_h: 9.4, p90_h: 31.2 },
      returned_rate: 0.034,
      red_flags: [
        { category: "chest_pain", label: L(c.locale, "胸痛或胸悶", "Chest pain or tightness"), n: 7 },
        { category: "dyspnea", label: L(c.locale, "呼吸困難", "Difficulty breathing"), n: 5 },
        { category: "gi_bleeding", label: L(c.locale, "消化道出血", "Gastrointestinal bleeding"), n: 3 },
        { category: "stroke", label: L(c.locale, "疑似中風", "Possible stroke"), n: 2 },
        { category: "suicide", label: L(c.locale, "自傷念頭", "Thoughts of self-harm"), n: 1 },
      ],
      guard: [
        { kind: "dosage", n: 6 },
        { kind: "diagnosis", n: 4 },
        { kind: "prescribing", n: 2 },
        { kind: "other", n: 1 },
      ],
    });
  }),
  route("GET /admin/runs", ["audit.read"], (c) => page(c, runRows(c).filter((r) => (!c.q("status") || r.status === c.q("status")) && (!c.q("model") || r.model === c.q("model"))))),
  route("GET /admin/runs/:id", ["audit.read"], (c) => ok({ ...must(runRows(c).find((r) => r.id === c.params.id)), guard: [] })),
  route("GET /admin/audit", ["audit.read"], (c) => {
    const actor = c.q("actor");
    const action = c.q("action");
    const kind = c.q("kind");
    return page(
      c,
      c.db.audit
        .slice()
        .sort((a, b) => b.at.localeCompare(a.at))
        .map(({ actor_id, patient_id: _p, ...a }) => ({ ...a, actor: personOr(c.db, actor_id, c.locale) }))
        .filter((a) => (!actor || a.actor.id === actor) && (!action || a.action === action) && (!kind || a.kind === kind) && (!c.q("from") || a.at >= `${c.q("from")}`) && (!c.q("to") || a.at <= `${c.q("to")}T24`)),
    );
  }),
  route("GET /admin/rules", ["rules.read"], (c) =>
    ok({
      red_flags: RED_FLAG_ROWS.map((r) => ({ id: r.id, category: r.category, severity: r.severity, lang: r.lang, label: L(c.locale, r.label_zh, r.label_en), pattern: r.pattern, note: r.note })),
      scope: SCOPE_ROWS.map((r) => ({ id: r.id, verdict: r.verdict, lang: r.lang, pattern: r.pattern, note: r.note })),
      refill: REFILL_ROWS.map((r) => ({ key: r.key, value: r.value, unit: r.unit, text: L(c.locale, r.text_zh, r.text_en), source_url: r.source_url, verified_on: r.verified_on })),
      protocols: protocolSet(c.locale),
      formulary: formulary(c.locale),
    }),
  ),
  route("GET /admin/eval", ["rules.read"], (c) => ok({ latest: evalSummary(c.now, 0), history: [0, 2, 5, 9].map((d) => evalSummary(c.now, d)) })),
  route("POST /admin/demo/reset", ["demo.reset"], (c) => {
    if (c.body.confirm !== "RESET") badField("confirm", L(c.locale, "請輸入 RESET 確認。", "Type RESET to confirm."));
    for (const g of c.db.accounts.filter((a) => a.is_guest)) removeAccount(c.db, g.id);
    c.server.file.reset(true);
    return DONE;
  }),
];
