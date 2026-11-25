// Types of docs/api/contract.md (v1). Keep this file in step with the contract; do not add fields here
// that the contract does not have.

export type Locale = "zh-TW" | "en";
export type VisitStatus = "active" | "red_flag" | "submitted" | "reviewed";
export type Stage = "chief_complaint" | "hpi" | "background" | "confirm" | "done";
export type Urgency = "routine" | "soon" | "urgent";
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
  locale: Locale;
  status: VisitStatus;
  stage: Stage;
  urgency: Urgency;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
}

export type MessageKind = "opening" | "chat" | "red_flag" | "refusal" | "notice";

export interface Message {
  id: string;
  role: "patient" | "assistant";
  kind: MessageKind;
  content: string;
  created_at: string;
  run_id: string | null;
}

export interface ListField {
  answered: boolean;
  items: string[];
}

export interface Hpi {
  onset: string | null;
  modifiers: string | null;
  character: string | null;
  location: string | null;
  /** 0-10; 'n/a' means the patient cannot or need not rate it (counts as collected). */
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

export interface RedFlagHit {
  category: RedFlagCategory;
  label: string;
  matched_at: string;
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
  created_at: string;
}

export type RunStatus = "running" | "completed" | "failed" | "skipped";

export interface Run {
  id: string;
  model: string;
  fallback_used: boolean;
  status: RunStatus;
  steps: number;
  usage: { input_tokens: number; output_tokens: number };
  error_code: string | null;
  duration_ms: number;
  created_at: string;
}

export interface RefillInput {
  prescription_date: string;
  total_days: number;
  days_per_fill: number;
  fills_done: number;
  last_fill_date: string;
  today?: string;
  controlled: "no" | "yes" | "unsure";
  special_status: SpecialStatus;
  symptom_changed: boolean;
  side_effects: boolean;
}

export interface RefillResult {
  outcome: RefillOutcome;
  title: string;
  message: string;
  today: string;
  earliest_date: string | null;
  latest_date: string | null;
  next_fill_number: number | null;
  reasons: { code: string; text: string }[];
  rules: { key: string; text: string; source_url: string }[];
  handoff: boolean;
  ticket_no: string | null;
}

export interface PrevisitSummary {
  visit_id: string;
  chief_complaint: string | null;
  hpi: Hpi;
  past_history: string[];
  medications: string[];
  allergies: string[];
  not_collected: string[];
  red_flag_screen: {
    checked: boolean;
    triggered: { category: RedFlagCategory; label: string }[];
    note: string;
  };
  patient_questions: string[];
  narrative: string;
  refill: RefillResult | null;
  generated_by: { kind: "model" | "code"; model: string | null; at: string };
  disclaimer: string;
}

export interface Ticket {
  id: string;
  ticket_no: string;
  visit_id: string;
  reason: TicketReason;
  urgency: Urgency;
  summary: string;
  status: "open" | "resolved";
  created_by: "model" | "code" | "form";
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export interface RefillCheckRecord {
  id: string;
  input: RefillInput;
  result: RefillResult;
  created_at: string;
}

export interface VisitDetail {
  visit: Visit;
  messages: Message[];
  intake: IntakeView;
  summary: PrevisitSummary | null;
  red_flag: RedFlagHit | null;
  tickets: Ticket[];
  tool_calls: ToolCall[];
  runs: Run[];
  refill_checks: RefillCheckRecord[];
}

export interface EvalCategory {
  key: "intake" | "red_flag" | "refill" | "out_of_scope" | "boundary";
  total: number;
  passed: number;
}

export interface EvalSummary {
  ran_at: string;
  model: string;
  total: number;
  passed: number;
  categories: EvalCategory[];
}

export interface Meta {
  app: string;
  version: string;
  /** Asia/Taipei calendar date (YYYY-MM-DD) of the server; the default for the refill form's "today". */
  server_today: string;
  models: { primary: string; fallback: string };
  retention_days: number;
  max_message_chars: number;
  daily_limit_reached: boolean;
  eval: EvalSummary | null;
}

export interface ClinicianUser {
  username: string;
  display_name: string;
  role: "clinician";
}

export interface ClinicianVisitItem {
  visit: Visit;
  chief_complaint: string | null;
  red_flag: { category: RedFlagCategory; label: string } | null;
  open_tickets: number;
  has_summary: boolean;
  message_count: number;
  last_activity_at: string;
}

export type ClinicianTicket = Ticket & { chief_complaint: string | null };

// ---- SSE (contract section 4) ----

export type PrecheckScope = "ok" | "prescription_request" | "injection" | "controlled_drug";
export type GuardKind = "diagnosis" | "dosage" | "prescribing" | "other";
export type RunFailureCode = "max_steps" | "timeout" | "model_error" | "not_configured" | "daily_budget_exceeded";

export interface StreamEnvelope {
  v: number;
  seq: number;
  type: string;
  data: unknown;
}

export type StreamEvent =
  | { type: "message.accepted"; data: { message_id: string; visit_id: string } }
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
  | {
      type: "run.completed";
      data: {
        run_id: string;
        status: "completed" | "skipped";
        steps: number;
        usage: { input_tokens: number; output_tokens: number };
        model: string;
      };
    }
  | { type: "run.failed"; data: { run_id: string; code: RunFailureCode; message: string } };

export type StreamEventType = StreamEvent["type"];
