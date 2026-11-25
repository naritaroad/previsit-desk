// Title, description, Open Graph and language alternates of a public page. The static tags in index.html are the
// fallback for crawlers that run no script; this keeps them right for everyone else.

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";

import type { Locale } from "@/api/types";
import photos from "@/content/photos.json";
import { useLocale } from "@/ui";

const HREFLANG: Record<Locale, string> = { "zh-TW": "zh-Hant-TW", en: "en" };
const OG_LOCALE: Record<Locale, string> = { "zh-TW": "zh_TW", en: "en_US" };
const OG_IMAGE = "/og.jpg";

export const langUrl = (path: string, locale: Locale) => `${location.origin}${path}?lang=${locale}`;

function meta(key: "name" | "property", id: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${key}="${id}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(key, id);
    document.head.append(el);
  }
  el.content = content;
}
function link(rel: string, href: string, hreflang?: string) {
  const selector = hreflang ? `link[rel="${rel}"][hreflang="${hreflang}"]` : `link[rel="${rel}"]`;
  let el = document.head.querySelector<HTMLLinkElement>(selector);
  if (!el) {
    el = document.createElement("link");
    el.rel = rel;
    if (hreflang) el.hreflang = hreflang;
    document.head.append(el);
  }
  el.href = href;
}

export interface Seo {
  title: string;
  description: string;
  /** Not for search engines: sign-in, register, not found. */
  noindex?: boolean;
}

export function useSeo({ title, description, noindex }: Seo) {
  const { t } = useTranslation("public");
  const { pathname } = useLocation();
  const locale = useLocale();
  useEffect(() => {
    document.title = title;
    meta("name", "description", description);
    meta("name", "robots", noindex ? "noindex" : "index,follow");
    meta("property", "og:type", "website");
    meta("property", "og:site_name", t("seo.siteName"));
    meta("property", "og:title", title);
    meta("property", "og:description", description);
    meta("property", "og:url", langUrl(pathname, locale));
    meta("property", "og:locale", OG_LOCALE[locale]);
    meta("property", "og:locale:alternate", OG_LOCALE[locale === "en" ? "zh-TW" : "en"]);
    meta("property", "og:image", location.origin + OG_IMAGE);
    meta("property", "og:image:alt", locale === "en" ? photos.medicine_table.alt_en : photos.medicine_table.alt_zh);
    meta("name", "twitter:card", "summary_large_image");
    link("canonical", langUrl(pathname, locale));
    link("alternate", langUrl(pathname, "zh-TW"), HREFLANG["zh-TW"]);
    link("alternate", langUrl(pathname, "en"), HREFLANG.en);
    link("alternate", location.origin + pathname, "x-default");
  }, [title, description, noindex, pathname, locale, t]);
}

/** The common case: `seo.<page>.title` and `.desc` of public.json. */
export function usePageSeo(page: "home" | "service" | "clinicians" | "trust" | "handbook" | "emergency" | "credits" | "login" | "register" | "try" | "notFound", noindex?: boolean) {
  const { t } = useTranslation("public");
  useSeo({ title: t(`seo.${page}.title`), description: t(`seo.${page}.desc`), noindex });
}
