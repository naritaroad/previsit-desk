import { IconCalendarTime, IconChartBar, IconGavel, IconHome, IconInbox, IconMessages, IconPrescription, IconUsers } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useSession } from "@/app/session-context";
import { can } from "@/lib/permissions";
import type { CommandGroup } from "@/ui";

import type { NavGroup } from "./parts";
import { StaffShell } from "./StaffShell";

export interface ClinicShellProps {
  counts?: { worklist?: number; urgent?: number; rx?: number; tickets?: number };
  commandGroups?: CommandGroup[];
  onCommandQuery?: (q: string) => void;
  children?: ReactNode;
}

export function ClinicShell({ counts, ...rest }: ClinicShellProps) {
  const { t } = useTranslation("shell");
  const { me } = useSession();
  const groups: NavGroup[] = [
    {
      title: t("clinic.today"),
      items: [
        { to: "/clinic", end: true, label: t("clinic.overview"), icon: IconHome },
        { to: "/clinic/worklist", label: t("clinic.worklist"), icon: IconInbox, count: counts?.worklist, urgent: counts?.urgent },
        { to: "/clinic/rx", label: t("clinic.rx"), icon: IconPrescription, count: counts?.rx },
        { to: "/clinic/tickets", label: t("clinic.tickets"), icon: IconMessages, count: counts?.tickets },
        { to: "/clinic/schedule", label: t("clinic.schedule"), icon: IconCalendarTime },
      ],
    },
    {
      title: t("clinic.records"),
      items: [
        { to: "/clinic/patients", label: t("clinic.patients"), icon: IconUsers },
        ...(can(me, "oversight.read") ? [{ to: "/clinic/oversight", label: t("clinic.oversight"), icon: IconChartBar }] : []),
        ...(can(me, "rules.read") ? [{ to: "/clinic/rules", label: t("clinic.rules"), icon: IconGavel }] : []),
      ],
    },
  ];
  return <StaffShell ws="clinic" home="/clinic" groups={groups} {...rest} />;
}

export default ClinicShell;
