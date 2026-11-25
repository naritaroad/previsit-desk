import { IconPrinter } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";

import type { VisitDetail } from "@/api/types";
import { useVisitDetail } from "@/data";
import { isSent } from "@/lib/composer";
import { summaryRows } from "@/lib/intake";
import { Banner, Button, ButtonLink, Callout, EmptyState, FormSheet, PageBody, PageHeader, Section, StatusTag } from "@/ui";

import { Gate, useFmt } from "./shared";
import { DoctorNote } from "./visit/DoctorNote";
import { fieldKey } from "./visit/SummaryFields";
import { RefillNote } from "./visit/TurnRecord";

export default function VisitSummary() {
  const { id = "" } = useParams();
  const query = useVisitDetail(id);
  return (
    <PageBody width="read">
      <Gate query={query} rows={8}>
        {(d) => <Sheet detail={d} />}
      </Gate>
    </PageBody>
  );
}

/** The same sheet the doctor opens: what was said, where it came from, what is missing. */
function Sheet({ detail }: { detail: VisitDetail }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const { visit, summary: s, note } = detail;
  const sent = isSent(visit);
  return (
    <>
      <PageHeader
        title={t("summary.title")}
        lede={t("summary.lede")}
        back={{ to: `/app/visits/${visit.id}`, label: t("summary.back") }}
        meta={<StatusTag family="visit" status={visit.status} />}
        actions={
          <Button className="no-print" icon={<IconPrinter aria-hidden />} onClick={() => print()}>
            {t("summary.print")}
          </Button>
        }
      />
      <DoctorNote note={note} visit={visit} className="mb-8" />
      {!s ? (
        <EmptyState title={t("summary.none")} action={sent ? undefined : <ButtonLink to={`/app/visits/${visit.id}`}>{t("home.resume")}</ButtonLink>}>
          {t("summary.noneBody")}
        </EmptyState>
      ) : (
        <>
          {!sent && (
            <Banner tone="info" className="mb-stack no-print" actions={<ButtonLink to={`/app/visits/${visit.id}?step=review`}>{t("visit.finish")}</ButtonLink>}>
              {t("summary.notSent")}
            </Banner>
          )}
          {s.red_flag_screen.triggered.length > 0 && (
            <Callout tone="danger" className="mb-stack" title={t("sum.redFlag")}>
              {f.list(s.red_flag_screen.triggered.map((x) => x.label))}
            </Callout>
          )}
          <FormSheet
            title={visit.title}
            note={visit.submitted_at ? t("summary.sentAt", { date: f.dateTime(visit.submitted_at) }) : t("summary.draft")}
            items={[
              { label: t("summary.patient"), value: visit.patient.display_name },
              ...(visit.appointment ? [{ label: t("summary.appt"), value: t("visit.forAppt", { date: f.dateTime(visit.appointment.starts_at), doctor: f.person(visit.appointment.physician) }) }] : []),
              ...summaryRows(s, t("common.listSep")).map((r) => ({
                label: t(fieldKey(r.key)),
                value: r.status === "filled" ? r.value : <span className="text-fg-3">{t(r.status === "none" ? "sum.none" : r.status === "na" ? "sum.na" : "sum.missing")}</span>,
              })),
              ...(s.patient_questions.length
                ? [
                    {
                      label: t("field.patient_questions"),
                      value: (
                        <ul>
                          {s.patient_questions.map((q) => (
                            <li key={q}>{q}</li>
                          ))}
                        </ul>
                      ),
                    },
                  ]
                : []),
              { label: t("summary.redFlagScreen"), value: s.red_flag_screen.note || t("summary.redFlagNone") },
            ]}
          />
          {s.narrative && (
            <Section title={t("summary.narrative")}>
              <p className="max-w-[40em] whitespace-pre-wrap">{s.narrative}</p>
            </Section>
          )}
          {s.refill && (
            <Section title={t("summary.refill")}>
              <RefillNote result={s.refill} />
            </Section>
          )}
          <p className="mt-6 text-sm text-fg-2">
            {t(s.generated_by.kind === "model" ? "summary.byModel" : "summary.byCode", { date: f.dateTime(s.generated_by.at), model: s.generated_by.model ?? "" })}
            {s.edited_by_patient && ` ${t("summary.edited")}`}
          </p>
          <p className="text-sm text-fg-2">{s.disclaimer}</p>
          <p className="text-sm text-fg-2">{t("visit.fictional")}</p>
        </>
      )}
    </>
  );
}
