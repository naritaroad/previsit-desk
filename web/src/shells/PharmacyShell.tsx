import { IconClipboardList, IconGavel, IconHistory, IconPill } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";

import type { CommandGroup } from "@/ui";

import type { NavGroup } from "./parts";
import { StaffShell } from "./StaffShell";

/** Dispensing stages, left to right in the order the work happens. */
export const PHARMACY_STAGES = ["check", "prepare", "ready", "returned", "done"] as const;
export type PharmacyStage = (typeof PHARMACY_STAGES)[number];

export interface PharmacyShellProps {
  counts?: Partial<Record<PharmacyStage, number>>;
  commandGroups?: CommandGroup[];
  onCommandQuery?: (q: string) => void;
  children?: ReactNode;
}

export function PharmacyShell({ counts = {}, ...rest }: PharmacyShellProps) {
  const { t } = useTranslation("shell");
  const groups: NavGroup[] = [
    {
      items: [
        { to: "/pharmacy", label: t("pharmacy.queue"), icon: IconClipboardList, end: true },
        { to: "/pharmacy/history", label: t("pharmacy.history"), icon: IconHistory },
        { to: "/pharmacy/formulary", label: t("pharmacy.formulary"), icon: IconPill },
        { to: "/pharmacy/rules", label: t("pharmacy.rules"), icon: IconGavel },
      ],
    },
  ];
  const board = (
    <nav className="board no-print" aria-label={t("pharmacy.board")}>
      {PHARMACY_STAGES.map((s) => {
        const n = counts[s];
        return (
          <NavLink key={s} to={`/pharmacy/queue/${s}`} data-zero={n === 0}>
            <span className="n">{n ?? "–"}</span>
            <span className="t">{t(`pharmacy.stage.${s}`)}</span>
          </NavLink>
        );
      })}
    </nav>
  );
  return <StaffShell ws="pharmacy" home="/pharmacy" groups={groups} strip={board} {...rest} />;
}

export default PharmacyShell;
