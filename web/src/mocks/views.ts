// Records -> contract objects, in the reader's language, plus the side effects several endpoints share
// (events, notifications, tickets, access log).

import type {
  Appointment,
  ClinicalNote,
  HealthProfile,
  IntakeView,
  Measurement,
  Me,
  MedicationCard,
  Message,
  Notification,
  NotificationKind,
  PatientRow,
  Pharmacy,
  PrevisitState,
  RxAction,
  RxItem,
  RxRequest,
  RxRequestBrief,
  Ticket,
  TicketReason,
  Urgency,
  Visit,
  VisitDetail,
} from "../api/types.ts";
import { INTAKE_FIELDS } from "../api/types.ts";
import type { Locale } from "../api/types.ts";
import { ageFrom, daysBetween, taipeiDate } from "../lib/format.ts";
import { uuid } from "../lib/ids.ts";
import { ROLE_PERMISSIONS } from "../lib/permissions.ts";
import { isOpenRx } from "../lib/rx.ts";
import { can, type Ctx, type MockServer, person, personOr } from "./core.ts";
import type { AccountRec, AppointmentRec, Db, NotificationRec, RxRec, TicketRec, VisitRec } from "./db.ts";
import { medicationCard } from "./engine.ts";
import { DRUGS, L, questionsFor, refillQuestions } from "./rules.ts";
import { PHARMACY_SEED } from "./rules.ts";
import { buildSummary, missingFields, stageOf } from "./seed/visits.ts";

type View = Pick<Ctx, "db" | "locale"> & { account: AccountRec };

export const isStaff = (a: AccountRec) => a.role !== "patient";
export const todayOf = (now: string) => taipeiDate(now);

// ------------------------------------------------------------------------------------------------ account

export function meView(db: Db, a: AccountRec, locale: Locale = a.locale): Me {
  return {
    id: a.id,
    username: a.username,
    display_name: L(locale, a.display_name, a.display_name_en),
    role: a.role,
    title: a.title && L(locale, a.title, a.title_en ?? a.title),
    avatar: a.avatar,
    is_guest: a.is_guest,
    is_demo: a.is_demo,
    locale: a.locale,
    preferences: a.preferences,
    permissions: [...ROLE_PERMISSIONS[a.role]],
    unread_notifications: db.notifications.filter((n) => n.account_id === a.id && n.read_at === null).length,
    must_change_password: a.must_change_password,
    expires_at: a.expires_at,
  };
}
export function notificationView(n: NotificationRec, locale: Locale): Notification {
  return { id: n.id, kind: n.kind, title: L(locale, n.title_zh, n.title_en), body: L(locale, n.body_zh, n.body_en), link: n.link, read_at: n.read_at, created_at: n.created_at };
}

// ------------------------------------------------------------------------------------------------ appointments

export function appointmentView(db: Db, a: AppointmentRec, locale: Locale): Appointment {
  return {
    id: a.id,
    physician: personOr(db, a.physician_id, locale),
    department: L(locale, a.department_zh, a.department_en),
    starts_at: a.starts_at,
    minutes: a.minutes,
    mode: a.mode,
    status: a.status,
    reason: a.reason,
    visit_id: db.visits.find((v) => v.appointment_id === a.id)?.id ?? null,
    room: a.room && L(locale, a.room, a.room.replace(" 診", "").replace(/^/, "Room ")),
  };
}
export function previsitState(db: Db, appointmentId: string): PrevisitState {
  return db.visits.find((v) => v.appointment_id === appointmentId)?.status ?? "none";
}
export function lastSeenDays(db: Db, patientId: string, today: string): number | null {
  const days = db.appointments
    .filter((a) => a.patient_id === patientId && a.status === "completed")
    .map((a) => daysBetween(taipeiDate(a.starts_at), today))
    .filter((d) => d >= 0);
  return days.length ? Math.min(...days) : null;
}

// ------------------------------------------------------------------------------------------------ visits

export function intakeView(v: VisitRec): IntakeView {
  const missing = missingFields(v.intake);
  return { state: v.intake, stage: v.status === "active" ? stageOf(v.intake) : v.stage, missing, progress: { done: INTAKE_FIELDS.length - missing.length, total: INTAKE_FIELDS.length } };
}
export function messageView(db: Db, m: VisitRec["messages"][number], locale: Locale): Message {
  const { author_id, ...rest } = m;
  return { ...rest, author: person(db, author_id, locale) };
}
export function visitView(c: View, v: VisitRec): Visit {
  const { db, locale, account } = c;
  const appt = v.appointment_id ? db.appointments.find((a) => a.id === v.appointment_id) : undefined;
  const read = v.reads[account.id] ?? 0;
  return {
    id: v.id,
    title: v.title,
    locale: v.locale,
    status: v.status,
    stage: v.stage,
    urgency: v.urgency,
    mode: v.mode,
    pinned: v.pinned,
    archived: v.archived,
    patient: personOr(db, v.patient_id, locale),
    appointment: appt ? appointmentView(db, appt, locale) : null,
    assigned_to: person(db, v.assigned_to, locale),
    chief_complaint: v.intake.chief_complaint,
    last_seq: v.seq,
    created_at: v.created_at,
    updated_at: v.updated_at,
    last_activity_at: v.last_activity_at,
    submitted_at: v.submitted_at,
    reviewed_at: v.reviewed_at,
    reviewed_by: person(db, v.reviewed_by, locale),
    has_unread: v.messages.some((m) => m.seq > read && (isStaff(account) ? m.role === "patient" : m.role !== "patient")),
  };
}
export function noteView(c: View, v: VisitRec): ClinicalNote {
  const { db, locale } = c;
  const n = v.note;
  if (!n) {
    // Draft made from the summary; only S and O are filled.
    const s = v.summary;
    const lines = s ? [s.narrative || s.chief_complaint || "", s.patient_questions.length ? `${L(locale, "病人想問：", "Patient asks: ")}${s.patient_questions.join("、")}` : ""].filter(Boolean) : [];
    return {
      revision: 0,
      version: 0,
      status: "draft",
      sections: { subjective: lines.join("\n"), objective: objectiveText(db, v.patient_id, locale), assessment: "", plan: "", patient_message: "" },
      ai_drafted: ["subjective", "objective"],
      author: null,
      signed_by: null,
      signed_at: null,
      addenda: [],
      history: [],
    };
  }
  return {
    revision: n.revision,
    version: n.version,
    status: n.status,
    sections: n.sections,
    ai_drafted: ["subjective", "objective"],
    author: person(db, n.author_id, locale),
    signed_by: person(db, n.signed_by, locale),
    signed_at: n.signed_at,
    addenda: n.addenda.map((a) => ({ body: a.body, by: personOr(db, a.by, locale), at: a.at })),
    history: n.history.map((h) => ({ version: h.version, by: person(db, h.by, locale), at: h.at })),
  };
}
function objectiveText(db: Db, patientId: string, locale: Locale): string {
  const latest = (kind: Measurement["kind"]) => db.measurements.filter((m) => m.patient_id === patientId && m.kind === kind).sort((a, b) => b.taken_at.localeCompare(a.taken_at))[0];
  const bp = latest("bp");
  const glucose = latest("glucose");
  const out: string[] = [];
  if (bp) out.push(L(locale, `自述居家血壓 ${bp.values.systolic}/${bp.values.diastolic} mmHg（${taipeiDate(bp.taken_at)}）`, `Home blood pressure ${bp.values.systolic}/${bp.values.diastolic} mmHg (${taipeiDate(bp.taken_at)})`));
  if (glucose) out.push(L(locale, `自述血糖 ${glucose.values.value} mg/dL（${taipeiDate(glucose.taken_at)}）`, `Home glucose ${glucose.values.value} mg/dL (${taipeiDate(glucose.taken_at)})`));
  return out.join("\n");
}
export function ticketView(db: Db, t: TicketRec, locale: Locale, staff: boolean): Ticket {
  const { patient_id, ...rest } = t;
  return { ...rest, patient: personOr(db, patient_id, locale), resolved_by: staff ? rest.resolved_by : null, resolution_note: staff ? rest.resolution_note : null };
}
export function visitDetail(c: View, v: VisitRec): VisitDetail {
  const staff = isStaff(c.account);
  const note = v.note ? noteView(c, v) : null;
  const patientNote: ClinicalNote | null =
    note?.status === "signed" ? { ...note, sections: { subjective: "", objective: "", assessment: "", plan: "", patient_message: note.sections.patient_message }, addenda: [], history: [] } : null;
  return {
    visit: visitView(c, v),
    messages: v.messages.map((m) => messageView(c.db, m, c.locale)),
    intake: intakeView(v),
    summary: v.summary,
    red_flag: v.red_flag,
    tickets: c.db.tickets.filter((t) => t.visit_id === v.id).map((t) => ticketView(c.db, t, c.locale, staff)),
    tool_calls: v.tool_calls,
    runs: v.runs,
    refill_checks: v.refill_checks,
    note: staff ? note : patientNote,
  };
}

/** Store an event and send it to everyone who has the visit open. Returns its seq. */
export function emitVisit(server: MockServer, v: VisitRec, type: string, data: unknown | ((seq: number) => unknown)): number {
  v.seq += 1;
  const seq = v.seq;
  const payload = typeof data === "function" ? (data as (seq: number) => unknown)(seq) : data;
  v.events.push({ seq, type, data: payload });
  if (v.events.length > 400) v.events.splice(0, v.events.length - 400);
  server.live.publish({ to: { visit: v.id }, seq, type, data: payload });
  return seq;
}
/** Add a message to a visit and announce it. */
export function addMessage(server: MockServer, db: Db, v: VisitRec, m: Partial<VisitRec["messages"][number]> & Pick<VisitRec["messages"][number], "role" | "kind" | "content">, locale: Locale = v.locale): Message {
  const rec: VisitRec["messages"][number] = { id: uuid(), client_id: null, seq: 0, author_id: null, created_at: new Date().toISOString(), run_id: null, status: "ok", ...m };
  emitVisit(server, v, "message.created", (seq: number) => {
    rec.seq = seq;
    v.messages.push(rec);
    return messageView(db, rec, locale);
  });
  v.last_activity_at = rec.created_at;
  v.updated_at = rec.created_at;
  return messageView(db, rec, locale);
}
export function visitChanged(server: MockServer, v: VisitRec): void {
  server.live.publish({ to: { account: v.patient_id }, seq: null, type: "visit.changed", data: { id: v.id } });
  server.live.publish({ to: { permission: "visit.read" }, seq: null, type: "visit.changed", data: { id: v.id } });
  server.live.publish({ to: { permission: "visit.read" }, seq: null, type: "queue.changed", data: { name: "worklist" } });
}
export function notify(server: MockServer, db: Db, accountId: string, kind: NotificationKind, texts: [string, string, string, string], link: string | null): void {
  const a = db.accounts.find((x) => x.id === accountId);
  if (!a) return;
  const n: NotificationRec = { id: uuid(), account_id: accountId, kind, title_zh: texts[0], title_en: texts[1], body_zh: texts[2], body_en: texts[3], link, read_at: null, created_at: new Date().toISOString() };
  db.notifications.unshift(n);
  server.live.publish({ to: { account: accountId }, seq: null, type: "notification", data: notificationView(n, a.locale) });
}
export function notifyStaff(server: MockServer, db: Db, permission: "visit.review" | "rx.decide" | "rx.dispense" | "ticket.handle", kind: NotificationKind, texts: [string, string, string, string], link: string): void {
  for (const a of db.accounts) if (can(a, permission) && a.username) notify(server, db, a.id, kind, texts, link);
}

export function openTicket(server: MockServer, db: Db, o: { patient_id: string; visit_id: string | null; rx_id: string | null; reason: TicketReason; urgency: Urgency; summary: string; created_by: Ticket["created_by"] }): TicketRec {
  db.counters.ticket += 1;
  const now = new Date().toISOString();
  const t: TicketRec = { ...o, id: uuid(), ticket_no: `T-${taipeiDate(now).replaceAll("-", "")}-${String(db.counters.ticket).padStart(4, "0")}`, status: "open", created_at: now, resolved_at: null, resolved_by: null, resolution_note: null };
  db.tickets.push(t);
  const link = o.visit_id ? `/clinic/visits/${o.visit_id}` : `/clinic/rx/${o.rx_id}`;
  if (o.reason === "red_flag") notifyStaff(server, db, "ticket.handle", "red_flag", ["紅旗", "Red flag", o.summary, o.summary], link);
  else notifyStaff(server, db, "ticket.handle", "ticket.new", ["新的轉交單", "New ticket", o.summary, o.summary], link);
  server.live.publish({ to: { permission: "ticket.handle" }, seq: null, type: "queue.changed", data: { name: "tickets" } });
  return t;
}

/** Staff reading a patient's data leaves a trace (once per minute per resource). */
export function logAccess(c: View & { now: string }, patientId: string, action: string, target: string, resource: string): void {
  if (!isStaff(c.account)) return;
  const recent = c.db.audit.some((a) => a.kind === "access" && a.actor_id === c.account.id && a.target === target && Date.parse(c.now) - Date.parse(a.at) < 60_000);
  if (!recent) c.db.audit.unshift({ at: c.now, actor_id: c.account.id, kind: "access", action, target, patient_id: patientId, detail: { resource } });
}
export function audit(c: View & { now: string }, kind: "admin" | "rx" | "auth" | "clinic", action: string, target: string, detail: unknown = {}): void {
  c.db.audit.unshift({ at: c.now, actor_id: c.account.id, kind, action, target, detail });
}

// ------------------------------------------------------------------------------------------------ medicines, rx

export function pharmacyView(id: string | null, locale: Locale): Pharmacy | null {
  const p = PHARMACY_SEED.find((x) => x.id === id);
  return p ? { id: p.id, ...(locale === "en" ? p.en : p.zh) } : null;
}
export function medications(db: Db, patientId: string, today: string, locale: Locale): MedicationCard[] {
  return db.prescriptions
    .filter((p) => p.patient_id === patientId)
    .map((p) => {
      const open = db.rx.find((r) => isOpenRx(r.status) && r.items.some((i) => i.prescription_id === p.id));
      return medicationCard(p, today, locale, open?.id ?? null);
    });
}

export function allowedActions(r: RxRec, a: AccountRec): RxAction[] {
  const out: RxAction[] = [];
  const mine = a.id === r.patient_id;
  if (mine) {
    if (r.status === "draft") out.push("edit", "evaluate", "submit");
    if (r.status === "more_info") out.push("edit", "evaluate", "reply");
    if (["draft", "submitted", "in_review", "more_info", "returned"].includes(r.status)) out.push("cancel");
    if (r.status !== "draft" && r.status !== "cancelled") out.push("message");
    return out;
  }
  if (can(a, "rx.read") && r.status !== "draft") {
    out.push("message", "staff_message");
    if (isOpenRx(r.status)) out.push("assign");
  }
  if (can(a, "rx.decide") && (r.status === "in_review" || (r.kind === "refill" && r.status === "returned"))) out.push("decide");
  if (can(a, "rx.dispense")) {
    if (r.status === "submitted" && r.kind === "refill") out.push("accept", "return", "ask_physician");
    if (r.status === "approved" || r.status === "partially_approved") out.push("accept", "return");
    if (r.status === "at_pharmacy") out.push("ready", "return", "ask_physician");
    if (r.status === "ready") out.push("dispense", "return");
  }
  return out;
}
const isOverdue = (r: RxRec, now: string) => r.status === "in_review" && r.sla_due_at !== null && r.sla_due_at < now;

export function rxView(c: View & { now: string }, r: RxRec): RxRequest {
  const { db, locale, account } = c;
  const staff = isStaff(account);
  const items = r.items.map((i): RxItem => {
    const p = db.prescriptions.find((x) => x.id === i.prescription_id);
    const drug = p ? DRUGS.get(p.drug_id) : undefined;
    return {
      id: i.id,
      prescription_id: i.prescription_id,
      drug: drug
        ? { drug_id: drug.drug_id, name_zh: drug.name_zh, name_en: drug.name_en, class_id: drug.class_id, class_zh: drug.class_zh, class_en: drug.class_en, controlled_level: drug.controlled_level }
        : { drug_id: p?.drug_id ?? "", name_zh: p?.name ?? "", name_en: p?.name ?? "", class_id: "", class_zh: "", class_en: "", controlled_level: 0 },
      dose_text: p ? L(locale, p.dose_zh, p.dose_en) : "",
      scope: drug?.scope ?? "physician_only",
      scope_reason: drug ? L(locale, drug.reason_zh, drug.reason_en) : "",
      engine: i.engine,
      refill: i.refill,
      decision: i.decision ? { ...i.decision, by: personOr(db, i.decision.by, locale) } : null,
    };
  });
  const asked = items.filter((i) => i.scope !== "excluded").map((i) => ({ id: i.id, class_id: i.drug.class_id, name: L(locale, i.drug.name_zh, i.drug.name_en) }));
  return {
    id: r.id,
    no: r.no,
    kind: r.kind,
    status: r.status,
    revision: r.revision,
    patient: personOr(db, r.patient_id, locale),
    items,
    step: r.step,
    answers: r.answers,
    monitoring: r.monitoring,
    questions: r.kind === "renewal" ? questionsFor(asked, locale) : refillQuestions(locale),
    engine: r.engine,
    pharmacy: pharmacyView(r.pharmacy_id, locale),
    pickup_window: r.pickup_window,
    assigned_to: person(db, r.assigned_to, locale),
    priority: r.priority,
    sla_due_at: r.sla_due_at,
    overdue: isOverdue(r, c.now),
    decision_note: staff ? r.decision_note : r.patient_message,
    created_at: r.created_at,
    submitted_at: r.submitted_at,
    updated_at: r.updated_at,
    timeline: r.timeline
      .filter((e) => staff || e.visibility === "all")
      .map((e) => ({ at: e.at, type: e.type, actor: person(db, e.actor_id, locale), text: L(locale, e.zh, e.en), visibility: e.visibility })),
    messages: r.messages
      .filter((m) => staff || m.visibility === "all")
      .map((m) => ({ id: m.id, author: personOr(db, m.author_id, locale), body: m.body, created_at: m.created_at, visibility: m.visibility })),
    allowed_actions: allowedActions(r, account),
  };
}
export function rxBrief(c: View & { now: string }, r: RxRec): RxRequestBrief {
  const { db, locale, account } = c;
  const read = r.reads[account.id] ?? "";
  return {
    id: r.id,
    no: r.no,
    kind: r.kind,
    status: r.status,
    priority: r.priority,
    patient: personOr(db, r.patient_id, locale),
    drug_names: r.items.map((i) => {
      const p = db.prescriptions.find((x) => x.id === i.prescription_id);
      const d = p ? DRUGS.get(p.drug_id) : undefined;
      return d ? L(locale, `${d.name_zh} ${d.name_en}`, d.name_en) : (p?.name ?? "");
    }),
    disposition: r.engine?.disposition ?? null,
    assigned_to: person(db, r.assigned_to, locale),
    submitted_at: r.submitted_at,
    sla_due_at: r.sla_due_at,
    overdue: isOverdue(r, c.now),
    updated_at: r.updated_at,
    unread: r.updated_at > read,
    pickup_window: r.pickup_window,
    pharmacy_name: pharmacyView(r.pharmacy_id, locale)?.name ?? null,
  };
}
export function rxChanged(server: MockServer, r: RxRec): void {
  for (const to of [{ account: r.patient_id }, { permission: "rx.read" as const }]) {
    server.live.publish({ to, seq: null, type: "rx.changed", data: { id: r.id } });
  }
  server.live.publish({ to: { permission: "rx.read" }, seq: null, type: "queue.changed", data: { name: "rx" } });
}
export function rxEvent(r: RxRec, now: string, type: string, actor: string | null, zh: string, en: string, visibility: "all" | "staff" = "all"): void {
  r.timeline.push({ at: now, type, actor_id: actor, zh, en, visibility });
  r.revision += 1;
  r.updated_at = now;
}

// ------------------------------------------------------------------------------------------------ patients

export function patientRow(c: Pick<Ctx, "db" | "locale" | "now">, a: AccountRec): PatientRow {
  const { db, locale } = c;
  const profile: HealthProfile | undefined = db.profiles[a.id];
  const care = db.care[a.id];
  const next = db.appointments
    .filter((x) => x.patient_id === a.id && x.status === "booked" && x.starts_at > c.now)
    .sort((x, y) => x.starts_at.localeCompare(y.starts_at))[0];
  const open =
    db.visits.filter((v) => v.patient_id === a.id && (v.status === "submitted" || v.status === "red_flag")).length +
    db.rx.filter((r) => r.patient_id === a.id && ["submitted", "in_review"].includes(r.status)).length +
    db.tickets.filter((t) => t.patient_id === a.id && t.status === "open").length;
  return {
    patient: personOr(db, a.id, locale),
    age: ageFrom(profile?.birth_year ?? null, todayOf(c.now)),
    sex: profile?.sex ?? null,
    conditions: profile?.conditions.filter((x) => x.status === "active").map((x) => x.name) ?? [],
    tags: care?.tags ?? [],
    care_status: care?.care_status ?? "new",
    physician: person(db, care?.physician_id ?? null, locale),
    coordinator: person(db, care?.coordinator_id ?? null, locale),
    last_contact_at: care?.last_contact_at ?? null,
    open_items: open,
    next_appointment_at: next?.starts_at ?? null,
    flags: care?.flags ?? [],
  };
}

export { buildSummary };
