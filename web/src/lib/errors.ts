// Maps request and run failures to keys of the `errors` namespace. Pages use these words (in the language the
// person picked); the server's message is only used for field errors and as a last resort.

import { ApiError } from "../api/errors.ts";
import type { RunFailureCode } from "../api/types.ts";

export interface Described {
  /** Full i18next key, e.g. "errors:offline". */
  key: string;
  /** Pass to t() as they are; empty when the text has no placeholders. */
  params: Record<string, string | number>;
  /** Worth offering a retry button. */
  retryable: boolean;
}

const DEFAULT_WAIT_S = 30;
const say = (key: string, retryable: boolean): Described => ({ key, params: {}, retryable });

export function describeError(e: unknown): Described {
  if (!(e instanceof ApiError)) return say("errors:internal", true);
  switch (e.code) {
    case "offline":
      return say("errors:offline", true);
    case "bad_response":
      return say("errors:badResponse", true);
    case "rate_limited":
      return { key: "errors:rateLimited", params: { seconds: e.retryAfter ?? DEFAULT_WAIT_S }, retryable: true };
    case "not_found":
      return say("errors:notFound", false);
    case "visit_closed":
      return say("errors:visitClosed", false);
    case "conflict":
      return e.current === undefined ? say("errors:busy", true) : say("errors:stale", false);
    case "unauthorized":
      return say("errors:unauthorized", false);
    case "forbidden":
      return say("errors:forbidden", false);
    case "invalid_credentials":
      return say("errors:invalidCredentials", false);
    case "payload_too_large":
      return say("errors:tooLarge", false);
    case "unsupported_media_type":
    case "invalid_request":
      return say(e.hasFields ? "errors:invalidFields" : "errors:invalidRequest", false);
    case "invalid_state":
      return say("errors:invalidState", false);
    case "internal":
      return say("errors:internal", true);
  }
}

/** Failure of an assistant turn (SSE run.failed, or a run stored as failed/interrupted). */
export function describeRunFailure(code: RunFailureCode | "interrupted" | (string & {}) | null): Described {
  switch (code) {
    case "daily_budget_exceeded":
      return say("errors:run.budget", false);
    case "timeout":
      return say("errors:run.timeout", true);
    case "interrupted":
      return say("errors:run.interrupted", true);
    case "max_steps":
    case "model_error":
    case "not_configured":
      return say("errors:run.model", true);
    default:
      return say("errors:run.unknown", true);
  }
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** Text under an input: a zod message key ("field.required") becomes words, a server sentence stays as it is. */
export function fieldMessage(t: Translate, message: string | undefined): string | undefined {
  if (!message) return undefined;
  return message.startsWith("field.") ? t(`errors:${message}`) : message;
}

interface SetError<Name extends string> {
  (name: Name, error: { type: string; message: string }): void;
}

/**
 * Put the fields of a 422 onto a react-hook-form form. Returns the messages that belong to no input of the
 * form, so nothing is swallowed. Dotted server names (pickup_window.date) match nested inputs.
 */
export function applyFieldErrors<Name extends string>(e: unknown, names: readonly Name[], setError: SetError<Name>): string[] {
  if (!(e instanceof ApiError)) return [];
  const rest: string[] = [];
  for (const [field, message] of Object.entries(e.fields)) {
    const name = names.find((n) => n === field);
    if (name) setError(name, { type: "server", message });
    else rest.push(message || field);
  }
  return rest;
}
