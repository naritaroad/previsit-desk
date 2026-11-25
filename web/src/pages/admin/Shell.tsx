import "./lib/admin.css";

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { useAccounts, useAdminOverview } from "@/data";
import { formatUptime } from "@/lib/format";
import { paths } from "@/lib/links";
import { AdminShell } from "@/shells/AdminShell";
import { useLocale, type CommandGroup } from "@/ui";

function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export default function Shell() {
  const { t } = useTranslation("admin");
  const { t: ts } = useTranslation("shell");
  const locale = useLocale();
  const navigate = useNavigate();
  const overview = useAdminOverview();
  const [typed, setTyped] = useState("");
  const q = useDebounced(typed.trim(), 200);
  const accounts = useAccounts({ limit: 12, ...(q ? { q } : {}) });

  const s = overview.data?.system;
  const system = useMemo(
    () =>
      s && [
        { label: t("system.ai"), value: t(s.ai_enabled ? "system.on" : "system.off") },
        { label: t("system.model"), value: t(s.model_ready ? "system.ready" : "system.notReady") },
        { label: t("system.db"), value: t(s.db_ok ? "system.ok" : "system.down") },
        { label: t("system.uptime"), value: formatUptime(s.uptime_s, locale) },
        { label: t("system.version"), value: s.version },
      ],
    [s, t, locale],
  );
  const groups = useMemo<CommandGroup[]>(
    () => [
      {
        id: "accounts",
        title: t("accounts.title"),
        entries: accounts.items.slice(0, 12).map((a) => ({
          id: a.id,
          label: a.display_name,
          hint: [a.username, a.is_guest ? ts("role.guest") : (a.title ?? ts(`role.${a.role}`))].filter(Boolean).join(" "),
          keywords: [a.username ?? "", a.role],
          onSelect: () => void navigate(paths.admin.account(a.id)),
        })),
      },
    ],
    [accounts.items, navigate, t, ts],
  );
  return <AdminShell system={system} commandGroups={groups} onCommandQuery={setTyped} />;
}
