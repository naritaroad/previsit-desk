// State of one patient visit and the reducer that folds server data and SSE events into it.
// Pure (no React, no DOM) so `npm test` can replay a recorded stream and check the result.

import { charCount } from "../lib/composer.ts";
import { piiMasked } from "../lib/trace.ts";
import type {
  IntakeView,
  Message,
  PrevisitSummary,
  RedFlagHit,
  RefillCheckRecord,
  Run,
  RunFailureCode,
  RunStatus,
  StreamEnvelope,
  StreamEvent,
  Ticket,
  ToolCall,
  ToolName,
  ToolSource,
  ToolStatus,
  Visit,
  VisitDetail,
  GuardKind,
  PrecheckScope,
} from "../api/types.ts";

export type TraceStatus = ToolStatus | "running";

/** One row of the tool trace. `duration_ms` is null while the call runs or when no separate time exists. */
export interface TraceRow {
  id: string;
  run_id: string | null;
  step: number;
  name: ToolName;
  source: ToolSource;
  status: TraceStatus;
  arguments: unknown;
  result: unknown;
  duration_ms: number | null;
  created_at: string;
}

export interface RunView {
  id: string;
  model: string;
  fallback_used: boolean;
  status: RunStatus;
  steps: number;
  usage: { input_tokens: number; output_tokens: number };
  error_code: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface ChatMessage extends Message {
  /** Patient message shown before the server confirmed it (message.accepted). */
  pending?: boolean;
  /** The request failed before the server accepted the message. */
  failed?: boolean;
}

export interface GuardNote {
  run_id: string | null;
  kind: GuardKind;
  action: "rewritten" | "replaced";
}

export interface Failure {
  code: RunFailureCode | "network" | "visit_closed" | "rate_limited" | "conflict" | "unknown";
  message: string;
  retryAfter?: number | null;
}

export interface VisitState {
  visit: Visit | null;
  messages: ChatMessage[];
  /** Assistant text arriving through message.delta, before message.completed. */
  streaming: { text: string } | null;
  intake: IntakeView | null;
  summary: PrevisitSummary | null;
  redFlag: RedFlagHit | null;
  tickets: Ticket[];
  trace: TraceRow[];
  runs: RunView[];
  refillChecks: RefillCheckRecord[];
  guards: GuardNote[];
  scope: PrecheckScope | null;
  /** The server masked personal data in the last message (pii_filter ran). */
  piiMasked: number;
  /** A message is in flight (from send until run.completed/run.failed or an error). */
  busy: boolean;
  failure: Failure | null;
  /** Counter for placeholder run ids of the current turn (before run.started names the real one). */
  turn: number;
  currentRunId: string | null;
}

export const initialVisitState: VisitState = {
  visit: null,
  messages: [],
  streaming: null,
  intake: null,
  summary: null,
  redFlag: null,
  tickets: [],
  trace: [],
  runs: [],
  refillChecks: [],
  guards: [],
  scope: null,
  piiMasked: 0,
  busy: false,
  failure: null,
  turn: 0,
  currentRunId: null,
};

export type VisitAction =
  | { type: "reset" }
  | { type: "loaded"; detail: VisitDetail }
  | { type: "created"; visit: Visit; messages: Message[] }
  | { type: "patient_sent"; localId: string; content: string; at: string }
  | { type: "stream"; envelope: StreamEnvelope; at?: string }
  | { type: "send_failed"; failure: Failure }
  | { type: "refill_done"; record: RefillCheckRecord }
  | { type: "ticket_added"; ticket: Ticket }
  | { type: "submitted"; visit: Visit; summary: PrevisitSummary }
  | { type: "dismiss_failure" };

const turnRunId = (turn: number) => `turn:${turn}`;

const toTraceRow = (c: ToolCall): TraceRow => ({ ...c });
const toRunView = (r: Run): RunView => ({ ...r });

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function upsertRun(runs: RunView[], patch: Partial<RunView> & { id: string }, at: string): RunView[] {
  const i = runs.findIndex((r) => r.id === patch.id);
  if (i === -1) {
    return [
      ...runs,
      {
        model: "",
        fallback_used: false,
        status: "running",
        steps: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        error_code: null,
        duration_ms: null,
        created_at: at,
        ...patch,
      },
    ];
  }
  const next = runs.slice();
  next[i] = { ...next[i], ...patch };
  return next;
}

function remapTurnRows(trace: TraceRow[], turn: number, runId: string): TraceRow[] {
  const placeholder = turnRunId(turn);
  return trace.map((r) => (r.run_id === placeholder ? { ...r, run_id: runId } : r));
}

/** Events carry unknown data from the network; the reducer trusts the contract but guards against nulls. */
export function applyStreamEvent(state: VisitState, envelope: StreamEnvelope, at: string): VisitState {
  const e = envelope as unknown as StreamEvent;
  const turn = state.turn;
  switch (e.type) {
    case "message.accepted": {
      const messages = state.messages.map((m) => (m.pending ? { ...m, id: e.data.message_id, pending: false } : m));
      return { ...state, messages };
    }
    case "precheck.completed": {
      const rf = e.data.red_flag;
      const lastPatient = [...state.messages].reverse().find((m) => m.role === "patient");
      const chars = lastPatient ? charCount(lastPatient.content) : 0;
      const base = { run_id: turnRunId(turn), step: 0, source: "code" as const, created_at: at };
      const rows: TraceRow[] = [
        {
          ...base,
          id: `${turnRunId(turn)}:red_flag_precheck`,
          name: "red_flag_precheck",
          status: "ok",
          arguments: { chars },
          result: rf ? { hit: true, category: rf.category, label: rf.label } : { hit: false },
          duration_ms: e.data.duration_ms,
        },
        {
          ...base,
          id: `${turnRunId(turn)}:scope_precheck`,
          name: "scope_precheck",
          status: "ok",
          arguments: { chars },
          result: { verdict: e.data.scope },
          duration_ms: null,
        },
      ];
      let trace = state.trace;
      for (const row of rows) trace = upsertById(trace, row);
      return { ...state, trace, scope: e.data.scope, redFlag: rf ?? state.redFlag };
    }
    case "redflag.triggered": {
      const hit: RedFlagHit = {
        category: e.data.category,
        label: e.data.label,
        matched_at: at,
        message_id: e.data.message_id,
      };
      // Any status moves to red_flag (contract 7.1); visit.updated follows with the authoritative row.
      const visit = state.visit ? { ...state.visit, status: "red_flag" as const } : state.visit;
      return { ...state, redFlag: hit, visit };
    }
    case "run.started": {
      const trace = remapTurnRows(state.trace, turn, e.data.run_id);
      const runs = upsertRun(state.runs, { id: e.data.run_id, model: e.data.model, status: "running" }, at);
      return { ...state, trace, runs, currentRunId: e.data.run_id };
    }
    case "tool.started": {
      const row: TraceRow = {
        id: e.data.call_id,
        run_id: state.currentRunId ?? turnRunId(turn),
        step: e.data.step,
        name: e.data.name,
        source: e.data.source,
        status: "running",
        arguments: e.data.arguments,
        result: undefined,
        duration_ms: null,
        created_at: at,
      };
      return { ...state, trace: upsertById(state.trace, row) };
    }
    case "tool.completed": {
      const existing = state.trace.find((r) => r.id === e.data.call_id);
      const row: TraceRow = {
        id: e.data.call_id,
        run_id: existing?.run_id ?? state.currentRunId ?? turnRunId(turn),
        step: e.data.step,
        name: e.data.name,
        source: existing?.source ?? "model",
        status: e.data.status,
        arguments: existing?.arguments,
        result: e.data.result,
        duration_ms: e.data.duration_ms,
        created_at: existing?.created_at ?? at,
      };
      const masked = e.data.name === "pii_filter" ? piiMasked(e.data.result) : 0;
      return { ...state, trace: upsertById(state.trace, row), piiMasked: masked > 0 ? masked : state.piiMasked };
    }
    case "intake.updated": {
      const visit = state.visit ? { ...state.visit, stage: e.data.stage } : state.visit;
      return { ...state, intake: e.data, visit };
    }
    case "ticket.created":
      return { ...state, tickets: upsertById(state.tickets, e.data) };
    case "summary.updated":
      return { ...state, summary: e.data };
    case "guard.rewrote":
      return { ...state, guards: [...state.guards, { run_id: state.currentRunId, kind: e.data.kind, action: e.data.action }] };
    case "message.delta":
      return { ...state, streaming: { text: (state.streaming?.text ?? "") + e.data.text } };
    case "message.completed": {
      const message: ChatMessage = {
        id: e.data.message_id,
        role: "assistant",
        kind: e.data.kind,
        content: e.data.content,
        created_at: at,
        run_id: e.data.run_id,
      };
      return { ...state, streaming: null, messages: upsertById(state.messages, message) };
    }
    case "visit.updated":
      return { ...state, visit: e.data };
    case "run.completed": {
      const trace = state.currentRunId ? state.trace : remapTurnRows(state.trace, turn, e.data.run_id);
      const runs = upsertRun(
        state.runs,
        { id: e.data.run_id, model: e.data.model, status: e.data.status, steps: e.data.steps, usage: e.data.usage },
        at,
      );
      return { ...state, trace, runs, busy: false, streaming: null };
    }
    case "run.failed": {
      const trace = state.currentRunId ? state.trace : remapTurnRows(state.trace, turn, e.data.run_id);
      const runs = upsertRun(state.runs, { id: e.data.run_id, status: "failed", error_code: e.data.code }, at);
      return {
        ...state,
        trace,
        runs,
        busy: false,
        streaming: null,
        failure: { code: e.data.code, message: e.data.message },
      };
    }
    default:
      return state; // unknown event types are ignored so that the server can add new ones
  }
}

export function visitReducer(state: VisitState, action: VisitAction): VisitState {
  switch (action.type) {
    case "reset":
      return initialVisitState;
    case "loaded": {
      const d = action.detail;
      return {
        ...state,
        visit: d.visit,
        messages: d.messages,
        streaming: null,
        intake: d.intake,
        summary: d.summary,
        redFlag: d.red_flag,
        tickets: d.tickets,
        trace: d.tool_calls.map(toTraceRow),
        runs: d.runs.map(toRunView),
        refillChecks: d.refill_checks,
        busy: false,
        currentRunId: null,
      };
    }
    case "created":
      return {
        ...initialVisitState,
        visit: action.visit,
        messages: action.messages,
      };
    case "patient_sent": {
      const message: ChatMessage = {
        id: action.localId,
        role: "patient",
        kind: "chat",
        content: action.content,
        created_at: action.at,
        run_id: null,
        pending: true,
      };
      return {
        ...state,
        messages: [...state.messages.filter((m) => !m.failed), message],
        busy: true,
        failure: null,
        streaming: null,
        scope: null,
        piiMasked: 0,
        currentRunId: null,
        turn: state.turn + 1,
      };
    }
    case "stream":
      return applyStreamEvent(state, action.envelope, action.at ?? new Date().toISOString());
    case "send_failed": {
      // Keep the patient's text visible but flag it, so they can see it was not delivered.
      const messages = state.messages.map((m) => (m.pending ? { ...m, pending: false, failed: true } : m));
      return { ...state, messages, busy: false, streaming: null, failure: action.failure };
    }
    case "refill_done":
      return { ...state, refillChecks: upsertById(state.refillChecks, action.record) };
    case "ticket_added":
      return { ...state, tickets: upsertById(state.tickets, action.ticket) };
    case "submitted":
      return { ...state, visit: action.visit, summary: action.summary, busy: false };
    case "dismiss_failure":
      return { ...state, failure: null };
  }
}

/** Latest refill result of the visit, if any. */
export function latestRefill(state: VisitState): RefillCheckRecord | null {
  return state.refillChecks.length ? state.refillChecks[state.refillChecks.length - 1] : null;
}

/** Whether the visit still accepts patient messages (contract: submitted/reviewed answer 409 visit_closed). */
export function isClosed(visit: Visit | null): boolean {
  return visit?.status === "submitted" || visit?.status === "reviewed";
}

/** Group trace rows by run, in order of first appearance; rows without a run (form checks) share one group. */
export interface TraceGroup {
  key: string;
  run: RunView | null;
  rows: TraceRow[];
}

/** Code checks that run before a run exists: the server stores them with run_id null (found against the real backend). */
const PRECHECK_NAMES = new Set<string>(["red_flag_precheck", "scope_precheck", "pii_filter"]);

/**
 * The run a stored row belongs to. Prechecks come without a run id, so they join the first run that
 * was created after them (the run row is written a few milliseconds later, also when it is skipped).
 * Every other row without a run (refill checks and handoffs from forms) stays in the form group.
 */
function runIdOf(row: TraceRow, runs: RunView[]): string | null {
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

export function groupTrace(trace: TraceRow[], runs: RunView[]): TraceGroup[] {
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
  // A run that produced no rows (e.g. failed before any call) still shows its model and usage.
  for (const run of runs) {
    if (!byKey.has(run.id)) {
      const g: TraceGroup = { key: run.id, run, rows: [] };
      byKey.set(run.id, g);
      groups.push(g);
    }
  }
  return groups;
}

/**
 * The emergency card shows whenever the server reports a red-flag hit (the latest one), never by
 * inferring from status, and it stays on closed (submitted / reviewed) visits too (contract 7.1).
 */
export function showEmergency(state: VisitState): boolean {
  return state.redFlag !== null;
}

/** The visit has been sent to the doctor (a red_flag visit stays red_flag after submit, so check submitted_at). */
export function isSent(visit: Visit | null): boolean {
  return !!visit && (visit.submitted_at !== null || isClosed(visit));
}

/** Composer mode: red_flag pauses the visit; submitted / reviewed are closed; otherwise open. */
export function composerMode(visit: Visit | null): "open" | "paused" | "closed" {
  if (visit?.status === "red_flag") return "paused";
  return isClosed(visit) ? "closed" : "open";
}

/**
 * Whether to show the failure banner. A failed run also leaves a fixed `notice` message in the chat
 * (stored and streamed before run.failed), and that bubble already says it, so the banner stays away.
 */
export function failureBannerVisible(state: Pick<VisitState, "failure" | "messages">): boolean {
  if (!state.failure) return false;
  const last = state.messages[state.messages.length - 1];
  return !(last && last.role === "assistant" && last.kind === "notice");
}

/** Fixed text of the latest red_flag message, used by the emergency card. */
export function redFlagText(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.kind === "red_flag") return m.content;
  }
  return null;
}
