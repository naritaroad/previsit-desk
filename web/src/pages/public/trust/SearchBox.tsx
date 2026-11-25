import { useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";

import { Button, EmptyState, ErrorState, SearchInput, Spinner, useLocale } from "@/ui";

import { DOCS } from "./docs";
import { useAllDocs, useFacts } from "./hooks";
import { buildIndex, search } from "./search";

const PAGE = 12;

/** The search of /trust. The query is in the address, so a result list can be shared and the back button works. */
export function TrustSearch() {
  const { t } = useTranslation("public");
  const locale = useLocale();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const query = useDeferredValue(q.trim());
  const [started, setStarted] = useState(q !== "");
  const [shown, setShown] = useState(PAGE);
  const all = useAllDocs(started || q !== "");
  const { value } = useFacts();

  const index = useMemo(() => (all.data?.length ? buildIndex(all.data, (slug) => DOCS.find((d) => d.slug === slug)?.title[locale] ?? slug, (k) => value(k) ?? "") : []), [all.data, locale, value]);
  const hits = useMemo(() => (query ? search(index, query) : []), [index, query]);

  const type = (v: string) => {
    setShown(PAGE);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (v) next.set("q", v);
        else next.delete("q");
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  };

  return (
    <div role="search" aria-label={t("trust.search.label")}>
      <SearchInput value={q} onValueChange={type} onFocus={() => setStarted(true)} placeholder={t("trust.search.placeholder")} aria-label={t("trust.search.label")} className="max-w-2xl" />
      {query && (
        <section className="mt-6" aria-live="polite">
          {all.failed ? (
            <ErrorState onRetry={all.retry} />
          ) : index.length === 0 ? (
            <Spinner label={t("trust.search.loading")} />
          ) : hits.length === 0 ? (
            <EmptyState title={t("trust.search.none", { q: query })}>{t("trust.search.noneBody")}</EmptyState>
          ) : (
            <>
              <p className="font-semibold">{t("trust.search.results", { q: query, count: hits.length })}</p>
              <ol className="hits">
                {hits.slice(0, shown).map((h) => (
                  <li key={`${h.slug}-${h.id}`}>
                    <Link to={`/trust/${h.slug}#${h.id}`} className="link">
                      <span className="num">{h.no}</span> {h.docTitle}
                      {locale === "zh-TW" ? "：" : ": "}
                      {h.title}
                    </Link>
                    <p>
                      {h.snippet.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : s.text))}
                    </p>
                  </li>
                ))}
              </ol>
              {hits.length > shown && (
                <Button className="mt-4" onClick={() => setShown((n) => n + PAGE)}>
                  {t("trust.search.more", { count: Math.min(PAGE, hits.length - shown) })}
                </Button>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}

/** On a document: takes the words to the search page. */
export function SearchJump() {
  const { t } = useTranslation("public");
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  return (
    <form
      role="search"
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) void navigate(`/trust?q=${encodeURIComponent(q.trim())}`);
      }}
    >
      <SearchInput value={q} onValueChange={setQ} placeholder={t("trust.search.label")} aria-label={t("trust.search.label")} />
    </form>
  );
}
