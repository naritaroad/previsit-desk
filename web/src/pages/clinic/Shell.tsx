import { IconAlertTriangle, IconClockX, IconInbox, IconKeyboard, IconLayoutList, IconPrescription, IconUser, IconUserCheck } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useNavigate } from "react-router";

import { useClinicOverview, usePatients, useRxQueue } from "@/data";
import { paths } from "@/lib/links";
import { ClinicShell } from "@/shells/ClinicShell";
import { WorkspaceContext, type CommandEntry, type CommandGroup } from "@/ui";

import "./clinic.css";
import { ShortcutsDialog } from "./Shortcuts";
import { useClinicDensity, useDebounced } from "./lib";
import { useKey } from "./parts";

/** The connected shell: counts for the rail, records and shortcuts for Ctrl+K, and the density of this workspace. */
export default function Shell() {
  const { t } = useTranslation(["clinic", "rx"]);
  const navigate = useNavigate();
  const overview = useClinicOverview();
  const counts = overview.data?.counts;
  const [density, setDensity] = useClinicDensity();
  const [help, setHelp] = useState(false);
  const [q, setQ] = useState("");
  const found = useDebounced(q.trim(), 200);
  useKey("?", () => setHelp(true));

  const go = (to: string) => () => void navigate(to);
  const groups = useMemo<CommandGroup[]>(
    () => [
      {
        id: "filters",
        title: t("command.filters"),
        entries: [
          { id: "urgent", label: t("command.urgent"), icon: <IconAlertTriangle aria-hidden />, onSelect: go("/clinic/worklist?bucket=urgent") },
          { id: "mine", label: t("command.mine"), icon: <IconUserCheck aria-hidden />, onSelect: go("/clinic/worklist?bucket=mine") },
          { id: "overdue", label: t("command.overdue"), icon: <IconClockX aria-hidden />, onSelect: go("/clinic/rx?bucket=overdue") },
          { id: "today", label: t("command.today"), icon: <IconInbox aria-hidden />, onSelect: go("/clinic/worklist?bucket=pending&only=today") },
        ],
      },
      {
        id: "view",
        title: t("command.view"),
        entries: [
          { id: "density", label: t(density === "compact" ? "command.comfortable" : "command.compact"), icon: <IconLayoutList aria-hidden />, onSelect: () => setDensity(density === "compact" ? "comfortable" : "compact") },
          { id: "keys", label: t("command.keys"), icon: <IconKeyboard aria-hidden />, shortcut: "?", onSelect: () => setHelp(true) },
        ],
      },
    ],
    // go and setDensity are stable enough: they only read the router and the preferences.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, density],
  );
  const records = useRecordCommands(found);

  return (
    <ClinicShell counts={counts && { worklist: counts.pending, urgent: counts.urgent, rx: counts.rx_review, tickets: counts.tickets }} commandGroups={[...records, ...groups]} onCommandQuery={setQ}>
      <WorkspaceContext value={{ ws: "clinic", density }}>
        <div className="clinic-density" data-density={density}>
          <Outlet />
        </div>
        <ShortcutsDialog open={help} onOpenChange={setHelp} />
      </WorkspaceContext>
    </ClinicShell>
  );
}

/** Patients by name and requests by number, drug or name, while someone types in the palette. */
function useRecordCommands(q: string): CommandGroup[] {
  const { t } = useTranslation(["clinic", "rx"]);
  const navigate = useNavigate();
  const on = q.length > 0;
  const patients = usePatients(on ? { q, limit: 6 } : { limit: 6 });
  const rx = useRxQueue(undefined, on ? q : undefined);
  if (!on) return [];
  const people: CommandEntry[] = patients.items.slice(0, 6).map((r) => ({
    id: r.patient.id,
    label: r.patient.display_name,
    hint: [r.age === null ? null : t("patient.age", { n: r.age }), ...r.conditions.slice(0, 2)].filter(Boolean).join(t("patient.dot")),
    keywords: [q],
    icon: <IconUser aria-hidden />,
    onSelect: () => void navigate(paths.clinic.patient(r.patient.id)),
  }));
  const requests: CommandEntry[] = rx.items.slice(0, 6).map((r) => ({
    id: r.id,
    label: `${r.no} ${r.patient.display_name}`,
    hint: t(`rx:status.${r.status}`),
    keywords: [q, ...r.drug_names],
    icon: <IconPrescription aria-hidden />,
    onSelect: () => void navigate(paths.clinic.rx(r.id)),
  }));
  return [
    { id: "patients", title: t("command.patients"), entries: people },
    { id: "rx", title: t("command.requests"), entries: requests },
  ];
}
