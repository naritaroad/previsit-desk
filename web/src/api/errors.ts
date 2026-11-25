// One error type for every request. `code` is the contract's code (or 'offline' / 'bad_response' when the
// browser could not get an answer), `fields` are per-field messages of a 422, `current` is the server's
// version on a 409 revision conflict.

import type { ApiErrorCode, ServerErrorCode } from "./types.ts";

const SERVER_CODES: readonly ServerErrorCode[] = [
  "invalid_request",
  "unauthorized",
  "invalid_credentials",
  "forbidden",
  "not_found",
  "conflict",
  "visit_closed",
  "invalid_state",
  "rate_limited",
  "payload_too_large",
  "unsupported_media_type",
  "internal",
];

const CODE_BY_STATUS: Readonly<Record<number, ServerErrorCode>> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "invalid_request",
  429: "rate_limited",
};

export interface ApiErrorInit {
  status: number;
  code: ApiErrorCode;
  message?: string;
  fields?: Record<string, string>;
  current?: unknown;
  retryAfter?: number | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  /** Field name -> message, in the account's language. Empty when the error is not about fields. */
  readonly fields: Readonly<Record<string, string>>;
  /** The server's object: on a 409 revision conflict, or a 422 that explains itself (RefillResult). */
  readonly current: unknown;
  /** Seconds from Retry-After. */
  readonly retryAfter: number | null;

  constructor(init: ApiErrorInit) {
    super(init.message ?? init.code);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.fields = init.fields ?? {};
    this.current = init.current;
    this.retryAfter = init.retryAfter ?? null;
  }

  /** Nothing was wrong with the request itself; sending it again later can work. */
  get transient(): boolean {
    return this.code === "offline" || this.code === "rate_limited" || this.code === "bad_response" || this.status >= 500;
  }

  get hasFields(): boolean {
    return Object.keys(this.fields).length > 0;
  }
}

/**
 * A 409 that carries the server's version (stale revision), not a "busy" 409. `current` is null when the
 * object is gone on the server (a draft deleted on another device).
 */
export function isStale(e: unknown): e is ApiError {
  return e instanceof ApiError && e.code === "conflict" && e.current !== undefined;
}

export function isApiError(e: unknown, code?: ApiErrorCode): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

export function isAbort(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

function isServerCode(v: unknown): v is ServerErrorCode {
  return typeof v === "string" && (SERVER_CODES as readonly string[]).includes(v);
}

/** Retry-After: seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds > 0 ? Math.ceil(seconds) : null;
  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  const wait = Math.ceil((at - now) / 1000);
  return wait > 0 ? wait : null;
}

export async function toApiError(res: Response): Promise<ApiError> {
  let code: ApiErrorCode = CODE_BY_STATUS[res.status] ?? "internal";
  let message = res.statusText;
  let fields: Record<string, string> = {};
  let current: unknown;
  try {
    const body: unknown = await res.json();
    const err = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
    if (typeof err === "object" && err !== null) {
      const o = err as Record<string, unknown>;
      if (isServerCode(o.code)) code = o.code;
      if (typeof o.message === "string") message = o.message;
      if (typeof o.fields === "object" && o.fields !== null && !Array.isArray(o.fields)) {
        fields = Object.fromEntries(Object.entries(o.fields).map(([k, v]) => [k, String(v)]));
      }
      current = o.current;
    }
  } catch {
    /* not JSON (a proxy page, an empty body): the status decides */
  }
  return new ApiError({
    status: res.status,
    code,
    message,
    fields,
    current,
    retryAfter: parseRetryAfter(res.headers.get("Retry-After")),
  });
}
