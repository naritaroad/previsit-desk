// Pure helpers: dates and numbers, permissions, links, rx rules, intake rows, trace, reducer, copy files.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ApiError } from "../src/api/errors.ts";
import type { Message, PrevisitSummary, ProtocolQuestion, RxRequest, Ticket, VisitDetail } from "../src/api/types.ts";
import { charCount, composerBlock, composerMode, counterState, shouldSendOnKey } from "../src/lib/composer.ts";
import { jsonEqual } from "../src/lib/equal.ts";
import { applyFieldErrors, describeError, describeRunFailure, fieldMessage } from "../src/lib/errors.ts";
import * as f from "../src/lib/format.ts";
import { isUuid, uuid } from "../src/lib/ids.ts";
import { applySummaryChanges, EMPTY_INTAKE, intakeRows, summaryRows } from "../src/lib/intake.ts";
import { isInternalLink, notificationGroup, rxPath, safeExternalUrl, safeNext, visitPath } from "../src/lib/links.ts";
import { can, canAny, canEnter, homePath, portalOfPath, ROLE_PERMISSIONS } from "../src/lib/permissions.ts";
import { defaultRefillForm, futureDateErrors, toRefillInput } from "../src/lib/refillForm.ts";
import { allows, askedQuestions, currentStep, identityKey, missingForSubmit, monitoringAge, rxProgress, rxStatusMeta, stepsFor, worstDisposition } from "../src/lib/rx.ts";
import { groupTrace, handbookHits, ticketForMessage, traceBrief, type RunView, type TraceRow } from "../src/lib/trace.ts";
import { failureBannerVisible, initialVisitState, redFlagText, visitReducer } from "../src/lib/visitState.ts";

const NOW = new Date("2026-11-25T06:05:00Z"); // 14:05 in Taipei, a Wednesday

describe("dates and numbers", () => {
  it("shows Taipei time wherever the browser is", () => {
    expect(f.taipeiDate("2026-11-24T16:30:00Z")).toBe("2026-11-25");
    expect(f.formatTime("2026-11-24T16:30:00Z", "zh-TW")).toBe("00:30");
    expect(f.formatTime("2026-11-24T16:30:00Z", "en")).toBe("00:30");
    expect(f.taipeiInstant("2026-11-26", "09:30")).toBe("2026-11-26T01:30:00Z");
    expect(f.fromLocalInput(f.toLocalInput("2026-11-26T01:30:00Z"))).toBe("2026-11-26T01:30:00Z");
  });
  it("date styles in both languages", () => {
    const d = "2026-11-25";
    expect(f.formatDate(d, "zh-TW", "full")).toBe("2026年11月25日（週三）");
    expect(f.formatDate(d, "zh-TW", "long")).toBe("2026年11月25日");
    expect(f.formatDate(d, "zh-TW", "medium")).toBe("11月25日（三）");
    expect(f.formatDate(d, "zh-TW", "short")).toBe("2026/11/25");
    expect(f.formatDate(d, "en", "long")).toBe("November 25, 2026");
    expect(f.formatDate(d, "en", "medium")).toBe("Wed, Nov 25");
    expect(f.formatDate(null, "en")).toBe("—");
    expect(f.formatDateTime("2026-11-25T06:05:00Z", "zh-TW", NOW)).toBe("11月25日（三）14:05");
    expect(f.formatDateTime("2025-11-25T06:05:00Z", "zh-TW", NOW)).toBe("2025/11/25 14:05");
    expect(f.formatDateRange("2026-11-25", "2026-12-05", "zh-TW")).toBe("11月25日～12月5日");
  });
  it("relative time", () => {
    const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
    expect(f.formatRelative(at(0), "zh-TW", NOW)).toBe("剛剛");
    expect(f.formatRelative(at(-5), "zh-TW", NOW)).toContain("5 分鐘前");
    expect(f.formatRelative(at(-180), "en", NOW)).toBe("3 hours ago");
    expect(f.formatRelative(at(-1440), "zh-TW", NOW)).toBe("昨天");
    expect(f.formatRelative(at(-60 * 24 * 30), "zh-TW", NOW)).toBe("10月26日");
    expect(f.formatRelativeDay("2026-11-28", "zh-TW", "2026-11-25")).toContain("3 天後");
    expect(f.untilParts(at(-90), NOW)).toEqual({ past: true, days: 0, hours: 1, minutes: 30 });
    expect(f.formatSpan(at(200), "zh-TW", NOW)).toContain("3");
  });
  it("calendar arithmetic", () => {
    expect(f.addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(f.daysBetween("2026-11-25", "2026-12-05")).toBe(10);
    expect([f.isValidDate("2026-02-29"), f.isValidDate("2028-02-29"), f.isValidDate("26-1-1")]).toEqual([false, true, false]);
    expect(f.ageFrom(1964, "2026-11-25")).toBe(62);
  });
  it("numbers", () => {
    expect(f.formatPercent(0.923, "zh-TW")).toBe("92%");
    expect(f.formatPercent(null, "en")).toBe("—");
    expect(f.formatUsd(0.0123, "en")).toBe("$0.0123");
    expect(f.formatUsd(20, "zh-TW")).toBe("$20.00");
    expect(f.formatCompact(12_000, "zh-TW")).toContain("1.2");
    expect([f.formatDuration(840), f.formatDuration(1240), f.formatDuration(125_000), f.formatDuration(null)]).toEqual(["840 ms", "1.2 s", "2 min 5 s", "—"]);
    expect(f.truncate("胸口悶痛😀已經兩小時", 5)).toBe("胸口悶痛…");
    expect(f.prettyJson({ a: 1n })).toBe("[object Object]");
  });
});

describe("permissions and links", () => {
  const me = { permissions: [...ROLE_PERMISSIONS.coordinator], role: "coordinator" as const };
  it("can", () => {
    expect(can(me, "visit.read", "patient.manage")).toBe(true);
    expect(can(me, "visit.read", "note.sign")).toBe(false);
    expect(canAny(me, "note.sign", "thread.reply")).toBe(true);
    expect(can(null, "visit.read")).toBe(false);
  });
  it("each role enters its own workspace only", () => {
    expect(homePath(me)).toBe("/clinic");
    expect([portalOfPath("/app/visits"), portalOfPath("/apple"), portalOfPath("/")]).toEqual(["patient", "public", "public"]);
    expect([canEnter(me, "/clinic/rx/1"), canEnter(me, "/admin"), canEnter(me, "/trust"), canEnter(null, "/app")]).toEqual([true, false, true, false]);
  });
  it("links from the server must stay inside the site", () => {
    expect(["/app/rx/1", "//evil.example", "/\\evil", "https://evil.example", "javascript:alert(1)", "/a\n/b", null].map((l) => isInternalLink(l))).toEqual([true, false, false, false, false, false, false]);
    expect([safeNext("/clinic/visits/1", "/"), safeNext("//x", "/"), safeNext("/login?next=/app", "/app")]).toEqual(["/clinic/visits/1", "/", "/app"]);
    expect([safeExternalUrl("https://www.mohw.gov.tw/"), safeExternalUrl("javascript:1"), safeExternalUrl("")]).toEqual(["https://www.mohw.gov.tw/", null, null]);
    expect([rxPath("pharmacist", "1"), rxPath("patient", "1"), visitPath("physician", "a/b")]).toEqual(["/pharmacy/rx/1", "/app/rx/1", "/clinic/visits/a%2Fb"]);
    expect([notificationGroup("red_flag"), notificationGroup("refill.window_open"), notificationGroup("new.kind")]).toEqual(["emergency", "rx", "other"]);
  });
  it("ids", () => {
    expect(isUuid(uuid())).toBe(true);
    expect(isUuid("x")).toBe(false);
    expect(jsonEqual({ a: [1, { b: null }], c: undefined }, { a: [1, { b: null }] })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
  });
});

describe("errors", () => {
  it("every code has its own words", () => {
    expect(describeError(new ApiError({ status: 429, code: "rate_limited", retryAfter: 9 }))).toEqual({ key: "errors:rateLimited", params: { seconds: 9 }, retryable: true });
    expect(describeError(new ApiError({ status: 409, code: "conflict" })).key).toBe("errors:busy");
    expect(describeError(new ApiError({ status: 409, code: "conflict", current: {} })).key).toBe("errors:stale");
    expect(describeError(new Error("x")).key).toBe("errors:internal");
    expect(describeRunFailure("interrupted")).toEqual({ key: "errors:run.interrupted", params: {}, retryable: true });
    expect(describeRunFailure("something new").key).toBe("errors:run.unknown");
  });
  it("field messages go to inputs, the rest is returned", () => {
    const set: string[] = [];
    const rest = applyFieldErrors(new ApiError({ status: 422, code: "invalid_request", fields: { username: "已有人使用", other: "別的" } }), ["username", "password"], (n, e) => set.push(`${n}:${e.message}`));
    expect(set).toEqual(["username:已有人使用"]);
    expect(rest).toEqual(["別的"]);
    expect(fieldMessage((k) => `t(${k})`, "field.required")).toBe("t(errors:field.required)");
    expect(fieldMessage((k) => k, "伺服器的句子")).toBe("伺服器的句子");
  });
});

describe("rx rules", () => {
  const q = (id: string, o: Partial<ProtocolQuestion> = {}): ProtocolQuestion => ({ id, scope: "general", class_id: null, kind: "boolean", label: id, help: null, options: [], unit: null, min: null, max: null, required: true, max_age_days: null, ...o });
  const base = {
    kind: "renewal",
    items: [{ id: "i1", scope: "in_scope" }],
    answers: {},
    monitoring: {},
    questions: [q(identityKey("i1")), q("side_effects"), q("last_seen_days", { kind: "number" }), q("home_sbp", { kind: "number", min: 50, max: 300, scope: "class" }), q("a1c", { scope: "monitoring", kind: "number", required: false })],
    pharmacy: null,
    pickup_window: null,
  } as unknown as RxRequest;
  const ids = (rx: RxRequest) => missingForSubmit(rx, "2026-11-25").map((m) => `${m.step}:${m.id}:${m.reason}`);

  it("lists what is missing in step order, without the values the server computes", () => {
    expect(askedQuestions(base).map((x) => x.id)).toEqual(["side_effects", "home_sbp"]);
    expect(ids(base)).toEqual([`identity:${identityKey("i1")}:required`, "safety:side_effects:required", "safety:home_sbp:required", "pharmacy:pharmacy:required"]);
    const done = { ...base, answers: { [identityKey("i1")]: true, side_effects: false, home_sbp: 500 }, monitoring: { a1c: { value: 7, date: "2026-12-01", source: "patient" } }, pharmacy: { id: "p" } } as unknown as RxRequest;
    expect(ids(done)).toEqual(["safety:home_sbp:range", "monitoring:a1c:future"]);
  });
  it("a refill needs its questions, a pharmacy and a coming pickup time", () => {
    const refill = { ...base, kind: "refill", questions: [q("symptom_changed")] } as unknown as RxRequest;
    expect(ids(refill)).toEqual(["safety:symptom_changed:required", "pickup:pharmacy:required", "pickup:pickup_window:required"]);
    const late = { ...refill, answers: { symptom_changed: false }, pharmacy: { id: "p" }, pickup_window: { date: "2026-11-24", slot: "morning" } } as unknown as RxRequest;
    expect(ids(late)).toEqual(["pickup:pickup_window:range"]);
  });
  it("steps and progress", () => {
    expect(stepsFor("refill")).toEqual(["items", "safety", "pickup", "review"]);
    expect(currentStep({ kind: "renewal", step: "from-a-newer-version" })).toBe("items");
    expect(rxProgress("renewal", "more_info")).toMatchObject({ index: 1, left: false });
    expect(rxProgress("refill", "dispensed").index).toBe(3);
    expect(rxProgress("renewal", "declined").left).toBe(true);
    expect(worstDisposition(["ready", "in_person", "review"])).toBe("in_person");
    expect(rxStatusMeta("returned")).toMatchObject({ labelKey: "rx:status.returned", tone: "warning" });
    expect(allows({ allowed_actions: ["edit", "new_thing"] }, "edit")).toBe(true);
    expect(allows(null, "edit")).toBe(false);
  });
  it("age of a reading", () => {
    const m = q("a1c", { max_age_days: 183 });
    expect(monitoringAge(m, { date: "2026-11-01", source: "patient" }, "2026-11-25")).toEqual({ days: 24, stale: false });
    expect(monitoringAge(m, { date: "2026-01-01", source: "patient" }, "2026-11-25")?.stale).toBe(true);
    expect(monitoringAge(m, undefined, "2026-11-25")).toBeNull();
  });
  it("standalone refill form", () => {
    const form = defaultRefillForm("2026-11-25");
    expect(form.last_fill_date).toBe("2026-11-01");
    expect(toRefillInput(form)).toMatchObject({ total_days: 90, fills_done: 1 });
    expect(futureDateErrors({ ...form, last_fill_date: "2026-12-01" }, "2026-11-25")).toEqual({ last_fill_date: "field.future" });
  });
});

describe("composer", () => {
  it("rules", () => {
    expect(charCount("頭痛😀")).toBe(3);
    expect([composerBlock(" ", 10, false), composerBlock("12345678901", 10, false), composerBlock("ok", 10, true), composerBlock("ok", 10, false)]).toEqual(["empty", "too_long", "closed", null]);
    expect([counterState(5, 10), counterState(9, 10), counterState(11, 10)]).toEqual(["ok", "near", "over"]);
    expect(shouldSendOnKey({ key: "Enter", shiftKey: false })).toBe(true);
    expect(shouldSendOnKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSendOnKey({ key: "Enter", shiftKey: false, keyCode: 229 })).toBe(false);
    expect(composerMode({ status: "reviewed", mode: "human" })).toBe("human");
    expect(composerMode({ status: "red_flag", mode: "ai" })).toBe("paused");
    expect(composerMode({ status: "submitted", mode: "ai" })).toBe("closed");
  });
});

describe("intake and summary", () => {
  const summary = {
    chief_complaint: "頭痛",
    hpi: { onset: "三天前", modifiers: null, character: "不適用", location: null, severity: "n/a", course: null, associated: null },
    past_history: [],
    medications: ["甲", "乙"],
    allergies: [],
    not_collected: ["hpi.modifiers", "hpi.location", "hpi.course", "hpi.associated", "allergies"],
    patient_questions: [],
    evidence: { chief_complaint: ["m1"] },
    revision: 2,
    edited_by_patient: false,
  } as unknown as PrevisitSummary;
  it("rows say filled, none, not applicable or missing, with their evidence", () => {
    const rows = Object.fromEntries(summaryRows(summary).map((r) => [r.key, r]));
    expect(rows.chief_complaint).toMatchObject({ status: "filled", evidence: ["m1"] });
    expect(rows["hpi.character"].status).toBe("na");
    expect(rows["hpi.severity"].status).toBe("na");
    expect(rows.past_history.status).toBe("none");
    expect(rows.medications).toMatchObject({ value: "甲、乙", items: ["甲", "乙"] });
    expect(rows.allergies.status).toBe("missing");
    expect(intakeRows(EMPTY_INTAKE.state).every((r) => r.status === "missing")).toBe(true);
  });
  it("a patient edit fills and clears fields", () => {
    const next = applySummaryChanges(summary, { "hpi.location": "右側", "hpi.onset": null, allergies: [] });
    expect(next.hpi).toMatchObject({ location: "右側", onset: null });
    expect(next.not_collected).toEqual(["hpi.onset", "hpi.course", "hpi.modifiers", "hpi.associated"]);
    expect(next.edited_by_patient).toBe(true);
    expect(summary.hpi.onset).toBe("三天前");
  });
});

describe("trace", () => {
  const row = (id: string, run_id: string | null, name: TraceRow["name"], created_at: string): TraceRow => ({ id, run_id, step: 0, name, source: "code", status: "ok", arguments: {}, result: {}, duration_ms: 1, created_at });
  const run = (id: string, created_at: string): RunView => ({ id, model: "m", fallback_used: false, status: "completed", steps: 1, usage: { input_tokens: 1, output_tokens: 1 }, error_code: null, duration_ms: 1, created_at });
  it("prechecks join the run that follows; form checks stay apart; empty runs show", () => {
    const groups = groupTrace([row("a", null, "red_flag_precheck", "2026-11-25T08:00:00Z"), row("b", "r1", "record_intake", "2026-11-25T08:00:02Z"), row("c", null, "check_chronic_refill", "2026-11-25T08:01:00Z")], [run("r1", "2026-11-25T08:00:01Z"), run("r2", "2026-11-25T09:00:00Z")]);
    expect(groups.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([["r1", ["a", "b"]], ["form", ["c"]], ["r2", []]]);
  });
  it("briefs", () => {
    expect(traceBrief("red_flag_precheck", { hit: true, label: "胸痛" })).toEqual({ key: "rx:trace.redFlagHit", params: { label: "胸痛" } });
    expect(traceBrief("search_health_education", { hits: [] })?.key).toBe("rx:trace.searchNone");
    expect(traceBrief("output_guard", { passed: false, action: "replaced", violations: ["dosage"] })).toMatchObject({ key: "rx:trace.guardReplaced" });
    expect(traceBrief("new_tool", {})).toBeNull();
    expect(handbookHits({ hits: [{ title: "急診", source_url: "javascript:1" }] })).toEqual([{ title: "急診", section: "", sourceName: "", url: null }]);
  });
  it("finds the ticket a refusal caused", () => {
    const t = (reason: Ticket["reason"], created_at: string) => ({ reason, created_at }) as Ticket;
    const mine = t("controlled_drug", "2026-11-25T09:00:04Z");
    const reply = { role: "assistant", kind: "refusal", created_at: "2026-11-25T09:00:05Z" } as Message;
    expect(ticketForMessage(reply, [t("red_flag", "2026-11-25T09:00:04Z"), t("controlled_drug", "2026-11-25T08:00:00Z"), mine])).toBe(mine);
    expect(ticketForMessage({ ...reply, kind: "chat" }, [mine])).toBeNull();
  });
});

describe("visit reducer", () => {
  const detail = (o: Partial<VisitDetail> = {}, seq = 5): VisitDetail =>
    ({ visit: { id: "v", last_seq: seq, status: "active", mode: "ai" }, messages: [], intake: EMPTY_INTAKE, summary: null, red_flag: null, tickets: [], tool_calls: [], runs: [], refill_checks: [], note: null, ...o }) as unknown as VisitDetail;
  const msg = (id: string, seq: number, o: Partial<Message> = {}): Message => ({ id, client_id: null, seq, role: "assistant", kind: "chat", author: null, content: id, created_at: "2026-11-25T08:00:00Z", run_id: null, status: "ok", ...o });
  const ev = (seq: number | null, type: string, data: unknown) => ({ type: "event" as const, envelope: { seq, type, data }, at: "2026-11-25T08:00:00Z" });

  it("sorts by seq, drops seen events and ignores unknown types", () => {
    let s = visitReducer(initialVisitState, { type: "loaded", detail: detail({ messages: [msg("b", 4), msg("a", 2)] }) });
    s = visitReducer(s, ev(5, "message.created", msg("old", 5)));
    s = visitReducer(s, ev(6, "message.created", msg("c", 6)));
    s = visitReducer(s, ev(7, "something.new", {}));
    expect(s.messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(s.lastSeq).toBe(7);
  });
  it("message.completed replaces the live text and merges with message.created", () => {
    let s = visitReducer(initialVisitState, { type: "loaded", detail: detail() });
    s = visitReducer(s, ev(6, "run.started", { run_id: "r", model: "m" }));
    s = visitReducer(s, ev(null, "message.delta", { text: "草" }));
    expect(s.live).toEqual({ runId: "r", text: "草" });
    s = visitReducer(s, ev(7, "message.created", msg("m1", 7, { content: "正式" })));
    s = visitReducer(s, ev(8, "message.completed", { message_id: "m1", kind: "chat", content: "正式", run_id: "r" }));
    expect(s.live).toBeNull();
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ seq: 7, run_id: "r" });
  });
  it("a read that is older than what was applied does not undo it", () => {
    let s = visitReducer(initialVisitState, { type: "loaded", detail: detail() });
    s = visitReducer(s, ev(6, "message.created", msg("new", 6)));
    s = visitReducer(s, { type: "loaded", detail: detail({}, 5) });
    expect(s.messages.map((m) => m.id)).toEqual(["new"]);
    expect(s.lastSeq).toBe(6);
  });
  it("failure banner stays away when a notice already says it", () => {
    const run = { phase: "failed" as const, runId: "r", code: "timeout" };
    expect(failureBannerVisible({ run, messages: [] })).toBe(true);
    expect(failureBannerVisible({ run, messages: [msg("n", 1, { kind: "notice" })] })).toBe(false);
    expect(redFlagText([msg("a", 1, { kind: "red_flag", content: "撥打 119" }), msg("b", 2)])).toBe("撥打 119");
  });
});

describe("copy files of the errors and rx namespaces", () => {
  const dir = resolve(process.cwd(), "src/i18n/locales");
  const flat = (o: object, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? flat(v as object, `${p}${k}.`) : [`${p}${k}`]));
  const keys = (lng: string, ns: string) => flat(JSON.parse(readFileSync(resolve(dir, lng, `${ns}.json`), "utf8")) as object);
  const bases = (list: string[]) => [...new Set(list.map((k) => k.replace(/_(one|other)$/, "")))].sort();
  it("have the same keys in both languages", () => {
    for (const ns of ["errors", "rx"]) expect(bases(keys("en", ns))).toEqual(bases(keys("zh-TW", ns)));
    expect(readdirSync(dir).sort()).toEqual(["en", "zh-TW"]);
  });
  it("cover every key the code can ask for", () => {
    const have = { errors: new Set(bases(keys("zh-TW", "errors"))), rx: new Set(bases(keys("zh-TW", "rx"))) };
    const source = ["errors.ts", "rx.ts", "trace.ts"].map((n) => readFileSync(resolve(process.cwd(), "src/lib", n), "utf8")).join("\n") + readFileSync(resolve(process.cwd(), "src/api/schemas.ts"), "utf8");
    const asked = [
      ...[...source.matchAll(/"(errors|rx):([\w.]+)"/g)].map((m) => [m[1], m[2]]),
      ...[...source.matchAll(/"(field\.\w+)"/g)].map((m) => ["errors", m[1]]),
      ...[...source.matchAll(/K\("(\w+)"\)/g)].map((m) => ["rx", `trace.${m[1]}`]),
    ] as ["errors" | "rx", string][];
    expect(asked.length).toBeGreaterThan(40);
    expect(asked.filter(([ns, k]) => !have[ns].has(k))).toEqual([]);
  });
});
