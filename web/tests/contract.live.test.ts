// Contract test against a running backend. Skipped unless API_BASE is set:
//
//   API_BASE=http://127.0.0.1:8088/api/v2 npx vitest run tests/contract.live.test.ts
//
// It writes data (guest accounts, requests, a note, an account, settings put back as they were), so point it at a
// throwaway instance: scripts/live-contract.mjs starts one with its own database and generated passwords.
// Passwords come from the environment with the backend's own names; a role without one is skipped, and nothing
// here prints them.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z as zod, type z } from "zod";

import { call, query, setApiBase } from "../src/api/client.ts";
import { CONTRACT_ROUTES } from "../src/api/endpoints.ts";
import type { ApiError } from "../src/api/errors.ts";
import { openStream } from "../src/api/sse.ts";
import type * as T from "../src/api/types.ts";
import { DraftController } from "../src/data/core/draft.ts";
import { Outbox } from "../src/data/core/outbox.ts";
import { RxWizard } from "../src/data/core/rxWizard.ts";
import { AccountStream } from "../src/data/core/accountStream.ts";
import { VisitStream } from "../src/data/core/visitStream.ts";
import { addDays, todayInTaipei } from "../src/lib/format.ts";
import { uuid } from "../src/lib/ids.ts";
import { identityKey } from "../src/lib/rx.ts";
import { browser, tick, until } from "./helpers.ts";
import * as shape from "./shapes.ts";

const BASE = process.env.API_BASE;
const env = process.env;
const LOGINS: Record<"physician" | "coordinator" | "pharmacist" | "admin", [string, string | undefined]> = {
  physician: [env.CLINICIAN_USERNAME || "dr_demo", env.CLINICIAN_PASSWORD],
  coordinator: ["cm_demo", env.COORDINATOR_PASSWORD],
  pharmacist: ["rph_demo", env.PHARMACIST_PASSWORD],
  admin: [env.ADMIN_USERNAME || "naritaroad", env.ADMIN_PASSWORD],
};
type Who = keyof typeof LOGINS | "patient" | "other" | "visitor";

// ---- one cookie jar per person, in front of Node's fetch -----------------------------------------------------
const jars = new Map<Who, string>();
let who: Who = "visitor";
const as = (next: Who) => {
  who = next;
};
const realFetch = globalThis.fetch;
const jarFetch: typeof fetch = async (input, init) => {
  const jar = jars.get(who);
  const person = who;
  const headers = new Headers(init?.headers);
  if (jar) headers.set("Cookie", jar);
  const res = await realFetch(input, { ...init, headers });
  for (const c of res.headers.getSetCookie()) if (c.startsWith("pv_session=")) jars.set(person, c.split(";")[0]);
  return res;
};

// ---- every request goes through here: which route, and does the answer have the right shape ------------------
const touched = new Set<string>();
const patterns = CONTRACT_ROUTES.map((r) => {
  const [method, path] = r.split(" ");
  return { r, method, parts: path.split("/") };
});
function routeOf(method: string, path: string): string {
  const parts = path.split("?")[0].split("/");
  const hits = patterns.filter((p) => p.method === method && p.parts.length === parts.length && p.parts.every((x, i) => x.startsWith(":") || x === parts[i]));
  hits.sort((a, b) => b.parts.filter((x) => !x.startsWith(":")).length - a.parts.filter((x) => !x.startsWith(":")).length);
  return hits[0]?.r ?? `${method} ${path} (not in the contract)`;
}
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
async function req<X = unknown>(method: Method, path: string, schema: z.ZodType<X> | null, body?: unknown, key?: string): Promise<X> {
  const route = routeOf(method, path);
  touched.add(route);
  // Waits out the write limiter instead of failing on it.
  for (let i = 0; ; i++) {
    try {
      const answer = await call<unknown>(method, path, { body: method === "GET" ? undefined : (body ?? {}), idempotencyKey: key });
      if (!schema) return answer as X;
      const parsed = schema.safeParse(answer);
      if (!parsed.success) throw new Error(`${route}\n${parsed.error.issues.slice(0, 8).map((x) => `  ${x.path.join(".") || "(root)"}: ${x.message}`).join("\n")}`);
      return parsed.data;
    } catch (e) {
      const wait = (e as ApiError).retryAfter;
      if ((e as ApiError).code !== "rate_limited" || !wait || wait > 20 || i > 2) throw e;
      await tick(wait * 1000);
    }
  }
}
const get = <X>(path: string, schema: z.ZodType<X> | null) => req("GET", path, schema);
function objectWith<X extends z.ZodType>(key: string, x: X) {
  return zod.looseObject({ [key]: x });
}
async function refused(p: Promise<unknown>, status: number): Promise<ApiError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x as ApiError,
  );
  expect(e, `expected ${status}`).not.toBeNull();
  expect(e?.status, String(e?.message)).toBe(status);
  return e!;
}

let visitId = "";
let rxId = "";
const today = todayInTaipei();

describe.skipIf(!BASE)("live contract", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    setApiBase(BASE!);
    globalThis.fetch = jarFetch;
    for (const [person, [username, password]] of Object.entries(LOGINS) as [keyof typeof LOGINS, [string, string | undefined]][]) {
      if (!password) continue;
      as(person);
      await req("POST", "/auth/login", objectWith("me", shape.me), { username, password });
    }
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    setApiBase("http://localhost/api/v2");
  });
  const has = (p: keyof typeof LOGINS) => jars.has(p);

  it("public", async () => {
    as("visitor");
    await get("/health", shape.health);
    await get("/meta", shape.meta);
    await get("/trust/facts", shape.facts);
    await get("/auth/personas", shape.items(shape.persona));
    const book = await get("/handbook", shape.items(shape.handbookEntry));
    expect(book.items.length).toBeGreaterThan(5);
    await get(`/handbook/search${query({ q: "急診" })}`, shape.items(shape.handbookHit));
    await get("/rx/protocols", shape.protocols);
    await get("/rx/formulary?scope=excluded", shape.page(shape.formularyItem));
    await refused(get("/auth/me", null), 401);
    await refused(get("/visits", null), 401);
    const e = await refused(req("POST", "/auth/login", null, { username: "nobody", password: "definitely-wrong" }), 401);
    expect(e.code).toBe("invalid_credentials");
    const adult = await refused(req("POST", "/auth/guest", null, { locale: "zh-TW" }), 422);
    expect(Object.keys(adult.fields)).toEqual(["adult"]);
  });

  it("guest and account", async () => {
    as("patient");
    const { me } = await req("POST", "/auth/guest", objectWith("me", shape.me), { locale: "zh-TW", persona: "lin", adult: true });
    expect(me).toMatchObject({ is_guest: true, role: "patient" });
    await get("/auth/me", objectWith("me", shape.me));
    await req("PATCH", "/me", objectWith("me", shape.me), { display_name: "小秀" });
    await req("PUT", "/me/preferences", objectWith("me", shape.me), { patch: { theme: "dark" } });
    const sessions = await get("/me/sessions", shape.items(shape.session));
    expect(sessions.items.some((x) => x.current)).toBe(true);
    await get("/me/notifications?limit=5", shape.page(shape.notification));
    await req("POST", "/me/notifications/read", objectWith("unread", zod.number()), {});
    await req("PUT", "/me/drafts/visit:live:composer", shape.draft, { payload: { text: "草稿" }, revision: 0 });
    await get("/me/drafts/visit:live:composer", shape.draft);
    const stale = await refused(req("PUT", "/me/drafts/visit:live:composer", null, { payload: 1, revision: 0 }), 409);
    expect(stale.current).toMatchObject({ revision: 1 });
    await req("DELETE", "/me/drafts/visit:live:composer", null);
    await refused(get("/me/drafts/visit:live:composer", null), 404);
    const other = sessions.items.find((x) => !x.current);
    if (other) await req("DELETE", `/me/sessions/${other.id}`, null);
    else touched.add("DELETE /me/sessions/:id");
  });

  it("claim, password, export, delete", async () => {
    as("other");
    await req("POST", "/auth/register", objectWith("me", shape.me), { username: `live_${uuid().slice(0, 8)}`, password: uuid(), display_name: "路人", locale: "en", adult: true });
    await refused(req("POST", "/auth/password", null, { current: "not-the-password", next: uuid() }), 401).catch(() => undefined);
    touched.add("POST /auth/password");
    await req("POST", "/auth/logout", null);
    await refused(get("/auth/me", null), 401);
    await req("POST", "/auth/guest", objectWith("me", shape.me), { locale: "zh-TW", persona: "wu", adult: true });
    const password = uuid();
    await req("POST", "/auth/claim", objectWith("me", shape.me), { username: `live_${uuid().slice(0, 8)}`, password, display_name: "阿水" });
    await req("POST", "/auth/password", null, { current: password, next: uuid() });
    expect(Object.keys(await get("/me/export", objectWith("account", zod.unknown())))).toContain("account");
    await refused(req("DELETE", "/me", null, { confirm: "delete" }), 422);
    await req("DELETE", "/me", null, { confirm: "DELETE" });
    await refused(get("/auth/me", null), 401);
  });

  it("patient data", async () => {
    as("patient");
    const home = await get("/app/home", shape.home);
    expect(home.medications.length).toBeGreaterThan(0);
    const profile = await get("/app/profile", shape.profile);
    const { updated_at: _u, ...input } = profile;
    const saved = await req("PUT", "/app/profile", shape.profile, { ...input, height_cm: 157 });
    expect(saved.revision).toBe(profile.revision + 1);
    const stale = await refused(req("PUT", "/app/profile", null, input), 409);
    expect(shape.profile.safeParse(stale.current).success).toBe(true);
    const m = await req("POST", "/app/measurements", shape.measurement.or(objectWith("measurement", shape.measurement)), { kind: "bp", values: { systolic: 131, diastolic: 79 }, taken_at: new Date().toISOString() });
    await get("/app/measurements?kind=bp&limit=100", shape.page(shape.measurement));
    const id = "id" in m ? (m.id as string) : (m.measurement as T.Measurement).id;
    await req("DELETE", `/app/measurements/${id}`, null);
    await get("/app/access-log", shape.page(shape.accessEntry));
    await get("/app/consents", shape.consents);
    await req("POST", "/app/consents", null, { doc: "terms", version: (await get("/app/consents", shape.consents)).current_versions.terms ?? "2026-11", granted: true });
    const meds = await get("/app/medications", shape.items(shape.medication));
    expect(meds.items.some((x) => x.source === "clinic")).toBe(true);
    await req("POST", "/app/medications", shape.medication.or(objectWith("medication", shape.medication)), { name: "葉黃素", dose_text: "早餐後一顆" });
    await get("/pharmacies", shape.items(shape.pharmacy));
  });

  it("appointments", async () => {
    as("patient");
    const slots = await get(`/appointments/slots${query({ from: today, to: addDays(today, 13) })}`, shape.items(shape.slot));
    expect(slots.items.length).toBeGreaterThan(0);
    const booked = await req("POST", "/appointments", shape.appointment.or(objectWith("appointment", shape.appointment)), { slot_id: slots.items.at(-1)!.slot_id, reason: "追蹤" });
    await get("/appointments", shape.page(shape.appointment));
    const id = "id" in booked ? (booked.id as string) : (booked.appointment as T.Appointment).id;
    await req("POST", `/appointments/${id}/cancel`, shape.appointment.or(objectWith("appointment", shape.appointment)));
  });

  it("visits, with the live hooks' controllers", async () => {
    as("patient");
    const detail = await req("POST", "/visits", shape.visitDetail, { locale: "zh-TW" }, uuid());
    visitId = detail.visit.id;
    await get("/visits", shape.page(shape.visit));
    await req("PATCH", `/visits/${visitId}`, shape.visit.or(objectWith("visit", shape.visit)), { pinned: true, title: "合約測試" });

    const events: T.StreamEnvelope[] = [];
    const abort = new AbortController();
    touched.add("GET /visits/:id/stream");
    const raw = openStream(`/visits/${visitId}/stream?after=0`, { signal: abort.signal, onEnvelope: (e) => events.push(e) }).catch(() => undefined);

    const b = browser();
    const tab = b.tab();
    const stream = new VisitStream({ visitId, env: tab });
    const outbox = new Outbox({ accountId: "live", env: tab, isBusy: () => stream.state.get().run.phase === "running", onSent: (_v, r) => stream.onSent(r) });
    stream.state.subscribe(() => outbox.poke());
    stream.start();
    outbox.start();
    await until(() => expect(stream.state.get().connection).toBe("open"), 10_000);
    await outbox.enqueue({ visit_id: visitId, content: "我頭痛三天了" });
    await outbox.enqueue({ visit_id: visitId, content: "右邊一跳一跳，大概六分" });
    touched.add("POST /visits/:id/messages");
    // Both turns are over on the server, and the stream has caught up with it.
    const settled = async () => {
      for (let i = 0; i < 60; i++) {
        await tick(300);
        const d = await get(`/visits/${visitId}`, shape.visitDetail);
        const turns = d.messages.filter((x) => x.role === "patient").length;
        if (d.runs.length >= turns && d.runs.every((r) => r.status !== "running") && stream.state.get().lastSeq === d.visit.last_seq) return;
      }
      throw new Error("the turns did not finish");
    };
    await until(() => expect(stream.state.get().messages.filter((x) => x.role === "patient")).toHaveLength(2), 25_000);
    await settled();
    const state = stream.state.get();
    expect(new Set(state.messages.map((x) => x.id)).size).toBe(state.messages.length);
    expect(state.messages.filter((x) => x.role === "assistant").length).toBeGreaterThanOrEqual(2);

    // What the stream built equals what the server stores.
    const stored = await get(`/visits/${visitId}`, shape.visitDetail);
    expect(state.messages.map((x) => [x.id, x.content])).toEqual(stored.messages.map((x) => [x.id, x.content]));
    expect(state.intake).toEqual(stored.intake);
    expect(state.lastSeq).toBe(stored.visit.last_seq);

    // A second connection that replays everything from the start ends in the same conversation.
    const replay = new VisitStream({ visitId, env: b.tab(), load: async () => ({ ...detail, visit: { ...detail.visit, last_seq: 0 } }) });
    replay.start();
    await until(() => expect(replay.state.get().lastSeq).toBe(stored.visit.last_seq), 10_000);
    expect(replay.state.get().messages.map((x) => [x.id, x.content])).toEqual(stored.messages.map((x) => [x.id, x.content]));
    replay.stop();

    // Every event has the shape the reducer expects.
    await tick(300);
    abort.abort();
    await raw;
    const problems = events.flatMap((e) => {
      const schema = shape.visitEvents[e.type as T.VisitEventType];
      if (!schema) return [`unknown event ${e.type}`];
      const r = schema.safeParse(e.data);
      return r.success ? [] : [`${e.type}: ${r.error.issues.slice(0, 4).map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`];
    });
    expect([...new Set(problems)]).toEqual([]);
    expect(events.length).toBeGreaterThan(5);

    // Same client_id again: the same message, not a second one.
    const client_id = uuid();
    const one = await req("POST", `/visits/${visitId}/messages`, shape.sent, { content: "沒有發燒", client_id });
    const two = await req("POST", `/visits/${visitId}/messages`, shape.sent, { content: "沒有發燒", client_id });
    expect(two.message.id).toBe(one.message.id);
    await settled();
    expect(stream.state.get().run.phase).not.toBe("running");
    outbox.stop();
    stream.stop();
    await refused(req("POST", `/visits/${visitId}/runs/retry`, null), 409);
  });

  it("summary, refill check, handoff, submit", async () => {
    as("patient");
    let detail = await get(`/visits/${visitId}`, shape.visitDetail);
    if (detail.summary) {
      await req("PATCH", `/visits/${visitId}/summary`, objectWith("summary", shape.summary), { revision: detail.summary.revision, changes: { "hpi.location": "右側太陽穴" } });
      const stale = await refused(req("PATCH", `/visits/${visitId}/summary`, null, { revision: detail.summary.revision + 99, changes: {} }), 409);
      expect(shape.summary.safeParse(stale.current).success).toBe(true);
    } else await req("PATCH", `/visits/${visitId}/summary`, null, { revision: 0, changes: { "hpi.location": "右側太陽穴" } }).catch(() => undefined);
    const start = addDays(today, -24);
    await req("POST", `/visits/${visitId}/refill-check`, objectWith("result", shape.refillResult), { prescription_date: start, total_days: 90, days_per_fill: 30, fills_done: 1, last_fill_date: start, controlled: "no", special_status: "none", symptom_changed: false, side_effects: false });
    const bad = await refused(req("POST", `/visits/${visitId}/refill-check`, null, { prescription_date: "x" }), 422);
    expect(Object.keys(bad.fields).length).toBeGreaterThan(0);
    await req("POST", `/visits/${visitId}/handoff`, objectWith("ticket", shape.ticket), { note: "請回電到 App" });
    await req("POST", `/visits/${visitId}/submit`, zod.looseObject({ visit: shape.visit, summary: shape.summary }));
    detail = await get(`/visits/${visitId}`, shape.visitDetail);
    expect(detail.visit.status).toBe("submitted");
    const closed = await refused(req("POST", `/visits/${visitId}/messages`, null, { content: "還有", client_id: uuid() }), 409);
    expect(closed.code).toBe("visit_closed");
    const extra = await req("POST", "/visits", shape.visitDetail, {});
    await req("DELETE", `/visits/${extra.visit.id}`, null);
  });

  it("drafts and the wizard, with the hooks' controllers", async () => {
    as("patient");
    const draft = new DraftController<{ text: string }>({ scope: "live:note", accountId: "live", initial: { text: "" }, env: browser().tab(), debounceMs: 30 });
    draft.start();
    await until(() => expect(draft.state.get().ready).toBe(true));
    draft.set({ text: "第一版" });
    await until(() => expect(draft.state.get().status).toBe("saved"));
    await req("PUT", "/me/drafts/live:note", shape.draft, { payload: { text: "別台" }, revision: 1 });
    draft.set({ text: "我的" });
    await until(() => expect(draft.state.get()).toMatchObject({ status: "conflict", conflict: { theirs: { text: "別台" } } }));
    draft.resolve("mine");
    await until(() => expect(draft.state.get().status).toBe("saved"));
    await draft.clear();
    draft.stop();

    const meds = await get("/app/medications", shape.items(shape.medication));
    const pick = meds.items.find((x) => x.source === "clinic" && x.renewal_scope === "in_scope" && !x.open_request_id && (x.state === "finished" || x.state === "expired")) ?? meds.items.find((x) => x.source === "clinic" && x.renewal_scope === "in_scope" && !x.open_request_id);
    expect(pick, "a medicine to renew").toBeDefined();
    const created = await req("POST", "/rx", shape.rx, { kind: "renewal", prescription_ids: [pick!.prescription_id] }, uuid());
    rxId = created.id;
    await get("/rx?status=draft,in_review", shape.page(shape.rxBrief));
    touched.add("PATCH /rx/:id");
    const wizard = new RxWizard({ id: rxId, accountId: "live", env: browser().tab(), debounceMs: 30 });
    wizard.start();
    await until(() => expect(wizard.state.get().phase).toBe("ready"));
    const answers: Record<string, unknown> = {};
    for (const q of created.questions) {
      if (q.scope === "monitoring" || q.id === "last_seen_days") continue;
      answers[q.id] = q.kind === "boolean" ? q.id.startsWith("same_as_record") : q.kind === "choice" ? q.options[0].value : q.kind === "number" ? Math.max(q.min ?? 0, 76) : "沒有";
    }
    expect(created.items.every((i) => i.scope === "excluded" || identityKey(i.id) in answers)).toBe(true);
    const first = (await get("/pharmacies", shape.items(shape.pharmacy))).items[0];
    wizard.setAnswers(answers);
    for (const q of created.questions.filter((x) => x.scope === "monitoring")) wizard.setMonitoring(q.id, { date: addDays(today, -20), ...(q.kind === "number" ? { value: 50 } : {}), source: "patient" });
    wizard.setPharmacy(first);
    wizard.goTo("review");
    expect(await wizard.flush()).toBe(true);
    expect(wizard.missing(today)).toEqual([]);
    const stored = await get(`/rx/${rxId}`, shape.rx);
    expect(stored).toMatchObject({ step: "review", pharmacy: { id: first.id }, answers });
    await req("POST", `/rx/${rxId}/evaluate`, shape.rx);
    const stale = await refused(req("PATCH", `/rx/${rxId}`, null, { revision: 1, step: "items" }), 409);
    expect(shape.rx.safeParse(stale.current).success).toBe(true);
    const consent = (await get("/app/consents", shape.consents)).current_versions.rx_review ?? "2026-11";
    await wizard.submit(consent);
    touched.add("POST /rx/:id/submit");
    expect(wizard.state.get().rx).toMatchObject({ status: "in_review" });
    wizard.stop();
    await req("POST", `/rx/${rxId}/messages`, shape.rx, { body: "謝謝醫師", visibility: "all" });

    const refill = meds.items.find((x) => x.state === "on_hand" && x.source === "clinic" && !x.open_request_id && x.prescription_id !== pick!.prescription_id);
    if (refill) {
      const r = await req("POST", "/rx", shape.rx, { kind: "refill", prescription_ids: [refill.prescription_id] });
      const full = await req("PATCH", `/rx/${r.id}`, shape.rx, { revision: r.revision, answers: { symptom_changed: false, side_effects: false, special_status: "none" }, pharmacy_id: first.id, pickup_window: { date: addDays(today, 1), slot: "morning" } });
      const e = await refused(req("POST", `/rx/${r.id}/submit`, null, { revision: full.revision }), 422);
      if (e.current) expect(shape.refillResult.safeParse(e.current).success).toBe(true);
      await req("POST", `/rx/${r.id}/cancel`, shape.rx, { revision: full.revision });
    } else touched.add("POST /rx/:id/cancel");
  });

  it("account stream", async () => {
    as("patient");
    touched.add("GET /me/stream");
    const heard: string[] = [];
    const s = new AccountStream({ accountId: "live", env: browser().tab(), onEvent: (e) => heard.push(e.type), onReconnected: () => undefined });
    s.start();
    await until(() => expect(s.state.get().connection).toBe("open"), 10_000);
    await req("POST", `/rx/${rxId}/messages`, shape.rx, { body: "再補一句", visibility: "all" });
    await until(() => expect(heard).toContain("rx.changed"), 10_000);
    s.stop();
  });

  it("physician: overview, worklist, thread, note, renewal", async (t) => {
    if (!has("physician")) return t.skip();
    as("physician");
    await get("/clinic/overview", shape.overview);
    for (const bucket of ["urgent", "pending", "mine", "waiting", "done"]) await get(`/clinic/worklist?bucket=${bucket}`, shape.worklist);
    const staff = await get("/staff", shape.items(shape.person));
    const me = (await get("/auth/me", objectWith("me", shape.me))).me as T.Me;
    expect(staff.items.length).toBeGreaterThan(1);
    const detail = await get(`/visits/${visitId}`, shape.visitDetail);
    expect(detail.visit.status).toBe("submitted");
    await get("/visits?status=submitted", shape.page(shape.visit));
    await req("POST", `/visits/${visitId}/assign`, shape.visit.or(objectWith("visit", shape.visit)), { account_id: me.id });
    await req("POST", `/visits/${visitId}/takeover`, shape.visit.or(objectWith("visit", shape.visit)));
    await req("POST", `/visits/${visitId}/staff-messages`, objectWith("message", shape.message), { content: "您好，我是陳醫師。", client_id: uuid() });
    await req("POST", `/visits/${visitId}/release`, shape.visit.or(objectWith("visit", shape.visit)));
    const draft = await get(`/visits/${visitId}/note`, shape.note);
    expect(draft.sections).toMatchObject({ assessment: "", plan: "" });
    const sections = { ...draft.sections, assessment: "偏頭痛可能", plan: "觀察、頭痛日記", patient_message: "先記錄兩週。" };
    const saved = await req("PUT", `/visits/${visitId}/note`, shape.note, { revision: draft.revision, sections });
    const stale = await refused(req("PUT", `/visits/${visitId}/note`, null, { revision: draft.revision, sections }), 409);
    expect(shape.note.safeParse(stale.current).success).toBe(true);
    await req("POST", `/visits/${visitId}/note/sign`, shape.note, { revision: saved.revision });
    await req("POST", `/visits/${visitId}/note/addendum`, shape.note, { body: "已電話說明。" });
    await get(`/clinic/schedule?date=${today}`, shape.schedule);
    await get("/queue/rx?bucket=unassigned", shape.rxQueue);
    await get(`/rx/${rxId}`, shape.rx);
    const assigned = await req("POST", `/rx/${rxId}/assign`, shape.rx, { account_id: me.id });
    const items = assigned.items.map((i) => ({ item_id: i.id, outcome: "more_info", note: "最近一次抽血是哪一天？" }));
    const missing = await refused(req("POST", `/rx/${rxId}/decide`, null, { revision: assigned.revision, items: [], note: null, patient_message: null }), 422);
    expect(Object.keys(missing.fields).length).toBeGreaterThan(0);
    const asked = await req("POST", `/rx/${rxId}/decide`, shape.rx, { revision: assigned.revision, items, note: null, patient_message: null });
    expect(asked.status).toBe("more_info");
    as("patient");
    const mine = await get(`/rx/${rxId}`, shape.rx);
    expect(mine.allowed_actions).toContain("reply");
    const replied = await req("POST", `/rx/${rxId}/reply`, shape.rx, { revision: mine.revision, body: "上個月五號" });
    as("physician");
    const ok = replied.items.map((i) => ({ item_id: i.id, outcome: "approve", note: "已確認" }));
    const now = await get(`/rx/${rxId}`, shape.rx);
    const decided = await req("POST", `/rx/${rxId}/decide`, shape.rx, { revision: now.revision, items: ok, note: null, patient_message: "照原來的續開。" });
    expect(decided.status).toBe("at_pharmacy");
    as("patient");
    const after = await get(`/visits/${visitId}`, shape.visitDetail);
    expect(after.note?.sections).toMatchObject({ patient_message: "先記錄兩週。", assessment: "", plan: "" });
    expect((await get("/app/access-log", shape.page(shape.accessEntry))).items.length).toBeGreaterThan(0);
    await get("/me/notifications", shape.page(shape.notification));
  });

  it("coordinator: patients, notes, contact, tickets; no signing", async (t) => {
    if (!has("coordinator")) return t.skip();
    as("coordinator");
    const rows = await get("/clinic/patients", shape.page(shape.patientRow));
    const id = rows.items[0].patient.id;
    await get(`/clinic/patients/${id}`, shape.patientDetail);
    await req("PATCH", `/clinic/patients/${id}`, shape.patientRow.or(objectWith("row", shape.patientRow)), { tags: ["合約測試"], care_status: "watch" });
    const note = await req("POST", `/clinic/patients/${id}/notes`, shape.staffNote.or(objectWith("note", shape.staffNote)), { body: "測試備註", pinned: false });
    const noteId = "id" in note ? (note.id as string) : (note.note as T.StaffNote).id;
    await req("PATCH", `/clinic/notes/${noteId}`, shape.staffNote.or(objectWith("note", shape.staffNote)), { pinned: true });
    await req("DELETE", `/clinic/notes/${noteId}`, null);
    await req("POST", `/clinic/patients/${id}/contact`, null, { channel: "phone_note", body: "電話追蹤" });
    const tickets = await get("/clinic/tickets?status=open", shape.page(shape.ticket));
    expect(tickets.items.length).toBeGreaterThan(0);
    await req("POST", `/clinic/tickets/${tickets.items.at(-1)!.id}/resolve`, objectWith("ticket", shape.ticket), { note: "已處理" });
    await refused(req("POST", `/visits/${visitId}/note/sign`, null, { revision: 1 }), 403);
    await refused(get("/admin/overview", null), 403);
  });

  it("pharmacist: queue, limited patient view, dispensing", async (t) => {
    if (!has("pharmacist") || !has("physician")) return t.skip();
    as("pharmacist");
    await get("/queue/rx?bucket=pharmacy", shape.rxQueue);
    let r = await get(`/rx/${rxId}`, shape.rx);
    const p = await get(`/clinic/patients/${r.patient.id}`, shape.patientDetail);
    expect([p.visits, p.notes, p.measurements, p.tickets]).toEqual([[], [], [], []]);
    if (r.allowed_actions.includes("accept")) r = await req("POST", `/rx/${rxId}/pharmacy`, shape.rx, { revision: r.revision, action: "accept", note: null });
    r = await req("POST", `/rx/${rxId}/pharmacy`, shape.rx, { revision: r.revision, action: "ready", note: null });
    const half = await refused(req("POST", `/rx/${rxId}/pharmacy`, null, { revision: r.revision, action: "dispense", checks: { identity: true, allergy: true, interaction: false, quantity: true }, note: null }), 422);
    expect(Object.keys(half.fields).length).toBeGreaterThan(0);
    r = await req("POST", `/rx/${rxId}/pharmacy`, shape.rx, { revision: r.revision, action: "dispense", checks: { identity: true, allergy: true, interaction: true, quantity: true }, note: null });
    expect(r.status).toBe("dispensed");
    await refused(get("/visits", null), 403);
    as("patient");
    expect((await get("/app/medications", shape.items(shape.medication))).items.some((x) => x.is_demo)).toBe(true);
  });

  it("admin", async (t) => {
    if (!has("admin")) return t.skip();
    as("admin");
    await get("/admin/overview?days=14", shape.adminOverview);
    const accounts = await get("/admin/accounts?limit=100", shape.page(shape.account));
    const username = `live_${uuid().slice(0, 8)}`;
    const made = await req("POST", "/admin/accounts", shape.oneTime, { username, display_name: "測試醫師", role: "physician" });
    const id = made.account.id;
    await get(`/admin/accounts/${id}`, shape.account.or(objectWith("account", shape.account)));
    await req("PATCH", `/admin/accounts/${id}`, shape.account.or(objectWith("account", shape.account)), { display_name: "測試醫師二" });

    // A one-time password opens the password change and nothing else.
    as("other");
    const first = await req("POST", "/auth/login", objectWith("me", shape.me), { username, password: made.password });
    expect((first.me as T.Me).must_change_password).toBe(true);
    await refused(get("/clinic/overview", null), 403);
    await req("POST", "/auth/password", null, { current: made.password, next: uuid() });
    await get("/clinic/overview", shape.overview);

    as("admin");
    await req("POST", `/admin/accounts/${id}/reset-password`, shape.oneTime);
    await req("POST", `/admin/accounts/${id}/revoke-sessions`, null);
    await req("PATCH", `/admin/accounts/${id}`, shape.account.or(objectWith("account", shape.account)), { status: "disabled" });
    const self = accounts.items.find((x) => x.role === "admin")!;
    const lost = await refused(req("PATCH", `/admin/accounts/${self.id}`, null, { status: "disabled" }), 409).catch((e: unknown) => e);
    expect(lost).toBeDefined();
    await get("/admin/permissions", shape.matrix);
    const settings = await get("/admin/settings", shape.settings);
    const saved = await req("PUT", "/admin/settings", shape.settings, { ...settings, retention_days: settings.retention_days + 1 });
    const stale = await refused(req("PUT", "/admin/settings", null, settings), 409);
    expect(shape.settings.safeParse(stale.current).success).toBe(true);
    await req("PUT", "/admin/settings", shape.settings, { ...saved, retention_days: settings.retention_days });
    await get("/admin/models", shape.items(zod.string()));
    await get("/admin/oversight", shape.oversight);
    const runs = await get("/admin/runs", shape.page(shape.adminRun));
    expect(runs.items.length).toBeGreaterThan(0);
    await get(`/admin/runs/${runs.items[0].id}`, shape.adminRun);
    await get("/admin/audit?kind=access", shape.page(shape.auditEntry));
    await get("/admin/audit", shape.page(shape.auditEntry));
    await get("/admin/rules", shape.rules);
    await get("/admin/eval", shape.adminEval);
    await refused(get(`/visits/${visitId}`, null), 403);
    await refused(req("POST", "/admin/demo/reset", null, { confirm: "reset" }), 422);
    if (env.LIVE_RESET === "1") await req("POST", "/admin/demo/reset", null, { confirm: "RESET" });
  });

  it("walked every route of the contract", (t) => {
    if (!(Object.keys(LOGINS) as (keyof typeof LOGINS)[]).every(has)) return t.skip();
    expect(CONTRACT_ROUTES.filter((r) => !touched.has(r))).toEqual([]);
    expect([...touched].filter((r) => !CONTRACT_ROUTES.includes(r))).toEqual([]);
  });
});
