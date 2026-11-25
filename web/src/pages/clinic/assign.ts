// Assigning several things at once, with undo. Each request stands alone: what fails is named, the rest stays done.

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { rxApi, visitsApi } from "@/api/endpoints";
import type { PersonRef, WorkItem } from "@/api/types";
import { qk } from "@/data";
import { toast } from "@/ui";

export type Assignable = Pick<WorkItem, "type" | "id" | "assigned_to">;

const send = (i: Assignable, p: PersonRef | null): Promise<unknown> => (i.type === "visit" ? visitsApi.assign(i.id, p?.id ?? null) : rxApi.assign(i.id, p?.id ?? null));

export function useAssignMany() {
  const { t } = useTranslation(["clinic", "common"]);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const run = async (jobs: { item: Assignable; to: PersonRef | null }[]): Promise<number> => {
    setBusy(true);
    const done = await Promise.allSettled(jobs.map((j) => send(j.item, j.to)));
    setBusy(false);
    for (const key of [qk.clinic, ["rx", "queue"], ["visits", "list"], qk.patients]) void qc.invalidateQueries({ queryKey: key });
    for (const j of jobs) void qc.invalidateQueries({ queryKey: j.item.type === "visit" ? qk.visit(j.item.id) : qk.rxDetail(j.item.id) });
    return done.filter((d) => d.status === "rejected").length;
  };

  /** Tickets have no assignee in the API, so they are left out and counted. */
  const assign = async (items: readonly Assignable[], to: PersonRef | null) => {
    const jobs = items.filter((i) => i.type !== "ticket").map((item) => ({ item, to }));
    const skipped = items.length - jobs.length;
    if (jobs.length === 0) return toast.info(t("assign.ticketsSkipped", { count: skipped }));
    const failed = await run(jobs);
    const ok = jobs.length - failed;
    if (failed > 0) toast.warn(t("assign.failed", { count: failed }));
    if (ok > 0)
      toast.ok([to ? t("assign.done", { count: ok, name: to.display_name }) : t("assign.cleared", { count: ok }), skipped > 0 ? t("assign.ticketsSkipped", { count: skipped }) : ""].filter(Boolean).join(t("common:list.sentenceSep")), {
        action: { label: t("assign.undo"), onClick: () => void run(jobs.map((j) => ({ item: j.item, to: j.item.assigned_to }))) },
      });
  };
  return { assign, busy };
}
