import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useTrustFacts } from "@/data";
import { Button, ButtonLink, Checkbox, DocLayout, EvidenceLine, EvidenceList, FormSheet, Ledger, Phrases, RuledTable, TableOfContents, TextLink, WorkspaceContext, type DetailItem } from "@/ui";

import { useResumed } from "./lib/live";
import { usePageSeo } from "./lib/seo";
import { Opening, PhotoNote, useList } from "./parts/common";

const SECTIONS = ["desk", "queue", "renewal", "phase", "coordinator", "pharmacy", "log", "missing"] as const;

interface DeskLine {
  at: string;
  t: string;
  q: string;
}

/** A piece of the review desk in the clinic's ink. The times work; assessment and plan are blank on purpose. */
function DeskFigure() {
  const { t } = useTranslation("public");
  const ts = useList();
  const [open, setOpen] = useState<number | null>(null);
  const lines = ts<DeskLine[]>("clinicians.desk.lines");
  return (
    <figure className="m-0">
      <WorkspaceContext value={{ ws: "clinic", density: "compact" }}>
        <div className="figure-frame" data-ws="clinic" data-density="compact">
          <div className="desk-fig">
            <div>
              <h4>{t("clinicians.desk.sTitle")}</h4>
              <EvidenceList label={t("clinicians.desk.sTitle")}>
                {lines.map((l, i) => (
                  <EvidenceLine key={l.at} at={l.at} onJump={() => setOpen(i)}>
                    {l.t}
                  </EvidenceLine>
                ))}
                <EvidenceLine missing>{t("clinicians.desk.missing")}</EvidenceLine>
              </EvidenceList>
              <div className="desk-quote" data-open={open !== null} aria-live="polite">
                {open === null ? (
                  t("clinicians.desk.pick")
                ) : (
                  <>
                    <strong className="num">
                      {t("clinicians.desk.jumped")} {lines[open].at}
                    </strong>
                    {lines[open].q}
                  </>
                )}
              </div>
              <h4 className="mt-5">{t("clinicians.desk.oTitle")}</h4>
              <Ledger items={ts<{ label: string; value: string; unit: string }[]>("clinicians.desk.o")} />
            </div>
            <div className="desk-ap">
              <div>
                <h4>{t("clinicians.desk.apTitle")}</h4>
                <p className="text-sm text-fg-2">{t("clinicians.desk.author")}</p>
              </div>
              <dl className="grid gap-4">
                {(["a", "p"] as const).map((k) => (
                  <div key={k}>
                    <dt>
                      <span aria-hidden="true">{k.toUpperCase()}</span>
                      {t(`clinicians.desk.${k}`)}
                    </dt>
                    <dd>{t("clinicians.desk.blank")}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>
      </WorkspaceContext>
      <figcaption className="figure-cap">{t("clinicians.desk.figure")}</figcaption>
    </figure>
  );
}

function DispenseFigure() {
  const { t } = useTranslation("public");
  const ts = useList();
  const checks = ts<{ id: string; label: string; hint: string }[]>("clinicians.pharmacy.checks");
  const [ok, setOk] = useState<Record<string, boolean>>({ identity: true, allergy: true, interaction: true });
  const left = checks.filter((c) => !ok[c.id]).length;
  return (
    <figure className="m-0">
      <WorkspaceContext value={{ ws: "pharmacy", density: "compact" }}>
        <div className="figure-frame" data-ws="pharmacy" data-density="compact">
          <div className="rx-fig">
            <FormSheet title={t("clinicians.pharmacy.sheet")} note={t("clinicians.pharmacy.no")} items={ts<DetailItem[]>("clinicians.pharmacy.items")} />
            <div role="group" aria-label={t("clinicians.pharmacy.checkTitle")}>
              <h4 className="text-ink-text mb-1 font-bold">{t("clinicians.pharmacy.checkTitle")}</h4>
              {checks.map((c) => (
                <Checkbox key={c.id} label={c.label} hint={c.hint} checked={ok[c.id] ?? false} onCheckedChange={(v) => setOk({ ...ok, [c.id]: v === true })} />
              ))}
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button variant="primary" disabled={left > 0}>
                  {t("clinicians.pharmacy.dispense")}
                </Button>
                <span className="text-sm text-fg-2" role="status">
                  {left > 0 ? t("clinicians.pharmacy.left", { count: left }) : t("clinicians.pharmacy.done")}
                </span>
              </div>
            </div>
          </div>
        </div>
      </WorkspaceContext>
      <figcaption className="figure-cap">{t("clinicians.pharmacy.figure")}</figcaption>
    </figure>
  );
}

export default function Clinicians() {
  const { t } = useTranslation("public");
  const ts = useList();
  const facts = useResumed(useTrustFacts());
  usePageSeo("clinicians");
  const h = (k: (typeof SECTIONS)[number]) => (
    <h2 className="pub-h2">
      <Phrases text={t(`clinicians.${k}.title`)} />
    </h2>
  );
  return (
    <div className="site-wrap">
      <Opening title={t("clinicians.title")} lede={t("clinicians.lede")} aside={<PhotoNote slot="doctor_desk" ratio="16 / 9" priority sizes="(min-width: 64rem) 42vw, 100vw" />} />
      <DocLayout className="clin-doc" toc={<TableOfContents items={SECTIONS.map((id) => ({ id, title: t(`clinicians.toc.${id}`) }))} />}>
        <section id="desk" className="clin-sec">
          {h("desk")}
          <div className="pub-prose">
            <p>{t("clinicians.desk.p1")}</p>
            <p>{t("clinicians.desk.p2")}</p>
          </div>
          <DeskFigure />
        </section>
        <section id="queue" className="clin-sec">
          {h("queue")}
          <div className="pub-prose">
            <p>{t("clinicians.queue.p1")}</p>
          </div>
          <RuledTable caption={t("clinicians.queue.caption")} head={ts<string[]>("clinicians.queue.head")} rows={ts<string[][]>("clinicians.queue.rows")} />
        </section>
        <section id="renewal" className="clin-sec">
          {h("renewal")}
          <div className="pub-prose">
            <p>{t("clinicians.renewal.p1")}</p>
            <p>{t("clinicians.renewal.p2")}</p>
          </div>
        </section>
        <section id="phase" className="clin-sec">
          {h("phase")}
          <div className="pub-prose">
            <p>{t("clinicians.phase.p1", { phase: facts.data?.oversight_phase ?? 1 })}</p>
            <p>{t("clinicians.phase.p2")}</p>
            <p>
              <TextLink to="/trust/human-oversight">{t("clinicians.phase.link")}</TextLink>
            </p>
          </div>
        </section>
        <section id="coordinator" className="clin-sec">
          {h("coordinator")}
          <div className="pub-prose">
            <p>{t("clinicians.coordinator.p1")}</p>
          </div>
        </section>
        <section id="pharmacy" className="clin-sec">
          {h("pharmacy")}
          <div className="pub-prose">
            <p>{t("clinicians.pharmacy.p1")}</p>
            <p>{t("clinicians.pharmacy.p2")}</p>
          </div>
          <DispenseFigure />
        </section>
        <section id="log" className="clin-sec">
          {h("log")}
          <div className="pub-prose">
            <p>{t("clinicians.log.p1")}</p>
          </div>
        </section>
        <section id="missing" className="clin-sec">
          {h("missing")}
          <ul className="pub-list max-w-[40em]">
            {ts<string[]>("clinicians.missing.items").map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </section>
        <section className="clin-sec">
          <h2 className="pub-h2">{t("clinicians.enter.title")}</h2>
          <div className="pub-prose">
            <p>{t("clinicians.enter.p1")}</p>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
            <ButtonLink to="/login" variant="primary">
              {t("cta.login")}
            </ButtonLink>
            <TextLink to="/try" className="inline-flex min-h-11 items-center">
              {t("cta.try")}
            </TextLink>
          </div>
        </section>
      </DocLayout>
    </div>
  );
}
