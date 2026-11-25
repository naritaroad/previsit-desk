// The mock server answers every endpoint of the contract, for the right roles, with contract-shaped objects.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adminApi, appointmentsApi, authApi, clinicApi, CONTRACT_ROUTES, meApi, patientApi, publicApi, rxApi, visitsApi } from "../src/api/endpoints.ts";
import type { RxStatus, VisitStatus } from "../src/api/types.ts";
import { addDays, todayInTaipei } from "../src/lib/format.ts";
import { identityKey } from "../src/lib/rx.ts";
import { parseMock } from "../src/mocks/config.ts";
import { fid } from "../src/mocks/db.ts";
import { CLASSES, DRUGS, GENERAL, parseCsv, redFlag, REFILL_ROWS, scopeOf } from "../src/mocks/rules.ts";
import { ROUTES } from "../src/mocks/start.ts";
import { type Mock, mock } from "./helpers.ts";

const repo = (path: string) => readFileSync(resolve(process.cwd(), "..", path), "utf8");
let m: Mock;
beforeEach(() => {
  m = mock();
});
afterEach(() => m.stop());
const as = (username: string) => expect(m.server.loginAs(username)).toBe(true);

describe("coverage", () => {
  it("has a handler for every contract route, and no others", () => {
    const have = ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect(have).toEqual([...CONTRACT_ROUTES].sort());
    expect(new Set(have).size).toBe(have.length);
  });

  it("knows every endpoint the contract document names", () => {
    const named = new Set<string>();
    for (const line of repo("docs/v2/contract.md").split("\n")) {
      if (!line.startsWith("| `")) continue; // only table rows define endpoints
      let base = "";
      for (const [, methods, raw] of line.split("|")[1].matchAll(/((?:GET|POST|PUT|PATCH|DELETE)(?:\/(?:GET|POST|PUT|PATCH|DELETE))*) ((?:\.\.\.)?\/?[^\s`?]+)/g)) {
        const path = raw.startsWith("...") ? base + raw.slice(3) : raw;
        if (!path.startsWith("/")) continue;
        // "...": relative to the row's last /{id}.
        if (!raw.startsWith("...") && !base.endsWith("{id}")) base = path;
        for (const method of methods.split("/")) named.add(`${method} ${path.replace(/\{(\w+)\}/g, ":$1")}`);
      }
    }
    const known = new Set(CONTRACT_ROUTES);
    expect([...named].filter((r) => !known.has(r))).toEqual([]);
    expect(named.size).toBeGreaterThan(80);
  });
});

describe("fixtures", () => {
  it("has the five default accounts, three personas and ten panel patients", async () => {
    const { accounts } = m.server.db;
    const names = accounts.flatMap((a) => a.username ?? []).sort();
    expect(names).toEqual(["cm_demo", "dr_demo", "naritaroad", "patient_demo", "rph_demo"]);
    expect((await authApi.personas()).map((p) => p.id)).toEqual(["lin", "chang", "wu"]);
    expect(accounts.filter((a) => a.role === "patient" && a.username === null)).toHaveLength(10);
  });

  it("covers every visit and rx state, with engine results on sent renewals", () => {
    const { visits, rx } = m.server.db;
    const visitStates: VisitStatus[] = ["active", "red_flag", "submitted", "reviewed"];
    expect(visitStates.filter((s) => !visits.some((v) => v.status === s))).toEqual([]);
    expect(visits.some((v) => v.mode === "human")).toBe(true);
    expect(visits.some((v) => v.runs.at(-1)?.status === "interrupted")).toBe(true);
    const rxStates: RxStatus[] = [
      "draft", "submitted", "in_review", "more_info", "approved", "partially_approved", "declined", "visit_required", "at_pharmacy", "returned", "ready", "dispensed", "cancelled",
    ];
    expect(rxStates.filter((s) => !rx.some((r) => r.status === s))).toEqual([]);
    const sent = rx.filter((r) => r.kind === "renewal" && r.submitted_at);
    expect(sent.every((r) => r.engine !== null && r.items.every((i) => i.engine !== null))).toBe(true);
    expect(sent.map((r) => r.engine?.disposition)).toEqual(expect.arrayContaining(["review", "in_person", "urgent"]));
    expect(rx.flatMap((r) => r.items).some((i) => i.engine?.disposition === "excluded")).toBe(true);
    expect(rx.some((r) => r.status === "in_review" && r.sla_due_at !== null && r.sla_due_at < new Date().toISOString())).toBe(true);
  });

  it("uses the project's own rule files", () => {
    expect(REFILL_ROWS).toEqual(parseCsv(repo("data/seed/refill_rules.csv")));
    expect(DRUGS.get("zolpidem")?.scope).toBe("excluded");
    expect(redFlag("我胸口好悶")?.category).toBe("chest_pain");
    expect(redFlag("沒有胸痛")).toBeNull();
    expect(scopeOf("可以幫我開抗生素嗎")).toBe("prescription_request");
    expect(scopeOf("最近睡不好")).toBe("ok");
  });

  it("fixture answers and readings only use questions that exist in the protocol", () => {
    const known = new Set([...GENERAL, ...[...CLASSES.values()].flatMap((c) => [...c.questions, ...c.monitoring])].map((q) => q.id));
    const used = m.server.db.rx.filter((r) => r.kind === "renewal").flatMap((r) => [...Object.keys(r.answers).filter((k) => !k.startsWith("same_as_record:")), ...Object.keys(r.monitoring)]);
    expect([...new Set(used)].filter((k) => !known.has(k))).toEqual([]);
  });

  it("has no Simplified characters", () => {
    expect(JSON.stringify(m.server.db).match(/[们这说时现个实际应认识过还进记录请问题药师医诊剂处预约续复习产业务经验团队]/gu) ?? []).toEqual([]);
  });

  it("no drug in the fixtures is missing from the formulary, and no prescription has two open requests", () => {
    const { prescriptions, rx } = m.server.db;
    expect(prescriptions.filter((p) => !DRUGS.has(p.drug_id))).toEqual([]);
    const open = rx.filter((r) => !["declined", "visit_required", "dispensed", "cancelled"].includes(r.status)).flatMap((r) => r.items.map((i) => i.prescription_id));
    expect(new Set(open).size).toBe(open.length);
  });
});

describe("auth", () => {
  it("signs in, refuses wrong passwords, makes guests and lets them claim the account", async () => {
    await expect(authApi.login({ username: "dr_demo", password: "short" })).rejects.toMatchObject({ status: 401, code: "invalid_credentials" });
    await expect(authApi.me()).rejects.toMatchObject({ code: "unauthorized" });
    const me = await authApi.login({ username: "dr_demo", password: "anything-long" });
    expect(me.role).toBe("physician");
    expect(me.permissions).toContain("rx.decide");
    await authApi.logout();

    const guest = await authApi.guest({ locale: "zh-TW", persona: "wu", adult: true });
    expect(guest).toMatchObject({ is_guest: true, display_name: "吳金水", role: "patient" });
    expect((await patientApi.medications()).map((x) => x.drug.drug_id)).toContain("tamsulosin");
    const taken = authApi.claim({ username: "dr_demo", password: "long-enough-1", display_name: "阿水" });
    await expect(taken).rejects.toMatchObject({ status: 422, fields: { username: expect.any(String) } });
    const claimed = await authApi.claim({ username: "ashui", password: "long-enough-1", display_name: "阿水" });
    expect(claimed).toMatchObject({ id: guest.id, is_guest: false, username: "ashui" });
    expect((await patientApi.medications()).length).toBeGreaterThan(0);
  });

  it("keeps each role to its own endpoints", async () => {
    const checks: [string, () => Promise<unknown>, boolean][] = [
      ["patient_demo", () => clinicApi.overview(), false],
      ["patient_demo", () => patientApi.home(), true],
      ["cm_demo", () => clinicApi.worklist(), true],
      ["cm_demo", () => visitsApi.signNote(fid("visit:kuo-migraine"), 2), false],
      ["rph_demo", () => rxApi.queue({ bucket: "pharmacy" }), true],
      ["rph_demo", () => clinicApi.worklist(), false],
      ["naritaroad", () => adminApi.overview(7), true],
      ["naritaroad", () => visitsApi.get(fid("visit:lin-dizzy")), false],
    ];
    for (const [username, call, allowed] of checks) {
      as(username);
      if (allowed) await expect(call()).resolves.toBeDefined();
      else await expect(call()).rejects.toMatchObject({ status: 403 });
    }
  });
});

describe("read endpoints", () => {
  it("public", async () => {
    expect((await publicApi.health()).ok).toBe(true);
    expect((await publicApi.meta()).server_today).toBe(todayInTaipei());
    expect((await publicApi.trustFacts()).oversight_phase).toBe(1);
    expect(await publicApi.pharmacies()).toHaveLength(4);
    expect((await publicApi.handbook()).length).toBeGreaterThan(10);
    expect((await publicApi.searchHandbook("急診")).length).toBeGreaterThan(0);
    expect((await rxApi.protocols()).classes).toHaveLength(16);
    expect((await rxApi.formulary({ scope: "excluded" })).items.every((f) => f.renewal_scope === "excluded")).toBe(true);
  });

  it("patient", async () => {
    as("patient_demo");
    const home = await patientApi.home();
    expect(home.next_appointment?.physician.display_name).toBeTruthy();
    expect(home.active_visits[0].pinned).toBe(true);
    expect(home.active_requests.length).toBeGreaterThan(1);
    const states = (await patientApi.medications()).map((x) => x.state);
    expect(states).toEqual(expect.arrayContaining(["on_hand", "window_open", "finished"]));
    expect((await patientApi.measurements({ kind: "bp" })).items.length).toBeGreaterThan(10);
    expect((await patientApi.accessLog()).items[0].actor.role).not.toBe("patient");
    expect((await patientApi.consents()).items).toHaveLength(2);
    const slots = await appointmentsApi.slots({ from: todayInTaipei(), to: addDays(todayInTaipei(), 6) });
    expect(slots.some((s) => s.available)).toBe(true);
    expect((await visitsApi.list({ archived: true })).items).toHaveLength(1);
    expect((await visitsApi.list({ q: "血糖" })).items.length).toBeGreaterThan(0);
    expect((await meApi.sessions())[0].current).toBe(true);
    expect((await meApi.export()).visits).toBeDefined();
  });

  it("clinic", async () => {
    as("dr_demo");
    const overview = await clinicApi.overview();
    expect(overview.counts.urgent).toBeGreaterThan(0);
    expect(overview.today.length).toBeGreaterThan(5);
    const list = await clinicApi.worklist({ bucket: "urgent" });
    expect(list.items[0].urgency).toBe("urgent");
    expect(list.counts.pending).toBeGreaterThan(3);
    expect((await clinicApi.patients()).items).toHaveLength(11);
    const detail = await clinicApi.patient(fid("account:lin"));
    expect(detail.timeline.length).toBeGreaterThan(5);
    expect((await clinicApi.schedule(todayInTaipei())).physicians).toHaveLength(2);
    expect((await clinicApi.tickets()).items.every((t) => t.status === "open")).toBe(true);
    expect((await clinicApi.staff()).map((p) => p.role)).not.toContain("patient");
    const visit = await visitsApi.get(fid("visit:chang-night"));
    const ids = new Set(visit.messages.map((x) => x.id));
    expect(Object.values(visit.summary?.evidence ?? {}).flat().every((id) => ids.has(id))).toBe(true);
    const draft = await visitsApi.note(fid("visit:chang-night"));
    expect(draft).toMatchObject({ revision: 0, sections: { assessment: "", plan: "" } });
  });

  it("a pharmacist sees medicines and allergies only", async () => {
    as("rph_demo");
    const p = await clinicApi.patient(fid("account:lin"));
    expect(p.medications.length).toBeGreaterThan(0);
    expect(p.profile.allergies.length).toBeGreaterThan(0);
    expect([p.visits, p.notes, p.measurements, p.timeline, p.profile.conditions]).toEqual([[], [], [], [], []]);
  });

  it("admin", async () => {
    as("naritaroad");
    expect((await adminApi.overview(14)).series).toHaveLength(14);
    expect((await adminApi.accounts({ role: "physician" })).items).toHaveLength(2);
    expect((await adminApi.permissions()).permissions).toHaveLength(21);
    expect((await adminApi.oversight()).by_class).toHaveLength(16);
    expect((await adminApi.runs({ status: "interrupted" })).items).toHaveLength(1);
    expect((await adminApi.audit({ actor: fid("account:dr") })).items.length).toBeGreaterThan(2);
    expect((await adminApi.rules()).red_flags.length).toBeGreaterThan(20);
    expect((await adminApi.eval()).history.length).toBeGreaterThan(1);
    expect((await adminApi.models()).length).toBeGreaterThan(1);
  });
});

describe("flows", () => {
  it("renewal: wizard, engine, doctor, pharmacy, next prescription record", async () => {
    as("patient_demo");
    const lin = fid("account:lin");
    const before = m.server.db.prescriptions.filter((p) => p.patient_id === lin).length;
    let rx = await rxApi.get(fid("rx:lin-losartan-draft"));
    const answers: Record<string, unknown> = {};
    for (const q of rx.questions) {
      if (q.scope === "monitoring") continue;
      if (q.kind === "boolean") answers[q.id] = false;
      else if (q.kind === "choice") answers[q.id] = q.options[0].value;
      else answers[q.id] = q.id === "home_sbp" ? 124 : 76;
    }
    for (const i of rx.items) answers[identityKey(i.id)] = true;
    const today = todayInTaipei();
    const monitoring = {
      egfr_k_annual: { date: addDays(today, -75), source: "patient" as const },
      bp_check: { date: today, source: "patient" as const },
    };
    rx = await rxApi.patch(rx.id, rx.revision, { answers, monitoring, step: "review" });
    rx = await rxApi.evaluate(rx.id);
    expect(rx.engine?.disposition).toBe("ready");
    rx = await rxApi.submit(rx.id, rx.revision, "2026-11");
    expect(rx).toMatchObject({ status: "submitted", overdue: false });
    expect(rx.allowed_actions).not.toContain("edit");

    as("dr_demo");
    rx = await rxApi.get(rx.id);
    expect(rx.allowed_actions).toContain("decide");
    const nothing = rxApi.decide(rx.id, { revision: rx.revision, items: [], note: null, patient_message: null });
    await expect(nothing).rejects.toMatchObject({ status: 422 });
    const items = rx.items.map((i) => ({ item_id: i.id, outcome: "approve" as const, note: null }));
    rx = await rxApi.decide(rx.id, { revision: rx.revision, items, note: null, patient_message: "照原來的續開。" });
    expect(rx.status).toBe("at_pharmacy");

    as("rph_demo");
    rx = await rxApi.pharmacy(rx.id, { revision: rx.revision, action: "ready", note: null });
    const checks = { identity: true, allergy: true, interaction: false, quantity: true };
    const half = rxApi.pharmacy(rx.id, { revision: rx.revision, action: "dispense", checks, note: null });
    await expect(half).rejects.toMatchObject({ fields: { "checks.interaction": expect.any(String) } });
    rx = await rxApi.pharmacy(rx.id, { revision: rx.revision, action: "dispense", checks: { ...checks, interaction: true }, note: null });
    expect(rx.status).toBe("dispensed");
    expect(m.server.db.prescriptions.filter((p) => p.patient_id === lin)).toHaveLength(before + 1);
    const told = m.server.db.notifications.filter((n) => n.account_id === lin && n.link === `/app/rx/${rx.id}`);
    expect(told.length).toBeGreaterThanOrEqual(3);
  });

  it("a danger sign makes the request urgent at once", async () => {
    as("patient_demo");
    const rx = await rxApi.get(fid("rx:lin-losartan-draft"));
    const answers: Record<string, unknown> = { urgent_symptoms_now: true };
    for (const q of rx.questions) {
      if (q.scope === "monitoring" || q.id in answers) continue;
      answers[q.id] = q.kind === "boolean" ? false : q.kind === "choice" ? q.options[0].value : 120;
    }
    for (const i of rx.items) answers[identityKey(i.id)] = true;
    const full = await rxApi.patch(rx.id, rx.revision, { answers });
    const sent = await rxApi.submit(full.id, full.revision, "2026-11");
    expect(sent).toMatchObject({ status: "in_review", priority: "urgent", engine: { disposition: "urgent" } });
    expect(m.server.db.tickets.some((t) => t.rx_id === rx.id && t.urgency === "urgent")).toBe(true);
  });

  it("a refill outside the window is refused with the check's result", async () => {
    as("patient_demo");
    const rx = await rxApi.create({ kind: "refill", prescription_ids: [fid("prescription:lin-atorvastatin")] });
    const full = await rxApi.patch(rx.id, rx.revision, { pharmacy_id: "ph-anhe", pickup_window: { date: todayInTaipei(), slot: "evening" }, answers: { symptom_changed: false, side_effects: false, special_status: "none" } });
    const sent = rxApi.submit(full.id, full.revision, "2026-11");
    await expect(sent).rejects.toMatchObject({ status: 422, current: { outcome: "too_early" } });
  });

  it("note: save, sign, addendum; a stale save gets the newer note", async () => {
    as("dr_demo");
    const id = fid("visit:kuo-migraine");
    const note = await visitsApi.note(id);
    const saved = await visitsApi.putNote(id, note.revision, { ...note.sections, plan: "頭痛日記四週。", patient_message: "先記錄四週。" });
    const stale = visitsApi.putNote(id, note.revision, note.sections);
    await expect(stale).rejects.toMatchObject({ status: 409, current: { revision: saved.revision } });
    const signed = await visitsApi.signNote(id, saved.revision);
    expect(signed.status).toBe("signed");
    expect((await visitsApi.addendum(id, "已電話說明。")).addenda).toHaveLength(1);
    expect((await visitsApi.get(id)).visit.status).toBe("reviewed");
  });

  it("an Idempotency-Key gives the first answer again", async () => {
    as("patient_demo");
    const a = await visitsApi.create({}, "key-1");
    const b = await visitsApi.create({}, "key-1");
    expect(b.visit.id).toBe(a.visit.id);
  });

  it("toggles: 409 with the server's version, 429 with Retry-After, offline, empty", async () => {
    as("patient_demo");
    const profile = await patientApi.profile();
    const { updated_at: _u, ...input } = profile;
    Object.assign(m.server.config, parseMock("409*1").config);
    await expect(patientApi.putProfile(input)).rejects.toMatchObject({ status: 409, current: { revision: profile.revision } });
    await expect(patientApi.putProfile(input)).resolves.toMatchObject({ revision: profile.revision + 1 });
    Object.assign(m.server.config, parseMock("429*1").config);
    await expect(visitsApi.create({})).rejects.toMatchObject({ code: "rate_limited", retryAfter: 5 });
    Object.assign(m.server.config, parseMock("empty").config);
    expect((await visitsApi.list()).items).toEqual([]);
    Object.assign(m.server.config, parseMock("full,offline").config);
    await expect(visitsApi.list()).rejects.toMatchObject({ code: "offline" });
    expect(parseMock("as:dr_demo,latency:1200,reset")).toMatchObject({ as: "dr_demo", reset: true, config: { latency: 1200 } });
  });
});
