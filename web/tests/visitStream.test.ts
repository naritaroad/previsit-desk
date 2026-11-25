// The live visit: load, replay, dedupe by seq, reconnect with Last-Event-ID, pause when hidden, live text,
// interrupted and failed turns. Against the mock server, plus a hand-driven stream for the timing rules.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { visitsApi } from "../src/api/endpoints.ts";
import { ApiError } from "../src/api/errors.ts";
import type { OpenStreamOptions } from "../src/api/sse.ts";
import { AccountStream } from "../src/data/core/accountStream.ts";
import { VisitStream, type VisitStreamOptions } from "../src/data/core/visitStream.ts";
import type { AccountEvent, VisitDetail } from "../src/api/types.ts";
import { uuid } from "../src/lib/ids.ts";
import { fid } from "../src/mocks/db.ts";
import { browser, type Mock, mock, tick, until } from "./helpers.ts";

let m: Mock;
let open: { stop(): void }[];
beforeEach(() => {
  m = mock();
  m.server.loginAs("patient_demo");
  open = [];
});
afterEach(() => {
  vi.useRealTimers();
  for (const x of open) x.stop();
  m.stop();
});
function stream(visitId: string, o: Partial<VisitStreamOptions> = {}, env = browser().tab()) {
  const v = new VisitStream({ visitId, env, ...o });
  open.push(v);
  v.start();
  return { v, page: env.page, s: () => v.state.get() };
}
const send = (visitId: string, content: string) => visitsApi.send(visitId, { content, client_id: uuid() });

describe("with the mock server", () => {
  const ACTIVE = fid("visit:lin-glucose");

  it("loads, opens the stream after last_seq, and shows a whole turn", async () => {
    const { s } = stream(ACTIVE);
    await until(() => expect(s().connection).toBe("open"));
    const before = s().messages.length;
    await send(ACTIVE, "沒有增減");
    await until(() => expect(s().run.phase).toBe("idle"));
    await until(() => expect(s().messages).toHaveLength(before + 2));
    expect(s().messages.map((x) => x.seq)).toEqual([...s().messages.map((x) => x.seq)].sort((a, b) => a - b));
    expect(s().messages.at(-1)).toMatchObject({ role: "assistant", kind: "chat" });
    expect(s().live).toBeNull();
    expect(s().intake?.missing).not.toContain("medications");
    expect(s().runs.at(-1)).toMatchObject({ status: "completed" });
    expect(s().trace.some((r) => r.name === "record_intake" && r.status === "ok")).toBe(true);
    expect(s().lastSeq).toBe(m.server.db.visits.find((v) => v.id === ACTIVE)!.seq);
  });

  it("shows text as it arrives, then the stored text", async () => {
    m.server.config.pace = 0.15;
    const { s, v } = stream(ACTIVE);
    await until(() => expect(s().connection).toBe("open"));
    const seen: string[] = [];
    v.state.subscribe(() => s().live && seen.push(s().live!.text));
    await send(ACTIVE, "/slow");
    await until(() => expect(s().run.phase).toBe("running"));
    await until(() => expect(s().messages.at(-1)?.content).toContain("測試回覆"), 8000);
    expect(seen.length).toBeGreaterThan(5);
    expect(s().messages.at(-1)!.content.startsWith(seen[0])).toBe(true);
    expect(s().live).toBeNull();
  });

  it("events missed while disconnected are replayed once", async () => {
    const { s, page } = stream(ACTIVE);
    await until(() => expect(s().connection).toBe("open"));
    page.emit("offline");
    expect(s().connection).toBe("offline");
    const known = s().messages.length;
    await send(ACTIVE, "斷線時寫的");
    await tick(60);
    expect(s().messages).toHaveLength(known);
    page.emit("online");
    await until(() => expect(s().messages).toHaveLength(known + 2));
    expect(new Set(s().messages.map((x) => x.id)).size).toBe(s().messages.length);
    expect(s().run.phase).toBe("idle");
  });

  it("a cut stream reconnects by itself", async () => {
    const { s } = stream(ACTIVE);
    await until(() => expect(s().connection).toBe("open"));
    m.server.closeStreams();
    await until(() => expect(s().connection).toBe("retrying"));
    await until(() => expect(s().connection).toBe("open"));
    await send(ACTIVE, "重連後");
    await until(() => expect(s().messages.some((x) => x.content === "重連後")).toBe(true));
  });

  it("our own message shows once whether the answer or the event comes first", async () => {
    const { v, s } = stream(ACTIVE);
    await until(() => expect(s().connection).toBe("open"));
    const result = await send(ACTIVE, "只出現一次");
    await until(() => expect(s().messages.filter((x) => x.content === "只出現一次")).toHaveLength(1));
    v.onSent(result);
    expect(s().messages.filter((x) => x.content === "只出現一次")).toHaveLength(1);
  });

  it("red flag: emergency state at once, whatever the status was", async () => {
    const { s } = stream(ACTIVE);
    await until(() => expect(s().connection).toBe("open"));
    await send(ACTIVE, "現在胸口很悶，喘不過氣");
    await until(() => expect(s().redFlag).not.toBeNull());
    await until(() => expect(s().messages.at(-1)?.kind).toBe("red_flag"));
    expect(s().visit).toMatchObject({ status: "red_flag", urgency: "urgent" });
    expect(s().tickets.some((t) => t.reason === "red_flag")).toBe(true);
    expect(s().run.phase).toBe("idle");
  });

  it("interrupted: marked, and retry runs the turn again", async () => {
    const { v, s } = stream(ACTIVE);
    await until(() => expect(s().connection).toBe("open"));
    await send(ACTIVE, "/interrupt");
    await until(() => expect(s().run).toMatchObject({ phase: "interrupted", code: "interrupted" }));
    const before = s().messages.length;
    await v.retryRun();
    await until(() => expect(s().messages.length).toBeGreaterThan(before));
    await until(() => expect(s().run.phase).toBe("idle"));
  });

  it("failed: the code is kept; a second retry press while one runs is harmless", async () => {
    m.server.config.pace = 0.3;
    const { v, s } = stream(ACTIVE);
    await until(() => expect(s().connection).toBe("open"));
    await send(ACTIVE, "/fail");
    await until(() => expect(s().run).toMatchObject({ phase: "failed", code: "model_error" }));
    await v.retryRun();
    await expect(v.retryRun()).rejects.toMatchObject({ code: "conflict" });
    expect(s().run.phase).toBe("running");
  });

  it("a visit stored with an interrupted run opens ready to retry", async () => {
    m.server.db.sessions[0].account_id = fid("account:liu");
    const { s } = stream(fid("visit:liu-stopped"));
    await until(() => expect(s().phase).toBe("ready"));
    expect(s().run.phase).toBe("interrupted");
  });

  it("take-over by staff reaches the patient", async () => {
    const { s } = stream(ACTIVE);
    await until(() => expect(s().connection).toBe("open"));
    const token = m.server.currentToken()!;
    m.server.loginAs("cm_demo");
    await visitsApi.takeover(ACTIVE);
    await visitsApi.staffSend(ACTIVE, { content: "您好，我是個案管理師。", client_id: uuid() });
    await until(() => expect(s().visit?.mode).toBe("human"));
    await until(() => expect(s().messages.at(-1)).toMatchObject({ role: "staff", author: { display_name: "許雅雯" } }));
    m.server.storage.setItem("pv-mock:session", token);
    const { run_id } = await send(ACTIVE, "謝謝");
    expect(run_id).toBeNull();
  });

  it("note.signed without a note makes it read the visit again", async () => {
    const id = fid("visit:lin-dizzy");
    const { s } = stream(id);
    await until(() => expect(s().connection).toBe("open"));
    m.server.loginAs("dr_demo");
    const note = await visitsApi.note(id);
    const saved = await visitsApi.putNote(id, 0, { ...note.sections, assessment: "姿勢性低血壓可能", plan: "抽血", patient_message: "起身慢一點。" });
    await visitsApi.signNote(id, saved.revision);
    m.server.loginAs("patient_demo");
    await until(() => expect(s().visit?.status).toBe("reviewed"));
    await until(() => expect(s().note?.sections.patient_message).toBe("起身慢一點。"));
    expect(s().note?.sections.assessment).toBe("");
  });

  it("not found and no access are final errors", async () => {
    const { s } = stream("00000000-0000-4000-8000-000000000000");
    await until(() => expect(s()).toMatchObject({ phase: "error", error: { code: "not_found" }, connection: "closed" }));
  });
});

describe("timing", () => {
  const detail = (seq: number): VisitDetail => ({
    ...({} as VisitDetail),
    visit: { id: "v", last_seq: seq, mode: "ai", status: "active" } as VisitDetail["visit"],
    messages: [],
    intake: {} as VisitDetail["intake"],
    summary: null,
    red_flag: null,
    tickets: [],
    tool_calls: [],
    runs: [],
    refill_checks: [],
    note: null,
  });
  /** Every connection attempt, driven by the test. */
  function driver() {
    const calls: { path: string; o: OpenStreamOptions; end: () => void; fail: (e: unknown) => void }[] = [];
    const openStream = (path: string, o: OpenStreamOptions) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ path, o, end: resolve, fail: reject });
        o.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        o.onOpen?.();
      });
    return { calls, openStream };
  }
  const start = async (o: Partial<VisitStreamOptions> = {}) => {
    vi.useFakeTimers();
    const d = driver();
    const t = stream("v", { load: async () => detail(7), open: d.openStream, ...o });
    await vi.advanceTimersByTimeAsync(1);
    return { ...d, ...t };
  };

  it("resumes after the last event, with Last-Event-ID, and drops events it has seen", async () => {
    const { calls, s } = await start();
    expect(calls[0].path).toContain("after=7");
    calls[0].o.onEnvelope({ seq: 8, type: "message.completed", data: { message_id: "m1", kind: "chat", content: "一", run_id: "r" } });
    calls[0].o.onEnvelope({ seq: 8, type: "message.completed", data: { message_id: "m1", kind: "chat", content: "重複", run_id: "r" } });
    calls[0].end();
    await vi.advanceTimersByTimeAsync(600);
    expect(calls[1].path).toContain("after=8");
    expect(calls[1].o.lastEventId).toBe(8);
    calls[1].o.onEnvelope({ seq: 8, type: "message.completed", data: { message_id: "m1", kind: "chat", content: "重播", run_id: "r" } });
    expect(s().messages.map((x) => x.content)).toEqual(["一"]);
  });

  it("backs off 0.5, 1, 2 s … and starts over after an event", async () => {
    const { calls, s } = await start();
    const gaps: number[] = [];
    for (let i = 0; i < 4; i++) {
      calls.at(-1)!.fail(new ApiError({ status: 0, code: "offline" }));
      await vi.advanceTimersByTimeAsync(0);
      gaps.push(s().retryAt! - Date.now());
      await vi.advanceTimersByTimeAsync(gaps.at(-1)!);
    }
    expect(gaps).toEqual([500, 1000, 2000, 4000]);
    calls.at(-1)!.o.onEnvelope({ seq: 9, type: "visit.updated", data: { id: "v", last_seq: 9 } });
    calls.at(-1)!.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(s().retryAt! - Date.now()).toBe(500);
  });

  it("honours Retry-After", async () => {
    const { calls, s } = await start();
    calls[0].fail(new ApiError({ status: 429, code: "rate_limited", retryAfter: 12 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(s().retryAt! - Date.now()).toBe(12_000);
  });

  it("treats 40 s without a byte as a dead connection; keep-alives feed it", async () => {
    const { calls, s } = await start();
    await vi.advanceTimersByTimeAsync(30_000);
    calls[0].o.onActivity?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s().connection).toBe("open");
    await vi.advanceTimersByTimeAsync(11_000);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("pauses ten seconds after the page is hidden and resumes when it is back", async () => {
    const { calls, page, s } = await start();
    page.emit("hidden");
    await vi.advanceTimersByTimeAsync(5000);
    expect(s().connection).toBe("open"); // a quick look at another tab changes nothing
    page.emit("visible");
    page.emit("hidden");
    await vi.advanceTimersByTimeAsync(10_500);
    expect(s().connection).toBe("paused");
    expect(calls[0].o.signal.aborted).toBe(true);
    page.emit("visible");
    await vi.advanceTimersByTimeAsync(1);
    expect(s().connection).toBe("open");
    expect(calls).toHaveLength(2);
  });

  it("partial text is dropped on reconnect because deltas are not replayed", async () => {
    const { calls, s } = await start();
    calls[0].o.onEnvelope({ seq: 8, type: "run.started", data: { run_id: "r", model: "x" } });
    calls[0].o.onEnvelope({ seq: null, type: "message.delta", data: { text: "一半" } });
    expect(s().live?.text).toBe("一半");
    calls[0].end();
    await vi.advanceTimersByTimeAsync(600);
    expect(s()).toMatchObject({ live: null, run: { phase: "running" } });
  });

  it("stops for good when access is taken away", async () => {
    const { calls, s } = await start();
    calls[0].fail(new ApiError({ status: 403, code: "forbidden" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(s()).toMatchObject({ phase: "error", connection: "closed", error: { code: "forbidden" } });
  });
});

describe("account stream", () => {
  it("one connection for all tabs; everyone hears every event; another tab takes over", async () => {
    const b = browser();
    const heard: string[][] = [[], []];
    const tabs = heard.map((log) => {
      const s = new AccountStream({ accountId: "a", env: b.tab(), onEvent: (e: AccountEvent) => log.push(e.type), onReconnected: () => log.push("reconnected") });
      open.push(s);
      s.start();
      return s;
    });
    await until(() => expect(tabs[0].state.get()).toEqual({ connection: "open", leader: true }));
    expect(m.server.openStreams).toBe(1);
    await visitsApi.create({});
    m.server.live.publish({ to: { account: fid("account:lin") }, seq: null, type: "rx.changed", data: { id: "x" } });
    await until(() => expect(heard).toEqual([["rx.changed"], ["rx.changed"]]));
    tabs[0].stop();
    await until(() => expect(tabs[1].state.get()).toEqual({ connection: "open", leader: true }));
    m.server.live.publish({ to: { account: fid("account:lin") }, seq: null, type: "visit.changed", data: { id: "y" } });
    await until(() => expect(heard[1]).toContain("visit.changed"));
    expect(m.server.openStreams).toBe(1);
  });

  it("after a break everything shown is refreshed", async () => {
    const log: string[] = [];
    const s = new AccountStream({ accountId: "a", env: browser().tab(), onEvent: () => undefined, onReconnected: () => log.push("reconnected") });
    open.push(s);
    s.start();
    await until(() => expect(s.state.get().connection).toBe("open"));
    m.server.closeStreams();
    await until(() => expect(log).toEqual(["reconnected"]));
  });
});
