// What the mock server does on purpose: latency, offline, failures. Set through ?mock=… (kept for the tab) or
// window.__mock. See docs/engineering/v2-frontend-data.md §6.

export interface MockConfig {
  /** Milliseconds; each request waits between half and one and a half times this. */
  latency: number;
  /** Requests fail like a lost network, streams close, navigator.onLine says false. */
  offline: boolean;
  /** Writes answer this status. `left` counts down; Infinity = until cleared. */
  fail: { status: FailStatus; left: number } | null;
  /** Streams are cut every few seconds (tests reconnecting and replay). */
  drop: boolean;
  /** Every list is empty. */
  empty: boolean;
  /** Assistant turns: 1 = normal, 0 = at once, 3 = three times slower. */
  pace: number;
  log: boolean;
}
export type FailStatus = 401 | 403 | 409 | 422 | 429 | 500;

export const defaultConfig = (): MockConfig => ({ latency: 180, offline: false, fail: null, drop: false, empty: false, pace: 1, log: false });

export interface ParsedMock {
  config: Partial<MockConfig>;
  /** Sign in as this username. */
  as: string | null;
  reset: boolean;
}

const STATUSES: readonly number[] = [401, 403, 409, 422, 429, 500];

/**
 * ?mock=as:dr_demo,latency:1200,429 — comma separated:
 *   as:<username> · reset · offline · online · latency:<ms> · fast · slow · 409 (every write) · 409*2 (next two
 *   writes) · ok (no failures) · drop · nodrop · empty · full · log
 */
export function parseMock(text: string): ParsedMock {
  const config: Partial<MockConfig> = {};
  let as: string | null = null;
  let reset = false;
  for (const raw of text.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const [name, value = ""] = part.split(":");
    const status = /^(\d{3})(?:\*(\d+))?$/.exec(part);
    if (status && STATUSES.includes(Number(status[1]))) {
      config.fail = { status: Number(status[1]) as FailStatus, left: status[2] ? Number(status[2]) : Number.POSITIVE_INFINITY };
    } else if (name === "as") as = value || null;
    else if (name === "reset") reset = true;
    else if (name === "offline") config.offline = true;
    else if (name === "online") config.offline = false;
    else if (name === "latency") config.latency = Math.max(0, Number(value) || 0);
    else if (name === "fast") Object.assign(config, { latency: 0, pace: 0.25 });
    else if (name === "slow") Object.assign(config, { latency: 1500, pace: 3 });
    else if (name === "ok") config.fail = null;
    else if (name === "drop") config.drop = true;
    else if (name === "nodrop") config.drop = false;
    else if (name === "empty") config.empty = true;
    else if (name === "full") config.empty = false;
    else if (name === "log") config.log = true;
  }
  return { config, as, reset };
}
