// Coordination between tabs: a typed BroadcastChannel and leader election (Web Locks, or a localStorage lease
// where locks are missing). One leader per name; when its tab closes or crashes another tab takes over.

import { readStorage, writeStorage } from "../../lib/storage.ts";
import { TAB_ID, uuid } from "../../lib/ids.ts";

export interface TabChannel<M> {
  post(message: M): void;
  onMessage(listener: (message: M, fromTab: string) => void): () => void;
  close(): void;
}
interface Wire<M> {
  from: string;
  m: M;
}
export type ChannelFactory = <M>(name: string) => TabChannel<M>;

export const openChannel: ChannelFactory = <M>(name: string): TabChannel<M> => {
  const from = `${TAB_ID}:${uuid()}`;
  const listeners = new Set<(m: M, from: string) => void>();
  const bc = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(name);
  if (bc) {
    bc.onmessage = (e: MessageEvent<Wire<M>>) => {
      if (e.data?.from !== from) for (const l of [...listeners]) l(e.data.m, e.data.from);
    };
    // Node's BroadcastChannel keeps the process alive; the browser's has no unref.
    (bc as { unref?: () => void }).unref?.();
  }
  let closed = false;
  return {
    post(m) {
      if (!closed) bc?.postMessage({ from, m } satisfies Wire<M>);
    },
    onMessage(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    close() {
      closed = true;
      listeners.clear();
      bc?.close();
    },
  };
};

/** Channels between objects of one process: several "tabs" in a test. */
export function memoryChannels(): ChannelFactory {
  const rooms = new Map<string, Set<(m: unknown, from: string) => void>>();
  return <M>(name: string): TabChannel<M> => {
    const from = uuid();
    const room = rooms.get(name) ?? new Set();
    rooms.set(name, room);
    const mine = new Set<(m: M, f: string) => void>();
    const receive = (m: unknown, f: string) => {
      if (f !== from) for (const l of [...mine]) l(m as M, f);
    };
    room.add(receive);
    return {
      post(m) {
        const copy = structuredClone(m);
        queueMicrotask(() => {
          for (const r of [...room]) r(copy, from);
        });
      },
      onMessage(l) {
        mine.add(l);
        return () => mine.delete(l);
      },
      close() {
        mine.clear();
        room.delete(receive);
      },
    };
  };
}

export interface Leadership {
  readonly isLeader: boolean;
  /** Give up leadership (or stop waiting for it). */
  release(): void;
}
export type Elect = (name: string, onChange: (leader: boolean) => void) => Leadership;

function electWithLocks(locks: LockManager): Elect {
  return (name, onChange) => {
    let leader = false;
    let done: (() => void) | null = null;
    const abort = new AbortController();
    locks
      .request(name, { mode: "exclusive", signal: abort.signal }, () => {
        if (abort.signal.aborted) return undefined;
        leader = true;
        onChange(true);
        return new Promise<void>((resolve) => {
          done = resolve;
        });
      })
      .catch(() => undefined);
    return {
      get isLeader() {
        return leader;
      },
      release() {
        abort.abort();
        done?.();
        if (leader) {
          leader = false;
          onChange(false);
        }
      },
    };
  };
}

const LEASE_MS = 6000;
/** Best effort without Web Locks: a lease renewed every 2 s; a crashed leader is replaced within 6 s. */
const electWithLease: Elect = (name, onChange) => {
  const key = `pv-lease:${name}`;
  const id = uuid();
  let leader = false;
  const set = (v: boolean) => {
    if (v !== leader) {
      leader = v;
      onChange(v);
    }
  };
  const tick = () => {
    const [owner, until] = (readStorage(key) ?? "").split("|");
    if (owner === id || !owner || Number(until) < Date.now()) {
      writeStorage(key, `${id}|${Date.now() + LEASE_MS}`);
      set((readStorage(key) ?? `${id}|`).startsWith(`${id}|`));
    } else set(false);
  };
  const timer = setInterval(tick, LEASE_MS / 3);
  queueMicrotask(tick);
  return {
    get isLeader() {
      return leader;
    },
    release() {
      clearInterval(timer);
      if (leader) writeStorage(key, null);
      set(false);
    },
  };
};

export const elect: Elect = (name, onChange) => {
  const locks = typeof navigator === "undefined" ? undefined : (navigator as { locks?: LockManager }).locks;
  return (locks ? electWithLocks(locks) : electWithLease)(name, onChange);
};

/** Election between objects of one process: the first waiting one gets it. For tests. */
export function memoryElections(): Elect {
  const queues = new Map<string, { onChange: (v: boolean) => void; leader: boolean; dead: boolean }[]>();
  const promote = (name: string) => {
    const head = queues.get(name)?.[0];
    if (head && !head.leader) {
      head.leader = true;
      queueMicrotask(() => {
        if (!head.dead) head.onChange(true);
      });
    }
  };
  return (name, onChange) => {
    const entry = { onChange, leader: false, dead: false };
    const queue = queues.get(name) ?? [];
    queues.set(name, queue);
    queue.push(entry);
    promote(name);
    return {
      get isLeader() {
        return entry.leader;
      },
      release() {
        if (entry.dead) return;
        entry.dead = true;
        queue.splice(queue.indexOf(entry), 1);
        if (entry.leader) {
          entry.leader = false;
          onChange(false);
        }
        promote(name);
      },
    };
  };
}
