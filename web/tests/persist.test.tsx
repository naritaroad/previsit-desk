// What stays in the browser: one account's cache, for a day, gone on logout and role change; preferences at once
// and synced; and the whole provider with real hooks against the mock server.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors.ts";
import type { Me, Notification, Visit } from "../src/api/types.ts";
import { PreferencesController, parsePreferences } from "../src/data/core/preferences.ts";
import {
  DataProvider,
  leaveGuard,
  useAccountStream,
  useAuth,
  useChangePassword,
  useDraft,
  useLeaveGuard,
  useLogin,
  useMarkRead,
  useMedications,
  useMeta,
  useNoteEditor,
  useNotifications,
  useOutbox,
  usePreferences,
  useSavedFilter,
  useUnreadCount,
  useUpdateVisit,
  useVisits,
  useVisitStream,
} from "../src/data/index.ts";
import { keysForEvent, qk } from "../src/data/keys.ts";
import { AccountCache, createQueryClient } from "../src/data/persist.ts";
import { KEYS } from "../src/lib/storage.ts";
import { fid } from "../src/mocks/db.ts";
import { type Browser, browser, type Mock, mock, tick, until } from "./helpers.ts";

const me = (id: string, role: Me["role"] = "patient"): Me => ({
  id,
  username: id,
  display_name: id,
  role,
  title: null,
  avatar: null,
  is_guest: false,
  is_demo: true,
  locale: "zh-TW",
  preferences: {},
  permissions: [],
  unread_notifications: 0,
  must_change_password: false,
  expires_at: null,
});

let b: Browser;
beforeEach(() => {
  b = browser();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("query cache per account", () => {
  const make = (o: { buster?: string; maxAge?: number } = {}) => {
    const qc = createQueryClient();
    return { qc, cache: new AccountCache({ queryClient: qc, kv: b.kv, ...o }) };
  };
  const cached = (id: string) => b.kv.get<{ clientState: { queries: { queryKey: unknown[] }[] } }>(`pv:cache:${id}`);

  it("is restored for the same account and holds no admin, public or opted-out data", async () => {
    const one = make();
    await one.cache.activate(me("a"));
    one.qc.setQueryData(qk.home, { unread: 3 });
    one.qc.setQueryData(qk.settings, { secret: true });
    one.qc.setQueryData(qk.meta, { app: "x" });
    await one.qc.fetchQuery({ queryKey: qk.accessLog, queryFn: () => ["x"], meta: { persist: false } });
    await one.cache.flush();
    expect((await cached("a"))?.clientState.queries.map((q) => q.queryKey)).toEqual([["me"], ["home"]]);

    const two = make(); // reload
    await two.cache.activate(me("a"));
    expect(two.qc.getQueryData(qk.home)).toEqual({ unread: 3 });
  });

  it("another account never sees it, and it is removed from the browser", async () => {
    const one = make();
    await one.cache.activate(me("a"));
    one.qc.setQueryData(qk.home, { unread: 3 });
    await one.cache.flush();
    await b.kv.set("pv:draft:a:x", { value: "草稿" });
    await one.cache.activate(me("b"));
    expect(one.qc.getQueryData(qk.home)).toBeUndefined();
    expect(one.qc.getQueryData<Me>(qk.me)?.id).toBe("b");
    expect((await b.kv.keys("pv:")).filter((k) => k.includes(":a"))).toEqual([]);
  });

  it("a role change drops the cache, in this tab and after a reload", async () => {
    const one = make();
    await one.cache.activate(me("a", "physician"));
    one.qc.setQueryData(qk.clinicOverview, { counts: {} });
    await one.cache.flush();
    const reloaded = make();
    await reloaded.cache.activate(me("a", "coordinator"));
    expect(reloaded.qc.getQueryData(qk.clinicOverview)).toBeUndefined();
    await one.cache.activate(me("a", "admin"));
    expect(one.qc.getQueryData(qk.clinicOverview)).toBeUndefined();
  });

  it("logout removes everything of the account; an expired session keeps unsent work", async () => {
    const { qc, cache } = make();
    const work = { "pv:draft:a:n": 1, "pv:outbox:a": [1], "pv:rx:a:r": 1 };
    const fill = async () => {
      await cache.activate(me("a"));
      qc.setQueryData(qk.home, { unread: 1 });
      for (const [k, v] of Object.entries(work)) await b.kv.set(k, v);
      await cache.flush();
    };
    await fill();
    await cache.deactivate("expired");
    expect(qc.getQueryData(qk.home)).toBeUndefined();
    expect((await b.kv.keys("pv:")).sort()).toEqual(Object.keys(work).sort());
    await fill();
    await cache.deactivate("logout");
    expect(await b.kv.keys("pv:")).toEqual([]);
    expect(localStorage.getItem(KEYS.lastAccount)).toBeNull();
  });

  it("is thrown away after 24 hours and by a new build", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const one = make({ buster: "build-1" });
    await one.cache.activate(me("a"));
    one.qc.setQueryData(qk.home, { unread: 3 });
    await one.cache.flush();
    const next = make({ buster: "build-2" });
    await next.cache.activate(me("a"));
    expect(next.qc.getQueryData(qk.home)).toBeUndefined();

    const again = make({ buster: "build-1" });
    await again.cache.activate(me("a"));
    again.qc.setQueryData(qk.home, { unread: 3 });
    await again.cache.flush();
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    const late = make({ buster: "build-1" });
    await late.cache.activate(me("a"));
    expect(late.qc.getQueryData(qk.home)).toBeUndefined();
  });

  it("offline start: the last account's data, only that account's, and nothing after logout", async () => {
    const one = make();
    await one.cache.activate(me("a"));
    one.qc.setQueryData(qk.home, { unread: 3 });
    await one.cache.flush();
    const offline = make();
    expect((await offline.cache.restoreOffline())?.id).toBe("a");
    expect(offline.qc.getQueryData(qk.home)).toEqual({ unread: 3 });
    await offline.cache.deactivate("logout");
    expect(await make().cache.restoreOffline()).toBeNull();
  });

  it("public queries that are loading survive a signed-out start", async () => {
    const { qc, cache } = make();
    const meta = qc.fetchQuery({ queryKey: qk.meta, queryFn: () => tick(30).then(() => ({ app: "x" })) });
    await cache.deactivate("expired");
    expect(await meta).toEqual({ app: "x" });
    expect(qc.getQueryState(qk.meta)).toMatchObject({ status: "success", fetchStatus: "idle" });
  });

  it("an answer that arrives after logout does not come back", async () => {
    const { qc, cache } = make();
    await cache.activate(me("a"));
    const slow = qc.fetchQuery({ queryKey: qk.home, queryFn: () => tick(30).then(() => ({ unread: 9 })) }).catch(() => undefined);
    await cache.deactivate("logout");
    await slow;
    await tick(40);
    expect(qc.getQueryData(qk.home)).toBeUndefined();
    expect(await b.kv.keys("pv:")).toEqual([]);
  });
});

describe("preferences", () => {
  it("apply at once, sync in one request, and come back on another device", async () => {
    vi.useFakeTimers();
    const env = b.tab();
    const saved: Record<string, unknown>[] = [];
    const applied: string[] = [];
    const p = new PreferencesController({ env, save: async (patch) => saved.push(patch), apply: (x) => applied.push(x.theme) });
    p.start();
    p.attach("a", { theme: "light", text: "112" });
    expect(p.state.get()).toMatchObject({ theme: "light", text: "112" });
    p.set({ theme: "dark" });
    p.set({ density: "compact" });
    p.setFilter("worklist", { bucket: "mine" });
    expect(applied.at(-1)).toBe("dark");
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    expect(saved).toEqual([{ theme: "dark", density: "compact", filters: { worklist: { bucket: "mine" } } }]);
    p.detach();
    expect(p.state.get()).toMatchObject({ theme: "dark", filters: {} });
    p.stop();
  });

  it("offline changes are kept and sent when the network is back", async () => {
    vi.useFakeTimers();
    const env = b.tab();
    let down = true;
    const saved: Record<string, unknown>[] = [];
    const p = new PreferencesController({
      env,
      apply: () => undefined,
      save: async (patch) => {
        if (down) throw new ApiError({ status: 0, code: "offline" });
        saved.push(patch);
      },
    });
    p.start();
    p.attach("a", {});
    p.set({ theme: "dark" });
    await vi.advanceTimersByTimeAsync(600);
    p.set({ sidebar: "collapsed" });
    down = false;
    env.page.emit("online");
    await vi.advanceTimersByTimeAsync(10);
    expect(saved).toEqual([{ theme: "dark", sidebar: "collapsed" }]);
    p.stop();
  });

  it("ignores unknown values", () => {
    expect(parsePreferences({ theme: "neon", text: 999, filters: [1] })).toEqual({ theme: "system", text: "100", density: "comfortable", sidebar: "expanded", filters: {} });
  });
});

describe("invalidation", () => {
  it("maps account events to query keys", () => {
    const hit = (e: Parameters<typeof keysForEvent>[0], key: readonly unknown[]) => keysForEvent(e).some((k) => k.every((x, i) => Object.is(x, key[i])));
    expect(hit({ type: "rx.changed", data: { id: "1" } }, qk.rxDetail("1"))).toBe(true);
    expect(hit({ type: "rx.changed", data: { id: "1" } }, qk.rxDetail("2"))).toBe(false);
    expect(hit({ type: "rx.changed", data: { id: "1" } }, qk.rxQueue("mine"))).toBe(true);
    expect(hit({ type: "visit.changed", data: { id: "1" } }, qk.visitList({}))).toBe(true);
    expect(hit({ type: "queue.changed", data: { name: "all" } }, qk.profile)).toBe(true);
    expect(hit({ type: "queue.changed", data: { name: "rx" } }, qk.profile)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ with React

describe("hooks in the provider", () => {
  let m: Mock;
  let qc: QueryClient;
  beforeEach(() => {
    m = mock();
    qc = createQueryClient();
  });
  afterEach(() => {
    cleanup();
    m.stop();
    qc.clear();
  });
  const wrapper = (env = b.tab()) =>
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <DataProvider env={env} queryClient={qc}>
          {children}
        </DataProvider>
      );
    };
  const hook = <T,>(use: () => T, env?: ReturnType<Browser["tab"]>) => renderHook(use, { wrapper: wrapper(env) });

  it("visitor → login → logout", async () => {
    const { result } = hook(() => ({ auth: useAuth(), login: useLogin() }));
    expect(result.current.auth.status).toBe("loading");
    await waitFor(() => expect(result.current.auth.status).toBe("anonymous"));
    await act(async () => {
      await expect(result.current.login.mutateAsync({ username: "dr_demo", password: "bad" })).rejects.toMatchObject({ code: "invalid_credentials" });
    });
    expect(result.current.auth).toMatchObject({ status: "anonymous", expired: false });
    await act(() => result.current.login.mutateAsync({ username: "dr_demo", password: "good-enough" }));
    expect(result.current.auth).toMatchObject({ status: "authenticated", home: "/clinic" });
    expect(result.current.auth.can("rx.decide")).toBe(true);
    expect(result.current.auth.can("rx.decide", "rx.dispense")).toBe(false);
    await act(() => result.current.auth.logout());
    expect(result.current.auth).toMatchObject({ status: "anonymous", me: null, expired: false });
    expect(await b.kv.keys("pv:cache")).toEqual([]);
  });

  it("a visitor's first page gets its public data", async () => {
    m.server.config.latency = 20;
    const { result } = hook(() => ({ auth: useAuth(), meta: useMeta() }));
    await waitFor(() => expect(result.current.auth.status).toBe("anonymous"));
    await waitFor(() => expect(result.current.meta.data?.app).toBe("PreVisit Desk"));
  });

  it("a one-time password: no streams until it is changed, then everything opens", async () => {
    m.server.db.accounts.find((a) => a.username === "dr_demo")!.must_change_password = true;
    m.server.loginAs("dr_demo");
    const { result } = hook(() => ({ auth: useAuth(), change: useChangePassword(), stream: useAccountStream() }));
    await waitFor(() => expect(result.current.auth).toMatchObject({ status: "authenticated", mustChangePassword: true }));
    expect(m.server.openStreams).toBe(0);
    await act(() => result.current.change.mutateAsync({ current: "one-time-password", next: "my-own-password" }));
    await waitFor(() => expect(result.current.auth.mustChangePassword).toBe(false));
    await waitFor(() => expect(result.current.stream.connection).toBe("open"));
  });

  it("a session that ends while working shows expired and clears the data", async () => {
    m.server.loginAs("patient_demo");
    const { result } = hook(() => ({ auth: useAuth(), meds: useMedications() }));
    await waitFor(() => expect(result.current.meds.data?.length).toBeGreaterThan(3));
    m.server.signOut();
    await act(() => result.current.meds.refetch());
    await waitFor(() => expect(result.current.auth).toMatchObject({ status: "anonymous", expired: true }));
    expect(qc.getQueryData(qk.medications)).toBeUndefined();
  });

  it("start without network: cached data of the last account, then live again", async () => {
    m.server.loginAs("patient_demo");
    const first = hook(() => ({ auth: useAuth(), meds: useMedications() }));
    await waitFor(() => expect(first.result.current.meds.data).toBeDefined());
    await until(() => expect((b.kv as unknown as { map: Map<string, unknown> }).map.has(`pv:cache:${fid("account:lin")}`)).toBe(true));
    await tick(1100);
    first.unmount();
    qc = createQueryClient();
    m.server.config.offline = true;
    const env = b.tab();
    const second = hook(() => ({ auth: useAuth(), meds: useMedications() }), env);
    await waitFor(() => expect(second.result.current.auth.status).toBe("offline"));
    expect(second.result.current.auth.me?.display_name).toBe("林秀琴");
    expect(second.result.current.meds.data?.length).toBeGreaterThan(3);
    m.server.config.offline = false;
    act(() => env.page.emit("online"));
    await waitFor(() => expect(second.result.current.auth.status).toBe("authenticated"));
  });

  it("chat: queued message → sent → confirmed by the stream; nothing is left in the outbox", async () => {
    m.server.loginAs("patient_demo");
    const id = fid("visit:lin-glucose");
    const { result } = hook(() => ({ visit: useVisitStream(id), outbox: useOutbox(id) }));
    await waitFor(() => expect(result.current.visit.connection).toBe("open"));
    const before = result.current.visit.messages.length;
    await act(async () => {
      await result.current.outbox.send("  沒有增減  ");
      await result.current.outbox.send("第二則");
    });
    await waitFor(() => expect(result.current.visit.messages).toHaveLength(before + 4), { timeout: 6000 });
    expect(result.current.visit.messages.filter((x) => x.role === "patient").slice(-2).map((x) => x.content)).toEqual(["沒有增減", "第二則"]);
    await waitFor(() => expect(result.current.outbox.items).toEqual([]));
    expect(result.current.visit.run.phase).toBe("idle");
  });

  it("chat offline: the message waits, survives a reload and goes out once", async () => {
    m.server.loginAs("patient_demo");
    const id = fid("visit:lin-glucose");
    const env = b.tab();
    const first = hook(() => ({ visit: useVisitStream(id), outbox: useOutbox(id) }), env);
    await waitFor(() => expect(first.result.current.visit.connection).toBe("open"));
    m.server.config.offline = true;
    act(() => env.page.emit("offline"));
    await act(async () => void (await first.result.current.outbox.send("離線寫的")));
    expect(first.result.current.outbox.items).toMatchObject([{ content: "離線寫的", status: "queued" }]);
    expect(first.result.current.outbox.hasUnsent).toBe(true);
    first.unmount();
    m.server.config.offline = false;
    qc = createQueryClient();
    const second = hook(() => ({ visit: useVisitStream(id), outbox: useOutbox(id) }));
    await waitFor(() => expect(second.result.current.visit.messages.filter((x) => x.content === "離線寫的")).toHaveLength(1), { timeout: 5000 });
    expect(m.server.db.visits.find((v) => v.id === id)!.messages.filter((x) => x.content === "離線寫的")).toHaveLength(1);
  });

  it("pin is shown at once and undone when the server refuses", async () => {
    m.server.loginAs("patient_demo");
    const seen: (boolean | undefined)[] = [];
    let watch = "";
    const { result } = hook(() => {
      const list = useVisits();
      seen.push(list.items.find((v: Visit) => v.id === watch)?.pinned);
      return { list, update: useUpdateVisit() };
    });
    await waitFor(() => expect(result.current.list.items.length).toBeGreaterThan(1));
    const target = result.current.list.items.find((v: Visit) => !v.pinned)!;
    m.server.config.fail = { status: 500, left: 1 };
    m.server.config.latency = 40;
    watch = target.id;
    act(() => result.current.update.mutate({ id: target.id, pinned: true }));
    await waitFor(() => expect(result.current.update.isError).toBe(true));
    expect(seen).toContain(true);
    await waitFor(() => expect(result.current.list.items.find((v: Visit) => v.id === target.id)?.pinned).toBe(false));
  });

  it("notifications: arrive live, once, and can be read", async () => {
    m.server.loginAs("patient_demo");
    const got: Notification[] = [];
    const { result } = hook(() => ({ list: useNotifications(), unread: useUnreadCount(), read: useMarkRead(), stream: useAccountStream({ onNotification: (n) => got.push(n) }) }));
    await waitFor(() => expect(result.current.stream.connection).toBe("open"));
    await waitFor(() => expect(result.current.list.items.length).toBeGreaterThan(2));
    const unread = result.current.unread;
    const { notify } = await import("../src/mocks/views.ts");
    act(() => notify(m.server, m.server.db, fid("account:lin"), "rx.status", ["新進度", "Update", "內容", "Body"], "/app/rx/1"));
    await waitFor(() => expect(result.current.list.items[0].title).toBe("新進度"));
    expect(got.map((n) => n.title)).toEqual(["新進度"]);
    await waitFor(() => expect(result.current.unread).toBe(unread + 1));
    await act(() => result.current.read.mutateAsync(undefined));
    await waitFor(() => expect(result.current.unread).toBe(0));
    expect(result.current.list.items.every((n) => n.read_at !== null)).toBe(true);
  });

  it("note editor: autosaved text survives, saves, signs; another version is offered", async () => {
    m.server.loginAs("dr_demo");
    const id = fid("visit:chang-night");
    const first = hook(() => useNoteEditor(id));
    await waitFor(() => expect(first.result.current.sections?.subjective).toContain("氣喘"));
    expect(first.result.current.edited).toBe(false);
    act(() => first.result.current.set("assessment", "氣喘控制不佳"));
    await waitFor(() => expect(first.result.current.autosave.status).toBe("saved"));
    first.unmount();

    qc = createQueryClient();
    const { result } = hook(() => useNoteEditor(id));
    await waitFor(() => expect(result.current.sections?.assessment).toBe("氣喘控制不佳"));
    act(() => result.current.set("plan", "調整吸入技巧，兩週後回診"));
    await act(async () => void (await result.current.save()));
    expect(result.current).toMatchObject({ edited: false, note: { revision: 1, status: "draft" } });

    act(() => result.current.set("patient_message", "每天早晚各吸一次，吸完漱口。"));
    const other = m.server.db.visits.find((v) => v.id === id)!.note!;
    other.revision += 1;
    other.sections = { ...other.sections, plan: "個管師改過" };
    await act(async () => void (await expect(result.current.save()).rejects.toMatchObject({ code: "conflict" })));
    await waitFor(() => expect(result.current.conflict?.theirs.sections.plan).toBe("個管師改過"));
    act(() => result.current.resolve({ merged: { ...result.current.conflict!.theirs.sections, patient_message: "每天早晚各吸一次，吸完漱口。" } }));
    await waitFor(() => expect(result.current.conflict).toBeNull());
    await act(async () => void (await result.current.sign()));
    await waitFor(() => expect(result.current.note).toMatchObject({ status: "signed", sections: { plan: "個管師改過" } }));
    expect(result.current.edited).toBe(false);
  });

  it("a draft hook changes with its scope", async () => {
    m.server.loginAs("patient_demo");
    const env = b.tab();
    const W = wrapper(env);
    const { result, rerender } = renderHook(({ scope }) => useDraft(scope, ""), { wrapper: W, initialProps: { scope: "visit:1:composer" } });
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.set("第一個"));
    rerender({ scope: "visit:2:composer" });
    await waitFor(() => expect(result.current).toMatchObject({ ready: true, value: "" }));
    rerender({ scope: "visit:1:composer" });
    await waitFor(() => expect(result.current.value).toBe("第一個"));
  });

  it("preferences and saved filters go through the account", async () => {
    m.server.loginAs("dr_demo");
    const { result } = hook(() => ({ p: usePreferences(), f: useSavedFilter("worklist", { bucket: "pending", q: "" }), auth: useAuth() }));
    await waitFor(() => expect(result.current.auth.isSignedIn).toBe(true));
    act(() => {
      result.current.p.setPrefs({ theme: "dark" });
      result.current.f[1]({ bucket: "mine" });
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(result.current.f[0]).toEqual({ bucket: "mine", q: "" });
    await waitFor(() => expect(m.server.db.accounts.find((a) => a.username === "dr_demo")!.preferences).toMatchObject({ theme: "dark", filters: { worklist: { bucket: "mine" } } }), { timeout: 2000 });
    act(() => result.current.f[2]());
    expect(result.current.f[0].bucket).toBe("pending");
  });

  it("leave guard: beforeunload only while something is unsaved", () => {
    function Page({ dirty }: { dirty: boolean }) {
      useLeaveGuard("form", dirty);
      return <p>page</p>;
    }
    const blocked = () => !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    const { rerender, unmount } = render(<Page dirty={false} />);
    expect(screen.getByText("page")).toBeTruthy();
    expect(blocked()).toBe(false);
    rerender(<Page dirty />);
    expect(blocked()).toBe(true);
    expect(leaveGuard.active).toBe(true);
    unmount();
    expect(blocked()).toBe(false);
    expect(leaveGuard.active).toBe(false);
  });

  it("hooks outside the provider fail loudly", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lone = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    expect(() => renderHook(() => useAuth(), { wrapper: lone })).toThrow("DataProvider");
  });
});
