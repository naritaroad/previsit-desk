// Safety page: the six boundaries, the latest eval pass rates, model names and data retention.

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { EvalCategory } from "../api/types.ts";
import { AppHeader } from "../components/AppHeader.tsx";
import { Icon } from "../components/Icon.tsx";
import { useMeta } from "../hooks/useMeta.ts";
import { currentLocale } from "../i18n/index.ts";
import { formatDateTime, formatPercent } from "../lib/format.ts";

const BOUNDARIES = ["disclosure", "redFlag", "noAdvice", "refill", "audit", "privacy"] as const;
const CATEGORY_ORDER: EvalCategory["key"][] = ["intake", "red_flag", "refill", "out_of_scope", "boundary"];

export function SafetyPage() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const { meta, failed, retry } = useMeta();
  const days = meta?.retention_days ?? 14;

  useEffect(() => {
    document.title = `${t("safety.title")}・${t("app.name")}`;
  }, [t, locale]);

  const ev = meta?.eval ?? null;
  const categories = ev ? [...ev.categories].sort((a, b) => CATEGORY_ORDER.indexOf(a.key) - CATEGORY_ORDER.indexOf(b.key)) : [];

  return (
    <div className="app">
      <div className="cl">
        <AppHeader sub={t("app.sub")} />
        <main className="cl-main page" id="main" tabIndex={-1}>
          <Link className="btn btn-ghost back-link" to="/">
            <Icon name="back" />
            {t("safety.back")}
          </Link>
          <div className="detail-head">
            <Icon name="shield" size="lg" />
            <h1>{t("safety.title")}</h1>
          </div>
          <p className="page__lead">{t("safety.lead")}</p>

          <div className="safety-grid">
            {BOUNDARIES.map((key, i) => (
              <section key={key} className="card boundary">
                <span className="boundary__num" aria-hidden="true">
                  {i + 1}
                </span>
                <div>
                  <h2>{t(`safety.boundary.${key}.title`)}</h2>
                  <p>{t(`safety.boundary.${key}.body`, { days })}</p>
                  <span className="chip boundary__how">
                    <Icon name="check" size="sm" />
                    {t(`safety.boundary.${key}.how`, { days })}
                  </span>
                </div>
              </section>
            ))}
          </div>

          <section className="card" aria-labelledby="eval-title">
            <h2 className="card__title" id="eval-title">
              <Icon name="list" />
              {t("safety.evalTitle")}
              {ev ? (
                <span className="text-xs text-muted card__sub">
                  {t("safety.evalMeta", { time: formatDateTime(ev.ran_at, locale), model: ev.model, total: ev.total })}
                </span>
              ) : null}
            </h2>
            {failed ? (
              <div className="notice" role="alert">
                <Icon name="wifi" />
                <div>
                  <p>{t("safety.loadFailed")}</p>
                  <button type="button" className="btn btn-secondary btn-compact" onClick={retry}>
                    {t("common.retry")}
                  </button>
                </div>
              </div>
            ) : !meta ? (
              <div className="stack-sm" aria-busy="true" aria-label={t("common.loading")}>
                <div className="skel" style={{ width: "60%" }} />
                <div className="skel" />
                <div className="skel" style={{ width: "80%" }} />
              </div>
            ) : !ev ? (
              <p className="text-sm text-muted">{t("safety.evalNone")}</p>
            ) : (
              <>
                <div className="eval">
                  {categories.map((c) => (
                    <div className="eval-row" key={c.key}>
                      <span>{t(`safety.eval.${c.key}`)}</span>
                      <div className="meter" role="img" aria-label={t("safety.evalAria", { name: t(`safety.eval.${c.key}`), passed: c.passed, total: c.total })}>
                        <span style={{ width: `${c.total ? (c.passed / c.total) * 100 : 0}%` }} />
                      </div>
                      <span className="eval-row__num">
                        {c.passed}／{c.total}・{formatPercent(c.passed, c.total, locale)}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-sm eval__total">
                  {t("safety.evalTotal", { passed: ev.passed, total: ev.total, percent: formatPercent(ev.passed, ev.total, locale) })}
                </p>
              </>
            )}
          </section>

          <section className="card" aria-labelledby="about-title">
            <h2 className="card__title" id="about-title">
              <Icon name="info" />
              {t("safety.aboutTitle")}
            </h2>
            <dl className="kv kv--wide">
              <dt>{t("safety.primaryModel")}</dt>
              <dd className="mono">{meta?.models.primary ?? "—"}</dd>
              <dt>{t("safety.fallbackModel")}</dt>
              <dd className="mono">{meta?.models.fallback ?? "—"}</dd>
              <dt>{t("safety.retention")}</dt>
              <dd>{t("safety.retentionValue", { days })}</dd>
              <dt>{t("safety.version")}</dt>
              <dd className="mono">{meta?.version ?? "—"}</dd>
            </dl>
            <p className="note-box">{t("safety.demoNote")}</p>
          </section>
        </main>
      </div>
    </div>
  );
}
