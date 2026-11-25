// /app, /appointments and the visit endpoints both sides use.

import type { AccessLogEntry, HealthProfileInput, Measurement, MeasurementInput, RefillInput, SummaryChanges, TicketReason } from "../../api/types.ts";
import { addDays, isValidDate, taipeiDate, taipeiInstant } from "../../lib/format.ts";
import { uuid } from "../../lib/ids.ts";
import { applySummaryChanges } from "../../lib/intake.ts";
import { isOpenRx } from "../../lib/rx.ts";
import { badField, can, checkRevision, created, DONE, fail, must, ok, page, personOr, type Route, route, type UserCtx } from "../core.ts";
import { type AppointmentRec, fid, type VisitRec } from "../db.ts";
import { checkRefill, medicationCard } from "../engine.ts";
import { L, refillRule } from "../rules.ts";
import { emptyIntake, OPENING_EN, OPENING_ZH } from "../seed/visits.ts";
import { isRunning, retryTurn, startTurn, submitVisit } from "../turns.ts";
import { addMessage, appointmentView, emitVisit, isStaff, logAccess, medications, messageView, openTicket, rxBrief, ticketView, todayOf, visitChanged, visitDetail, visitView } from "../views.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const MAX_CHARS = 800;

/** The visit, if this account may see it. Staff reads are logged. */
export function visitFor(c: UserCtx, log = false): VisitRec {
  const v = must(c.db.visits.find((x) => x.id === c.params.id));
  if (v.patient_id === c.account.id) return v;
  if (!isStaff(c.account)) return fail("not_found");
  if (!can(c.account, "visit.read")) return fail("forbidden");
  if (log) logAccess(c, v.patient_id, "visit.read", `visit:${v.id}`, L("zh-TW", "預問診", "Previsit"));
  return v;
}
function ownVisit(c: UserCtx): VisitRec {
  const v = must(c.db.visits.find((x) => x.id === c.params.id));
  return v.patient_id === c.account.id ? v : fail("not_found");
}
const byActivity = (a: VisitRec, b: VisitRec) => Number(b.pinned) - Number(a.pinned) || b.last_activity_at.localeCompare(a.last_activity_at);

export function checkMessage(c: UserCtx): { content: string; clientId: string } {
  const content = str(c.body.content).trim();
  const clientId = str(c.body.client_id);
  if (!content) badField("content", L(c.locale, "請輸入內容。", "Write something."));
  if ([...content].length > MAX_CHARS) badField("content", L(c.locale, `最多 ${MAX_CHARS} 個字。`, `At most ${MAX_CHARS} characters.`));
  if (!clientId || clientId.length > 64) badField("client_id", "1-64");
  return { content, clientId };
}

// ---- slots: two physicians, weekdays, quarter hours ----
const PHYSICIANS = ["dr", "dr2"] as const;
const HOURS = { dr: [["09:00", 12], ["14:30", 6]], dr2: [["14:00", 12]] } as const;
export function slotTimes(physician: (typeof PHYSICIANS)[number], date: string): string[] {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return [];
  return HOURS[physician].flatMap(([start, n]) =>
    Array.from({ length: n }, (_, i) => new Date(Date.parse(taipeiInstant(date, start)) + i * 15 * 60_000).toISOString().replace(".000Z", "Z")),
  );
}
export const physicianKeys = PHYSICIANS;
function department(key: "dr" | "dr2", locale: UserCtx["locale"]): string {
  return key === "dr" ? L(locale, "慢性病門診", "Chronic care clinic") : L(locale, "家庭醫學科", "Family medicine");
}

export const patientRoutes: Route[] = [
  route("GET /app/home", ["visit.own"], (c) => {
    const { db, account, locale, now } = c;
    const id = account.id;
    const today = todayOf(now);
    const next = db.appointments.filter((a) => a.patient_id === id && (a.status === "booked" || a.status === "checked_in") && a.starts_at > now).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
    const meds = medications(db, id, today, locale).filter((m) => m.source === "clinic");
    const tasks: { kind: string; title: string; link: string; due_at: string | null }[] = [];
    if (next && !db.visits.some((v) => v.appointment_id === next.id && v.submitted_at)) tasks.push({ kind: "previsit", title: L(locale, "看診前完成預問診", "Finish your previsit before the appointment"), link: "/app/visits", due_at: next.starts_at });
    for (const r of db.rx.filter((x) => x.patient_id === id && x.status === "more_info")) tasks.push({ kind: "rx.more_info", title: L(locale, "回覆醫師的問題", "Answer the doctor's question"), link: `/app/rx/${r.id}`, due_at: r.sla_due_at });
    for (const r of db.rx.filter((x) => x.patient_id === id && x.status === "ready")) tasks.push({ kind: "rx.ready", title: L(locale, "到藥局領藥", "Collect your medicine"), link: `/app/rx/${r.id}`, due_at: r.pickup_window ? taipeiInstant(r.pickup_window.date, "21:00") : null });
    for (const m of meds) if (m.state === "window_open" || m.state === "late") tasks.push({ kind: "refill", title: L(locale, `預約領藥：${m.drug.name_en}`, `Book a refill: ${m.drug.name_en}`), link: "/app/medications", due_at: m.next_window?.to ?? m.supply_ends_on });
    const empty = c.server.config.empty;
    return ok({
      next_appointment: next && !empty ? appointmentView(db, next, locale) : null,
      active_visits: empty ? [] : db.visits.filter((v) => v.patient_id === id && v.status !== "reviewed" && !v.archived && !v.submitted_at).sort(byActivity).map((v) => visitView(c, v)),
      medications: empty ? [] : meds,
      active_requests: empty ? [] : db.rx.filter((r) => r.patient_id === id && isOpenRx(r.status)).map((r) => rxBrief(c, r)),
      unread: db.notifications.filter((n) => n.account_id === id && !n.read_at).length,
      tasks: empty ? [] : tasks,
    });
  }),

  route("GET /app/profile", ["profile.own"], (c) => ok(must(c.db.profiles[c.account.id]))),
  route("PUT /app/profile", ["profile.own"], (c) => {
    const current = must(c.db.profiles[c.account.id]);
    checkRevision(c, current.revision, () => current);
    const { revision: _r, ...input } = c.body as unknown as HealthProfileInput;
    if (!str(input.display_name).trim()) badField("display_name", L(c.locale, "這一欄要填。", "Required."));
    c.db.profiles[c.account.id] = { ...current, ...input, revision: current.revision + 1, updated_at: c.now };
    return ok(c.db.profiles[c.account.id]);
  }),

  route("GET /app/measurements", ["profile.own"], (c) => {
    const kind = c.q("kind");
    return page(c, c.db.measurements.filter((m) => m.patient_id === c.account.id && (!kind || m.kind === kind)).sort((a, b) => b.taken_at.localeCompare(a.taken_at)).map(({ patient_id: _p, ...m }) => m));
  }),
  route("POST /app/measurements", ["profile.own"], (c) => {
    const input = c.body as unknown as MeasurementInput;
    if (!input.taken_at || Number.isNaN(Date.parse(input.taken_at))) badField("taken_at", L(c.locale, "請填時間。", "Enter a time."));
    if (Date.parse(input.taken_at) > Date.parse(c.now) + 60_000) badField("taken_at", L(c.locale, "不能晚於現在。", "Can't be in the future."));
    const m: Measurement = { id: uuid(), kind: input.kind, values: input.values, taken_at: input.taken_at, source: "patient" };
    c.db.measurements.push({ ...m, patient_id: c.account.id });
    return created(m);
  }),
  route("DELETE /app/measurements/:id", ["profile.own"], (c) => {
    const m = must(c.db.measurements.find((x) => x.id === c.params.id && x.patient_id === c.account.id));
    if (m.source === "clinic") fail("forbidden");
    c.db.measurements = c.db.measurements.filter((x) => x.id !== m.id);
    return DONE;
  }),

  route("GET /app/access-log", ["profile.own"], (c) =>
    page(
      c,
      c.db.audit
        .filter((a) => a.kind === "access" && a.patient_id === c.account.id)
        .sort((a, b) => b.at.localeCompare(a.at))
        .map((a): AccessLogEntry => ({ at: a.at, actor: personOr(c.db, a.actor_id, c.locale), action: a.action, resource: String((a.detail as { resource?: string }).resource ?? a.target) })),
    ),
  ),
  route("GET /app/consents", ["profile.own"], (c) =>
    ok({
      items: c.db.consents.filter((x) => x.account_id === c.account.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(({ account_id: _a, ...x }) => x),
      current_versions: { terms: "2026-11", ai_disclosure: "2026-11", rx_review: "2026-11" },
    }),
  ),
  route("POST /app/consents", ["profile.own"], (c) => {
    const doc = (["terms", "ai_disclosure", "rx_review"] as const).find((d) => d === c.body.doc) ?? badField("doc", "doc");
    const rec = { account_id: c.account.id, doc, version: str(c.body.version), granted: c.body.granted === true, created_at: c.now };
    c.db.consents.push(rec);
    const { account_id: _a, ...view } = rec;
    return created(view);
  }),

  route("GET /app/medications", ["rx.own"], (c) => ok({ items: c.server.config.empty ? [] : medications(c.db, c.account.id, todayOf(c.now), c.locale) })),
  route("POST /app/medications", ["rx.own"], (c) => {
    const name = str(c.body.name).trim();
    if (!name) badField("name", L(c.locale, "請填藥名。", "Enter a name."));
    const rec = { id: uuid(), patient_id: c.account.id, drug_id: "", name, dose_zh: str(c.body.dose_text), dose_en: str(c.body.dose_text), source: "self_reported" as const, issued_on: todayOf(c.now), total_days: 0, days_per_fill: 0, fills_allowed: 0, fills: [] };
    c.db.prescriptions.push(rec);
    return created(medicationCard(rec, todayOf(c.now), c.locale, null));
  }),

  // ---- appointments ----
  route("GET /appointments", ["appt.own"], (c) =>
    page(c, c.db.appointments.filter((a) => a.patient_id === c.account.id).sort((a, b) => b.starts_at.localeCompare(a.starts_at)).map((a) => appointmentView(c.db, a, c.locale))),
  ),
  route("GET /appointments/slots", ["appt.own", "appt.manage"], (c) => {
    const today = todayOf(c.now);
    const from = isValidDate(c.q("from") ?? "") ? c.q("from")! : today;
    const to = isValidDate(c.q("to") ?? "") ? c.q("to")! : addDays(from, 13);
    const items: unknown[] = [];
    for (let d = from; d <= to && items.length < 600; d = addDays(d, 1)) {
      for (const key of PHYSICIANS) {
        const id = fid(`account:${key}`);
        const dep = department(key, c.locale);
        if ((c.q("physician_id") && c.q("physician_id") !== id) || (c.q("department") && c.q("department") !== dep)) continue;
        for (const starts_at of slotTimes(key, d)) {
          if (starts_at <= c.now) continue;
          const taken = c.db.appointments.some((a) => a.physician_id === id && a.starts_at === starts_at && a.status !== "cancelled");
          // A few slots look taken by people who are not in the demo.
          const busy = fid(starts_at + key).charCodeAt(0) % 4 === 0;
          if (taken || busy) continue;
          items.push({ slot_id: `${key}|${starts_at}`, physician: personOr(c.db, id, c.locale), department: dep, starts_at, minutes: 15, mode: key === "dr2" && starts_at.slice(14, 16) === "30" ? "video" : "in_person", room: key === "dr" ? L(c.locale, "3 診", "Room 3") : L(c.locale, "5 診", "Room 5"), available: true });
        }
      }
    }
    return ok({ items: c.server.config.empty ? [] : items });
  }),
  route("POST /appointments", ["appt.own"], (c) => {
    const [key, starts_at] = str(c.body.slot_id).split("|");
    if ((key !== "dr" && key !== "dr2") || !starts_at || !slotTimes(key, taipeiDate(starts_at)).includes(starts_at)) return fail("not_found");
    const physician_id = fid(`account:${key}`);
    if (c.db.appointments.some((a) => a.physician_id === physician_id && a.starts_at === starts_at && a.status !== "cancelled")) fail("invalid_state");
    const rec: AppointmentRec = { id: uuid(), patient_id: c.account.id, physician_id, department_zh: department(key, "zh-TW"), department_en: department(key, "en"), starts_at, minutes: 15, mode: "in_person", status: "booked", reason: str(c.body.reason).trim() || null, room: key === "dr" ? "3 診" : "5 診" };
    c.db.appointments.push(rec);
    return created({ appointment: appointmentView(c.db, rec, c.locale) });
  }),
  route("POST /appointments/:id/cancel", ["appt.own"], (c) => {
    const a = must(c.db.appointments.find((x) => x.id === c.params.id && x.patient_id === c.account.id));
    if (a.status !== "booked") fail("invalid_state");
    a.status = "cancelled";
    return ok({ appointment: appointmentView(c.db, a, c.locale) });
  }),

  // ---- visits ----
  route("GET /visits", ["visit.own", "visit.read"], (c) => {
    const q = (c.q("q") ?? "").trim().toLowerCase();
    const status = c.q("status");
    const archived = c.q("archived");
    const list = c.db.visits.filter(
      (v) =>
        (isStaff(c.account) || v.patient_id === c.account.id) &&
        (!status || v.status === status) &&
        (isStaff(c.account) || (archived === "true") === v.archived) &&
        (!q || `${v.title} ${v.intake.chief_complaint ?? ""} ${v.messages.map((m) => m.content).join(" ")}`.toLowerCase().includes(q)),
    );
    return page(c, list.sort(byActivity).map((v) => visitView(c, v)));
  }),
  route("POST /visits", ["visit.own"], (c) => {
    const appt = c.body.appointment_id ? must(c.db.appointments.find((a) => a.id === c.body.appointment_id && a.patient_id === c.account.id)) : null;
    const existing = appt ? c.db.visits.find((v) => v.appointment_id === appt.id) : undefined;
    if (existing) return ok(visitDetail(c, existing));
    const locale = c.body.locale === "en" || c.body.locale === "zh-TW" ? c.body.locale : c.locale;
    const v: VisitRec = {
      id: uuid(),
      patient_id: c.account.id,
      title: L(locale, "新的預問診", "New previsit"),
      locale,
      status: "active",
      stage: "chief_complaint",
      urgency: "routine",
      mode: "ai",
      pinned: false,
      archived: false,
      appointment_id: appt?.id ?? null,
      assigned_to: appt?.physician_id ?? null,
      seq: 0,
      created_at: c.now,
      updated_at: c.now,
      last_activity_at: c.now,
      submitted_at: null,
      reviewed_at: null,
      reviewed_by: null,
      reads: {},
      messages: [],
      intake: emptyIntake(),
      evidence: {},
      summary: null,
      red_flag: null,
      tool_calls: [],
      runs: [],
      refill_checks: [],
      note: null,
      events: [],
    };
    c.db.visits.push(v);
    addMessage(c.server, c.db, v, { role: "assistant", kind: "opening", content: locale === "en" ? OPENING_EN : OPENING_ZH });
    v.reads[c.account.id] = v.seq;
    return created(visitDetail(c, v));
  }),
  route("GET /visits/:id", ["visit.own", "visit.read"], (c) => {
    const v = visitFor(c, true);
    const detail = visitDetail(c, v);
    if (v.reads[c.account.id] !== v.seq) {
      v.reads[c.account.id] = v.seq;
      c.server.file.save();
    }
    return ok(detail);
  }),
  route("PATCH /visits/:id", ["visit.own"], (c) => {
    const v = ownVisit(c);
    if (typeof c.body.title === "string") {
      const title = c.body.title.trim();
      if (!title || [...title].length > 60) badField("title", L(c.locale, "標題要 1 到 60 個字。", "1 to 60 characters."));
      v.title = title;
    }
    if (typeof c.body.pinned === "boolean") v.pinned = c.body.pinned;
    if (typeof c.body.archived === "boolean") v.archived = c.body.archived;
    v.updated_at = c.now;
    return ok({ visit: visitView(c, v) });
  }),
  route("DELETE /visits/:id", ["visit.own"], (c) => {
    const v = ownVisit(c);
    c.db.visits = c.db.visits.filter((x) => x.id !== v.id);
    c.db.turns = c.db.turns.filter((t) => t.visit_id !== v.id);
    return DONE;
  }),
  route("POST /visits/:id/messages", ["visit.own"], (c) => {
    const v = ownVisit(c);
    const { content, clientId } = checkMessage(c);
    const known = v.messages.find((m) => m.client_id === clientId);
    if (known) return ok({ message: messageView(c.db, known, c.locale), run_id: v.runs.findLast((r) => r.status === "running")?.id ?? null });
    if (v.mode === "ai" && (v.status === "submitted" || v.status === "reviewed")) fail("visit_closed");
    if (isRunning(c.db, v.id)) fail("conflict");
    const message = addMessage(c.server, c.db, v, { role: "patient", kind: "chat", content, client_id: clientId });
    v.reads[c.account.id] = v.seq;
    const run_id = startTurn(c.server, c.db, v, must(v.messages.find((m) => m.id === message.id)));
    visitChanged(c.server, v);
    return { status: 202, body: { message, run_id } };
  }),
  route("GET /visits/:id/stream", ["visit.own", "visit.read"], (c) => {
    const v = visitFor(c);
    const after = Math.max(Number(c.q("after")) || 0, Number(c.req.headers.get("Last-Event-ID")) || 0);
    return c.server.sse(c, v.events.filter((e) => e.seq > after), (e) => "visit" in e.to && e.to.visit === v.id);
  }),
  route("POST /visits/:id/runs/retry", ["visit.own"], (c) => {
    const v = ownVisit(c);
    if (isRunning(c.db, v.id)) fail("conflict");
    const last = v.runs.at(-1);
    if (!last || (last.status !== "failed" && last.status !== "interrupted")) return fail("invalid_state");
    return { status: 202, body: { run_id: retryTurn(c.server, c.db, v) } };
  }),
  route("PATCH /visits/:id/summary", ["visit.own"], (c) => {
    const v = ownVisit(c);
    if (v.submitted_at) fail("visit_closed");
    const s = v.summary ?? fail("invalid_state");
    checkRevision(c, s.revision, () => s);
    const changes = (c.body.changes ?? {}) as SummaryChanges;
    v.summary = { ...applySummaryChanges(s, changes), revision: s.revision + 1 };
    emitVisit(c.server, v, "summary.updated", v.summary);
    return ok({ summary: v.summary });
  }),
  route("POST /visits/:id/submit", ["visit.own"], (c) => {
    const v = ownVisit(c);
    submitVisit(c.server, c.db, v, c.now);
    emitVisit(c.server, v, "visit.updated", visitView(c, v));
    visitChanged(c.server, v);
    return ok({ visit: visitView(c, v), summary: v.summary });
  }),
  route("POST /visits/:id/handoff", ["visit.own"], (c) => {
    const v = ownVisit(c);
    const note = str(c.body.note).trim();
    const t = openTicket(c.server, c.db, { patient_id: v.patient_id, visit_id: v.id, rx_id: null, reason: (str(c.body.reason) || "patient_request") as TicketReason, urgency: "routine", summary: note || L(v.locale, "病人希望醫療團隊聯絡。", "The patient asks to be contacted."), created_by: "form" });
    emitVisit(c.server, v, "ticket.created", t);
    return created({ ticket: ticketView(c.db, t, c.locale, false) });
  }),
  route("POST /visits/:id/refill-check", ["visit.own"], (c) => {
    const v = ownVisit(c);
    const input = c.body as unknown as RefillInput;
    const fields: Record<string, string> = {};
    for (const k of ["prescription_date", "last_fill_date"] as const) if (!isValidDate(str(input[k]))) fields[k] = L(c.locale, "日期請寫成 YYYY-MM-DD。", "Write the date as YYYY-MM-DD.");
    for (const k of ["total_days", "days_per_fill"] as const) if (!(Number(input[k]) >= 1)) fields[k] = L(c.locale, "要是大於 0 的整數。", "Must be a whole number above 0.");
    if (!(Number(input.fills_done) >= 1 && Number(input.fills_done) <= refillRule("max_fills"))) fields.fills_done = L(c.locale, "要在 1 到 3 之間。", "Between 1 and 3.");
    if (Object.keys(fields).length) fail("invalid_request", { fields });
    const result = checkRefill(input, todayOf(c.now), c.locale);
    if (result.handoff) {
      const t = openTicket(c.server, c.db, { patient_id: v.patient_id, visit_id: v.id, rx_id: null, reason: "other", urgency: "routine", summary: result.reasons.map((r) => r.text).join("；"), created_by: "form" });
      result.ticket_no = t.ticket_no;
      emitVisit(c.server, v, "ticket.created", t);
    }
    v.refill_checks.push({ id: uuid(), input, result, created_at: c.now });
    return ok({ result });
  }),
];
