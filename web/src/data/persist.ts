// The query cache and its copy in IndexedDB. The cache holds exactly one account. Its copy is stored under that
// account's id and role, restored only after the server confirmed who is signed in (or while offline, for the
// last account of this browser), and removed on logout, on a role change and after 24 hours.

import { defaultShouldDehydrateQuery, type Query, QueryClient } from "@tanstack/react-query";
import {
  type PersistedClient,
  type Persister,
  persistQueryClientRestore,
  persistQueryClientSave,
  persistQueryClientSubscribe,
} from "@tanstack/react-query-persist-client";

import { version } from "../../package.json";
import { ApiError } from "../api/errors.ts";
import type { Me } from "../api/types.ts";
import { KEYS, readStorage, writeStorage } from "../lib/storage.ts";
import { type KV, kvKey, purgeAccounts } from "./core/kv.ts";
import { qk } from "./keys.ts";

/** Raise when the shape of cached data changes. */
const CACHE_SCHEMA = 1;
export const BUSTER = `${version}-${import.meta.env?.VITE_BUILD_ID ?? "local"}-${CACHE_SCHEMA}`;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const WRITE_EVERY_MS = 1000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: MAX_AGE_MS, // must be at least maxAge or restored queries are collected at once
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        networkMode: "offlineFirst",
        retry: (count, e) => e instanceof ApiError && e.transient && e.code !== "rate_limited" && count < 2,
        retryDelay: (n) => Math.min(4000, 600 * 2 ** n),
      },
      mutations: { retry: false, networkMode: "always" },
    },
  });
}

/** meta: {persist: false} keeps a query out of IndexedDB (admin data, audit, one-time secrets). */
export function shouldPersist(query: Query): boolean {
  if (!defaultShouldDehydrateQuery(query)) return false;
  if (query.meta?.persist === false) return false;
  const domain = query.queryKey[0];
  return domain !== "admin" && domain !== "public" && domain !== "sessions";
}

class KvPersister implements Persister {
  private readonly kv: KV;
  private readonly key: string;
  private pending: PersistedClient | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dead = false;

  constructor(kv: KV, key: string) {
    this.kv = kv;
    this.key = key;
  }
  persistClient(client: PersistedClient): void {
    if (this.dead) return;
    this.pending = client;
    this.timer ??= setTimeout(() => void this.write(), WRITE_EVERY_MS);
  }
  restoreClient(): Promise<PersistedClient | undefined> {
    return this.kv.get<PersistedClient>(this.key);
  }
  async removeClient(): Promise<void> {
    this.cancel();
    await this.kv.del(this.key);
  }
  async write(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const client = this.pending;
    this.pending = null;
    if (client && !this.dead) await this.kv.set(this.key, client).catch(() => undefined);
  }
  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
  dispose(): void {
    this.dead = true;
    this.cancel();
  }
}

interface LastAccount {
  id: string;
  role: string;
}
function readLast(): LastAccount | null {
  try {
    const v: unknown = JSON.parse(readStorage(KEYS.lastAccount) ?? "null");
    if (typeof v === "object" && v !== null && "id" in v && "role" in v) return { id: String(v.id), role: String(v.role) };
  } catch {
    /* not ours */
  }
  return null;
}

export interface AccountCacheOptions {
  queryClient: QueryClient;
  kv: KV;
  buster?: string;
  maxAge?: number;
}

export class AccountCache {
  private readonly qc: QueryClient;
  private readonly kv: KV;
  private readonly buster: string;
  private readonly maxAge: number;
  private active: LastAccount | null = null;
  private persister: KvPersister | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(o: AccountCacheOptions) {
    this.qc = o.queryClient;
    this.kv = o.kv;
    this.buster = o.buster ?? BUSTER;
    this.maxAge = o.maxAge ?? MAX_AGE_MS;
  }

  get accountId(): string | null {
    return this.active?.id ?? null;
  }

  /** The server said who is signed in. Switches caches when that is someone else, or the same person in a new role. */
  async activate(me: Me): Promise<void> {
    if (this.active?.id === me.id && this.active.role === me.role) {
      this.qc.setQueryData(qk.me, me);
      return;
    }
    const roleChanged = this.active?.id === me.id || (readLast()?.id === me.id && readLast()?.role !== me.role);
    if (this.active) await this.deactivate("switch");
    else if (roleChanged) await this.kv.del(kvKey("cache", me.id));
    await purgeAccounts(this.kv, { except: me.id });
    await this.open({ id: me.id, role: me.role });
    this.qc.setQueryData(qk.me, me);
    writeStorage(KEYS.lastAccount, JSON.stringify({ id: me.id, role: me.role }));
  }

  /** No network at start: show the last account's cached data. Null when there is none (or it is too old). */
  async restoreOffline(): Promise<Me | null> {
    const last = readLast();
    if (!last || this.active) return this.active ? (this.qc.getQueryData<Me>(qk.me) ?? null) : null;
    await this.open(last);
    const me = this.qc.getQueryData<Me>(qk.me) ?? null;
    if (!me || me.id !== last.id) {
      await this.deactivate("expired");
      return null;
    }
    return me;
  }

  /**
   * logout: everything of this account leaves the browser. expired: the session ended, so cached data goes but
   * unsent messages and drafts stay for the next sign-in of the same account. switch: another account or role.
   */
  async deactivate(reason: "logout" | "expired" | "switch"): Promise<void> {
    const active = this.active ?? readLast();
    this.active = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.persister?.dispose();
    this.persister = null;
    // Cancel first: an answer on its way must not land in the next account's cache.
    await this.qc.cancelQueries();
    this.qc.getMutationCache().clear();
    this.qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "public" });
    if (active) {
      if (reason === "logout") await purgeAccounts(this.kv, { only: active.id });
      else await this.kv.del(kvKey("cache", active.id));
    }
    if (reason === "logout") writeStorage(KEYS.lastAccount, null);
  }

  /** Write pending changes now (page hidden or closing). */
  async flush(): Promise<void> {
    if (!this.persister || !this.active) return;
    await persistQueryClientSave({ ...this.options(), dehydrateOptions: { shouldDehydrateQuery: shouldPersist, shouldDehydrateMutation: () => false } });
    await this.persister.write();
  }

  private options() {
    // The role is part of the buster, so a cache written in another role is dropped on restore.
    return { queryClient: this.qc, persister: this.persister!, buster: `${this.buster}:${this.active!.role}` };
  }

  private async open(account: LastAccount): Promise<void> {
    this.active = account;
    this.persister = new KvPersister(this.kv, kvKey("cache", account.id));
    await persistQueryClientRestore({ ...this.options(), maxAge: this.maxAge }).catch(() => undefined);
    this.unsubscribe = persistQueryClientSubscribe({
      ...this.options(),
      dehydrateOptions: { shouldDehydrateQuery: shouldPersist, shouldDehydrateMutation: () => false },
    });
  }
}
