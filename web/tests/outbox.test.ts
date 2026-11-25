// Messages survive reload, offline and tab close, go out in order, and arrive exactly once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors.ts";
import type { Message, SendMessageResult } from "../src/api/types.ts";
import { Outbox, type OutboxItem, type OutboxOptions } from "../src/data/core/outbox.ts";
import { type Browser, browser, deferred, tick, until } from "./helpers.ts";

const VISIT = "visit-1";
/** Keeps one message per client_id, like the real endpoint. */
class Server {
  readonly stored: { client_id: string; content: string; visit: string }[] = [];
  calls = 0;
  /** Runs before the message is stored (throw = request lost) and after (throw = answer lost). */
  before: (item: OutboxItem) => Promise<void> = async () => undefined;
  after: (item: OutboxItem) => Promise<void> = async () => undefined;
  send = async (item: OutboxItem): Promise<SendMessageResult> => {
    this.calls += 1;
    await this.before(item);
    if (!this.stored.some((s) => s.client_id === item.client_id)) this.stored.push({ client_id: item.client_id, content: item.content, visit: item.visit_id });
    await this.after(item);
    const message: Message = { id: `m-${item.client_id}`, client_id: item.client_id, seq: this.stored.length, role: "patient", kind: "chat", author: null, content: item.content, created_at: "2026-11-25T08:00:00Z", run_id: null, status: "ok" };
    return { message, run_id: null };
  };
  get texts() {
    return this.stored.map((s) => s.content);
  }
}
const offlineError = () => new ApiError({ status: 0, code: "offline" });

let b: Browser;
let server: Server;
let open: Outbox[];
beforeEach(() => {
  b = browser();
  server = new Server();
  open = [];
});
afterEach(() => {
  for (const o of open) o.stop();
  vi.useRealTimers();
});
function tab(o: Partial<OutboxOptions> = {}, env = b.tab()) {
  const outbox = new Outbox({ accountId: "a", env, send: server.send, ...o });
  open.push(outbox);
  outbox.start();
  return { outbox, page: env.page };
}

describe("sending", () => {
  it("stores the message before anything is sent, then shows queued → sending → sent", async () => {
    const gate = deferred<void>();
    server.before = () => gate.promise;
    const { outbox } = tab();
    const id = await outbox.enqueue({ visit_id: VISIT, content: "頭痛三天" });
    expect(await b.kv.get<OutboxItem[]>("pv:outbox:a")).toMatchObject([{ client_id: id, content: "頭痛三天" }]);
    await until(() => expect(outbox.itemsFor(VISIT)[0].status).toBe("sending"));
    expect(outbox.hasUnsent(VISIT)).toBe(true);
    gate.resolve();
    await until(() => expect(outbox.itemsFor(VISIT)[0]).toMatchObject({ status: "sent", message_id: `m-${id}` }));
    expect(outbox.hasUnsent()).toBe(false);
    await outbox.confirm([id]); // the stream showed it
    expect(outbox.itemsFor(VISIT)).toEqual([]);
  });

  it("keeps the order within a visit and does not hold up other visits", async () => {
    const gate = deferred<void>();
    server.before = (i) => (i.content === "一" ? gate.promise : Promise.resolve());
    const { outbox } = tab();
    for (const content of ["一", "二", "三"]) await outbox.enqueue({ visit_id: VISIT, content });
    await outbox.enqueue({ visit_id: "visit-2", content: "別的" });
    await tick(20);
    expect(server.texts).toEqual([]); // one request at a time; the first one is still open
    gate.resolve();
    await until(() => expect(server.texts).toHaveLength(4));
    expect(server.stored.filter((s) => s.visit === VISIT).map((s) => s.content)).toEqual(["一", "二", "三"]);
  });

  it("waits while a turn is running on the visit", async () => {
    const busy = new Set([VISIT]);
    const { outbox } = tab({ isBusy: (v) => busy.has(v) });
    await outbox.enqueue({ visit_id: VISIT, content: "等一下" });
    await tick(30);
    expect(server.calls).toBe(0);
    expect(outbox.itemsFor(VISIT)[0].status).toBe("queued");
    busy.clear();
    outbox.poke();
    await until(() => expect(server.texts).toEqual(["等一下"]));
  });
});

describe("failures", () => {
  it("an answer that got lost is sent again with the same client_id and stored once", async () => {
    let lose = true;
    server.after = async () => {
      if (lose) {
        lose = false;
        throw offlineError();
      }
    };
    const { outbox } = tab();
    await outbox.enqueue({ visit_id: VISIT, content: "只能有一則" });
    await until(() => expect(outbox.itemsFor(VISIT)[0].status).toBe("sent"));
    expect(server.calls).toBe(2);
    expect(server.texts).toEqual(["只能有一則"]);
  });

  it("offline: nothing is tried; going online sends everything in order", async () => {
    const { outbox, page } = tab();
    page.emit("offline");
    for (const content of ["甲", "乙"]) await outbox.enqueue({ visit_id: VISIT, content });
    await tick(20);
    expect(server.calls).toBe(0);
    page.emit("online");
    await until(() => expect(server.texts).toEqual(["甲", "乙"]));
  });

  it("a refused message is marked failed, blocks the ones behind it, and can be retried or taken back", async () => {
    server.before = async (i) => {
      if (i.content === "太長") throw new ApiError({ status: 422, code: "invalid_request", fields: { content: "太長" } });
    };
    const { outbox } = tab();
    const bad = await outbox.enqueue({ visit_id: VISIT, content: "太長" });
    await outbox.enqueue({ visit_id: VISIT, content: "後面" });
    await until(() => expect(outbox.itemsFor(VISIT).map((i) => i.status)).toEqual(["failed", "queued"]));
    await outbox.retry(bad);
    await until(() => expect(server.calls).toBe(2));
    await until(() => expect(outbox.itemsFor(VISIT)[0].status).toBe("failed"));
    expect(await outbox.discard(bad)).toBe("太長");
    await until(() => expect(server.texts).toEqual(["後面"]));
  });

  it("429 waits for Retry-After; a busy 409 is retried without showing an error", async () => {
    vi.useFakeTimers();
    const answers = [new ApiError({ status: 429, code: "rate_limited", retryAfter: 7 }), new ApiError({ status: 409, code: "conflict" })];
    server.before = async () => {
      const e = answers.shift();
      if (e) throw e;
    };
    const { outbox } = tab();
    await outbox.enqueue({ visit_id: VISIT, content: "慢慢來" });
    await vi.advanceTimersByTimeAsync(10);
    expect(outbox.itemsFor(VISIT)[0]).toMatchObject({ status: "queued", error: { code: "rate_limited", retryAfter: 7 } });
    await vi.advanceTimersByTimeAsync(6900);
    expect(server.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(server.calls).toBe(2);
    expect(outbox.itemsFor(VISIT)[0]).toMatchObject({ status: "queued", error: null });
    await vi.advanceTimersByTimeAsync(1600);
    expect(server.texts).toEqual(["慢慢來"]);
  });

  it("an ended session pauses the queue; the message is sent after signing in again", async () => {
    let signedIn = false;
    server.before = async () => {
      if (!signedIn) throw new ApiError({ status: 401, code: "unauthorized" });
    };
    const first = tab();
    await first.outbox.enqueue({ visit_id: VISIT, content: "登入過期時寫的" });
    await until(() => expect(first.outbox.itemsFor(VISIT)[0]).toMatchObject({ status: "queued", error: { code: "unauthorized" } }));
    await tick(50);
    expect(server.calls).toBe(1);
    first.outbox.stop();
    signedIn = true;
    tab(); // signed in again
    await until(() => expect(server.texts).toEqual(["登入過期時寫的"]));
  });
});

describe("reload and tabs", () => {
  it("a message that was being sent when the tab died is sent by the next one, once", async () => {
    const never = deferred<void>();
    server.after = () => never.promise; // stored on the server, but the tab never hears
    const first = tab();
    await first.outbox.enqueue({ visit_id: VISIT, content: "關掉分頁" });
    await until(() => expect(server.texts).toEqual(["關掉分頁"]));
    first.outbox.stop(); // tab closed mid-request
    expect((await b.kv.get<OutboxItem[]>("pv:outbox:a"))?.[0].status).toBe("sending");
    server.after = async () => undefined;
    const second = tab();
    await until(() => expect(second.outbox.itemsFor(VISIT)[0].status).toBe("sent"));
    expect(server.calls).toBe(2);
    expect(server.texts).toEqual(["關掉分頁"]);
  });

  it("only the leader sends; followers queue, see every state, and take over when it closes", async () => {
    const one = tab();
    const two = tab();
    const sentInTwo: string[] = [];
    await until(() => expect([one.outbox.state.get().leader, two.outbox.state.get().leader]).toEqual([true, false]));
    await two.outbox.enqueue({ visit_id: VISIT, content: "從第二個分頁" });
    await until(() => expect(two.outbox.itemsFor(VISIT)[0]?.status).toBe("sent"));
    expect(server.calls).toBe(1);

    const gate = deferred<void>();
    server.before = () => gate.promise;
    await two.outbox.enqueue({ visit_id: VISIT, content: "接手" });
    await until(() => expect(one.outbox.itemsFor(VISIT).at(-1)?.status).toBe("sending"));
    one.outbox.stop();
    server.before = async () => undefined;
    gate.resolve();
    await until(() => expect(two.outbox.state.get().leader).toBe(true));
    await until(() => expect(two.outbox.itemsFor(VISIT).at(-1)?.status).toBe("sent"));
    sentInTwo.push(...server.texts);
    expect(sentInTwo).toEqual(["從第二個分頁", "接手"]);
  });

  it("every tab hears about accepted messages", async () => {
    const heard: string[] = [];
    tab();
    tab({ onSent: (_visit, r) => heard.push(r.message.content) });
    await until(() => expect(open[0].state.get().leader).toBe(true));
    await open[1].enqueue({ visit_id: VISIT, content: "聽得到" });
    await until(() => expect(heard).toEqual(["聽得到"]));
  });

  it("keeps accounts apart", async () => {
    const mine = tab();
    mine.page.emit("offline");
    await mine.outbox.enqueue({ visit_id: VISIT, content: "我的" });
    mine.outbox.stop();
    const other = tab({ accountId: "b" });
    await tick(20);
    expect(other.outbox.state.get()).toMatchObject({ ready: true, items: [] });
    expect(server.calls).toBe(0);
  });
});
