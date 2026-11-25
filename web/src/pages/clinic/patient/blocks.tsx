// Parts of a patient's record used by the record page, the review desk and the prescription review.

import { IconAlertTriangle, IconPinned } from "@tabler/icons-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";

import type { HealthProfile, Measurement, MeasurementKind, MedicationCard, PatientDetail, ProfileItem, StaffNote, Visit } from "@/api/types";
import { useToday } from "@/data";
import { paths } from "@/lib/links";
import { Badge, DescriptionList, RefillStrip, Segmented, Skeleton, StatusTag, TextLink } from "@/ui";

import { personLabel, useFmt } from "../lib";

const Chart = lazy(() => import("@/ui/measurement-chart").then((m) => ({ default: m.MeasurementChart })));

const active = (items: ProfileItem[] | undefined) => (items ?? []).filter((i) => i.status === "active");

/** Allergies come first and always say something: "none recorded" is not the same as "no allergies". */
export function Allergies({ profile }: { profile: HealthProfile | null }) {
  const { t } = useTranslation("clinic");
  const items = active(profile?.allergies);
  if (items.length === 0) return <p className="text-fg-2">{t("record.noAllergies")}</p>;
  return (
    <ul className="grid gap-1">
      {items.map((a) => (
        <li key={a.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
          <IconAlertTriangle size={18} className="mt-1 text-warn" aria-hidden />
          <span>
            <span className="font-semibold">{a.name}</span>
            {a.detail && <span className="text-fg-2">{t("record.detail", { text: a.detail })}</span>}
            {a.source === "patient" && <span className="block text-sm text-fg-3">{t("record.selfReported")}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ProfileItems({ items, empty }: { items: ProfileItem[] | undefined; empty: string }) {
  const { t } = useTranslation("clinic");
  const list = active(items);
  if (list.length === 0) return <p className="text-fg-2">{empty}</p>;
  return (
    <ul className="divide-y divide-rule">
      {list.map((i) => (
        <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5">
          <span className="min-w-0">
            <span className="font-medium">{i.name}</span>
            {i.detail && <span className="block text-sm text-fg-2">{i.detail}</span>}
          </span>
          <span className="text-sm text-fg-3">{[i.since && t("record.since", { when: i.since }), i.source === "patient" && t("record.selfReported")].filter(Boolean).join(t("patient.dot"))}</span>
        </li>
      ))}
    </ul>
  );
}

export function ProfileFacts({ profile }: { profile: HealthProfile | null }) {
  const { t } = useTranslation("clinic");
  if (!profile) return <p className="text-fg-2">{t("record.noProfile")}</p>;
  const life = profile.lifestyle;
  return (
    <DescriptionList
      items={[
        { label: t("record.born"), value: profile.birth_year === null ? null : <span className="num">{profile.birth_year}</span> },
        { label: t("record.height"), value: profile.height_cm === null ? null : <span className="num">{t("record.cm", { n: profile.height_cm })}</span> },
        { label: t("record.smoking"), value: life.smoking },
        { label: t("record.alcohol"), value: life.alcohol },
        { label: t("record.exercise"), value: life.exercise },
      ]}
    />
  );
}

/** Medicines with the dispensing cells, so "how many fills are left" is one look. */
export function MedicationList({ items, only, compact }: { items: MedicationCard[]; only?: ReadonlySet<string>; compact?: boolean }) {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const today = useToday();
  const list = only ? items.filter((m) => only.has(m.prescription_id)) : items;
  if (list.length === 0) return <p className="text-fg-2">{t("record.noMedicines")}</p>;
  return (
    <ul className="divide-y divide-rule">
      {list.map((m) => (
        <li key={m.prescription_id} className="py-2">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <span className="min-w-0 flex-1 basis-40">
              <span className="font-medium">{fmt.locale === "en" ? m.drug.name_en || m.drug.name_zh : m.drug.name_zh || m.drug.name_en}</span>
              <span className="block text-sm text-fg-2">{m.dose_text}</span>
            </span>
            {m.source === "clinic" ? <RefillStrip med={m} today={today} size="compact" /> : <Badge>{t("record.selfReported")}</Badge>}
          </div>
          {m.source === "clinic" && (
            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-2">
              <StatusTag family="med" status={m.state} plain />
              <span className="num">{t("record.supplyTo", { date: fmt.date(m.supply_ends_on, "month_day") })}</span>
              {m.open_request_id && <TextLink to={paths.clinic.rx(m.open_request_id)}>{t("record.openRequest")}</TextLink>}
            </span>
          )}
          {!compact && m.source === "clinic" && (
            <div className="mt-3">
              <RefillStrip med={m} today={today} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

const KINDS: readonly MeasurementKind[] = ["bp", "glucose", "weight", "pulse"];
/** One chart at a time, for the kinds that have readings. */
export function Readings({ items, height = 180, kinds = KINDS }: { items: Measurement[]; height?: number; kinds?: readonly MeasurementKind[] }) {
  const { t } = useTranslation(["clinic", "common"]);
  const have = kinds.filter((k) => items.some((m) => m.kind === k));
  const [pick, setPick] = useState<MeasurementKind | null>(null);
  const kind = pick && have.includes(pick) ? pick : have[0];
  if (!kind) return <p className="text-fg-2">{t("record.noReadings")}</p>;
  return (
    <>
      {have.length > 1 && <Segmented className="mb-3" label={t("record.readingKind")} value={kind} onValueChange={(v) => setPick(v as MeasurementKind)} options={have.map((value) => ({ value, label: t(`common:measure.kind.${value}`) }))} />}
      <Suspense fallback={<Skeleton className="h-40" />}>
        <Chart kind={kind} items={items} height={height} />
      </Suspense>
      <p className="mt-1 text-sm text-fg-3">{t("record.hollow")}</p>
    </>
  );
}

export function LabResults({ items }: { items: Measurement[] }) {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const labs = items.filter((m) => m.kind === "lab").toSorted((a, b) => b.taken_at.localeCompare(a.taken_at));
  if (labs.length === 0) return <p className="text-fg-2">{t("record.noLabs")}</p>;
  return (
    <dl className="ledger">
      {labs.map((m) => (
        <div key={m.id}>
          <dt>
            {m.values.name}
            <span className="block text-sm text-fg-3">{fmt.date(m.taken_at, "short")}</span>
          </dt>
          <dd>
            {m.values.value}
            <small>{m.values.unit}</small>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function VisitLinks({ visits, except, limit }: { visits: Visit[]; except?: string; limit?: number }) {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const list = visits.filter((v) => v.id !== except).slice(0, limit);
  if (list.length === 0) return <p className="text-fg-2">{t("record.noVisits")}</p>;
  return (
    <ul className="divide-y divide-rule">
      {list.map((v) => (
        <li key={v.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
          <span className="min-w-0">
            <TextLink to={paths.clinic.visit(v.id)}>{v.title}</TextLink>
            <span className="num block text-sm text-fg-2">{fmt.date(v.submitted_at ?? v.created_at, "short")}</span>
          </span>
          <StatusTag family="visit" status={v.status} />
        </li>
      ))}
    </ul>
  );
}

export function PinnedNotes({ notes }: { notes: StaffNote[] }) {
  const fmt = useFmt();
  const pinned = notes.filter((n) => n.pinned);
  if (pinned.length === 0) return null;
  return (
    <ul className="grid gap-2">
      {pinned.map((n) => (
        <li key={n.id} className="staff-note" data-pinned="true">
          <IconPinned size={16} aria-hidden />
          <span>
            <span className="block whitespace-pre-wrap">{n.body}</span>
            <span className="text-sm text-fg-2">
              {personLabel(n.author)} {fmt.date(n.created_at, "month_day")}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Codes of the API; anything else is already a sentence. */
const FLAG_CODES = ["red_flag", "rx_overdue", "open_ticket"] as const;
export function Flags({ flags }: { flags: string[] }) {
  const { t } = useTranslation("clinic");
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {flags.map((f) => {
        const code = FLAG_CODES.find((c) => c === f);
        return (
          <Badge key={f} tone={code === "red_flag" ? "danger" : "warn"} icon={<IconAlertTriangle aria-hidden />}>
            {code ? t(`flag.${code}`) : f}
          </Badge>
        );
      })}
    </span>
  );
}

/** Latest reading per kind, as text: objective data the patient or the clinic recorded. */
export function latestReadings(detail: Pick<PatientDetail, "measurements"> | undefined): Measurement[] {
  const seen = new Map<string, Measurement>();
  for (const m of detail?.measurements ?? []) {
    const key = m.kind === "lab" ? `lab:${m.values.name}` : m.kind;
    const old = seen.get(key);
    if (!old || m.taken_at > old.taken_at) seen.set(key, m);
  }
  return [...seen.values()];
}
