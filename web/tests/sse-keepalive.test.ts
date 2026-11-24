// Contract 7.6: the server sends ": keep-alive" comment lines every 15 s.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSseParser } from "../src/api/sse.ts";
import type { StreamEnvelope } from "../src/api/types.ts";

test("keep-alive comments between and inside events change nothing", () => {
  const events: StreamEnvelope[] = [];
  const parser = createSseParser((e) => events.push(e));
  parser.push(": keep-alive\n\n");
  parser.push('event: run.started\n: keep-alive\ndata: {"v":1,"seq":1,"type":"run.started","data":{"run_id":"r","model":"m"}}\n\n');
  parser.push(": keep-alive\n\n");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "run.started");
  assert.equal(parser.dropped, 0);
});
