// Frame of the clinician screens: header with the signed-in name and a sign-out button, then the page.

import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate } from "react-router";

import { ApiError } from "../api/client.ts";
import { useAuth } from "../auth.tsx";
import { AppHeader } from "./AppHeader.tsx";
import { Icon } from "./Icon.tsx";

/** Redirects to the login page when nobody is signed in. */
export function RequireClinician({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="app">
        <div className="cl">
          <main className="cl-main page" aria-busy="true" aria-label={t("common.loading")}>
            <div className="skel" style={{ width: "40%" }} />
            <div className="skel" />
          </main>
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/clinician/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

/** Call from a catch block: a 401 means the session ended, so go back to the login page. */
export function useSessionGuard() {
  const { expire } = useAuth();
  return (e: unknown): boolean => {
    if (e instanceof ApiError && e.code === "unauthorized") {
      expire();
      return true;
    }
    return false;
  };
}

export function ClinicianShell({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    document.title = `${title}・${t("app.name")}`;
  }, [title, t]);

  return (
    <div className="app">
      <div className="cl">
        <AppHeader sub={t("clinician.sub")}>
          {user ? <span className="app-header__user text-sm text-muted">{user.display_name}</span> : null}
          {user ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={async () => {
                await logout();
                navigate("/clinician/login", { replace: true });
              }}
            >
              <Icon name="logout" size="sm" />
              <span className="btn-label">{t("clinician.logout")}</span>
            </button>
          ) : null}
        </AppHeader>
        <main className="cl-main page" id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
