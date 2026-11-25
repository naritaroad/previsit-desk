// The tool trace: grouping rows by run and one-line briefs (v1 contract §7.5). Brief texts are rx:trace.*; unknown
// tools return null and the panel shows the raw JSON.

import type { GuardKind, Message, Run, RunStatus, Ticket, TicketReason, TokenUsage, ToolCall, ToolName, ToolStatus } from "../api/types.ts";
import { safeExternalUrl } from "./links.ts";

export type TraceStatus = ToolStatus | "running";
/** One row of the tool trace. `duration_ms` is null while the call runs or when no separate time exists. */
export interface TraceRow extends Omit<ToolCall, "status" | "duration_ms"> {
  status: TraceStatus;
  duration_ms: number | null;
}
export interface RunView {
  id: string;
  model: string;
  fallback_used: boolean;
  status: RunStatus;
  steps: number;
  usage: TokenUsage;
  error_code: string | null;
  duration_ms: number | null;
  created_at: string;
}
export interface GuardNote {
  run_id: string | null;
  kind: GuardKind;
  action: "rewritten" | "replaced";
}
export const toTraceRow = (c: ToolCall): TraceRow => ({ ...c });
export const toRunView = (r: Run): RunView => ({ ...r });

export interface TraceGroup {
  key: string;
  run: RunView | null;
  rows: TraceRow[];
}

/** Code checks that run before a run exists: the server stores them with run_id null. */
const PRECHECK_NAMES: ReadonlySet<string> = new Set(["red_flag_precheck", "scope_precheck", "pii_filter"]);

/**
 * The run a stored row belongs to. Prechecks come without a run id, so they join the first run created after
 * them (the run row is written a few milliseconds later). Other rows without a run stay in the form group.
 */
function runIdOf(row: TraceRow, runs: readonly RunView[]): string | null {
  if (row.run_id !== null) return row.run_id;
  if (!PRECHECK_NAMES.has(row.name)) return null;
  const at = Date.parse(row.created_at);
  if (Number.isNaN(at)) return null;
  let best: RunView | null = null;
  for (const r of runs) {
    const t = Date.parse(r.created_at);
    if (!Number.isNaN(t) && t >= at - 1 && (best === null || t < Date.parse(best.created_at))) best = r;
  }
  return best?.id ?? null;
}

/** Rows grouped by run in order of first appearance; a run without rows still shows its model and usage. */
export function groupTrace(trace: readonly TraceRow[], runs: readonly RunView[]): TraceGroup[] {
  const groups: TraceGroup[] = [];
  const byKey = new Map<string, TraceGroup>();
  for (const row of trace) {
    const runId = runIdOf(row, runs);
    const key = runId ?? "form";
    let g = byKey.get(key);
    if (!g) {
      g = { key, run: runs.find((r) => r.id === runId) ?? null, rows: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.rows.push(row);
  }
  for (const run of runs) if (!byKey.has(run.id)) groups.push({ key: run.id, run, rows: [] });
  return groups;
}

// ------------------------------------------------------------------------------------------- briefs

export interface TraceBrief {
  /** Full i18next key. */
  key: string;
  params?: Record<string, string | number>;
}
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join("、") : "");
const K = (name: string) => `rx:trace.${name}`;

const SCOPE_KEYS: Readonly<Record<string, string>> = {
  ok: K("scopeOk"),
  prescription_request: K("scopePrescription"),
  controlled_drug: K("scopeControlled"),
  injection: K("scopeInjection"),
};
const REFILL_KEYS: Readonly<Record<string, string>> = {
  eligible: K("refillEligible"),
  too_early: K("refillTooEarly"),
  revisit: K("refillRevisit"),
  consult: K("refillConsult"),
};

export function traceBrief(name: ToolName | (string & {}), result: unknown): TraceBrief | null {
  if (!isObj(result)) return null;
  switch (name) {
    case "red_flag_precheck":
      return result.hit === true ? { key: K("redFlagHit"), params: { label: str(result.label) } } : { key: K("redFlagNone") };
    case "scope_precheck": {
      const key = SCOPE_KEYS[str(result.verdict)];
      return key ? { key } : null;
    }
    case "pii_filter":
      return { key: K("pii"), params: { count: Number(result.masked) || 0, kinds: list(result.kinds) } };
    case "record_intake":
      return { key: K("intake"), params: { applied: len(result.applied), rejected: len(result.rejected) } };
    case "search_health_education":
      return len(result.hits) ? { key: K("searchHits"), params: { count: len(result.hits) } } : { key: K("searchNone") };
    case "check_chronic_refill": {
      const key = REFILL_KEYS[str(result.outcome)];
      return key ? { key } : null;
    }
    case "transfer_to_clinician":
      return { key: K(result.deduped === true ? "transferDeduped" : "transfer"), params: { ticket: str(result.ticket_no) } };
    case "save_previsit_summary":
      return result.saved === true ? { key: K("saved"), params: { count: len(result.not_collected) } } : null;
    case "output_guard":
      if (result.passed === true) return { key: K("guardPass") };
      return { key: K(result.action === "replaced" ? "guardReplaced" : "guardRewritten"), params: { violations: list(result.violations) } };
    default:
      return null;
  }
}

/** True when the red-flag precheck row is a hit. */
export function isRedFlagHitResult(result: unknown): boolean {
  return isObj(result) && result.hit === true;
}
/** How many values pii_filter masked. */
export function piiMasked(result: unknown): number {
  return isObj(result) ? Number(result.masked) || 0 : 0;
}

export interface HandbookHitLine {
  title: string;
  section: string;
  sourceName: string;
  /** http(s) only; anything else is dropped. */
  url: string | null;
}
export function handbookHits(result: unknown): HandbookHitLine[] {
  if (!isObj(result) || !Array.isArray(result.hits)) return [];
  return result.hits.filter(isObj).map((h) => ({
    title: str(h.title),
    section: str(h.section),
    sourceName: str(h.source_name),
    url: safeExternalUrl(str(h.source_url)),
  }));
}

// ------------------------------------------------------------------------------------------ tickets

const REFUSAL_REASONS: readonly TicketReason[] = ["prescription_request", "controlled_drug"];

/**
 * The handoff ticket a fixed reply caused, so the chat can say so under it. Tickets carry no message id; the
 * match is by reason and time (raised while that reply was being written).
 */
export function ticketForMessage(m: Pick<Message, "role" | "kind" | "created_at">, tickets: readonly Ticket[]): Ticket | null {
  if (m.role !== "assistant" || (m.kind !== "refusal" && m.kind !== "red_flag")) return null;
  const at = Date.parse(m.created_at);
  if (Number.isNaN(at)) return null;
  const reasons: readonly TicketReason[] = m.kind === "refusal" ? REFUSAL_REASONS : ["red_flag"];
  let best: Ticket | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const tk of tickets) {
    if (!reasons.includes(tk.reason)) continue;
    const gap = Date.parse(tk.created_at) - at; // negative: the ticket came first
    if (Number.isNaN(gap) || gap < -15_000 || gap > 5_000) continue;
    if (Math.abs(gap) < bestGap) {
      best = tk;
      bestGap = Math.abs(gap);
    }
  }
  return best;
}
