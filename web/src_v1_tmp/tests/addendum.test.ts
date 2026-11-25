// Contract section 7 rules: intake sentinel and key order, emergency card, stream replacement,
// trace shapes, error mapping.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "../src/api/client.ts";
import type { StreamEnvelope, Visit } from "../src/api/types.ts";
import { describeApiError, describeFailure } from "../src/lib/errors.ts";
import { EMPTY_INTAKE, INTAKE_FIELDS, intakeRows, isCoreField, progressPercent, splitMissing } from "../src/lib/intake.ts";
import { isRedFlagHitResult, piiMasked, traceBrief } from "../src/lib/trace.ts";
import { composerMode, initialVisitState, isSent, redFlagText, showEmergency, visitReducer, type VisitState } from "../src/state/visitReducer.ts";

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
const replay = (start: VisitState, events: StreamEnvelope[]) =>
  events.reduce((s, envelope) => visitReducer(s, { type: "stream", envelope, at: "2026-11-25T08:01:00Z" }), start);
const started = visitReducer(initialVisitState, { type: "created", visit, messages: [] });
const sent = (state: VisitState, text: string) =>
  visitReducer(state, { type: "patient_sent", localId: "local-1", content: text, at: "2026-11-25T08:01:00Z" });

test("severity n/a counts as collected and the sentinel string shows as not applicable", () => {
  const view = structuredClone(EMPTY_INTAKE);
  view.state.hpi.severity = "n/a";
  view.state.hpi.location = "不適用";
  const rows = Object.fromEntries(intakeRows(view.state).map((r) => [r.key, r]));
  assert.equal(rows["hpi.severity"].status, "na");
  assert.equal(rows["hpi.location"].status, "na");
});

test("keys follow the contract order; missing splits into required and suggested", () => {
  assert.deepEqual([...INTAKE_FIELDS], [
    "chief_complaint",
    "hpi.onset",
    "hpi.course",
    "hpi.location",
    "hpi.character",
    "hpi.severity",
    "hpi.modifiers",
    "hpi.associated",
    "past_history",
    "medications",
    "allergies",
  ]);
  assert.equal(isCoreField("hpi.location"), false);
  assert.equal(isCoreField("hpi.severity"), true);
  assert.deepEqual(splitMissing(["hpi.location", "allergies", "hpi.modifiers"]), {
    required: ["allergies"],
    suggested: ["hpi.location", "hpi.modifiers"],
  });
  assert.equal(progressPercent({ progress: { done: 8, total: 11 } }), 73);
});

test("precheck rows use the contract shapes (chars / hit / verdict)", () => {
  let s = sent(started, "我咳嗽");
  s = replay(s, [ev("precheck.completed", { red_flag: null, scope: "prescription_request", duration_ms: 2 })]);
  const rf = s.trace.find((r) => r.name === "red_flag_precheck");
  const sc = s.trace.find((r) => r.name === "scope_precheck");
  assert.deepEqual(rf?.arguments, { chars: 3 });
  assert.deepEqual(rf?.result, { hit: false });
  assert.deepEqual(sc?.result, { verdict: "prescription_request" });
});

test("red flag in canonical order: the card follows red_flag, not status, and survives closed screens", () => {
  let s = sent(started, "胸痛");
  s = replay(s, [
    ev("message.accepted", { message_id: "m-1", visit_id: visit.id }),
    ev("precheck.completed", {
      red_flag: { category: "chest_pain", label: "胸痛", matched_at: "2026-11-25T08:01:00Z", message_id: "m-1" },
      scope: "ok",
      duration_ms: 1,
    }),
    ev("redflag.triggered", { category: "chest_pain", label: "胸痛", message_id: "m-1" }),
    ev("message.completed", { message_id: "m-2", kind: "red_flag", content: "請立即撥打 119", run_id: "r-1" }),
    ev("visit.updated", { ...visit, status: "red_flag" }),
    ev("run.completed", { run_id: "r-1", status: "skipped", steps: 0, usage: { input_tokens: 0, output_tokens: 0 }, model: "rules" }),
  ]);
  assert.equal(showEmergency(s), true);
  assert.equal(composerMode(s.visit), "paused");
  assert.equal(redFlagText(s.messages), "請立即撥打 119");
  assert.equal(s.busy, false);

  const detail = (status: Visit["status"], red_flag: typeof s.redFlag) => ({
    visit: { ...visit, status },
    messages: s.messages,
    intake: s.intake ?? EMPTY_INTAKE,
    summary: null,
    red_flag,
    tickets: [],
    tool_calls: [],
    runs: [],
    refill_checks: [],
  });
  // The doctor reviewed it: status is reviewed, the server still reports the latest hit.
  const reviewed = visitReducer(s, { type: "loaded", detail: detail("reviewed", s.redFlag) });
  assert.equal(showEmergency(reviewed), true);
  assert.equal(composerMode(reviewed.visit), "closed");
  // No hit reported: no card, whatever the status says.
  const none = visitReducer(reviewed, { type: "loaded", detail: detail("red_flag", null) });
  assert.equal(showEmergency(none), false);
});

test("message.completed replaces the streamed text", () => {
  let s = sent(started, "hi");
  s = replay(s, [
    ev("run.started", { run_id: "r-1", model: "m" }),
    ev("message.delta", { text: "草稿文字" }),
    ev("message.completed", { message_id: "m-2", kind: "chat", content: "守門後的正式文字", run_id: "r-1" }),
  ]);
  assert.equal(s.streaming, null);
  assert.equal(s.messages.at(-1)?.content, "守門後的正式文字");
});

test("pii_filter masking is remembered for the turn and cleared on the next send", () => {
  let s = sent(started, "我的電話是 0912345678");
  s = replay(s, [
    ev("run.started", { run_id: "r-1", model: "m" }),
    ev("tool.completed", { call_id: "p-1", step: 0, name: "pii_filter", status: "ok", result: { masked: 1, kinds: ["phone"] }, duration_ms: 1 }),
  ]);
  assert.equal(s.piiMasked, 1);
  assert.equal(sent(s, "好").piiMasked, 0);
});

test("a submitted red_flag visit counts as sent but stays paused", () => {
  const v: Visit = { ...visit, status: "red_flag", submitted_at: "2026-11-25T09:00:00Z" };
  assert.equal(isSent(v), true);
  assert.equal(composerMode(v), "paused");
  assert.equal(isSent(visit), false);
});

test("every documented tool shape gets a brief; unknown names and shapes return null", () => {
  assert.equal(traceBrief("red_flag_precheck", { hit: false })?.key, "trace.brief.redFlagNone");
  assert.deepEqual(traceBrief("red_flag_precheck", { hit: true, category: "chest_pain", label: "胸痛", rule_id: "r1" }), {
    key: "trace.brief.redFlagHit",
    params: { label: "胸痛" },
  });
  assert.equal(traceBrief("scope_precheck", { verdict: "injection" })?.key, "trace.brief.scopeInjection");
  assert.deepEqual(traceBrief("pii_filter", { masked: 2, kinds: ["phone", "id"] })?.params, { count: 2, kinds: "phone、id" });
  assert.deepEqual(traceBrief("record_intake", { applied: ["a", "b"], rejected: [{ field: "x", reason: "pii" }] })?.params, {
    applied: 2,
    rejected: 1,
  });
  assert.equal(traceBrief("search_health_education", { hits: [] })?.key, "trace.brief.searchNone");
  assert.equal(traceBrief("search_health_education", { hits: [{ section: "1" }] })?.params?.count, 1);
  assert.equal(traceBrief("check_chronic_refill", { outcome: "too_early" })?.key, "trace.brief.refillTooEarly");
  assert.equal(traceBrief("transfer_to_clinician", { ticket_no: "T-1", deduped: true })?.key, "trace.brief.transferDeduped");
  assert.equal(traceBrief("save_previsit_summary", { saved: true, not_collected: ["allergies"] })?.params?.count, 1);
  assert.equal(traceBrief("output_guard", { passed: true, violations: [], action: "none" })?.key, "trace.brief.guardPass");
  assert.equal(traceBrief("output_guard", { passed: false, violations: ["dosage"], action: "replaced" })?.key, "trace.brief.guardReplaced");
  assert.equal(traceBrief("brand_new_tool", { x: 1 }), null);
  assert.equal(traceBrief("record_intake", null), null);
  assert.equal(traceBrief("scope_precheck", { verdict: "something_new" }), null);
});

test("red-flag hit and pii helpers", () => {
  assert.equal(isRedFlagHitResult({ hit: true }), true);
  assert.equal(isRedFlagHitResult({ hit: false }), false);
  assert.equal(isRedFlagHitResult(null), false);
  assert.equal(piiMasked({ masked: 3 }), 3);
  assert.equal(piiMasked("x"), 0);
});

test("API errors map to copy keys, including the new codes", () => {
  assert.equal(describeApiError(new ApiError(429, "rate_limited", "x", {}, 45)).params?.seconds, 45);
  assert.equal(describeApiError(new ApiError(429, "rate_limited", "x")).params?.seconds, 30);
  assert.equal(describeApiError(new ApiError(409, "conflict", "x")).key, "errors.conflict");
  assert.equal(describeApiError(new ApiError(409, "invalid_state", "x")).key, "errors.invalidState");
  assert.equal(describeApiError(new ApiError(0, "offline", "x")).retryable, true);
  assert.equal(describeApiError(new ApiError(415, "unsupported_media_type", "x")).key, "errors.internal");
  assert.equal(describeApiError(new Error("boom")).key, "errors.internal");
  assert.equal(describeFailure({ code: "daily_budget_exceeded", message: "" }).key, "errors.budget");
  assert.equal(describeFailure({ code: "timeout", message: "" }).retryable, true);
});
