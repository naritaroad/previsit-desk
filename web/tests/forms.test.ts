// Refill-form validation, intake helpers, composer rules, formatting.

import assert from "node:assert/strict";
import { test } from "node:test";

import { charCount, composerBlock, counterState, shouldSendOnKey } from "../src/lib/composer.ts";
import { addDays, formatDuration, isValidDate, todayInTaipei } from "../src/lib/format.ts";
import { EMPTY_INTAKE, INTAKE_FIELDS, intakeRows, isNotApplicable, progressPercent } from "../src/lib/intake.ts";
import { defaultRefillForm, hasErrors, serverFieldErrors, toRefillInput, validateRefillForm } from "../src/lib/refillForm.ts";
import { isVisitId } from "../src/lib/storage.ts";

const TODAY = "2026-11-25";

test("default refill form is valid and produces a contract-shaped input without a today override", () => {
  const form = defaultRefillForm(TODAY);
  assert.equal(form.last_fill_date, "2026-11-01");
  assert.deepEqual(validateRefillForm(form, TODAY), {});
  const input = toRefillInput(form);
  assert.equal(input.total_days, 90);
  assert.equal(input.fills_done, 1);
  assert.equal("today" in input, false);
});

test("today override is sent only when switched on", () => {
  const form = { ...defaultRefillForm(TODAY), use_today_override: true, today_override: "2026-12-15" };
  assert.equal(toRefillInput(form).today, "2026-12-15");
  assert.equal("today" in toRefillInput({ ...form, use_today_override: false }), false);
});

test("validation: required, bad dates, ranges, order", () => {
  const base = defaultRefillForm(TODAY);
  assert.equal(validateRefillForm({ ...base, prescription_date: "" }, TODAY).prescription_date, "required");
  assert.equal(validateRefillForm({ ...base, last_fill_date: "2026-02-30" }, TODAY).last_fill_date, "bad_date");
  assert.equal(validateRefillForm({ ...base, total_days: "abc" }, TODAY).total_days, "bad_number");
  assert.equal(validateRefillForm({ ...base, total_days: "" }, TODAY).total_days, "required");
  assert.equal(validateRefillForm({ ...base, fills_done: "4" }, TODAY).fills_done, "fills_range");
  assert.equal(validateRefillForm({ ...base, fills_done: "3" }, TODAY).fills_done, undefined); // 3 = all fills used, the server answers revisit
  assert.equal(validateRefillForm({ ...base, days_per_fill: "45", total_days: "30" }, TODAY).days_per_fill, "per_fill_exceeds_total");
  assert.equal(validateRefillForm({ ...base, last_fill_date: "2026-12-30" }, TODAY).last_fill_date, "after_today");
  assert.equal(validateRefillForm({ ...base, prescription_date: "2026-11-10", last_fill_date: "2026-11-01" }, TODAY).last_fill_date, "before_prescription");
  assert.equal(hasErrors(validateRefillForm({ ...base, total_days: "-5" }, TODAY)), true);
});

test("a 120-day prescription is not blocked on the client (the server answers revisit)", () => {
  const errors = validateRefillForm({ ...defaultRefillForm(TODAY), total_days: "120" }, TODAY);
  assert.deepEqual(errors, {});
});

test("an overridden today moves the 'not in the future' check", () => {
  const form = { ...defaultRefillForm(TODAY), last_fill_date: "2026-12-01", prescription_date: "2026-12-01" };
  assert.equal(validateRefillForm(form, TODAY).last_fill_date, "after_today");
  assert.deepEqual(validateRefillForm({ ...form, use_today_override: true, today_override: "2026-12-10" }, TODAY), {});
});

test("server field names map to form errors", () => {
  assert.deepEqual(serverFieldErrors({ last_fill_date: "bad", total_days: "bad", unknown: "x", today: "bad" }), {
    last_fill_date: "bad_date",
    total_days: "bad_number",
    today_override: "bad_date",
  });
});

test("date helpers", () => {
  assert.equal(todayInTaipei(new Date("2026-11-24T17:00:00Z")), "2026-11-25"); // 01:00 next day in Taipei
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(isValidDate("2026-02-29"), false);
  assert.equal(isValidDate("2028-02-29"), true);
  assert.equal(formatDuration(840), "840 ms");
  assert.equal(formatDuration(1240), "1.2 s");
  assert.equal(formatDuration(null), "—");
});

test("intake rows: missing, filled, not applicable, answered-none", () => {
  const view = structuredClone(EMPTY_INTAKE);
  view.state.chief_complaint = "咳嗽";
  view.state.hpi.location = "不適用";
  view.state.hpi.severity = 4;
  view.state.allergies = { answered: true, items: [] };
  view.state.medications = { answered: true, items: ["降血壓藥", "胃藥"] };
  const rows = Object.fromEntries(intakeRows(view.state).map((r) => [r.key, r]));
  assert.equal(rows["chief_complaint"].status, "filled");
  assert.equal(rows["hpi.location"].status, "na");
  assert.equal(rows["hpi.severity"].value, "4 / 10");
  assert.equal(rows["allergies"].status, "none");
  assert.equal(rows["medications"].value, "降血壓藥、胃藥");
  assert.equal(rows["past_history"].status, "missing");
  assert.equal(intakeRows(view.state).length, INTAKE_FIELDS.length);
  assert.equal(isNotApplicable(" N/A "), true);
});

test("progress percent is clamped and safe for empty totals", () => {
  assert.equal(progressPercent(null), 0);
  assert.equal(progressPercent({ progress: { done: 3, total: 11 } }), 27);
  assert.equal(progressPercent({ progress: { done: 20, total: 11 } }), 100);
  assert.equal(progressPercent({ progress: { done: 0, total: 0 } }), 0);
});

test("composer: counts code points, blocks empty / too long / busy / closed", () => {
  assert.equal(charCount("胸痛"), 2);
  assert.equal(charCount("a😀b"), 3);
  assert.equal(composerBlock("   ", 800, false, false), "empty");
  assert.equal(composerBlock("x".repeat(801), 800, false, false), "too_long");
  assert.equal(composerBlock("x".repeat(800), 800, false, false), null);
  assert.equal(composerBlock("hi", 800, true, false), "busy");
  assert.equal(composerBlock("hi", 800, false, true), "closed");
  assert.equal(counterState(100, 800), "ok");
  assert.equal(counterState(720, 800), "near");
  assert.equal(counterState(801, 800), "over");
});

test("Enter sends, Shift+Enter and IME composition do not", () => {
  assert.equal(shouldSendOnKey({ key: "Enter", shiftKey: false }), true);
  assert.equal(shouldSendOnKey({ key: "Enter", shiftKey: true }), false);
  assert.equal(shouldSendOnKey({ key: "Enter", shiftKey: false, isComposing: true }), false);
  assert.equal(shouldSendOnKey({ key: "Enter", shiftKey: false, keyCode: 229 }), false);
  assert.equal(shouldSendOnKey({ key: "a", shiftKey: false }), false);
});

test("only UUIDs are trusted as a stored visit id", () => {
  assert.equal(isVisitId("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(isVisitId("../../etc/passwd"), false);
  assert.equal(isVisitId(null), false);
});
