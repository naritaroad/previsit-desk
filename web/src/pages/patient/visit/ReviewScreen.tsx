import { IconSend } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import type { VisitStreamHandle } from "@/data";
import { useSubmitVisit } from "@/data";
import { EMPTY_INTAKE } from "@/lib/intake";
import { Banner, Button, Callout, PageBody, PageHeader, Section } from "@/ui";

import { ActionError, useFmt } from "../shared";
import { fieldKey, IntakeFields, SummaryFields } from "./SummaryFields";

/** One last look before the doctor gets it: every field, what was not asked, and what happens next. */
export function ReviewScreen({ state, unsent, onBack, onDone }: { state: VisitStreamHandle; unsent: number; onBack: () => void; onDone: () => void }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const visit = state.visit!;
  const submit = useSubmitVisit(visit.id);
  const summary = state.summary;
  const running = state.run.phase === "running";
  const doctor = visit.appointment ? f.person(visit.appointment.physician) : "";
  return (
    <div className="scroll-y min-h-0 flex-1">
      <PageBody width="read" className="pb-0">
        <PageHeader title={t("review.title")} lede={t("review.lede")} />
        {!summary && (
          <Callout tone="info" className="mb-stack" title={t("review.noSummary")}>
            {t("review.noSummaryBody")}
          </Callout>
        )}
        {state.redFlag && (
          <Callout tone="danger" className="mb-stack" title={t("review.redFlag")}>
            {t("review.redFlagBody")}
          </Callout>
        )}
        <Section title={t("review.fields")}>
          {summary ? <SummaryFields visitId={visit.id} summary={summary} editable /> : <IntakeFields state={(state.intake ?? EMPTY_INTAKE).state} />}
        </Section>
        {summary && summary.not_collected.length > 0 && (
          <Section title={t("review.notAsked")}>
            <p>{f.list(summary.not_collected.map((k) => t(fieldKey(k), { defaultValue: k })))}</p>
            <p className="text-sm text-fg-2">{t("review.notAskedBody")}</p>
          </Section>
        )}
        <Section title={t("review.nextTitle")}>
          <ul className="grid gap-2">
            <li>{visit.appointment ? t("review.next1Appt", { doctor, date: f.dateTime(visit.appointment.starts_at) }) : t("review.next1")}</li>
            <li>{t("review.next2")}</li>
            <li>{t("review.next3")}</li>
          </ul>
        </Section>
        <div className="mt-6 grid gap-3">
          {unsent > 0 && <Banner tone="warn">{t("review.unsent", { count: unsent })}</Banner>}
          {running && <Banner tone="info">{t("review.running")}</Banner>}
          <ActionError error={submit.error} title={t("review.failed")} onRetry={() => submit.mutate(undefined, { onSuccess: onDone })} />
        </div>
        <div className="step-form-foot mt-6">
          <Button onClick={onBack}>{t("review.back")}</Button>
          <span className="ms-auto" />
          <Button variant="primary" icon={<IconSend aria-hidden />} loading={submit.isPending} disabled={unsent > 0 || running} onClick={() => submit.mutate(undefined, { onSuccess: onDone })}>
            {t("review.submit")}
          </Button>
        </div>
      </PageBody>
    </div>
  );
}
