// Standalone refill check form (inside a visit): defaults and conversion to the contract's RefillInput. Field
// validation is refillSchema in src/api/schemas.ts; the server stays the authority (422 with fields).

import type { CalendarDate, RefillInput, SpecialStatus } from "../api/types.ts";
import { addDays } from "./format.ts";

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
}

/** Example values; `today` is the server's Asia/Taipei date (meta.server_today). The form says to replace them. */
export function defaultRefillForm(today: CalendarDate): RefillFormValues {
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
  };
}

/** Dates that only make sense against "today"; returned as zod-style message keys. */
export function futureDateErrors(v: Pick<RefillFormValues, "prescription_date" | "last_fill_date">, today: CalendarDate): Partial<Record<"prescription_date" | "last_fill_date", string>> {
  const out: Partial<Record<"prescription_date" | "last_fill_date", string>> = {};
  if (v.prescription_date > today) out.prescription_date = "field.future";
  if (v.last_fill_date > today) out.last_fill_date = "field.future";
  return out;
}

/** Call after validation. */
export function toRefillInput(v: RefillFormValues): RefillInput {
  return { ...v, total_days: Number(v.total_days), days_per_fill: Number(v.days_per_fill), fills_done: Number(v.fills_done) };
}
