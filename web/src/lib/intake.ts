// Helpers that turn an IntakeView or a stored summary into rows for the preview. Pure.
// Field keys and their order are fixed by docs/api/contract.md section 7.4.

import type { IntakeState, IntakeView, PrevisitSummary, Stage } from "../api/types.ts";

/** Keys exactly as the contract lists them (IntakeView.missing and PrevisitSummary.not_collected). */
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

/** Fields that decide the stage. The others are "suggested": useful to the doctor, not required to move on. */
const CORE = new Set<string>(["chief_complaint", "hpi.onset", "hpi.course", "hpi.severity", "hpi.associated", "past_history", "medications", "allergies"]);

export function isCoreField(key: string): boolean {
  return CORE.has(key);
}

export const STAGES: readonly Stage[] = ["chief_complaint", "hpi", "background", "confirm", "done"];

export function stageIndex(stage: Stage): number {
  return STAGES.indexOf(stage);
}

/** 'filled' has a value, 'none' is a list answered with "nothing", 'na' is marked not applicable. */
export type FieldStatus = "filled" | "none" | "na" | "missing";

export interface IntakeRow {
  key: IntakeFieldKey;
  status: FieldStatus;
  /** Text to show for 'filled' (list items joined with a separator). Empty for the other statuses. */
  value: string;
}

/** The backend normalises every spelling to this string; the others are accepted in case a summary predates that. */
const NOT_APPLICABLE = new Set(["不適用", "n/a", "na", "not applicable"]);

export function isNotApplicable(text: string): boolean {
  return NOT_APPLICABLE.has(text.trim().toLowerCase());
}

function textRow(key: IntakeFieldKey, text: string | null): IntakeRow {
  if (text === null || text.trim() === "") return { key, status: "missing", value: "" };
  if (isNotApplicable(text)) return { key, status: "na", value: "" };
  return { key, status: "filled", value: text.trim() };
}

function listRow(key: IntakeFieldKey, field: { answered: boolean; items: string[] }, sep: string): IntakeRow {
  if (!field.answered) return { key, status: "missing", value: "" };
  if (field.items.length === 0) return { key, status: "none", value: "" };
  return { key, status: "filled", value: field.items.join(sep) };
}

function severityRow(v: number | "n/a" | null): IntakeRow {
  if (v === null) return { key: "hpi.severity", status: "missing", value: "" };
  if (v === "n/a") return { key: "hpi.severity", status: "na", value: "" };
  return { key: "hpi.severity", status: "filled", value: `${v} / 10` };
}

/** Rows in the contract's key order. */
export function intakeRows(state: IntakeState, listSeparator = "、"): IntakeRow[] {
  const h = state.hpi;
  return [
    textRow("chief_complaint", state.chief_complaint),
    textRow("hpi.onset", h.onset),
    textRow("hpi.course", h.course),
    textRow("hpi.location", h.location),
    textRow("hpi.character", h.character),
    severityRow(h.severity),
    textRow("hpi.modifiers", h.modifiers),
    textRow("hpi.associated", h.associated),
    listRow("past_history", state.past_history, listSeparator),
    listRow("medications", state.medications, listSeparator),
    listRow("allergies", state.allergies, listSeparator),
  ];
}

export function progressPercent(view: Pick<IntakeView, "progress"> | null): number {
  if (!view || view.progress.total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((view.progress.done / view.progress.total) * 100)));
}

/** True for keys the UI can label; unknown keys from a newer server fall back to the raw key. */
export function isKnownField(key: string): key is IntakeFieldKey {
  return (INTAKE_FIELDS as readonly string[]).includes(key);
}

/** Split `missing` into what is still needed and what is only suggested. */
export function splitMissing(missing: string[]): { required: string[]; suggested: string[] } {
  return { required: missing.filter(isCoreField), suggested: missing.filter((k) => !isCoreField(k)) };
}

/** Empty intake used before the first intake.updated arrives. */
export const EMPTY_INTAKE: IntakeView = {
  state: {
    chief_complaint: null,
    hpi: { onset: null, modifiers: null, character: null, location: null, severity: null, course: null, associated: null },
    past_history: { answered: false, items: [] },
    medications: { answered: false, items: [] },
    allergies: { answered: false, items: [] },
    patient_questions: [],
  },
  stage: "chief_complaint",
  missing: [...INTAKE_FIELDS],
  progress: { done: 0, total: INTAKE_FIELDS.length },
};

/** Rebuild an IntakeState from a stored summary so the same rows can show it (not_collected lists the missing keys). */
export function summaryToState(s: PrevisitSummary): IntakeState {
  const gone = new Set(s.not_collected);
  const list = (key: string, items: string[]) => ({ answered: !gone.has(key), items: gone.has(key) ? [] : items });
  const h = s.hpi;
  const pick = (key: string, v: string | null) => (gone.has(key) ? null : v);
  return {
    chief_complaint: s.chief_complaint === null || gone.has("chief_complaint") ? null : s.chief_complaint,
    hpi: {
      onset: pick("hpi.onset", h.onset),
      modifiers: pick("hpi.modifiers", h.modifiers),
      character: pick("hpi.character", h.character),
      location: pick("hpi.location", h.location),
      severity: gone.has("hpi.severity") ? null : h.severity,
      course: pick("hpi.course", h.course),
      associated: pick("hpi.associated", h.associated),
    },
    past_history: list("past_history", s.past_history),
    medications: list("medications", s.medications),
    allergies: list("allergies", s.allergies),
    patient_questions: s.patient_questions,
  };
}
