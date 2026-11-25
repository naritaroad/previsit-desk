import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { useHandbook } from "@/data";
import { formatDate } from "@/lib/format";
import { safeExternalUrl } from "@/lib/links";
import { ButtonLink, DescriptionList, EmptyState, ErrorState, ExternalLink, Phrases, SkeletonRows, TextLink, useLocale } from "@/ui";

import { handbookPath, isWarning, sectionId, withSections } from "./lib/handbook";
import { useResumed } from "./lib/live";
import { useSeo } from "./lib/seo";

const ZH = "zh-Hant-TW";

export default function HandbookArticle() {
  const { id = "" } = useParams();
  const { t } = useTranslation("public");
  const locale = useLocale();
  const list = useResumed(useHandbook());
  const items = list.data ?? [];
  const i = items.findIndex((e) => sectionId(e.section) === id);
  const entry = items[i];
  const prev = items[i - 1];
  const next = items[i + 1];
  useSeo({
    title: entry ? `${entry.title}｜${t("handbook.title")}` : t("seo.handbook.title"),
    description: entry ? [...entry.text].slice(0, 90).join("") : t("seo.handbook.desc"),
    noindex: list.isSuccess && !entry,
  });

  if (!entry)
    return (
      <div className="site-wrap py-16">
        {list.isPending ? (
          <>
            <h1 className="pub-h1" tabIndex={-1}>
              {t("handbook.title")}
            </h1>
            <SkeletonRows rows={5} className="mt-6" />
          </>
        ) : list.isError ? (
          <ErrorState onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : (
          <EmptyState title={<h1 tabIndex={-1}>{t("handbook.notFoundTitle")}</h1>} action={<ButtonLink to="/handbook">{t("handbook.back")}</ButtonLink>}>
            {t("handbook.notFoundBody")}
          </EmptyState>
        )}
      </div>
    );

  const known = new Set(items.map((e) => e.section));
  const source = safeExternalUrl(entry.source_url);
  const same = items.filter((e) => e.chapter === entry.chapter);
  return (
    <div className="site-wrap site-page">
      <div className="doc">
        <div className="doc-toc hb-toc">
          <nav aria-label={t("handbook.related")} className="toc-nav">
            <p className="toc-title" lang={ZH}>
              {entry.chapter}
            </p>
            <ol className="toc toc-wide" lang={ZH}>
              {same.map((e) => (
                <li key={e.section}>
                  <Link to={handbookPath(e.section)} aria-current={e === entry ? "page" : undefined} data-open={e === entry}>
                    <span className="num">{sectionId(e.section)}</span>
                    <span>{e.title}</span>
                  </Link>
                </li>
              ))}
            </ol>
            <p className="mt-4 max-lg:hidden">
              <TextLink to="/handbook">{t("handbook.back")}</TextLink>
            </p>
          </nav>
        </div>
        <article className="doc-body hb-article">
          <p className="doc-crumb">
            <TextLink to="/handbook" className="inline-flex min-h-8 items-center">
              {t("handbook.back")}
            </TextLink>
            <span className="num text-fg-2">{entry.section}</span>
          </p>
          <h1 className="pub-h1" tabIndex={-1} lang={ZH}>
            <Phrases text={entry.title} />
          </h1>
          {locale === "en" && <p className="mt-3 text-fg-2">{t("handbook.chineseOnly")}</p>}
          {isWarning(entry.section) && (
            <div className="hb-warning" role="note">
              <p>{t("handbook.urgentTitle")}</p>
              <p>{t("handbook.urgentBody")}</p>
              <p className="flex flex-wrap gap-x-6">
                <a href="tel:119">119</a>
                <a href="tel:1925">1925</a>
              </p>
            </div>
          )}
          <div className="hb-text" lang={ZH}>
            {entry.text.split(/\n{2,}/).map((para, k) => (
              <p key={k}>
                {withSections(para, known).map((s, j) =>
                  s.section && s.section !== entry.section ? (
                    <Link key={j} to={handbookPath(s.section)} className="link">
                      {s.text}
                    </Link>
                  ) : (
                    s.text
                  ),
                )}
              </p>
            ))}
          </div>
          <div className="mt-10 border-t-[1.5px] border-ink pt-2">
            <DescriptionList
              items={[
                {
                  label: t("handbook.source"),
                  value: (
                    <span lang={ZH}>
                      {entry.source_name}
                      {source && (
                        <>
                          {" "}
                          <ExternalLink href={source} lang={locale === "en" ? "en" : ZH}>
                            {t("handbook.openSource")}
                          </ExternalLink>
                        </>
                      )}
                    </span>
                  ),
                },
                { label: t("handbook.verified"), value: formatDate(entry.verified_on, locale, "long") },
              ]}
            />
          </div>
          <p className="mt-4 text-sm text-fg-2">{t("handbook.note")}</p>
          <nav className="doc-next" aria-label={t("trust.doc.nav")}>
            {prev && (
              <Link to={handbookPath(prev.section)} rel="prev">
                <small>{t("handbook.prev")}</small>
                <b lang={ZH}>{prev.title}</b>
              </Link>
            )}
            {next && (
              <Link to={handbookPath(next.section)} rel="next">
                <small>{t("handbook.next")}</small>
                <b lang={ZH}>{next.title}</b>
              </Link>
            )}
          </nav>
        </article>
      </div>
    </div>
  );
}
