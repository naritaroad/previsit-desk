// Refill-check form: defaults, validation and conversion to the contract's RefillInput. Pure.
// The server stays the authority (it answers 422 invalid_request with the field names); these
// checks only catch what the patient can fix before sending.

import type { RefillInput, SpecialStatus } from "../api/types.ts";
import { addDays, isValidDate } from "./format.ts";

export const SPECIAL_STATUSES: readonly SpecialStatus[] = [
  "none",
  "going_abroad",
  "returning_island",
  "ocean_fishing_crew",
  "international_crew",
  "rare_disease",
];

export interface RefillFormValues {
  prescription_date: string;
  total_days: string;
  days_per_fill: string;
  fills_done: string;
  last_fill_date: string;
  controlled: "no" | "yes" | "unsure";
  special_status: SpecialStatus;
  symptom_changed: boolean;
  side_effects: boolean;
  /** Demo only: pretend today is another day. Ignored unless `use_today_override` is on. */
  use_today_override: boolean;
  today_override: string;
}

export type RefillFieldKey =
  | "prescription_date"
  | "total_days"
  | "days_per_fill"
  | "fills_done"
  | "last_fill_date"
  | "today_override";

export type RefillErrorCode =
  | "required"
  | "bad_date"
  | "bad_number"
  | "fills_range"
  | "after_today"
  | "before_prescription"
  | "per_fill_exceeds_total";

export type RefillErrors = Partial<Record<RefillFieldKey, RefillErrorCode>>;

/**
 * Example values so the demo gives an answer in one click: a 90-day prescription in three 30-day
 * fills, first fill 24 days ago. The form tells the patient to replace them with the real dates.
 * `today` is the server's Asia/Taipei date (GET /meta server_today).
 */
export function defaultRefillForm(today: string): RefillFormValues {
  const start = addDays(today, -24);
  return {
    prescription_date: start,
    total_days: "90",
    days_per_fill: "30",
    fills_done: "1",
    last_fill_date: start,
    controlled: "no",
    special_status: "none",
    symptom_changed: false,
    side_effects: false,
    use_today_override: false,
    today_override: today,
  };
}

function parseIntStrict(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  return Number(t);
}

export function validateRefillForm(v: RefillFormValues, serverToday: string): RefillErrors {
  const errors: RefillErrors = {};
  const today = v.use_today_override && v.today_override ? v.today_override : serverToday;

  const checkDate = (key: "prescription_date" | "last_fill_date" | "today_override", value: string) => {
    if (!value.trim()) errors[key] = "required";
    else if (!isValidDate(value)) errors[key] = "bad_date";
  };
  checkDate("prescription_date", v.prescription_date);
  checkDate("last_fill_date", v.last_fill_date);
  if (v.use_today_override) checkDate("today_override", v.today_override);

  const total = parseIntStrict(v.total_days);
  const per = parseIntStrict(v.days_per_fill);
  const fills = parseIntStrict(v.fills_done);
  if (total === null || total < 1) errors.total_days = v.total_days.trim() ? "bad_number" : "required";
  if (per === null || per < 1) errors.days_per_fill = v.days_per_fill.trim() ? "bad_number" : "required";
  if (fills === null) errors.fills_done = v.fills_done.trim() ? "bad_number" : "required";
  else if (fills < 1 || fills > 3) errors.fills_done = "fills_range";
  if (total !== null && per !== null && total >= 1 && per >= 1 && per > total) errors.days_per_fill = "per_fill_exceeds_total";

  if (!errors.last_fill_date && !errors.today_override && v.last_fill_date > today) errors.last_fill_date = "after_today";
  if (!errors.prescription_date && !errors.today_override && v.prescription_date > today) errors.prescription_date = "after_today";
  if (!errors.last_fill_date && !errors.prescription_date && v.last_fill_date < v.prescription_date)
    errors.last_fill_date = "before_prescription";

  return errors;
}

export function hasErrors(errors: RefillErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Call only after validateRefillForm returned no errors. */
export function toRefillInput(v: RefillFormValues): RefillInput {
  const input: RefillInput = {
    prescription_date: v.prescription_date,
    total_days: Number(v.total_days),
    days_per_fill: Number(v.days_per_fill),
    fills_done: Number(v.fills_done),
    last_fill_date: v.last_fill_date,
    controlled: v.controlled,
    special_status: v.special_status,
    symptom_changed: v.symptom_changed,
    side_effects: v.side_effects,
  };
  if (v.use_today_override && v.today_override) input.today = v.today_override;
  return input;
}

/** Map field names from a 422 response (`error.fields`) to form fields; unknown names are ignored. */
export function serverFieldErrors(fields: Record<string, string>): RefillErrors {
  const known: RefillFieldKey[] = ["prescription_date", "total_days", "days_per_fill", "fills_done", "last_fill_date"];
  const out: RefillErrors = {};
  for (const f of Object.keys(fields)) {
    if (f === "today") out.today_override = "bad_date";
    else if ((known as string[]).includes(f)) out[f as RefillFieldKey] = f.endsWith("_date") ? "bad_date" : "bad_number";
  }
  return out;
}

/** Outcome presentation: one shape and icon per outcome so colour is never the only signal. */
export const OUTCOME_ORDER = ["eligible", "too_early", "revisit", "consult"] as const;
