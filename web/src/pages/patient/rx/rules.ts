// How the wizard splits the server's questions into screens, and what it can offer to fill in from the health record.
// Pure. Which answers matter is decided by the protocol engine on the server, never here.

import type { Measurement, MonitoringValue, ProtocolQuestion, RxRequest } from "@/api/types";
import { addDays, daysBetween, taipeiDate } from "@/lib/format";
import { askedQuestions, isAnswered, isOpenRx, monitoringQuestions, stepsFor, type RxStep } from "@/lib/rx";

export interface Part {
  /** Position in the safety step, for the address (?part=2). */
  index: number;
  scope: "general" | "class";
  classId: string | null;
  questions: ProtocolQuestion[];
}

const PER_SCREEN = 4;

/** Emergency questions first and alone on their screen: nobody should scroll past them. */
export function safetyParts(rx: Pick<RxRequest, "questions">): Part[] {
  const all = askedQuestions(rx);
  const isUrgent = (q: ProtocolQuestion) => q.scope === "general" && q.id.startsWith("urgent");
  const groups: Omit<Part, "index">[] = [];
  const push = (scope: Part["scope"], classId: string | null, list: ProtocolQuestion[]) => {
    for (let i = 0; i < list.length; i += PER_SCREEN) groups.push({ scope, classId, questions: list.slice(i, i + PER_SCREEN) });
  };
  push("general", null, all.filter(isUrgent));
  push("general", null, all.filter((q) => q.scope === "general" && !isUrgent(q)));
  const classes = [...new Set(all.filter((q) => q.scope === "class").map((q) => q.class_id))];
  for (const id of classes) push("class", id, all.filter((q) => q.scope === "class" && q.class_id === id));
  return groups.map((g, index) => ({ ...g, index }));
}

/** Steps this request needs; a step without questions is left out. */
export function activeSteps(rx: Pick<RxRequest, "kind" | "questions">): RxStep[] {
  return stepsFor(rx.kind).filter((s) => (s === "safety" ? askedQuestions(rx).length > 0 : s === "monitoring" ? monitoringQuestions(rx).length > 0 : true));
}

export function inRange(q: ProtocolQuestion, n: number): boolean {
  return (q.min === null || n >= q.min) && (q.max === null || n <= q.max);
}
/** Why a question cannot be left as it is. */
export function questionProblem(q: ProtocolQuestion, answer: unknown): "required" | "range" | null {
  if (!isAnswered(q, answer)) return q.required ? "required" : null;
  if (typeof answer === "number" && !inRange(q, answer)) return "range";
  return null;
}

/** An answer points to an emergency: the engine says so, or free text matched a red-flag rule. */
export function isUrgentRx(rx: Pick<RxRequest, "engine" | "items" | "priority" | "status" | "timeline">): boolean {
  if (!isOpenRx(rx.status)) return false;
  return rx.engine?.disposition === "urgent" || rx.priority === "urgent" || rx.items.some((i) => i.engine?.disposition === "urgent") || rx.timeline.some((e) => e.type === "urgent");
}
export function urgentLabels(rx: Pick<RxRequest, "items">): string[] {
  return [...new Set(rx.items.flatMap((i) => i.engine?.fired.filter((f) => f.disposition === "urgent").map((f) => f.label) ?? []))];
}

// ---------------------------------------------------------------------------------------------- prefill

export interface Suggestion {
  value?: number;
  date?: string;
  /** How many readings an average covers; 1 = a single reading. */
  count: number;
  from: string;
  to: string;
  source: "patient" | "clinic" | "mixed";
}

const WINDOW_DAYS = 7;
const round1 = (n: number) => Math.round(n * 10) / 10;

function fromReadings(list: { at: string; value: number; source: "patient" | "clinic" }[], today: string, whole: boolean): Suggestion | null {
  const sorted = [...list].sort((a, b) => b.at.localeCompare(a.at));
  if (sorted.length === 0) return null;
  const recent = sorted.filter((r) => r.at > addDays(today, -WINDOW_DAYS));
  const use = recent.length > 0 ? recent : sorted.slice(0, 1);
  const avg = use.reduce((n, r) => n + r.value, 0) / use.length;
  const sources = new Set(use.map((r) => r.source));
  return { value: whole ? Math.round(avg) : round1(avg), date: use[0].at, count: use.length, from: use.at(-1)!.at, to: use[0].at, source: sources.size > 1 ? "mixed" : use[0].source };
}

const norm = (s: string) => s.toLowerCase().replace(/[\s（）()_-]/g, "");

/** The health record's value for a question, if there clearly is one. Offered with a button, never filled in silently. */
export function suggestion(q: ProtocolQuestion, items: readonly Measurement[], today: string): Suggestion | null {
  const of = (kind: Measurement["kind"], pick: (m: Measurement) => number | undefined) =>
    items.flatMap((m) => {
      const value = m.kind === kind ? pick(m) : undefined;
      return value === undefined ? [] : [{ at: taipeiDate(m.taken_at), value, source: m.source }];
    });
  if (q.unit === "mmHg" && /sbp|systolic/.test(q.id)) return fromReadings(of("bp", (m) => m.values.systolic), today, true);
  if (q.unit === "mmHg" && /dbp|diastolic/.test(q.id)) return fromReadings(of("bp", (m) => m.values.diastolic), today, true);
  if (q.unit === "mg/dL" && /glucose|sugar|fpg|smbg/.test(q.id)) return fromReadings(of("glucose", (m) => m.values.value), today, true);
  if (/^weight/.test(q.id)) return fromReadings(of("weight", (m) => m.values.value), today, false);
  if (/pulse|heart_rate/.test(q.id)) return fromReadings(of("pulse", (m) => m.values.value), today, true);
  if (q.kind === "date" && q.id === "bp_check") {
    const last = of("bp", (m) => m.values.systolic).sort((a, b) => b.at.localeCompare(a.at))[0];
    return last ? { date: last.at, count: 1, from: last.at, to: last.at, source: last.source } : null;
  }
  // A lab result whose name appears in the question: "HbA1c" in 「糖化血色素 HbA1c（最近一次數值）」.
  const label = norm(q.label);
  const lab = items
    .filter((m) => m.kind === "lab" && m.values.name && norm(m.values.name).length >= 3 && label.includes(norm(m.values.name)))
    .sort((a, b) => b.taken_at.localeCompare(a.taken_at))[0];
  if (!lab) return null;
  const at = taipeiDate(lab.taken_at);
  return { ...(q.kind === "number" && lab.values.value !== undefined ? { value: lab.values.value } : {}), date: at, count: 1, from: at, to: at, source: lab.source };
}

export function sameAs(s: Suggestion, v: MonitoringValue | undefined): boolean {
  return Boolean(v) && v!.value === s.value && v!.date === s.date;
}

export function ageDays(date: string, today: string): number {
  return Math.max(0, daysBetween(date, today));
}

/** Last group of RX-20261125-0001: what people read out at the counter. */
export function shortNo(no: string): string {
  const parts = no.split("-");
  return parts.length >= 3 ? `${parts[1].slice(4)}-${parts[2]}` : no;
}
