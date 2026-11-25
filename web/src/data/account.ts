// Notifications, preferences and the account stream.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent } from "react";

import { meApi } from "../api/endpoints.ts";
import type { AccountEvent, Me, Notification } from "../api/types.ts";
import type { Connection } from "./core/stream.ts";
import type { Preferences } from "./core/preferences.ts";
import { useMe } from "./auth.ts";
import { qk } from "./keys.ts";
import { useData, useStore } from "./provider.tsx";
import { editLists, invalidate, usePaged } from "./util.ts";

export function useNotifications(o: { unread?: boolean; limit?: number } = {}) {
  const { unread, limit } = o;
  const params = { ...(unread ? { unread: true } : {}), ...(limit ? { limit } : {}) };
  return usePaged<Notification>([...qk.notifications, params], (cursor, signal) =>
    meApi.notifications({ ...params, cursor }, signal),
  );
}

/** For the badge; kept current by the account stream. */
export function useUnreadCount(): number {
  return useMe()?.unread_notifications ?? 0;
}

/** Mark some (ids) or all as read. The badge and the lists change at once. */
export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) => meApi.readNotifications(ids),
    onMutate: async (ids) => {
      const now = new Date().toISOString();
      const hit = (n: Notification) => n.read_at === null && (!ids || ids.includes(n.id));
      const me = qc.getQueryData<Me>(qk.me);
      const changed = new Set<string>();
      const lists = await editLists<Notification>(qc, qk.notifications, (items) =>
        items.map((n) => {
          if (!hit(n)) return n;
          changed.add(n.id);
          return { ...n, read_at: now };
        }),
      );
      const n = ids ? ids.filter((id) => changed.has(id)).length : Number.POSITIVE_INFINITY;
      qc.setQueryData<Me>(qk.me, (m) => (m ? { ...m, unread_notifications: Math.max(0, m.unread_notifications - n) } : m));
      return { lists, me };
    },
    onError: (_e, _ids, ctx) => {
      for (const [key, data] of ctx?.lists ?? []) qc.setQueryData(key, data);
      if (ctx?.me) qc.setQueryData(qk.me, ctx.me);
    },
    onSettled: () => invalidate(qc, qk.notifications, qk.me),
  });
}

export interface AccountStreamHandlers {
  /** Called in the visible tab only, so one notification makes one toast. */
  onNotification?: (n: Notification) => void;
  onEvent?: (e: AccountEvent) => void;
}
/** GET /me/stream (shared by all tabs). Query invalidation already happens; add handlers for toasts. */
export function useAccountStream(handlers: AccountStreamHandlers = {}): { connection: Connection; leader: boolean } {
  const { onAccountEvent, stream, env } = useData();
  const handle = useEffectEvent((e: AccountEvent) => {
    handlers.onEvent?.(e);
    if (e.type === "notification" && !env.page.hidden()) handlers.onNotification?.(e.data);
  });
  useEffect(() => onAccountEvent((e) => handle(e)), [onAccountEvent]);
  return useStore(stream?.state ?? CLOSED);
}
const CLOSED_STATE = { connection: "closed" as Connection, leader: false };
const CLOSED = { get: () => CLOSED_STATE, subscribe: () => () => undefined };

/** Theme, text size, density and sidebar: applied at once, synced to the account when signed in. */
export function usePreferences(): { prefs: Preferences; setPrefs: (part: Partial<Omit<Preferences, "filters">>) => void } {
  const { preferences } = useData();
  const prefs = useStore(preferences.state);
  const setPrefs = useCallback((part: Partial<Omit<Preferences, "filters">>) => preferences.set(part), [preferences]);
  return { prefs, setPrefs };
}

/**
 * Filter values of one list, remembered for the account. Unknown keys from an older version are dropped:
 * only keys of `initial` are read.
 */
export function useSavedFilter<F extends Record<string, string | boolean | null>>(
  list: string,
  initial: F,
): [F, (part: Partial<F>) => void, () => void] {
  const { preferences } = useData();
  const stored = useStore(preferences.state).filters[list] ?? {};
  const value = { ...initial };
  for (const k of Object.keys(initial) as (keyof F & string)[]) {
    const v = stored[k];
    if (v === null || typeof v === "string" || typeof v === "boolean") value[k] = v as F[typeof k];
  }
  return [value, (part) => preferences.setFilter(list, { ...value, ...part }), () => preferences.setFilter(list, null)];
}
