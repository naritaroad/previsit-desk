// zod schemas for what people type into forms. Messages are keys of the `errors` namespace
// (errors:field.*), so forms translate them with fieldMessage() from src/lib/errors.ts. The server stays the
// authority: a 422 with `fields` is shown on the same inputs.

import { z } from "zod";

import { isValidDate } from "../lib/format.ts";

const required = "field.required";
const username = z
  .string()
  .trim()
  .min(1, required)
  .min(3, "field.usernameShort")
  .max(32, "field.usernameLong")
  .regex(/^[a-z0-9][a-z0-9_.-]*$/i, "field.usernameChars");
const password = z.string().min(1, required).min(8, "field.passwordShort").max(128, "field.passwordLong");
const displayName = z.string().trim().min(1, required).max(40, "field.tooLong");

export const loginSchema = z.object({
  username: z.string().trim().min(1, required),
  password: z.string().min(1, required),
});
export const claimSchema = z.object({ username, password, display_name: displayName });
export const registerSchema = claimSchema;
export const passwordSchema = z
  .object({ current: z.string().min(1, required), next: password, confirm: z.string().min(1, required) })
  .refine((v) => v.next === v.confirm, { path: ["confirm"], message: "field.passwordMismatch" })
  .refine((v) => v.next !== v.current, { path: ["next"], message: "field.passwordSame" });

const date = z.string().min(1, required).refine(isValidDate, "field.date");

/** Number inputs give strings; an empty one is "required", not 0. */
const numberIn = (min: number, max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? undefined : Number(v)) : v),
    z.number({ error: (issue) => (issue.input === undefined ? required : "field.number") }).min(min, "field.range").max(max, "field.range"),
  );

/** Plausible ranges only catch typing mistakes; they say nothing about health. */
export const bpSchema = z
  .object({ systolic: numberIn(50, 300), diastolic: numberIn(20, 200), taken_at: z.string().min(1, required) })
  .refine((v) => v.systolic > v.diastolic, { path: ["diastolic"], message: "field.bpOrder" });
export const glucoseSchema = z.object({ value: numberIn(10, 900), taken_at: z.string().min(1, required) });
export const weightSchema = z.object({ value: numberIn(2, 400), taken_at: z.string().min(1, required) });
export const pulseSchema = z.object({ value: numberIn(20, 300), taken_at: z.string().min(1, required) });
export const labSchema = z.object({
  name: z.string().trim().min(1, required).max(40, "field.tooLong"),
  value: numberIn(-10_000, 1_000_000),
  unit: z.string().trim().max(20, "field.tooLong"),
  taken_at: z.string().min(1, required),
});
export const measurementSchemas = {
  bp: bpSchema,
  glucose: glucoseSchema,
  weight: weightSchema,
  pulse: pulseSchema,
  lab: labSchema,
} as const;

const item = z.object({
  id: z.string(),
  name: z.string().trim().min(1, required).max(80, "field.tooLong"),
  detail: z.string().trim().max(300, "field.tooLong").nullable(),
  since: z.string().trim().max(20, "field.tooLong").nullable(),
  source: z.enum(["patient", "clinic"]),
  status: z.enum(["active", "inactive"]),
});
export const profileSchema = z.object({
  revision: z.number().int().nonnegative(),
  display_name: displayName,
  birth_year: z.number().int().min(1900, "field.range").max(2100, "field.range").nullable(),
  sex: z.enum(["female", "male", "other"]).nullable(),
  height_cm: z.number().min(30, "field.range").max(260, "field.range").nullable(),
  conditions: z.array(item),
  medications: z.array(item),
  allergies: z.array(item),
  family_history: z.array(item),
  lifestyle: z.object({
    smoking: z.string().nullable(),
    alcohol: z.string().nullable(),
    exercise: z.string().nullable(),
  }),
  preferred_pharmacy_id: z.string().nullable(),
  contact_preference: z.literal("in_app"),
});

export const selfReportedMedicationSchema = z.object({
  name: z.string().trim().min(1, required).max(80, "field.tooLong"),
  dose_text: z.string().trim().max(120, "field.tooLong"),
});

export const refillSchema = z
  .object({
    prescription_date: date,
    total_days: numberIn(1, 3650),
    days_per_fill: numberIn(1, 3650),
    fills_done: numberIn(1, 3),
    last_fill_date: date,
    controlled: z.enum(["no", "yes", "unsure"]),
    special_status: z.enum(["none", "going_abroad", "returning_island", "ocean_fishing_crew", "international_crew", "rare_disease"]),
    symptom_changed: z.boolean(),
    side_effects: z.boolean(),
  })
  .refine((v) => v.days_per_fill <= v.total_days, { path: ["days_per_fill"], message: "field.perFillExceedsTotal" })
  .refine((v) => !isValidDate(v.last_fill_date) || !isValidDate(v.prescription_date) || v.last_fill_date >= v.prescription_date, { path: ["last_fill_date"], message: "field.beforePrescription" });

export const pickupSchema = z.object({ date, slot: z.enum(["morning", "afternoon", "evening"]) });

export const createAccountSchema = z.object({
  username,
  display_name: displayName,
  role: z.enum(["patient", "physician", "pharmacist", "coordinator", "admin"]),
  title: z.string().trim().max(40, "field.tooLong").optional(),
});

/** A message as the server counts it: trimmed, 1..max Unicode code points. */
export const messageSchema = (max: number) =>
  z
    .string()
    .trim()
    .min(1, required)
    .refine((s) => [...s].length <= max, "field.messageLong");

export type LoginForm = z.infer<typeof loginSchema>;
export type ClaimForm = z.infer<typeof claimSchema>;
export type PasswordForm = z.infer<typeof passwordSchema>;
export type RefillForm = z.infer<typeof refillSchema>;
export type ProfileForm = z.infer<typeof profileSchema>;
export type CreateAccountForm = z.infer<typeof createAccountSchema>;
