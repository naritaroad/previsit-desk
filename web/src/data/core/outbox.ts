// Messages waiting to be sent. Stored in IndexedDB with a client_id before anything is sent, so they survive
// reload, crash, offline and closing the tab. The server keeps one message per client_id (a repeat answers 200
// with the same object), which makes resending after an unknown outcome safe: exactly once.
//
// One tab sends (leader election); the others write to the same store and watch it through a BroadcastChannel.
// Order is kept per visit: a message that cannot be sent blocks the ones behind it until it is retried or dropped.

import { visitsApi } from "../../api/endpoints.ts";
import { ApiError } from "../../api/errors.ts";
import type { ApiErrorCode, SendMessageResult } from "../../api/types.ts";
import { uuid } from "../../lib/ids.ts";
import { backoffMs, type Env, Store } from "./env.ts";
import { kvKey } from "./kv.ts";
import type { Leadership, TabChannel } from "./tabs.ts";

export type OutboxStatus = "queued" | "sending" | "sent" | "failed";
export interface OutboxItem {
  client_id: string;
  visit_id: string;
  /** patient: POST …/messages; staff: POST …/staff-messages */
  kind: "patient" | "staff";
  content: string;
  created_at: string;
  status: OutboxStatus;
  attempts: number;
  /** Not before this time (after a temporary failure). */
  next_at: number;
  /** Why it failed (failed) or why it is waiting (queued after a temporary failure). */
  error: { code: ApiErrorCode; message: string; retryAfter: number | null } | null;
  /** Server id once accepted. */
  message_id: string | null;
  sent_at: number | null;
}

export interface OutboxState {
  ready: boolean;
  items: OutboxItem[];
  leader: boolean;
}

type Wire = { type: "changed" } | { type: "flush" } | { type: "sent"; visitId: string; result: SendMessageResult };

export type SendFn = (item: OutboxItem) => Promise<SendMessageResult>;
export interface OutboxOptions {
  accountId: string;
  env: Env;
  send?: SendFn;
  /** Every tab hears about each accepted message (to fold it into the visit before the stream does). */
  onSent?: (visitId: string, result: SendMessageResult) => void;
  /** A run is still going on this visit: the server would answer 409, so wait for it. */
  isBusy?: (visitId: string) => boolean;
}

const KEEP_SENT_MS = 60_000;
const BUSY_WAIT_MS = 1500;

const defaultSend: SendFn = (item) =>
  item.kind === "staff"
    ? visitsApi.staffSend(item.visit_id, { content: item.content, client_id: item.client_id })
    : visitsApi.send(item.visit_id, { content: item.content, client_id: item.client_id });

export class Outbox {
  readonly state = new Store<OutboxState>({ ready: false, items: [], leader: false });
  private readonly o: OutboxOptions;
  private readonly key: string;
  private channel: TabChannel<Wire> | null = null;
  private leadership: Leadership | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;
  private again = false;
  private stopped = true;
  private paused = false;
  private offs: (() => void)[] = [];

  constructor(o: OutboxOptions) {
    this.o = o;
    this.key = kvKey("outbox", o.accountId);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const { env } = this.o;
    this.channel = env.channel<Wire>(`pv-outbox:${this.o.accountId}`);
    this.channel.onMessage((m) => {
      if (m.type === "sent") this.o.onSent?.(m.visitId, m.result);
      if (m.type === "flush") this.paused = false;
      void this.reload().then(() => this.pump());
    });
    this.offs = [env.page.on("online", () => this.flush()), env.page.on("visible", () => void this.pump())];
    this.leadership = env.elect(`pv-outbox:${this.o.accountId}`, (leader) => {
      if (this.stopped) return;
      this.state.patch({ leader });
      if (leader) void this.recover().then(() => this.pump());
    });
    void this.reload().then(() => this.pump());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const off of this.offs) off();
    this.offs = [];
    this.leadership?.release();
    this.leadership = null;
    this.channel?.close();
    this.channel = null;
  }

  /** Write first, send later. Resolves with the client_id once the message is stored. */
  async enqueue(input: { visit_id: string; content: string; kind?: "patient" | "staff" }): Promise<string> {
    const item: OutboxItem = {
      client_id: uuid(),
      visit_id: input.visit_id,
      kind: input.kind ?? "patient",
      content: input.content,
      created_at: new Date(this.o.env.now()).toISOString(),
      status: "queued",
      attempts: 0,
      next_at: 0,
      error: null,
      message_id: null,
      sent_at: null,
    };
    await this.mutate((items) => [...items, item]);
    void this.pump();
    return item.client_id;
  }

  /** Try a failed message again (same client_id), or everything that is waiting when no id is given. */
  async retry(clientId?: string): Promise<void> {
    this.paused = false;
    await this.mutate((items) =>
      items.map((i) =>
        (clientId ? i.client_id === clientId : true) && (i.status === "failed" || i.status === "queued")
          ? { ...i, status: "queued", next_at: 0, error: null }
          : i,
      ),
    );
    this.channel?.post({ type: "flush" });
    void this.pump();
  }

  /** Drop a message that was not accepted. Returns its text so the composer can take it back. */
  async discard(clientId: string): Promise<string | null> {
    const item = this.state.get().items.find((i) => i.client_id === clientId);
    if (!item || item.status === "sending" || item.status === "sent") return null;
    await this.mutate((items) => items.filter((i) => i.client_id !== clientId));
    void this.pump();
    return item.content;
  }

  /** The visit's stream showed the message, so the outbox no longer needs to. */
  async confirm(clientIds: readonly string[]): Promise<void> {
    const set = new Set(clientIds);
    if (!this.state.get().items.some((i) => set.has(i.client_id) && i.status !== "failed")) return;
    await this.mutate((items) => items.filter((i) => !set.has(i.client_id)));
  }

  itemsFor(visitId: string): OutboxItem[] {
    return this.state.get().items.filter((i) => i.visit_id === visitId);
  }
  /** Anything that would be lost to the person's attention by leaving (still not accepted). */
  hasUnsent(visitId?: string): boolean {
    return this.state.get().items.some((i) => i.status !== "sent" && (!visitId || i.visit_id === visitId));
  }

  flush(): void {
    this.paused = false;
    void this.mutate((items) => items.map((i) => (i.status === "queued" && i.next_at > 0 ? { ...i, next_at: 0 } : i))).then(() =>
      this.pump(),
    );
  }

  // ------------------------------------------------------------------------------------------------ store

  private async reload(): Promise<void> {
    const items = (await this.o.env.kv.get<OutboxItem[]>(this.key)) ?? [];
    if (!this.stopped) this.state.patch({ ready: true, items });
  }

  private async mutate(fn: (items: OutboxItem[]) => OutboxItem[]): Promise<void> {
    let next: OutboxItem[] = [];
    await this.o.env.kv.update<OutboxItem[]>(this.key, (old) => {
      next = fn(old ?? []);
      return next;
    });
    this.state.patch({ ready: true, items: next });
    this.channel?.post({ type: "changed" });
  }

  private patchItem(clientId: string, part: Partial<OutboxItem>): Promise<void> {
    return this.mutate((items) => items.map((i) => (i.client_id === clientId ? { ...i, ...part } : i)));
  }

  /** A new leader: what the previous one left as "sending" has an unknown outcome and is sent again. */
  private async recover(): Promise<void> {
    await this.reload();
    const now = this.o.env.now();
    const items = this.state.get().items;
    if (!items.some((i) => i.status === "sending" || (i.status === "sent" && now - (i.sent_at ?? 0) > KEEP_SENT_MS))) return;
    await this.mutate((all) =>
      all
        .filter((i) => !(i.status === "sent" && now - (i.sent_at ?? 0) > KEEP_SENT_MS))
        .map((i) => (i.status === "sending" ? { ...i, status: "queued" as const } : i)),
    );
  }

  // ------------------------------------------------------------------------------------------------ sending

  /** The next message to send: the oldest unsent one of each visit, if it is due. */
  private nextDue(now: number): { item: OutboxItem | null; wakeAt: number | null } {
    const seen = new Set<string>();
    let wakeAt: number | null = null;
    for (const item of this.state.get().items) {
      if (item.status === "sent" || seen.has(item.visit_id)) continue;
      seen.add(item.visit_id); // head of this visit's line
      if (item.status !== "queued") continue;
      if (this.o.isBusy?.(item.visit_id)) {
        wakeAt = Math.min(wakeAt ?? Number.POSITIVE_INFINITY, now + BUSY_WAIT_MS);
        continue;
      }
      if (item.next_at <= now) return { item, wakeAt: null };
      wakeAt = Math.min(wakeAt ?? Number.POSITIVE_INFINITY, item.next_at);
    }
    return { item: null, wakeAt };
  }

  /** Wake the sender (a run just finished). */
  poke(): void {
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.paused || !this.leadership?.isLeader) return;
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      for (;;) {
        this.again = false;
        if (this.stopped || this.paused || !this.o.env.page.online()) break;
        const now = this.o.env.now();
        const { item, wakeAt } = this.nextDue(now);
        if (!item) {
          if (this.again) continue;
          if (wakeAt !== null) this.timer = setTimeout(() => void this.pump(), Math.max(10, wakeAt - now));
          break;
        }
        await this.sendOne(item);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async sendOne(item: OutboxItem): Promise<void> {
    await this.patchItem(item.client_id, { status: "sending", attempts: item.attempts + 1, error: null });
    try {
      const result = await (this.o.send ?? defaultSend)(item);
      if (this.stopped) return;
      await this.patchItem(item.client_id, {
        status: "sent",
        message_id: result.message.id,
        sent_at: this.o.env.now(),
        error: null,
      });
      this.o.onSent?.(item.visit_id, result);
      this.channel?.post({ type: "sent", visitId: item.visit_id, result });
    } catch (e) {
      if (this.stopped) return;
      const err = e instanceof ApiError ? e : new ApiError({ status: 0, code: "internal", message: String(e) });
      const error = { code: err.code, message: err.message, retryAfter: err.retryAfter };
      const busy = err.code === "conflict";
      if (err.code === "unauthorized") {
        // Signed out: keep the message; sign-in (a new outbox or retry) sends it.
        this.paused = true;
        await this.patchItem(item.client_id, { status: "queued", error });
      } else if (err.transient || busy) {
        const wait = err.retryAfter ? err.retryAfter * 1000 : busy ? BUSY_WAIT_MS : backoffMs(item.attempts, this.o.env.random(), 800, 30_000);
        await this.patchItem(item.client_id, { status: "queued", error: busy ? null : error, next_at: this.o.env.now() + wait });
      } else {
        await this.patchItem(item.client_id, { status: "failed", error });
      }
    }
  }
}
