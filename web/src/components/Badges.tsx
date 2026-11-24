// Small status labels shared by the clinician screens. Always icon plus word; red only for urgent.

import { useTranslation } from "react-i18next";

import type { Urgency, VisitStatus } from "../api/types.ts";
import { Icon, type IconName } from "./Icon.tsx";

const URGENCY_ICON: Record<Urgency, IconName> = { urgent: "alert", soon: "clock", routine: "list" };
const STATUS_ICON: Record<VisitStatus, IconName> = { active: "chat", red_flag: "alert", submitted: "doc", reviewed: "check" };

export function UrgencyBadge({ urgency }: { urgency: Urgency }) {
  const { t } = useTranslation();
  return (
    <span className={`urg urg--${urgency}`}>
      <Icon name={URGENCY_ICON[urgency]} size="sm" />
      {t(`urgency.${urgency}`)}
    </span>
  );
}

export function VisitStatusLabel({ status }: { status: VisitStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`vstatus vstatus--${status}`}>
      <Icon name={STATUS_ICON[status]} size="sm" />
      {t(`visitStatus.${status}`)}
    </span>
  );
}
