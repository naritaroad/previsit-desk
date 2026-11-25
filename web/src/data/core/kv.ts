// Key-value store used for everything that must survive a reload: IndexedDB through idb-keyval, or memory when
// IndexedDB is missing or blocked (private windows, tests). `update` is atomic across tabs.

import { createStore, del, get, keys, set, update, type UseStore } from "idb-keyval";

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  update<T>(key: string, fn: (old: T | undefined) => T): Promise<void>;
  del(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export class MemoryKV implements KV {
  readonly map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.map.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
  async update<T>(key: string, fn: (old: T | undefined) => T): Promise<void> {
    this.map.set(key, structuredClone(fn(this.map.get(key) as T | undefined)));
  }
  async del(key: string): Promise<void> {
    this.map.delete(key);
  }
  async keys(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}

class IdbKV implements KV {
  private readonly store: UseStore;
  constructor() {
    this.store = createStore("previsit-desk", "kv");
  }
  get<T>(key: string) {
    return get<T>(key, this.store);
  }
  set<T>(key: string, value: T) {
    return set(key, value, this.store);
  }
  update<T>(key: string, fn: (old: T | undefined) => T) {
    return update<T>(key, fn, this.store);
  }
  del(key: string) {
    return del(key, this.store);
  }
  async keys(prefix: string) {
    return (await keys<string>(this.store)).filter((k) => typeof k === "string" && k.startsWith(prefix));
  }
}

/** Falls back to memory on the first failure (blocked or broken IndexedDB), and says so once. */
class SafeKV implements KV {
  private inner: KV;
  private readonly memory = new MemoryKV();
  constructor(inner: KV) {
    this.inner = inner;
  }
  private async run<T>(op: (kv: KV) => Promise<T>): Promise<T> {
    try {
      return await op(this.inner);
    } catch (e) {
      if (this.inner === this.memory) throw e;
      console.warn("IndexedDB is not available; unsent work is kept in this tab only.");
      this.inner = this.memory;
      return op(this.inner);
    }
  }
  get<T>(key: string) {
    return this.run((kv) => kv.get<T>(key));
  }
  set<T>(key: string, value: T) {
    return this.run((kv) => kv.set(key, value));
  }
  update<T>(key: string, fn: (old: T | undefined) => T) {
    return this.run((kv) => kv.update(key, fn));
  }
  del(key: string) {
    return this.run((kv) => kv.del(key));
  }
  keys(prefix: string) {
    return this.run((kv) => kv.keys(prefix));
  }
}

let shared: KV | null = null;
export function defaultKV(): KV {
  shared ??= typeof indexedDB === "undefined" ? new MemoryKV() : new SafeKV(new IdbKV());
  return shared;
}
/** Tests. */
export function setDefaultKV(kv: KV | null): void {
  shared = kv;
}

/**
 * Keys are scoped per account, so one person's unsent work or cached data is never read as another's.
 * kind: draft, outbox, rx (pending wizard changes), cache (query cache).
 */
export const kvKey = (kind: "draft" | "outbox" | "rx" | "cache", accountId: string, rest = "") =>
  `pv:${kind}:${accountId}${rest ? `:${rest}` : ""}`;

/** Remove what belongs to an account (logout) or to every other account (sign-in). */
export async function purgeAccounts(kv: KV, which: { only: string } | { except: string }, kinds?: readonly string[]): Promise<void> {
  for (const key of await kv.keys("pv:")) {
    const [, kind, account] = key.split(":");
    if (kinds && !kinds.includes(kind)) continue;
    const mine = "only" in which ? account === which.only : account !== which.except;
    if (mine) await kv.del(key);
  }
}
