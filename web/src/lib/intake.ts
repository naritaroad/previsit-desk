// Rows for the intake preview, the summary editor and the review desk. Pure. Field keys and order are fixed by
// the contract (INTAKE_FIELDS).

import { INTAKE_FIELDS } from "../api/types.ts";
import type { IntakeFieldKey, IntakeState, IntakeView, PrevisitSummary, Stage, SummaryChanges } from "../api/types.ts";

/** Fields that decide the stage; the others are suggestions. */
const CORE: ReadonlySet<string> = new Set([
  "chief_complaint",
  "hpi.onset",
  "hpi.course",
  "hpi.severity",
  "hpi.associated",
  "past_history",
  "medications",
  "allergies",
]);
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
  /** Text for 'filled'; list items joined. */
  value: string;
  /** List items, for the list fields. */
  items: string[] | null;
  /** Message ids the value came from (summaries only). */
  evidence: string[];
}

/** The backend normalises every spelling to 不適用. */
const NOT_APPLICABLE = new Set(["不適用", "n/a", "na", "not applicable"]);
export function isNotApplicable(text: string): boolean {
  return NOT_APPLICABLE.has(text.trim().toLowerCase());
}

type Row = Omit<IntakeRow, "evidence">;
function textRow(key: IntakeFieldKey, text: string | null): Row {
  if (text === null || text.trim() === "") return { key, status: "missing", value: "", items: null };
  if (isNotApplicable(text)) return { key, status: "na", value: "", items: null };
  return { key, status: "filled", value: text.trim(), items: null };
}
function listRow(key: IntakeFieldKey, field: { answered: boolean; items: string[] }, sep: string): Row {
  if (!field.answered) return { key, status: "missing", value: "", items: [] };
  if (field.items.length === 0) return { key, status: "none", value: "", items: [] };
  return { key, status: "filled", value: field.items.join(sep), items: field.items };
}
function severityRow(v: number | "n/a" | null): Row {
  const key = "hpi.severity";
  if (v === null) return { key, status: "missing", value: "", items: null };
  if (v === "n/a") return { key, status: "na", value: "", items: null };
  return { key, status: "filled", value: `${v} / 10`, items: null };
}

export function intakeRows(state: IntakeState, listSeparator = "、", evidence: Record<string, string[]> = {}): IntakeRow[] {
  const h = state.hpi;
  const rows: Row[] = [
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
  return rows.map((r) => ({ ...r, evidence: evidence[r.key] ?? [] }));
}

/** Rebuild an IntakeState from a stored summary so the same rows can show it. */
export function summaryToState(s: PrevisitSummary): IntakeState {
  const gone = new Set(s.not_collected);
  const list = (key: string, items: string[]) => ({ answered: !gone.has(key), items: gone.has(key) ? [] : items });
  const pick = <T>(key: string, v: T | null): T | null => (gone.has(key) ? null : v);
  return {
    chief_complaint: pick("chief_complaint", s.chief_complaint),
    hpi: {
      onset: pick("hpi.onset", s.hpi.onset),
      modifiers: pick("hpi.modifiers", s.hpi.modifiers),
      character: pick("hpi.character", s.hpi.character),
      location: pick("hpi.location", s.hpi.location),
      severity: pick("hpi.severity", s.hpi.severity),
      course: pick("hpi.course", s.hpi.course),
      associated: pick("hpi.associated", s.hpi.associated),
    },
    past_history: list("past_history", s.past_history),
    medications: list("medications", s.medications),
    allergies: list("allergies", s.allergies),
    patient_questions: s.patient_questions,
  };
}
export function summaryRows(s: PrevisitSummary, listSeparator = "、"): IntakeRow[] {
  return intakeRows(summaryToState(s), listSeparator, s.evidence);
}

/** The summary as it will look after a patient edit (optimistic). Mirrors what the server does with `changes`. */
export function applySummaryChanges(s: PrevisitSummary, changes: SummaryChanges): PrevisitSummary {
  const next: PrevisitSummary = { ...s, hpi: { ...s.hpi }, edited_by_patient: true };
  const gone = new Set(s.not_collected);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (key === "patient_questions" || key === "past_history" || key === "medications" || key === "allergies") {
      next[key] = value as string[];
      gone.delete(key);
      continue;
    }
    if (key === "chief_complaint") next.chief_complaint = value as string | null;
    else if (key === "hpi.severity") next.hpi.severity = value as number | "n/a" | null;
    else if (key.startsWith("hpi.")) {
      const part = key.slice(4) as Exclude<keyof PrevisitSummary["hpi"], "severity">;
      next.hpi[part] = value as string | null;
    }
    if (value === null || value === "") gone.add(key);
    else gone.delete(key);
  }
  next.not_collected = INTAKE_FIELDS.filter((k) => gone.has(k));
  return next;
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
