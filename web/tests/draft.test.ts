// Drafts: local first, debounced to the server with a revision, offline tolerant, conflicts offered, tabs in step.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors.ts";
import type { DraftRecord } from "../src/api/types.ts";
import { type DraftApi, DraftController } from "../src/data/core/draft.ts";
import { type Browser, browser, deferred } from "./helpers.ts";

type Text = { text: string };
const SCOPE = "visit:1:composer";
const KEY = `pv:draft:a:${SCOPE}`;

class Server implements DraftApi {
  record: DraftRecord<unknown> | null = null;
  puts: { payload: unknown; revision: number; keepalive: boolean }[] = [];
  down: ApiError | null = null;
  gate: Promise<void> | null = null;
  async get<T>(): Promise<DraftRecord<T>> {
    if (this.down) throw this.down;
    if (!this.record) throw new ApiError({ status: 404, code: "not_found" });
    return structuredClone(this.record) as DraftRecord<T>;
  }
  async put<T>(scope: string, payload: T, revision: number, keepalive: boolean): Promise<DraftRecord<T>> {
    if (this.gate) await this.gate;
    if (this.down) throw this.down;
    this.puts.push({ payload: structuredClone(payload), revision, keepalive });
    if ((this.record?.revision ?? 0) !== revision) throw new ApiError({ status: 409, code: "conflict", current: this.record });
    this.record = { scope, payload: structuredClone(payload), revision: revision + 1, updated_at: `2026-11-25T08:00:0${revision}Z` };
    return structuredClone(this.record) as DraftRecord<T>;
  }
  async del(): Promise<void> {
    this.record = null;
  }
  /** Saved from another device. */
  elsewhere(text: string) {
    this.record = { scope: SCOPE, payload: { text }, revision: (this.record?.revision ?? 0) + 1, updated_at: "2026-11-25T09:00:00Z" };
  }
}

let b: Browser;
let server: Server;
let open: DraftController<Text>[];
beforeEach(() => {
  vi.useFakeTimers();
  b = browser();
  server = new Server();
  open = [];
});
afterEach(() => {
  for (const d of open) d.stop();
  vi.useRealTimers();
});
async function tab(env = b.tab()) {
  const draft = new DraftController<Text>({ scope: SCOPE, accountId: "a", initial: { text: "" }, env, api: server, debounceMs: 800 });
  open.push(draft);
  draft.start();
  await vi.advanceTimersByTimeAsync(1);
  return { draft, page: env.page, s: () => draft.state.get() };
}
const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("autosave", () => {
  it("writes every change to this device at once and to the server after a pause", async () => {
    const t = await tab();
    expect(t.s()).toMatchObject({ ready: true, status: "idle", value: { text: "" } });
    t.draft.set({ text: "頭" });
    t.draft.set({ text: "頭痛" });
    await pass(1);
    expect(await b.kv.get(KEY)).toMatchObject({ value: { text: "頭痛" }, dirty: true });
    expect(server.puts).toEqual([]);
    await pass(800);
    expect(server.puts).toEqual([{ payload: { text: "頭痛" }, revision: 0, keepalive: false }]);
    expect(t.s()).toMatchObject({ status: "saved", dirty: false, savedAt: expect.any(String) });
    expect(await b.kv.get(KEY)).toMatchObject({ dirty: false, revision: 1 });
  });

  it("saves at least every five seconds while typing without a pause", async () => {
    const t = await tab();
    for (let i = 0; i < 20; i++) {
      t.draft.set({ text: "字".repeat(i + 1) });
      await pass(400);
    }
    expect(server.puts.length).toBeGreaterThanOrEqual(1);
  });

  it("typing during a save is saved again on top of the new revision", async () => {
    const t = await tab();
    const gate = deferred<void>();
    server.gate = gate.promise;
    t.draft.set({ text: "一" });
    await pass(800);
    t.draft.set({ text: "一二" });
    gate.resolve();
    server.gate = null;
    await pass(1000);
    expect(server.puts.map((p) => [p.payload, p.revision])).toEqual([
      [{ text: "一" }, 0],
      [{ text: "一二" }, 1],
    ]);
    expect(t.s()).toMatchObject({ dirty: false, status: "saved" });
  });

  it("a reload shows the local copy before the server answers, then continues from the server", async () => {
    const t = await tab();
    t.draft.set({ text: "寫到一半" });
    await pass(1);
    t.page.emit("offline"); // the tab dies before it could save
    t.draft.stop();
    const again = await tab();
    expect(again.s()).toMatchObject({ ready: true, value: { text: "寫到一半" } });
    await pass(50);
    expect(server.record).toMatchObject({ payload: { text: "寫到一半" }, revision: 1 });
  });

  it("another device: the newer server version is shown when nothing is unsaved here", async () => {
    server.elsewhere("手機寫的");
    const t = await tab();
    expect(t.s()).toMatchObject({ value: { text: "手機寫的" }, status: "saved", dirty: false });
  });

  it("pagehide and hiding the page flush with keepalive", async () => {
    const t = await tab();
    t.draft.set({ text: "離開前" });
    t.page.emit("pagehide");
    await pass(1);
    expect(server.puts).toEqual([{ payload: { text: "離開前" }, revision: 0, keepalive: true }]);
  });

  it("clear removes it everywhere and later edits start a new draft", async () => {
    const t = await tab();
    t.draft.set({ text: "已送出" });
    await pass(900);
    await t.draft.clear();
    expect(server.record).toBeNull();
    expect(await b.kv.get(KEY)).toBeUndefined();
    expect(t.s()).toMatchObject({ value: { text: "" }, status: "idle" });
    t.draft.set({ text: "下一則" });
    await pass(900);
    expect(server.record).toMatchObject({ payload: { text: "下一則" }, revision: 1 });
  });

  it("clear while a save is on its way does not bring the draft back", async () => {
    const t = await tab();
    const gate = deferred<void>();
    server.gate = gate.promise;
    t.draft.set({ text: "送出中" });
    await pass(800);
    const cleared = t.draft.clear();
    gate.resolve();
    await pass(10);
    await cleared;
    expect(server.record).toBeNull();
    expect(await b.kv.get(KEY)).toBeUndefined();
    expect(t.s()).toMatchObject({ value: { text: "" }, dirty: false });
  });
});

describe("offline", () => {
  it("says offline, keeps the text, and saves when the network is back", async () => {
    const t = await tab();
    t.page.emit("offline");
    t.draft.set({ text: "沒網路" });
    await pass(900);
    expect(t.s()).toMatchObject({ status: "offline", dirty: true });
    expect(await b.kv.get(KEY)).toMatchObject({ value: { text: "沒網路" }, dirty: true });
    t.page.emit("online");
    await pass(10);
    expect(t.s()).toMatchObject({ status: "saved", dirty: false });
  });

  it("server errors are retried with backoff", async () => {
    const t = await tab();
    server.down = new ApiError({ status: 503, code: "internal" });
    t.draft.set({ text: "再試" });
    await pass(900);
    expect(t.s()).toMatchObject({ status: "offline" });
    server.down = null;
    await pass(2000);
    expect(t.s()).toMatchObject({ status: "saved" });
  });

  it("started offline: local work is not overwritten, and nothing is sent before the server's version is known", async () => {
    server.elsewhere("伺服器上的");
    server.down = new ApiError({ status: 0, code: "offline" });
    const t = await tab();
    t.draft.set({ text: "本機的" });
    await pass(900);
    expect(server.puts).toEqual([]);
    server.down = null;
    t.page.emit("online");
    await pass(10);
    expect(t.s()).toMatchObject({ status: "conflict", conflict: { mine: { text: "本機的" }, theirs: { text: "伺服器上的" } } });
    expect(server.puts).toEqual([]);
  });

  it("a refusal that retrying cannot fix is reported, and the text stays", async () => {
    const t = await tab();
    server.down = new ApiError({ status: 422, code: "invalid_request", fields: { payload: "太長" } });
    t.draft.set({ text: "長".repeat(20) });
    await pass(900);
    expect(t.s()).toMatchObject({ error: { code: "invalid_request" }, dirty: true });
    await pass(60_000);
    expect(server.puts).toEqual([]);
  });
});

describe("conflict", () => {
  async function conflicted() {
    const t = await tab();
    t.draft.set({ text: "第一版" });
    await pass(900);
    server.elsewhere("別台裝置");
    t.draft.set({ text: "我的第二版" });
    await pass(900);
    expect(t.s()).toMatchObject({ status: "conflict", conflict: { mine: { text: "我的第二版" }, theirs: { text: "別台裝置" } } });
    return t;
  }
  it("keeps both versions and sends nothing until someone chooses", async () => {
    const t = await conflicted();
    const sent = server.puts.length;
    t.draft.set({ text: "我的第三版" });
    await pass(10_000);
    expect(server.puts).toHaveLength(sent);
    expect(t.s().conflict?.mine).toEqual({ text: "我的第三版" });
    expect(server.record?.payload).toEqual({ text: "別台裝置" });
  });
  it("mine overwrites on top of theirs", async () => {
    const t = await conflicted();
    t.draft.resolve("mine");
    await pass(10);
    expect(server.record).toMatchObject({ payload: { text: "我的第二版" }, revision: 3 });
    expect(t.s()).toMatchObject({ status: "saved", conflict: null });
  });
  it("theirs replaces the local text", async () => {
    const t = await conflicted();
    t.draft.resolve("theirs");
    await pass(10);
    expect(t.s()).toMatchObject({ value: { text: "別台裝置" }, status: "saved", dirty: false });
    expect(server.record?.revision).toBe(2);
    t.draft.set({ text: "接著寫" });
    await pass(900);
    expect(server.record).toMatchObject({ payload: { text: "接著寫" }, revision: 3 });
  });
  it("a merged text is saved", async () => {
    const t = await conflicted();
    t.draft.resolve({ merged: { text: "兩邊都要" } });
    await pass(10);
    expect(server.record?.payload).toEqual({ text: "兩邊都要" });
  });
  it("the same text on both sides is no conflict", async () => {
    const t = await tab();
    t.draft.set({ text: "第一版" });
    await pass(900);
    server.elsewhere("一樣");
    t.draft.set({ text: "一樣" });
    await pass(900);
    expect(t.s()).toMatchObject({ status: "saved", conflict: null, dirty: false });
  });
  it("deleted on another device (sent there): asks instead of bringing it back", async () => {
    const t = await tab();
    t.draft.set({ text: "第一版" });
    await pass(900);
    server.record = null;
    t.draft.set({ text: "還在改" });
    await pass(900);
    expect(t.s()).toMatchObject({ status: "conflict", conflict: { theirs: null, mine: { text: "還在改" } } });
    t.draft.resolve("mine");
    await pass(10);
    expect(server.record).toMatchObject({ payload: { text: "還在改" }, revision: 1 });
  });
});

describe("tabs", () => {
  it("edits appear in the other tab, and only the editing tab saves", async () => {
    const one = await tab();
    const two = await tab();
    one.draft.set({ text: "左邊打字" });
    await pass(1);
    expect(two.s()).toMatchObject({ value: { text: "左邊打字" } });
    await pass(900);
    expect(server.puts).toHaveLength(1);
    expect(two.s()).toMatchObject({ status: "saved", dirty: false });
    two.draft.set({ text: "右邊接著打" });
    await pass(900);
    expect(server.puts.at(-1)).toMatchObject({ payload: { text: "右邊接著打" }, revision: 1 });
    expect(one.s()).toMatchObject({ value: { text: "右邊接著打" }, status: "saved" });
  });
  it("a tab closed before saving: the other one saves for it", async () => {
    const one = await tab();
    await tab();
    one.page.isOnline = false; // its keepalive flush cannot go out either
    one.draft.set({ text: "來不及存" });
    await pass(1);
    one.draft.stop();
    await pass(6000);
    expect(server.record?.payload).toEqual({ text: "來不及存" });
  });
  it("clearing in one tab clears the other", async () => {
    const one = await tab();
    const two = await tab();
    one.draft.set({ text: "送出這則" });
    await pass(900);
    await one.draft.clear();
    await pass(5);
    expect(two.s()).toMatchObject({ value: { text: "" }, status: "idle" });
  });
});
