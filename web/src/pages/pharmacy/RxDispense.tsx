import { useTranslation } from "react-i18next";
import { useLocation, useParams } from "react-router";

import type { RxRequest } from "@/api/types";
import { usePatient, useRx, useToday } from "@/data";
import { formatDate, formatDateTime, PICKUP_HOURS } from "@/lib/format";
import { isOpenRx } from "@/lib/rx";
import { PHARMACY_STAGES } from "@/shells/PharmacyShell";
import { Badge, Callout, PageBody, PageHeader, SkeletonRows, StatusTag, useLocale } from "@/ui";

import { Desk } from "./dispense/Desk";
import { Checked, dispensable, ItemFacts, leftOut, NotDispensed } from "./dispense/Facts";
import { PatientPanel, usePatientFacts } from "./dispense/PatientPanel";
import { PrintMenu } from "./dispense/Print";
import { History, Messages } from "./dispense/Thread";
import { LoadProblem } from "./shared/problem";
import { personName } from "./shared/names";

export default function RxDispense() {
  const { t } = useTranslation("pharmacy");
  const { t: ts } = useTranslation("shell");
  const { id = "" } = useParams();
  const rx = useRx(id);
  const { state } = useLocation() as { state: { stage?: string | null } | null };
  const stage = PHARMACY_STAGES.find((s) => s === state?.stage) ?? null;
  const back = { to: stage ? `/pharmacy/queue/${stage}` : "/pharmacy", label: stage ? ts(`pharmacy.stage.${stage}`) : t("queue.allOpen") };

  if (rx.isError && !rx.data)
    return (
      <PageBody>
        <PageHeader back={back} title={t("dispense.title")} />
        <LoadProblem error={rx.error} onRetry={() => void rx.refetch()} />
      </PageBody>
    );
  if (!rx.data)
    return (
      <PageBody>
        <PageHeader back={back} title={t("dispense.title")} />
        <SkeletonRows rows={8} />
      </PageBody>
    );
  return <Loaded key={id} rx={rx.data} back={back} stage={stage} />;
}

function Loaded({ rx, back, stage }: { rx: RxRequest; back: { to: string; label: string }; stage: string | null }) {
  const { t } = useTranslation("pharmacy");
  const { t: tr } = useTranslation("rx");
  const locale = useLocale();
  const today = useToday();
  const patient = usePatient(rx.patient.id);
  const items = dispensable(rx);
  const facts = usePatientFacts(patient.data, items);
  const cards = patient.data?.medications ?? [];
  const w = rx.pickup_window;
  const decided = items.find((i) => i.decision)?.decision;
  return (
    <PageBody>
      <PageHeader
        back={back}
        title={rx.no}
        meta={
          <>
            <StatusTag family="rx" status={rx.status} />
            <Badge tone={rx.kind === "refill" ? "ink" : "info"}>{tr(`kind.${rx.kind}`)}</Badge>
            {rx.priority !== "routine" && <StatusTag family="urgency" status={rx.priority} />}
            <span>{w ? t("dispense.pickup", { when: `${formatDate(w.date, locale, "medium")} ${tr(`pickupSlot.${w.slot}`)}`, hours: PICKUP_HOURS[w.slot].join(t("print.to")) }) : t("dispense.noPickup")}</span>
            {rx.pharmacy && <span>{rx.pharmacy.name}</span>}
            <span>{rx.assigned_to ? t("dispense.handledBy", { name: personName(rx.assigned_to) }) : t("dispense.unhandled")}</span>
          </>
        }
        actions={<PrintMenu rx={rx} cards={cards} ageSex={facts.ageSex} today={today} />}
      />
      <Callout tone="info" className="mb-5" title={t("origin.title")}>
        {rx.kind === "refill"
          ? t("origin.refill")
          : decided
            ? t("origin.renewal", { name: personName(decided.by), at: formatDateTime(decided.at, locale) })
            : t("origin.undecided")}
      </Callout>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(19rem,1fr)] lg:grid-rows-[auto_1fr]">
        <div className="grid min-w-0 content-start gap-5">
          {items.map((i) => (
            <ItemFacts key={i.id} rx={rx} item={i} card={cards.find((c) => c.prescription_id === i.prescription_id)} today={today} />
          ))}
          <NotDispensed items={leftOut(rx)} />
        </div>
        <div className="grid min-w-0 content-start gap-5 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <PatientPanel patientId={rx.patient.id} name={rx.patient.display_name} detail={patient.data} facts={facts} error={patient.isError ? patient.error : null} onRetry={() => void patient.refetch()} />
          <Desk rx={rx} cards={cards} facts={facts} stage={stage} />
          <History rx={rx} />
        </div>
        <div className="grid min-w-0 content-start gap-5">
          <Checked rx={rx} />
          <Messages rx={rx} />
        </div>
      </div>
      {!isOpenRx(rx.status) && <p className="mt-4 text-sm text-fg-2">{t("dispense.closed")}</p>}
    </PageBody>
  );
}
