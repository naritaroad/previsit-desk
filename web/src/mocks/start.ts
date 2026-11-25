// Entry of the mock server (`@mocks` in `--mode mock`). No service worker: the page's fetch is wrapped and the
// API's requests are answered by MSW handlers in the page itself, so streams, aborts and reloads behave and
// nothing is added to public/.

import { http, type RequestHandler } from "msw";
import { getResponse } from "msw/utils/get-response";

import { type MockConfig, parseMock } from "./config.ts";
import { MockServer, type MockServerOptions } from "./core.ts";
import { MemoryStorage } from "./db.ts";
import { accountRoutes } from "./routes/account.ts";
import { adminRoutes } from "./routes/admin.ts";
import { clinicRoutes } from "./routes/clinic.ts";
import { patientRoutes } from "./routes/patient.ts";
import { rxRoutes } from "./routes/rx.ts";
import { TurnRunner } from "./turns.ts";
import { notify } from "./views.ts";

export const ROUTES = [...accountRoutes, ...patientRoutes, ...rxRoutes, ...clinicRoutes, ...adminRoutes];

export function createMockServer(o: Partial<Omit<MockServerOptions, "routes">> = {}): MockServer {
  return new MockServer({ storage: new MemoryStorage(), ...o, routes: ROUTES });
}

/** One MSW handler per endpoint, all answered by the mock server. */
export function mockHandlers(server: MockServer): RequestHandler[] {
  const on = { GET: http.get, POST: http.post, PUT: http.put, PATCH: http.patch, DELETE: http.delete } as const;
  const handlers = server.routes.map((r) =>
    on[r.method as keyof typeof on](`*/api/v2${r.path}`, async ({ request }) => (await server.handle(request)) ?? undefined),
  );
  handlers.push(http.all("*/api/*", async ({ request }) => (await server.handle(request)) ?? undefined));
  return handlers;
}

/** Route this realm's fetch for /api/* through the handlers. Returns the undo. */
export function installFetch(server: MockServer): () => void {
  const real = globalThis.fetch;
  const handlers = mockHandlers(server);
  const base = typeof location === "undefined" || location.origin === "null" ? "http://localhost" : location.origin;
  const wrapped: typeof fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, base);
    if (!url.pathname.startsWith("/api/")) return real(input, init);
    const request = new Request(url, input instanceof Request ? input : init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const answer = getResponse(handlers, request).then((r) => r ?? new Response(null, { status: 404 }));
    if (!signal) return answer;
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    return Promise.race([
      answer,
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })),
    ]);
  };
  globalThis.fetch = wrapped;
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = real;
  };
}

export interface MockControl {
  readonly config: Readonly<MockConfig>;
  /** "offline", "409", "429*2", "latency:2000", "as:dr_demo", "reset", … (same words as ?mock=). */
  set: (text: string) => void;
  loginAs: (username: string) => void;
  reset: () => void;
  /** Cut every open stream once. */
  drop: () => void;
  /** Stop running turns as if the server restarted. */
  interrupt: (visitId?: string) => void;
  /** Send a notification to the signed-in account. */
  notify: (title?: string, body?: string) => void;
  /** Someone else changes a draft, rx request, note, profile or the settings: the next save is a 409. */
  editElsewhere: (what: "drafts" | "rx" | "notes" | "profile" | "settings") => void;
  readonly server: MockServer;
  help: () => void;
}
declare global {
  interface Window {
    __mock?: MockControl;
  }
}

const CONFIG_KEY = "pv-mock:config";

function applyOffline(server: MockServer, offline: boolean): void {
  const was = server.config.offline;
  server.config.offline = offline;
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => !server.config.offline });
  if (offline) server.closeStreams();
  if (was !== offline) window.dispatchEvent(new Event(offline ? "offline" : "online"));
}

export async function startMocks(): Promise<void> {
  const server = createMockServer({ storage: localStorage, shared: true });
  const runner = new TurnRunner(server);
  installFetch(server);

  const remember = () => sessionStorage.setItem(CONFIG_KEY, JSON.stringify({ ...server.config, fail: server.config.fail && { ...server.config.fail, left: Number.isFinite(server.config.fail.left) ? server.config.fail.left : -1 } }));
  const apply = (text: string) => {
    const { config, as, reset } = parseMock(text);
    const { offline, ...rest } = config;
    Object.assign(server.config, rest);
    if (reset) {
      server.file.reset();
      server.signOut();
    }
    if (as && !server.loginAs(as)) console.warn(`[mock] no account called ${as}`);
    if (offline !== undefined) applyOffline(server, offline);
    remember();
  };
  try {
    const saved = JSON.parse(sessionStorage.getItem(CONFIG_KEY) ?? "null") as MockConfig | null;
    if (saved) {
      const { offline, ...rest } = saved;
      Object.assign(server.config, rest);
      if (server.config.fail?.left === -1) server.config.fail.left = Number.POSITIVE_INFINITY;
      if (offline) applyOffline(server, true);
    }
  } catch {
    /* start with the defaults */
  }
  const fromUrl = new URLSearchParams(location.search).get("mock");
  if (fromUrl !== null) {
    apply(fromUrl);
    // "as" and "reset" must not run again on reload.
    const url = new URL(location.href);
    url.searchParams.delete("mock");
    history.replaceState(history.state, "", url);
  }

  window.__mock = {
    get config() {
      return server.config;
    },
    server,
    set: apply,
    loginAs: (username) => {
      apply(`as:${username}`);
      location.assign("/");
    },
    reset: () => {
      apply("reset");
      location.assign("/");
    },
    drop: () => server.closeStreams(),
    interrupt: (visitId) => runner.interrupt(visitId),
    notify: (title = "測試通知", body = "這是一則測試通知。") => {
      const s = server.db.sessions.find((x) => x.token === server.currentToken());
      if (!s) return;
      notify(server, server.db, s.account_id, "rx.status", [title, title, body, body], null);
      server.file.save();
    },
    editElsewhere: (what) => {
      const { db } = server;
      if (what === "drafts") for (const d of Object.values(db.drafts)) d.revision += 1;
      if (what === "rx") for (const r of db.rx) if (r.status === "draft" || r.status === "more_info") r.revision += 1;
      if (what === "notes") for (const v of db.visits) if (v.note?.status === "draft") v.note.revision += 1;
      if (what === "profile") for (const p of Object.values(db.profiles)) p.revision += 1;
      if (what === "settings") db.settings.revision += 1;
      server.file.save();
    },
    help: () =>
      console.info(
        "__mock.set('offline' | 'online' | '409' | '409*2' | '429' | '500' | 'ok' | 'latency:1500' | 'fast' | 'slow' | 'drop' | 'empty' | 'full' | 'reset' | 'as:dr_demo')\n__mock.loginAs(username) reset() drop() interrupt() notify() editElsewhere('rx')\nMessages: /fail /interrupt /slow /summary /budget",
      ),
  };
  console.info("[mock] API mocked in this page. Accounts: patient_demo, dr_demo, cm_demo, rph_demo, naritaroad (any password of 8+ characters). __mock.help()");
}
