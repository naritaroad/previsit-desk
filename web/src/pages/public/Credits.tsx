import { useTranslation } from "react-i18next";

import photos from "@/content/photos.json";
import { formatDate } from "@/lib/format";
import { ExternalLink, Photo, TextLink, useLocale } from "@/ui";

import { usePageSeo } from "./lib/seo";
import { Opening, SplitRow, useList } from "./parts/common";

interface Meta {
  alt_zh: string;
  alt_en: string;
  credit: { photographer: string; source: string; url: string; license: string; license_url: string; checked: string };
}
const PHOTOS = photos as unknown as Record<string, Meta>;

export default function Credits() {
  const { t } = useTranslation("public");
  const ts = useList();
  const { t: common } = useTranslation("common");
  const locale = useLocale();
  usePageSeo("credits");
  return (
    <div className="site-wrap">
      <Opening title={t("credits.title")} lede={t("credits.lede")} />
      <section aria-labelledby="ph" className="pb-16">
        <h2 className="sr-only" id="ph">
          {t("credits.photosTitle")}
        </h2>
        <ul className="credit-list">
          {Object.entries(PHOTOS).map(([slot, m]) => (
            <li key={slot}>
              <Photo slot={slot} ratio="3 / 2" decorative sizes="(min-width: 64rem) 25rem, (min-width: 40rem) 50vw, 100vw" />
              <p className="what">{locale === "en" ? m.alt_en : m.alt_zh}</p>
              <p className="by">
                {common("photo.credit")} {m.credit.photographer}
                {common("photo.via", { source: m.credit.source })}
              </p>
              <p className="by flex flex-wrap gap-x-4">
                <ExternalLink href={m.credit.url}>
                  {t("credits.view")}
                  <span className="sr-only"> {m.credit.photographer}</span>
                </ExternalLink>
                <ExternalLink href={m.credit.license_url}>{m.credit.license}</ExternalLink>
                <span className="num">{t("credits.checked", { date: formatDate(m.credit.checked, locale, "short") })}</span>
              </p>
            </li>
          ))}
        </ul>
      </section>
      <SplitRow title={t("credits.softwareTitle")} className="tight">
        <ul className="limits">
          {ts<{ name: string; by: string; license: string; url: string }[]>("credits.software").map((s) => (
            <li key={s.name}>
              <p>
                <ExternalLink href={s.url}>{s.name}</ExternalLink>
              </p>
              <p>
                {s.by}
                {locale === "en" ? ", " : "，"}
                {s.license}
              </p>
            </li>
          ))}
        </ul>
      </SplitRow>
      <SplitRow title={t("credits.contentTitle")} className="tight">
        <p className="max-w-[36em] leading-loose">{t("credits.contentBody")}</p>
        <p className="mt-3 flex flex-wrap gap-x-6">
          <TextLink to="/handbook" className="inline-flex min-h-11 items-center">
            {t("credits.handbook")}
          </TextLink>
          <TextLink to="/trust/references-and-changelog" className="inline-flex min-h-11 items-center">
            {t("credits.references")}
          </TextLink>
        </p>
      </SplitRow>
    </div>
  );
}
