import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";

import { Phrases, TextLink } from "@/ui";

import { usePageSeo } from "./lib/seo";
import { PhotoNote } from "./parts/common";

export default function NotFound() {
  const { t } = useTranslation("public");
  const { pathname } = useLocation();
  usePageSeo("notFound", true);
  const links = [
    ["/", t("seo.siteName")],
    ["/service", t("cta.service")],
    ["/try", t("cta.try")],
    ["/trust", t("trust.title")],
    ["/handbook", t("handbook.title")],
    ["/emergency", t("cta.emergency")],
  ];
  return (
    <div className="site-wrap">
      <div className="entry">
        <div>
          <h1 className="pub-h1" tabIndex={-1}>
            <Phrases text={t("notFound.title")} />
          </h1>
          <p className="pub-lede">{t("notFound.body")}</p>
          <p className="mt-2 text-sm wrap-any text-fg-2">{t("notFound.path", { path: pathname })}</p>
          <ul className="pub-list mt-6 max-w-md">
            {links.map(([to, label]) => (
              <li key={to} className="py-0!">
                <TextLink to={to} className="inline-flex min-h-12 items-center">
                  {label}
                </TextLink>
              </li>
            ))}
          </ul>
        </div>
        <PhotoNote slot="nature_calm" ratio="4 / 5" sizes="(min-width: 64rem) 35vw, 100vw" className="max-lg:hidden" />
      </div>
    </div>
  );
}
