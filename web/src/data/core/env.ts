// What the controllers need from the outside: storage, tab channels, elections, timers and the page's
// visibility and connectivity. Tests pass their own; the app uses browserEnv().

import { defaultKV, type KV } from "./kv.ts";
import { type ChannelFactory, type Elect, elect, openChannel } from "./tabs.ts";

export interface PageState {
  online(): boolean;
  hidden(): boolean;
  /** online, offline, visible, hidden, pagehide */
  on(event: PageEvent, listener: () => void): () => void;
}
export type PageEvent = "online" | "offline" | "visible" | "hidden" | "pagehide";

export interface Env {
  kv: KV;
  channel: ChannelFactory;
  elect: Elect;
  page: PageState;
  now(): number;
  /** 0..1, for jitter. */
  random(): number;
}

const browserPage: PageState = {
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  on(event, listener) {
    if (typeof window === "undefined") return () => undefined;
    if (event === "visible" || event === "hidden") {
      const onChange = () => {
        if ((document.visibilityState === "hidden") === (event === "hidden")) listener();
      };
      document.addEventListener("visibilitychange", onChange);
      return () => document.removeEventListener("visibilitychange", onChange);
    }
    window.addEventListener(event, listener);
    return () => window.removeEventListener(event, listener);
  },
};

export function browserEnv(): Env {
  return { kv: defaultKV(), channel: openChannel, elect, page: browserPage, now: () => Date.now(), random: () => Math.random() };
}

/** A page whose state tests control. */
export class FakePage implements PageState {
  isOnline = true;
  isHidden = false;
  private readonly listeners = new Map<PageEvent, Set<() => void>>();
  online = () => this.isOnline;
  hidden = () => this.isHidden;
  on(event: PageEvent, listener: () => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    this.listeners.set(event, set);
    set.add(listener);
    return () => set.delete(listener);
  }
  emit(event: PageEvent): void {
    if (event === "online") this.isOnline = true;
    if (event === "offline") this.isOnline = false;
    if (event === "hidden") this.isHidden = true;
    if (event === "visible") this.isHidden = false;
    for (const l of [...(this.listeners.get(event) ?? [])]) l();
  }
}

/** 0.5 s, 1 s, 2 s … capped, with up to 30 % jitter so tabs and clients do not retry in step. */
export function backoffMs(attempt: number, random: number, base = 500, cap = 15_000): number {
  const raw = Math.min(cap, base * 2 ** Math.max(0, attempt));
  return Math.round(raw * (1 + 0.3 * random));
}

/** Minimal observable store for useSyncExternalStore. */
export class Store<S> {
  private state: S;
  private readonly listeners = new Set<() => void>();
  constructor(initial: S) {
    this.state = initial;
  }
  get = (): S => this.state;
  set(next: S): void {
    if (Object.is(next, this.state)) return;
    this.state = next;
    for (const l of [...this.listeners]) l();
  }
  patch(part: Partial<S>): void {
    this.set({ ...this.state, ...part });
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}
