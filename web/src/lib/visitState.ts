// State of one visit and the reducer that folds GET /visits/{id} and stream events into it. Pure, so tests can
// replay a recorded stream. Events are deduplicated by `seq`; message.delta has none and is never stored.

import type {
  ClinicalNote,
  IntakeView,
  Message,
  PrecheckScope,
  PrevisitSummary,
  RedFlagHit,
  RefillCheckRecord,
  RunFailureCode,
  StreamEnvelope,
  Ticket,
  Visit,
  VisitDetail,
  VisitEvent,
} from "../api/types.ts";
import { charCount } from "./composer.ts";
import { type GuardNote, piiMasked, type RunView, toRunView, toTraceRow, type TraceRow } from "./trace.ts";

export type RunPhase = "idle" | "running" | "failed" | "interrupted";
export interface RunState {
  phase: RunPhase;
  runId: string | null;
  /** Set when phase is failed (run.failed code) or interrupted. */
  code: RunFailureCode | "interrupted" | (string & {}) | null;
}

export interface VisitState {
  loaded: boolean;
  visit: Visit | null;
  messages: Message[];
  /** Assistant text arriving through message.delta, before message.completed replaces it. */
  live: { runId: string | null; text: string } | null;
  run: RunState;
  intake: IntakeView | null;
  summary: PrevisitSummary | null;
  redFlag: RedFlagHit | null;
  tickets: Ticket[];
  trace: TraceRow[];
  runs: RunView[];
  refillChecks: RefillCheckRecord[];
  note: ClinicalNote | null;
  guards: GuardNote[];
  /** Verdict of the last scope precheck. */
  scope: PrecheckScope | null;
  /** Values masked in the last message. */
  piiMasked: number;
  /** Highest seq applied; the stream resumes after it. */
  lastSeq: number;
  /** An event said that something changed that only GET /visits/{id} carries (note.signed without a note). */
  stale: boolean;
}

export const initialVisitState: VisitState = {
  loaded: false,
  visit: null,
  messages: [],
  live: null,
  run: { phase: "idle", runId: null, code: null },
  intake: null,
  summary: null,
  redFlag: null,
  tickets: [],
  trace: [],
  runs: [],
  refillChecks: [],
  note: null,
  guards: [],
  scope: null,
  piiMasked: 0,
  lastSeq: 0,
  stale: false,
};

export type VisitAction =
  | { type: "reset" }
  | { type: "loaded"; detail: VisitDetail }
  | { type: "event"; envelope: StreamEnvelope; at: string }
  /** The stream (re)opened: deltas were not replayed, so partial text is dropped. */
  | { type: "stream_opened" }
  /** Answer of POST …/messages, which can arrive before or after message.created. */
  | { type: "message_sent"; message: Message; runId: string | null }
  | { type: "retry_started" }
  | { type: "visit_patched"; visit: Visit }
  | { type: "summary_patched"; summary: PrevisitSummary }
  | { type: "note_patched"; note: ClinicalNote }
  | { type: "ticket_added"; ticket: Ticket }
  | { type: "refill_checked"; record: RefillCheckRecord };

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const i = items.findIndex((x) => x.id === item.id);
  if (i === -1) return [...items, item];
  const next = items.slice();
  next[i] = item;
  return next;
}

/** Messages in conversation order: by seq, and by time for the ones that have none yet. */
export function sortMessages(messages: Message[]): Message[] {
  return messages
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      if (a.m.seq > 0 && b.m.seq > 0 && a.m.seq !== b.m.seq) return a.m.seq - b.m.seq;
      const t = a.m.created_at.localeCompare(b.m.created_at);
      return t !== 0 ? t : a.i - b.i;
    })
    .map((x) => x.m);
}

/** One row per message id and per client_id: an echo of our own message never shows twice. */
function upsertMessage(messages: Message[], m: Message): Message[] {
  const i = messages.findIndex((x) => x.id === m.id || (m.client_id !== null && x.client_id === m.client_id));
  if (i === -1) return sortMessages([...messages, m]);
  const next = messages.slice();
  // A stub written from message.completed has no seq or author; keep whichever is known.
  next[i] = { ...next[i], ...m, seq: m.seq || next[i].seq, client_id: m.client_id ?? next[i].client_id };
  return sortMessages(next);
}

function upsertRun(runs: RunView[], patch: Partial<RunView> & { id: string }, at: string): RunView[] {
  const i = runs.findIndex((r) => r.id === patch.id);
  if (i === -1) {
    const fresh: RunView = {
      model: "",
      fallback_used: false,
      status: "running",
      steps: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      error_code: null,
      duration_ms: null,
      created_at: at,
      ...patch,
    };
    return [...runs, fresh];
  }
  const next = runs.slice();
  next[i] = { ...next[i], ...patch };
  return next;
}

const PENDING_RUN = "pending";
const adoptPending = (trace: TraceRow[], runId: string): TraceRow[] =>
  trace.some((r) => r.run_id === PENDING_RUN) ? trace.map((r) => (r.run_id === PENDING_RUN ? { ...r, run_id: runId } : r)) : trace;

/** Where the last assistant turn stands, from stored runs. */
export function runStateFrom(runs: readonly RunView[]): RunState {
  const last = runs.length ? runs[runs.length - 1] : null;
  if (!last) return { phase: "idle", runId: null, code: null };
  if (last.status === "running") return { phase: "running", runId: last.id, code: null };
  if (last.status === "interrupted") return { phase: "interrupted", runId: last.id, code: "interrupted" };
  if (last.status === "failed") return { phase: "failed", runId: last.id, code: last.error_code };
  return { phase: "idle", runId: last.id, code: null };
}

function applyEvent(state: VisitState, envelope: StreamEnvelope, at: string): VisitState {
  const e = envelope as unknown as VisitEvent; // the network is trusted to follow the contract; unknown types fall through
  switch (e.type) {
    case "message.accepted":
      return state.run.phase === "running" ? state : { ...state, run: { phase: "running", runId: null, code: null } };
    case "message.created": {
      const m = e.data;
      return {
        ...state,
        messages: upsertMessage(state.messages, m),
        visit: state.visit ? { ...state.visit, last_activity_at: m.created_at } : state.visit,
        piiMasked: m.role === "patient" ? 0 : state.piiMasked,
      };
    }
    case "precheck.completed": {
      const lastPatient = state.messages.findLast((m) => m.role === "patient");
      const chars = lastPatient ? charCount(lastPatient.content) : 0;
      const base = { run_id: PENDING_RUN, step: 0, source: "code" as const, status: "ok" as const, created_at: at };
      const rf = e.data.red_flag;
      // Placeholder ids: the stored rows come with the next GET and replace the whole list.
      const id = `live:${envelope.seq ?? at}`;
      const rows: TraceRow[] = [
        {
          ...base,
          id: `${id}:red_flag`,
          name: "red_flag_precheck",
          arguments: { chars },
          result: rf ? { hit: true, category: rf.category, label: rf.label } : { hit: false },
          duration_ms: e.data.duration_ms,
        },
        { ...base, id: `${id}:scope`, name: "scope_precheck", arguments: { chars }, result: { verdict: e.data.scope }, duration_ms: null },
      ];
      return { ...state, trace: [...state.trace, ...rows], scope: e.data.scope, redFlag: rf ?? state.redFlag };
    }
    case "redflag.triggered":
      return {
        ...state,
        redFlag: { ...e.data, matched_at: at },
        visit: state.visit ? { ...state.visit, status: "red_flag", urgency: "urgent" } : state.visit,
      };
    case "run.started":
      return {
        ...state,
        live: null,
        trace: adoptPending(state.trace, e.data.run_id),
        runs: upsertRun(state.runs, { id: e.data.run_id, model: e.data.model, status: "running" }, at),
        run: { phase: "running", runId: e.data.run_id, code: null },
      };
    case "tool.started": {
      const row: TraceRow = {
        id: e.data.call_id,
        run_id: state.run.runId ?? PENDING_RUN,
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
        run_id: existing?.run_id ?? state.run.runId ?? PENDING_RUN,
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
    case "intake.updated":
      return { ...state, intake: e.data, visit: state.visit ? { ...state.visit, stage: e.data.stage } : state.visit };
    case "ticket.created":
      return { ...state, tickets: upsertById(state.tickets, e.data) };
    case "summary.updated":
      return { ...state, summary: e.data };
    case "guard.rewrote":
      return { ...state, guards: [...state.guards, { run_id: state.run.runId, kind: e.data.kind, action: e.data.action }] };
    case "message.delta":
      return { ...state, live: { runId: state.run.runId, text: (state.live?.text ?? "") + e.data.text } };
    case "message.completed": {
      const message: Message = {
        id: e.data.message_id,
        client_id: null,
        seq: envelope.seq ?? 0,
        role: "assistant",
        kind: e.data.kind,
        author: null,
        content: e.data.content,
        created_at: at,
        run_id: e.data.run_id,
        status: "ok",
      };
      const known = state.messages.find((m) => m.id === message.id);
      const merged = known ? { ...known, content: message.content, kind: message.kind, run_id: message.run_id } : message;
      return { ...state, live: null, messages: upsertMessage(state.messages, merged) };
    }
    case "visit.updated":
      return { ...state, visit: e.data };
    case "mode.changed":
      return { ...state, visit: state.visit ? { ...state.visit, mode: e.data.mode } : state.visit };
    case "note.signed":
      return e.data.note ? { ...state, note: e.data.note } : { ...state, stale: true };
    case "run.interrupted":
      return {
        ...state,
        live: null,
        runs: upsertRun(state.runs, { id: e.data.run_id, status: "interrupted" }, at),
        run: { phase: "interrupted", runId: e.data.run_id, code: "interrupted" },
      };
    case "run.completed":
      return {
        ...state,
        live: null,
        trace: adoptPending(state.trace, e.data.run_id),
        runs: upsertRun(
          state.runs,
          { id: e.data.run_id, model: e.data.model, status: e.data.status, steps: e.data.steps, usage: e.data.usage },
          at,
        ),
        run: { phase: "idle", runId: e.data.run_id, code: null },
      };
    case "run.failed":
      return {
        ...state,
        live: null,
        trace: adoptPending(state.trace, e.data.run_id),
        runs: upsertRun(state.runs, { id: e.data.run_id, status: "failed", error_code: e.data.code }, at),
        run: { phase: "failed", runId: e.data.run_id, code: e.data.code },
      };
    default:
      return state; // the server may add event types
  }
}

export function visitReducer(state: VisitState, action: VisitAction): VisitState {
  switch (action.type) {
    case "reset":
      return initialVisitState;
    case "loaded": {
      const d = action.detail;
      // Read before an event we already applied: only the note (which events may not carry) is newer.
      if (state.loaded && d.visit.last_seq < state.lastSeq) return { ...state, note: d.note, stale: false };
      const runs = d.runs.map(toRunView);
      return {
        ...state,
        loaded: true,
        stale: false,
        visit: d.visit,
        messages: sortMessages(d.messages),
        live: null,
        intake: d.intake,
        summary: d.summary,
        redFlag: d.red_flag,
        tickets: d.tickets,
        trace: d.tool_calls.map(toTraceRow),
        runs,
        refillChecks: d.refill_checks,
        note: d.note,
        run: runStateFrom(runs),
        lastSeq: d.visit.last_seq,
      };
    }
    case "event": {
      const { envelope } = action;
      if (envelope.seq !== null && envelope.seq <= state.lastSeq) return state;
      const next = applyEvent(state, envelope, action.at);
      return envelope.seq === null ? next : { ...next, lastSeq: envelope.seq };
    }
    case "stream_opened":
      return state.live ? { ...state, live: null } : state;
    case "message_sent": {
      const running = action.runId !== null && !state.runs.some((r) => r.id === action.runId && r.status !== "running");
      return {
        ...state,
        messages: upsertMessage(state.messages, action.message),
        run: running ? { phase: "running", runId: action.runId, code: null } : state.run,
      };
    }
    case "retry_started":
      return { ...state, run: { phase: "running", runId: null, code: null }, live: null };
    case "visit_patched":
      return { ...state, visit: action.visit };
    case "summary_patched":
      return { ...state, summary: action.summary };
    case "note_patched":
      return { ...state, note: action.note };
    case "ticket_added":
      return { ...state, tickets: upsertById(state.tickets, action.ticket) };
    case "refill_checked":
      return { ...state, refillChecks: upsertById(state.refillChecks, action.record) };
  }
}

/** Latest refill result of the visit, if any. */
export function latestRefill(state: Pick<VisitState, "refillChecks">): RefillCheckRecord | null {
  return state.refillChecks.at(-1) ?? null;
}
/** The emergency card follows the hit, never the status, and stays on closed visits. */
export function showEmergency(state: Pick<VisitState, "redFlag">): boolean {
  return state.redFlag !== null;
}
/** Fixed text of the latest red_flag message, for the emergency card. */
export function redFlagText(messages: readonly Message[]): string | null {
  return messages.findLast((m) => m.role === "assistant" && m.kind === "red_flag")?.content ?? null;
}
/** A failed run also leaves a fixed `notice` message that already says it, so the banner stays away. */
export function failureBannerVisible(state: Pick<VisitState, "run" | "messages">): boolean {
  if (state.run.phase === "interrupted") return true;
  if (state.run.phase !== "failed") return false;
  const last = state.messages.at(-1);
  return !(last && last.role === "assistant" && last.kind === "notice");
}
