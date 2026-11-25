import { IconCalendarOff, IconChevronLeft, IconChevronRight, IconClipboardText, IconUser, IconVideo } from "@tabler/icons-react";
import { useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import type { ClinicSchedule, ScheduleSlot } from "@/api/types";
import { useMe, useSavedFilter, useSchedule, useToday } from "@/data";
import { addDays, isValidDate, taipeiDate, taipeiInstant } from "@/lib/format";
import { paths } from "@/lib/links";
import { FillPage } from "@/shells/StaffShell";
import { Badge, Button, ButtonLink, DateField, DescriptionList, EmptyState, IconButton, Segmented, Sheet, SkeletonRows, StatusTag, cn, statusIcon, useMediaQuery } from "@/ui";

import { samePerson, useFmt, useMinute, useUrlState } from "./lib";
import { PageError, StaleBar } from "./parts";

type Doctor = ClinicSchedule["physicians"][number];

/** Minutes after midnight in Taipei. */
const minuteOf = (iso: string) => Math.round((Date.parse(iso) - Date.parse(taipeiInstant(taipeiDate(iso)))) / 60_000);

export default function Schedule() {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const today = useToday();
  const me = useMe();
  const [url, set] = useUrlState({ date: today });
  const date = isValidDate(url.date) ? url.date : today;
  const [view, setView] = useSavedFilter("clinic.schedule", { who: "all", empty: true });
  const query = useSchedule(date);
  const wide = useMediaQuery("(min-width: 56rem)");
  const [open, setOpen] = useState<{ doctor: Doctor; slot: ScheduleSlot } | null>(null);
  const mine = query.data?.physicians.some((p) => samePerson(p.physician, me));
  const doctors = useMemo(() => (query.data?.physicians ?? []).filter((p) => view.who !== "mine" || !mine || samePerson(p.physician, me)), [query.data, view.who, mine, me]);
  const booked = doctors.reduce((n, d) => n + d.slots.filter((s) => s.appointment && s.appointment.status !== "cancelled").length, 0);
  return (
    <FillPage
      head={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-pane py-2.5">
          <h1 className="page-title" tabIndex={-1}>
            {t("schedule.title")}
          </h1>
          <span className="inline-flex items-center gap-1">
            <IconButton label={t("schedule.prev")} size="sm" variant="bordered" onClick={() => set({ date: addDays(date, -1) })}>
              <IconChevronLeft size={20} aria-hidden />
            </IconButton>
            <DateField className="w-40" aria-label={t("schedule.date")} value={date} onValueChange={(v) => v && set({ date: v })} />
            <IconButton label={t("schedule.next")} size="sm" variant="bordered" onClick={() => set({ date: addDays(date, 1) })}>
              <IconChevronRight size={20} aria-hidden />
            </IconButton>
            <Button size="sm" disabled={date === today} onClick={() => set({ date: today })}>
              {t("schedule.today")}
            </Button>
          </span>
          <span className="num font-medium" role="status">
            {fmt.date(date, "full")}
            {query.data && <span className="ms-3 text-sm font-normal text-fg-2">{t("schedule.booked", { count: booked })}</span>}
          </span>
          {mine && (
            <Segmented
              className="ms-auto"
              label={t("overview.whose")}
              value={view.who}
              onValueChange={(who) => setView({ who })}
              options={[
                { value: "mine", label: t("overview.mine") },
                { value: "all", label: t("overview.all") },
              ]}
            />
          )}
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col bg-surface">
        <StaleBar query={query} />
        {query.isError && !query.data ? (
          <PageError error={query.error} onRetry={() => void query.refetch()} />
        ) : !query.data ? (
          <SkeletonRows rows={10} />
        ) : doctors.every((d) => d.slots.length === 0) ? (
          <EmptyState icon={<IconCalendarOff aria-hidden />} title={t("schedule.empty")} action={date !== today ? <Button onClick={() => set({ date: today })}>{t("schedule.today")}</Button> : undefined}>
            {t("schedule.emptyBody")}
          </EmptyState>
        ) : wide ? (
          <Grid date={date} today={today} doctors={doctors} onOpen={(doctor, slot) => setOpen({ doctor, slot })} />
        ) : (
          <List doctors={doctors} onOpen={(doctor, slot) => setOpen({ doctor, slot })} />
        )}
      </div>
      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpen(null)} title={open?.slot.patient?.display_name ?? ""} description={open ? `${fmt.dateTime(open.slot.starts_at)} ${open.doctor.physician.display_name}` : undefined}>
        {open?.slot.appointment && open.slot.patient && (
          <div className="grid gap-5">
            <span className="flex flex-wrap gap-2">
              <StatusTag family="previsit" status={open.slot.previsit} />
              <StatusTag family="appointment" status={open.slot.appointment.status} />
            </span>
            <DescriptionList
              items={[
                { label: t("col.reason"), value: open.slot.appointment.reason },
                { label: t("schedule.mode"), value: t(`appt.mode.${open.slot.appointment.mode}`) },
                { label: t("schedule.room"), value: open.slot.appointment.room },
                { label: t("schedule.department"), value: open.slot.appointment.department },
                { label: t("schedule.length"), value: t("schedule.minutes", { count: open.slot.appointment.minutes }) },
              ]}
            />
            <div className="grid gap-2">
              {open.slot.appointment.visit_id ? (
                <ButtonLink to={paths.clinic.visit(open.slot.appointment.visit_id)} variant="primary" icon={<IconClipboardText aria-hidden />}>
                  {t("preview.open.visit")}
                </ButtonLink>
              ) : (
                <p className="text-fg-2">{t("schedule.noPrevisit")}</p>
              )}
              <ButtonLink to={paths.clinic.patient(open.slot.patient.id)} icon={<IconUser aria-hidden />}>
                {t("preview.patient")}
              </ButtonLink>
            </div>
          </div>
        )}
      </Sheet>
    </FillPage>
  );
}

/** One column per physician on a shared time scale; a quarter of an hour is one row. */
function Grid({ date, today, doctors, onOpen }: { date: string; today: string; doctors: Doctor[]; onOpen: (d: Doctor, s: ScheduleSlot) => void }) {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const now = useMinute();
  const all = doctors.flatMap((d) => d.slots);
  const start = Math.floor(Math.min(...all.map((s) => minuteOf(s.starts_at))) / 60) * 60;
  const end = Math.ceil(Math.max(...all.map((s) => minuteOf(s.starts_at) + s.minutes)) / 60) * 60;
  const row = (m: number) => Math.round((m - start) / 15) + 1;
  // Hours nobody works (lunch, the gap before the evening session) are folded to one thin row.
  const busy = new Set(all.flatMap((s) => Array.from({ length: Math.ceil(s.minutes / 15) }, (_, i) => row(minuteOf(s.starts_at)) + i)));
  const rows = Array.from({ length: (end - start) / 15 }, (_, i) => i + 1);
  const gap = (r: number) => ![...Array(4).keys()].some((i) => busy.has(Math.floor((r - 1) / 4) * 4 + 1 + i));
  const template = rows.map((r) => (gap(r) ? "0.4rem" : "minmax(var(--slot), auto)")).join(" ");
  const nowRow = date === today ? (minuteOf(now.toISOString()) - start) / 15 : -1;
  return (
    <div className="scroll-y min-h-0 flex-1">
      <div className="day-grid" style={{ "--doctors": doctors.length } as CSSProperties}>
        <div className="day-head" role="presentation" />
        {doctors.map((d) => (
          <h2 key={d.physician.id} className="day-head">
            {d.physician.display_name}
            <span className="num ms-2 text-sm font-normal text-fg-2">{t("schedule.filled", { done: d.slots.filter((s) => s.appointment).length, total: d.slots.length })}</span>
          </h2>
        ))}
        <div className="day-times" style={{ gridTemplateRows: template }} aria-hidden="true">
          {rows
            .filter((r) => (r - 1) % 4 === 0 && !gap(r))
            .map((r) => (
              <span key={r} className="num" style={{ gridRow: r }}>
                {fmt.time(taipeiInstant(date, `${String(Math.floor((start + (r - 1) * 15) / 60)).padStart(2, "0")}:00`))}
              </span>
            ))}
        </div>
        {doctors.map((d) => (
          <ol key={d.physician.id} className="day-col" style={{ gridTemplateRows: template }} aria-label={t("schedule.of", { name: d.physician.display_name })}>
            {rows
              .filter((r) => (r - 1) % 4 === 0 && !gap(r))
              .map((r) => (
                <li key={`h-${r}`} className="hour-line" style={{ gridRow: r }} aria-hidden="true" />
              ))}
            {nowRow >= 0 && nowRow < rows.length && !gap(Math.floor(nowRow) + 1) && (
              <li className="now-line" style={{ gridRow: Math.floor(nowRow) + 1, "--part": nowRow % 1 } as CSSProperties} aria-hidden="true">
                <span className="num">{fmt.time(now)}</span>
              </li>
            )}
            {d.slots.map((s) => (
              <li key={s.slot_id} style={{ gridRow: `${row(minuteOf(s.starts_at))} / span ${Math.max(1, Math.round(s.minutes / 15))}` }}>
                <Slot slot={s} onOpen={() => onOpen(d, s)} />
              </li>
            ))}
          </ol>
        ))}
      </div>
    </div>
  );
}

function Slot({ slot, onOpen }: { slot: ScheduleSlot; onOpen: () => void }) {
  const { t } = useTranslation(["clinic", "common"]);
  const fmt = useFmt();
  if (!slot.appointment || !slot.patient)
    return (
      <span className="slot-free num">
        <span aria-hidden="true">{fmt.time(slot.starts_at)}</span>
        <span className="sr-only">{t("schedule.free", { time: fmt.time(slot.starts_at) })}</span>
      </span>
    );
  const Icon = statusIcon("previsit", slot.previsit);
  const off = slot.appointment.status === "cancelled";
  return (
    <button type="button" className={cn("slot-booked", off && "line-through")} data-state={slot.previsit} data-done={slot.appointment.status === "completed"} onClick={onOpen}>
      <span className="num font-semibold">{fmt.time(slot.starts_at)}</span>
      <span className="min-w-0 truncate">
        <span className="font-semibold">{slot.patient.display_name}</span>
        {slot.appointment.reason && <span className="ms-2 text-fg-2">{slot.appointment.reason}</span>}
      </span>
      <span className="slot-state">
        {slot.appointment.mode === "video" && <IconVideo size={16} aria-label={t("appt.mode.video")} />}
        <Icon size={16} aria-hidden />
        <span>{t(`common:status.previsit.${slot.previsit}`)}</span>
      </span>
    </button>
  );
}

/** Tablets held upright and phones: one physician after another. */
function List({ doctors, onOpen }: { doctors: Doctor[]; onOpen: (d: Doctor, s: ScheduleSlot) => void }) {
  const { t } = useTranslation("clinic");
  const [pick, setPick] = useState(doctors[0]?.physician.id ?? "");
  const d = doctors.find((x) => x.physician.id === pick) ?? doctors[0];
  const slots = d.slots.filter((s) => s.appointment);
  return (
    <div className="scroll-y min-h-0 flex-1 p-pane">
      {doctors.length > 1 && <Segmented className="mb-4" label={t("schedule.physician")} value={d.physician.id} onValueChange={setPick} options={doctors.map((x) => ({ value: x.physician.id, label: x.physician.display_name, count: x.slots.filter((s) => s.appointment).length }))} />}
      {slots.length === 0 ? (
        <EmptyState title={t("schedule.noneFor", { name: d.physician.display_name })} />
      ) : (
        <ol className="grid gap-2">
          {slots.map((s) => (
            <li key={s.slot_id}>
              <Slot slot={s} onOpen={() => onOpen(d, s)} />
            </li>
          ))}
        </ol>
      )}
      <p className="mt-4">
        <Badge plain>{t("schedule.freeSlots", { count: d.slots.length - slots.length })}</Badge>
      </p>
    </div>
  );
}
