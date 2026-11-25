// Account preferences: applied to this browser at once, sent to the account in the background (merged patches),
// and taken over from the account when signing in elsewhere.

import { meApi } from "../../api/endpoints.ts";
import { ApiError } from "../../api/errors.ts";
import { jsonEqual } from "../../lib/equal.ts";
import { KEYS, readStorage, writeStorage } from "../../lib/storage.ts";
import { type Env, Store } from "./env.ts";

export type Theme = "system" | "light" | "dark";
/** Root text size in percent; index.html knows 112 and 125. */
export type TextSize = "100" | "112" | "125";
export type Density = "comfortable" | "compact";
export type Sidebar = "expanded" | "collapsed";
export interface Preferences {
  theme: Theme;
  text: TextSize;
  density: Density;
  sidebar: Sidebar;
  /** List filters by list name, e.g. filters.worklist = {bucket: "mine"}. */
  filters: Record<string, Record<string, unknown>>;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  text: "100",
  density: "comfortable",
  sidebar: "expanded",
  filters: {},
};

const oneOf = <T extends string>(v: unknown, all: readonly T[], fallback: T): T => all.find((x) => x === v) ?? fallback;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whatever the account has stored, read as preferences; unknown values fall back. */
export function parsePreferences(raw: Record<string, unknown>, base: Preferences = DEFAULT_PREFERENCES): Preferences {
  return {
    theme: oneOf(raw.theme, ["system", "light", "dark"] as const, base.theme),
    text: oneOf(raw.text, ["100", "112", "125"] as const, base.text),
    density: oneOf(raw.density, ["comfortable", "compact"] as const, base.density),
    sidebar: oneOf(raw.sidebar, ["expanded", "collapsed"] as const, base.sidebar),
    filters: isRecord(raw.filters) ? Object.fromEntries(Object.entries(raw.filters).filter((e): e is [string, Record<string, unknown>] => isRecord(e[1]))) : base.filters,
  };
}

/** What this browser remembers for visitors (and before the account answers). */
export function localPreferences(): Preferences {
  return parsePreferences({ theme: readStorage(KEYS.theme) ?? undefined, text: readStorage(KEYS.text) ?? undefined, density: readStorage(KEYS.density) ?? undefined });
}

/** Puts theme, text size and density on <html> and remembers them for the next first paint. */
export function applyPreferences(p: Preferences): void {
  writeStorage(KEYS.theme, p.theme === "system" ? null : p.theme);
  writeStorage(KEYS.text, p.text === "100" ? null : p.text);
  writeStorage(KEYS.density, p.density === "comfortable" ? null : p.density);
  if (typeof document === "undefined") return;
  const dark = p.theme === "dark" || (p.theme === "system" && typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
  const d = document.documentElement.dataset;
  d.theme = dark ? "dark" : "light";
  if (p.text === "100") delete d.text;
  else d.text = p.text;
  if (p.density === "comfortable") delete d.density;
  else d.density = p.density;
}

export interface PreferencesOptions {
  env: Env;
  save?: (patch: Record<string, unknown>, keepalive: boolean) => Promise<unknown>;
  apply?: (p: Preferences) => void;
  debounceMs?: number;
}

export class PreferencesController {
  readonly state: Store<Preferences>;
  private readonly o: PreferencesOptions;
  private accountId: string | null = null;
  private patch: Record<string, unknown> = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private offs: (() => void)[] = [];

  constructor(o: PreferencesOptions) {
    this.o = o;
    this.state = new Store(localPreferences());
  }

  start(): void {
    const { page } = this.o.env;
    this.offs = [page.on("online", () => void this.sync()), page.on("hidden", () => void this.sync(true)), page.on("pagehide", () => void this.sync(true))];
    if (typeof matchMedia === "function") {
      const mq = matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => this.apply();
      mq.addEventListener?.("change", onChange);
      this.offs.push(() => mq.removeEventListener?.("change", onChange));
    }
    this.apply();
  }
  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Signed in: the account's preferences win over this browser's, except for changes not sent yet. */
  attach(accountId: string, raw: Record<string, unknown>): void {
    if (this.accountId !== accountId) this.patch = {};
    this.accountId = accountId;
    const next = parsePreferences({ ...raw, ...this.patch }, { ...this.state.get(), filters: {} });
    if (!jsonEqual(next, this.state.get())) {
      this.state.set(next);
      this.apply();
    }
  }
  /** Signed out: the look stays as it is, the account's filters do not. */
  detach(): void {
    this.accountId = null;
    this.patch = {};
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state.patch({ filters: {} });
  }

  set(part: Partial<Preferences>): void {
    this.state.patch(part);
    this.apply();
    if (!this.accountId) return;
    Object.assign(this.patch, part);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync(), this.o.debounceMs ?? 500);
  }
  setFilter(list: string, value: Record<string, unknown> | null): void {
    const filters = { ...this.state.get().filters };
    if (value === null) delete filters[list];
    else filters[list] = value;
    this.set({ filters });
  }

  private apply(): void {
    (this.o.apply ?? applyPreferences)(this.state.get());
  }

  private async sync(keepalive = false): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.sending || !this.accountId || Object.keys(this.patch).length === 0 || !this.o.env.page.online()) return;
    const patch = this.patch;
    const account = this.accountId;
    this.patch = {};
    this.sending = true;
    try {
      await (this.o.save ?? meApi.putPreferences)(patch, keepalive);
    } catch (e) {
      if (this.accountId === account && e instanceof ApiError && e.transient) {
        this.patch = { ...patch, ...this.patch };
        this.timer ??= setTimeout(() => void this.sync(), 10_000);
      }
    } finally {
      this.sending = false;
    }
    if (this.accountId && Object.keys(this.patch).length > 0 && !this.timer) this.timer = setTimeout(() => void this.sync(), this.o.debounceMs ?? 500);
  }
}
