// Clinician session: GET /auth/me when a clinician page is first opened, login and logout. Patients never
// trigger the call (it would answer 401 and put a red line in their console). The cookie is HttpOnly, so
// the page only ever knows the display name.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { useLocation } from "react-router";

import { ApiError, api } from "./api/client.ts";
import type { ClinicianUser } from "./api/types.ts";

interface AuthValue {
  user: ClinicianUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Call when any clinician request answered 401. */
  expire: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<ClinicianUser | null>(null);
  const [checked, setChecked] = useState(false);
  const onClinicianRoute = useLocation().pathname.startsWith("/clinician");
  const loading = onClinicianRoute && !checked;

  useEffect(() => {
    if (!onClinicianRoute || checked) return;
    let alive = true;
    api.me().then(
      ({ user }) => alive && (setUser(user), setChecked(true)),
      (e: unknown) => {
        if (!alive) return;
        if (!(e instanceof ApiError && e.code === "unauthorized")) setUser(null);
        setChecked(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [onClinicianRoute, checked]);

  const login = useCallback(async (username: string, password: string) => {
    const { user } = await api.login(username, password);
    setUser(user);
    setChecked(true);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const expire = useCallback(() => setUser(null), []);

  const value = useMemo(() => ({ user, loading, login, logout, expire }), [user, loading, login, logout, expire]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
