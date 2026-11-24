// Clinician sign-in (demo account). Wrong credentials and rate limits are shown under the fields.

import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate } from "react-router";

import { ApiError } from "../api/client.ts";
import { useAuth } from "../auth.tsx";
import { AppHeader } from "../components/AppHeader.tsx";
import { Icon } from "../components/Icon.tsx";
import { describeApiError } from "../lib/errors.ts";

export function ClinicianLogin() {
  const { t } = useTranslation();
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const uid = useId();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof describeApiError> | null>(null);
  const from = (location.state as { from?: string } | null)?.from ?? "/clinician";

  useEffect(() => {
    document.title = `${t("clinician.loginTitle")}・${t("app.name")}`;
  }, [t]);

  if (user) return <Navigate to={from} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      navigate(from, { replace: true });
    } catch (ex) {
      setError(describeApiError(ex));
      if (!(ex instanceof ApiError)) setError({ key: "errors.internal", retryable: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="cl">
        <AppHeader sub={t("clinician.sub")} />
        <main className="cl-main page page--narrow" id="main" tabIndex={-1}>
          <section className="card">
            <h1 className="card__heading">{t("clinician.loginTitle")}</h1>
            <p className="text-sm text-muted">{t("clinician.loginLead")}</p>
            <form className="stack" onSubmit={onSubmit} noValidate>
              <div className="form-field">
                <label htmlFor={`${uid}-user`}>{t("clinician.username")}</label>
                <input
                  id={`${uid}-user`}
                  className="field"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor={`${uid}-pass`}>{t("clinician.password")}</label>
                <input
                  id={`${uid}-pass`}
                  className="field"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `${uid}-err` : undefined}
                  required
                />
                {error ? (
                  <span className="form-err" id={`${uid}-err`} role="alert">
                    <Icon name="alert" size="sm" />
                    {t(error.key, error.params)}
                  </span>
                ) : null}
              </div>
              <button className="btn btn-primary" type="submit" disabled={busy || !username.trim() || !password}>
                {busy ? t("clinician.loggingIn") : t("clinician.login")}
              </button>
            </form>
          </section>
        </main>
      </div>
    </div>
  );
}
