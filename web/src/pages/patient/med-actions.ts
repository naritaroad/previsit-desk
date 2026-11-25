// What can be done with a medicine today, from the card the server computed. Nothing here decides eligibility: dates,
// state and scope are the server's, this only picks the sentence and the button.

import type { MedicationCard, RxRequestBrief } from "@/api/types";

export type MedStep = { do: "open"; requestId: string } | { do: "refill" } | { do: "renewal" } | { do: "visit" } | { do: "none" };
export interface MedAdvice {
  step: MedStep;
  /** Key under patient:advice. */
  reason: "open" | "openDraft" | "windowOpen" | "late" | "lateBlocked" | "soon" | "onHand" | "renew" | "renewIndividual" | "excluded" | "preview" | "self";
  /** The server's own sentence, when it explains more than we could. */
  detail: string | null;
}

export function medAdvice(m: MedicationCard, request?: Pick<RxRequestBrief, "status"> | null): MedAdvice {
  if (m.source === "self_reported") return { step: { do: "none" }, reason: "self", detail: null };
  if (m.open_request_id) return { step: { do: "open", requestId: m.open_request_id }, reason: request?.status === "draft" ? "openDraft" : "open", detail: null };
  const preview = m.refill_preview;
  const blocked = preview && preview.outcome !== "eligible" && preview.outcome !== "too_early" ? preview.message : null;
  if (m.state === "window_open") return blocked ? { step: { do: "visit" }, reason: "preview", detail: blocked } : { step: { do: "refill" }, reason: "windowOpen", detail: null };
  if (m.state === "late") return preview?.outcome === "eligible" ? { step: { do: "refill" }, reason: "late", detail: null } : { step: { do: "visit" }, reason: "lateBlocked", detail: blocked };
  if (m.state === "window_soon") return { step: { do: "none" }, reason: "soon", detail: null };
  if (m.state === "on_hand") return { step: { do: "none" }, reason: "onHand", detail: null };
  if (m.renewal_scope === "excluded") return { step: { do: "visit" }, reason: "excluded", detail: null };
  return { step: { do: "renewal" }, reason: m.renewal_scope === "physician_only" ? "renewIndividual" : "renew", detail: null };
}

/** Needs attention first, then by how soon the supply ends. Self-reported medicines last. */
const RANK: Record<MedicationCard["state"], number> = { late: 0, window_open: 1, finished: 2, expired: 3, window_soon: 4, on_hand: 5 };
export function sortMeds(items: readonly MedicationCard[]): MedicationCard[] {
  return [...items].sort((a, b) => Number(a.source === "self_reported") - Number(b.source === "self_reported") || RANK[a.state] - RANK[b.state] || a.days_left - b.days_left);
}
export function needsAttention(m: MedicationCard): boolean {
  return m.source === "clinic" && (m.state === "window_open" || m.state === "late" || m.state === "finished" || m.state === "expired");
}
