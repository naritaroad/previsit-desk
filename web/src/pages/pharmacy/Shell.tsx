import { useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { paths } from "@/lib/links";
import { PHARMACY_STAGES, PharmacyShell } from "@/shells/PharmacyShell";
import { StatusTag, type CommandGroup } from "@/ui";

import { useBoard } from "./board";

/** Counts for the board, and the open requests in the palette. Today's work is already loaded, so search is instant. */
export default function Shell() {
  const { t } = useTranslation("pharmacy");
  const navigate = useNavigate();
  const { rows, counts } = useBoard();
  const [typed, setTyped] = useState("");
  const q = useDeferredValue(typed.trim().toLowerCase());
  const groups = useMemo<CommandGroup[]>(() => {
    const all = PHARMACY_STAGES.flatMap((s) => rows[s]);
    const hit = q ? all.filter((r) => `${r.no} ${r.patient.display_name} ${r.drug_names.join(" ")}`.toLowerCase().includes(q)) : all;
    return [
      {
        id: "rx",
        title: t("queue.paletteTitle"),
        entries: hit.slice(0, 12).map((r) => ({
          id: r.id,
          label: `${r.no} ${r.patient.display_name}`,
          hint: <StatusTag family="rx" status={r.status} plain />,
          keywords: r.drug_names,
          onSelect: () => void navigate(paths.pharmacy.rx(r.id)),
        })),
      },
    ];
  }, [rows, q, navigate, t]);
  return <PharmacyShell counts={counts} commandGroups={groups} onCommandQuery={setTyped} />;
}
