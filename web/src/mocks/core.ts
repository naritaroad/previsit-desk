// The mock server's frame: errors, router, sessions, idempotency, server-sent events and live fan-out between
// tabs. Endpoints are in routes/*.ts; they work on plain records and return plain values.

import type { ErrorBody, Locale, Permission, PersonRef, ServerErrorCode } from "../api/types.ts";
import { uuid } from "../lib/ids.ts";
import { ROLE_PERMISSIONS } from "../lib/permissions.ts";
import { defaultConfig, type MockConfig } from "./config.ts";
import { type AccountRec, type Db, DbFile, type SessionRec, type TextStorage } from "./db.ts";
import { L } from "./rules.ts";
import { seedDb } from "./seed/index.ts";

// ------------------------------------------------------------------------------------------------ errors

const STATUS: Record<ServerErrorCode, number> = {
  invalid_request: 422,
  unauthorized: 401,
  invalid_credentials: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  visit_closed: 409,
  invalid_state: 409,
  rate_limited: 429,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal: 500,
};
const MESSAGES: Record<ServerErrorCode, [string, string]> = {
  invalid_request: ["送出的內容不正確，請檢查後再試。", "The request is not valid. Check it and send it again."],
  unauthorized: ["請先登入。", "Please sign in."],
  invalid_credentials: ["帳號或密碼不正確。", "Wrong username or password."],
  forbidden: ["這個帳號沒有權限。", "This account has no permission."],
  not_found: ["找不到這筆資料。", "Not found."],
  conflict: ["這筆資料剛更新過。", "This was just updated."],
  visit_closed: ["這次預問診已送出，不能再補充。", "This previsit has been sent."],
  invalid_state: ["目前的狀態不能做這個動作。", "That is not possible in the current state."],
  rate_limited: ["操作太頻繁，請稍候再試。", "Too many requests. Try again later."],
  payload_too_large: ["內容太長。", "Too long."],
  unsupported_media_type: ["只接受 JSON。", "JSON only."],
  internal: ["系統發生問題。", "Something went wrong."],
};

export class MockError extends Error {
  readonly code: ServerErrorCode;
  readonly fields: Record<string, string> | undefined;
  readonly current: unknown;
  readonly retryAfter: number | undefined;
  constructor(code: ServerErrorCode, o: { fields?: Record<string, string>; current?: unknown; retryAfter?: number } = {}) {
    super(code);
    this.code = code;
    this.fields = o.fields;
    this.current = o.current;
    this.retryAfter = o.retryAfter;
  }
  toResponse(locale: Locale): Response {
    const [zh, en] = MESSAGES[this.code];
    const error: ErrorBody["error"] = { code: this.code, message: L(locale, zh, en) };
    if (this.fields) error.fields = this.fields;
    if (this.current !== undefined) error.current = this.current;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.retryAfter) headers["Retry-After"] = String(this.retryAfter);
    return new Response(JSON.stringify({ error }), { status: STATUS[this.code], headers });
  }
}
export const fail = (code: ServerErrorCode, o?: ConstructorParameters<typeof MockError>[1]): never => {
  throw new MockError(code, o);
};
export const badField = (field: string, message: string): never => fail("invalid_request", { fields: { [field]: message } });
export function must<T>(value: T | null | undefined): T {
  return value ?? fail("not_found");
}

// ------------------------------------------------------------------------------------------------ live

/** What goes over a stream. `to` picks the listeners. */
export interface LiveEvent {
  to: { visit: string } | { account: string } | { permission: Permission };
  seq: number | null;
  type: string;
  data: unknown;
}
type LiveListener = (e: LiveEvent) => void;

export class Live {
  private readonly listeners = new Set<LiveListener>();
  private readonly bc: BroadcastChannel | null;
  constructor(shared: boolean) {
    this.bc = shared && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("pv-mock-live") : null;
    if (this.bc) {
      this.bc.onmessage = (e: MessageEvent<LiveEvent>) => this.deliver(e.data);
      (this.bc as { unref?: () => void }).unref?.();
    }
  }
  publish(e: LiveEvent): void {
    this.deliver(e);
    this.bc?.postMessage(e);
  }
  listen(l: LiveListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private deliver(e: LiveEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
  close(): void {
    this.bc?.close();
    this.listeners.clear();
  }
}

// ------------------------------------------------------------------------------------------------ server

export interface Ctx {
  server: MockServer;
  db: Db;
  req: Request;
  url: URL;
  params: Record<string, string>;
  /** Parsed JSON body ({} when there is none). */
  body: Record<string, unknown>;
  /** Null on public endpoints without a session. */
  account: AccountRec | null;
  session: SessionRec | null;
  locale: Locale;
  now: string;
  q(name: string): string | null;
}
/** Ctx with a signed-in account. */
export interface UserCtx extends Ctx {
  account: AccountRec;
  session: SessionRec;
}

export interface Reply {
  status: number;
  body: unknown;
}
type Result = Reply | Response;
export const ok = (body: unknown): Reply => ({ status: 200, body });
export const created = (body: unknown): Reply => ({ status: 201, body });
export const DONE: Reply = { status: 200, body: { ok: true } };

export interface Route {
  method: string;
  path: string;
  handle: (c: Ctx) => Result | Promise<Result>;
}
/** Signed-in endpoint; `needs` are permissions of which one is enough. */
export function route(spec: string, needs: readonly Permission[] | "any", handle: (c: UserCtx) => Result | Promise<Result>): Route {
  const [method, path] = spec.split(" ");
  return {
    method,
    path,
    handle: (c) => {
      if (!c.account || !c.session) return fail("unauthorized");
      if (needs !== "any" && !needs.some((p) => can(c.account!, p))) return fail("forbidden");
      return handle(c as UserCtx);
    },
  };
}
export function open(spec: string, handle: (c: Ctx) => Result | Promise<Result>): Route {
  const [method, path] = spec.split(" ");
  return { method, path, handle };
}

export function can(a: AccountRec, p: Permission): boolean {
  return ROLE_PERMISSIONS[a.role].includes(p);
}

export function person(db: Db, id: string | null, locale: Locale): PersonRef | null {
  const a = id ? db.accounts.find((x) => x.id === id) : undefined;
  return a ? { id: a.id, display_name: L(locale, a.display_name, a.display_name_en), role: a.role, title: a.title && L(locale, a.title, a.title_en ?? a.title), avatar: a.avatar } : null;
}
export function personOr(db: Db, id: string | null, locale: Locale): PersonRef {
  return person(db, id, locale) ?? { id: id ?? "", display_name: L(locale, "已刪除的帳號", "Deleted account"), role: "patient", title: null, avatar: null };
}

/** Cursor pages over an already sorted array; the cursor is an offset. */
export function page<T>(c: Ctx, items: T[], extra: Record<string, unknown> = {}): Reply {
  const list = c.server.config.empty ? [] : items;
  const limit = Math.min(100, Math.max(1, Number(c.q("limit")) || 30));
  const from = Number(c.q("cursor")) || 0;
  const next = from + limit < list.length ? String(from + limit) : null;
  return ok({ items: list.slice(from, from + limit), next_cursor: next, total: list.length, ...extra });
}

/** Optimistic lock: the body must carry the current revision. */
export function checkRevision(c: Ctx, current: number, view: () => unknown): void {
  if (c.body.revision !== current) fail("conflict", { current: view() });
}

export interface MockServerOptions {
  storage: TextStorage;
  config?: Partial<MockConfig>;
  /** Share live events with other tabs. */
  shared?: boolean;
  routes: Route[];
}

const SESSION_KEY = "pv-mock:session";

export class MockServer {
  readonly config: MockConfig;
  readonly file: DbFile;
  readonly live: Live;
  readonly storage: TextStorage;
  readonly routes: readonly Route[];
  private readonly streams = new Set<() => void>();
  /** Called after every write (the turn runner looks for due work). */
  onWrite: () => void = () => undefined;
  /** Requests seen, for tests. */
  readonly seen: string[] = [];

  constructor(o: MockServerOptions) {
    this.config = { ...defaultConfig(), ...o.config };
    this.storage = o.storage;
    this.routes = o.routes;
    this.file = new DbFile(o.storage, () => seedDb());
    this.live = new Live(o.shared ?? false);
  }

  get db(): Db {
    return this.file.get();
  }
  now(): string {
    return new Date().toISOString();
  }

  // ---------------------------------------------------------------------------------------- sessions

  currentToken(): string | null {
    return this.storage.getItem(SESSION_KEY);
  }
  signIn(account: AccountRec, device = "Windows · Chrome"): void {
    const db = this.db;
    const token = uuid();
    db.sessions.push({ token, id: uuid(), account_id: account.id, device, created_at: this.now(), last_seen_at: this.now() });
    account.last_login_at = this.now();
    this.storage.setItem(SESSION_KEY, token);
    this.file.save();
  }
  signOut(): void {
    const token = this.currentToken();
    const db = this.db;
    db.sessions = db.sessions.filter((s) => s.token !== token);
    this.storage.removeItem(SESSION_KEY);
    this.file.save();
  }
  loginAs(username: string): boolean {
    const a = this.db.accounts.find((x) => x.username === username);
    if (!a) return false;
    this.signIn(a);
    return true;
  }

  // ---------------------------------------------------------------------------------------- requests

  /** Null when the URL is not one of the API's. */
  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url, "http://mock");
    const at = url.pathname.indexOf("/api/v2");
    const path = at === -1 ? (url.pathname.endsWith("/api/v1/health") ? "/health" : null) : url.pathname.slice(at + "/api/v2".length) || "/";
    if (path === null) return null;
    const { config } = this;
    this.seen.push(`${req.method} ${path}`);
    if (config.log) console.info(`[mock] ${req.method} ${path}${url.search}`);
    if (config.latency > 0) await sleep(config.latency * (0.5 + Math.random()), req.signal);
    if (config.offline) throw new TypeError("Failed to fetch");

    const db = this.db;
    const token = this.currentToken();
    const session = db.sessions.find((s) => s.token === token) ?? null;
    const account = session ? (db.accounts.find((a) => a.id === session.account_id && a.status === "active") ?? null) : null;
    const locale: Locale = account?.locale ?? (req.headers.get("Accept-Language")?.toLowerCase().startsWith("en") ? "en" : "zh-TW");
    const matched = this.match(req.method, path);
    try {
      if (!matched) return new MockError("not_found").toResponse(locale);
      const writes = req.method !== "GET";
      const body = writes ? await readBody(req) : {};
      const injected = writes && !path.startsWith("/auth/") && !path.startsWith("/me/preferences") ? this.injectFailure(body) : null;
      if (injected) throw injected;
      if (session) session.last_seen_at = this.now();
      if (account?.must_change_password && !/^\/(auth\/.*|me|me\/preferences|health|meta|trust\/facts|handbook.*)$/.test(path)) throw new MockError("forbidden");
      const c: Ctx = {
        server: this,
        db,
        req,
        url,
        params: matched.params,
        body,
        account,
        session,
        locale,
        now: this.now(),
        q: (name) => url.searchParams.get(name),
      };
      const key = writes ? req.headers.get("Idempotency-Key") : null;
      const idem = key && account ? `${account.id}|${key}` : null;
      if (idem && db.idem[idem]) return json(db.idem[idem].status, db.idem[idem].body);
      const result = await matched.route.handle(c);
      if (result instanceof Response) return result;
      if (idem) db.idem[idem] = result;
      if (writes) {
        this.file.save();
        this.onWrite();
      }
      return json(result.status, result.body);
    } catch (e) {
      if (e instanceof MockError) return e.toResponse(locale);
      console.error("[mock]", req.method, path, e);
      return new MockError("internal").toResponse(locale);
    }
  }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = path.split("/");
    let best: { route: Route; params: Record<string, string>; fixed: number } | null = null;
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const pattern = r.path.split("/");
      if (pattern.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let fixed = 0;
      const hit = pattern.every((p, i) => {
        if (p.startsWith(":")) {
          params[p.slice(1)] = decodeURIComponent(parts[i]);
          return parts[i] !== "";
        }
        fixed += 1;
        return p === parts[i];
      });
      // "/appointments/slots" wins over "/appointments/:id".
      if (hit && (!best || fixed > best.fixed)) best = { route: r, params, fixed };
    }
    return best;
  }

  /** ?mock=409 and friends. A 409 with a revision in the body becomes a real stale-revision conflict. */
  private injectFailure(body: Record<string, unknown>): MockError | null {
    const f = this.config.fail;
    if (!f || f.left <= 0) return null;
    f.left -= 1;
    if (f.left <= 0) this.config.fail = null;
    if (f.status === 409) {
      if (typeof body.revision === "number") {
        body.revision = -1;
        return null;
      }
      return new MockError("conflict");
    }
    if (f.status === 429) return new MockError("rate_limited", { retryAfter: 5 });
    if (f.status === 422) return new MockError("invalid_request", { fields: { body: "mock" } });
    if (f.status === 403) return new MockError("forbidden");
    if (f.status === 401) {
      this.signOut();
      return new MockError("unauthorized");
    }
    return new MockError("internal");
  }

  // ---------------------------------------------------------------------------------------- streams

  /** text/event-stream: replay, then live events until the client goes away. */
  sse(c: Ctx, replay: { seq: number; type: string; data: unknown }[], filter: (e: LiveEvent) => boolean): Response {
    const encoder = new TextEncoder();
    const frame = (seq: number | null, type: string, data: unknown) =>
      encoder.encode(`event: ${type}\n${seq === null ? "" : `id: ${seq}\n`}data: ${JSON.stringify({ v: 1, ...(seq === null ? {} : { seq }), type, data })}\n\n`);
    let stop: () => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        const off = this.live.listen((e) => {
          if (!closed && filter(e)) controller.enqueue(frame(e.seq, e.type, e.data));
        });
        const keepAlive = setInterval(() => !closed && controller.enqueue(encoder.encode(": keep-alive\n\n")), 15_000);
        const dropTimer = this.config.drop ? setTimeout(() => stop(), 6000 + Math.random() * 6000) : null;
        stop = () => {
          if (closed) return;
          closed = true;
          off();
          clearInterval(keepAlive);
          if (dropTimer) clearTimeout(dropTimer);
          this.streams.delete(stop);
          try {
            controller.close();
          } catch {
            /* already cancelled by the reader */
          }
        };
        this.streams.add(stop);
        c.req.signal?.addEventListener("abort", () => stop(), { once: true });
        controller.enqueue(encoder.encode(": open\n\n"));
        for (const e of replay) controller.enqueue(frame(e.seq, e.type, e.data));
      },
      cancel: () => stop(),
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
  }
  /** Cut every open stream (offline toggle, __mock.drop()). */
  closeStreams(): void {
    for (const stop of [...this.streams]) stop();
  }
  get openStreams(): number {
    return this.streams.size;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.trim() === "") return {};
  if (!req.headers.get("Content-Type")?.includes("json")) fail("unsupported_media_type");
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : fail("invalid_request");
  } catch {
    return fail("invalid_request");
  }
}
export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}
