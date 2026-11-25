import { useTranslation } from "react-i18next";
import { Phrases, TextLink } from "@/ui";

import { usePageSeo } from "./lib/seo";
import { CallRow, Opening, SplitRow, useList } from "./parts/common";

export default function Emergency() {
  const { t } = useTranslation("public");
  const ts = useList();
  usePageSeo("emergency");
  return (
    <div className="site-wrap">
      <Opening title={t("emergency.title")} lede={t("emergency.lede")} aside={<CallRow />} />
      <section className="pub-split tight border-danger-solid! border-t-2!">
        <div className="pub-split-head">
          <h2 className="pub-h2">
            <Phrases text={t("emergency.whenTitle")} />
          </h2>
          <p>{t("emergency.whenNote")}</p>
        </div>
        <ul className="when-list">
          {ts<{ t: string; s: string }[]>("emergency.when").map((w) => (
            <li key={w.s}>
              <div>
                <span>{w.t}</span>
                <TextLink to={`/handbook/${w.s}`}>{t("handbook.see", { section: `§${w.s}` })}</TextLink>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <SplitRow title={t("emergency.crisisTitle")} className="tight">
        <p className="max-w-[36em] text-md leading-loose">{t("emergency.crisisBody")}</p>
        <p className="mt-4 flex flex-wrap gap-x-8">
          {["1925", "1995", "1980", "119"].map((n) => (
            <a key={n} href={`tel:${n}`} className="num inline-flex min-h-12 items-center text-xl font-extrabold text-danger underline underline-offset-4">
              {n}
            </a>
          ))}
        </p>
        <TextLink to="/handbook/2.7" className="mt-2 inline-flex min-h-11 items-center">
          {t("handbook.see", { section: "§2.7" })}
        </TextLink>
      </SplitRow>
      <SplitRow title={t("emergency.sayTitle")} className="tight">
        <ol className="pub-list say-list">
          {ts<string[]>("emergency.say").map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </SplitRow>
      <SplitRow title={t("emergency.siteTitle")} className="tight">
        <ul className="pub-list">
          {ts<string[]>("emergency.site").map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <TextLink to="/trust/clinical-safety" className="mt-4 inline-flex min-h-11 items-center">
          {t("emergency.link")}
        </TextLink>
      </SplitRow>
    </div>
  );
}
