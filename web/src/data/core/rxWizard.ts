// The refill / renewal wizard. The server draft (rx_requests.status = draft or more_info) is the source of
// truth; changes are merged on top, kept in IndexedDB until accepted, and sent with the revision they are based
// on. Opening the same request anywhere continues at the stored step.

import { rxApi } from "../../api/endpoints.ts";
import { ApiError, isApiError, isStale } from "../../api/errors.ts";
import type { MonitoringValue, Pharmacy, PickupWindow, RxPatch, RxRequest } from "../../api/types.ts";
import { jsonEqual } from "../../lib/equal.ts";
import { isEditableRx, missingForSubmit, type Incomplete, type RxStep } from "../../lib/rx.ts";
import { backoffMs, type Env, Store } from "./env.ts";
import { kvKey } from "./kv.ts";
import type { TabChannel } from "./tabs.ts";

export type SaveStatus = "idle" | "saving" | "saved" | "offline" | "conflict";
/** What is not on the server yet. null in answers or monitoring means "cleared". */
export interface PendingPatch {
  step?: string;
  answers?: Record<string, unknown>;
  monitoring?: Record<string, MonitoringValue | null>;
  pharmacy?: Pharmacy | null;
  pickup_window?: PickupWindow | null;
}
export interface WizardConflict {
  /** Keys changed on both sides, e.g. "answers.side_effects" or "pharmacy". */
  keys: string[];
  mine: PendingPatch;
  theirs: RxRequest;
}
export interface WizardState {
  phase: "loading" | "ready" | "error";
  error: ApiError | null;
  /** The server's request with unsaved changes applied; what the steps render. */
  rx: RxRequest | null;
  status: SaveStatus;
  savedAt: string | null;
  conflict: WizardConflict | null;
  /** Field messages of the last refused save or submit. */
  fields: Readonly<Record<string, string>>;
  submitting: boolean;
  evaluating: boolean;
}

interface StoredPending {
  base: RxRequest;
  patch: PendingPatch;
}
type Wire = { type: "server"; rx: RxRequest };

export interface WizardOptions {
  id: string;
  accountId: string;
  env: Env;
  api?: Pick<typeof rxApi, "get" | "patch" | "evaluate" | "submit" | "cancel" | "reply">;
  debounceMs?: number;
  /** Tell the query cache about every server version. */
  onServer?: (rx: RxRequest) => void;
}

const dropNull = <V>(o: Record<string, V | null>): Record<string, V> =>
  Object.fromEntries(Object.entries(o).filter((e): e is [string, V] => e[1] !== null));

/** The request as it looks with the patch applied. */
export function applyPending(rx: RxRequest, p: PendingPatch): RxRequest {
  return {
    ...rx,
    step: p.step ?? rx.step,
    answers: p.answers ? dropNull({ ...rx.answers, ...p.answers }) : rx.answers,
    monitoring: p.monitoring ? dropNull<MonitoringValue>({ ...rx.monitoring, ...p.monitoring }) : rx.monitoring,
    pharmacy: p.pharmacy === undefined ? rx.pharmacy : p.pharmacy,
    pickup_window: p.pickup_window === undefined ? rx.pickup_window : p.pickup_window,
  };
}

/** The request body: whole answers and monitoring objects, so merging and replacing servers agree. */
export function toBody(rx: RxRequest, p: PendingPatch): RxPatch {
  const body: RxPatch = {};
  if (p.step !== undefined) body.step = p.step;
  if (p.answers) body.answers = { ...rx.answers, ...p.answers };
  if (p.monitoring) body.monitoring = { ...rx.monitoring, ...p.monitoring } as Record<string, MonitoringValue>;
  if (p.pharmacy !== undefined) body.pharmacy_id = p.pharmacy?.id ?? null;
  if (p.pickup_window !== undefined) body.pickup_window = p.pickup_window;
  return body;
}

const isEmpty = (p: PendingPatch) => Object.keys(p).length === 0;

function merge(a: PendingPatch, b: PendingPatch): PendingPatch {
  const out: PendingPatch = { ...a, ...b };
  if (a.answers || b.answers) out.answers = { ...a.answers, ...b.answers };
  if (a.monitoring || b.monitoring) out.monitoring = { ...a.monitoring, ...b.monitoring };
  return out;
}

/** Keys the patch changes that the server also changed since `base` (to something else than the patch's value). */
export function conflictKeys(base: RxRequest, theirs: RxRequest, p: PendingPatch): string[] {
  const keys: string[] = [];
  const check = (name: string, b: unknown, t: unknown, m: unknown) => {
    const gone = (v: unknown) => v ?? null;
    if (!jsonEqual(gone(b), gone(t)) && !jsonEqual(gone(t), gone(m))) keys.push(name);
  };
  for (const [k, v] of Object.entries(p.answers ?? {})) check(`answers.${k}`, base.answers[k], theirs.answers[k], v);
  for (const [k, v] of Object.entries(p.monitoring ?? {})) check(`monitoring.${k}`, base.monitoring[k], theirs.monitoring[k], v);
  if (p.pharmacy !== undefined) check("pharmacy", base.pharmacy?.id, theirs.pharmacy?.id, p.pharmacy?.id);
  if (p.pickup_window !== undefined) check("pickup_window", base.pickup_window, theirs.pickup_window, p.pickup_window);
  return keys; // the step is only a bookmark: the latest click wins
}

export class RxWizard {
  readonly state = new Store<WizardState>({
    phase: "loading",
    error: null,
    rx: null,
    status: "idle",
    savedAt: null,
    conflict: null,
    fields: {},
    submitting: false,
    evaluating: false,
  });
  private readonly o: WizardOptions;
  private readonly api: NonNullable<WizardOptions["api"]>;
  private readonly key: string;
  private server: RxRequest | null = null;
  private pending: PendingPatch = {};
  private sending: PendingPatch | null = null;
  private inFlight: Promise<void> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private open = false;
  private channel: TabChannel<Wire> | null = null;
  private offs: (() => void)[] = [];

  constructor(o: WizardOptions) {
    this.o = o;
    this.api = o.api ?? rxApi;
    this.key = kvKey("rx", o.accountId, o.id);
  }

  start(): void {
    if (this.open) return;
    this.open = true;
    const { env } = this.o;
    this.channel = env.channel<Wire>(`pv-rx:${this.o.accountId}:${this.o.id}`);
    this.channel.onMessage((m) => {
      if (m.type === "server" && this.server && m.rx.revision > this.server.revision) this.onServer(m.rx, false);
    });
    this.offs = [
      env.page.on("online", () => {
        this.attempts = 0;
        if (this.state.get().phase === "ready") void this.save();
        else void this.load();
      }),
      env.page.on("visible", () => void this.refresh()),
      env.page.on("hidden", () => this.flushKeepalive()),
      env.page.on("pagehide", () => this.flushKeepalive()),
    ];
    void this.load();
  }

  stop(): void {
    if (!this.open) return;
    this.flushKeepalive();
    this.open = false;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.debounce = null;
    this.retryTimer = null;
    for (const off of this.offs) off();
    this.offs = [];
    this.channel?.close();
    this.channel = null;
  }

  // ---------------------------------------------------------------------------------------------- editing

  goTo(step: RxStep): void {
    this.edit({ step });
  }
  /** undefined clears the answer. */
  setAnswer(id: string, value: unknown): void {
    this.edit({ answers: { [id]: value ?? null } });
  }
  setAnswers(values: Record<string, unknown>): void {
    this.edit({ answers: values });
  }
  setMonitoring(id: string, value: MonitoringValue | null): void {
    this.edit({ monitoring: { [id]: value } });
  }
  setPharmacy(pharmacy: Pharmacy | null): void {
    this.edit({ pharmacy });
  }
  setPickupWindow(pickup_window: PickupWindow | null): void {
    this.edit({ pickup_window });
  }

  missing(today: string): Incomplete[] {
    const { rx } = this.state.get();
    return rx ? missingForSubmit(rx, today) : [];
  }

  get unsaved(): boolean {
    return !isEmpty(this.pending) || this.sending !== null;
  }

  // ---------------------------------------------------------------------------------------------- actions

  /** Save now; true when the server has everything. */
  async flush(): Promise<boolean> {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    if (this.inFlight) await this.inFlight;
    if (!isEmpty(this.pending)) await this.save();
    return !this.unsaved && !this.state.get().conflict;
  }

  /** Preview of the engine; nothing is sent to the clinic. */
  async evaluate(): Promise<RxRequest | null> {
    if (!(await this.flush()) || !this.server) return null;
    this.state.patch({ evaluating: true, fields: {}, error: null });
    try {
      const rx = await this.api.evaluate(this.o.id);
      this.onServer(rx);
      return rx;
    } catch (e) {
      this.actionError(e);
      throw e;
    } finally {
      this.state.patch({ evaluating: false });
    }
  }

  async submit(consentVersion: string, idempotencyKey?: string): Promise<RxRequest | null> {
    return this.action(() => this.api.submit(this.o.id, this.server!.revision, consentVersion, idempotencyKey));
  }
  async cancel(): Promise<RxRequest | null> {
    return this.action(() => this.api.cancel(this.o.id, this.server!.revision));
  }
  /** Answer a more_info question; changed answers go with it. */
  async reply(body: string): Promise<RxRequest | null> {
    return this.action(() => this.api.reply(this.o.id, { revision: this.server!.revision, body, answers: this.server!.answers }));
  }

  private async action(run: () => Promise<RxRequest>): Promise<RxRequest | null> {
    if (!(await this.flush()) || !this.server) return null;
    this.state.patch({ submitting: true, fields: {}, error: null });
    try {
      const rx = await run();
      this.onServer(rx);
      await this.o.env.kv.del(this.key);
      return rx;
    } catch (e) {
      this.actionError(e);
      throw e;
    } finally {
      this.state.patch({ submitting: false });
    }
  }

  private actionError(e: unknown): void {
    if (isStale(e) && e.current) this.onServer(e.current as RxRequest);
    if (e instanceof ApiError) this.state.patch({ fields: e.fields });
  }

  /** Answer of the merge dialog for the conflicting keys; the other changes are kept either way. */
  resolve(choice: "mine" | "theirs"): void {
    const { conflict } = this.state.get();
    if (!conflict) return;
    if (choice === "theirs") {
      const p = structuredClone(this.pending);
      for (const key of conflict.keys) {
        const [group, ...rest] = key.split(".");
        const name = rest.join(".");
        if (group === "answers" && p.answers) delete p.answers[name];
        else if (group === "monitoring" && p.monitoring) delete p.monitoring[name];
        else if (group === "pharmacy") delete p.pharmacy;
        else if (group === "pickup_window") delete p.pickup_window;
      }
      if (p.answers && Object.keys(p.answers).length === 0) delete p.answers;
      if (p.monitoring && Object.keys(p.monitoring).length === 0) delete p.monitoring;
      this.pending = p;
    }
    this.state.patch({ conflict: null, status: isEmpty(this.pending) ? "saved" : "saving" });
    this.render();
    void this.persist();
    void this.save();
  }

  // ---------------------------------------------------------------------------------------------- sync

  private edit(patch: PendingPatch): void {
    if (!this.server || !isEditableRx(this.server.status)) return;
    this.pending = merge(this.pending, patch);
    this.state.patch({ fields: {} });
    this.render();
    void this.persist();
    if (this.state.get().conflict) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.save();
    }, this.o.debounceMs ?? 600);
  }

  private render(): void {
    if (!this.server) return;
    const unsent = merge(this.sending ?? {}, this.pending);
    this.state.patch({ rx: applyPending(this.server, unsent) });
  }

  private async persist(): Promise<void> {
    const unsent = merge(this.sending ?? {}, this.pending);
    if (isEmpty(unsent) || !this.server) await this.o.env.kv.del(this.key);
    else await this.o.env.kv.set<StoredPending>(this.key, { base: this.server, patch: unsent });
  }

  private async load(): Promise<void> {
    const stored = await this.o.env.kv.get<StoredPending>(this.key);
    try {
      const rx = await this.api.get(this.o.id);
      if (!this.open) return;
      if (stored && isEditableRx(rx.status)) {
        this.server = stored.base;
        this.pending = merge(stored.patch, this.pending);
      } else if (stored) await this.o.env.kv.del(this.key);
      this.onServer(rx);
      if (!isEmpty(this.pending) && !this.state.get().conflict) void this.save();
    } catch (e) {
      if (!this.open) return;
      if (isApiError(e) && e.transient && stored) {
        // Offline with unsent work: keep going on the last version this browser saw.
        this.server = stored.base;
        this.pending = merge(stored.patch, this.pending);
        this.state.patch({ phase: "ready", status: "offline" });
        this.render();
      } else this.state.patch({ phase: "error", error: e instanceof ApiError ? e : new ApiError({ status: 0, code: "internal" }) });
      if (isApiError(e) && e.transient) this.later(() => void this.load());
    }
  }

  /** Coming back to the page: another device may have moved on. */
  private async refresh(): Promise<void> {
    if (!this.server || this.inFlight || this.state.get().submitting) return;
    try {
      const rx = await this.api.get(this.o.id);
      if (this.open && this.server && rx.revision >= this.server.revision) this.onServer(rx);
    } catch {
      /* the next save reports problems */
    }
  }

  /** A server version arrived: rebase what is unsent, or ask when the same keys changed on both sides. */
  private onServer(rx: RxRequest, broadcast = true): void {
    const base = this.server;
    const mine = merge(this.sending ?? {}, this.pending);
    const keys = base && rx.revision > base.revision && !isEmpty(mine) ? conflictKeys(base, rx, mine) : [];
    this.server = rx;
    if (!isEditableRx(rx.status)) {
      this.pending = {};
      this.sending = null;
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = null;
    }
    this.state.patch({ phase: "ready", error: null });
    if (keys.length) this.state.patch({ status: "conflict", conflict: { keys, mine, theirs: rx } });
    else if (!isEmpty(this.pending)) this.state.patch({ conflict: null });
    else this.state.patch({ conflict: null, status: this.state.get().status === "idle" ? "idle" : "saved", savedAt: rx.updated_at });
    this.render();
    this.o.onServer?.(rx);
    if (broadcast) this.channel?.post({ type: "server", rx });
  }

  private async save(): Promise<void> {
    if (this.inFlight || isEmpty(this.pending) || !this.server || !this.open) return;
    if (this.state.get().conflict) return;
    if (!this.o.env.page.online()) {
      this.state.patch({ status: "offline" });
      return;
    }
    const patch = this.pending;
    const base = this.server;
    this.sending = patch;
    this.pending = {};
    this.state.patch({ status: "saving" });
    const run = (async () => {
      try {
        const rx = await this.api.patch(this.o.id, base.revision, toBody(base, patch));
        this.sending = null;
        this.attempts = 0;
        this.state.patch({ status: "saved" });
        this.onServer(rx);
      } catch (e) {
        this.sending = null;
        this.pending = merge(patch, this.pending);
        if (isStale(e) && e.current) {
          this.onServer(e.current as RxRequest); // rebased: saved again below, or a conflict to resolve
        } else if (e instanceof ApiError && !e.transient && e.code !== "unauthorized" && e.code !== "conflict") {
          this.state.patch({ status: "offline", error: e, fields: e.fields });
        } else {
          this.state.patch({ status: "offline" });
          this.later(() => void this.save());
        }
      }
      await this.persist();
    })();
    this.inFlight = run;
    await run;
    this.inFlight = null;
    const s = this.state.get();
    if (this.open && !isEmpty(this.pending) && !s.conflict && !s.error && s.status !== "offline" && !this.debounce) await this.save();
  }

  private later(retry: () => void): void {
    if (this.retryTimer || !this.o.env.page.online()) return;
    const wait = backoffMs(this.attempts, this.o.env.random(), 1500, 30_000);
    this.attempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.open) retry();
    }, wait);
  }

  private flushKeepalive(): void {
    if (!this.open || isEmpty(this.pending) || !this.server || this.inFlight || this.state.get().conflict) return;
    if (!this.o.env.page.online()) return;
    const patch = this.pending;
    const base = this.server;
    this.pending = {};
    this.sending = patch;
    const run = this.api
      .patch(this.o.id, base.revision, toBody(base, patch), true)
      .then((rx) => {
        this.sending = null;
        this.onServer(rx);
      })
      .catch(() => {
        this.sending = null;
        this.pending = merge(patch, this.pending);
      })
      .then(() => this.persist())
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = run;
  }
}
