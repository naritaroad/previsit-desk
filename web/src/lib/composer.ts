// Rules for the message composer. Pure.

import type { Visit } from "../api/types.ts";

/** Characters as the server counts them: Unicode code points, not UTF-16 units. */
export function charCount(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

export type ComposerBlock = "empty" | "too_long" | "closed" | null;

/** Queued messages wait for the running turn, so "busy" never blocks typing or sending in v2. */
export function composerBlock(text: string, max: number, closed: boolean): ComposerBlock {
  if (closed) return "closed";
  const trimmed = text.trim();
  if (trimmed === "") return "empty";
  return charCount(trimmed) > max ? "too_long" : null;
}

/** The counter turns to a warning in the last 10 % of the limit. */
export function counterState(count: number, max: number): "ok" | "near" | "over" {
  if (count > max) return "over";
  return count >= Math.floor(max * 0.9) ? "near" : "ok";
}

/** Enter sends; Shift+Enter and IME composition (Chinese input) do not. */
export function shouldSendOnKey(e: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  if (e.key !== "Enter" || e.shiftKey) return false;
  return !(e.isComposing || e.keyCode === 229);
}

/** The visit has been sent to the doctor (a red_flag visit stays red_flag after submit, so check submitted_at). */
export function isSent(visit: Pick<Visit, "status" | "submitted_at"> | null): boolean {
  return !!visit && (visit.submitted_at !== null || visit.status === "submitted" || visit.status === "reviewed");
}

/**
 * open: normal. paused: red flag, the assistant answers with a fixed reminder. closed: submitted or reviewed.
 * human: the care team took over and answers here, also on submitted visits.
 */
export type ComposerMode = "open" | "paused" | "closed" | "human";
export function composerMode(visit: Pick<Visit, "status" | "mode"> | null): ComposerMode {
  if (!visit) return "open";
  if (visit.mode === "human") return "human";
  if (visit.status === "red_flag") return "paused";
  return visit.status === "submitted" || visit.status === "reviewed" ? "closed" : "open";
}
