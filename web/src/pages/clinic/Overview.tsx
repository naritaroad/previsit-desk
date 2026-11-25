import { IconArrowRight, IconCalendarOff, IconPhoneCall, IconVideo } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { AppointmentRow } from "@/api/types";
import { useClinicOverview, useMe, useSavedFilter, useWorklist } from "@/data";
import { internalLink, paths } from "@/lib/links";
import { Badge, Banner, ButtonLink, DataTable, EmptyState, PageBody, PageHeader, Panel, Section, Segmented, Skeleton, SkeletonRows, StatusTag, TextLink } from "@/ui";

import { samePerson, useFmt, useMinute } from "./lib";
import { PageError, StaleBar } from "./parts";

const COUNT_LINKS = [
  ["urgent", "/clinic/worklist?bucket=urgent"],
  ["overdue", "/clinic/rx?bucket=overdue"],
  ["pending", "/clinic/worklist?bucket=pending&type=visit"],
  ["rx_review", "/clinic/rx"],
  ["tickets", "/clinic/tickets"],
  ["waiting_patient", "/clinic/worklist?bucket=waiting"],
] as const;

/** Before the clinic session: who is coming, whose previsit is not read yet, and what cannot wait. */
export default function Overview() {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const now = useMinute();
  const query = useClinicOverview();
  const data = query.data;
  if (!data && query.isError)
    return (
      <PageBody>
        <PageError error={query.error} onRetry={() => void query.refetch()} />
      </PageBody>
    );
  return (
    <>
      <StaleBar query={query} />
      <PageBody>
        <PageHeader title={t("overview.title")} meta={<span className="num">{fmt.date(now, "full")}</span>} />
        <Urgent />
        <div className="overview-grid">
          <Today rows={data?.today} now={now} loading={!data} />
          <div className="grid content-start gap-5">
            <Panel title={t("overview.queues")} flush>
              {data ? (
                <ul className="queue-links">
                  {COUNT_LINKS.map(([key, to]) => (
                    <li key={key}>
                      <Link to={to} data-zero={data.counts[key] === 0} data-urgent={key === "urgent" && data.counts[key] > 0}>
                        <span className="n num">{data.counts[key]}</span>
                        <span className="min-w-0">
                          <span className="block font-semibold">{t(`overview.count.${key}`)}</span>
                          <span className="block text-sm text-fg-2">{t(`overview.countHint.${key}`)}</span>
                        </span>
                        <IconArrowRight size={18} aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <SkeletonRows rows={6} />
              )}
            </Panel>
            <Section title={t("overview.activity")}>
              {!data ? (
                <div className="grid gap-3">
                  <Skeleton />
                  <Skeleton className="w-4/5" />
                  <Skeleton className="w-3/5" />
                </div>
              ) : data.activity.length === 0 ? (
                <p className="text-fg-2">{t("overview.activityEmpty")}</p>
              ) : (
                <ul className="activity">
                  {data.activity.map((a, i) => {
                    const link = internalLink(a.link);
                    return (
                      <li key={`${a.at}-${i}`}>
                        <time className="num text-sm text-fg-3" dateTime={a.at}>
                          {fmt.rel(a.at)}
                        </time>
                        {link ? (
                          <TextLink to={link} quiet>
                            {a.text}
                          </TextLink>
                        ) : (
                          <span>{a.text}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>
          </div>
        </div>
      </PageBody>
    </>
  );
}

/** Urgent items by name, never only as a number. */
function Urgent() {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const list = useWorklist({ bucket: "urgent", limit: 5 });
  if (list.items.length === 0) return null;
  const more = (list.counts?.urgent ?? 0) - list.items.length;
  return (
    <Banner
      tone="danger"
      role="note"
      icon={<IconPhoneCall aria-hidden />}
      title={t("overview.urgentTitle", { count: list.counts?.urgent ?? list.items.length })}
      className="mb-stack"
      actions={more > 0 ? <ButtonLink to="/clinic/worklist?bucket=urgent" size="sm">{t("overview.urgentMore", { count: more })}</ButtonLink> : undefined}
    >
      <ul className="urgent-list">
        {list.items.map((i) => (
          <li key={`${i.type}:${i.id}`}>
            <TextLink to={internalLink(i.link) ?? "/clinic/worklist?bucket=urgent"} className="font-semibold">
              {i.patient.display_name}
            </TextLink>
            <span className="min-w-0">
              {i.title}
              {i.subtitle && i.subtitle !== i.title && <span className="block text-sm text-fg-2">{i.subtitle}</span>}
            </span>
            <time className="num text-sm text-fg-2" dateTime={i.updated_at}>
              {fmt.rel(i.updated_at)}
            </time>
          </li>
        ))}
      </ul>
    </Banner>
  );
}

const RANK: Record<string, number> = { red_flag: 0, submitted: 1, active: 2, none: 3, reviewed: 4 };

function Today({ rows, now, loading }: { rows: AppointmentRow[] | undefined; now: Date; loading: boolean }) {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const me = useMe();
  const doctor = me?.role === "physician";
  const [view, setView] = useSavedFilter("clinic.overview", { who: doctor ? "mine" : "all", sort: "time" });
  const mine = rows?.filter((r) => samePerson(r.appointment.physician, me));
  const shown = (doctor && view.who === "mine" ? mine : rows)?.toSorted((a, b) =>
    view.sort === "state" ? RANK[a.previsit] - RANK[b.previsit] || a.appointment.starts_at.localeCompare(b.appointment.starts_at) : Number(b.previsit === "red_flag") - Number(a.previsit === "red_flag") || a.appointment.starts_at.localeCompare(b.appointment.starts_at),
  );
  const nextAt = shown?.filter((r) => r.appointment.status === "booked" || r.appointment.status === "checked_in").map((r) => r.appointment.starts_at).filter((at) => new Date(at) > now).sort()[0];
  const ready = shown?.filter((r) => r.previsit === "submitted" || r.previsit === "reviewed" || r.previsit === "red_flag").length ?? 0;
  return (
    <Panel
      flush
      title={t("overview.today")}
      meta={shown && shown.length > 0 ? <span className="num">{t("overview.todayMeta", { total: shown.length, ready })}</span> : undefined}
      actions={
        <>
          {doctor && (
            <Segmented
              label={t("overview.whose")}
              value={view.who}
              onValueChange={(who) => setView({ who })}
              options={[
                { value: "mine", label: t("overview.mine"), count: mine?.length },
                { value: "all", label: t("overview.all"), count: rows?.length },
              ]}
            />
          )}
          <Segmented
            label={t("overview.order")}
            value={view.sort}
            onValueChange={(sort) => setView({ sort })}
            options={[
              { value: "time", label: t("overview.byTime") },
              { value: "state", label: t("overview.byState") },
            ]}
          />
        </>
      }
      footer={<TextLink to={paths.clinic.schedule()}>{t("overview.toSchedule")}</TextLink>}
    >
      <DataTable
        caption={t("overview.today")}
        rows={loading ? undefined : shown}
        loading={loading}
        rowKey={(r) => r.appointment.id}
        rowLink={(r) => (r.appointment.visit_id ? paths.clinic.visit(r.appointment.visit_id) : paths.clinic.patient(r.patient.id))}
        isUrgent={(r) => r.previsit === "red_flag"}
        empty={
          <EmptyState icon={<IconCalendarOff aria-hidden />} title={t("overview.todayEmpty")} action={<ButtonLink to={paths.clinic.schedule()}>{t("overview.toSchedule")}</ButtonLink>}>
            {t("overview.todayEmptyBody")}
          </EmptyState>
        }
        columns={[
          {
            id: "time",
            header: t("col.time"),
            nowrap: true,
            width: "6.5rem",
            cell: (r) => (
              <span className="num font-semibold">
                {fmt.time(r.appointment.starts_at)}
                {r.appointment.starts_at === nextAt && (
                  <Badge tone="ink" plain className="ms-2">
                    {t("overview.next")}
                  </Badge>
                )}
              </span>
            ),
          },
          { id: "patient", header: t("col.patient"), card: "title", width: "8rem", cell: (r) => <span className="font-semibold">{r.patient.display_name}</span> },
          {
            id: "reason",
            header: t("col.reason"),
            cell: (r) => (
              <>
                <span className="block">{r.appointment.reason ?? <span className="text-fg-3">{t("overview.noReason")}</span>}</span>
                <span className="inline-flex items-center gap-1 text-sm text-fg-2">
                  {r.appointment.mode === "video" && <IconVideo size={15} aria-hidden />}
                  {[t(`appt.mode.${r.appointment.mode}`), r.appointment.room, r.appointment.department].filter(Boolean).join(t("patient.dot"))}
                </span>
              </>
            ),
          },
          ...(view.who === "all" || !doctor ? [{ id: "physician", header: t("col.physician"), width: "7rem", hideBelow: "md" as const, cell: (r: AppointmentRow) => r.appointment.physician.display_name }] : []),
          { id: "state", header: t("col.previsit"), card: "end", width: "8rem", cell: (r) => <StatusTag family="previsit" status={r.previsit} /> },
          { id: "arrive", header: t("col.arrival"), width: "7rem", hideBelow: "lg", cell: (r) => <StatusTag family="appointment" status={r.appointment.status} plain /> },
        ]}
      />
    </Panel>
  );
}
