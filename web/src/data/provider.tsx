// DataProvider: query client, who is signed in, the per-account cache, the account stream, the outbox and the
// preferences. Put it above the router. Everything below reads it through the hooks of this folder.

import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, type ReactNode, use, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { onUnauthorized, setApiLanguage } from "../api/client.ts";
import { authApi } from "../api/endpoints.ts";
import { ApiError, isApiError } from "../api/errors.ts";
import type { AccountEvent, Me, SendMessageResult } from "../api/types.ts";
import { AccountStream } from "./core/accountStream.ts";
import { browserEnv, type Env } from "./core/env.ts";
import { Outbox } from "./core/outbox.ts";
import { PreferencesController } from "./core/preferences.ts";
import { keysForEvent, qk } from "./keys.ts";
import { AccountCache, createQueryClient } from "./persist.ts";

export type AuthStatus =
  /** First answer of the server is not here yet. */
  | "loading"
  | "anonymous"
  | "authenticated"
  /** No network: the last account's cached data, read only until the server answers. */
  | "offline"
  /** Neither the server nor a cached account could be read; offer "try again". */
  | "unreachable";

export interface AuthState {
  status: AuthStatus;
  me: Me | null;
  /** The session ended while working (401): show "please sign in again" and come back here. */
  expired: boolean;
  error: ApiError | null;
}

type EventListener = (e: AccountEvent) => void;
type SentListener = (visitId: string, result: SendMessageResult) => void;

export interface DataContextValue {
  env: Env;
  queryClient: QueryClient;
  cache: AccountCache;
  auth: AuthState;
  /** The server answered with this account (login, guest, register, claim, PATCH /me). */
  signIn: (me: Me) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  preferences: PreferencesController;
  outbox: Outbox | null;
  stream: AccountStream | null;
  onAccountEvent: (l: EventListener) => () => void;
  onSent: (l: SentListener) => () => void;
  /** Visits with a running turn; the outbox waits for them. */
  busyVisits: Set<string>;
}

const DataContext = createContext<DataContextValue | null>(null);
export function useData(): DataContextValue {
  const v = use(DataContext);
  if (!v) throw new Error("DataProvider is missing");
  return v;
}

type AuthWire = { type: "in"; id: string; role: string } | { type: "out" };

export interface DataProviderProps {
  children: ReactNode;
  /** Tests. */
  env?: Env;
  queryClient?: QueryClient;
}

export function DataProvider({ children, env: givenEnv, queryClient: givenClient }: DataProviderProps) {
  const [env] = useState(() => givenEnv ?? browserEnv());
  const [queryClient] = useState(() => givenClient ?? createQueryClient());
  const [cache] = useState(() => new AccountCache({ queryClient, kv: env.kv }));
  const [preferences] = useState(() => new PreferencesController({ env }));
  const [auth, setAuth] = useState<AuthState>({ status: "loading", me: null, expired: false, error: null });
  const [eventListeners] = useState(() => new Set<EventListener>());
  const [sentListeners] = useState(() => new Set<SentListener>());
  const [busyVisits] = useState(() => new Set<string>());
  const generation = useRef(0);
  const channel = useRef<{ post: (m: AuthWire) => void } | null>(null);

  const enter = useCallback(
    async (me: Me, broadcast: boolean) => {
      const gen = ++generation.current;
      await cache.activate(me);
      if (gen !== generation.current) return;
      preferences.attach(me.id, me.preferences);
      setApiLanguage(me.locale);
      setAuth({ status: "authenticated", me, expired: false, error: null });
      if (broadcast) channel.current?.post({ type: "in", id: me.id, role: me.role });
    },
    [cache, preferences],
  );

  const leave = useCallback(
    async (reason: "logout" | "expired", broadcast: boolean) => {
      const gen = ++generation.current;
      preferences.detach();
      // Leave the signed-in screens before the data goes, so nothing refetches into an empty session.
      setAuth({ status: "anonymous", me: null, expired: reason === "expired", error: null });
      await cache.deactivate(reason);
      if (gen === generation.current && broadcast) channel.current?.post({ type: "out" });
    },
    [cache, preferences],
  );

  const refresh = useCallback(async () => {
    const gen = generation.current;
    try {
      const me = await authApi.me();
      if (gen === generation.current) await enter(me, false);
    } catch (e) {
      if (gen !== generation.current) return;
      if (isApiError(e, "unauthorized")) {
        if (cache.accountId) await leave("expired", true);
        else {
          generation.current += 1;
          await cache.deactivate("expired");
          setAuth({ status: "anonymous", me: null, expired: false, error: null });
        }
        return;
      }
      const error = e instanceof ApiError ? e : new ApiError({ status: 0, code: "internal", message: String(e) });
      if (cache.accountId) return; // keep working on what we have
      const me = error.transient ? await cache.restoreOffline() : null;
      if (gen !== generation.current) return;
      if (me) {
        preferences.attach(me.id, me.preferences);
        setAuth({ status: "offline", me, expired: false, error });
      } else setAuth({ status: "unreachable", me: null, expired: false, error });
    }
  }, [cache, enter, leave, preferences]);

  // Who am I: once at start, when coming back online, and when another tab signs in or out.
  useEffect(() => {
    preferences.start();
    const ch = env.channel<AuthWire>("pv-auth");
    channel.current = ch;
    const offChannel = ch.onMessage((m) => {
      if (m.type === "in") void refresh();
      else void leave("expired", false).then(() => setAuth((a) => ({ ...a, expired: false })));
    });
    const offOnline = env.page.on("online", () => void refresh());
    const offHidden = env.page.on("hidden", () => void cache.flush());
    const off401 = onUnauthorized(() => {
      if (cache.accountId) void leave("expired", true);
    });
    void refresh();
    return () => {
      offChannel();
      offOnline();
      offHidden();
      off401();
      ch.close();
      channel.current = null;
      preferences.stop();
    };
  }, [cache, env, leave, preferences, refresh]);

  // With a one-time password every endpoint but the password change answers 403, so streams wait for it.
  const accountId = (auth.status === "authenticated" || auth.status === "offline") && !auth.me?.must_change_password ? (auth.me?.id ?? null) : null;

  const [services, setServices] = useState<{ id: string; outbox: Outbox; stream: AccountStream } | null>(null);
  useEffect(() => {
    if (!accountId) {
      setServices(null);
      return;
    }
    const outbox = new Outbox({
      accountId,
      env,
      isBusy: (visitId) => busyVisits.has(visitId),
      onSent: (visitId, result) => {
        for (const l of [...sentListeners]) l(visitId, result);
      },
    });
    const stream = new AccountStream({
      accountId,
      env,
      onEvent: (e) => {
        for (const queryKey of keysForEvent(e)) void queryClient.invalidateQueries({ queryKey });
        if (e.type === "notification") {
          queryClient.setQueryData<Me>(qk.me, (m) => (m ? { ...m, unread_notifications: m.unread_notifications + 1 } : m));
        }
        for (const l of [...eventListeners]) l(e);
      },
      onReconnected: () => {
        void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "public" });
        void refresh();
      },
    });
    outbox.start();
    stream.start();
    setServices({ id: accountId, outbox, stream });
    return () => {
      outbox.stop();
      stream.stop();
    };
  }, [accountId, busyVisits, env, eventListeners, queryClient, refresh, sentListeners]);

  const value = useMemo<DataContextValue>(() => {
    const current = services && services.id === accountId ? services : null;
    return {
      env,
      queryClient,
      cache,
      auth,
      signIn: (me) => enter(me, true),
      signOut: async () => {
        try {
          await authApi.logout();
        } catch (e) {
          // Without the server the session stays valid there; keep the person signed in rather than pretend.
          if (!isApiError(e, "unauthorized")) throw e;
        }
        await leave("logout", true);
      },
      refresh,
      preferences,
      outbox: current?.outbox ?? null,
      stream: current?.stream ?? null,
      onAccountEvent: (l) => {
        eventListeners.add(l);
        return () => eventListeners.delete(l);
      },
      onSent: (l) => {
        sentListeners.add(l);
        return () => sentListeners.delete(l);
      },
      busyVisits,
    };
  }, [accountId, auth, busyVisits, cache, enter, env, eventListeners, leave, preferences, queryClient, refresh, sentListeners, services]);

  return (
    <QueryClientProvider client={queryClient}>
      <DataContext value={value}>{children}</DataContext>
    </QueryClientProvider>
  );
}

/** useSyncExternalStore over a core Store. */
export function useStore<S>(store: { get: () => S; subscribe: (l: () => void) => () => void }): S {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
