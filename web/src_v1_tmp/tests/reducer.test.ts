// Event reducer (src/state/visitReducer.ts): replays recorded streams and checks the resulting state.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { StreamEnvelope, Visit } from "../src/api/types.ts";
import { groupTrace, initialVisitState, isClosed, visitReducer, type VisitState } from "../src/state/visitReducer.ts";

const visit: Visit = {
  id: "11111111-1111-4111-8111-111111111111",
  locale: "zh-TW",
  status: "active",
  stage: "chief_complaint",
  urgency: "routine",
  created_at: "2026-11-25T08:00:00Z",
  updated_at: "2026-11-25T08:00:00Z",
  submitted_at: null,
  reviewed_at: null,
  reviewed_by: null,
  review_note: null,
};

let seq = 0;
const ev = (type: string, data: unknown): StreamEnvelope => ({ v: 1, seq: ++seq, type, data });

function replay(start: VisitState, events: StreamEnvelope[]): VisitState {
  return events.reduce((s, envelope) => visitReducer(s, { type: "stream", envelope, at: "2026-11-25T08:01:00Z" }), start);
}

function sent(state: VisitState, text: string): VisitState {
  return visitReducer(state, { type: "patient_sent", localId: "local-1", content: text, at: "2026-11-25T08:01:00Z" });
}

const started = visitReducer(initialVisitState, { type: "created", visit, messages: [] });

test("a normal turn: optimistic message, tools, intake, streamed reply, run totals", () => {
  let s = sent(started, "我咳嗽三天了");
  assert.equal(s.busy, true);
  assert.equal(s.messages.at(-1)?.pending, true);

  s = replay(s, [
    ev("message.accepted", { message_id: "m-1", visit_id: visit.id }),
    ev("precheck.completed", { red_flag: null, scope: "ok", duration_ms: 2 }),
    ev("run.started", { run_id: "r-1", model: "model-a" }),
    ev("tool.started", { call_id: "c-1", step: 1, name: "record_intake", source: "model", arguments: { patch: { chief_complaint: "咳嗽" } } }),
    ev("tool.completed", { call_id: "c-1", step: 1, name: "record_intake", status: "ok", result: { applied: ["chief_complaint"] }, duration_ms: 12 }),
    ev("intake.updated", {
      state: started.intake?.state ?? null,
      stage: "hpi",
      missing: ["hpi.onset"],
      progress: { done: 1, total: 11 },
    }),
    ev("message.delta", { text: "了解，" }),
    ev("message.delta", { text: "請問從什麼時候開始？" }),
  ]);
  assert.equal(s.streaming?.text, "了解，請問從什麼時候開始？");
  assert.equal(s.messages.at(-1)?.id, "m-1");
  assert.equal(s.messages.at(-1)?.pending, false);

  s = replay(s, [
    ev("message.completed", { message_id: "m-2", kind: "chat", content: "了解，請問從什麼時候開始？", run_id: "r-1" }),
    ev("run.completed", { run_id: "r-1", status: "completed", steps: 2, usage: { input_tokens: 900, output_tokens: 40 }, model: "model-a" }),
  ]);
  assert.equal(s.busy, false);
  assert.equal(s.streaming, null);
  assert.equal(s.messages.at(-1)?.role, "assistant");
  assert.equal(s.visit?.stage, "hpi");
  assert.deepEqual(s.runs[0].usage, { input_tokens: 900, output_tokens: 40 });
  assert.equal(s.runs[0].model, "model-a");

  // Precheck rows were created before run.started and now belong to run r-1.
  const names = s.trace.map((r) => `${r.name}:${r.run_id}:${r.status}`);
  assert.deepEqual(names, [
    "red_flag_precheck:r-1:ok",
    "scope_precheck:r-1:ok",
    "record_intake:r-1:ok",
  ]);
  const groups = groupTrace(s.trace, s.runs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].run?.model, "model-a");
});

test("a red flag turn has no run.started, still gets a skipped run and a persistent card", () => {
  let s = sent(started, "我胸口悶痛");
  s = replay(s, [
    ev("message.accepted", { message_id: "m-1", visit_id: visit.id }),
    ev("precheck.completed", {
      red_flag: { category: "chest_pain", label: "胸痛", matched_at: "2026-11-25T08:01:00Z", message_id: "m-1" },
      scope: "ok",
      duration_ms: 1,
    }),
    ev("redflag.triggered", { category: "chest_pain", label: "胸痛", message_id: "m-1" }),
    ev("ticket.created", { id: "t-1", ticket_no: "T-20261125-0001", visit_id: visit.id, reason: "red_flag", urgency: "urgent", summary: "x", status: "open", created_by: "code", created_at: "2026-11-25T08:01:00Z", resolved_at: null, resolved_by: null, resolution_note: null }),
    ev("message.completed", { message_id: "m-2", kind: "red_flag", content: "請立即撥打 119", run_id: "r-9" }),
    ev("run.completed", { run_id: "r-9", status: "skipped", steps: 0, usage: { input_tokens: 0, output_tokens: 0 }, model: "rules" }),
  ]);
  assert.equal(s.redFlag?.category, "chest_pain");
  assert.equal(s.visit?.status, "red_flag");
  assert.equal(s.tickets.length, 1);
  assert.equal(s.runs[0].status, "skipped");
  assert.equal(s.busy, false);
  assert.ok(s.trace.every((r) => r.run_id === "r-9"));
  assert.equal(s.messages.at(-1)?.kind, "red_flag");
});

test("run.failed clears busy and records the failure code", () => {
  let s = sent(started, "hi");
  s = replay(s, [
    ev("message.accepted", { message_id: "m-1", visit_id: visit.id }),
    ev("precheck.completed", { red_flag: null, scope: "ok", duration_ms: 1 }),
    ev("run.failed", { run_id: "r-2", code: "daily_budget_exceeded", message: "額度已用完" }),
  ]);
  assert.equal(s.busy, false);
  assert.equal(s.failure?.code, "daily_budget_exceeded");
  assert.equal(s.runs[0].status, "failed");
});

test("tool.completed without a started row still creates one; running rows show as running", () => {
  let s = sent(started, "hi");
  s = replay(s, [
    ev("run.started", { run_id: "r-1", model: "m" }),
    ev("tool.started", { call_id: "c-1", step: 1, name: "search_health_education", source: "model", arguments: { query: "x" } }),
  ]);
  assert.equal(s.trace.at(-1)?.status, "running");
  s = replay(s, [ev("tool.completed", { call_id: "c-9", step: 2, name: "output_guard", status: "ok", result: null, duration_ms: 3 })]);
  assert.equal(s.trace.length, 2);
  assert.equal(s.trace.at(-1)?.name, "output_guard");
});

test("guard.rewrote is recorded; unknown event types are ignored", () => {
  let s = sent(started, "hi");
  s = replay(s, [ev("run.started", { run_id: "r-1", model: "m" }), ev("guard.rewrote", { kind: "dosage", action: "replaced" }), ev("something.new", { a: 1 })]);
  assert.deepEqual(s.guards, [{ run_id: "r-1", kind: "dosage", action: "replaced" }]);
});

test("send_failed keeps the patient text but flags it, and the next send removes the failed copy", () => {
  let s = sent(started, "第一則");
  s = visitReducer(s, { type: "send_failed", failure: { code: "network", message: "offline" } });
  assert.equal(s.messages.at(-1)?.failed, true);
  assert.equal(s.busy, false);
  s = sent(s, "第一則");
  assert.equal(s.messages.filter((m) => m.role === "patient").length, 1);
  assert.equal(s.failure, null);
});

test("loaded replaces everything from the server detail; closed visits are detected", () => {
  const submitted: Visit = { ...visit, status: "submitted" };
  assert.equal(isClosed(submitted), true);
  assert.equal(isClosed({ ...visit, status: "red_flag" }), false);
  assert.equal(isClosed(null), false);
});

test("form-sourced tool calls without a run share one group", () => {
  const groups = groupTrace(
    [
      { id: "a", run_id: null, step: 1, name: "check_chronic_refill", source: "form", status: "ok", arguments: {}, result: {}, duration_ms: 3, created_at: "x" },
      { id: "b", run_id: "r", step: 1, name: "record_intake", source: "model", status: "ok", arguments: {}, result: {}, duration_ms: 3, created_at: "x" },
    ],
    [],
  );
  assert.deepEqual(groups.map((g) => g.key), ["form", "r"]);
});
