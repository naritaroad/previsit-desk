import { IconChevronRight, IconMessageCircle, IconMessages, IconPill } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { visitsApi } from "@/api/endpoints";
import type { TicketReason, Visit } from "@/api/types";
import { useCreateVisit, useIdempotency, useRxList, useVisits } from "@/data";
import { isSent } from "@/lib/composer";
import { Banner, Button, EmptyState, Field, FieldGroup, PageBody, PageHeader, RadioRows, Sheet, SkeletonRows, StatusTag, Textarea, TextLink } from "@/ui";

import { ActionError, LoadError, StaleNote, useFmt } from "./shared";
import { threadRows, type ThreadRow } from "./threads";

export default function Messages() {
  const { t } = useTranslation("patient");
  const visits = useVisits({ archived: false });
  const rx = useRxList();
  const ready = visits.data !== undefined && rx.data !== undefined;
  const error = (!visits.data && visits.error) || (!rx.data && rx.error);
  const rows = threadRows(visits.items, rx.items);
  return (
    <PageBody>
      <PageHeader title={t("msgs.title")} lede={t("msgs.lede")} actions={<Contact visits={visits.items} />} />
      <StaleNote query={visits} />
      {error ? (
        <LoadError
          error={error}
          onRetry={() => {
            void visits.refetch();
            void rx.refetch();
          }}
          retrying={visits.isFetching || rx.isFetching}
        />
      ) : !ready ? (
        <SkeletonRows rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<IconMessages aria-hidden />} title={t("msgs.none")}>
          {t("msgs.noneBody")}
        </EmptyState>
      ) : (
        <ul className="row-list">
          {rows.map((r) => (
            <Row key={r.key} row={r} />
          ))}
        </ul>
      )}
      <p className="mt-6 text-fg-2">{t("msgs.notUrgent")}</p>
    </PageBody>
  );
}

function Row({ row }: { row: ThreadRow }) {
  const { t } = useTranslation(["patient", "rx"]);
  const f = useFmt();
  const { visit, rx } = row;
  const Icon = visit ? IconMessageCircle : IconPill;
  return (
    <li className="row-item">
      <Link to={row.to} className="row-link" data-unread={row.unread}>
        <Icon size={24} className="flex-none text-ink-text" aria-hidden />
        <span className="row-main">
          <span className="row-title">
            {row.unread && <span className="sr-only">{t("patient:visits.unread")}</span>}
            {visit ? visit.title : rx && `${t(`rx:kind.${rx.kind}`)}${t("patient:common.colon")}${f.list(rx.drug_names)}`}
          </span>
          <span className="row-sub">
            {visit
              ? visit.mode === "human"
                ? t("patient:visits.human", { name: f.person(visit.assigned_to) || t("patient:common.careTeam") })
                : t("patient:msgs.reviewed", { name: f.person(visit.reviewed_by) })
              : rx && (rx.assigned_to ? f.person(rx.assigned_to) : rx.no)}
          </span>
        </span>
        <span className="row-end">
          {visit ? <StatusTag family="visit" status={visit.status} /> : rx && <StatusTag family="rx" status={rx.status} />}
          <time className="num text-sm text-fg-2" dateTime={row.at}>
            {f.relative(row.at)}
          </time>
        </span>
        <IconChevronRight size={20} className="flex-none text-fg-3" aria-hidden />
      </Link>
    </li>
  );
}

const REASONS: readonly TicketReason[] = ["patient_request", "symptom_change", "side_effects", "other"];

/** Ask the clinic to get in touch. The contract only knows hand-overs of a previsit, so one is opened when needed. */
function Contact({ visits }: { visits: Visit[] }) {
  const { t } = useTranslation("patient");
  const qc = useQueryClient();
  const create = useCreateVisit();
  const idem = useIdempotency();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<TicketReason>("patient_request");
  const [note, setNote] = useState("");
  const target = visits.find((v) => v.mode === "human") ?? visits.find((v) => v.status === "active" && !isSent(v));
  const send = useMutation({
    mutationFn: async () => {
      const id = target?.id ?? (await create.mutateAsync({})).visit.id;
      const ticket = await visitsApi.handoff(id, { reason, note: note.trim() }, idem.key([id, reason, note]));
      return { id, ticket };
    },
    onSuccess: () => {
      idem.done();
      setNote("");
      void qc.invalidateQueries({ queryKey: ["visits"] });
    },
  });
  const empty = note.trim() === "";
  const [tried, setTried] = useState(false);
  const submit = () => {
    if (empty) setTried(true);
    else send.mutate();
  };
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          send.reset();
          setTried(false);
        }
      }}
      title={t("msgs.contactTitle")}
      trigger={<Button variant="primary">{t("msgs.contact")}</Button>}
      footer={
        send.data ? (
          <Button block onClick={() => setOpen(false)}>
            {t("common.close")}
          </Button>
        ) : (
          <Button variant="primary" block loading={send.isPending} onClick={submit}>
            {t("msgs.contactSend")}
          </Button>
        )
      }
    >
      {send.data ? (
        <Banner tone="ok" title={t("handoff.done")}>
          <p>{t("handoff.doneBody", { no: send.data.ticket.ticket_no })}</p>
          <p className="mt-2">
            <TextLink to={`/app/visits/${send.data.id}`} onClick={() => setOpen(false)}>
              {t("msgs.openThread")}
            </TextLink>
          </p>
        </Banner>
      ) : (
        <div className="grid gap-5">
          <p>{t("msgs.contactBody")}</p>
          <FieldGroup label={t("msgs.reason")}>
            <RadioRows label={t("msgs.reason")} value={reason} onValueChange={(v) => setReason(v as TicketReason)} options={REASONS.map((r) => ({ value: r, label: t(`msgs.reason_${r}`) }))} />
          </FieldGroup>
          <Field label={t("msgs.note")} hint={t("msgs.noteHint")} error={tried && empty ? t("msgs.noteNeeded") : undefined}>
            <Textarea rows={4} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <p className="text-sm text-fg-2">{t("msgs.notUrgent")}</p>
          <ActionError error={send.error} title={t("msgs.contactFailed")} onRetry={submit} />
        </div>
      )}
    </Sheet>
  );
}
