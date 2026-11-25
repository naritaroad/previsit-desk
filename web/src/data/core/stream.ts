// A long-lived SSE connection that keeps itself alive: backoff, Last-Event-ID, stall watchdog, paused while the
// page is hidden or offline. Used by the visit stream and the account stream.

import { isApiError } from "../../api/errors.ts";
import type { ApiError } from "../../api/errors.ts";
import { openStream, type OpenStreamOptions } from "../../api/sse.ts";
import type { StreamEnvelope } from "../../api/types.ts";
import { backoffMs, type Env, Store } from "./env.ts";

export type Connection = "connecting" | "open" | "retrying" | "paused" | "offline" | "closed";
export interface ConnectionState {
  connection: Connection;
  /** Why the stream is closed for good (401, 403, 404). */
  error: ApiError | null;
  /** When the next attempt runs, while retrying. */
  retryAt: number | null;
}

export interface ReconnectingStreamOptions {
  env: Env;
  path: () => string;
  lastEventId?: () => number | null;
  onEnvelope: (e: StreamEnvelope) => void;
  onOpen?: () => void;
  /** Keep the connection while the page is hidden (the account stream's leader does). */
  keepWhenHidden?: boolean;
  /** How long a hidden page keeps its stream before pausing. */
  hiddenGraceMs?: number;
  /** No bytes for this long (the server sends a comment every 15 s) means a dead connection. */
  stallMs?: number;
  open?: (path: string, o: OpenStreamOptions) => Promise<void>;
}

const FATAL = new Set(["unauthorized", "forbidden", "not_found", "invalid_request"]);

export class ReconnectingStream {
  readonly state = new Store<ConnectionState>({ connection: "closed", error: null, retryAt: null });
  private readonly o: ReconnectingStreamOptions;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private started = false;
  private offs: (() => void)[] = [];

  constructor(o: ReconnectingStreamOptions) {
    this.o = o;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { page } = this.o.env;
    this.offs = [
      page.on("online", () => this.resume()),
      page.on("offline", () => {
        this.disconnect();
        this.state.patch({ connection: "offline", retryAt: null });
      }),
      page.on("visible", () => this.resume()),
      page.on("hidden", () => {
        if (this.o.keepWhenHidden) return;
        this.hiddenTimer ??= setTimeout(() => {
          this.hiddenTimer = null;
          if (!page.hidden()) return;
          this.disconnect();
          this.state.patch({ connection: "paused", retryAt: null });
        }, this.o.hiddenGraceMs ?? 10_000);
      }),
    ];
    this.connect();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const off of this.offs) off();
    this.offs = [];
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = null;
    this.disconnect();
    this.state.set({ connection: "closed", error: null, retryAt: null });
  }

  /** Try again right away (a "reconnect" button, coming back online or to the foreground). */
  resume(): void {
    if (!this.started) return;
    if (this.hiddenTimer) {
      clearTimeout(this.hiddenTimer);
      this.hiddenTimer = null;
    }
    const { connection, error } = this.state.get();
    if (connection === "open" || connection === "connecting") return;
    if (error) return; // closed for good
    this.attempt = 0;
    this.connect();
  }

  private disconnect(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.timer = null;
    this.watchdog = null;
    this.abort?.abort();
    this.abort = null;
  }

  private connect(): void {
    this.disconnect();
    const { env } = this.o;
    if (!env.page.online()) {
      this.state.patch({ connection: "offline", retryAt: null });
      return;
    }
    if (!this.o.keepWhenHidden && env.page.hidden() && this.state.get().connection === "paused") return;
    const abort = new AbortController();
    this.abort = abort;
    this.state.patch({ connection: "connecting", retryAt: null });
    const feed = () => {
      if (this.watchdog) clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => {
        if (this.abort === abort) this.fail(abort, null);
      }, this.o.stallMs ?? 40_000);
    };
    feed();
    (this.o.open ?? openStream)(this.o.path(), {
      signal: abort.signal,
      lastEventId: this.o.lastEventId?.() ?? null,
      onOpen: () => {
        if (this.abort !== abort) return;
        this.state.patch({ connection: "open", retryAt: null, error: null });
        this.o.onOpen?.();
      },
      onActivity: () => {
        if (this.abort !== abort) return;
        feed();
      },
      onEnvelope: (e) => {
        if (this.abort !== abort) return;
        this.attempt = 0;
        this.o.onEnvelope(e);
      },
    }).then(
      () => this.fail(abort, null), // the server closed it (restart, deploy): reconnect
      (e: unknown) => this.fail(abort, e),
    );
  }

  private fail(abort: AbortController, e: unknown): void {
    if (this.abort !== abort || !this.started) return;
    this.disconnect();
    if (isApiError(e) && FATAL.has(e.code)) {
      this.state.set({ connection: "closed", error: e, retryAt: null });
      return;
    }
    const { env } = this.o;
    if (!env.page.online()) {
      this.state.patch({ connection: "offline", retryAt: null });
      return;
    }
    const wait =
      isApiError(e, "rate_limited") && e.retryAfter ? e.retryAfter * 1000 : backoffMs(this.attempt, env.random());
    this.attempt += 1;
    this.state.patch({ connection: "retrying", retryAt: env.now() + wait });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, wait);
  }
}
