import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { RxRequestBrief, RxStatus } from "@/api/types";
import { useMe, useRxList, useSavedFilter } from "@/data";
import { formatDateTime } from "@/lib/format";
import { paths } from "@/lib/links";
import { Badge, Button, DataTable, EmptyState, FilterBar, LoadMore, PageBody, PageHeader, Panel, SearchInput, Segmented, StatusTag, useLocale } from "@/ui";

import { personName } from "./shared/names";
import { LoadProblem } from "./shared/problem";

const VIEWS = ["dispensed", "returned", "in_review", "cancelled"] as const satisfies readonly RxStatus[];

/** Requests after the counter: handed out, returned, sent back to a physician, cancelled. */
export default function History() {
  const { t } = useTranslation("pharmacy");
  const { t: tr } = useTranslation("rx");
  const locale = useLocale();
  const me = useMe();
  const [filter, setFilter] = useSavedFilter<{ status: string; mine: boolean }>("pharmacy-history", { status: "dispensed", mine: false });
  const [q, setQ] = useState("");
  const status = VIEWS.find((v) => v === filter.status) ?? "dispensed";
  const list = useRxList({ status, ...(q.trim() ? { q: q.trim() } : {}) });
  const needle = q.trim().toLowerCase();
  const rows: RxRequestBrief[] = list.items.filter((r) => r.status === status && (!filter.mine || r.assigned_to?.id === me?.id) && (!needle || `${r.no} ${r.patient.display_name} ${r.drug_names.join(" ")}`.toLowerCase().includes(needle)));
  return (
    <PageBody>
      <PageHeader title={t("history.title")} lede={t("history.lede")} />
      <Segmented
        className="mb-4"
        label={t("history.filter")}
        value={status}
        onValueChange={(v) => setFilter({ status: v })}
        options={VIEWS.map((v) => ({ value: v, label: t(`history.view.${v}`) }))}
      />
      <Panel flush>
        <FilterBar search={<SearchInput value={q} onValueChange={setQ} placeholder={t("queue.search")} />}>
          <Button aria-pressed={filter.mine} variant={filter.mine ? "soft" : "secondary"} onClick={() => setFilter({ mine: !filter.mine })}>
            {t("history.mine")}
          </Button>
        </FilterBar>
        {list.isError && !list.data ? (
          <LoadProblem error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <DataTable
            caption={t("history.title")}
            rows={list.data ? rows : undefined}
            loading={!list.data}
            rowKey={(r) => r.id}
            rowLink={(r) => paths.pharmacy.rx(r.id)}
            empty={<EmptyState title={needle || filter.mine ? t("queue.noMatch") : t(`history.empty.${status}`)}>{status === "in_review" ? t("history.inReviewNote") : undefined}</EmptyState>}
            footer={list.hasNextPage ? t("history.loaded", { count: rows.length }) : t("queue.count", { count: rows.length })}
            columns={[
              { id: "n", header: t("queue.no"), cell: (r) => <span className="num font-semibold">{r.no}</span>, nowrap: true, width: "12.5rem", card: "title" },
              { id: "p", header: t("queue.patient"), cell: (r) => <span className="font-semibold">{r.patient.display_name}</span>, width: "9rem" },
              { id: "d", header: t("queue.drugs"), cell: (r) => r.drug_names.join(t("listSep")) },
              { id: "k", header: t("queue.kind"), cell: (r) => <Badge tone={r.kind === "refill" ? "ink" : "info"}>{tr(`kind.${r.kind}`)}</Badge>, width: "7.5rem", hideBelow: "lg" },
              { id: "s", header: t("queue.stage"), cell: (r) => <StatusTag family="rx" status={r.status} />, width: "9rem", card: "end", hideBelow: "lg" },
              { id: "a", header: t("queue.handler"), cell: (r) => (r.assigned_to ? personName(r.assigned_to) : <span className="text-fg-3">{t("queue.noHandler")}</span>), width: "10rem" },
              { id: "u", header: t("history.updated"), cell: (r) => formatDateTime(r.updated_at, locale), sortValue: (r) => r.updated_at, align: "end", nowrap: true, width: "12rem" },
            ]}
          />
        )}
        {list.hasNextPage && <LoadMore onLoad={() => void list.fetchNextPage()} loading={list.isFetchingNextPage} />}
      </Panel>
    </PageBody>
  );
}
