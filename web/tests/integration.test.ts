// Rules found while walking the client against the real backend.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Message, StreamEnvelope, Ticket, ToolName } from "../src/api/types.ts";
import { ticketForMessage } from "../src/lib/tickets.ts";
import { handbookHits } from "../src/lib/trace.ts";
import { failureBannerVisible, groupTrace, initialVisitState, visitReducer } from "../src/state/visitReducer.ts";

const ticket = (reason: Ticket["reason"], created_at: string): Ticket => ({
  id: "t", ticket_no: "T-20261125-0007", visit_id: "v", reason, urgency: "soon", summary: "", status: "open",
  created_by: "code", created_at, resolved_at: null, resolved_by: null, resolution_note: null,
});
const reply = (kind: Message["kind"], created_at: string): Message => ({ id: "m", role: "assistant", kind, content: "x", created_at, run_id: null });

test("a refusal gets the ticket that was raised with it, not an older or unrelated one", () => {
  const at = "2026-11-25T09:00:05Z";
  const mine = ticket("controlled_drug", "2026-11-25T09:00:04Z");
  const old = ticket("controlled_drug", "2026-11-25T08:00:00Z");
  const other = ticket("symptom_change", "2026-11-25T09:00:05Z");
  assert.equal(ticketForMessage(reply("refusal", at), [old, other, mine])?.ticket_no, "T-20261125-0007");
  assert.equal(ticketForMessage(reply("refusal", at), [old, other]), null);
  assert.equal(ticketForMessage(reply("chat", at), [mine]), null);
  assert.equal(ticketForMessage({ role: "patient", kind: "chat", created_at: at }, [mine]), null);
  assert.equal(ticketForMessage(reply("red_flag", at), [ticket("red_flag", "2026-11-25T09:00:06Z")])?.reason, "red_flag");
});

test("handbook hits keep title, section and a safe link only", () => {
  const hits = handbookHits({
    hits: [
      { score: 1.1, title: "咳嗽", section: "§3.2", source_name: "健康e點通", source_url: "https://ihealth.vghtpe.gov.tw/media/394", source_type: "authoritative" },
      { title: "怪連結", section: "§1", source_name: "x", source_url: "javascript:alert(1)" },
    ],
  });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].url, "https://ihealth.vghtpe.gov.tw/media/394");
  assert.equal(hits[1].url, null);
  assert.deepEqual(handbookHits({ hits: [] }), []);
  assert.deepEqual(handbookHits(null), []);
});

test("run.failed: the stored fixed notice is shown, the banner is not (one message, not two)", () => {
  const env = (type: string, data: unknown, seq: number): StreamEnvelope => ({ v: 1, seq, type, data });
  let s = visitReducer(initialVisitState, { type: "patient_sent", localId: "l", content: "hi", at: "2026-11-25T09:00:00Z" });
  for (const [i, e] of [
    env("message.accepted", { message_id: "m1", visit_id: "v" }, 1),
    env("precheck.completed", { red_flag: null, scope: "ok", duration_ms: 1 }, 2),
    env("run.started", { run_id: "r", model: "m" }, 3),
    env("message.completed", { message_id: "m2", kind: "notice", content: "AI 暫時無法回覆。", run_id: "r" }, 4),
    env("run.failed", { run_id: "r", code: "timeout", message: "AI 暫時無法回覆。" }, 5),
  ].entries()) s = visitReducer(s, { type: "stream", envelope: e, at: `2026-11-25T09:00:0${i}Z` });
  assert.equal(s.failure?.code, "timeout");
  assert.equal(s.messages.filter((m) => m.kind === "notice").length, 1);
  assert.equal(failureBannerVisible(s), false);
  // Without a stored notice (the stream broke before it), the banner speaks.
  assert.equal(failureBannerVisible({ failure: s.failure, messages: s.messages.slice(0, -1) }), true);
  assert.equal(failureBannerVisible({ failure: null, messages: s.messages }), false);
});

test("stored prechecks (run_id null) join the run created right after them; form rows stay apart", () => {
  const row = (name: string, run_id: string | null, created_at: string, source: "code" | "model" | "form" = "code") => ({
    id: `${name}-${created_at}`, run_id, step: 0, name: name as ToolName, source, status: "ok" as const, arguments: null, result: {}, duration_ms: 1, created_at,
  });
  const run = (id: string, created_at: string) => ({ id, model: "m", fallback_used: false, status: "completed" as const, steps: 1, usage: { input_tokens: 1, output_tokens: 1 }, error_code: null, duration_ms: 5, created_at });
  // Shapes seen on the real backend: prechecks at :02.412 and :05.897, runs created at :02.430 and :05.917.
  const trace = [
    row("red_flag_precheck", null, "2026-11-24T21:12:02.412832Z"),
    row("scope_precheck", null, "2026-11-24T21:12:02.420424Z"),
    row("record_intake", "r1", "2026-11-24T21:12:04.167487Z", "model"),
    row("red_flag_precheck", null, "2026-11-24T21:12:05.897998Z"),
    row("scope_precheck", null, "2026-11-24T21:12:05.906814Z"),
    row("output_guard", "r2", "2026-11-24T21:12:06.5Z"),
    row("check_chronic_refill", null, "2026-11-24T21:12:09Z", "form"),
    row("transfer_to_clinician", null, "2026-11-24T21:12:09.1Z"),
  ];
  const groups = groupTrace(trace, [run("r1", "2026-11-24T21:12:02.430214Z"), run("r2", "2026-11-24T21:12:05.917443Z")]);
  assert.deepEqual(groups.map((g) => g.key), ["r1", "r2", "form"]);
  assert.deepEqual(groups[0].rows.map((r) => r.name), ["red_flag_precheck", "scope_precheck", "record_intake"]);
  assert.deepEqual(groups[1].rows.map((r) => r.name), ["red_flag_precheck", "scope_precheck", "output_guard"]);
  assert.deepEqual(groups[2].rows.map((r) => r.name), ["check_chronic_refill", "transfer_to_clinician"]);
});
