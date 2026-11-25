// Types of docs/v2/contract.md (and the v1 types it inherits from docs/api/contract.md §1, §4, §7).
// Where the contract names an object without spelling out its fields, the assumption is marked
// "Assumed:" here and listed in docs/engineering/v2-frontend-data.md.

// ---------------------------------------------------------------------------------------- shared

export type Role = "patient" | "physician" | "pharmacist" | "coordinator" | "admin";
export type Locale = "zh-TW" | "en";
export type Permission =
  | "visit.own"
  | "rx.own"
  | "profile.own"
  | "appt.own"
  | "visit.read"
  | "visit.review"
  | "note.sign"
  | "thread.reply"
  | "ticket.handle"
  | "patient.read"
  | "patient.manage"
  | "appt.manage"
  | "rx.read"
  | "rx.decide"
  | "rx.dispense"
  | "account.manage"
  | "settings.manage"
  | "audit.read"
  | "oversight.read"
  | "rules.read"
  | "demo.reset";
export type Urgency = "routine" | "soon" | "urgent";

/** ISO 8601 UTC instant, e.g. 2026-11-25T08:00:00Z. */
export type Instant = string;
/** Asia/Taipei calendar date, YYYY-MM-DD. */
export type CalendarDate = string;

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  total?: number;
}
export interface ListParams {
  cursor?: string;
  /** 1-100, default 30. */
  limit?: number;
  q?: string;
}

export interface Me {
  id: string;
  username: string | null;
  display_name: string;
  role: Role;
  title: string | null;
  /** Slot of src/content/photos.json, or null. */
  avatar: string | null;
  is_guest: boolean;
  is_demo: boolean;
  locale: Locale;
  preferences: Record<string, unknown>;
  permissions: Permission[];
  unread_notifications: number;
  must_change_password: boolean;
  /** Guest sandbox only: when it is deleted. */
  expires_at: Instant | null;
}

export interface PersonRef {
  id: string;
  display_name: string;
  role: Role;
  title: string | null;
  avatar: string | null;
}

// ---------------------------------------------------------------------------------------- errors

export type ServerErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "invalid_credentials"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "visit_closed"
  | "invalid_state"
  | "rate_limited"
  | "payload_too_large"
  | "unsupported_media_type"
  | "internal";
/** Server codes plus the two the browser itself can produce. */
export type ApiErrorCode = ServerErrorCode | "offline" | "bad_response";

export interface ErrorBody {
  error: { code: ServerErrorCode; message: string; fields?: Record<string, string>; current?: unknown };
}

// ------------------------------------------------------------------------------- auth and account

export interface Persona {
  id: string;
  display_name: string;
  display_name_en: string;
  age_band: string;
  summary_zh: string;
  summary_en: string;
}
export interface SessionInfo {
  id: string;
  device: string;
  created_at: Instant;
  last_seen_at: Instant;
  current: boolean;
}
export interface LoginInput {
  username: string;
  password: string;
}
export interface ClaimInput {
  username: string;
  password: string;
  display_name: string;
}
/** `adult`: the visitor said they are 18 or older (the model provider's terms); only true is accepted. */
export interface RegisterInput extends ClaimInput {
  locale: Locale;
  adult: boolean;
}
export interface GuestInput {
  locale: Locale;
  persona?: string;
  adult: boolean;
}
export interface PasswordInput {
  current: string;
  next: string;
}
export interface MePatch {
  display_name?: string;
  locale?: Locale;
  avatar?: string | null;
}

export type NotificationKind =
  | "visit.reviewed"
  | "visit.staff_message"
  | "rx.status"
  | "rx.more_info"
  | "rx.ready"
  | "rx.message"
  | "appt.reminder"
  | "refill.window_open"
  | "ticket.new"
  | "rx.new"
  | "rx.overdue"
  | "visit.submitted"
  | "red_flag";
export interface Notification {
  id: string;
  kind: NotificationKind;
  /** Already in the account's language. */
  title: string;
  body: string;
  link: string | null;
  read_at: Instant | null;
  created_at: Instant;
}

/** GET and PUT /me/drafts/{scope}; a 409 carries it in error.current (null when it was deleted elsewhere). */
export interface DraftRecord<T = unknown> {
  scope: string;
  payload: T;
  revision: number;
  updated_at: Instant;
}

/** Account stream (GET /me/stream). */
export type AccountEvent =
  | { type: "notification"; data: Notification }
  | { type: "visit.changed"; data: { id: string } }
  | { type: "rx.changed"; data: { id: string } }
  /** name "all": too much changed at once, reload what is shown. */
  | { type: "queue.changed"; data: { name: string } };

// --------------------------------------------------------------------------------- visits (v1 + v2)

export type VisitStatus = "active" | "red_flag" | "submitted" | "reviewed";
export type Stage = "chief_complaint" | "hpi" | "background" | "confirm" | "done";
export type VisitMode = "ai" | "human";
export type RedFlagCategory =
  | "chest_pain"
  | "dyspnea"
  | "stroke"
  | "consciousness"
  | "gi_bleeding"
  | "anaphylaxis"
  | "seizure"
  | "suicide";
export type SpecialStatus =
  | "none"
  | "going_abroad"
  | "returning_island"
  | "ocean_fishing_crew"
  | "international_crew"
  | "rare_disease";
export type RefillOutcome = "eligible" | "too_early" | "revisit" | "consult";
export type TicketReason =
  | "red_flag"
  | "prescription_request"
  | "controlled_drug"
  | "symptom_change"
  | "side_effects"
  | "special_status"
  | "out_of_scope_medical"
  | "patient_request"
  | "other";

export interface Visit {
  id: string;
  title: string;
  locale: Locale;
  status: VisitStatus;
  stage: Stage;
  urgency: Urgency;
  mode: VisitMode;
  pinned: boolean;
  archived: boolean;
  patient: PersonRef;
  appointment: Appointment | null;
  assigned_to: PersonRef | null;
  chief_complaint: string | null;
  last_seq: number;
  created_at: Instant;
  updated_at: Instant;
  last_activity_at: Instant;
  submitted_at: Instant | null;
  reviewed_at: Instant | null;
  reviewed_by: PersonRef | null;
  has_unread: boolean;
}

export type MessageRole = "patient" | "assistant" | "staff";
export type MessageKind = "opening" | "chat" | "red_flag" | "refusal" | "notice" | "handoff";
export interface Message {
  id: string;
  client_id: string | null;
  seq: number;
  role: MessageRole;
  kind: MessageKind;
  /** Set on staff messages. */
  author: PersonRef | null;
  content: string;
  created_at: Instant;
  run_id: string | null;
  status: "ok" | "interrupted";
}

export interface ListField {
  /** answered with no items means "none". */
  answered: boolean;
  items: string[];
}
export interface Hpi {
  onset: string | null;
  modifiers: string | null;
  character: string | null;
  location: string | null;
  /** 0-10; 'n/a' counts as collected. */
  severity: number | "n/a" | null;
  course: string | null;
  associated: string | null;
}
export interface IntakeState {
  chief_complaint: string | null;
  hpi: Hpi;
  past_history: ListField;
  medications: ListField;
  allergies: ListField;
  patient_questions: string[];
}
export interface IntakeView {
  state: IntakeState;
  stage: Stage;
  missing: string[];
  progress: { done: number; total: number };
}
/** Field keys of intake, summaries and evidence, in the contract's order (v1 contract §7.4). */
export const INTAKE_FIELDS = [
  "chief_complaint",
  "hpi.onset",
  "hpi.course",
  "hpi.location",
  "hpi.character",
  "hpi.severity",
  "hpi.modifiers",
  "hpi.associated",
  "past_history",
  "medications",
  "allergies",
] as const;
export type IntakeFieldKey = (typeof INTAKE_FIELDS)[number];

export interface RedFlagHit {
  category: RedFlagCategory;
  label: string;
  matched_at: Instant;
  message_id: string;
}

export type ToolName =
  | "red_flag_precheck"
  | "scope_precheck"
  | "pii_filter"
  | "output_guard"
  | "record_intake"
  | "search_health_education"
  | "check_chronic_refill"
  | "transfer_to_clinician"
  | "save_previsit_summary";
export type ToolSource = "code" | "model" | "form";
export type ToolStatus = "ok" | "rejected" | "error";
export interface ToolCall {
  id: string;
  run_id: string | null;
  step: number;
  name: ToolName;
  source: ToolSource;
  status: ToolStatus;
  arguments: unknown;
  result: unknown;
  duration_ms: number;
  created_at: Instant;
}

export type RunStatus = "running" | "completed" | "failed" | "skipped" | "interrupted";
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}
export interface Run {
  id: string;
  model: string;
  fallback_used: boolean;
  status: RunStatus;
  steps: number;
  usage: TokenUsage;
  error_code: string | null;
  duration_ms: number;
  created_at: Instant;
}

export interface RefillInput {
  prescription_date: CalendarDate;
  total_days: number;
  days_per_fill: number;
  fills_done: number;
  last_fill_date: CalendarDate;
  today?: CalendarDate;
  controlled: "no" | "yes" | "unsure";
  special_status: SpecialStatus;
  symptom_changed: boolean;
  side_effects: boolean;
}
export interface RefillResult {
  outcome: RefillOutcome;
  title: string;
  message: string;
  today: CalendarDate;
  earliest_date: CalendarDate | null;
  latest_date: CalendarDate | null;
  next_fill_number: number | null;
  reasons: { code: string; text: string }[];
  rules: { key: string; text: string; source_url: string }[];
  handoff: boolean;
  ticket_no: string | null;
}
export interface RefillCheckRecord {
  id: string;
  input: RefillInput;
  result: RefillResult;
  created_at: Instant;
}

export interface PrevisitSummary {
  visit_id: string;
  revision: number;
  edited_by_patient: boolean;
  chief_complaint: string | null;
  hpi: Hpi;
  past_history: string[];
  medications: string[];
  allergies: string[];
  not_collected: string[];
  red_flag_screen: { checked: boolean; triggered: { category: RedFlagCategory; label: string }[]; note: string };
  patient_questions: string[];
  /** Points the doctor may want to ask about; never a diagnosis. */
  follow_up: string[];
  /** Field key -> message ids the value came from. */
  evidence: Record<string, string[]>;
  narrative: string;
  refill: RefillResult | null;
  generated_by: { kind: "model" | "code"; model: string | null; at: Instant };
  disclaimer: string;
}
/** PATCH /visits/{id}/summary `changes`: intake field keys plus patient_questions. Errors come as changes.<key>. */
export type SummaryChanges = Partial<
  Record<Exclude<IntakeFieldKey, "past_history" | "medications" | "allergies" | "hpi.severity">, string | null>
> & {
  "hpi.severity"?: number | "n/a" | null;
  past_history?: string[];
  medications?: string[];
  allergies?: string[];
  patient_questions?: string[];
};

export interface Ticket {
  id: string;
  ticket_no: string;
  /** Null when the ticket came from an rx request (see rx_id). */
  visit_id: string | null;
  /** Set when the ticket came from an rx request. */
  rx_id?: string | null;
  /** Present in staff lists. */
  patient?: PersonRef | null;
  reason: TicketReason;
  urgency: Urgency;
  summary: string;
  status: "open" | "resolved";
  created_by: "model" | "code" | "form";
  created_at: Instant;
  resolved_at: Instant | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export interface ClinicalNoteSections {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  patient_message: string;
}
export type NoteSection = keyof ClinicalNoteSections;
export interface ClinicalNote {
  revision: number;
  version: number;
  status: "draft" | "signed";
  sections: ClinicalNoteSections;
  /** The assistant only ever drafts these two. */
  ai_drafted: ("subjective" | "objective")[];
  author: PersonRef | null;
  signed_by: PersonRef | null;
  signed_at: Instant | null;
  addenda: { body: string; by: PersonRef; at: Instant }[];
  history: { version: number; by: PersonRef | null; at: Instant }[];
}

export interface VisitDetail {
  visit: Visit;
  messages: Message[];
  intake: IntakeView;
  summary: PrevisitSummary | null;
  /** The latest hit; the emergency card depends on this, not on visit.status. */
  red_flag: RedFlagHit | null;
  tickets: Ticket[];
  tool_calls: ToolCall[];
  runs: Run[];
  refill_checks: RefillCheckRecord[];
  /** Patients only get it after signing, with patient_message. */
  note: ClinicalNote | null;
}

export interface VisitListParams extends ListParams {
  status?: VisitStatus;
  archived?: boolean;
}
export interface CreateVisitInput {
  locale?: Locale;
  appointment_id?: string;
}
export interface SendMessageResult {
  message: Message;
  run_id: string | null;
}

// ---------------------------------------------------------------------------------- visit stream

export type PrecheckScope = "ok" | "prescription_request" | "injection" | "controlled_drug";
export type GuardKind = "diagnosis" | "dosage" | "prescribing" | "other";
export type RunFailureCode = "max_steps" | "timeout" | "model_error" | "not_configured" | "daily_budget_exceeded";

/** One decoded SSE event. `seq` is null for events that are not stored (message.delta). */
export interface StreamEnvelope {
  seq: number | null;
  type: string;
  data: unknown;
}
export type VisitEvent =
  | { type: "message.accepted"; data: { message_id: string; visit_id: string } }
  | { type: "message.created"; data: Message }
  | { type: "precheck.completed"; data: { red_flag: RedFlagHit | null; scope: PrecheckScope; duration_ms: number } }
  | { type: "redflag.triggered"; data: { category: RedFlagCategory; label: string; message_id: string } }
  | { type: "run.started"; data: { run_id: string; model: string } }
  | { type: "tool.started"; data: { call_id: string; step: number; name: ToolName; source: ToolSource; arguments: unknown } }
  | {
      type: "tool.completed";
      data: { call_id: string; step: number; name: ToolName; status: ToolStatus; result: unknown; duration_ms: number };
    }
  | { type: "intake.updated"; data: IntakeView }
  | { type: "ticket.created"; data: Ticket }
  | { type: "summary.updated"; data: PrevisitSummary }
  | { type: "guard.rewrote"; data: { kind: GuardKind; action: "rewritten" | "replaced" } }
  | { type: "message.delta"; data: { text: string } }
  | { type: "message.completed"; data: { message_id: string; kind: MessageKind; content: string; run_id: string | null } }
  | { type: "visit.updated"; data: Visit }
  | { type: "mode.changed"; data: { mode: VisitMode; by?: PersonRef | null } }
  | { type: "note.signed"; data: { note?: ClinicalNote } }
  | { type: "run.interrupted"; data: { run_id: string } }
  | {
      type: "run.completed";
      data: { run_id: string; status: "completed" | "skipped"; steps: number; usage: TokenUsage; model: string };
    }
  | { type: "run.failed"; data: { run_id: string; code: RunFailureCode; message: string } };
export type VisitEventType = VisitEvent["type"];

// ------------------------------------------------------------------------------- patient workspace

export type ItemSource = "patient" | "clinic";
export interface ProfileItem {
  id: string;
  name: string;
  detail: string | null;
  since: string | null;
  source: ItemSource;
  status: "active" | "inactive";
}
export interface Lifestyle {
  smoking: string | null;
  alcohol: string | null;
  exercise: string | null;
}
export interface HealthProfile {
  revision: number;
  display_name: string;
  birth_year: number | null;
  sex: "female" | "male" | "other" | null;
  height_cm: number | null;
  conditions: ProfileItem[];
  medications: ProfileItem[];
  allergies: ProfileItem[];
  family_history: ProfileItem[];
  lifestyle: Lifestyle;
  preferred_pharmacy_id: string | null;
  contact_preference: "in_app";
  updated_at: Instant;
}
/** PUT /app/profile: the whole profile without updated_at, with the revision it was based on. */
export type HealthProfileInput = Omit<HealthProfile, "updated_at">;

export type MeasurementKind = "bp" | "glucose" | "weight" | "pulse" | "lab";
export interface MeasurementValues {
  systolic?: number;
  diastolic?: number;
  value?: number;
  name?: string;
  unit?: string;
}
export interface Measurement {
  id: string;
  kind: MeasurementKind;
  values: MeasurementValues;
  taken_at: Instant;
  source: ItemSource;
}
export interface MeasurementInput {
  kind: MeasurementKind;
  values: MeasurementValues;
  taken_at: Instant;
}

export interface AccessLogEntry {
  at: Instant;
  actor: PersonRef;
  action: string;
  resource: string;
}
export type ConsentDoc = "terms" | "ai_disclosure" | "rx_review" | "adult";
export interface Consent {
  doc: ConsentDoc;
  version: string;
  granted: boolean;
  created_at: Instant;
}
/** GET /app/consents: the whole history, newest first; the first entry of a document is the one that counts. */
export interface ConsentState {
  items: Consent[];
  current_versions: Partial<Record<ConsentDoc, string>>;
}

export interface Appointment {
  id: string;
  physician: PersonRef;
  department: string;
  starts_at: Instant;
  minutes: number;
  mode: "in_person" | "video";
  status: "booked" | "checked_in" | "completed" | "cancelled";
  reason: string | null;
  visit_id: string | null;
  room: string | null;
}
/** Items of GET /appointments/slots. The server lists free slots only. */
export interface AppointmentSlot {
  slot_id: string;
  physician: PersonRef;
  department: string;
  starts_at: Instant;
  minutes: number;
  mode: "in_person" | "video";
  room: string | null;
  available: boolean;
}
export interface SlotParams {
  from?: CalendarDate;
  to?: CalendarDate;
  department?: string;
  physician_id?: string;
}

export interface DrugRef {
  drug_id: string;
  name_zh: string;
  name_en: string;
  class_id: string;
  class_zh: string;
  class_en: string;
  controlled_level: number;
}
export interface Fill {
  n: number;
  filled_on: CalendarDate;
  pharmacy_name: string;
}
export type MedicationState = "on_hand" | "window_open" | "window_soon" | "late" | "finished" | "expired";
export type RenewalScope = "in_scope" | "physician_only" | "excluded";
export interface MedicationCard {
  prescription_id: string;
  drug: DrugRef;
  dose_text: string;
  source: "clinic" | "self_reported";
  issued_on: CalendarDate;
  total_days: number;
  days_per_fill: number;
  fills: Fill[];
  fills_allowed: number;
  supply_ends_on: CalendarDate;
  next_window: { from: CalendarDate; to: CalendarDate } | null;
  valid_until: CalendarDate;
  state: MedicationState;
  renewal_scope: RenewalScope;
  days_left: number;
  /** True for the demonstration record a handed-over renewal creates. */
  is_demo?: boolean;
  open_request_id: string | null;
  refill_preview: RefillResult | null;
}

export interface HomeTask {
  kind: string;
  title: string;
  link: string;
  /** An instant (an appointment) or a calendar date (the end of a refill window). */
  due_at: Instant | CalendarDate | null;
}
export interface PatientHome {
  next_appointment: Appointment | null;
  active_visits: Visit[];
  medications: MedicationCard[];
  active_requests: RxRequestBrief[];
  unread: number;
  tasks: HomeTask[];
}
/** GET /me/export: a JSON document for download; pages only save it. */
export type ExportDocument = Record<string, unknown>;

// --------------------------------------------------------------------------------------------- rx

export type RxKind = "refill" | "renewal";
export type RxStatus =
  | "draft"
  | "submitted"
  | "in_review"
  | "more_info"
  | "approved"
  | "partially_approved"
  | "declined"
  | "visit_required"
  | "at_pharmacy"
  | "returned"
  | "ready"
  | "dispensed"
  | "cancelled";
export type Disposition = "ready" | "review" | "in_person" | "urgent" | "excluded";
export type RxOutcome = "approve" | "decline" | "visit_required" | "more_info";
export type PickupSlot = "morning" | "afternoon" | "evening";
export interface PickupWindow {
  date: CalendarDate;
  slot: PickupSlot;
}
export interface MonitoringValue {
  value?: number;
  date?: CalendarDate;
  source: ItemSource;
}
export interface FiredRule {
  question_id: string;
  label: string;
  answer: unknown;
  disposition: Disposition;
  reason: string;
  source_url: string | null;
}
export interface RxItem {
  id: string;
  prescription_id: string;
  drug: DrugRef;
  dose_text: string;
  scope: RenewalScope;
  scope_reason: string;
  engine: { disposition: Disposition; fired: FiredRule[] } | null;
  refill: RefillResult | null;
  decision: { outcome: RxOutcome; note: string | null; by: PersonRef; at: Instant } | null;
}
export interface EngineResult {
  protocol_version: string;
  disposition: Disposition;
  evaluated_at: Instant;
  summary: string;
  stale_monitoring: string[];
}
export interface ProtocolQuestion {
  id: string;
  scope: "general" | "class" | "monitoring";
  class_id: string | null;
  kind: "boolean" | "choice" | "number" | "text" | "date";
  label: string;
  help: string | null;
  options: { value: string; label: string }[];
  unit: string | null;
  min: number | null;
  max: number | null;
  required: boolean;
  max_age_days: number | null;
}
export interface RxEvent {
  at: Instant;
  type: string;
  actor: PersonRef | null;
  text: string;
  visibility: "all" | "staff";
}
export interface RxMessage {
  id: string;
  author: PersonRef;
  body: string;
  created_at: Instant;
  visibility: "all" | "staff";
}
export interface Pharmacy {
  id: string;
  name: string;
  district: string;
  address: string;
  hours: string;
  services: string[];
}
/** Values of RxRequest.allowed_actions; unknown names from a newer server are kept as strings and ignored. */
export type RxAction =
  | "edit"
  | "evaluate"
  | "submit"
  | "cancel"
  | "reply"
  | "message"
  | "staff_message"
  | "assign"
  | "decide"
  | "accept"
  | "ready"
  | "dispense"
  | "return"
  | "ask_physician";
export interface RxRequest {
  id: string;
  /** RX-20261125-0001 */
  no: string;
  kind: RxKind;
  status: RxStatus;
  revision: number;
  patient: PersonRef;
  items: RxItem[];
  step: string;
  answers: Record<string, unknown>;
  monitoring: Record<string, MonitoringValue>;
  questions: ProtocolQuestion[];
  engine: EngineResult | null;
  pharmacy: Pharmacy | null;
  pickup_window: PickupWindow | null;
  assigned_to: PersonRef | null;
  priority: Urgency;
  sla_due_at: Instant | null;
  overdue: boolean;
  decision_note: string | null;
  created_at: Instant;
  submitted_at: Instant | null;
  updated_at: Instant;
  timeline: RxEvent[];
  messages: RxMessage[];
  allowed_actions: (RxAction | (string & {}))[];
}
export interface RxRequestBrief {
  id: string;
  no: string;
  kind: RxKind;
  status: RxStatus;
  priority: Urgency;
  patient: PersonRef;
  drug_names: string[];
  disposition: Disposition | null;
  assigned_to: PersonRef | null;
  submitted_at: Instant | null;
  sla_due_at: Instant | null;
  overdue: boolean;
  updated_at: Instant;
  unread: boolean;
  pickup_window: PickupWindow | null;
  pharmacy_name: string | null;
}
export interface RxListParams extends ListParams {
  /** One status, or several separated by commas. */
  status?: RxStatus | (string & {});
  kind?: RxKind;
}
export interface RxPatch {
  step?: string;
  answers?: Record<string, unknown>;
  monitoring?: Record<string, MonitoringValue>;
  pharmacy_id?: string | null;
  pickup_window?: PickupWindow | null;
}
export interface RxDecisionInput {
  revision: number;
  items: { item_id: string; outcome: RxOutcome; note: string | null }[];
  note: string | null;
  patient_message: string | null;
}
export type PharmacyAction = "accept" | "ready" | "dispense" | "return" | "ask_physician";
export interface PharmacyChecks {
  identity: boolean;
  allergy: boolean;
  interaction: boolean;
  quantity: boolean;
}
export interface PharmacyInput {
  revision: number;
  action: PharmacyAction;
  checks?: PharmacyChecks;
  note: string | null;
}
export type RxBucket = "mine" | "unassigned" | "urgent" | "overdue" | "more_info" | "pharmacy" | "done";
export interface RxQueue extends Page<RxRequestBrief> {
  counts: Record<RxBucket, number>;
}
export interface ProtocolRule {
  when: { op: "eq" | "neq" | "in" | "gt" | "gte" | "lt" | "lte" | "missing" | (string & {}); value: unknown };
  disposition: Disposition;
  reason: string;
  source_url: string | null;
}
export interface ProtocolRuleQuestion {
  id: string;
  kind: ProtocolQuestion["kind"];
  label: string;
  required: boolean;
  rules: ProtocolRule[];
}
export interface ProtocolRuleMonitoring {
  id: string;
  label: string;
  max_age_days: number | null;
  value_kind: "date_only" | "number";
  unit: string;
  rules: ProtocolRule[];
  stale_disposition: Disposition;
  reason: string;
  source_type: string | null;
  source_url: string | null;
  verified_on: CalendarDate | null;
}
/** GET /rx/protocols (public): the rules themselves, for reading. The wizard's questions are RxRequest.questions. */
export interface ProtocolSet {
  version: string;
  approved_by_note: string;
  general: { questions: ProtocolRuleQuestion[] };
  classes: {
    class_id: string;
    title: string;
    summary: string;
    questions: ProtocolRuleQuestion[];
    monitoring: ProtocolRuleMonitoring[];
  }[];
}
/** Items of GET /rx/formulary (public). */
export interface FormularyItem extends DrugRef {
  form: string;
  strengths: string[];
  renewal_scope: RenewalScope;
  reason: string;
  source_type: string;
  source_url: string | null;
  verified_on: CalendarDate | null;
}
export interface FormularyParams extends ListParams {
  scope?: RenewalScope;
}

// ------------------------------------------------------------------------------------------- clinic

export type PrevisitState = "none" | "active" | "submitted" | "reviewed" | "red_flag";
export interface AppointmentRow {
  appointment: Appointment;
  patient: PersonRef;
  previsit: PrevisitState;
}
export interface ClinicOverview {
  counts: { urgent: number; pending: number; rx_review: number; overdue: number; waiting_patient: number; tickets: number };
  today: AppointmentRow[];
  activity: { at: Instant; text: string; link: string | null }[];
}
export type WorklistBucket = "urgent" | "pending" | "mine" | "waiting" | "done";
export interface WorkItem {
  type: "visit" | "rx" | "ticket";
  id: string;
  patient: PersonRef;
  title: string;
  subtitle: string;
  urgency: Urgency;
  status: string;
  assigned_to: PersonRef | null;
  due_at: Instant | null;
  updated_at: Instant;
  link: string;
}
export interface Worklist extends Page<WorkItem> {
  counts: Record<WorklistBucket, number>;
}
export interface WorklistParams extends ListParams {
  bucket?: WorklistBucket;
  sort?: string;
}
export type CareStatus = "new" | "active" | "watch" | "inactive";
export interface PatientRow {
  patient: PersonRef;
  age: number | null;
  sex: HealthProfile["sex"];
  conditions: string[];
  tags: string[];
  care_status: CareStatus;
  physician: PersonRef | null;
  coordinator: PersonRef | null;
  last_contact_at: Instant | null;
  open_items: number;
  next_appointment_at: Instant | null;
  flags: string[];
}
export interface PatientListParams extends ListParams {
  tag?: string;
  status?: CareStatus;
  assigned?: string;
}
export interface StaffNote {
  id: string;
  author: PersonRef;
  body: string;
  pinned: boolean;
  created_at: Instant;
}
export interface TimelineEntry {
  at: Instant;
  kind: string;
  title: string;
  link: string | null;
  actor: PersonRef | null;
}
export interface PatientDetail {
  row: PatientRow;
  profile: HealthProfile;
  medications: MedicationCard[];
  measurements: Measurement[];
  visits: Visit[];
  rx: RxRequestBrief[];
  appointments: Appointment[];
  tickets: Ticket[];
  notes: StaffNote[];
  timeline: TimelineEntry[];
}
export interface PatientPatch {
  tags?: string[];
  care_status?: CareStatus;
  physician_id?: string | null;
  coordinator_id?: string | null;
}
export interface ContactInput {
  channel: "in_app" | "phone_note";
  body: string;
}
export interface ScheduleSlot {
  slot_id: string;
  starts_at: Instant;
  minutes: number;
  appointment: Appointment | null;
  patient: PersonRef | null;
  previsit: PrevisitState;
}
export interface ClinicSchedule {
  date: CalendarDate;
  physicians: { physician: PersonRef; slots: ScheduleSlot[] }[];
}

// -------------------------------------------------------------------------------------------- admin

export interface UsageTotals {
  visits: number;
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  red_flags: number;
  rx: number;
}
export interface UsageDay extends UsageTotals {
  day: CalendarDate;
}
export interface AdminOverview {
  totals: UsageTotals & {
    patients: number;
    guests: number;
    staff: number;
    month_cost_usd: number;
    month_budget_usd: number | null;
    calls_today: number;
    daily_call_limit: number;
  };
  series: UsageDay[];
  /** visits_pending, red_flag, rx_review, rx_overdue, rx_more_info, rx_pharmacy, tickets_open */
  queues: Record<string, number>;
  system: { version: string; model_ready: boolean; uptime_s: number; db_ok: boolean; ai_enabled: boolean };
}
export interface AccountRow {
  id: string;
  username: string | null;
  display_name: string;
  role: Role;
  title: string | null;
  status: "active" | "disabled";
  is_guest: boolean;
  is_demo: boolean;
  created_at: Instant;
  last_login_at: Instant | null;
  sessions: number;
}
export interface AccountListParams extends ListParams {
  role?: Role;
  status?: "active" | "disabled";
}
export interface CreateAccountInput {
  username: string;
  display_name: string;
  role: Role;
  title?: string;
}
export interface AccountPatch {
  display_name?: string;
  role?: Role;
  title?: string | null;
  status?: "active" | "disabled";
}
/** The one-time password is shown once and never cached. */
export interface OneTimePassword {
  account: AccountRow;
  password: string;
}
export interface PermissionMatrix {
  roles: Role[];
  permissions: { id: Permission; label: string; description: string }[];
  matrix: Record<Role, Permission[]>;
}
export interface AiSettings {
  enabled: boolean;
  primary: string;
  fallback: string | null;
  thinking: string;
  temperature: number;
  max_steps: number;
  daily_call_limit: number;
  per_client_daily_limit: number;
  /** null = no monthly limit. */
  monthly_budget_usd: number | null;
  on_budget: "fallback" | "stop";
  prices: Record<string, { in: number; out: number }>;
}
export interface AdminSettings {
  revision: number;
  ai: AiSettings;
  limits: { messages_per_10min: number; visits_per_10min: number; max_messages_per_visit: number };
  rx: { sla_hours_routine: number; sla_hours_soon: number; /** read only */ oversight_phase: 1 };
  retention_days: number;
}
export interface OversightClass {
  class_id: string;
  class: string;
  total: number;
  engine: Record<Disposition, number>;
  decisions: Record<RxOutcome, number>;
  agreement_rate: number | null;
  /** Items the engine marked `review` that a physician decided; they are not part of the agreement rate. */
  review_decided: number;
  threshold_total: number;
}
export interface OversightReport {
  phase: number;
  by_class: OversightClass[];
  turnaround: { median_h: number | null; p90_h: number | null };
  returned_rate: number | null;
  red_flags: { category: RedFlagCategory; label: string | null; n: number }[];
  guard: { kind: GuardKind; n: number }[];
}
export interface DateRange {
  from?: CalendarDate;
  to?: CalendarDate;
}
/** A Run plus where it ran; never patient text. `guard` comes with GET /admin/runs/{id} only. */
export interface AdminRun extends Run {
  visit_id: string;
  cost_usd: number;
  tools: { name: ToolName; source: ToolSource; status: ToolStatus; step: number; duration_ms: number }[];
  guard?: { kind: GuardKind; action: "rewritten" | "replaced" }[];
}
export interface RunListParams extends ListParams {
  status?: RunStatus;
  model?: string;
}
export interface AuditEntry {
  at: Instant;
  actor: PersonRef;
  kind: "admin" | "access" | "rx" | "auth" | "clinic";
  action: string;
  target: string;
  detail: unknown;
}
export interface AuditParams extends ListParams, DateRange {
  /** Account id. */
  actor?: string;
  /** Exact action name. */
  action?: string;
  kind?: AuditEntry["kind"];
}
/** GET /admin/rules (read only). */
export interface AdminRules {
  red_flags: {
    id: string;
    category: RedFlagCategory;
    severity: string;
    lang: string;
    label: string;
    pattern: string;
    note: string;
  }[];
  scope: { id: string; verdict: PrecheckScope; lang: string; pattern: string; note: string }[];
  refill: { key: string; value: string; unit: string; text: string; source_url: string; verified_on: string }[];
  protocols: ProtocolSet;
  formulary: FormularyItem[];
}

export interface EvalCategory {
  key: "intake" | "red_flag" | "refill" | "out_of_scope" | "boundary" | (string & {});
  total: number;
  passed: number;
}
export interface EvalSummary {
  ran_at: Instant;
  model: string;
  total: number;
  passed: number;
  categories: EvalCategory[];
}
export interface AdminEval {
  latest: EvalSummary | null;
  history: EvalSummary[];
}

// ------------------------------------------------------------------------------------------- public

export interface Health {
  ok: boolean;
  version: string;
  model_ready: boolean;
}
export interface Meta {
  app: string;
  version: string;
  server_today: CalendarDate;
  models: { primary: string; fallback: string | null };
  retention_days: number;
  max_message_chars: number;
  daily_limit_reached: boolean;
  eval: EvalSummary | null;
  oversight_phase: number;
  protocol_version: string;
  formulary_counts: Record<RenewalScope, number>;
  ai_enabled: boolean;
}
export interface TrustFacts {
  red_flag_rules: number;
  red_flag_categories: number;
  scope_rules: number;
  refill_rules: { key: string; value: string; unit: string; text: string; source_url: string; verified_on: CalendarDate }[];
  handbook_sections: number;
  eval_cases: number;
  eval: EvalSummary | null;
  protocol_version: string;
  formulary_counts: Record<RenewalScope, number>;
  retention_days: number;
  oversight_phase: number;
  sla_hours: { routine: number; soon: number };
  limits: { daily_call_limit: number; max_message_chars: number };
  version: string;
  models: { primary: string; fallback: string | null };
  ai_enabled: boolean;
}
export interface HandbookEntry {
  section: string;
  title: string;
  chapter: string;
  text: string;
  source_type: "official" | "project" | (string & {});
  source_name: string;
  source_url: string | null;
  verified_on: CalendarDate;
}
export interface HandbookHit extends Omit<HandbookEntry, "text" | "chapter"> {
  snippet: string;
  score: number;
}
