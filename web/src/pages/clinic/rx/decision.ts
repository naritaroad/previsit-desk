// Rules of a physician's decision, as the server checks them (backend rx/machine.rs, check_decision). The server has the
// last word; this only says beforehand what is missing. Nothing here prefers one outcome over another.

import type { Disposition, RxItem, RxOutcome, RxStatus } from "@/api/types";

export const OUTCOMES: readonly RxOutcome[] = ["approve", "visit_required", "decline", "more_info"];

export interface ItemDraft {
  outcome: RxOutcome | null;
  note: string;
}
export type NoteNeed = "override" | "question" | "reason" | null;

const AGAINST: readonly Disposition[] = ["in_person", "urgent"];
/** Approving although the check suggests a visit or an emergency: the physician writes why. */
export const isOverride = (item: Pick<RxItem, "engine">, outcome: RxOutcome | null): boolean => outcome === "approve" && !!item.engine && AGAINST.includes(item.engine.disposition);

/** What the note of this item has to contain for this outcome. */
export function noteNeed(item: Pick<RxItem, "engine">, outcome: RxOutcome | null): NoteNeed {
  if (isOverride(item, outcome)) return "override";
  if (outcome === "more_info") return "question";
  if (outcome === "decline" || outcome === "visit_required") return "reason";
  return null;
}

export type ItemProblem = "undecided" | "no_pharmacy" | Exclude<NoteNeed, null>;
export function itemProblem(item: Pick<RxItem, "engine">, draft: ItemDraft | undefined, patientMessage: string, hasPharmacy: boolean): ItemProblem | null {
  if (!draft?.outcome) return "undecided";
  if (draft.outcome === "approve" && !hasPharmacy) return "no_pharmacy";
  const need = noteNeed(item, draft.outcome);
  if (!need || draft.note.trim()) return null;
  // A reason may be shared in the message to the patient; a question or an override may not.
  return need === "reason" && patientMessage.trim() ? null : need;
}

/** Where the whole request goes. Null while an item is undecided. */
export function requestOutcome(outcomes: readonly (RxOutcome | null | undefined)[]): Extract<RxStatus, "more_info" | "approved" | "partially_approved" | "visit_required" | "declined"> | null {
  if (outcomes.length === 0 || outcomes.some((o) => !o)) return null;
  if (outcomes.includes("more_info")) return "more_info";
  if (outcomes.every((o) => o === "approve")) return "approved";
  if (outcomes.includes("approve")) return "partially_approved";
  return outcomes.includes("visit_required") ? "visit_required" : "declined";
}

/** Numbered lines for the note of a more_info item. */
export const questionText = (questions: readonly string[]): string => {
  const list = questions.map((q) => q.trim()).filter(Boolean);
  return list.length < 2 ? list.join("") : list.map((q, i) => `${i + 1}. ${q}`).join("\n");
};
