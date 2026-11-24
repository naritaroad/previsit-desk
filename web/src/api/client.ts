// Thin client for the HTTP API of docs/api/contract.md. Same origin, JSON, cookie session for the
// clinician side. Only endpoints from the contract are used here.

import { createSseParser } from "./sse.ts";
import type {
  ClinicianTicket,
  ClinicianUser,
  ClinicianVisitItem,
  Locale,
  Message,
  Meta,
  PrevisitSummary,
  RefillInput,
  RefillResult,
  StreamEnvelope,
  Ticket,
  TicketReason,
  Visit,
  VisitDetail,
} from "./types.ts";

const BASE = "/api/v1";

/** Error codes of the contract plus the two the browser can produce itself. */
export type ApiErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "invalid_credentials"
  | "forbidden"
  | "not_found"
  | "visit_closed"
  | "rate_limited"
  | "payload_too_large"
  | "internal"
  | "conflict"
  | "invalid_state"
  | "unsupported_media_type"
  | "offline"
  | "bad_response";

/** Filter values of GET /clinician/visits (default on the server: pending). */
export type ClinicianListStatus = "pending" | "submitted" | "red_flag" | "reviewed" | "all";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  /** Field name to message, from `error.fields` of a 422. */
  readonly fields: Record<string, string>;
  readonly retryAfter: number | null;

  constructor(status: number, code: ApiErrorCode, message: string, fields: Record<string, string> = {}, retryAfter: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.retryAfter = retryAfter;
  }
}

let acceptLanguage = "zh-TW";
/** Tell the server which language error messages should use (the Accept-Language header). */
export function setApiLanguage(locale: Locale): void {
  acceptLanguage = locale;
}

const KNOWN_CODES: readonly string[] = [
  "invalid_request",
  "unauthorized",
  "invalid_credentials",
  "forbidden",
  "not_found",
  "visit_closed",
  "rate_limited",
  "payload_too_large",
  "internal",
  "conflict",
  "invalid_state",
  "unsupported_media_type",
];

async function toApiError(res: Response): Promise<ApiError> {
  let code: ApiErrorCode = res.status === 404 ? "not_found" : res.status === 429 ? "rate_limited" : "internal";
  let message = res.statusText;
  let fields: Record<string, string> = {};
  try {
    const body: unknown = await res.json();
    const err = (body as { error?: { code?: unknown; message?: unknown; fields?: unknown } } | null)?.error;
    if (err) {
      if (typeof err.code === "string" && KNOWN_CODES.includes(err.code)) code = err.code as ApiErrorCode;
      if (typeof err.message === "string") message = err.message;
      if (err.fields && typeof err.fields === "object" && !Array.isArray(err.fields)) {
        fields = Object.fromEntries(Object.entries(err.fields as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
      } else if (Array.isArray(err.fields)) {
        // Older mock shape: a plain list of field names.
        fields = Object.fromEntries(err.fields.map((f) => [String(f), ""]));
      }
    }
  } catch {
    /* not JSON */
  }
  const retry = Number(res.headers.get("Retry-After"));
  return new ApiError(res.status, code, message, fields, Number.isFinite(retry) && retry > 0 ? retry : null);
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Accept-Language": acceptLanguage,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "offline", "network");
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(res.status, "bad_response", "bad response");
  }
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal);
const post = <T>(path: string, body: unknown = {}) => request<T>("POST", path, body);

export const api = {
  health: () => get<{ ok: boolean; version: string; model_ready: boolean }>("/health"),
  meta: (signal?: AbortSignal) => get<Meta>("/meta", signal),

  createVisit: (locale: Locale) => post<{ visit: Visit; messages: Message[] }>("/visits", { locale }),
  getVisit: (id: string, signal?: AbortSignal) => get<VisitDetail>(`/visits/${encodeURIComponent(id)}`, signal),
  refillCheck: (id: string, input: RefillInput) =>
    post<{ result: RefillResult }>(`/visits/${encodeURIComponent(id)}/refill-check`, input),
  submit: (id: string) => post<{ visit: Visit; summary: PrevisitSummary }>(`/visits/${encodeURIComponent(id)}/submit`),
  handoff: (id: string, reason?: TicketReason, note?: string) =>
    post<{ ticket: Ticket }>(`/visits/${encodeURIComponent(id)}/handoff`, { reason, note }),

  login: (username: string, password: string) => post<{ user: ClinicianUser }>("/auth/login", { username, password }),
  logout: () => post<unknown>("/auth/logout"),
  me: () => get<{ user: ClinicianUser }>("/auth/me"),
  clinicianVisits: (params: { status?: ClinicianListStatus; q?: string; limit?: number }, signal?: AbortSignal) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.q) qs.set("q", params.q);
    if (params.limit) qs.set("limit", String(params.limit));
    const suffix = qs.size ? `?${qs.toString()}` : "";
    return get<{ items: ClinicianVisitItem[] }>(`/clinician/visits${suffix}`, signal);
  },
  clinicianVisit: (id: string, signal?: AbortSignal) => get<VisitDetail>(`/clinician/visits/${encodeURIComponent(id)}`, signal),
  review: (id: string, note?: string) => post<{ visit: Visit }>(`/clinician/visits/${encodeURIComponent(id)}/review`, { note }),
  clinicianTickets: (status: "open" | "resolved" | "all", signal?: AbortSignal) =>
    get<{ items: ClinicianTicket[] }>(`/clinician/tickets?status=${status}`, signal),
  resolveTicket: (id: string, note?: string) =>
    post<{ ticket: Ticket }>(`/clinician/tickets/${encodeURIComponent(id)}/resolve`, { note }),
};

/**
 * POST a patient message and read the SSE answer. EventSource cannot POST, so the stream is read
 * with fetch. Resolves when the server closes the stream; rejects with ApiError for HTTP errors
 * (409 visit_closed, 429 rate_limited, ...) before any event arrives.
 */
export async function sendMessage(
  visitId: string,
  content: string,
  onEvent: (e: StreamEnvelope) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/visits/${encodeURIComponent(visitId)}/messages`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", "Accept-Language": acceptLanguage },
      body: JSON.stringify({ content }),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "offline", "network");
  }
  if (!res.ok) throw await toApiError(res);
  if (!res.body) throw new ApiError(res.status, "bad_response", "no stream");

  const parser = createSseParser(onEvent);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(value);
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "offline", "stream interrupted");
  }
  parser.end();
}
