// Refill and renewal requests.

import type { PharmacyAction, PharmacyChecks, RxBucket, RxOutcome, RxPatch, RxStatus } from "../../api/types.ts";
import { uuid } from "../../lib/ids.ts";
import { identityKey, isEditableRx, isOpenRx, missingForSubmit } from "../../lib/rx.ts";
import { badField, can, checkRevision, created, fail, must, ok, page, type Route, route, type UserCtx } from "../core.ts";
import type { RxRec } from "../db.ts";
import { evaluateItem, evaluateRequest, medicationCard } from "../engine.ts";
import { DRUGS, L } from "../rules.ts";
import { PHARMACY_SEED } from "../rules.ts";
import { audit, isStaff, lastSeenDays, logAccess, notify, notifyStaff, openTicket, rxBrief, rxChanged, rxEvent, rxView, todayOf } from "../views.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function rxFor(c: UserCtx, log = false): RxRec {
  const r = must(c.db.rx.find((x) => x.id === c.params.id));
  if (r.patient_id === c.account.id) return r;
  if (!isStaff(c.account) || r.status === "draft") return fail("not_found");
  if (!can(c.account, "rx.read")) return fail("forbidden");
  if (log) logAccess(c, r.patient_id, "rx.read", `rx:${r.id}`, r.kind === "refill" ? "領藥預約" : "續開申請");
  return r;
}
function ownRx(c: UserCtx): RxRec {
  const r = must(c.db.rx.find((x) => x.id === c.params.id));
  return r.patient_id === c.account.id ? r : fail("not_found");
}
const lock = (c: UserCtx, r: RxRec) => checkRevision(c, r.revision, () => rxView(c, r));
const drugOf = (c: UserCtx, prescriptionId: string) => {
  const p = c.db.prescriptions.find((x) => x.id === prescriptionId);
  return p ? DRUGS.get(p.drug_id) : undefined;
};

function runEngine(c: UserCtx, r: RxRec): void {
  const today = todayOf(c.now);
  const seen = lastSeenDays(c.db, r.patient_id, today);
  for (const i of r.items) {
    const p = c.db.prescriptions.find((x) => x.id === i.prescription_id);
    if (r.kind === "renewal") i.engine = evaluateItem(p?.drug_id ?? "", r.answers, r.monitoring, seen, today, c.locale);
    else if (p) i.refill = medicationCard(p, today, c.locale, null).refill_preview;
  }
  if (r.kind === "renewal") {
    r.engine = evaluateRequest(
      r.items.map((i) => ({ class_id: drugOf(c, i.prescription_id)?.class_id ?? "", scope: drugOf(c, i.prescription_id)?.scope ?? "physician_only", engine: i.engine! })),
      r.monitoring,
      today,
      c.now,
      c.locale,
    );
  }
}
const slaHours = (c: UserCtx, r: RxRec) => (r.priority === "urgent" ? 1 : r.priority === "soon" ? c.db.settings.rx.sla_hours_soon : c.db.settings.rx.sla_hours_routine);
const tell = (c: UserCtx, r: RxRec, kind: "rx.status" | "rx.more_info" | "rx.ready" | "rx.message", zh: string, en: string) =>
  notify(c.server, c.db, r.patient_id, kind, ["申請有新進度", "Update on your request", `${r.no}：${zh}`, `${r.no}: ${en}`], `/app/rx/${r.id}`);

const BUCKETS: Record<RxBucket, (c: UserCtx, r: RxRec) => boolean> = {
  mine: (c, r) => r.assigned_to === c.account.id && isOpenRx(r.status),
  unassigned: (_c, r) => r.assigned_to === null && ["submitted", "in_review", "returned"].includes(r.status),
  urgent: (_c, r) => r.priority === "urgent" && isOpenRx(r.status),
  overdue: (c, r) => (r.status === "submitted" || r.status === "in_review") && r.sla_due_at !== null && r.sla_due_at < c.now,
  more_info: (_c, r) => r.status === "more_info",
  pharmacy: (_c, r) => r.status === "at_pharmacy" || r.status === "ready" || (r.kind === "refill" && (r.status === "submitted" || r.status === "returned")),
  done: (_c, r) => !isOpenRx(r.status),
};
const RANK = { urgent: 0, soon: 1, routine: 2 } as const;
const byPriority = (a: RxRec, b: RxRec) => RANK[a.priority] - RANK[b.priority] || (a.sla_due_at ?? "9").localeCompare(b.sla_due_at ?? "9");

export const rxRoutes: Route[] = [
  route("POST /rx", ["rx.own"], (c) => {
    const kind = c.body.kind === "refill" || c.body.kind === "renewal" ? c.body.kind : badField("kind", "kind");
    const ids = Array.isArray(c.body.prescription_ids) ? c.body.prescription_ids.map(String) : [];
    if (!ids.length) badField("prescription_ids", L(c.locale, "請至少選一項藥。", "Choose at least one medicine."));
    for (const id of ids) {
      const p = must(c.db.prescriptions.find((x) => x.id === id && x.patient_id === c.account.id));
      if (p.source === "self_reported") badField("prescription_ids", L(c.locale, "自述用藥不能申請。", "Self-reported medicines can't be requested."));
      if (c.db.rx.some((r) => isOpenRx(r.status) && r.items.some((i) => i.prescription_id === id))) fail("invalid_state");
    }
    c.db.counters.rx += 1;
    const r: RxRec = {
      id: uuid(),
      no: `RX-${todayOf(c.now).replaceAll("-", "")}-${String(c.db.counters.rx).padStart(4, "0")}`,
      kind,
      status: "draft",
      revision: 1,
      patient_id: c.account.id,
      items: ids.map((prescription_id) => ({ id: uuid(), prescription_id, engine: null, refill: null, decision: null })),
      step: "items",
      answers: {},
      monitoring: {},
      engine: null,
      pharmacy_id: c.db.profiles[c.account.id]?.preferred_pharmacy_id ?? null,
      pickup_window: null,
      assigned_to: null,
      priority: "routine",
      sla_due_at: null,
      decision_note: null,
      patient_message: null,
      created_at: c.now,
      submitted_at: null,
      updated_at: c.now,
      timeline: [{ at: c.now, type: "created", actor_id: c.account.id, zh: "建立申請", en: "Request started", visibility: "all" }],
      messages: [],
      reads: { [c.account.id]: c.now },
    };
    if (kind === "refill") runEngine(c, r);
    c.db.rx.unshift(r);
    return created(rxView(c, r));
  }),
  route("GET /rx", ["rx.own", "rx.read"], (c) => {
    const status = c.q("status");
    const kind = c.q("kind");
    const list = c.db.rx.filter((r) => (isStaff(c.account) ? r.status !== "draft" : r.patient_id === c.account.id) && (!status || status.split(",").includes(r.status)) && (!kind || r.kind === kind));
    return page(c, list.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((r) => rxBrief(c, r)));
  }),
  route("GET /rx/:id", ["rx.own", "rx.read"], (c) => {
    const r = rxFor(c, true);
    r.reads[c.account.id] = c.now;
    c.server.file.save();
    return ok(rxView(c, r));
  }),
  route("PATCH /rx/:id", ["rx.own"], (c) => {
    const r = ownRx(c);
    if (!isEditableRx(r.status)) fail("invalid_state");
    lock(c, r);
    const p = c.body as RxPatch & Record<string, unknown>;
    if (typeof p.step === "string") r.step = p.step;
    if (isRecord(p.answers)) {
      // Like the server: unknown keys are dropped, null clears.
      const known = new Set(rxView(c, r).questions.map((q) => q.id));
      r.answers = { ...r.answers, ...Object.fromEntries(Object.entries(p.answers).filter(([k]) => known.has(k))) };
      for (const [k, v] of Object.entries(r.answers)) if (v === null) delete r.answers[k];
    }
    if (isRecord(p.monitoring)) {
      r.monitoring = { ...r.monitoring, ...p.monitoring };
      for (const [k, v] of Object.entries(r.monitoring)) if (v === null) delete r.monitoring[k];
    }
    if (p.pharmacy_id !== undefined) {
      if (p.pharmacy_id !== null && !PHARMACY_SEED.some((x) => x.id === p.pharmacy_id)) badField("pharmacy_id", "pharmacy");
      r.pharmacy_id = p.pharmacy_id;
    }
    if (p.pickup_window !== undefined) r.pickup_window = p.pickup_window;
    r.revision += 1;
    r.updated_at = c.now;
    return ok(rxView(c, r));
  }),
  route("POST /rx/:id/evaluate", ["rx.own"], (c) => {
    const r = ownRx(c);
    if (!isEditableRx(r.status)) fail("invalid_state");
    runEngine(c, r);
    return ok(rxView(c, r));
  }),
  route("POST /rx/:id/submit", ["rx.own"], (c) => {
    const r = ownRx(c);
    if (r.status !== "draft") fail("invalid_state");
    lock(c, r);
    if (!str(c.body.consent_version)) badField("consent_version", L(c.locale, "請先同意。", "Consent is needed."));
    runEngine(c, r);
    const view = rxView(c, r);
    const missing = missingForSubmit(view, todayOf(c.now));
    if (missing.length) fail("invalid_request", { fields: Object.fromEntries(missing.map((m) => [m.id, L(c.locale, "這一項還沒完成。", "Not complete yet.")])) });
    if (r.kind === "refill") {
      const a = r.answers;
      if (a.symptom_changed === true || a.side_effects === true || (a.special_status !== undefined && a.special_status !== "none")) {
        for (const i of r.items) if (i.refill) i.refill = { ...i.refill, outcome: "consult", title: L(c.locale, "請洽藥師或醫師", "Ask the pharmacist or doctor"), message: L(c.locale, "您的回答需要先由醫療人員確認。", "Your answers need to be checked by the care team first.") };
      }
      const bad = r.items.find((i) => i.refill && i.refill.outcome !== "eligible");
      if (bad) fail("invalid_request", { fields: { items: bad.refill!.title }, current: bad.refill });
    } else if (r.engine?.disposition === "excluded") fail("invalid_request", { fields: { items: L(c.locale, "這些藥都不接受線上申請。", "None of these can be requested online.") } });
    r.submitted_at = c.now;
    if (r.kind === "refill") {
      r.status = "submitted";
      rxEvent(r, c.now, "submitted", c.account.id, "送出領藥預約", "Refill pickup sent");
      notifyStaff(c.server, c.db, "rx.dispense", "rx.new", ["新的領藥預約", "New refill pickup", `${c.account.display_name}：${r.no}`, `${c.account.display_name_en}: ${r.no}`], `/pharmacy/rx/${r.id}`);
    } else {
      r.status = r.engine?.disposition === "urgent" ? "in_review" : "submitted";
      r.priority = r.engine?.disposition === "urgent" ? "urgent" : r.engine?.disposition === "in_person" ? "soon" : "routine";
      r.sla_due_at = new Date(Date.parse(c.now) + slaHours(c, r) * 3_600_000).toISOString();
      rxEvent(r, c.now, "submitted", c.account.id, "送出續開申請", "Renewal request sent");
      if (r.priority === "urgent") {
        rxEvent(r, c.now, "urgent", null, "回答有危急徵象，請立即就醫。已開立緊急單。", "Danger sign in the answers. Seek care now; an urgent ticket was opened.");
        openTicket(c.server, c.db, { patient_id: r.patient_id, visit_id: null, rx_id: r.id, reason: "red_flag", urgency: "urgent", summary: `續開申請 ${r.no} 有危急徵象`, created_by: "code" });
      }
      notifyStaff(c.server, c.db, "rx.decide", "rx.new", ["新的續開申請", "New renewal request", `${c.account.display_name}：${r.no}`, `${c.account.display_name_en}: ${r.no}`], `/clinic/rx/${r.id}`);
    }
    rxChanged(c.server, r);
    return ok(rxView(c, r));
  }),
  route("POST /rx/:id/cancel", ["rx.own"], (c) => {
    const r = ownRx(c);
    if (!isOpenRx(r.status)) fail("invalid_state");
    lock(c, r);
    r.status = "cancelled";
    rxEvent(r, c.now, "cancelled", c.account.id, "病人取消申請", "Cancelled by the patient");
    rxChanged(c.server, r);
    return ok(rxView(c, r));
  }),
  route("POST /rx/:id/reply", ["rx.own"], (c) => {
    const r = ownRx(c);
    if (r.status !== "more_info") fail("invalid_state");
    lock(c, r);
    const body = str(c.body.body).trim();
    if (!body) badField("body", L(c.locale, "請寫下回覆。", "Write a reply."));
    if (isRecord(c.body.answers)) r.answers = { ...r.answers, ...c.body.answers };
    runEngine(c, r);
    r.messages.push({ id: uuid(), author_id: c.account.id, body, created_at: c.now, visibility: "all" });
    for (const i of r.items) if (i.decision?.outcome === "more_info") i.decision = null;
    r.status = "in_review";
    r.sla_due_at = new Date(Date.parse(c.now) + slaHours(c, r) * 3_600_000).toISOString();
    rxEvent(r, c.now, "replied", c.account.id, "病人已補充資料", "The patient answered");
    rxChanged(c.server, r);
    return ok(rxView(c, r));
  }),
  route("POST /rx/:id/messages", ["rx.own", "rx.read"], (c) => {
    const r = rxFor(c);
    const body = str(c.body.body).trim();
    if (!body) badField("body", L(c.locale, "請輸入內容。", "Write something."));
    const visibility = isStaff(c.account) && c.body.visibility === "staff" ? "staff" : "all";
    r.messages.push({ id: uuid(), author_id: c.account.id, body, created_at: c.now, visibility });
    r.updated_at = c.now;
    if (isStaff(c.account) && visibility === "all") tell(c, r, "rx.message", "醫療團隊留言給您", "the care team wrote to you");
    rxChanged(c.server, r);
    return created(rxView(c, r));
  }),

  // ---- staff ----
  route("GET /queue/rx", ["rx.read"], (c) => {
    const bucket = c.q("bucket") as RxBucket | null;
    const q = (c.q("q") ?? "").toLowerCase();
    const all = c.db.rx.filter((r) => r.status !== "draft");
    const counts = Object.fromEntries(Object.entries(BUCKETS).map(([k, f]) => [k, c.server.config.empty ? 0 : all.filter((r) => f(c, r)).length]));
    const list = all.filter((r) => (bucket ? BUCKETS[bucket]?.(c, r) : isOpenRx(r.status))).sort(byPriority);
    const items = list.map((r) => rxBrief(c, r)).filter((b) => !q || `${b.no} ${b.patient.display_name} ${b.drug_names.join(" ")}`.toLowerCase().includes(q));
    return page(c, items, { counts });
  }),
  route("POST /rx/:id/assign", ["rx.read"], (c) => {
    const r = rxFor(c);
    const id = c.body.account_id === null ? null : str(c.body.account_id);
    const a = id ? must(c.db.accounts.find((x) => x.id === id && x.role !== "patient")) : null;
    r.assigned_to = a?.id ?? null;
    // Giving it to a physician starts the review.
    if (a && can(a, "rx.decide") && r.kind === "renewal" && r.status === "submitted") r.status = "in_review";
    rxEvent(r, c.now, "assigned", c.account.id, a ? `指派給${a.display_name}` : "取消指派", a ? `Assigned to ${a.display_name_en}` : "Unassigned", "staff");
    rxChanged(c.server, r);
    return ok(rxView(c, r));
  }),
  route("POST /rx/:id/decide", ["rx.decide"], (c) => {
    const r = rxFor(c);
    if (!rxView(c, r).allowed_actions.includes("decide")) fail("invalid_state");
    lock(c, r);
    const rows = Array.isArray(c.body.items) ? (c.body.items as { item_id: string; outcome: RxOutcome; note: string | null }[]) : [];
    const fields: Record<string, string> = {};
    for (const i of r.items) {
      const row = rows.find((x) => x.item_id === i.id);
      if (!row) fields[i.id] = L(c.locale, "每一項都要有決定。", "Every item needs a decision.");
      else if (row.outcome === "approve" && drugOf(c, i.prescription_id)?.scope === "excluded") fields[i.id] = L(c.locale, "這個藥不能線上續開。", "This medicine can't be renewed online.");
      else if (row.outcome === "approve" && (i.engine?.disposition === "in_person" || i.engine?.disposition === "urgent") && !str(row.note).trim()) fields[i.id] = L(c.locale, "檢核建議當面評估，同意時請寫理由。", "The check suggests a visit. Give your reason for approving.");
      else if (row.outcome === "more_info" && !str(row.note).trim()) fields[i.id] = L(c.locale, "請寫要問的問題。", "Write the question.");
      else if ((row.outcome === "decline" || row.outcome === "visit_required") && !str(row.note).trim() && !str(c.body.patient_message).trim()) fields[i.id] = L(c.locale, "請寫原因。", "Give the reason.");
    }
    if (Object.keys(fields).length) fail("invalid_request", { fields });
    for (const i of r.items) {
      const row = rows.find((x) => x.item_id === i.id)!;
      i.decision = { outcome: row.outcome, note: row.note, by: c.account.id, at: c.now };
    }
    r.decision_note = str(c.body.note) || null;
    r.patient_message = str(c.body.patient_message) || null;
    r.assigned_to ??= c.account.id;
    const outcomes = r.items.map((i) => i.decision!.outcome);
    const approved = outcomes.filter((o) => o === "approve").length;
    const [status, zh, en]: [RxStatus, string, string] = outcomes.includes("more_info")
      ? ["more_info", "醫師請您補充資料", "The doctor asked for more information"]
      : approved === outcomes.length
        ? ["at_pharmacy", "醫師同意，已轉到藥局", "Approved and sent to the pharmacy"]
        : approved > 0
          ? ["at_pharmacy", "部分項目同意並轉到藥局，其他需要回診", "Some items approved and sent to the pharmacy, others need a visit"]
          : outcomes.every((o) => o === "decline")
            ? ["declined", "醫師沒有同意續開", "Not approved by the doctor"]
            : ["visit_required", "醫師請您回診", "The doctor asked for a visit"];
    r.status = status;
    rxEvent(r, c.now, status === "more_info" ? "more_info" : "decided", c.account.id, zh, en);
    if (r.patient_message) r.messages.push({ id: uuid(), author_id: c.account.id, body: r.patient_message, created_at: c.now, visibility: "all" });
    audit(c, "rx", `rx.${status}`, `rx:${r.id}`, { outcomes });
    tell(c, r, status === "more_info" ? "rx.more_info" : "rx.status", zh, en);
    if (approved > 0) notifyStaff(c.server, c.db, "rx.dispense", "rx.new", ["新的調劑項目", "New item to dispense", `${r.no} 已由醫師同意。`, `${r.no} was approved.`], `/pharmacy/rx/${r.id}`);
    rxChanged(c.server, r);
    return ok(rxView(c, r));
  }),
  route("POST /rx/:id/pharmacy", ["rx.dispense"], (c) => {
    const r = rxFor(c);
    const action = str(c.body.action) as PharmacyAction;
    const view = rxView(c, r);
    if (!view.allowed_actions.includes(action)) fail("invalid_state");
    lock(c, r);
    const note = str(c.body.note).trim();
    if ((action === "return" || action === "ask_physician") && !note) badField("note", L(c.locale, "請寫原因。", "Give the reason."));
    const checks = (c.body.checks ?? {}) as Partial<PharmacyChecks>;
    if (action === "dispense") {
      const open = (["identity", "allergy", "interaction", "quantity"] as const).filter((k) => checks[k] !== true);
      if (open.length) fail("invalid_request", { fields: Object.fromEntries(open.map((k) => [`checks.${k}`, L(c.locale, "還沒核對。", "Not checked.")])) });
    }
    const steps: Record<PharmacyAction, [RxStatus, string, string]> = {
      accept: ["at_pharmacy", "藥局開始處理", "Pharmacy started"],
      ready: ["ready", "備藥完成，可以領藥", "Ready for pickup"],
      dispense: ["dispensed", "已領藥", "Collected"],
      return: ["returned", `藥局退回：${note}`, `Returned: ${note}`],
      ask_physician: ["in_review", `請醫師確認：${note}`, `Doctor asked to confirm: ${note}`],
    };
    const [status, zh, en] = steps[action];
    r.status = status;
    r.assigned_to = action === "ask_physician" ? null : c.account.id;
    if (action === "dispense") {
      const today = todayOf(c.now);
      for (const i of r.items) {
        const p = c.db.prescriptions.find((x) => x.id === i.prescription_id);
        if (!p) continue;
        const pharmacy_name = PHARMACY_SEED.find((x) => x.id === r.pharmacy_id)?.zh.name ?? "";
        if (r.kind === "refill") p.fills.push({ n: p.fills.length + 1, filled_on: today, pharmacy_name });
        else if (i.decision?.outcome === "approve") c.db.prescriptions.push({ ...structuredClone(p), id: uuid(), issued_on: today, fills: [{ n: 1, filled_on: today, pharmacy_name }], is_demo: true });
      }
    }
    rxEvent(r, c.now, action === "dispense" ? "dispensed" : action, c.account.id, zh, en);
    audit(c, "rx", `rx.${action}`, `rx:${r.id}`);
    tell(c, r, status === "ready" ? "rx.ready" : "rx.status", zh, en);
    rxChanged(c.server, r);
    return ok(rxView(c, r));
  }),
];

export { identityKey };
