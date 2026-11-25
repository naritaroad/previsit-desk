// Rx presentation and wizard rules. Pure. Labels are keys of the `rx` namespace; `tone` is one of the design
// system's semantic tones, always shown with text so colour is never the only signal.

import type {
  Disposition,
  MedicationState,
  MonitoringValue,
  ProtocolQuestion,
  RefillOutcome,
  RenewalScope,
  RxAction,
  RxEvent,
  RxKind,
  RxOutcome,
  RxRequest,
  RxStatus,
  Urgency,
  VisitStatus,
} from "../api/types.ts";
import { daysBetween, isValidDate } from "./format.ts";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";
export interface StatusMeta {
  labelKey: string;
  /** One sentence for the patient: what happens next. */
  hintKey: string;
  tone: Tone;
}

const RX_TONE: Readonly<Record<RxStatus, Tone>> = {
  draft: "neutral",
  submitted: "info",
  in_review: "info",
  more_info: "warning",
  approved: "success",
  partially_approved: "success",
  declined: "danger",
  visit_required: "warning",
  at_pharmacy: "info",
  returned: "warning",
  ready: "success",
  dispensed: "neutral",
  cancelled: "neutral",
};
export function rxStatusMeta(status: RxStatus): StatusMeta {
  return { labelKey: `rx:status.${status}`, hintKey: `rx:statusHint.${status}`, tone: RX_TONE[status] };
}

const DISPOSITION_TONE: Readonly<Record<Disposition, Tone>> = {
  ready: "success",
  review: "info",
  in_person: "warning",
  urgent: "danger",
  excluded: "neutral",
};
/** Worst first; the request's disposition is the worst of its items. */
export const DISPOSITION_ORDER: readonly Disposition[] = ["urgent", "excluded", "in_person", "review", "ready"];
export function dispositionMeta(d: Disposition): StatusMeta {
  return { labelKey: `rx:disposition.${d}`, hintKey: `rx:dispositionHint.${d}`, tone: DISPOSITION_TONE[d] };
}
export function worstDisposition(list: readonly Disposition[]): Disposition | null {
  return DISPOSITION_ORDER.find((d) => list.includes(d)) ?? null;
}

const OUTCOME_TONE: Readonly<Record<RxOutcome, Tone>> = {
  approve: "success",
  decline: "danger",
  visit_required: "warning",
  more_info: "info",
};
export function outcomeMeta(o: RxOutcome): StatusMeta {
  return { labelKey: `rx:outcome.${o}`, hintKey: `rx:outcomeHint.${o}`, tone: OUTCOME_TONE[o] };
}

const SCOPE_TONE: Readonly<Record<RenewalScope, Tone>> = { in_scope: "success", physician_only: "warning", excluded: "neutral" };
export function scopeMeta(s: RenewalScope): StatusMeta {
  return { labelKey: `rx:scope.${s}`, hintKey: `rx:scopeHint.${s}`, tone: SCOPE_TONE[s] };
}

const MED_TONE: Readonly<Record<MedicationState, Tone>> = {
  on_hand: "neutral",
  window_soon: "info",
  window_open: "success",
  late: "warning",
  finished: "neutral",
  expired: "neutral",
};
export function medicationMeta(s: MedicationState): StatusMeta {
  return { labelKey: `rx:medState.${s}`, hintKey: `rx:medStateHint.${s}`, tone: MED_TONE[s] };
}

const REFILL_TONE: Readonly<Record<RefillOutcome, Tone>> = {
  eligible: "success",
  too_early: "info",
  revisit: "warning",
  consult: "warning",
};
export function refillMeta(o: RefillOutcome): StatusMeta {
  return { labelKey: `rx:refill.${o}`, hintKey: `rx:refillHint.${o}`, tone: REFILL_TONE[o] };
}

const URGENCY_TONE: Readonly<Record<Urgency, Tone>> = { routine: "neutral", soon: "warning", urgent: "danger" };
export function urgencyMeta(u: Urgency): { labelKey: string; tone: Tone } {
  return { labelKey: `rx:urgency.${u}`, tone: URGENCY_TONE[u] };
}
const VISIT_TONE: Readonly<Record<VisitStatus, Tone>> = {
  active: "info",
  red_flag: "danger",
  submitted: "warning",
  reviewed: "success",
};
export function visitStatusMeta(s: VisitStatus): { labelKey: string; tone: Tone } {
  return { labelKey: `rx:visitStatus.${s}`, tone: VISIT_TONE[s] };
}

// ------------------------------------------------------------------------------------ state machine

export const OPEN_RX: ReadonlySet<RxStatus> = new Set([
  "draft",
  "submitted",
  "in_review",
  "more_info",
  "approved",
  "partially_approved",
  "at_pharmacy",
  "returned",
  "ready",
]);
export function isOpenRx(status: RxStatus): boolean {
  return OPEN_RX.has(status);
}
/** PATCH is accepted in these states only. */
export function isEditableRx(status: RxStatus): boolean {
  return status === "draft" || status === "more_info";
}
/** The buttons to show come from the server; never infer them from the status. */
export function allows(rx: Pick<RxRequest, "allowed_actions"> | null | undefined, action: RxAction): boolean {
  return !!rx && rx.allowed_actions.includes(action);
}

/** The happy path, for a progress bar; null when the request left it. */
const PATH: Readonly<Record<RxKind, readonly RxStatus[]>> = {
  renewal: ["submitted", "in_review", "approved", "at_pharmacy", "ready", "dispensed"],
  refill: ["submitted", "at_pharmacy", "ready", "dispensed"],
};
export function rxProgress(kind: RxKind, status: RxStatus): { steps: readonly RxStatus[]; index: number; left: boolean } {
  const steps = PATH[kind];
  if (status === "draft") return { steps, index: -1, left: false };
  const alias: Partial<Record<RxStatus, RxStatus>> = { more_info: "in_review", partially_approved: "approved", returned: "at_pharmacy" };
  const index = steps.indexOf(alias[status] ?? status);
  if (index >= 0) return { steps, index, left: false };
  // A refill that went to a doctor, or a closed request: show how far it got.
  return { steps, index: status === "in_review" ? 0 : steps.length - 1, left: status !== "in_review" };
}

/** Patient-visible timeline, oldest first. */
export function patientTimeline(events: readonly RxEvent[]): RxEvent[] {
  return events.filter((e) => e.visibility === "all").sort((a, b) => a.at.localeCompare(b.at));
}

// ------------------------------------------------------------------------------------------- wizard

/** Step ids stored in RxRequest.step. */
export const RENEWAL_STEPS = ["items", "identity", "safety", "monitoring", "pharmacy", "review"] as const;
export const REFILL_STEPS = ["items", "safety", "pickup", "review"] as const;
export type RenewalStep = (typeof RENEWAL_STEPS)[number];
export type RefillStep = (typeof REFILL_STEPS)[number];
export type RxStep = RenewalStep | RefillStep;

export function stepsFor(kind: RxKind): readonly RxStep[] {
  return kind === "renewal" ? RENEWAL_STEPS : REFILL_STEPS;
}
/** A stored step this client knows, else the first one. */
export function currentStep(rx: Pick<RxRequest, "kind" | "step">): RxStep {
  const steps = stepsFor(rx.kind);
  return steps.find((s) => s === rx.step) ?? steps[0];
}

/** The server works these out from the visit record. */
const COMPUTED_QUESTIONS: ReadonlySet<string> = new Set(["last_seen_days"]);
const SAME_AS_RECORD = "same_as_record:";
/** "Is this what you take now?" of one item: a required yes/no question the server adds per item. */
export function identityKey(itemId: string): string {
  return `${SAME_AS_RECORD}${itemId}`;
}
export function identityQuestions(rx: Pick<RxRequest, "questions">): ProtocolQuestion[] {
  return rx.questions.filter((q) => q.id.startsWith(SAME_AS_RECORD));
}
/** Safety questions: general ones first, then the classes' (a question two classes share comes once). */
export function askedQuestions(rx: Pick<RxRequest, "questions">): ProtocolQuestion[] {
  return rx.questions.filter((q) => q.scope !== "monitoring" && !COMPUTED_QUESTIONS.has(q.id) && !q.id.startsWith(SAME_AS_RECORD));
}
export function monitoringQuestions(rx: Pick<RxRequest, "questions">): ProtocolQuestion[] {
  return rx.questions.filter((q) => q.scope === "monitoring");
}

export function isAnswered(q: ProtocolQuestion, answer: unknown): boolean {
  switch (q.kind) {
    case "boolean":
      return typeof answer === "boolean";
    case "choice":
      return typeof answer === "string" && q.options.some((o) => o.value === answer);
    case "number":
      return typeof answer === "number" && Number.isFinite(answer);
    case "date":
      return typeof answer === "string" && isValidDate(answer);
    case "text":
      return typeof answer === "string" && answer.trim() !== "";
  }
}

export interface Incomplete {
  step: RxStep;
  /** Question id, item id or field name to focus. */
  id: string;
  reason: "required" | "range" | "future";
}

/** What still blocks submitting, in wizard order. The server checks again. */
export function missingForSubmit(
  rx: Pick<RxRequest, "kind" | "items" | "answers" | "monitoring" | "questions" | "pharmacy" | "pickup_window">,
  today: string,
): Incomplete[] {
  const out: Incomplete[] = [];
  if (!rx.items.some((i) => i.scope !== "excluded")) out.push({ step: "items", id: "items", reason: "required" });
  const check = (q: ProtocolQuestion, step: RxStep) => {
    const a = rx.answers[q.id];
    if (!isAnswered(q, a)) {
      if (q.required) out.push({ step, id: q.id, reason: "required" });
    } else if (typeof a === "number" && ((q.min !== null && a < q.min) || (q.max !== null && a > q.max))) {
      out.push({ step, id: q.id, reason: "range" });
    }
  };
  for (const q of identityQuestions(rx)) check(q, "identity");
  for (const q of askedQuestions(rx)) check(q, "safety");
  if (rx.kind === "refill") {
    if (!rx.pharmacy) out.push({ step: "pickup", id: "pharmacy", reason: "required" });
    if (!rx.pickup_window) out.push({ step: "pickup", id: "pickup_window", reason: "required" });
    else if (rx.pickup_window.date < today) out.push({ step: "pickup", id: "pickup_window", reason: "range" });
    return out;
  }
  for (const q of monitoringQuestions(rx)) {
    const v = rx.monitoring[q.id];
    if (v?.date && (!isValidDate(v.date) || v.date > today)) out.push({ step: "monitoring", id: q.id, reason: "future" });
    else if (v?.value !== undefined && ((q.min !== null && v.value < q.min) || (q.max !== null && v.value > q.max)))
      out.push({ step: "monitoring", id: q.id, reason: "range" });
    else if (q.required && (!v || (v.date === undefined && v.value === undefined)))
      out.push({ step: "monitoring", id: q.id, reason: "required" });
  }
  if (!rx.pharmacy) out.push({ step: "pharmacy", id: "pharmacy", reason: "required" });
  return out.sort((a, b) => RENEWAL_STEPS.indexOf(a.step as RenewalStep) - RENEWAL_STEPS.indexOf(b.step as RenewalStep));
}

/** Age of a monitoring value against the protocol's max_age_days: the same comparison the engine makes. */
export function monitoringAge(q: ProtocolQuestion, v: MonitoringValue | undefined, today: string): { days: number; stale: boolean } | null {
  if (!v?.date || !isValidDate(v.date)) return null;
  const days = daysBetween(v.date, today);
  return { days, stale: q.max_age_days !== null && days > q.max_age_days };
}
