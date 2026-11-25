import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";

import { useHandbook, useHandbookSearch } from "@/data";
import { EmptyState, ErrorState, SearchInput, SkeletonRows, Spinner, useLocale } from "@/ui";

import { chaptersOf, handbookPath } from "./lib/handbook";
import { useResumed } from "./lib/live";
import { usePageSeo } from "./lib/seo";
import { Opening, PhotoNote } from "./parts/common";

/** Section titles and text are Chinese in both languages. */
const ZH = "zh-Hant-TW";

export default function Handbook() {
  const { t } = useTranslation("public");
  const locale = useLocale();
  usePageSeo("handbook");
  const list = useResumed(useHandbook());
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [asked, setAsked] = useState(q);
  useEffect(() => {
    const id = setTimeout(() => setAsked(q), 250);
    return () => clearTimeout(id);
  }, [q]);
  const found = useHandbookSearch(asked);
  const searching = [...q.trim()].length >= 2;

  return (
    <div className="site-wrap">
      <Opening title={t("handbook.title")} lede={t("handbook.lede")} aside={<PhotoNote slot="nature_calm" ratio="16 / 9" priority sizes="(min-width: 64rem) 42vw, 100vw" className="max-lg:hidden" />}>
        <p className="mt-3 max-w-[34em] text-fg-2">
          {t("handbook.note")} {locale === "en" && t("handbook.chineseOnly")}
        </p>
        <div role="search" className="mt-6">
          <SearchInput
            value={q}
            onValueChange={(v) => setParams(v ? { q: v } : {}, { replace: true, preventScrollReset: true })}
            placeholder={t("handbook.placeholder")}
            aria-label={t("handbook.search")}
            className="max-w-xl"
          />
        </div>
      </Opening>

      {searching && (
        <section className="pb-10" aria-live="polite">
          {found.isError ? (
            <ErrorState onRetry={() => void found.refetch()} />
          ) : !found.data || asked !== q ? (
            <Spinner />
          ) : found.data.length === 0 ? (
            <EmptyState title={t("handbook.none", { q: q.trim() })}>{t("handbook.noneBody")}</EmptyState>
          ) : (
            <>
              <p className="font-semibold">{t("handbook.results", { q: q.trim(), count: found.data.length })}</p>
              <ol className="hits" lang={ZH}>
                {found.data.map((h) => (
                  <li key={h.section}>
                    <Link to={handbookPath(h.section)} className="link">
                      <span className="num">{h.section}</span> {h.title}
                    </Link>
                    <p>{h.snippet}</p>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}

      <div className="pb-20">
        {list.isPending ? (
          <SkeletonRows rows={8} />
        ) : list.isError ? (
          <ErrorState onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : (
          chaptersOf(list.data).map((c) => (
            <section key={c.title} className="hb-chapter" lang={ZH}>
              <h2>{c.title}</h2>
              <ul>
                {c.items.map((e) => (
                  <li key={e.section}>
                    <Link to={handbookPath(e.section)}>
                      <span className="no num">{e.section}</span>
                      <span className="name">{e.title}</span>
                      <span className="src" lang={locale === "en" ? "en" : ZH}>
                        {t(`handbook.sourceType.${e.source_type}`, { defaultValue: e.source_type })}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
