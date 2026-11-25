import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { AppHeader } from "../components/AppHeader.tsx";
import { Icon } from "../components/Icon.tsx";

export function NotFoundPage() {
  const { t } = useTranslation();
  useEffect(() => {
    document.title = `${t("notFound.title")}・${t("app.name")}`;
  }, [t]);
  return (
    <div className="app">
      <div className="cl">
        <AppHeader sub={t("app.sub")} />
        <main className="cl-main page page--narrow" id="main" tabIndex={-1}>
          <div className="empty card">
            <Icon name="search" />
            <h1>{t("notFound.title")}</h1>
            <p>{t("notFound.body")}</p>
            <Link className="btn btn-primary" to="/">
              {t("notFound.home")}
            </Link>
          </div>
        </main>
      </div>
    </div>
  );
}
