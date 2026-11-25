// The contract has no endpoint for "messages with the care team". A thread is either a previsit that a person from
// the clinic takes part in, or the message list of a request.

import type { RxRequestBrief, Visit } from "@/api/types";

export function hasThread(v: Pick<Visit, "mode" | "status">): boolean {
  return v.mode === "human" || v.status === "reviewed";
}

export interface ThreadRow {
  key: string;
  to: string;
  at: string;
  unread: boolean;
  visit?: Visit;
  rx?: RxRequestBrief;
}

export function threadRows(visits: readonly Visit[], rx: readonly RxRequestBrief[]): ThreadRow[] {
  const rows: ThreadRow[] = [
    ...visits.filter(hasThread).map((v): ThreadRow => ({ key: `visit-${v.id}`, to: `/app/messages/visit-${v.id}`, at: v.last_activity_at, unread: v.has_unread, visit: v })),
    ...rx.filter((r) => r.status !== "draft").map((r): ThreadRow => ({ key: `rx-${r.id}`, to: `/app/messages/rx-${r.id}`, at: r.updated_at, unread: r.unread, rx: r })),
  ];
  return rows.sort((a, b) => Number(b.unread) - Number(a.unread) || b.at.localeCompare(a.at));
}

/** "visit-<id>" or "rx-<id>" from the address. */
export function parseThread(id: string | undefined): { kind: "visit" | "rx"; id: string } | null {
  const m = /^(visit|rx)-(.+)$/.exec(id ?? "");
  return m ? { kind: m[1] as "visit" | "rx", id: m[2] } : null;
}
