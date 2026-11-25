// The strip on the public pages is a working calculator over one made-up prescription, so it needs no account and no
// server. It follows backend/src/refill.rs and backend/src/rx/medications.rs (same order of checks, same last day);
// tests/public-refill.test.ts holds the numbers against data/seed/refill_rules.csv and the persona file.

import type { CalendarDate } from "@/api/types";
import { addDays, daysBetween } from "@/lib/format";
import type { RefillStripData } from "@/ui";

export interface DemoRules {
  /** A later fill opens this many days before the supply runs out. */
  earlyWindowDays: number;
  maxFills: number;
  /** The app says "soon" when the window opens within this many days. */
  soonDays: number;
}
export const DEMO_RULES: DemoRules = { earlyWindowDays: 10, maxFills: 3, soonDays: 7 };

/** Lin's losartan, data/seed/demo/personas.json: 84 days in fills of 28, written and first filled 22 days ago. */
export const DEMO_RX = { issuedDaysAgo: 22, totalDays: 84, daysPerFill: 28 } as const;

export type DemoState = "too_early" | "open" | "gap" | "finished" | "expired";

export interface DemoView {
  strip: RefillStripData;
  state: DemoState;
  canFill: boolean;
  nextFill: number | null;
  /** First day the next fill can be collected. */
  opensOn: CalendarDate | null;
  /** Days without medicine on the chosen day. */
  gapDays: number;
  validUntil: CalendarDate;
}

export interface DemoRxInput {
  issuedOn: CalendarDate;
  totalDays: number;
  daysPerFill: number;
  /** Dates of the fills, oldest first. */
  fills: CalendarDate[];
  pharmacy: string;
}

/** What the prescription looks like on a given day. Fills after that day have not happened yet. */
export function viewOn(rx: DemoRxInput, day: CalendarDate, rules: DemoRules = DEMO_RULES): DemoView {
  const fills = rx.fills.filter((d) => d <= day);
  const allowed = Math.min(rules.maxFills, Math.ceil(rx.totalDays / rx.daysPerFill));
  const validUntil = addDays(rx.issuedOn, rx.totalDays - 1);
  const last = fills.at(-1);
  const covered = Math.min(rx.daysPerFill, Math.max(0, rx.totalDays - (fills.length - 1) * rx.daysPerFill));
  const supplyEnd = last ? addDays(last, covered) : rx.issuedOn;
  const opensOn = addDays(supplyEnd, -rules.earlyWindowDays);

  let state: DemoState;
  if (fills.length >= allowed) state = "finished";
  else if (day > validUntil) state = "expired";
  else if (day < opensOn) state = "too_early";
  else state = day > supplyEnd ? "gap" : "open";

  const closed = state === "finished" || state === "expired";
  const window = closed ? null : { from: opensOn < rx.issuedOn ? rx.issuedOn : opensOn, to: validUntil };
  const stripState: RefillStripData["state"] = closed
    ? (state as "finished" | "expired")
    : state === "gap"
      ? "late"
      : state === "open"
        ? "window_open"
        : daysBetween(day, opensOn) <= rules.soonDays
          ? "window_soon"
          : "on_hand";

  return {
    strip: {
      issued_on: rx.issuedOn,
      valid_until: validUntil,
      days_per_fill: rx.daysPerFill,
      fills_allowed: allowed,
      fills: fills.map((d, i) => ({ n: i + 1, filled_on: d, pharmacy_name: rx.pharmacy })),
      supply_ends_on: supplyEnd,
      next_window: window,
      state: stripState,
    },
    state,
    canFill: state === "open" || state === "gap",
    nextFill: closed ? null : fills.length + 1,
    opensOn: closed ? null : opensOn,
    gapDays: state === "gap" ? daysBetween(supplyEnd, day) : 0,
    validUntil,
  };
}

/** The fills after collecting on `day`; a fill planned for a later day is dropped. */
export function fillOn(rx: DemoRxInput, day: CalendarDate, rules: DemoRules = DEMO_RULES): CalendarDate[] {
  const past = rx.fills.filter((d) => d <= day);
  return viewOn(rx, day, rules).canFill ? [...past, day] : past;
}

/** First and last day the strip draws, so a slider laid over it lines up with the day line. */
export function axisOf(strip: RefillStripData): { start: CalendarDate; end: CalendarDate } {
  let to = strip.issued_on;
  for (let n = 1; n <= strip.fills_allowed; n++) {
    const fill = strip.fills.find((f) => f.n === n);
    const from = fill && (n === 1 || fill.filled_on > to) ? fill.filled_on : to;
    to = addDays(from, strip.days_per_fill);
  }
  return { start: strip.issued_on, end: to > strip.valid_until ? to : strip.valid_until };
}
