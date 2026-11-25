// Connects the data layer (src/data) to what the shells use.

import { useEffect, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { useAccountStream, useMarkRead, useNotifications, usePreferences, useUnreadCount } from "@/data/account";
import { useAuth, useUpdateMe } from "@/data/auth";
import { internalLink } from "@/lib/links";
import { toast } from "@/ui";

import { SessionContext, type Session } from "./session-context";

export function SessionProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  const { status, me, expired, refresh, logout } = useAuth();
  const { prefs, setPrefs } = usePreferences();
  const updateMe = useUpdateMe();
  const unread = useUnreadCount();
  const markRead = useMarkRead();

  // The browser chrome follows the page header.
  useEffect(() => {
    const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
    if (surface) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", surface);
  }, [prefs.theme]);

  // The account's language wins once it is known.
  const locale = me?.locale;
  useEffect(() => {
    if (locale && i18n.resolvedLanguage !== locale) void i18n.changeLanguage(locale);
    // Only when the account changes, not when the person switches language here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);

  const session = useMemo<Session>(
    () => ({
      status,
      me,
      expired,
      notifications: undefined,
      unread,
      prefs: { theme: prefs.theme, text: prefs.text },
      setPrefs,
      setLocale: (l) => {
        void i18n.changeLanguage(l);
        if (me) updateMe.mutate({ locale: l });
      },
      signOut: logout,
      retry: () => void refresh(),
      markRead: (ids) => markRead.mutate(ids),
    }),
    [status, me, expired, unread, prefs.theme, prefs.text, setPrefs, i18n, updateMe, logout, refresh, markRead],
  );
  return <SessionContext value={session}>{children}</SessionContext>;
}

/** Inside the app shells: notifications for the bell and a toast when one arrives. */
export function SignedIn({ children }: { children: ReactNode }) {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const list = useNotifications({ limit: 12 });
  useAccountStream({
    onNotification: (n) => {
      const link = internalLink(n.link);
      toast.info(n.title, { id: n.id, action: link ? { label: t("action.open"), onClick: () => void navigate(link) } : undefined });
    },
  });
  return (
    <SessionContext.Consumer>
      {(s) => <SessionContext value={s && { ...s, notifications: list.items }}>{children}</SessionContext>}
    </SessionContext.Consumer>
  );
}
