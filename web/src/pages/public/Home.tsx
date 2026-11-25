import { useTranslation } from "react-i18next";

import { useSession } from "@/app/session-context";
import { homePath } from "@/lib/permissions";
import { ButtonLink, Photo, Phrases, TextLink } from "@/ui";

import { usePageSeo } from "./lib/seo";
import { CallRow, PhotoNote, SplitRow, useCopy } from "./parts/common";
import { Excerpt } from "./parts/Excerpt";
import { FactsTable } from "./parts/FactsTable";
import { RefillDemo } from "./parts/RefillDemo";
import { RenewalPath } from "./parts/RenewalPath";

export default function Home() {
  const { t, ts } = useCopy();
  const { t: shell } = useTranslation("shell");
  const { me } = useSession();
  usePageSeo("home");
  return (
    <>
      <section className="site-wrap hero">
        <div className="hero-text">
          <h1 tabIndex={-1}>
            <Phrases text={t("home.title")} />
          </h1>
          <p>{t("home.lede")}</p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <ButtonLink to={me ? homePath(me) : "/try"} variant="primary" size="lg">
              {me ? shell("public.toWorkspace") : t("cta.try")}
            </ButtonLink>
            <TextLink to="/#limits" className="inline-flex min-h-11 items-center text-md">
              {t("home.heroLink")}
            </TextLink>
          </div>
          <p className="hero-fiction">{t("fiction")}</p>
        </div>
        <div className="hero-photos">
          <Photo slot="medicine_table" ratio="auto" priority sizes="(min-width: 64rem) 38vw, 66vw" />
          <p>
            {t("photo.medicine_table")} {t("photo.consultation")} {t("home.photoNote")} <TextLink to="/credits">{shell("footer.credits")}</TextLink>
          </p>
          <Photo slot="consultation" ratio="3 / 4" priority decorative sizes="(min-width: 64rem) 18vw, 30vw" />
        </div>
      </section>

      <section className="site-wrap">
        <div className="strip-feature">
          <div>
            <h2>
              <Phrases text={t("home.strip.title")} />
            </h2>
            <p>{t("home.strip.body")}</p>
          </div>
          <RefillDemo />
        </div>
      </section>

      <section className="pub-sheet">
        <div className="site-wrap pub-block">
          <div className="pub-intro">
            <h2 className="pub-h2">
              <Phrases text={t("home.excerpt.title")} />
            </h2>
            <p>{t("home.excerpt.body")}</p>
          </div>
          <Excerpt />
        </div>
      </section>

      <div className="site-wrap">
        <SplitRow title={t("home.renewal.title")} aside={<p>{t("home.renewal.body")}</p>}>
          <RenewalPath />
          <p className="pub-note">
            {t("home.renewal.note")} <TextLink to="/trust/medication-renewal">{t("home.renewal.link")}</TextLink>
          </p>
        </SplitRow>
      </div>

      <section className="photo-band">
        <Photo slot="waiting" ratio="21 / 9" sizes="100vw" credit caption={<span>{t("photo.waiting")} </span>} />
      </section>

      <section className="site-wrap who" aria-labelledby="who-title">
        <h2 className="pub-h2" id="who-title">
          <Phrases text={t("home.who.title")} />
        </h2>
        <article data-ws="patient" className="who-patient">
          <PhotoNote slot="hero" ratio="3 / 2" sizes="(min-width: 64rem) 55vw, 100vw" className="who-photo" />
          <div>
            <h3>{t("home.who.patient.title")}</h3>
            <p>{t("home.who.patient.body")}</p>
            <p>{t("home.who.patient.body2")}</p>
            <ButtonLink to="/try">{t("home.who.patient.cta")}</ButtonLink>
          </div>
        </article>
        <article data-ws="clinic" className="who-physician">
          <PhotoNote slot="notes_hand" ratio="3 / 2" sizes="(min-width: 64rem) 42vw, 100vw" className="who-photo" />
          <div>
            <h3>{t("home.who.physician.title")}</h3>
            <p>{t("home.who.physician.body")}</p>
            <p>{t("home.who.physician.body2")}</p>
            <ButtonLink to="/clinicians#desk">{t("home.who.physician.cta")}</ButtonLink>
          </div>
        </article>
        <article data-ws="pharmacy" className="who-pharmacist">
          <PhotoNote slot="pharmacy" ratio="3 / 2" sizes="(min-width: 64rem) 33vw, 100vw" className="who-photo" />
          <div>
            <h3>{t("home.who.pharmacist.title")}</h3>
            <p>{t("home.who.pharmacist.body")}</p>
            <p>{t("home.who.pharmacist.body2")}</p>
            <ButtonLink to="/clinicians#pharmacy">{t("home.who.pharmacist.cta")}</ButtonLink>
          </div>
        </article>
      </section>

      <section className="pub-sheet">
        <div className="site-wrap">
          <SplitRow id="limits" title={t("home.limits.title")} aside={<TextLink to="/trust/intended-use">{t("home.limits.link")}</TextLink>}>
            <ul className="limits">
              {ts<{ t: string; d: string }[]>("home.limits.items").map((i) => (
                <li key={i.t}>
                  <p>{i.t}</p>
                  <p>{i.d}</p>
                </li>
              ))}
            </ul>
          </SplitRow>
        </div>
      </section>

      <div className="site-wrap">
        <section className="pub-block">
          <div className="pub-intro">
            <h2 className="pub-h2">
              <Phrases text={t("home.trust.title")} />
            </h2>
            <p>
              {t("home.trust.body")} <TextLink to="/trust">{t("cta.trust")}</TextLink>
            </p>
          </div>
          <FactsTable />
        </section>
      </div>

      <section className="pub-emergency" aria-labelledby="em-title">
        <div className="site-wrap">
          <div>
            <h2 className="pub-h2" id="em-title">
              <Phrases text={t("home.emergency.title")} />
            </h2>
            <p>{t("home.emergency.body")}</p>
            <TextLink to="/emergency" className="inline-flex min-h-11 items-center">
              {t("home.emergency.link")}
            </TextLink>
          </div>
          <CallRow />
        </div>
      </section>
    </>
  );
}
