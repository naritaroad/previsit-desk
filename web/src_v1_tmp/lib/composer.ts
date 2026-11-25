// Rules for the message composer. Pure.

/** Characters as the server counts them: Unicode code points, not UTF-16 units. */
export function charCount(text: string): number {
  let n = 0;
  for (const ch of text) if (ch) n += 1;
  return n;
}

export type ComposerBlock = "empty" | "too_long" | "busy" | "closed" | null;

export function composerBlock(text: string, max: number, busy: boolean, closed: boolean): ComposerBlock {
  if (closed) return "closed";
  if (busy) return "busy";
  const trimmed = text.trim();
  if (trimmed === "") return "empty";
  if (charCount(trimmed) > max) return "too_long";
  return null;
}

/** The counter turns to a warning in the last 10 % of the limit. */
export function counterState(count: number, max: number): "ok" | "near" | "over" {
  if (count > max) return "over";
  if (count >= Math.floor(max * 0.9)) return "near";
  return "ok";
}

/** Enter sends; Shift+Enter and IME composition (Chinese input) do not. */
export function shouldSendOnKey(e: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  if (e.key !== "Enter" || e.shiftKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  return true;
}
