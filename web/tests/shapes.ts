// zod shapes of the server's answers, for tests/contract.live.test.ts. `z.ZodType<T.X>` makes the compiler check
// that a shape fits the type pages use; strict objects make a live run fail when the server adds or drops a field.

import { z } from "zod";

import type * as T from "../src/api/types.ts";

const s = z.string();
const n = z.number();
const b = z.boolean();
const instant = s.refine((v) => /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)), "instant");
const date = s.regex(/^\d{4}-\d{2}-\d{2}$/);
const nul = <X extends z.ZodType>(x: X) => z.nullable(x);
const list = <X extends z.ZodType>(x: X) => z.array(x);

const role = z.enum(["patient", "physician", "pharmacist", "coordinator", "admin"]);
const locale = z.enum(["zh-TW", "en"]);
const urgency = z.enum(["routine", "soon", "urgent"]);
const permission = z.enum([
  "visit.own", "rx.own", "profile.own", "appt.own", "visit.read", "visit.review", "note.sign", "thread.reply", "ticket.handle", "patient.read", "patient.manage",
  "appt.manage", "rx.read", "rx.decide", "rx.dispense", "account.manage", "settings.manage", "audit.read", "oversight.read", "rules.read", "demo.reset",
]);

export const page = <X extends z.ZodType>(item: X) => z.strictObject({ items: list(item), next_cursor: nul(s), total: n.optional() });
export const items = <X extends z.ZodType>(item: X) => z.object({ items: list(item) });

export const person: z.ZodType<T.PersonRef> = z.strictObject({ id: s, display_name: s, role, title: nul(s), avatar: nul(s) });
export const me: z.ZodType<T.Me> = z.strictObject({
  id: s, username: nul(s), display_name: s, role, title: nul(s), avatar: nul(s), is_guest: b, is_demo: b, locale, preferences: z.record(s, z.unknown()),
  permissions: list(permission), unread_notifications: n, must_change_password: b, expires_at: nul(instant),
});
export const persona: z.ZodType<T.Persona> = z.strictObject({ id: s, display_name: s, display_name_en: s, age_band: s, summary_zh: s, summary_en: s });
export const session: z.ZodType<T.SessionInfo> = z.strictObject({ id: s, device: s, created_at: instant, last_seen_at: instant, current: b });
export const notification: z.ZodType<T.Notification> = z.strictObject({
  id: s,
  kind: z.enum(["visit.reviewed", "visit.staff_message", "rx.status", "rx.more_info", "rx.ready", "rx.message", "appt.reminder", "refill.window_open", "ticket.new", "rx.new", "rx.overdue", "visit.submitted", "red_flag"]),
  title: s, body: s, link: nul(s), read_at: nul(instant), created_at: instant,
});
export const draft = z.strictObject({ scope: s, payload: z.unknown(), revision: n, updated_at: instant });

// ---- visits
const category = z.enum(["chest_pain", "dyspnea", "stroke", "consciousness", "gi_bleeding", "anaphylaxis", "seizure", "suicide"]);
const stage = z.enum(["chief_complaint", "hpi", "background", "confirm", "done"]);
export const appointment: z.ZodType<T.Appointment> = z.strictObject({
  id: s, physician: person, department: s, starts_at: instant, minutes: n, mode: z.enum(["in_person", "video"]), status: z.enum(["booked", "checked_in", "completed", "cancelled"]),
  reason: nul(s), visit_id: nul(s), room: nul(s),
});
export const visit: z.ZodType<T.Visit> = z.strictObject({
  id: s, title: s, locale, status: z.enum(["active", "red_flag", "submitted", "reviewed"]), stage, urgency, mode: z.enum(["ai", "human"]), pinned: b, archived: b, patient: person,
  appointment: nul(appointment), assigned_to: nul(person), chief_complaint: nul(s), last_seq: n, created_at: instant, updated_at: instant, last_activity_at: instant,
  submitted_at: nul(instant), reviewed_at: nul(instant), reviewed_by: nul(person), has_unread: b,
});
export const message: z.ZodType<T.Message> = z.strictObject({
  id: s, client_id: nul(s), seq: n, role: z.enum(["patient", "assistant", "staff"]), kind: z.enum(["opening", "chat", "red_flag", "refusal", "notice", "handoff"]), author: nul(person),
  content: s, created_at: instant, run_id: nul(s), status: z.enum(["ok", "interrupted"]),
});
const listField = z.strictObject({ answered: b, items: list(s) });
const hpi: z.ZodType<T.Hpi> = z.strictObject({ onset: nul(s), modifiers: nul(s), character: nul(s), location: nul(s), severity: nul(z.union([n, z.literal("n/a")])), course: nul(s), associated: nul(s) });
export const intake: z.ZodType<T.IntakeView> = z.strictObject({
  state: z.strictObject({ chief_complaint: nul(s), hpi, past_history: listField, medications: listField, allergies: listField, patient_questions: list(s) }),
  stage, missing: list(s), progress: z.strictObject({ done: n, total: n }),
});
export const refillResult: z.ZodType<T.RefillResult> = z.strictObject({
  outcome: z.enum(["eligible", "too_early", "revisit", "consult"]), title: s, message: s, today: date, earliest_date: nul(date), latest_date: nul(date), next_fill_number: nul(n),
  reasons: list(z.strictObject({ code: s, text: s })), rules: list(z.strictObject({ key: s, text: s, source_url: s })), handoff: b, ticket_no: nul(s),
});
export const summary: z.ZodType<T.PrevisitSummary> = z.strictObject({
  visit_id: s, revision: n, edited_by_patient: b, chief_complaint: nul(s), hpi, past_history: list(s), medications: list(s), allergies: list(s), not_collected: list(s),
  red_flag_screen: z.strictObject({ checked: b, triggered: list(z.strictObject({ category, label: s })), note: s }), patient_questions: list(s), follow_up: list(s),
  evidence: z.record(s, list(s)), narrative: s, refill: nul(refillResult), generated_by: z.strictObject({ kind: z.enum(["model", "code"]), model: nul(s), at: instant }), disclaimer: s,
});
export const ticket: z.ZodType<T.Ticket> = z.strictObject({
  id: s, ticket_no: s, visit_id: nul(s), rx_id: nul(s).optional(), patient: nul(person).optional(),
  reason: z.enum(["red_flag", "prescription_request", "controlled_drug", "symptom_change", "side_effects", "special_status", "out_of_scope_medical", "patient_request", "other"]),
  urgency, summary: s, status: z.enum(["open", "resolved"]), created_by: z.enum(["model", "code", "form"]), created_at: instant, resolved_at: nul(instant), resolved_by: nul(s), resolution_note: nul(s),
});
const toolName = z.enum(["red_flag_precheck", "scope_precheck", "pii_filter", "output_guard", "record_intake", "search_health_education", "check_chronic_refill", "transfer_to_clinician", "save_previsit_summary"]);
const toolSource = z.enum(["code", "model", "form"]);
const toolStatus = z.enum(["ok", "rejected", "error"]);
export const toolCall: z.ZodType<T.ToolCall> = z.strictObject({ id: s, run_id: nul(s), step: n, name: toolName, source: toolSource, status: toolStatus, arguments: z.unknown(), result: z.unknown(), duration_ms: n, created_at: instant });
const runShape = {
  id: s, model: s, fallback_used: b, status: z.enum(["running", "completed", "failed", "skipped", "interrupted"]), steps: n, usage: z.strictObject({ input_tokens: n, output_tokens: n }),
  error_code: nul(s), duration_ms: n, created_at: instant,
};
export const run: z.ZodType<T.Run> = z.strictObject(runShape);
const refillInput: z.ZodType<T.RefillInput> = z.strictObject({
  prescription_date: date, total_days: n, days_per_fill: n, fills_done: n, last_fill_date: date, today: date.optional(), controlled: z.enum(["no", "yes", "unsure"]),
  special_status: z.enum(["none", "going_abroad", "returning_island", "ocean_fishing_crew", "international_crew", "rare_disease"]), symptom_changed: b, side_effects: b,
});
export const note: z.ZodType<T.ClinicalNote> = z.strictObject({
  revision: n, version: n, status: z.enum(["draft", "signed"]),
  sections: z.strictObject({ subjective: s, objective: s, assessment: s, plan: s, patient_message: s }), ai_drafted: list(z.enum(["subjective", "objective"])),
  author: nul(person), signed_by: nul(person), signed_at: nul(instant), addenda: list(z.strictObject({ body: s, by: person, at: instant })),
  history: list(z.strictObject({ version: n, by: nul(person), at: instant })),
});
export const visitDetail: z.ZodType<T.VisitDetail> = z.strictObject({
  visit, messages: list(message), intake, summary: nul(summary), red_flag: nul(z.strictObject({ category, label: s, matched_at: instant, message_id: s })), tickets: list(ticket),
  tool_calls: list(toolCall), runs: list(run), refill_checks: list(z.strictObject({ id: s, input: refillInput, result: refillResult, created_at: instant })), note: nul(note),
});
export const sent: z.ZodType<T.SendMessageResult> = z.strictObject({ message, run_id: nul(s) });

/** Data of each stored or live event, by type (unknown types are allowed by the client). */
export const visitEvents: Record<T.VisitEventType, z.ZodType> = {
  "message.accepted": z.object({ message_id: s, visit_id: s }),
  "message.created": message,
  "precheck.completed": z.object({ red_flag: nul(z.strictObject({ category, label: s, matched_at: instant, message_id: s })), scope: z.enum(["ok", "prescription_request", "injection", "controlled_drug"]), duration_ms: n }),
  "redflag.triggered": z.object({ category, label: s, message_id: s }),
  "run.started": z.object({ run_id: s, model: s }),
  "tool.started": z.object({ call_id: s, step: n, name: toolName, source: toolSource, arguments: z.unknown() }),
  "tool.completed": z.object({ call_id: s, step: n, name: toolName, status: toolStatus, result: z.unknown(), duration_ms: n }),
  "intake.updated": intake,
  "ticket.created": ticket,
  "summary.updated": summary,
  "guard.rewrote": z.object({ kind: z.enum(["diagnosis", "dosage", "prescribing", "other"]), action: z.enum(["rewritten", "replaced"]) }),
  "message.delta": z.object({ text: s }),
  "message.completed": z.object({ message_id: s, kind: z.enum(["opening", "chat", "red_flag", "refusal", "notice", "handoff"]), content: s, run_id: nul(s) }),
  "visit.updated": visit,
  "mode.changed": z.object({ mode: z.enum(["ai", "human"]), by: nul(person).optional() }),
  "note.signed": z.looseObject({}),
  "run.interrupted": z.object({ run_id: s }),
  "run.completed": z.object({ run_id: s, status: z.enum(["completed", "skipped"]), steps: n, usage: z.strictObject({ input_tokens: n, output_tokens: n }), model: s }),
  "run.failed": z.object({ run_id: s, code: z.enum(["max_steps", "timeout", "model_error", "not_configured", "daily_budget_exceeded"]), message: s }),
};

// ---- patient
const source = z.enum(["patient", "clinic"]);
const profileItem: z.ZodType<T.ProfileItem> = z.strictObject({ id: s, name: s, detail: nul(s), since: nul(s), source, status: z.enum(["active", "inactive"]) });
export const profile: z.ZodType<T.HealthProfile> = z.strictObject({
  revision: n, display_name: s, birth_year: nul(n), sex: nul(z.enum(["female", "male", "other"])), height_cm: nul(n), conditions: list(profileItem), medications: list(profileItem),
  allergies: list(profileItem), family_history: list(profileItem), lifestyle: z.strictObject({ smoking: nul(s), alcohol: nul(s), exercise: nul(s) }), preferred_pharmacy_id: nul(s),
  contact_preference: z.literal("in_app"), updated_at: instant,
});
export const measurement: z.ZodType<T.Measurement> = z.strictObject({
  id: s, kind: z.enum(["bp", "glucose", "weight", "pulse", "lab"]),
  values: z.strictObject({ systolic: n.optional(), diastolic: n.optional(), value: n.optional(), name: s.optional(), unit: s.optional() }), taken_at: instant, source,
});
export const accessEntry: z.ZodType<T.AccessLogEntry> = z.strictObject({ at: instant, actor: person, action: s, resource: s });
const consentDoc = z.enum(["terms", "ai_disclosure", "rx_review", "adult"]);
export const consent: z.ZodType<T.Consent> = z.strictObject({ doc: consentDoc, version: s, granted: b, created_at: instant });
export const consents: z.ZodType<T.ConsentState> = z.object({ items: list(consent), current_versions: z.partialRecord(consentDoc, s) });
export const slot: z.ZodType<T.AppointmentSlot> = z.strictObject({ slot_id: s, physician: person, department: s, starts_at: instant, minutes: n, mode: z.enum(["in_person", "video"]), room: nul(s), available: b });
const drugShape = { drug_id: s, name_zh: s, name_en: s, class_id: s, class_zh: s, class_en: s, controlled_level: n };
const drug: z.ZodType<T.DrugRef> = z.strictObject(drugShape);
const scope = z.enum(["in_scope", "physician_only", "excluded"]);
export const medication: z.ZodType<T.MedicationCard> = z.strictObject({
  prescription_id: s, drug, dose_text: s, source: z.enum(["clinic", "self_reported"]), is_demo: b.optional(), issued_on: date, total_days: n, days_per_fill: n,
  fills: list(z.strictObject({ n, filled_on: date, pharmacy_name: s })), fills_allowed: n, supply_ends_on: date, next_window: nul(z.strictObject({ from: date, to: date })), valid_until: date,
  state: z.enum(["on_hand", "window_open", "window_soon", "late", "finished", "expired"]), renewal_scope: scope, days_left: n, open_request_id: nul(s), refill_preview: nul(refillResult),
});

// ---- rx
const rxStatus = z.enum(["draft", "submitted", "in_review", "more_info", "approved", "partially_approved", "declined", "visit_required", "at_pharmacy", "returned", "ready", "dispensed", "cancelled"]);
const disposition = z.enum(["ready", "review", "in_person", "urgent", "excluded"]);
const pickup = z.strictObject({ date, slot: z.enum(["morning", "afternoon", "evening"]) });
export const pharmacy: z.ZodType<T.Pharmacy> = z.strictObject({ id: s, name: s, district: s, address: s, hours: s, services: list(s) });
const visibility = z.enum(["all", "staff"]);
export const rxBrief: z.ZodType<T.RxRequestBrief> = z.strictObject({
  id: s, no: s, kind: z.enum(["refill", "renewal"]), status: rxStatus, priority: urgency, patient: person, drug_names: list(s), disposition: nul(disposition), assigned_to: nul(person),
  submitted_at: nul(instant), sla_due_at: nul(instant), overdue: b, updated_at: instant, unread: b,
  pickup_window: nul(pickup).default(null), pharmacy_name: nul(s).default(null), // announced; older builds leave them out
});
export const rx: z.ZodType<T.RxRequest> = z.strictObject({
  id: s, no: s, kind: z.enum(["refill", "renewal"]), status: rxStatus, revision: n, patient: person,
  items: list(z.strictObject({
    id: s, prescription_id: s, drug, dose_text: s, scope, scope_reason: s,
    engine: nul(z.strictObject({ disposition, fired: list(z.strictObject({ question_id: s, label: s, answer: z.unknown(), disposition, reason: s, source_url: nul(s) })) })),
    refill: nul(refillResult), decision: nul(z.strictObject({ outcome: z.enum(["approve", "decline", "visit_required", "more_info"]), note: nul(s), by: person, at: instant })),
  })),
  step: s, answers: z.record(s, z.unknown()), monitoring: z.record(s, z.strictObject({ value: n.optional(), date: date.optional(), source })),
  questions: list(z.strictObject({
    id: s, scope: z.enum(["general", "class", "monitoring"]), class_id: nul(s), kind: z.enum(["boolean", "choice", "number", "text", "date"]), label: s, help: nul(s),
    options: list(z.strictObject({ value: s, label: s })), unit: nul(s), min: nul(n), max: nul(n), required: b, max_age_days: nul(n),
  })),
  engine: nul(z.strictObject({ protocol_version: s, disposition, evaluated_at: instant, summary: s, stale_monitoring: list(s) })), pharmacy: nul(pharmacy), pickup_window: nul(pickup),
  assigned_to: nul(person), priority: urgency, sla_due_at: nul(instant), overdue: b, decision_note: nul(s), created_at: instant, submitted_at: nul(instant), updated_at: instant,
  timeline: list(z.strictObject({ at: instant, type: s, actor: nul(person), text: s, visibility })),
  messages: list(z.strictObject({ id: s, author: person, body: s, created_at: instant, visibility })), allowed_actions: list(s),
});
const rxBuckets = z.strictObject({ mine: n, unassigned: n, urgent: n, overdue: n, more_info: n, pharmacy: n, done: n });
export const rxQueue: z.ZodType<T.RxQueue> = z.strictObject({ items: list(rxBrief), next_cursor: nul(s), total: n.optional(), counts: rxBuckets });
const rule = z.strictObject({ when: z.strictObject({ op: s, value: z.unknown() }), disposition, reason: s, source_url: nul(s) });
const ruleQuestion = z.strictObject({ id: s, kind: z.enum(["boolean", "choice", "number", "text", "date"]), label: s, required: b, rules: list(rule) });
export const protocols: z.ZodType<T.ProtocolSet> = z.strictObject({
  version: s, approved_by_note: s, general: z.strictObject({ questions: list(ruleQuestion) }),
  classes: list(z.strictObject({
    class_id: s, title: s, summary: s, questions: list(ruleQuestion),
    monitoring: list(z.strictObject({ id: s, label: s, max_age_days: nul(n), value_kind: z.enum(["date_only", "number"]), unit: s, rules: list(rule), stale_disposition: disposition, reason: s, source_type: nul(s), source_url: nul(s), verified_on: nul(s) })),
  })),
});
export const formularyItem: z.ZodType<T.FormularyItem> = z.strictObject({ ...drugShape, form: s, strengths: list(s), renewal_scope: scope, reason: s, source_type: s, source_url: nul(s), verified_on: nul(s) });

export const home: z.ZodType<T.PatientHome> = z.strictObject({
  next_appointment: nul(appointment), active_visits: list(visit), medications: list(medication), active_requests: list(rxBrief), unread: n,
  tasks: list(z.strictObject({ kind: s, title: s, link: s, due_at: nul(instant.or(date)) })),
});

// ---- clinic
const previsit = z.enum(["none", "active", "submitted", "reviewed", "red_flag"]);
export const overview: z.ZodType<T.ClinicOverview> = z.strictObject({
  counts: z.strictObject({ urgent: n, pending: n, rx_review: n, overdue: n, waiting_patient: n, tickets: n }),
  today: list(z.strictObject({ appointment, patient: person, previsit })), activity: list(z.strictObject({ at: instant, text: s, link: nul(s) })),
});
export const workItem: z.ZodType<T.WorkItem> = z.strictObject({
  type: z.enum(["visit", "rx", "ticket"]), id: s, patient: person, title: s, subtitle: s, urgency, status: s, assigned_to: nul(person), due_at: nul(instant), updated_at: instant, link: s,
});
export const worklist: z.ZodType<T.Worklist> = z.strictObject({ items: list(workItem), next_cursor: nul(s), total: n.optional(), counts: z.strictObject({ urgent: n, pending: n, mine: n, waiting: n, done: n }) });
export const patientRow: z.ZodType<T.PatientRow> = z.strictObject({
  patient: person, age: nul(n), sex: nul(z.enum(["female", "male", "other"])), conditions: list(s), tags: list(s), care_status: z.enum(["new", "active", "watch", "inactive"]),
  physician: nul(person), coordinator: nul(person), last_contact_at: nul(instant), open_items: n, next_appointment_at: nul(instant), flags: list(s),
});
export const staffNote: z.ZodType<T.StaffNote> = z.strictObject({ id: s, author: person, body: s, pinned: b, created_at: instant });
export const patientDetail: z.ZodType<T.PatientDetail> = z.strictObject({
  row: patientRow, profile, medications: list(medication), measurements: list(measurement), visits: list(visit), rx: list(rxBrief), appointments: list(appointment), tickets: list(ticket),
  notes: list(staffNote), timeline: list(z.strictObject({ at: instant, kind: s, title: s, link: nul(s), actor: nul(person) })),
});
export const schedule: z.ZodType<T.ClinicSchedule> = z.strictObject({
  date, physicians: list(z.strictObject({ physician: person, slots: list(z.strictObject({ slot_id: s, starts_at: instant, minutes: n, appointment: nul(appointment), patient: nul(person), previsit })) })),
});

// ---- admin
const totals = { visits: n, model_calls: n, input_tokens: n, output_tokens: n, cost_usd: n, red_flags: n, rx: n };
export const adminOverview: z.ZodType<T.AdminOverview> = z.strictObject({
  totals: z.strictObject({ ...totals, patients: n, guests: n, staff: n, month_cost_usd: n, month_budget_usd: nul(n), calls_today: n, daily_call_limit: n }),
  series: list(z.strictObject({ ...totals, day: date })), queues: z.record(s, n),
  system: z.strictObject({ version: s, model_ready: b, uptime_s: n, db_ok: b, ai_enabled: b }),
});
export const account: z.ZodType<T.AccountRow> = z.strictObject({
  id: s, username: nul(s), display_name: s, role, title: nul(s), status: z.enum(["active", "disabled"]), is_guest: b, is_demo: b, created_at: instant, last_login_at: nul(instant), sessions: n,
});
export const oneTime: z.ZodType<T.OneTimePassword> = z.strictObject({ account, password: s });
export const matrix: z.ZodType<T.PermissionMatrix> = z.strictObject({
  roles: list(role), permissions: list(z.strictObject({ id: permission, label: s, description: s })),
  matrix: z.strictObject({ patient: list(permission), physician: list(permission), pharmacist: list(permission), coordinator: list(permission), admin: list(permission) }),
});
export const settings: z.ZodType<T.AdminSettings> = z.strictObject({
  revision: n,
  ai: z.strictObject({
    enabled: b, primary: s, fallback: nul(s), thinking: s, temperature: n, max_steps: n, daily_call_limit: n, per_client_daily_limit: n, monthly_budget_usd: nul(n), on_budget: z.enum(["fallback", "stop"]),
    prices: z.record(s, z.strictObject({ in: n, out: n })),
  }),
  limits: z.strictObject({ messages_per_10min: n, visits_per_10min: n, max_messages_per_visit: n }),
  rx: z.strictObject({ sla_hours_routine: n, sla_hours_soon: n, oversight_phase: z.literal(1) }), retention_days: n,
});
const dispositions = z.strictObject({ ready: n, review: n, in_person: n, urgent: n, excluded: n });
export const oversight: z.ZodType<T.OversightReport> = z.strictObject({
  phase: n,
  by_class: list(z.strictObject({
    class_id: s, class: s, total: n, engine: dispositions, decisions: z.strictObject({ approve: n, decline: n, visit_required: n, more_info: n }), agreement_rate: nul(n), review_decided: n, threshold_total: n,
  })),
  turnaround: z.strictObject({ median_h: nul(n), p90_h: nul(n) }), returned_rate: nul(n), red_flags: list(z.strictObject({ category, label: nul(s), n })),
  guard: list(z.strictObject({ kind: z.enum(["diagnosis", "dosage", "prescribing", "other"]), n })),
});
export const adminRun: z.ZodType<T.AdminRun> = z.strictObject({
  ...runShape, visit_id: s, cost_usd: n, tools: list(z.strictObject({ name: toolName, source: toolSource, status: toolStatus, step: n, duration_ms: n })),
  guard: list(z.strictObject({ kind: z.enum(["diagnosis", "dosage", "prescribing", "other"]), action: z.enum(["rewritten", "replaced"]) })).optional(),
});
export const auditEntry: z.ZodType<T.AuditEntry> = z.strictObject({ at: instant, actor: person, kind: z.enum(["admin", "access", "rx", "auth", "clinic"]), action: s, target: s, detail: z.unknown() });
export const rules: z.ZodType<T.AdminRules> = z.strictObject({
  red_flags: list(z.strictObject({ id: s, category, severity: s, lang: s, label: s, pattern: s, note: s })),
  scope: list(z.strictObject({ id: s, verdict: z.enum(["ok", "prescription_request", "injection", "controlled_drug"]), lang: s, pattern: s, note: s })),
  refill: list(z.strictObject({ key: s, value: s, unit: s, text: s, source_url: s, verified_on: s })), protocols, formulary: list(formularyItem),
});
const evalShape = { ran_at: s, model: s, total: n, passed: n, categories: list(z.looseObject({ key: s, total: n, passed: n })) };
export const evalSummary: z.ZodType<T.EvalSummary> = z.looseObject(evalShape);
export const adminEval: z.ZodType<T.AdminEval> = z.strictObject({ latest: nul(evalSummary), history: list(evalSummary) });

// ---- public
export const health: z.ZodType<T.Health> = z.strictObject({ ok: b, version: s, model_ready: b });
const counts = z.strictObject({ in_scope: n, physician_only: n, excluded: n });
const models = z.strictObject({ primary: s, fallback: nul(s) });
export const meta: z.ZodType<T.Meta> = z.strictObject({
  app: s, version: s, server_today: date, models, retention_days: n, max_message_chars: n, daily_limit_reached: b, eval: nul(evalSummary), oversight_phase: n, protocol_version: s, formulary_counts: counts, ai_enabled: b,
});
export const facts: z.ZodType<T.TrustFacts> = z.strictObject({
  red_flag_rules: n, red_flag_categories: n, scope_rules: n, refill_rules: list(z.strictObject({ key: s, value: s, unit: s, text: s, source_url: s, verified_on: s })), handbook_sections: n, eval_cases: n,
  eval: nul(evalSummary), protocol_version: s, formulary_counts: counts, retention_days: n, oversight_phase: n, sla_hours: z.strictObject({ routine: n, soon: n }),
  limits: z.strictObject({ daily_call_limit: n, max_message_chars: n }), version: s, models, ai_enabled: b,
});
export const handbookEntry: z.ZodType<T.HandbookEntry> = z.strictObject({ section: s, title: s, chapter: s, text: s, source_type: s, source_name: s, source_url: nul(s), verified_on: s });
export const handbookHit: z.ZodType<T.HandbookHit> = z.strictObject({ section: s, title: s, snippet: s, source_type: s, source_name: s, source_url: nul(s), verified_on: s, score: n });
