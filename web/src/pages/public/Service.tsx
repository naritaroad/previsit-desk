import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Disposition } from "@/api/types";
import { addDays, todayInTaipei } from "@/lib/format";
import { AssistantBubble, ButtonLink, NoticeLine, PatientBubble, Phrases, RefillStrip, RefusalNote, RuledTable, StaffBubble, StatusTag, TextLink, Timeline } from "@/ui";

import { DEMO_RX, viewOn } from "./lib/refillDemo";
import { usePageSeo } from "./lib/seo";
import { Opening, PhotoNote, SplitRow, useList } from "./parts/common";

const SITUATIONS = ["previsit", "refill", "renewal", "redflag", "handover"] as const;
type Situation = (typeof SITUATIONS)[number];
const DISPOSITIONS: Disposition[] = ["ready", "review", "in_person", "urgent", "excluded"];

interface Line {
  who: "ai" | "patient" | "refusal" | "redflag" | "notice" | "staff";
  t: string;
}

function Exchange({ of }: { of: "previsit" | "redflag" | "handover" }) {
  const { t } = useTranslation("public");
  const ts = useList();
  const lines = ts<Line[]>(`service.${of}.chat`);
  return (
    <div className="situ-chat">
      {lines.map((l, i) => {
        if (l.who === "ai") return <AssistantBubble key={i}>{l.t}</AssistantBubble>;
        if (l.who === "patient") return <PatientBubble key={i}>{l.t}</PatientBubble>;
        if (l.who === "refusal") return <RefusalNote key={i}>{l.t}</RefusalNote>;
        if (l.who === "notice") return <NoticeLine key={i}>{l.t}</NoticeLine>;
        if (l.who === "staff")
          return (
            <StaffBubble key={i} name={t("service.handover.staffName")} title={t("service.handover.staffTitle")}>
              {l.t}
            </StaffBubble>
          );
        return (
          <div key={i} className="hb-warning mt-0!">
            <p>{l.t}</p>
            <p className="mt-2 flex flex-wrap gap-x-6">
              <a href="tel:119">119</a>
              <a href="tel:1925">1925</a>
            </p>
          </div>
        );
      })}
    </div>
  );
}

function ResultTable() {
  const { t } = useTranslation("public");
  const ts = useList();
  const rows = ts<string[][]>("service.renewal.rows");
  return <RuledTable caption={t("service.renewal.table")} head={ts<string[]>("service.renewal.head")} rows={rows.map((r, i) => [<StatusTag key="s" family="disposition" status={DISPOSITIONS[i]} />, r[1], r[2]])} />;
}

/** What her request page shows while the pharmacy has it. */
function RefillStatus() {
  const { t } = useTranslation("public");
  const ts = useList();
  const today = useMemo(() => todayInTaipei(), []);
  const issuedOn = addDays(today, -DEMO_RX.issuedDaysAgo);
  const view = viewOn({ issuedOn, totalDays: DEMO_RX.totalDays, daysPerFill: DEMO_RX.daysPerFill, fills: [issuedOn], pharmacy: t("home.strip.pharmacy") }, today);
  const steps = ts<{ time: string; what: string; who: string; pending?: boolean }[]>("service.refill.steps");
  return (
    <div className="situ-status">
      <RefillStrip med={view.strip} today={today} />
      <Timeline label={t("service.refill.stepsLabel")} items={steps.map((x, i) => ({ id: String(i), ...x }))} className="mt-6" />
    </div>
  );
}

export default function Service() {
  const { t } = useTranslation("public");
  usePageSeo("service");
  const exhibit: Record<Situation, ReactNode> = {
    previsit: <Exchange of="previsit" />,
    refill: <RefillStatus />,
    renewal: <ResultTable />,
    redflag: <Exchange of="redflag" />,
    handover: <Exchange of="handover" />,
  };
  const more: Partial<Record<Situation, { to: string; key: string }>> = {
    renewal: { to: "/trust/medication-renewal", key: "home.renewal.link" },
    redflag: { to: "/trust/clinical-safety", key: "emergency.link" },
    handover: { to: "/trust/human-oversight", key: "clinicians.phase.link" },
  };
  return (
    <>
      <div className="site-wrap">
        <Opening
          title={t("service.title")}
          lede={t("service.lede")}
          aside={
            <nav className="situ-nav" aria-label={t("service.toc")}>
              <ol>
                {SITUATIONS.map((s) => (
                  <li key={s}>
                    <a href={`#${s}`}>
                      <span>{t(`service.${s}.when`)}</span>
                      <span>{t(`service.${s}.title`)}</span>
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          }
        />
      </div>
      <PhotoNote slot="clinic_corridor" ratio="21 / 9" sizes="100vw" priority className="photo-band situ-band" />
      <div className="site-wrap">
        {SITUATIONS.map((s) => (
          <section key={s} id={s} className="situ" aria-labelledby={`${s}-h`}>
            <div className="situ-head">
              <h2 className="pub-h2" id={`${s}-h`}>
                <Phrases text={t(`service.${s}.when`)} />
              </h2>
            </div>
            <div className="situ-body min-w-0">
              <p className="situ-lead">
                <Phrases text={t(`service.${s}.title`)} />
              </p>
              <p>{t(`service.${s}.p1`)}</p>
              <p>{t(`service.${s}.p2`)}</p>
              <div className="situ-exhibit">{exhibit[s]}</div>
              <p className="situ-stop">
                <strong>{t("service.stopsAt")}</strong>
                <span>{t(`service.${s}.stop`)}</span>
              </p>
              {more[s] && (
                <TextLink to={more[s].to} className="mt-4 inline-flex min-h-11 items-center">
                  {t(more[s].key)}
                </TextLink>
              )}
            </div>
          </section>
        ))}
      </div>
      <section className="pub-sheet">
        <div className="site-wrap">
          <SplitRow title={t("service.end.title")}>
            <p className="max-w-[36em] text-md">{t("service.end.body")}</p>
            <p className="mt-2 max-w-[36em] text-fg-2">{t("fiction")}</p>
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
              <ButtonLink to="/try" variant="primary">
                {t("cta.try")}
              </ButtonLink>
              <TextLink to="/clinicians" className="inline-flex min-h-11 items-center">
                {t("cta.clinicians")}
              </TextLink>
            </div>
          </SplitRow>
        </div>
      </section>
    </>
  );
}
