// Incremental parser for text/event-stream (contract section 4). Pure: no DOM, no fetch, so
// `npm test` can feed it chunks cut at awkward places.

import type { StreamEnvelope } from "./types.ts";

export interface SseBlock {
  event: string | null;
  data: string;
}

/** Parse one event block (the text between two blank lines). Returns null for comment-only blocks. */
export function parseSseBlock(block: string): SseBlock | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

/** Decode a block into the contract's envelope. Returns null if it is not valid JSON of that shape. */
export function decodeEnvelope(block: SseBlock): StreamEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(block.data);
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    const type = typeof o.type === "string" ? o.type : block.event;
    if (!type) return null;
    return { v: typeof o.v === "number" ? o.v : 1, seq: typeof o.seq === "number" ? o.seq : 0, type, data: o.data };
  } catch {
    return null;
  }
}

export interface SseParser {
  /** Feed the next chunk of decoded text; calls `onEnvelope` once per complete event. */
  push(chunk: string): void;
  /** Call when the stream ends; a final event without a trailing blank line is still delivered. */
  end(): void;
  /** Number of blocks that were dropped because they could not be decoded. */
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
