import { IconAlertTriangle, IconArrowBackUp, IconBan, IconBuildingStore, IconCalendarCheck, IconCalendarX, IconCheck, IconCircleCheck, IconCircleDashed, IconClock, IconFileCheck, IconHelpCircle, IconHourglass, IconMessageQuestion, IconPackage, IconPencil, IconPhoneCall, IconSend, IconStethoscope, IconUser, IconX, type Icon } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn, type Tone } from "./cn";

/** A small label. Give it an icon when it states a status; colour alone is never the message. */
export function Badge({ tone = "mute", icon, plain, children, className }: { tone?: Tone; icon?: ReactNode; plain?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cn("tag", className)} data-tone={tone} data-plain={plain}>
      {icon}
      {children}
    </span>
  );
}

export function CountBadge({ count, tone, label, max = 99 }: { count: number; tone?: "danger" | "mute"; label?: string; max?: number }) {
  if (count <= 0) return null;
  return (
    <span className="count-badge" data-tone={tone} aria-label={label}>
      {count > max ? `${max}+` : count}
    </span>
  );
}

type Spec = readonly [Tone, Icon];

/* One table per status family in docs/v2/contract.md. Labels of prescriptions and visits are rx.json's, the rest are
   common.json's status.<family>.<code>. */
const LABEL: Partial<Record<string, string>> = { rx: "rx:status", disposition: "rx:disposition", outcome: "rx:outcome", scope: "rx:scope", med: "rx:medState", urgency: "rx:urgency", visit: "rx:visitStatus" };

const STATUS = {
  rx: {
    draft: ["mute", IconPencil],
    submitted: ["info", IconSend],
    in_review: ["info", IconStethoscope],
    more_info: ["warn", IconMessageQuestion],
    approved: ["ok", IconFileCheck],
    partially_approved: ["ok", IconFileCheck],
    declined: ["mute", IconX],
    visit_required: ["hold", IconCalendarCheck],
    at_pharmacy: ["info", IconBuildingStore],
    returned: ["hold", IconArrowBackUp],
    ready: ["ok", IconPackage],
    dispensed: ["mute", IconCheck],
    cancelled: ["mute", IconBan],
  },
  disposition: {
    ready: ["ok", IconCircleCheck],
    review: ["info", IconStethoscope],
    in_person: ["hold", IconCalendarCheck],
    urgent: ["danger", IconPhoneCall],
    excluded: ["mute", IconBan],
  },
  outcome: {
    approve: ["ok", IconFileCheck],
    decline: ["mute", IconX],
    visit_required: ["hold", IconCalendarCheck],
    more_info: ["warn", IconMessageQuestion],
  },
  visit: {
    active: ["info", IconCircleDashed],
    red_flag: ["danger", IconPhoneCall],
    submitted: ["warn", IconHourglass],
    reviewed: ["ok", IconCircleCheck],
  },
  previsit: {
    none: ["mute", IconCircleDashed],
    active: ["info", IconPencil],
    submitted: ["warn", IconHourglass],
    reviewed: ["ok", IconCircleCheck],
    red_flag: ["danger", IconPhoneCall],
  },
  urgency: {
    routine: ["mute", IconClock],
    soon: ["warn", IconAlertTriangle],
    urgent: ["danger", IconPhoneCall],
  },
  appointment: {
    booked: ["info", IconCalendarCheck],
    checked_in: ["ok", IconUser],
    completed: ["mute", IconCheck],
    cancelled: ["mute", IconCalendarX],
  },
  med: {
    on_hand: ["mute", IconCheck],
    window_open: ["ok", IconPackage],
    window_soon: ["info", IconClock],
    late: ["warn", IconAlertTriangle],
    finished: ["hold", IconCalendarCheck],
    expired: ["mute", IconBan],
  },
  scope: {
    in_scope: ["ok", IconCircleCheck],
    physician_only: ["hold", IconStethoscope],
    excluded: ["mute", IconBan],
  },
  ticket: {
    open: ["warn", IconHourglass],
    resolved: ["ok", IconCircleCheck],
  },
  note: {
    draft: ["mute", IconPencil],
    signed: ["ok", IconFileCheck],
  },
  care: {
    new: ["info", IconUser],
    active: ["ok", IconCircleCheck],
    watch: ["warn", IconAlertTriangle],
    inactive: ["mute", IconCircleDashed],
  },
  run: {
    running: ["info", IconCircleDashed],
    completed: ["ok", IconCheck],
    failed: ["warn", IconAlertTriangle],
    skipped: ["mute", IconCircleDashed],
    interrupted: ["hold", IconArrowBackUp],
  },
  account: {
    active: ["ok", IconCircleCheck],
    disabled: ["mute", IconBan],
  },
  source: {
    clinic: ["info", IconStethoscope],
    patient: ["mute", IconUser],
    self_reported: ["mute", IconUser],
  },
} as const satisfies Record<string, Record<string, Spec>>;

export type StatusFamily = keyof typeof STATUS;

/** Status from the API, drawn the same way everywhere: `<StatusTag family="rx" status={rx.status} />`. */
export function StatusTag({ family, status, className, plain }: { family: StatusFamily; status: string; className?: string; plain?: boolean }) {
  const { t } = useTranslation(["common", "rx"]);
  const spec = (STATUS[family] as Record<string, Spec>)[status];
  const [tone, Icon] = spec ?? (["mute", IconHelpCircle] as const);
  return (
    <Badge tone={tone} icon={<Icon aria-hidden />} className={className} plain={plain}>
      {spec ? t(`${LABEL[family] ?? `common:status.${family}`}.${status}`) : status}
    </Badge>
  );
}

export function statusTone(family: StatusFamily, status: string): Tone {
  return (STATUS[family] as Record<string, Spec>)[status]?.[0] ?? "mute";
}
export function statusIcon(family: StatusFamily, status: string): Icon {
  return (STATUS[family] as Record<string, Spec>)[status]?.[1] ?? IconHelpCircle;
}
