// What the shells need to know about the signed-in person. Kept apart from the data layer so the gallery and tests
// can render shells with a made-up session. Pages use the hooks of src/data directly.

import { createContext, useContext } from "react";

import type { Locale, Me, Notification } from "@/api/types";

export type ThemeChoice = "system" | "light" | "dark";
export type TextSize = "100" | "112" | "125";

export interface Session {
  status: "loading" | "anonymous" | "authenticated" | "offline" | "unreachable";
  /** The session ended while working. */
  expired: boolean;
  me: Me | null;
  notifications: Notification[] | undefined;
  unread: number;
  prefs: { theme: ThemeChoice; text: TextSize };
  setPrefs: (part: { theme?: ThemeChoice; text?: TextSize }) => void;
  setLocale: (l: Locale) => void;
  signOut: () => Promise<void>;
  retry: () => void;
  markRead: (ids?: string[]) => void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
