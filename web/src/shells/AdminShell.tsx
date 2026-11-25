import { IconActivity, IconAdjustments, IconChartBar, IconDatabase, IconGavel, IconHome, IconKey, IconListSearch, IconReportAnalytics, IconUsers } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";

import type { CommandGroup } from "@/ui";

import type { NavGroup } from "./parts";
import { Crumbs, StaffShell } from "./StaffShell";

export interface AdminShellProps {
  /** Facts for the system line: version, model, database, AI switch. */
  system?: { label: string; value: ReactNode }[];
  commandGroups?: CommandGroup[];
  onCommandQuery?: (q: string) => void;
  children?: ReactNode;
}

const SECTIONS = ["accounts", "permissions", "ai", "oversight", "runs", "audit", "rules", "eval", "data", "settings", "notifications"] as const;

export function AdminShell({ system, ...rest }: AdminShellProps) {
  const { t } = useTranslation("shell");
  const { pathname } = useLocation();
  const groups: NavGroup[] = [
    { items: [{ to: "/admin", end: true, label: t("admin.overview"), icon: IconHome }] },
    {
      title: t("admin.people"),
      items: [
        { to: "/admin/accounts", label: t("admin.accounts"), icon: IconUsers },
        { to: "/admin/permissions", label: t("admin.permissions"), icon: IconKey },
      ],
    },
    {
      title: t("admin.ai_group"),
      items: [
        { to: "/admin/ai", label: t("admin.ai"), icon: IconAdjustments },
        { to: "/admin/oversight", label: t("admin.oversight"), icon: IconChartBar },
        { to: "/admin/runs", label: t("admin.runs"), icon: IconActivity },
        { to: "/admin/eval", label: t("admin.eval"), icon: IconReportAnalytics },
        { to: "/admin/rules", label: t("admin.rules"), icon: IconGavel },
      ],
    },
    {
      title: t("admin.records"),
      items: [
        { to: "/admin/audit", label: t("admin.audit"), icon: IconListSearch },
        { to: "/admin/data", label: t("admin.data"), icon: IconDatabase },
      ],
    },
  ];
  const [, , section, detail] = pathname.split("/");
  const known = SECTIONS.find((s) => s === section);
  const crumbs = [
    { label: t("ws.admin"), to: "/admin" },
    ...(known ? [{ label: t(`admin.${known}`), to: `/admin/${known}` }] : section ? [] : [{ label: t("admin.overview") }]),
    ...(detail ? [{ label: t("admin.detail") }] : []),
  ];
  return (
    <StaffShell
      ws="admin"
      home="/admin"
      groups={groups}
      topStart={<Crumbs items={crumbs} />}
      strip={
        system && (
          <aside className="sysline no-print" aria-label={t("admin.system")}>
            {system.map((s) => (
              <span key={s.label}>
                {s.label} <b>{s.value}</b>
              </span>
            ))}
          </aside>
        )
      }
      {...rest}
    />
  );
}

export default AdminShell;
