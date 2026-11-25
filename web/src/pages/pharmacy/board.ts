// The dispensing board: which stage a request is in, what it waits for, and the counts above the page. Stages come
// from the status and who has it; nothing here decides what may be done (allowed_actions does, on the request).

import { useEffect, useMemo } from "react";

import type { CalendarDate, RxRequestBrief } from "@/api/types";
import { useRxList, useRxQueue, useToday } from "@/data";
import { PICKUP_HOURS, taipeiDate, taipeiInstant } from "@/lib/format";
import { PHARMACY_STAGES, type PharmacyStage } from "@/shells/PharmacyShell";

export type BoardRow = RxRequestBrief;

export function stageOf(r: Pick<RxRequestBrief, "status" | "kind" | "assigned_to" | "updated_at">, today: CalendarDate): PharmacyStage | null {
  switch (r.status) {
    case "submitted":
      return r.kind === "refill" ? "check" : null;
    case "approved":
    case "partially_approved":
      return "check";
    case "at_pharmacy":
      // A renewal arrives from the physician without an accept step: it is new until a pharmacist has it.
      return r.assigned_to?.role === "pharmacist" ? "prepare" : "check";
    case "ready":
      return "ready";
    case "returned":
      return "returned";
    case "dispensed":
      return taipeiDate(r.updated_at) === today ? "done" : null;
    default:
      return null;
  }
}

export type PickupState = "past" | "today" | "tomorrow" | "later" | "unknown";
export function pickupState(r: BoardRow, now: Date, today: CalendarDate): PickupState {
  const w = r.pickup_window;
  if (!w) return "unknown";
  if (new Date(taipeiInstant(w.date, PICKUP_HOURS[w.slot][1])) < now) return "past";
  if (w.date <= today) return "today";
  const days = Math.round((Date.parse(w.date) - Date.parse(today)) / 86_400_000);
  return days === 1 ? "tomorrow" : "later";
}
const SLOT = { morning: 0, afternoon: 1, evening: 2 } as const;
/** Sorts by pick-up window; requests without one come after those with one. */
export function pickupKey(r: BoardRow): string {
  return r.pickup_window ? `${r.pickup_window.date}${SLOT[r.pickup_window.slot]}` : "9999";
}
const RANK = { urgent: 0, soon: 1, routine: 2 } as const;
export function byWork(a: BoardRow, b: BoardRow): number {
  return RANK[a.priority] - RANK[b.priority] || pickupKey(a).localeCompare(pickupKey(b)) || (a.submitted_at ?? "").localeCompare(b.submitted_at ?? "");
}

/** Pages are 30 rows; a pharmacy that has more open than this sees a note instead of a silent cut. */
const MAX_PAGES = 6;

export function useBoard() {
  const today = useToday();
  const open = useRxQueue("pharmacy");
  const done = useRxQueue("done");
  const returned = useRxList({ status: "returned" });

  const openPages = open.data?.pages.length ?? 0;
  useEffect(() => {
    if (open.hasNextPage && !open.isFetchingNextPage && openPages < MAX_PAGES) void open.fetchNextPage();
  }, [open, openPages]);
  const donePages = done.data?.pages.length ?? 0;
  const lastDone = done.items.at(-1);
  useEffect(() => {
    // Newest first: go on while the last row is still from today.
    if (done.hasNextPage && !done.isFetchingNextPage && donePages < MAX_PAGES && lastDone && taipeiDate(lastDone.updated_at) === today) void done.fetchNextPage();
  }, [done, donePages, lastDone, today]);

  const rows = useMemo(() => {
    const byId = new Map<string, BoardRow>();
    for (const r of [...done.items, ...returned.items, ...open.items]) byId.set(r.id, r);
    const by = Object.fromEntries(PHARMACY_STAGES.map((s) => [s, [] as BoardRow[]])) as Record<PharmacyStage, BoardRow[]>;
    for (const r of byId.values()) {
      const s = stageOf(r, today);
      if (s) by[s].push(r);
    }
    for (const s of PHARMACY_STAGES) by[s].sort(s === "done" ? (a, b) => b.updated_at.localeCompare(a.updated_at) : byWork);
    return by;
  }, [open.items, done.items, returned.items, today]);

  const ready = open.data !== undefined && done.data !== undefined;
  const counts = ready ? (Object.fromEntries(PHARMACY_STAGES.map((s) => [s, rows[s].length])) as Record<PharmacyStage, number>) : undefined;
  return {
    rows,
    counts,
    today,
    ready,
    error: (open.isError && !open.data) || (done.isError && !done.data) ? (open.error ?? done.error) : null,
    partial: Boolean(open.hasNextPage) && openPages >= MAX_PAGES,
    refetch: () => {
      void open.refetch();
      void done.refetch();
      void returned.refetch();
    },
    updatedAt: open.dataUpdatedAt,
  };
}
