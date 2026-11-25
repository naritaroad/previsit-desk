// /auth, /me and the public endpoints.

import type { HealthProfile } from "../../api/types.ts";
import { addDays, daysBetween, taipeiDate } from "../../lib/format.ts";
import { uuid } from "../../lib/ids.ts";
import { badField, type Ctx, created, DONE, fail, must, ok, open, page, type Route, route, type UserCtx } from "../core.ts";
import { type AccountRec, type Db, fid, type PrescriptionRec } from "../db.ts";
import { formulary, formularyCounts, HANDBOOK, L, PERSONAS, PROTOCOL_VERSION, protocolSet, RED_FLAG_ROWS, REFILL_ROWS, SCOPE_ROWS, searchHandbook } from "../rules.ts";
import { PHARMACY_SEED } from "../rules.ts";
import { audit, meView, notificationView, pharmacyView, todayOf } from "../views.ts";

const VERSION = "0.2.0-mock";
const str = (v: unknown) => (typeof v === "string" ? v : "");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Any 8+ characters are the right password; shorter ones, or ones starting with "wrong" or "not-", are not. */
const rightPassword = (v: unknown) => str(v).length >= 8 && !/^(wrong|not-)/.test(str(v));

function checkNewPassword(c: Ctx, field: string, value: unknown): void {
  const n = [...str(value)].length;
  if (n < 8 || n > 128) badField(field, L(c.locale, "密碼要 8 到 128 個字元。", "Passwords have 8 to 128 characters."));
}
function checkUsername(c: Ctx, value: unknown): string {
  const name = str(value).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(name)) badField("username", L(c.locale, "只能用英文字母、數字和 . _ -，3 到 32 個字元。", "3 to 32 letters, digits or . _ -"));
  if (c.db.accounts.some((a) => a.username === name)) badField("username", L(c.locale, "這個帳號名稱已經有人使用。", "That username is already taken."));
  return name;
}
function checkName(c: Ctx, value: unknown): string {
  const name = str(value).trim();
  if (!name || [...name].length > 40) badField("display_name", L(c.locale, "長度要在 1 到 40 個字之間。", "Write between 1 and 40 characters."));
  return name;
}
function newPatient(c: Ctx, o: Partial<AccountRec>): AccountRec {
  return {
    id: uuid(),
    username: null,
    display_name: "",
    display_name_en: "",
    role: "patient",
    title: null,
    title_en: null,
    avatar: null,
    status: "active",
    is_guest: false,
    is_demo: false,
    locale: c.body.locale === "en" ? "en" : "zh-TW",
    preferences: {},
    must_change_password: false,
    created_at: c.now,
    last_login_at: c.now,
    expires_at: null,
    ...o,
  };
}
const emptyProfile = (name: string, now: string): HealthProfile => ({
  revision: 1,
  display_name: name,
  birth_year: null,
  sex: null,
  height_cm: null,
  conditions: [],
  medications: [],
  allergies: [],
  family_history: [],
  lifestyle: { smoking: null, alcohol: null, exercise: null },
  preferred_pharmacy_id: null,
  contact_preference: "in_app",
  updated_at: now,
});

/** A guest sandbox gets its own copy of the persona's profile, medicines and readings. */
function copyPersona(db: Db, account: AccountRec, persona: string, now: string): void {
  const from = fid(`account:${persona}`);
  const profile = db.profiles[from];
  db.profiles[account.id] = profile ? { ...structuredClone(profile), display_name: account.display_name, revision: 1, updated_at: now } : emptyProfile(account.display_name, now);
  for (const p of db.prescriptions.filter((x) => x.patient_id === from)) db.prescriptions.push({ ...structuredClone(p), id: uuid(), patient_id: account.id } satisfies PrescriptionRec);
  for (const m of db.measurements.filter((x) => x.patient_id === from)) db.measurements.push({ ...structuredClone(m), id: uuid(), patient_id: account.id });
  for (const a of db.appointments.filter((x) => x.patient_id === from && x.status === "completed")) db.appointments.push({ ...structuredClone(a), id: uuid(), patient_id: account.id });
  db.care[account.id] = { tags: [], care_status: "new", physician_id: fid("account:dr"), coordinator_id: fid("account:cm"), last_contact_at: null, flags: [] };
}

/** Delete an account and everything it owns. */
export function removeAccount(db: Db, id: string): void {
  db.accounts = db.accounts.filter((a) => a.id !== id);
  db.sessions = db.sessions.filter((s) => s.account_id !== id);
  db.visits = db.visits.filter((v) => v.patient_id !== id);
  db.rx = db.rx.filter((r) => r.patient_id !== id);
  db.tickets = db.tickets.filter((t) => t.patient_id !== id);
  db.appointments = db.appointments.filter((a) => a.patient_id !== id);
  db.prescriptions = db.prescriptions.filter((p) => p.patient_id !== id);
  db.measurements = db.measurements.filter((m) => m.patient_id !== id);
  db.notifications = db.notifications.filter((n) => n.account_id !== id);
  db.staff_notes = db.staff_notes.filter((n) => n.patient_id !== id);
  delete db.profiles[id];
  delete db.care[id];
  for (const key of Object.keys(db.drafts)) if (key.startsWith(`${id}|`)) delete db.drafts[key];
}

const draftKey = (c: UserCtx) => `${c.account.id}|${c.params.scope}`;
const draftView = (c: UserCtx) => {
  const d = c.db.drafts[draftKey(c)];
  return d ? { scope: c.params.scope, ...d } : null;
};

export const accountRoutes: Route[] = [
  // ---- auth ----
  open("GET /auth/personas", () => ok({ items: PERSONAS })),
  open("POST /auth/guest", (c) => {
    if (c.body.adult !== true) badField("adult", L(c.locale, "請先確認您已滿 18 歲。", "Please confirm that you are 18 or older."));
    const persona = PERSONAS.find((p) => p.id === (c.body.persona ?? "lin")) ?? badField("persona", "unknown");
    const a = newPatient(c, { display_name: persona.display_name, display_name_en: c.db.accounts.find((x) => x.id === fid(`account:${persona.id}`))?.display_name_en ?? persona.display_name, is_guest: true, expires_at: new Date(Date.parse(c.now) + c.db.settings.retention_days * 86_400_000).toISOString() });
    c.db.accounts.push(a);
    copyPersona(c.db, a, persona.id, c.now);
    c.server.signIn(a);
    return created({ me: meView(c.db, a) });
  }),
  open("POST /auth/login", (c) => {
    const a = c.db.accounts.find((x) => x.username !== null && x.username === str(c.body.username).trim().toLowerCase());
    if (!a || a.status !== "active" || !rightPassword(c.body.password)) return fail("invalid_credentials");
    c.server.signIn(a);
    audit({ ...c, account: a }, "auth", "login", "session", {});
    return ok({ me: meView(c.db, a) });
  }),
  open("POST /auth/logout", (c) => {
    c.server.signOut();
    return DONE;
  }),
  route("GET /auth/me", "any", (c) => ok({ me: meView(c.db, c.account) })),
  route("POST /auth/claim", ["visit.own"], (c) => {
    if (!c.account.is_guest) return fail("invalid_state");
    const username = checkUsername(c, c.body.username);
    checkNewPassword(c, "password", c.body.password);
    const display_name = checkName(c, c.body.display_name);
    Object.assign(c.account, { username, display_name, display_name_en: display_name, is_guest: false, expires_at: null });
    return ok({ me: meView(c.db, c.account) });
  }),
  open("POST /auth/register", (c) => {
    if (c.body.adult !== true) badField("adult", L(c.locale, "請先確認您已滿 18 歲。", "Please confirm that you are 18 or older."));
    const username = checkUsername(c, c.body.username);
    checkNewPassword(c, "password", c.body.password);
    const display_name = checkName(c, c.body.display_name);
    const a = newPatient(c, { username, display_name, display_name_en: display_name });
    c.db.accounts.push(a);
    c.db.profiles[a.id] = emptyProfile(display_name, c.now);
    c.db.care[a.id] = { tags: [], care_status: "new", physician_id: null, coordinator_id: null, last_contact_at: null, flags: [] };
    c.server.signIn(a);
    return created({ me: meView(c.db, a) });
  }),
  route("POST /auth/password", "any", (c) => {
    if (!rightPassword(c.body.current)) badField("current", L(c.locale, "目前的密碼不正確。", "The current password is wrong."));
    checkNewPassword(c, "next", c.body.next);
    c.account.must_change_password = false;
    return DONE;
  }),

  // ---- me ----
  route("GET /me/sessions", "any", (c) =>
    ok({ items: c.db.sessions.filter((s) => s.account_id === c.account.id).map((s) => ({ id: s.id, device: s.device, created_at: s.created_at, last_seen_at: s.last_seen_at, current: s.token === c.session.token })) }),
  ),
  route("DELETE /me/sessions/:id", "any", (c) => {
    must(c.db.sessions.find((s) => s.id === c.params.id && s.account_id === c.account.id));
    c.db.sessions = c.db.sessions.filter((s) => s.id !== c.params.id);
    return DONE;
  }),
  route("PATCH /me", "any", (c) => {
    if (c.body.display_name !== undefined) {
      c.account.display_name = checkName(c, c.body.display_name);
      c.account.display_name_en = c.account.display_name;
    }
    if (c.body.locale === "zh-TW" || c.body.locale === "en") c.account.locale = c.body.locale;
    if ("avatar" in c.body) c.account.avatar = str(c.body.avatar) || null;
    return ok({ me: meView(c.db, c.account) });
  }),
  route("PUT /me/preferences", "any", (c) => {
    const patch = isRecord(c.body.patch) ? c.body.patch : badField("patch", "object");
    const next = { ...c.account.preferences, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
    c.account.preferences = next;
    return ok({ me: meView(c.db, c.account) });
  }),
  route("GET /me/notifications", "any", (c) =>
    page(c, c.db.notifications.filter((n) => n.account_id === c.account.id && (c.q("unread") !== "true" || n.read_at === null)).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((n) => notificationView(n, c.locale))),
  ),
  route("POST /me/notifications/read", "any", (c) => {
    const ids = Array.isArray(c.body.ids) ? c.body.ids.map(String) : null;
    for (const n of c.db.notifications) if (n.account_id === c.account.id && n.read_at === null && (!ids || ids.includes(n.id))) n.read_at = c.now;
    return ok({ unread: c.db.notifications.filter((n) => n.account_id === c.account.id && n.read_at === null).length });
  }),
  route("GET /me/drafts/:scope", "any", (c) => ok(must(draftView(c)))),
  route("PUT /me/drafts/:scope", "any", (c) => {
    if (!/^[\w:.-]{1,120}$/.test(c.params.scope)) badField("scope", "scope");
    if (JSON.stringify(c.body.payload ?? null).length > 16 * 1024) badField("payload", L(c.locale, "草稿太長。", "The draft is too long."));
    const current = c.db.drafts[draftKey(c)];
    if ((current?.revision ?? 0) !== c.body.revision) fail("conflict", { current: draftView(c) });
    c.db.drafts[draftKey(c)] = { payload: c.body.payload, revision: (current?.revision ?? 0) + 1, updated_at: c.now };
    return ok(draftView(c));
  }),
  route("DELETE /me/drafts/:scope", "any", (c) => {
    delete c.db.drafts[draftKey(c)];
    return DONE;
  }),
  route("GET /me/export", ["profile.own"], (c) => {
    const id = c.account.id;
    return ok({
      exported_at: c.now,
      account: meView(c.db, c.account),
      profile: c.db.profiles[id],
      measurements: c.db.measurements.filter((m) => m.patient_id === id),
      prescriptions: c.db.prescriptions.filter((p) => p.patient_id === id),
      visits: c.db.visits.filter((v) => v.patient_id === id).map(({ events: _e, reads: _r, ...v }) => v),
      rx: c.db.rx.filter((r) => r.patient_id === id),
      appointments: c.db.appointments.filter((a) => a.patient_id === id),
      consents: c.db.consents.filter((x) => x.account_id === id),
    });
  }),
  route("DELETE /me", ["profile.own"], (c) => {
    if (c.body.confirm !== "DELETE") badField("confirm", L(c.locale, "請輸入 DELETE 確認。", "Type DELETE to confirm."));
    removeAccount(c.db, c.account.id);
    c.server.signOut();
    return DONE;
  }),
  route("GET /me/stream", "any", (c) => {
    const { account } = c;
    const perms = new Set(meView(c.db, account).permissions);
    return c.server.sse(c, [], (e) => ("account" in e.to && e.to.account === account.id) || ("permission" in e.to && perms.has(e.to.permission)));
  }),

  // ---- public ----
  open("GET /health", (c) => ok({ ok: true, version: VERSION, model_ready: c.db.settings.ai.enabled })),
  open("GET /meta", (c) =>
    ok({
      app: "PreVisit Desk",
      version: VERSION,
      server_today: todayOf(c.now),
      models: { primary: c.db.settings.ai.primary, fallback: c.db.settings.ai.fallback },
      retention_days: c.db.settings.retention_days,
      max_message_chars: 800,
      daily_limit_reached: !c.db.settings.ai.enabled,
      eval: evalSummary(c.now, 0),
      oversight_phase: 1,
      protocol_version: PROTOCOL_VERSION,
      formulary_counts: formularyCounts(),
      ai_enabled: c.db.settings.ai.enabled,
    }),
  ),
  open("GET /trust/facts", (c) =>
    ok({
      red_flag_rules: RED_FLAG_ROWS.length,
      red_flag_categories: new Set(RED_FLAG_ROWS.map((r) => r.category)).size,
      scope_rules: SCOPE_ROWS.length,
      refill_rules: REFILL_ROWS.map((r) => ({ key: r.key, value: r.value, unit: r.unit, text: L(c.locale, r.text_zh, r.text_en), source_url: r.source_url, verified_on: r.verified_on })),
      handbook_sections: HANDBOOK.length,
      eval_cases: evalSummary(c.now, 0).total,
      eval: evalSummary(c.now, 0),
      protocol_version: PROTOCOL_VERSION,
      formulary_counts: formularyCounts(),
      retention_days: c.db.settings.retention_days,
      oversight_phase: 1,
      sla_hours: { routine: c.db.settings.rx.sla_hours_routine, soon: c.db.settings.rx.sla_hours_soon },
      limits: { daily_call_limit: c.db.settings.ai.daily_call_limit, max_message_chars: 800 },
      ai_enabled: c.db.settings.ai.enabled,
      version: VERSION,
      models: { primary: c.db.settings.ai.primary, fallback: c.db.settings.ai.fallback },
    }),
  ),
  open("GET /pharmacies", (c) => ok({ items: PHARMACY_SEED.map((p) => pharmacyView(p.id, c.locale)) })),
  open("GET /handbook", () => ok({ items: HANDBOOK })),
  open("GET /handbook/search", (c) =>
    ok({
      items: searchHandbook(c.q("q") ?? "").map(({ entry: { text, chapter: _c, ...e }, score }) => ({ ...e, score, snippet: `${[...text].slice(0, 80).join("")}…` })),
    }),
  ),
  open("GET /rx/protocols", (c) => ok(protocolSet(c.locale))),
  open("GET /rx/formulary", (c) => {
    const q = (c.q("q") ?? "").toLowerCase();
    const scope = c.q("scope");
    return page(c, formulary(c.locale).filter((f) => (!scope || f.renewal_scope === scope) && (!q || `${f.name_zh} ${f.name_en} ${f.class_zh} ${f.class_en}`.toLowerCase().includes(q))));
  }),
];

/** Numbers of the mock only; the real ones are in data/eval/results. */
export function evalSummary(now: string, daysAgo: number) {
  const categories = [
    { key: "intake", total: 12, passed: 12 - Math.min(1, daysAgo) },
    { key: "red_flag", total: 14, passed: 14 },
    { key: "refill", total: 9, passed: 9 },
    { key: "out_of_scope", total: 8, passed: 8 - (daysAgo > 3 ? 1 : 0) },
    { key: "boundary", total: 6, passed: 6 },
  ];
  return {
    ran_at: `${addDays(taipeiDate(now), -daysAgo)}T03:00:00Z`,
    model: "gemini-3.5-flash-lite",
    total: categories.reduce((n, x) => n + x.total, 0),
    passed: categories.reduce((n, x) => n + x.passed, 0),
    categories,
  };
}
export const daysAgo = (now: string, at: string) => daysBetween(taipeiDate(at), taipeiDate(now));
