// Ids the browser makes: message client ids and idempotency keys.

/** UUID v4; falls back to getRandomValues on plain-http origins where randomUUID is missing. */
export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** One per user intent (a click on "submit"), kept when that same intent is retried. */
export const newIdempotencyKey = uuid;

/** This tab, for BroadcastChannel messages. */
export const TAB_ID = uuid();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID.test(value);
}
