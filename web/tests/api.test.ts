// fetch client and SSE parser.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { call, onUnauthorized, query, seg, unwrap } from "../src/api/client.ts";
import { ApiError, isStale, parseRetryAfter } from "../src/api/errors.ts";
import { bpSchema, claimSchema, messageSchema, passwordSchema, refillSchema } from "../src/api/schemas.ts";
import { createSseParser, decodeEnvelope, openStream, parseSseBlock } from "../src/api/sse.ts";
import type { StreamEnvelope } from "../src/api/types.ts";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  fetchMock.mockResolvedValueOnce(new Response(body === null ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers }));

describe("client", () => {
  it("sends JSON, Accept-Language and the Idempotency-Key", async () => {
    answer(201, { ok: 1 });
    await call("POST", "/visits", { body: { a: 1 }, idempotencyKey: "k" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost/api/v2/visits");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", body: '{"a":1}' });
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json", "Idempotency-Key": "k", "Accept-Language": "zh-TW" });
  });

  it("204 and empty answers are undefined", async () => {
    answer(204, null);
    expect(await call("DELETE", "/x")).toBeUndefined();
    answer(200, "");
    expect(await call("POST", "/x")).toBeUndefined();
  });

  it("422 fields, 409 current, 429 Retry-After", async () => {
    answer(422, { error: { code: "invalid_request", message: "m", fields: { name: "太長" } } });
    await expect(call("POST", "/x")).rejects.toMatchObject({ code: "invalid_request", fields: { name: "太長" }, hasFields: true, transient: false });
    answer(409, { error: { code: "conflict", message: "m", current: { revision: 4 } } });
    const stale = await call("PUT", "/x").catch((e: unknown) => e);
    expect(isStale(stale)).toBe(true);
    answer(409, { error: { code: "conflict", message: "m", current: null } });
    expect(isStale(await call("PUT", "/x").catch((e: unknown) => e))).toBe(true); // deleted on the server
    answer(409, { error: { code: "conflict", message: "busy" } });
    expect(isStale(await call("PUT", "/x").catch((e: unknown) => e))).toBe(false);
    answer(429, { error: { code: "rate_limited", message: "m" } }, { "Retry-After": "42" });
    await expect(call("POST", "/x")).rejects.toMatchObject({ code: "rate_limited", retryAfter: 42, transient: true });
  });

  it("a proxy's HTML error page is judged by its status", async () => {
    answer(502, "<html>bad gateway</html>");
    await expect(call("GET", "/x")).rejects.toMatchObject({ code: "internal", status: 502, transient: true });
    answer(200, "<html>");
    await expect(call("GET", "/x")).rejects.toMatchObject({ code: "bad_response" });
  });

  it("no network is 'offline'; an abort stays an abort", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(call("GET", "/x")).rejects.toMatchObject({ code: "offline", transient: true });
    fetchMock.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    await expect(call("GET", "/x")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("tells listeners about an ended session, not about wrong passwords or a quiet check", async () => {
    let heard = 0;
    const off = onUnauthorized(() => (heard += 1));
    answer(401, { error: { code: "invalid_credentials", message: "m" } });
    await call("POST", "/auth/login").catch(() => undefined);
    answer(401, { error: { code: "unauthorized", message: "m" } });
    await call("GET", "/auth/me", { quiet401: true }).catch(() => undefined);
    expect(heard).toBe(0);
    answer(401, { error: { code: "unauthorized", message: "m" } });
    await call("GET", "/visits").catch(() => undefined);
    expect(heard).toBe(1);
    off();
  });

  it("helpers", () => {
    expect(query({ a: 1, b: "", c: undefined, d: null, e: false, q: "頭 痛" })).toBe("?a=1&e=false&q=%E9%A0%AD+%E7%97%9B");
    expect(query({})).toBe("");
    expect(seg("visit:1/2:composer")).toBe("visit:1%2F2:composer");
    expect(unwrap({ visit: { id: "1" } }, "visit")).toEqual({ id: "1" });
    expect(unwrap({ id: "1" }, "visit")).toEqual({ id: "1" });
    expect(parseRetryAfter("Wed, 25 Nov 2026 08:00:30 GMT", Date.parse("2026-11-25T08:00:00Z"))).toBe(30);
    expect([parseRetryAfter(null), parseRetryAfter("0"), parseRetryAfter("soon")]).toEqual([null, null, null]);
  });
});

describe("SSE", () => {
  const frame = (seq: number | null, type: string, data: unknown) =>
    `event: ${type}\n${seq === null ? "" : `id: ${seq}\n`}data: ${JSON.stringify({ v: 1, ...(seq === null ? {} : { seq }), type, data })}\n\n`;
  function collect() {
    const events: StreamEnvelope[] = [];
    return { events, parser: createSseParser((e) => events.push(e)) };
  }

  it("parses whole events, with and without seq", () => {
    const { events, parser } = collect();
    parser.push(frame(1, "message.created", { id: "m1" }) + frame(null, "message.delta", { text: "胸口" }));
    expect(events).toEqual([
      { seq: 1, type: "message.created", data: { id: "m1" } },
      { seq: null, type: "message.delta", data: { text: "胸口" } },
    ]);
  });

  it("reassembles one character at a time, CRLF, comments and multi-line data", () => {
    const { events, parser } = collect();
    for (const ch of `: keep-alive\r\n\r\n${frame(3, "x", { text: "已經兩小時" }).replaceAll("\n", "\r\n")}`) parser.push(ch);
    parser.push(`event: y\n: note\ndata: {"a":\ndata: 1}\n\n`);
    expect(events).toEqual([
      { seq: 3, type: "x", data: { text: "已經兩小時" } },
      { seq: null, type: "y", data: { a: 1 } },
    ]);
  });

  it("uses id: when the payload has no seq, and the event name when it has no envelope", () => {
    expect(decodeEnvelope(parseSseBlock('event: rx.changed\nid: 9\ndata: {"id":"r1"}')!)).toEqual({ seq: 9, type: "rx.changed", data: { id: "r1" } });
    expect(decodeEnvelope(parseSseBlock('id: 9\ndata: {"type":"a","data":{}}')!)).toEqual({ seq: 9, type: "a", data: {} });
  });

  it("drops what it cannot decode and delivers a last event without a blank line", () => {
    const { events, parser } = collect();
    parser.push("data: not json\n\n");
    parser.push('event: z\ndata: {"v":1,"type":"z","data":1}');
    parser.end();
    expect(parser.dropped).toBe(1);
    expect(events).toEqual([{ seq: null, type: "z", data: 1 }]);
  });

  it("openStream sends Last-Event-ID and maps HTTP errors", async () => {
    const events: StreamEnvelope[] = [];
    answer(200, frame(5, "x", 1));
    await openStream("/visits/1/stream?after=4", { signal: new AbortController().signal, lastEventId: 4, onEnvelope: (e) => events.push(e) });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Accept: "text/event-stream", "Last-Event-ID": "4" });
    expect(events).toHaveLength(1);
    answer(404, { error: { code: "not_found", message: "m" } });
    await expect(openStream("/x", { signal: new AbortController().signal, onEnvelope: () => undefined })).rejects.toBeInstanceOf(ApiError);
  });

  it("an abort ends a stream that is waiting for bytes", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start() {} })));
    const abort = new AbortController();
    const reading = openStream("/x", { signal: abort.signal, onEnvelope: () => undefined });
    setTimeout(() => abort.abort(), 10);
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("input schemas", () => {
  const errors = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
    r.success ? {} : Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join("."), i.message]));
  it("account forms", () => {
    expect(errors(claimSchema.safeParse({ username: "a", password: "short", display_name: " " }))).toEqual({
      username: "field.usernameShort",
      password: "field.passwordShort",
      display_name: "field.required",
    });
    expect(errors(passwordSchema.safeParse({ current: "12345678", next: "abcdefgh", confirm: "abcdefgx" }))).toEqual({ confirm: "field.passwordMismatch" });
  });
  it("numbers typed into inputs", () => {
    expect(errors(bpSchema.safeParse({ systolic: "", diastolic: "80", taken_at: "2026-11-25T08:00" }))).toEqual({ systolic: "field.required" });
    expect(errors(bpSchema.safeParse({ systolic: "80", diastolic: "120", taken_at: "x" }))).toEqual({ diastolic: "field.bpOrder" });
    expect(bpSchema.parse({ systolic: "132", diastolic: 80, taken_at: "x" })).toMatchObject({ systolic: 132, diastolic: 80 });
  });
  it("refill form", () => {
    const base = { prescription_date: "2026-11-01", total_days: "90", days_per_fill: "30", fills_done: "1", last_fill_date: "2026-11-01", controlled: "no", special_status: "none", symptom_changed: false, side_effects: false };
    expect(refillSchema.safeParse(base).success).toBe(true);
    expect(errors(refillSchema.safeParse({ ...base, last_fill_date: "2026-02-30" }))).toEqual({ last_fill_date: "field.date" });
    expect(errors(refillSchema.safeParse({ ...base, total_days: "20" }))).toEqual({ days_per_fill: "field.perFillExceedsTotal" });
    expect(errors(refillSchema.safeParse({ ...base, fills_done: "4" }))).toEqual({ fills_done: "field.range" });
  });
  it("messages are counted in code points", () => {
    expect(messageSchema(2).safeParse("😀😀").success).toBe(true);
    expect(messageSchema(2).safeParse("三個字").success).toBe(false);
    expect(messageSchema(2).safeParse("  ").success).toBe(false);
  });
});
