// SSE parser (src/api/sse.ts): chunk boundaries, CRLF, comments, multi-line data, bad JSON.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSseParser, parseSseBlock } from "../src/api/sse.ts";
import type { StreamEnvelope } from "../src/api/types.ts";

const frame = (seq: number, type: string, data: unknown) =>
  `event: ${type}\ndata: ${JSON.stringify({ v: 1, seq, type, data })}\n\n`;

function collect() {
  const events: StreamEnvelope[] = [];
  return { events, parser: createSseParser((e) => events.push(e)) };
}

test("parses events delivered whole", () => {
  const { events, parser } = collect();
  parser.push(frame(1, "message.accepted", { message_id: "m1", visit_id: "v1" }) + frame(2, "run.started", { run_id: "r1", model: "x" }));
  assert.deepEqual(
    events.map((e) => [e.seq, e.type]),
    [
      [1, "message.accepted"],
      [2, "run.started"],
    ],
  );
  assert.deepEqual(events[0].data, { message_id: "m1", visit_id: "v1" });
});

test("reassembles an event that arrives one character at a time", () => {
  const { events, parser } = collect();
  const text = frame(1, "message.delta", { text: "胸口悶痛，已經兩小時" });
  for (const ch of text) parser.push(ch);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data, { text: "胸口悶痛，已經兩小時" });
});

test("a blank line split between two chunks still ends the event", () => {
  const { events, parser } = collect();
  const text = frame(1, "intake.updated", { stage: "hpi" });
  parser.push(text.slice(0, -1));
  assert.equal(events.length, 0);
  parser.push(text.slice(-1));
  assert.equal(events.length, 1);
});

test("accepts CRLF line endings and ignores comment lines", () => {
  const { events, parser } = collect();
  parser.push(`: keep-alive\r\n\r\nevent: run.completed\r\ndata: {"v":1,"seq":9,"type":"run.completed","data":{"run_id":"r"}}\r\n\r\n`);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "run.completed");
  assert.equal(events[0].seq, 9);
});

test("joins multi-line data fields with a newline", () => {
  const block = parseSseBlock('event: x\ndata: {"a":\ndata: 1}');
  assert.deepEqual(block, { event: "x", data: '{"a":\n1}' });
});

test("falls back to the event name when the JSON has no type", () => {
  const { events, parser } = collect();
  parser.push('event: message.delta\ndata: {"data":{"text":"hi"}}\n\n');
  assert.equal(events[0].type, "message.delta");
  assert.deepEqual(events[0].data, { text: "hi" });
});

test("drops undecodable blocks and counts them, keeps going", () => {
  const { events, parser } = collect();
  parser.push("event: x\ndata: {not json\n\n");
  parser.push(frame(2, "run.completed", {}));
  assert.equal(events.length, 1);
  assert.equal(parser.dropped, 1);
});

test("end() delivers a final event that lacks the trailing blank line", () => {
  const { events, parser } = collect();
  parser.push('event: run.completed\ndata: {"v":1,"seq":3,"type":"run.completed","data":{}}');
  assert.equal(events.length, 0);
  parser.end();
  assert.equal(events.length, 1);
});

test("comment-only and empty blocks produce nothing", () => {
  assert.equal(parseSseBlock(": ping"), null);
  assert.equal(parseSseBlock(""), null);
});
