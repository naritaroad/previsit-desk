import { IconLanguage, IconPrinter } from "@tabler/icons-react";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useParams } from "react-router";

import { useSession } from "@/app/session-context";
import { formatDate, formatTime, todayInTaipei } from "@/lib/format";
import { Button, DocLayout, DocumentMeta, ErrorState, Footnotes, Phrases, Prose, SkeletonRows, TableOfContents, TextLink, useLocale } from "@/ui";

import { useSeo } from "./lib/seo";
import NotFound from "./NotFound";
import { citedIn, DOCS, type DocEntry, linkReferences, REFERENCES_SLUG, referencesOf, resolveSlug } from "./trust/docs";
import { useAllDocs, useDoc, useFacts, useKeepPosition } from "./trust/hooks";
import { DocMarkdown, FactsContext, InlineMarkdown } from "./trust/Markdown";
import { SearchJump } from "./trust/SearchBox";

export default function TrustSection() {
  const { section = "" } = useParams();
  const { doc, redirect } = resolveSlug(section);
  if (redirect) return <Navigate to={redirect} replace />;
  if (!doc) return <NotFound />;
  return <TrustDocument key={doc.slug} entry={doc} />;
}

const REFS = DOCS.find((d) => d.slug === REFERENCES_SLUG)!;

function TrustDocument({ entry }: { entry: DocEntry }) {
  const { t } = useTranslation("public");
  const { t: shell } = useTranslation("shell");
  const locale = useLocale();
  const { setLocale } = useSession();
  const facts = useFacts();
  const loaded = useDoc(entry);
  const refDoc = useDoc(REFS);
  const isRefs = entry.slug === REFERENCES_SLUG;
  const all = useAllDocs(isRefs);
  const doc = loaded.data;
  useKeepPosition(doc && loaded.locale ? `${loaded.locale}` : "");
  useSeo({ title: shell("title", { page: entry.title[locale] }), description: entry.summary[locale] });

  // A document that arrived after its address: the layout's search for the hash target covers two seconds; a slow
  // network takes longer.
  useEffect(() => {
    if (!doc || !location.hash) return;
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
    // Only when the text first arrives, not on a change of language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc !== null]);

  const body = useMemo(() => (doc ? linkReferences(doc.body) : ""), [doc]);
  const cited = useMemo(() => (doc ? citedIn(doc).sort((a, b) => a - b) : []), [doc]);
  const refs = useMemo(() => (refDoc.data ? referencesOf(refDoc.data) : new Map<number, string>()), [refDoc.data]);
  const toc = useMemo(() => {
    const items: { id: string; title: string; no: string; children?: { id: string; title: string; no: string }[] }[] = [];
    for (const h of doc?.headings ?? []) {
      const item = { id: h.id, title: h.title, no: h.no };
      if (h.level === 2) items.push(item);
      else (items.at(-1)!.children ??= []).push(item);
    }
    return items;
  }, [doc]);

  const i = DOCS.indexOf(entry);
  const prev = DOCS[i - 1];
  const next = DOCS[i + 1];
  const date = (d: string | undefined) => (d ? formatDate(d, locale, "long") : "");
  const other = locale === "zh-TW" ? "en" : "zh-TW";
  const meta = doc?.meta ?? {};

  return (
    <FactsContext value={facts}>
      <div className="site-wrap site-page">
        <nav className="doc-crumb" aria-label={shell("nav.path")}>
          <TextLink to="/trust" className="inline-flex min-h-8 items-center">
            {t("trust.doc.breadcrumb")}
          </TextLink>
          <span className="text-fg-2">
            {entry.order} / {DOCS.length}
          </span>
        </nav>
        <DocLayout
          toc={
            <div
              onClick={(e) => {
                // On a phone the contents cover the text; close them once a heading is chosen.
                const a = (e.target as HTMLElement).closest("a");
                const details = a?.closest("details");
                if (details) details.open = false;
              }}
            >
              <TableOfContents items={toc} />
              <div className="doc-all">
                <TextLink to="/trust">{t("trust.doc.all")}</TextLink>
                <SearchJump />
              </div>
            </div>
          }
        >
          <Prose>
            <h1 tabIndex={-1}>
              <Phrases text={entry.title[locale]} />
            </h1>
            <p className="lede mt-4">{entry.summary[locale]}</p>
            <DocumentMeta
              items={[
                { label: t("trust.doc.version"), value: meta.version },
                { label: t("trust.doc.effective"), value: date(meta.effective) },
                { label: t("trust.doc.owner"), value: meta.owner },
                { label: t("trust.doc.reviewer"), value: meta.reviewer },
                { label: t("trust.doc.next"), value: date(meta.next_review) },
              ]}
            />
            <div className="doc-tools no-print">
              <Button size="sm" variant="ghost" icon={<IconLanguage aria-hidden />} onClick={() => setLocale(other)}>
                <span lang={other === "en" ? "en" : "zh-Hant-TW"}>{t("trust.doc.switchTo")}</span>
              </Button>
              <Button size="sm" variant="ghost" icon={<IconPrinter aria-hidden />} onClick={() => window.print()}>
                {t("trust.doc.print")}
              </Button>
            </div>
            {body.includes("{{facts.") && (
              <p className="doc-live" role="status">
                {facts.state === "ready" ? t("trust.doc.live", { time: formatTime(facts.at, locale) }) : facts.state === "failed" ? t("trust.doc.liveFailed") : t("trust.doc.liveLoading")}
              </p>
            )}
            {doc ? (
              <div className="doc-text" lang={loaded.locale === "en" ? "en" : "zh-Hant-TW"}>
                <DocMarkdown body={body} headings={doc.headings} title={entry.title[locale]} />
              </div>
            ) : loaded.failed ? (
              <ErrorState title={t("trust.doc.loadFailed")} onRetry={loaded.retry} />
            ) : (
              <SkeletonRows rows={8} />
            )}
            {cited.length > 0 && refs.size > 0 && (
              <Footnotes title={t("trust.doc.refs")} items={cited.filter((n) => refs.has(n)).map((n) => ({ n, content: <InlineMarkdown text={refs.get(n)!} /> }))} />
            )}
            {isRefs && all.data && all.data.length > 0 && <CitedBy docs={all.data} refs={[...refs.keys()]} />}
            <nav className="doc-next" aria-label={t("trust.doc.nav")}>
              {prev && (
                <Link to={`/trust/${prev.slug}`} rel="prev">
                  <small>{t("trust.doc.prev")}</small>
                  <b>{prev.title[locale]}</b>
                </Link>
              )}
              {next && (
                <Link to={`/trust/${next.slug}`} rel="next">
                  <small>{t("trust.doc.next_")}</small>
                  <b>{next.title[locale]}</b>
                </Link>
              )}
            </nav>
            <p className="print-only">{t("trust.doc.printedFrom", { url: location.href, date: formatDate(todayInTaipei(), locale, "long") })}</p>
          </Prose>
        </DocLayout>
      </div>
    </FactsContext>
  );
}

/** On the references page: which documents cite each entry. */
function CitedBy({ docs, refs }: { docs: { slug: string; body: string }[]; refs: number[] }) {
  const { t } = useTranslation("public");
  const locale = useLocale();
  return (
    <section className="footnotes" aria-label={t("trust.doc.citedBy")}>
      <h2>{t("trust.doc.citedBy")}</h2>
      <ol>
        {refs.map((n) => (
          <li key={n} value={n} id={`ref-${n}`} className="doc-cited">
            {docs
              .filter((d) => citedIn(d).includes(n))
              .map((d, k) => (
                <span key={d.slug}>
                  {k > 0 && (locale === "zh-TW" ? "、" : ", ")}
                  <TextLink to={`/trust/${d.slug}#fnref-${n}`}>{DOCS.find((x) => x.slug === d.slug)?.title[locale]}</TextLink>
                </span>
              ))}
          </li>
        ))}
      </ol>
    </section>
  );
}
