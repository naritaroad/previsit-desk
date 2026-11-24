// Clinician session: GET /auth/me on load, login and logout. The cookie is HttpOnly, so the page
// only ever knows the display name.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api.me().then(
      ({ user }) => alive && (setUser(user), setLoading(false)),
      (e: unknown) => {
        if (!alive) return;
        if (!(e instanceof ApiError && e.code === "unauthorized")) setUser(null);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const { user } = await api.login(username, password);
    setUser(user);
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
