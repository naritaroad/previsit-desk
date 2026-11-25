import { useTranslation } from "react-i18next";
import { useParams } from "react-router";

import { usePatient, useToday } from "@/data";
import { formatDate } from "@/lib/format";
import { paths } from "@/lib/links";
import { Callout, DataTable, EmptyState, PageBody, PageHeader, Panel, RefillStrip, Section, SkeletonRows, StatusTag, useLocale } from "@/ui";

import { AllergyBlock, usePatientFacts } from "./dispense/PatientPanel";
import { drugName } from "./shared/names";
import { LoadProblem } from "./shared/problem";

/** What a pharmacist may see of a patient: medicines, allergies, requests. The server leaves the rest out. */
export default function Patient() {
  const { t } = useTranslation("pharmacy");
  const { t: tr } = useTranslation("rx");
  const locale = useLocale();
  const today = useToday();
  const { id = "" } = useParams();
  const patient = usePatient(id);
  const facts = usePatientFacts(patient.data, []);
  const back = { to: "/pharmacy", label: t("queue.allOpen") };
  const d = patient.data;
  if (patient.isError && !d)
    return (
      <PageBody>
        <PageHeader back={back} title={t("patient.title")} />
        <LoadProblem error={patient.error} onRetry={() => void patient.refetch()} />
      </PageBody>
    );
  if (!d)
    return (
      <PageBody>
        <PageHeader back={back} title={t("patient.title")} />
        <SkeletonRows rows={6} />
      </PageBody>
    );
  return (
    <PageBody>
      <PageHeader back={back} title={d.row.patient.display_name} meta={facts.ageSex ? <span className="text-base">{facts.ageSex}</span> : undefined} />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(18rem,1fr)]">
        <div className="min-w-0">
          <Section title={t("patient.meds")}>
            {d.medications.length === 0 ? (
              <Panel>
                <p className="text-fg-2">{t("patient.noMeds")}</p>
              </Panel>
            ) : (
              <div className="grid gap-4">
                {d.medications.map((m) => (
                  <Panel key={m.prescription_id} title={drugName(m.drug, locale)} meta={<StatusTag family={m.source === "clinic" ? "med" : "source"} status={m.source === "clinic" ? m.state : m.source} />} as="article">
                    <p className="mb-3">{m.dose_text}</p>
                    {m.source === "clinic" ? <RefillStrip med={m} today={today} /> : <p className="text-sm text-fg-2">{t("patient.selfReportedNote")}</p>}
                    {m.fills.length > 0 && (
                      <p className="mt-3 text-sm text-fg-2">{m.fills.map((f) => t("patient.fill", { n: f.n, date: formatDate(f.filled_on, locale, "short"), pharmacy: f.pharmacy_name })).join(t("sentenceGap"))}</p>
                    )}
                  </Panel>
                ))}
              </div>
            )}
          </Section>
          <Section title={t("patient.requests")}>
            <Panel flush>
              <DataTable
                caption={t("patient.requests")}
                rows={d.rx}
                rowKey={(r) => r.id}
                rowLink={(r) => paths.pharmacy.rx(r.id)}
                empty={<EmptyState title={t("patient.noRequests")} />}
                columns={[
                  { id: "n", header: t("queue.no"), cell: (r) => <span className="num font-semibold">{r.no}</span>, card: "title", nowrap: true, width: "12.5rem" },
                  { id: "d", header: t("queue.drugs"), cell: (r) => r.drug_names.join(t("listSep")) },
                  { id: "k", header: t("queue.kind"), cell: (r) => tr(`kind.${r.kind}`), width: "7rem", hideBelow: "md" },
                  { id: "s", header: t("queue.stage"), cell: (r) => <StatusTag family="rx" status={r.status} />, card: "end", width: "9rem" },
                ]}
              />
            </Panel>
          </Section>
        </div>
        <div className="grid gap-5">
          <AllergyBlock allergies={facts.allergies} />
          <Callout tone="info" title={t("patient.limitTitle")}>
            {t("patient.limitBody")}
          </Callout>
        </div>
      </div>
    </PageBody>
  );
}
