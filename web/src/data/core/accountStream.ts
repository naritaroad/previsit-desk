// GET /me/stream for the whole browser: one tab (the leader) keeps the connection and passes every event to the
// others, so ten open tabs do not use ten connections.

import { meApi } from "../../api/endpoints.ts";
import type { openStream } from "../../api/sse.ts";
import type { AccountEvent, StreamEnvelope } from "../../api/types.ts";
import { type Env, Store } from "./env.ts";
import { type Connection, ReconnectingStream } from "./stream.ts";
import type { Leadership, TabChannel } from "./tabs.ts";

const TYPES: ReadonlySet<string> = new Set(["notification", "visit.changed", "rx.changed", "queue.changed"]);
export function isAccountEvent(e: { type: string; data: unknown }): e is AccountEvent {
  return TYPES.has(e.type) && typeof e.data === "object" && e.data !== null;
}

type Wire = { type: "event"; event: AccountEvent } | { type: "reconnected" };

export interface AccountStreamOptions {
  accountId: string;
  env: Env;
  onEvent: (e: AccountEvent) => void;
  /** Events were possibly missed (the stream has no replay): refresh what is shown. */
  onReconnected: () => void;
  open?: typeof openStream;
}

export class AccountStream {
  readonly state = new Store<{ connection: Connection; leader: boolean }>({ connection: "connecting", leader: false });
  private readonly o: AccountStreamOptions;
  private stream: ReconnectingStream | null = null;
  private channel: TabChannel<Wire> | null = null;
  private leadership: Leadership | null = null;
  private openedBefore = false;

  constructor(o: AccountStreamOptions) {
    this.o = o;
  }

  start(): void {
    if (this.channel) return;
    const { env, accountId } = this.o;
    const channel = env.channel<Wire>(`pv-account:${accountId}`);
    this.channel = channel;
    channel.onMessage((m) => {
      if (m.type === "event") this.o.onEvent(m.event);
      else this.o.onReconnected();
    });
    this.leadership = env.elect(`pv-account:${accountId}`, (leader) => {
      this.state.patch({ leader });
      if (leader) this.lead();
      else this.stream?.stop();
    });
  }

  private lead(): void {
    this.stream = new ReconnectingStream({
      env: this.o.env,
      path: () => meApi.streamPath(),
      keepWhenHidden: true,
      open: this.o.open,
      onOpen: () => {
        if (this.openedBefore) {
          this.o.onReconnected();
          this.channel?.post({ type: "reconnected" });
        }
        this.openedBefore = true;
      },
      onEnvelope: (e: StreamEnvelope) => {
        const event = { type: e.type, data: e.data };
        if (!isAccountEvent(event)) return;
        this.o.onEvent(event);
        this.channel?.post({ type: "event", event });
      },
    });
    const stream = this.stream;
    stream.state.subscribe(() => this.state.patch({ connection: stream.state.get().connection }));
    stream.start();
  }

  stop(): void {
    this.leadership?.release();
    this.leadership = null;
    this.stream?.stop();
    this.stream = null;
    this.channel?.close();
    this.channel = null;
  }
}
