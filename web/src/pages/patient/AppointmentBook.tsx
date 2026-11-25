import { IconCalendarOff, IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";

import { ApiError } from "@/api/errors";
import type { AppointmentSlot } from "@/api/types";
import { useAppointments, useBookAppointment, useCancelAppointment, useSlots, useToday } from "@/data";
import { addDays, taipeiDate } from "@/lib/format";
import { Banner, Button, EmptyState, Field, IconButton, Input, NativeSelect, PageBody, PageHeader, SkeletonRows, useMediaQuery } from "@/ui";

import { ActionError, LoadError, useFmt } from "./shared";

/** Booking opens four weeks ahead (backend appts.rs MAX_DAYS_AHEAD). */
const WEEKS = 4;
const PERIODS = ["morning", "afternoon", "evening"] as const;
type Period = (typeof PERIODS)[number];

export default function AppointmentBook() {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const movingId = params.get("reschedule");
  const appointments = useAppointments();
  const moving = movingId ? appointments.items.find((a) => a.id === movingId) : undefined;
  const today = useToday();
  const wide = useMediaQuery("(min-width: 62rem)");
  const [week, setWeek] = useState(0);
  const [department, setDepartment] = useState("");
  const [physician, setPhysician] = useState("");
  const [picked, setPicked] = useState<AppointmentSlot | null>(null);
  const [reason, setReason] = useState("");
  const from = addDays(today, week * 7);
  const to = addDays(from, 6);
  // The whole week, unfiltered: the choices of department and doctor come from it.
  const slots = useSlots({ from, to });
  const all = useMemo(() => slots.data ?? [], [slots.data]);
  const departments = [...new Set(all.map((s) => s.department))];
  const doctors = [...new Map(all.filter((s) => !department || s.department === department).map((s) => [s.physician.id, s.physician])).values()];
  const shown = all.filter((s) => (!department || s.department === department) && (!physician || s.physician.id === physician));
  const free = shown.filter((s) => s.available);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));

  const book = useBookAppointment();
  const cancel = useCancelAppointment();
  const taken = book.error instanceof ApiError && (book.error.code === "invalid_state" || book.error.code === "conflict" || Boolean(book.error.fields.slot_id));
  const submit = () => {
    if (!picked) return;
    book.mutate(
      { slot_id: picked.slot_id, reason: reason.trim() },
      {
        onSuccess: async () => {
          if (!moving) return navigate("/app/appointments?booked=1");
          try {
            await cancel.mutateAsync(moving.id);
            return navigate("/app/appointments?booked=1&moved=1");
          } catch {
            return navigate("/app/appointments?keptOld=1");
          }
        },
        onError: (e) => {
          if (e instanceof ApiError && (e.code === "invalid_state" || e.code === "conflict" || e.fields.slot_id)) {
            setPicked(null);
            void slots.refetch();
          }
        },
      },
    );
  };
  const slotProps = (s: AppointmentSlot) => ({
    slot: s,
    pressed: picked?.slot_id === s.slot_id,
    showDoctor: !physician && doctors.length > 1,
    onPick: () => {
      setPicked(s);
      book.reset();
    },
  });

  return (
    <PageBody className="pb-0">
      <PageHeader title={t(moving ? "book.moveTitle" : "book.title")} lede={moving ? t("book.moveLede", { date: f.dateTime(moving.starts_at), doctor: f.person(moving.physician) }) : t("book.lede")} back={{ to: "/app/appointments", label: t("appt.title") }} />
      <div className="mb-stack flex flex-wrap items-end gap-3">
        <Field label={t("book.department")} className="w-52">
          <NativeSelect
            value={department}
            onChange={(e) => {
              setDepartment(e.target.value);
              setPhysician("");
            }}
          >
            <option value="">{t("book.anyDepartment")}</option>
            {departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t("book.doctor")} className="w-52">
          <NativeSelect value={physician} onChange={(e) => setPhysician(e.target.value)}>
            <option value="">{t("book.anyDoctor")}</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {f.person(d)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <div className="ms-auto flex items-center gap-1" role="group" aria-label={t("book.week")}>
          <IconButton label={t("book.prevWeek")} variant="bordered" disabled={week === 0} onClick={() => setWeek(week - 1)}>
            <IconChevronLeft size={22} aria-hidden />
          </IconButton>
          <span className="num min-w-40 text-center font-semibold" role="status">
            {f.range(from, to)}
          </span>
          <IconButton label={t("book.nextWeek")} variant="bordered" disabled={week >= WEEKS - 1} onClick={() => setWeek(week + 1)}>
            <IconChevronRight size={22} aria-hidden />
          </IconButton>
        </div>
      </div>

      {taken && (
        <Banner tone="warn" role="alert" className="mb-stack" title={t("book.takenTitle")}>
          {t("book.takenBody")}
        </Banner>
      )}
      {slots.error && !slots.data ? (
        <LoadError error={slots.error} onRetry={() => void slots.refetch()} retrying={slots.isFetching} />
      ) : !slots.data ? (
        <SkeletonRows rows={6} />
      ) : free.length === 0 ? (
        <EmptyState icon={<IconCalendarOff aria-hidden />} title={t("book.none")} action={week < WEEKS - 1 ? <Button onClick={() => setWeek(week + 1)}>{t("book.nextWeek")}</Button> : undefined}>
          {t("book.noneBody")}
        </EmptyState>
      ) : wide ? (
        <table className="week">
          <caption className="sr-only">{t("book.gridLabel", { range: f.range(from, to) })}</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">{t("book.period")}</span>
              </th>
              {days.map((d) => (
                <th key={d} scope="col" data-today={d === today}>
                  <span className="num">{f.date(d, "medium")}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERIODS.filter((p) => shown.some((s) => periodOf(s) === p)).map((p) => (
              <tr key={p}>
                <th scope="row">{t(`book.${p}`)}</th>
                {days.map((d) => (
                  <td key={d}>
                    {shown
                      .filter((s) => taipeiDate(s.starts_at) === d && periodOf(s) === p)
                      .map((s) => (
                        <Slot key={s.slot_id} {...slotProps(s)} />
                      ))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        days
          .filter((d) => shown.some((s) => taipeiDate(s.starts_at) === d))
          .map((d) => {
            const open = shown.filter((s) => taipeiDate(s.starts_at) === d);
            return (
              <section key={d} className="slot-day" aria-label={f.date(d, "full")}>
                <h2 className="font-bold">
                  {f.date(d, "full")} <span className="num text-sm font-normal text-fg-2">{t("book.freeCount", { count: open.filter((s) => s.available).length })}</span>
                </h2>
                <div>
                  {open
                    .filter((s) => s.available)
                    .map((s) => (
                      <Slot key={s.slot_id} {...slotProps(s)} />
                    ))}
                </div>
              </section>
            );
          })
      )}

      <div className="step-form-foot mt-6" data-empty={!picked}>
        {picked ? (
          <form
            className="grid w-full gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,20rem)_auto] md:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <p role="status">
              <b className="num block text-lg">{f.dateTime(picked.starts_at)}</b>
              {[picked.department, f.person(picked.physician), t(picked.mode === "video" ? "appt.video" : "appt.inPerson"), picked.mode === "video" ? null : picked.room].filter(Boolean).join(t("common.sep"))}
            </p>
            <Field label={t("book.reason")} optional>
              <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={t("book.reasonExample")} />
            </Field>
            <Button type="submit" variant="primary" loading={book.isPending || cancel.isPending}>
              {t(moving ? "book.moveDo" : "book.do")}
            </Button>
            {book.error && !taken && <ActionError error={book.error} className="md:col-span-3" title={t("book.failed")} onRetry={submit} />}
          </form>
        ) : (
          <p className="text-fg-2">{t("book.pickFirst")}</p>
        )}
      </div>
    </PageBody>
  );
}

function periodOf(s: AppointmentSlot): Period {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Asia/Taipei" }).format(new Date(s.starts_at)));
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

function Slot({ slot: s, pressed, showDoctor, onPick }: { slot: AppointmentSlot; pressed: boolean; showDoctor: boolean; onPick: () => void }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  return (
    <button type="button" className="slot" aria-pressed={pressed} disabled={!s.available} onClick={onPick} aria-label={t(s.available ? "book.slotLabel" : "book.slotTaken", { date: f.dateTime(s.starts_at), doctor: f.person(s.physician), department: s.department })}>
      {f.time(s.starts_at)}
      {s.available && (showDoctor || s.mode === "video") && <small>{[showDoctor ? s.physician.display_name : null, s.mode === "video" ? t("appt.videoShort") : null].filter(Boolean).join(" ")}</small>}
    </button>
  );
}
