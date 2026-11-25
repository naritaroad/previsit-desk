import { IconCalendarPlus, IconChevronRight, IconMessages, IconPill } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { Appointment, HomeTask, MedicationCard, PatientHome, RxRequestBrief, Visit } from "@/api/types";
import { useMe, usePatientHome, useToday } from "@/data";
import { taipeiDate, TIME_ZONE } from "@/lib/format";
import { isInternalLink } from "@/lib/links";
import { Banner, ButtonLink, DataTable, EmptyState, PageBody, PageHeader, Panel, RefillStrip, Section, Skeleton, SkeletonRows, StatusTag, TextLink } from "@/ui";

import { MedActions } from "./MedActions";
import { needsAttention, sortMeds } from "./med-actions";
import { DrugName, Gate, useFmt } from "./shared";

export default function Home() {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const me = useMe();
  const today = useToday();
  const home = usePatientHome();
  return (
    <PageBody>
      <PageHeader title={t("home.hello", { name: me?.display_name ?? "" })} lede={t("home.today", { date: f.date(today, "full") })} />
      <Gate query={home} skeleton={<HomeSkeleton />}>
        {(data) => <HomeContent data={data} today={today} />}
      </Gate>
    </PageBody>
  );
}

function HomeSkeleton() {
  return (
    <>
      <Skeleton className="h-32" />
      <div className="mt-10">
        <SkeletonRows rows={4} />
      </div>
    </>
  );
}

/** Task kinds already shown by another block of this page. */
const SHOWN_ELSEWHERE = new Set(["previsit", "refill", "renewal"]);

function HomeContent({ data, today }: { data: PatientHome; today: string }) {
  const { t } = useTranslation("patient");
  const next = data.next_appointment;
  const forNext = next ? data.active_visits.find((v) => v.appointment?.id === next.id || v.id === next.visit_id) : undefined;
  const others = data.active_visits.filter((v) => v !== forNext);
  const urgent = data.tasks.filter((x) => x.kind === "red_flag");
  const tasks = data.tasks.filter((x) => !SHOWN_ELSEWHERE.has(x.kind) && x.kind !== "red_flag");
  const meds = sortMeds(data.medications.filter((m) => m.source === "clinic"));
  const due = meds.filter(needsAttention);
  const shown = (due.length ? due : meds.slice(0, 1)).slice(0, 2);
  const rest = meds.filter((m) => !shown.includes(m));
  const empty = !next && !data.active_visits.length && !data.medications.length && !data.active_requests.length;
  return (
    <>
      {urgent.map((x) => (
        <Banner key={x.link} tone="danger" className="mb-stack" role="alert" title={x.title} actions={isInternalLink(x.link) ? <ButtonLink to={x.link}>{t("home.openVisit")}</ButtonLink> : undefined} />
      ))}
      {next ? <NextVisit appointment={next} visit={forNext} /> : <NoNext />}
      {tasks.length > 0 && <Tasks tasks={tasks} />}
      {others.length > 0 && <Resume visits={others} />}
      <Section title={t("home.medsTitle")} actions={meds.length > 0 ? <TextLink to="/app/medications">{t("home.medsAll")}</TextLink> : undefined}>
        {meds.length === 0 ? (
          <EmptyState icon={<IconPill aria-hidden />} title={t("home.medsNone")}>
            {t("home.medsNoneBody")}
          </EmptyState>
        ) : (
          <>
            <div className="grid gap-4">
              {shown.map((m) => (
                <MedPanel key={m.prescription_id} med={m} today={today} request={data.active_requests.find((r) => r.id === m.open_request_id)} />
              ))}
            </div>
            {rest.length > 0 && (
              <ul className="row-list mt-4">
                {rest.map((m) => (
                  <MedRow key={m.prescription_id} med={m} today={today} />
                ))}
              </ul>
            )}
          </>
        )}
      </Section>
      {data.active_requests.length > 0 && <Requests items={data.active_requests} />}
      <Section title={t("home.contactTitle")}>
        <ul className="row-list">
          <li className="row-item">
            <Link to="/app/messages" className="row-link" data-unread={data.unread > 0}>
              <IconMessages size={24} className="flex-none text-ink-text" aria-hidden />
              <span className="row-main">
                <span className="row-title">{t("home.messages")}</span>
                <span className="row-sub">{data.unread > 0 ? t("home.unread", { count: data.unread }) : t("home.noUnread")}</span>
              </span>
              <IconChevronRight size={20} className="flex-none text-fg-3" aria-hidden />
            </Link>
          </li>
        </ul>
      </Section>
      {empty && <p className="mt-6 text-fg-2">{t("home.emptyNote")}</p>}
    </>
  );
}

function NextVisit({ appointment: a, visit }: { appointment: Appointment; visit: Visit | undefined }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const day = taipeiDate(a.starts_at);
  const weekday = new Intl.DateTimeFormat(f.locale, { weekday: "short", timeZone: TIME_ZONE }).format(new Date(a.starts_at));
  const sent = Boolean(visit?.submitted_at) || (!visit && a.visit_id !== null);
  return (
    <section className="next-visit" aria-label={t("home.nextLabel")}>
      <div className="date num" aria-hidden="true">
        <span>{t("home.month", { month: Number(day.slice(5, 7)) })}</span>
        <b>{Number(day.slice(8))}</b>
        <span>{weekday}</span>
      </div>
      <div className="min-w-0">
        <h2 className="num text-xl font-bold">
          <span className="sr-only">{f.date(a.starts_at, "full")} </span>
          {f.time(a.starts_at)} {a.department}
        </h2>
        <p>{[f.person(a.physician), a.mode === "video" ? t("appt.video") : a.room].filter(Boolean).join(t("common.sep"))}</p>
        <p className="text-fg-2">
          {a.status === "checked_in" ? t("home.checkedIn") : visit ? t("home.previsitProgress") : sent ? t("home.previsitSent") : t("home.previsitTodo")}
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        {visit ? (
          <ButtonLink to={`/app/visits/${visit.id}`} variant="primary">
            {t("home.resume")}
          </ButtonLink>
        ) : sent && a.visit_id ? (
          <ButtonLink to={`/app/visits/${a.visit_id}/summary`}>{t("home.seeSummary")}</ButtonLink>
        ) : (
          <ButtonLink to={`/app/visits/new?appointment=${a.id}`} variant="primary">
            {t("home.startPrevisit")}
          </ButtonLink>
        )}
        <ButtonLink to="/app/appointments">{t("home.changeAppt")}</ButtonLink>
      </div>
    </section>
  );
}

function NoNext() {
  const { t } = useTranslation("patient");
  return (
    <section className="no-next" aria-label={t("home.nextLabel")}>
      <div className="min-w-0">
        <h2 className="text-lg font-bold">{t("home.noNext")}</h2>
        <p className="text-fg-2">{t("home.noNextBody")}</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <ButtonLink to="/app/appointments/book" variant="primary" icon={<IconCalendarPlus aria-hidden />}>
          {t("home.book")}
        </ButtonLink>
        <ButtonLink to="/app/visits/new">{t("home.startPrevisit")}</ButtonLink>
      </div>
    </section>
  );
}

function Tasks({ tasks }: { tasks: HomeTask[] }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  return (
    <Section title={t("home.tasksTitle")}>
      <ul className="row-list">
        {tasks.map((x, i) => {
          const body = (
            <>
              <span className="row-main">
                <span className="row-title">{x.title}</span>
                {x.due_at && <span className="row-sub num">{t("home.due", { date: f.date(x.due_at, "medium") })}</span>}
              </span>
              <IconChevronRight size={20} className="flex-none text-fg-3" aria-hidden />
            </>
          );
          return (
            <li key={`${x.link}-${i}`} className="row-item">
              {isInternalLink(x.link) ? (
                <Link to={x.link} className="row-link">
                  {body}
                </Link>
              ) : (
                <div className="row-link">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Resume({ visits }: { visits: Visit[] }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  return (
    <Section title={t("home.resumeTitle")} actions={<TextLink to="/app/visits">{t("visits.all")}</TextLink>}>
      <ul className="row-list">
        {visits.slice(0, 4).map((v) => (
          <li key={v.id} className="row-item">
            <Link to={`/app/visits/${v.id}`} className="row-link" data-unread={v.has_unread}>
              <span className="row-main">
                <span className="row-title">{v.title}</span>
                <span className="row-sub">{t("home.lastActive", { when: f.relative(v.last_activity_at) })}</span>
              </span>
              <StatusTag family="visit" status={v.status} />
              <IconChevronRight size={20} className="flex-none text-fg-3" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function MedPanel({ med, today, request }: { med: MedicationCard; today: string; request?: RxRequestBrief }) {
  return (
    <Panel title={<DrugName drug={med.drug} />} meta={<StatusTag family="med" status={med.state} />}>
      <RefillStrip med={med} today={today} />
      <MedActions med={med} request={request} className="mt-4" />
    </Panel>
  );
}

function MedRow({ med, today }: { med: MedicationCard; today: string }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  return (
    <li className="row-item">
      <Link to={`/app/medications#m-${med.prescription_id}`} className="row-link">
        <span className="row-main">
          <span className="row-title">{f.drug(med.drug)}</span>
          <span className="row-sub num">{t("home.supplyTo", { date: f.date(med.supply_ends_on, "medium") })}</span>
        </span>
        <span className="row-end">
          <StatusTag family="med" status={med.state} />
          <RefillStrip med={med} today={today} size="compact" />
        </span>
      </Link>
    </li>
  );
}

function Requests({ items }: { items: RxRequestBrief[] }) {
  const { t } = useTranslation(["patient", "rx"]);
  const f = useFmt();
  return (
    <Section title={t("patient:home.requestsTitle")} actions={<TextLink to="/app/rx">{t("patient:home.requestsAll")}</TextLink>}>
      <Panel flush>
        <DataTable
          caption={t("patient:home.requestsTitle")}
          rows={items}
          rowKey={(r) => r.id}
          rowLink={(r) => (r.status === "draft" ? `/app/rx/${r.id}/edit` : `/app/rx/${r.id}`)}
          isUrgent={(r) => r.priority === "urgent"}
          columns={[
            {
              id: "what",
              header: t("patient:rx.colWhat"),
              card: "title",
              cell: (r) => (
                <>
                  <span className="block font-semibold">{t(`rx:kind.${r.kind}`)}</span>
                  <span className="block text-sm text-fg-2">{f.list(r.drug_names)}</span>
                </>
              ),
            },
            { id: "status", header: t("patient:rx.colStatus"), card: "end", cell: (r) => <StatusTag family="rx" status={r.status} /> },
            { id: "next", header: t("patient:rx.colNext"), cell: (r) => <span className="text-fg-2">{t(`rx:statusHint.${r.status}`)}</span> },
          ]}
        />
      </Panel>
    </Section>
  );
}
