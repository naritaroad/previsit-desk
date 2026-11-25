// The wizard: server draft is the source, every change is autosaved with a revision, and it resumes anywhere.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rxApi } from "../src/api/endpoints.ts";
import { RxWizard } from "../src/data/core/rxWizard.ts";
import { currentStep, identityKey } from "../src/lib/rx.ts";
import { todayInTaipei } from "../src/lib/format.ts";
import { fid } from "../src/mocks/db.ts";
import { type Browser, browser, type Mock, mock, tick, until } from "./helpers.ts";

const ID = fid("rx:lin-losartan-draft");
let m: Mock;
let b: Browser;
let open: RxWizard[];
beforeEach(() => {
  m = mock();
  m.server.loginAs("patient_demo");
  b = browser();
  open = [];
});
afterEach(() => {
  for (const w of open) w.stop();
  m.stop();
});
async function wizard(env = b.tab()) {
  const w = new RxWizard({ id: ID, accountId: "a", env, debounceMs: 20 });
  open.push(w);
  w.start();
  await until(() => expect(w.state.get().phase).not.toBe("loading"));
  return { w, page: env.page, s: () => w.state.get() };
}
const record = () => m.server.db.rx.find((r) => r.id === ID)!;
/** Another device saves something. */
const elsewhere = (answers: Record<string, unknown>) => rxApi.get(ID).then((rx) => rxApi.patch(ID, rx.revision, { answers: { ...rx.answers, ...answers } }));

describe("autosave and resume", () => {
  it("opens at the stored step with the stored answers", async () => {
    const { s } = await wizard();
    expect(currentStep(s().rx!)).toBe("safety");
    expect(s().rx!.answers.taking_as_prescribed).toBe("all");
  });

  it("shows changes at once and saves step, answers, readings and pharmacy in one request", async () => {
    const { w, s } = await wizard();
    const before = record().revision;
    w.setAnswer("side_effects", false);
    w.setMonitoring("bp_check", { date: todayInTaipei(), source: "patient" });
    w.goTo("monitoring");
    expect(s().rx!.answers.side_effects).toBe(false);
    expect(w.unsaved).toBe(true);
    await until(() => expect(s().status).toBe("saved"));
    expect(record()).toMatchObject({ revision: before + 1, step: "monitoring", answers: { side_effects: false, taking_as_prescribed: "all" } });
    expect(w.unsaved).toBe(false);
  });

  it("clearing an answer removes it on the server", async () => {
    const { w } = await wizard();
    w.setAnswer("urgent_symptoms_now", undefined);
    await w.flush();
    expect(record().answers).not.toHaveProperty("urgent_symptoms_now");
  });

  it("another device continues where this one stopped", async () => {
    const first = await wizard();
    first.w.setAnswer("new_allergy", true);
    first.w.goTo("monitoring");
    await first.w.flush();
    first.w.stop();
    const second = await wizard(browser().tab()); // nothing local there
    expect(second.s().rx).toMatchObject({ step: "monitoring", answers: { new_allergy: true } });
  });

  it("offline work survives a reload and is saved when the network returns", async () => {
    const first = await wizard();
    first.page.emit("offline");
    first.w.setAnswer("hospital_or_er", false);
    await until(() => expect(first.s().status).toBe("offline"));
    first.w.stop();
    expect(record().answers).not.toHaveProperty("hospital_or_er");
    const second = await wizard();
    expect(second.s().rx!.answers.hospital_or_er).toBe(false);
    await until(() => expect(record().answers.hospital_or_er).toBe(false));
    expect(await b.kv.keys("pv:rx:")).toEqual([]);
  });

  it("opened offline with unsent work: the last known version is shown", async () => {
    const first = await wizard();
    first.page.emit("offline");
    first.w.setAnswer("new_medicines", true);
    await tick(40);
    first.w.stop();
    m.server.config.offline = true;
    const second = await wizard();
    expect(second.s()).toMatchObject({ phase: "ready", status: "offline" });
    expect(second.s().rx!.answers.new_medicines).toBe(true);
    m.server.config.offline = false;
    second.page.emit("online");
    await until(() => expect(record().answers.new_medicines).toBe(true));
  });
});

describe("two editors", () => {
  it("different questions are merged without asking", async () => {
    const { w, s } = await wizard();
    await elsewhere({ new_allergy: true });
    w.setAnswer("side_effects", true);
    await w.flush();
    await until(() => expect(record().answers).toMatchObject({ new_allergy: true, side_effects: true }));
    expect(s()).toMatchObject({ conflict: null, rx: { answers: { new_allergy: true, side_effects: true } } });
  });

  it("the same question answered differently is offered for a choice", async () => {
    const { w, s } = await wizard();
    await elsewhere({ side_effects: false });
    w.setAnswer("side_effects", true);
    w.setAnswer("new_medicines", false);
    expect(await w.flush()).toBe(false);
    expect(s()).toMatchObject({ status: "conflict", conflict: { keys: ["answers.side_effects"], theirs: { answers: { side_effects: false } } } });
    w.resolve("theirs");
    await until(() => expect(record().answers).toMatchObject({ side_effects: false, new_medicines: false }));
    expect(s().conflict).toBeNull();
  });

  it("keeping mine overwrites only the conflicting answer", async () => {
    const { w } = await wizard();
    await elsewhere({ side_effects: false, hospital_or_er: true });
    w.setAnswer("side_effects", true);
    await w.flush();
    w.resolve("mine");
    await until(() => expect(record().answers).toMatchObject({ side_effects: true, hospital_or_er: true }));
  });

  it("two tabs follow each other through the channel", async () => {
    const one = await wizard();
    const two = await wizard();
    one.w.setAnswer("new_allergy", false);
    await one.w.flush();
    await until(() => expect(two.s().rx!.answers.new_allergy).toBe(false));
    two.w.setAnswer("new_allergy", true);
    await two.w.flush();
    expect(record().answers.new_allergy).toBe(true);
  });

  it("a request that left the draft state stops being editable", async () => {
    const { w, page, s } = await wizard();
    record().status = "in_review";
    record().revision += 1;
    w.setAnswer("new_allergy", true);
    page.emit("visible"); // back to this tab: it reads the request again
    await until(() => expect(s().rx!.status).toBe("in_review"));
    w.setAnswer("side_effects", true);
    expect(s().rx!.answers).not.toHaveProperty("side_effects");
    expect(w.unsaved).toBe(false);
  });
});

describe("submit", () => {
  async function complete(w: RxWizard) {
    const rx = w.state.get().rx!;
    const answers: Record<string, unknown> = {};
    for (const q of rx.questions) {
      if (q.scope === "monitoring" || q.id === "last_seen_days") continue;
      answers[q.id] = q.kind === "boolean" ? false : q.kind === "choice" ? q.options[0].value : 120;
    }
    for (const i of rx.items) answers[identityKey(i.id)] = true;
    w.setAnswers(answers);
  }

  it("says what is missing, in wizard order", async () => {
    const { w } = await wizard();
    const missing = w.missing(todayInTaipei());
    expect(missing[0]).toMatchObject({ step: "identity" });
    expect(missing.some((x) => x.step === "safety")).toBe(true);
    await complete(w);
    expect(w.missing(todayInTaipei())).toEqual([]);
  });

  it("saves what is unsaved, then submits with the latest revision", async () => {
    const { w, s } = await wizard();
    await complete(w);
    const rx = await w.submit("2026-11");
    expect(rx).toMatchObject({ status: "submitted" });
    expect(s()).toMatchObject({ submitting: false, rx: { status: "submitted" } });
    expect(record().answers.kidney_liver_change).toBe(false);
    expect(await b.kv.keys("pv:rx:")).toEqual([]);
  });

  it("a refused submit puts field messages in the state", async () => {
    const { w, s } = await wizard();
    await expect(w.submit("2026-11")).rejects.toMatchObject({ status: 422 });
    expect(Object.keys(s().fields).length).toBeGreaterThan(0);
    expect(s().submitting).toBe(false);
  });

  it("previews the engine without sending", async () => {
    const { w, s } = await wizard();
    await complete(w);
    const rx = await w.evaluate();
    expect(rx?.engine).not.toBeNull();
    expect(s().rx!.status).toBe("draft");
  });

  it("cancel closes the draft", async () => {
    const { w } = await wizard();
    expect((await w.cancel())?.status).toBe("cancelled");
  });
});
