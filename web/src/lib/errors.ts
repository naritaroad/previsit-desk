// Maps API errors and run failures to UI copy keys. The page uses its own wording (in the language
// the visitor picked) instead of the server's message, so the interface never mixes languages.

import { ApiError } from "../api/client.ts";
import type { Failure } from "../state/visitReducer.ts";

export interface Described {
  /** Key in the language files. */
  key: string;
  params?: Record<string, string | number>;
  /** Worth offering a retry button. */
  retryable: boolean;
}

const DEFAULT_WAIT_S = 30;

export function describeApiError(e: unknown): Described {
  if (!(e instanceof ApiError)) return { key: "errors.internal", retryable: true };
  switch (e.code) {
    case "offline":
      return { key: "errors.offline", retryable: true };
    case "rate_limited":
      return { key: "errors.rateLimited", params: { seconds: e.retryAfter ?? DEFAULT_WAIT_S }, retryable: true };
    case "not_found":
      return { key: "errors.notFound", retryable: false };
    case "visit_closed":
      return { key: "errors.visitClosed", retryable: false };
    case "conflict":
      return { key: "errors.conflict", retryable: true };
    case "unauthorized":
      return { key: "errors.unauthorized", retryable: false };
    case "invalid_credentials":
      return { key: "errors.invalidCredentials", retryable: false };
    case "payload_too_large":
      return { key: "errors.tooLarge", retryable: false };
    case "invalid_request":
      return { key: "errors.invalidRequest", retryable: false };
    case "invalid_state":
      return { key: "errors.invalidState", retryable: false };
    default:
      return { key: "errors.internal", retryable: true };
  }
}

/** Run failures (SSE run.failed) and request failures kept in the visit state. */
export function describeFailure(f: Failure): Described {
  switch (f.code) {
    case "daily_budget_exceeded":
      return { key: "errors.budget", retryable: false };
    case "timeout":
      return { key: "errors.timeout", retryable: true };
    case "max_steps":
    case "model_error":
    case "not_configured":
      return { key: "errors.modelDown", retryable: true };
    case "network":
      return { key: "errors.offline", retryable: true };
    case "rate_limited":
      return { key: "errors.rateLimited", params: { seconds: f.retryAfter ?? DEFAULT_WAIT_S }, retryable: true };
    case "visit_closed":
      return { key: "errors.visitClosed", retryable: false };
    case "conflict":
      return { key: "errors.conflict", retryable: true };
    default:
      return { key: "errors.internal", retryable: true };
  }
}
