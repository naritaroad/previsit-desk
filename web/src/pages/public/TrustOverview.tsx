import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";

import { formatDate } from "@/lib/format";
import { DocumentMeta, Phrases, useLocale } from "@/ui";

import { usePageSeo } from "./lib/seo";
import { Opening, useList } from "./parts/common";
import { FactsTable } from "./parts/FactsTable";
import { DOC_SET, DOCS } from "./trust/docs";
import { TrustSearch } from "./trust/SearchBox";

export default function TrustOverview() {
  const { t } = useTranslation("public");
  const ts = useList();
  const locale = useLocale();
  const [params] = useSearchParams();
  usePageSeo("trust");
  const date = (d: string) => formatDate(d, locale, "long");
  return (
    <div className="site-wrap">
      <Opening
        title={t("trust.title")}
        lede={t("trust.lede")}
        aside={
          <nav className="start-list" aria-labelledby="start-h">
            <h2 id="start-h">{t("trust.startTitle")}</h2>
            <ul>
              {ts<{ to: string; t: string; d: string }[]>("trust.start").map((x) => (
                <li key={x.to}>
                  <Link to={x.to}>
                    <b>{x.t}</b>
                    <span>{x.d}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        }
      >
        <div className="trust-meta">
          <DocumentMeta
            items={[
              { label: t("trust.setMeta.version"), value: DOC_SET.version },
              { label: t("trust.setMeta.effective"), value: date(DOC_SET.effective) },
              { label: t("trust.setMeta.next"), value: date(DOC_SET.next_review) },
              { label: t("trust.setMeta.count"), value: t("trust.setMeta.countValue", { count: DOCS.length }) },
            ]}
          />
        </div>
        <p className="mb-6 max-w-[38em] text-fg-2">{t("trust.reviewNote")}</p>
        <TrustSearch />
      </Opening>

      <section className="pub-docs" aria-labelledby="docs-h">
        <h2 className="pub-h2" id="docs-h">
          {t("trust.listTitle")}
        </h2>
        <ol className="doc-list">
          {DOCS.map((d) => (
            <li key={d.slug}>
              <Link to={`/trust/${d.slug}`}>
                <span className="no num">{d.order}</span>
                <span className="name">
                  <Phrases text={d.title[locale]} />
                </span>
                <span className="sum">{d.summary[locale]}</span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      {!params.get("q") && (
          <section className="pb-20" aria-labelledby="facts-h">
            <h2 className="pub-h2 mb-6" id="facts-h">
              {t("trust.factsTitle")}
            </h2>
            <FactsTable />
          </section>
      )}
    </div>
  );
}
