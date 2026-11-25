import { IconCalendar, IconCalendarPlus } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";

import type { Appointment } from "@/api/types";
import { useAppointments, useCancelAppointment, useToday, useVisits } from "@/data";
import { formatRelativeDay, taipeiDate } from "@/lib/format";
import { Banner, Button, ButtonLink, Callout, ConfirmDialog, EmptyState, PageBody, PageHeader, Section, SkeletonRows, StatusTag, TextLink, toast } from "@/ui";

import { ActionError, LoadError, StaleNote, useFmt } from "./shared";

export default function Appointments() {
  const { t } = useTranslation("patient");
  const [params] = useSearchParams();
  const list = useAppointments();
  const visits = useVisits({ archived: false });
  const now = new Date().toISOString();
  const open = (a: Appointment) => (a.status === "booked" || a.status === "checked_in") && a.starts_at > new Date(Date.now() - 3_600_000).toISOString();
  const upcoming = list.items.filter(open).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const past = list.items.filter((a) => !open(a));
  return (
    <PageBody>
      <PageHeader
        title={t("appt.title")}
        lede={t("appt.lede")}
        actions={
          <ButtonLink to="/app/appointments/book" variant="primary" icon={<IconCalendarPlus aria-hidden />}>
            {t("appt.book")}
          </ButtonLink>
        }
      />
      {params.get("booked") && (
        <Banner tone="ok" className="mb-stack" title={t(params.get("moved") ? "appt.movedDone" : "appt.bookedDone")}>
          {t("appt.bookedBody")}
        </Banner>
      )}
      {params.get("keptOld") && (
        <Banner tone="warn" className="mb-stack" role="alert" title={t("appt.keptOldTitle")}>
          {t("appt.keptOldBody")}
        </Banner>
      )}
      <StaleNote query={list} />
      {list.error && !list.data ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : !list.data ? (
        <SkeletonRows rows={4} />
      ) : (
        <>
          <Section title={t("appt.upcoming")}>
            {upcoming.length === 0 ? (
              <EmptyState icon={<IconCalendar aria-hidden />} title={t("home.noNext")} action={<ButtonLink to="/app/appointments/book">{t("appt.book")}</ButtonLink>}>
                {t("home.noNextBody")}
              </EmptyState>
            ) : (
              <ul>
                {upcoming.map((a) => (
                  <Upcoming key={a.id} appointment={a} visit={visits.items.find((v) => v.appointment?.id === a.id || v.id === a.visit_id)} now={now} />
                ))}
              </ul>
            )}
          </Section>
          {past.length > 0 && (
            <Section title={t("appt.past")}>
              <ul>
                {past.map((a) => (
                  <li key={a.id} className="appt">
                    <When at={a.starts_at} />
                    <Where appointment={a} />
                    <div className="flex flex-wrap items-center gap-3">
                      <StatusTag family="appointment" status={a.status} />
                      {a.visit_id && <TextLink to={`/app/visits/${a.visit_id}/summary`}>{t("home.seeSummary")}</TextLink>}
                    </div>
                  </li>
                ))}
              </ul>
              {list.hasNextPage && (
                <div className="mt-4">
                  <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
                    {t("common.more")}
                  </Button>
                </div>
              )}
            </Section>
          )}
        </>
      )}
    </PageBody>
  );
}

function When({ at }: { at: string }) {
  const f = useFmt();
  return (
    <div className="when">
      <b>{f.date(at, "medium")}</b>
      <span>{f.time(at)}</span>
    </div>
  );
}

function Where({ appointment: a }: { appointment: Appointment }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  return (
    <div className="min-w-0">
      <p className="font-semibold">{a.department}</p>
      <p>{[f.person(a.physician), t(a.mode === "video" ? "appt.video" : "appt.inPerson"), a.mode === "video" ? null : a.room, t("appt.minutes", { count: a.minutes })].filter(Boolean).join(t("common.sep"))}</p>
      {a.reason && <p className="text-fg-2">{t("appt.reasonLine", { reason: a.reason })}</p>}
    </div>
  );
}

function Upcoming({ appointment: a, visit, now }: { appointment: Appointment; visit?: { id: string; submitted_at: string | null }; now: string }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const today = useToday();
  const cancel = useCancelAppointment();
  const [asking, setAsking] = useState(false);
  const day = taipeiDate(a.starts_at);
  const sent = Boolean(visit?.submitted_at);
  const started = a.starts_at <= now;
  return (
    <li className="appt">
      <When at={a.starts_at} />
      <div className="min-w-0">
        <p className="num text-sm text-fg-2">{formatRelativeDay(day, f.locale, today)}</p>
        <Where appointment={a} />
        <p className="mt-1">{t(sent ? "home.previsitSent" : visit ? "home.previsitProgress" : "home.previsitTodo")}</p>
        {day === today && a.status === "booked" && (
          <Callout tone="info" className="mt-3" title={t("appt.todayTitle")}>
            {t(a.mode === "video" ? "appt.todayVideo" : "appt.todayBody")}
          </Callout>
        )}
        {a.status === "checked_in" && <p className="mt-1">{t("home.checkedIn")}</p>}
        <ActionError error={cancel.error} className="mt-3" title={t("appt.cancelFailed")} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <StatusTag family="appointment" status={a.status} />
        {sent && visit ? (
          <ButtonLink to={`/app/visits/${visit.id}/summary`}>{t("home.seeSummary")}</ButtonLink>
        ) : (
          <ButtonLink to={visit ? `/app/visits/${visit.id}` : `/app/visits/new?appointment=${a.id}`} variant="soft">
            {t(visit ? "home.resume" : "home.startPrevisit")}
          </ButtonLink>
        )}
        {a.status === "booked" && !started && (
          <>
            <ButtonLink to={`/app/appointments/book?reschedule=${a.id}`}>{t("appt.reschedule")}</ButtonLink>
            <ConfirmDialog
              open={asking}
              onOpenChange={setAsking}
              trigger={<Button variant="destructive">{t("appt.cancel")}</Button>}
              title={t("appt.cancelTitle", { date: f.dateTime(a.starts_at), department: a.department })}
              description={t(visit ? "appt.cancelBodyVisit" : "appt.cancelBody")}
              confirmLabel={t("appt.cancelDo")}
              cancelLabel={t("appt.cancelKeep")}
              destructive
              busy={cancel.isPending}
              onConfirm={() => cancel.mutate(a.id, { onSuccess: () => toast.ok(t("appt.cancelled")) })}
            />
          </>
        )}
      </div>
    </li>
  );
}
