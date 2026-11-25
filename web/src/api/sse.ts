// text/event-stream over fetch: an incremental parser (pure) and a reader with Last-Event-ID.
// EventSource is not used because it cannot set headers, report HTTP errors or be paused cleanly.

import { request, responseOrThrow } from "./client.ts";
import { ApiError, isAbort } from "./errors.ts";
import type { StreamEnvelope } from "./types.ts";

export interface SseBlock {
  event: string | null;
  id: string | null;
  data: string;
}

/** Parse one event block (the text between two blank lines). Null for comment-only blocks. */
export function parseSseBlock(block: string): SseBlock | null {
  let event: string | null = null;
  let id: string | null = null;
  const data: string[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, id, data: data.join("\n") };
}

function toSeq(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Decode a block. Two payload shapes are accepted: the contract's envelope `{v, seq, type, data}` and a bare
 * object whose type is the `event:` field. `id:` is the sequence number when the envelope has none.
 */
export function decodeEnvelope(block: SseBlock): StreamEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if ("data" in o) {
    const type = typeof o.type === "string" ? o.type : block.event;
    if (type) return { seq: toSeq(o.seq) ?? toSeq(block.id), type, data: o.data };
  }
  if (block.event) return { seq: toSeq(block.id), type: block.event, data: parsed };
  return null;
}

export interface SseParser {
  /** Feed the next chunk of decoded text. */
  push(chunk: string): void;
  /** Call when the stream ends; a final event without a trailing blank line is still delivered. */
  end(): void;
  /** Blocks that could not be decoded. */
  readonly dropped: number;
}

export function createSseParser(onEnvelope: (e: StreamEnvelope) => void): SseParser {
  let buffer = "";
  let dropped = 0;
  const emit = (block: string) => {
    const parsed = parseSseBlock(block);
    if (!parsed) return;
    const envelope = decodeEnvelope(parsed);
    if (envelope) onEnvelope(envelope);
    else dropped += 1;
  };
  const drain = () => {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) return;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      emit(block);
    }
  };
  return {
    push(chunk) {
      buffer += chunk;
      drain();
    },
    end() {
      drain();
      if (buffer.trim()) emit(buffer);
      buffer = "";
    },
    get dropped() {
      return dropped;
    },
  };
}

export interface OpenStreamOptions {
  signal: AbortSignal;
  lastEventId?: number | null;
  onOpen?: () => void;
  onEnvelope: (e: StreamEnvelope) => void;
  /** Any bytes at all, keep-alive comments included (feeds the stall watchdog). */
  onActivity?: () => void;
}

/** Reads the stream until the server closes it (resolves) or it breaks (rejects with ApiError). */
export async function openStream(path: string, o: OpenStreamOptions): Promise<void> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (o.lastEventId) headers["Last-Event-ID"] = String(o.lastEventId);
  const res = await responseOrThrow(await request("GET", path, { headers, signal: o.signal, cache: "no-store" }));
  if (!res.body) throw new ApiError({ status: res.status, code: "bad_response" });
  o.onOpen?.();
  o.onActivity?.();
  const parser = createSseParser(o.onEnvelope);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // Some fetch implementations do not reject a pending read on abort; cancelling always ends it.
  const onAbort = () => void reader.cancel().catch(() => undefined);
  o.signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (o.signal.aborted) throw new DOMException("aborted", "AbortError");
      if (done) break;
      o.onActivity?.();
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } catch (e) {
    if (isAbort(e) || o.signal.aborted) throw new DOMException("aborted", "AbortError");
    throw new ApiError({ status: 0, code: "offline", message: "stream interrupted" });
  } finally {
    o.signal.removeEventListener("abort", onAbort);
  }
}
