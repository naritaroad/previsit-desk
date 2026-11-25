// fetch wrapper: same origin, JSON, cookie session, typed errors. Pages never call this directly; they use
// src/data hooks, which use src/api/endpoints.ts.

import { ApiError, isAbort, toApiError } from "./errors.ts";
import type { Locale } from "./types.ts";

let base = "/api/v2";
let acceptLanguage: Locale = "zh-TW";
type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Tests and non-browser callers point this at an absolute URL. */
export function setApiBase(url: string): void {
  base = url.replace(/\/$/, "");
}
export function apiBase(): string {
  return base;
}
/** Language of error messages before the account's locale is known (Accept-Language). */
export function setApiLanguage(locale: Locale): void {
  acceptLanguage = locale;
}
/** Called on every 401 `unauthorized` (an expired or revoked session), not for wrong passwords. */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Idempotency-Key for create requests; one per user intent, kept across retries. */
  idempotencyKey?: string;
  /** Survives the page being closed (used to flush drafts). Browsers refuse bodies over 64 KB. */
  keepalive?: boolean;
  cache?: RequestCache;
  /** Do not tell the 401 listeners (the very first GET /auth/me of a visitor). */
  quiet401?: boolean;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** The raw request. Network failures become ApiError('offline'); aborts pass through. */
export async function request(method: Method, path: string, o: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language": acceptLanguage,
    ...o.headers,
  };
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  if (o.idempotencyKey) headers["Idempotency-Key"] = o.idempotencyKey;
  try {
    return await fetch(`${base}${path}`, {
      method,
      credentials: "same-origin",
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal: o.signal,
      keepalive: o.keepalive,
      cache: o.cache,
    });
  } catch (e) {
    if (isAbort(e) || o.signal?.aborted) throw e;
    throw new ApiError({ status: 0, code: "offline", message: "network" });
  }
}

export async function responseOrThrow(res: Response, quiet401 = false): Promise<Response> {
  if (res.ok) return res;
  const error = await toApiError(res);
  if (error.code === "unauthorized" && !quiet401) for (const l of [...unauthorizedListeners]) l();
  throw error;
}

/** JSON request. An empty answer (204) is `undefined`, so void endpoints use call<void>. */
export async function call<T>(method: Method, path: string, o: RequestOptions = {}): Promise<T> {
  const res = await responseOrThrow(await request(method, path, o), o.quiet401);
  if (res.status === 204) return undefined as T;
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if (isAbort(e) || o.signal?.aborted) throw e;
    throw new ApiError({ status: 0, code: "offline", message: "network" });
  }
  if (text.trim() === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError({ status: res.status, code: "bad_response", message: "not JSON" });
  }
}

type QueryValue = string | number | boolean | null | undefined;

/** "?a=1&b=x" without empty values; "" when nothing is set. */
export function query(params: object = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params) as [string, QueryValue][]) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const text = qs.toString();
  return text ? `?${text}` : "";
}

/** Path segment encoding that keeps ':' readable (draft scopes such as visit:<id>:composer). */
export function seg(value: string): string {
  return encodeURIComponent(value).replace(/%3A/gi, ":");
}

/** A few answers may come wrapped ({visit: …}) or bare; the contract allows both readings. */
export function unwrap<T>(body: unknown, key: string): T {
  if (typeof body === "object" && body !== null && key in body) {
    const inner = (body as Record<string, unknown>)[key];
    if (typeof inner === "object" && inner !== null) return inner as T;
  }
  return body as T;
}
