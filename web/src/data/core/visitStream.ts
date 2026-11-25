// One visit, live: GET /visits/{id}, then GET /visits/{id}/stream?after=<last_seq>. Replayed events and events
// seen twice are dropped by seq; a reconnect continues after the last one applied.

import { visitsApi } from "../../api/endpoints.ts";
import { ApiError, isApiError } from "../../api/errors.ts";
import type { openStream } from "../../api/sse.ts";
import type { SendMessageResult, VisitDetail } from "../../api/types.ts";
import { initialVisitState, type VisitAction, visitReducer, type VisitState } from "../../lib/visitState.ts";
import { backoffMs, type Env, Store } from "./env.ts";
import { type Connection, ReconnectingStream } from "./stream.ts";

export interface VisitStreamState extends VisitState {
  phase: "loading" | "ready" | "error";
  error: ApiError | null;
  connection: Connection;
  /** When the next reconnect runs (ms since epoch), while connection is "retrying". */
  retryAt: number | null;
}

export interface VisitStreamOptions {
  visitId: string;
  env: Env;
  load?: (id: string) => Promise<VisitDetail>;
  retry?: (id: string) => Promise<unknown>;
  open?: typeof openStream;
  /** A visit already in the query cache: shown at once, then refreshed. */
  initial?: VisitDetail;
  /** Every change of the underlying detail, for the query cache. */
  onLoaded?: (detail: VisitDetail) => void;
  /** A run ended (the outbox may send the next message). */
  onIdle?: () => void;
  /** Client ids of our own messages the server confirmed. */
  onConfirmed?: (clientIds: string[]) => void;
}

export class VisitStream {
  readonly state: Store<VisitStreamState>;
  private readonly o: VisitStreamOptions;
  private readonly stream: ReconnectingStream;
  private started = false;
  private loading = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private off: (() => void) | null = null;

  constructor(o: VisitStreamOptions) {
    this.o = o;
    this.state = new Store<VisitStreamState>({
      ...initialVisitState,
      phase: "loading",
      error: null,
      connection: "connecting",
      retryAt: null,
    });
    if (o.initial) this.dispatch({ type: "loaded", detail: o.initial });
    this.stream = new ReconnectingStream({
      env: o.env,
      path: () => visitsApi.streamPath(o.visitId, this.state.get().lastSeq),
      lastEventId: () => this.state.get().lastSeq || null,
      open: o.open,
      onOpen: () => this.dispatch({ type: "stream_opened" }),
      onEnvelope: (envelope) => {
        this.dispatch({ type: "event", envelope, at: new Date(o.env.now()).toISOString() });
        if (this.state.get().stale) void this.reload();
      },
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.off = this.stream.state.subscribe(() => {
      const s = this.stream.state.get();
      this.state.patch({ connection: s.connection, retryAt: s.retryAt });
      // Deleted or access removed while open.
      if (s.error && this.state.get().phase === "ready") this.state.patch({ phase: "error", error: s.error });
    });
    void this.reload();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.off?.();
    this.off = null;
    this.stream.stop();
  }

  /** Read the visit again (also the "try again" button of the error state). */
  async reload(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const detail = await (this.o.load ?? visitsApi.get)(this.o.visitId);
      if (!this.started) return;
      this.attempts = 0;
      this.dispatch({ type: "loaded", detail });
      this.state.patch({ phase: "ready", error: null });
      this.o.onLoaded?.(detail);
      this.stream.start();
    } catch (e) {
      if (!this.started) return;
      const error = e instanceof ApiError ? e : new ApiError({ status: 0, code: "internal", message: String(e) });
      if (error.transient) {
        // Keep what is on screen; connection says what is going on.
        this.state.patch({
          phase: this.state.get().loaded ? "ready" : "error",
          error,
          connection: this.o.env.page.online() ? "retrying" : "offline",
        });
        this.timer = setTimeout(
          () => {
            this.timer = null;
            if (this.started) void this.reload();
          },
          error.retryAfter ? error.retryAfter * 1000 : backoffMs(this.attempts, this.o.env.random()),
        );
        this.attempts += 1;
      } else this.state.patch({ phase: "error", error, connection: "closed" });
    } finally {
      this.loading = false;
    }
  }

  reconnect(): void {
    if (this.state.get().phase === "ready") this.stream.resume();
    else void this.reload();
  }

  /** Run the last interrupted or failed turn again. */
  async retryRun(): Promise<void> {
    const before = this.state.get().run;
    this.dispatch({ type: "retry_started" });
    try {
      await (this.o.retry ?? visitsApi.retryRun)(this.o.visitId);
    } catch (e) {
      // Already running (another tab pressed it first): the stream shows it.
      if (!isApiError(e, "conflict")) this.state.patch({ run: before });
      throw e;
    }
  }

  onSent(result: SendMessageResult): void {
    this.dispatch({ type: "message_sent", message: result.message, runId: result.run_id });
  }

  dispatch(action: VisitAction): void {
    const prev = this.state.get();
    const next = visitReducer(prev, action);
    if (next === prev) return;
    this.state.set({ ...prev, ...next });
    if (next.messages !== prev.messages) {
      const ids = next.messages.flatMap((m) => (m.client_id ? [m.client_id] : []));
      if (ids.length) this.o.onConfirmed?.(ids);
    }
    if (prev.run.phase === "running" && next.run.phase !== "running") this.o.onIdle?.();
  }
}
