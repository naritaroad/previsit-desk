// Finds the handoff ticket that a fixed reply (refusal or red flag) caused, so the chat can say so
// right under that reply. Tickets carry no message id, so the match is by reason and time: a ticket
// raised while that reply was being written.

import type { Message, Ticket, TicketReason } from "../api/types.ts";

const REFUSAL_REASONS: readonly TicketReason[] = ["prescription_request", "controlled_drug"];
const BEFORE_MS = 15_000;
const AFTER_MS = 5_000;

export function ticketForMessage(m: Pick<Message, "role" | "kind" | "created_at">, tickets: readonly Ticket[]): Ticket | null {
  if (m.role !== "assistant" || (m.kind !== "refusal" && m.kind !== "red_flag")) return null;
  const at = Date.parse(m.created_at);
  if (Number.isNaN(at)) return null;
  const reasons: readonly TicketReason[] = m.kind === "refusal" ? REFUSAL_REASONS : ["red_flag"];
  let best: Ticket | null = null;
  let bestGap = Infinity;
  for (const tk of tickets) {
    if (!reasons.includes(tk.reason)) continue;
    const gap = Date.parse(tk.created_at) - at; // negative: the ticket came first
    if (Number.isNaN(gap) || gap < -BEFORE_MS || gap > AFTER_MS) continue;
    if (Math.abs(gap) < bestGap) {
      best = tk;
      bestGap = Math.abs(gap);
    }
  }
  return best;
}
