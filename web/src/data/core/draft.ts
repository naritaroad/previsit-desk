// One autosaved draft (a composer, a clinical note, a form). Local first: every change is written to IndexedDB
// at once and to the server after a short pause, with the revision it was based on. If the server has a newer
// revision (another device), both versions are offered instead of overwriting either.

import { meApi } from "../../api/endpoints.ts";
import { ApiError, isApiError, isStale } from "../../api/errors.ts";
import type { DraftRecord } from "../../api/types.ts";
import { jsonEqual } from "../../lib/equal.ts";
import { backoffMs, type Env, Store } from "./env.ts";
import { kvKey } from "./kv.ts";
import type { TabChannel } from "./tabs.ts";

export type DraftStatus = "idle" | "saving" | "saved" | "offline" | "conflict";
export interface DraftConflict<T> {
  mine: T;
  /** The server's version; null when it was deleted there (sent or discarded on another device). */
  theirs: T | null;
  theirsUpdatedAt: string | null;
}
export interface DraftState<T> {
  /** False until the local copy was read; show a skeleton, not an empty editor. */
  ready: boolean;
  value: T;
  status: DraftStatus;
  dirty: boolean;
  savedAt: string | null;
  conflict: DraftConflict<T> | null;
  /** A refusal that retrying will not fix (too large, no permission). */
  error: ApiError | null;
}

interface LocalDraft<T> {
  value: T;
  /** Server revision this value is based on; 0 = never on the server. */
  revision: number;
  dirty: boolean;
  savedAt: string | null;
}
type Wire<T> = { type: "edit" | "saved" | "cleared"; draft: LocalDraft<T> };

export interface DraftApi {
  get<T>(scope: string): Promise<DraftRecord<T>>;
  put<T>(scope: string, payload: T, revision: number, keepalive: boolean): Promise<DraftRecord<T>>;
  del(scope: string): Promise<void>;
}
const defaultApi: DraftApi = {
  get: (scope) => meApi.draft(scope),
  put: (scope, payload, revision, keepalive) => meApi.putDraft(scope, payload, revision, keepalive),
  del: (scope) => meApi.deleteDraft(scope),
};

export interface DraftOptions<T> {
  scope: string;
  accountId: string;
  initial: T;
  env: Env;
  api?: DraftApi;
  debounceMs?: number;
  /** Save at least this often while typing without a pause. */
  maxWaitMs?: number;
}

export class DraftController<T> {
  readonly state: Store<DraftState<T>>;
  private readonly o: DraftOptions<T>;
  private readonly api: DraftApi;
  private readonly key: string;
  private revision = 0;
  private channel: TabChannel<Wire<T>> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private firstUnsavedAt: number | null = null;
  private inFlight: Promise<void> | null = null;
  /** Bumped on every local change, so a save knows whether something changed meanwhile. */
  private version = 0;
  private attempts = 0;
  private open = false;
  private synced = false;
  private cleared = false;
  private writing: Promise<void> = Promise.resolve();
  private offs: (() => void)[] = [];

  constructor(o: DraftOptions<T>) {
    this.o = o;
    this.api = o.api ?? defaultApi;
    this.key = kvKey("draft", o.accountId, o.scope);
    this.state = new Store<DraftState<T>>({
      ready: false,
      value: o.initial,
      status: "idle",
      dirty: false,
      savedAt: null,
      conflict: null,
      error: null,
    });
  }

  start(): void {
    if (this.open) return;
    this.open = true;
    const { env } = this.o;
    this.channel = env.channel<Wire<T>>(`pv-draft:${this.o.accountId}:${this.o.scope}`);
    this.channel.onMessage((m) => this.onSibling(m));
    this.offs = [
      env.page.on("online", () => {
        this.attempts = 0;
        if (!this.synced) void this.pull();
        else if (this.state.get().dirty) void this.save();
      }),
      env.page.on("hidden", () => this.flushKeepalive()),
      env.page.on("pagehide", () => this.flushKeepalive()),
    ];
    void this.load();
  }

  /** Unmount: whatever is unsaved is in IndexedDB already; the server copy is sent on the way out. */
  stop(): void {
    if (!this.open) return;
    this.flushKeepalive();
    this.open = false;
    this.clearTimers();
    for (const off of this.offs) off();
    this.offs = [];
    this.channel?.close();
    this.channel = null;
  }

  set(next: T | ((prev: T) => T)): void {
    const s = this.state.get();
    const value = typeof next === "function" ? (next as (prev: T) => T)(s.value) : next;
    if (jsonEqual(value, s.value)) return;
    this.version += 1;
    this.cleared = false;
    this.state.patch({ value, dirty: true, error: null, conflict: s.conflict ? { ...s.conflict, mine: value } : null });
    this.store("edit");
    if (!s.conflict) this.schedule();
  }

  /** Save now; resolves when the server has the current value (or when that failed). */
  async flush(): Promise<void> {
    this.clearDebounce();
    if (this.inFlight) await this.inFlight;
    if (this.state.get().dirty && !this.state.get().conflict) await this.save();
  }

  /** The draft was used (message sent, note signed) or thrown away: remove it everywhere. */
  async clear(): Promise<void> {
    this.clearTimers();
    this.version += 1;
    this.cleared = true;
    const hadServer = this.revision > 0 || !this.synced || this.inFlight !== null;
    this.revision = 0;
    this.attempts = 0;
    this.state.patch({ value: this.o.initial, dirty: false, status: "idle", conflict: null, error: null, savedAt: null });
    await this.writing;
    await this.o.env.kv.del(this.key);
    this.channel?.post({ type: "cleared", draft: this.local() });
    if (this.inFlight) await this.inFlight;
    if (hadServer) await this.api.del(this.o.scope).catch(() => undefined); // gone or offline: the retention sweep gets it
    if (this.cleared) this.revision = 0;
  }

  /** Answer of the merge dialog. "theirs" with a deleted server draft starts over from the initial value. */
  resolve(choice: "mine" | "theirs" | { merged: T }): void {
    const { conflict } = this.state.get();
    if (!conflict) return;
    this.version += 1;
    if (choice === "theirs") {
      const value = conflict.theirs ?? this.o.initial;
      this.state.patch({ value, dirty: false, conflict: null, status: "saved", savedAt: conflict.theirsUpdatedAt });
      this.store("saved");
      return;
    }
    const value = choice === "mine" ? conflict.mine : choice.merged;
    this.state.patch({ value, dirty: true, conflict: null, status: "saving" });
    this.store("edit");
    void this.save();
  }

  get unsaved(): boolean {
    const s = this.state.get();
    return s.dirty || s.status === "conflict";
  }

  // ------------------------------------------------------------------------------------------------ local

  private local(): LocalDraft<T> {
    const s = this.state.get();
    return { value: s.value, revision: this.revision, dirty: s.dirty, savedAt: s.savedAt };
  }
  /** IndexedDB write on every change, one at a time so the last one wins. */
  private store(type: "edit" | "saved"): void {
    const draft = this.local();
    this.channel?.post({ type, draft });
    this.writing = this.writing.then(
      () => (this.cleared ? undefined : this.o.env.kv.set(this.key, draft)),
      () => undefined,
    );
  }

  private async load(): Promise<void> {
    const local = await this.o.env.kv.get<LocalDraft<T>>(this.key);
    if (!this.open) return;
    if (local && this.version === 0) {
      this.revision = local.revision;
      this.state.patch({ ready: true, value: local.value, dirty: local.dirty, savedAt: local.savedAt, status: local.dirty ? "saving" : "saved" });
    } else this.state.patch({ ready: true });
    await this.pull();
  }

  private onSibling(m: Wire<T>): void {
    if (!this.open) return;
    if (m.type === "cleared") {
      this.clearTimers();
      this.version += 1;
      this.revision = 0;
      this.state.patch({ value: this.o.initial, dirty: false, status: "idle", conflict: null, error: null, savedAt: null });
      return;
    }
    if (m.draft.revision < this.revision && m.type === "edit" && this.state.get().dirty) return;
    this.revision = Math.max(this.revision, m.draft.revision);
    this.version += 1;
    this.synced = this.synced || m.type === "saved";
    // The tab that edits does the saving; here it is only shown.
    this.clearDebounce();
    this.state.patch({
      ready: true,
      value: m.draft.value,
      dirty: m.draft.dirty,
      savedAt: m.draft.savedAt,
      status: m.draft.dirty ? "saving" : "saved",
      conflict: null,
      error: null,
    });
    // If that tab is closed before it saves, this one does.
    if (m.draft.dirty) this.debounce = setTimeout(() => void this.save(), (this.o.debounceMs ?? 800) * 6);
  }

  // ------------------------------------------------------------------------------------------------ server

  private async pull(): Promise<void> {
    const at = this.version;
    let server: DraftRecord<T> | null;
    try {
      server = await this.api.get<T>(this.o.scope);
    } catch (e) {
      if (!this.open) return;
      if (isApiError(e, "not_found")) server = null;
      else {
        this.offline(e, () => void this.pull());
        return;
      }
    }
    if (!this.open) return;
    this.synced = true;
    this.attempts = 0;
    const s = this.state.get();
    if (!server) {
      // Deleted elsewhere while nothing changed here: follow. Unsaved work is kept and saved as new.
      const had = this.revision > 0;
      this.revision = 0;
      if (s.dirty) void this.save();
      else if (had && at === this.version) {
        this.state.patch({ value: this.o.initial, status: "idle", savedAt: null });
        void this.o.env.kv.del(this.key);
      } else this.state.patch({ status: "idle" });
      return;
    }
    if (!s.dirty) {
      this.revision = server.revision;
      this.state.patch({ value: server.payload, status: "saved", savedAt: server.updated_at });
      this.store("saved");
    } else if (server.revision === this.revision) void this.save();
    else if (jsonEqual(server.payload, s.value)) this.adopt(server);
    else this.conflictWith(server);
  }

  private schedule(): void {
    const now = this.o.env.now();
    this.firstUnsavedAt ??= now;
    const wait = Math.min(this.o.debounceMs ?? 800, Math.max(0, this.firstUnsavedAt + (this.o.maxWaitMs ?? 5000) - now));
    this.clearDebounce();
    this.debounce = setTimeout(() => void this.save(), wait);
  }

  private async save(): Promise<void> {
    this.clearDebounce();
    if (this.inFlight || !this.open) return;
    const s = this.state.get();
    if (!s.dirty || s.conflict || s.error) return;
    if (!this.synced) return; // pull() decides first whether this would overwrite something
    if (!this.o.env.page.online()) {
      this.state.patch({ status: "offline" });
      return;
    }
    const version = this.version;
    const base = this.revision;
    this.firstUnsavedAt = null;
    this.state.patch({ status: "saving" });
    const run = (async () => {
      try {
        const saved = await this.api.put(this.o.scope, s.value, base, false);
        this.attempts = 0;
        if (this.cleared) return;
        this.revision = Math.max(this.revision, saved.revision);
        if (this.version === version) this.state.patch({ dirty: false, status: "saved", savedAt: saved.updated_at });
        else this.state.patch({ savedAt: saved.updated_at });
        this.store("saved");
      } catch (e) {
        if (this.cleared || !this.open) return;
        this.onSaveError(e, base);
      }
    })();
    this.inFlight = run;
    await run;
    this.inFlight = null;
    const after = this.state.get();
    if (this.open && !this.cleared && after.dirty && !after.conflict && !after.error && after.status !== "offline" && !this.retryTimer)
      this.schedule();
  }

  private onSaveError(e: unknown, base: number): void {
    if (isStale(e)) {
      const current = e.current as DraftRecord<T> | null;
      const s = this.state.get();
      if (!current) {
        // Deleted on another device (it was sent or discarded there): ask instead of bringing it back.
        this.revision = 0;
        this.state.patch({ status: "conflict", conflict: { mine: s.value, theirs: null, theirsUpdatedAt: null } });
      } else if (jsonEqual(current.payload, s.value)) this.adopt(current);
      else if (this.revision > base && current.revision <= this.revision) void 0; // a sibling tab saved meanwhile; save again on top
      else this.conflictWith(current);
      return;
    }
    if (e instanceof ApiError && !e.transient && e.code !== "unauthorized" && e.code !== "conflict") {
      this.state.patch({ status: "offline", error: e });
      return;
    }
    this.offline(e, () => void this.save());
  }

  private adopt(server: DraftRecord<T>): void {
    this.revision = server.revision;
    this.state.patch({ dirty: false, status: "saved", savedAt: server.updated_at, conflict: null });
    this.store("saved");
  }

  private conflictWith(server: DraftRecord<T>): void {
    this.revision = server.revision;
    this.clearTimers();
    this.state.patch({
      status: "conflict",
      conflict: { mine: this.state.get().value, theirs: server.payload, theirsUpdatedAt: server.updated_at },
    });
  }

  private offline(e: unknown, retry: () => void): void {
    this.state.patch({ status: this.state.get().dirty ? "offline" : this.state.get().status });
    if (this.retryTimer || !this.o.env.page.online()) return; // the online event retries
    const wait = isApiError(e) && e.retryAfter ? e.retryAfter * 1000 : backoffMs(this.attempts, this.o.env.random(), 1500, 30_000);
    this.attempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.open) retry();
    }, wait);
  }

  /** The page is going away: a normal request would be cancelled, a keepalive one is delivered. */
  private flushKeepalive(): void {
    const s = this.state.get();
    if (!this.open || !s.dirty || s.conflict || s.error || !this.synced || this.inFlight || !this.o.env.page.online()) return;
    this.clearDebounce();
    const version = this.version;
    const run = this.api
      .put(this.o.scope, s.value, this.revision, true)
      .then((saved) => {
        if (this.cleared) return;
        this.revision = Math.max(this.revision, saved.revision);
        if (this.version === version) this.state.patch({ dirty: false, status: "saved", savedAt: saved.updated_at });
        this.store("saved");
      })
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = null;
        if (this.open && this.state.get().dirty) this.schedule();
      });
    this.inFlight = run;
  }

  private clearDebounce(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }
  private clearTimers(): void {
    this.clearDebounce();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.firstUnsavedAt = null;
  }
}
