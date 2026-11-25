import { useTranslation } from "react-i18next";

import type { RunStatus } from "@/api/types";
import { useModels, useRuns, useSavedFilter } from "@/data";
import { formatCount, formatDateTime, formatDuration, formatUsd } from "@/lib/format";
import { Badge, Callout, DataTable, EmptyState, FilterBar, LoadMore, NativeSelect, PageBody, PageHeader, Panel, Segmented, StatusTag, useLocale } from "@/ui";

import { LoadProblem } from "../pharmacy/shared/problem";
import { shortId } from "./lib/audit";
import { useRunText } from "./lib/runs";

const STATUSES: readonly RunStatus[] = ["running", "completed", "failed", "interrupted", "skipped"];

export default function Runs() {
  const { t } = useTranslation("admin");
  const { t: tc } = useTranslation("common");
  const locale = useLocale();
  const words = useRunText();
  const models = useModels();
  const [filter, setFilter, reset] = useSavedFilter<{ status: string; model: string }>("admin-runs", { status: "all", model: "all" });
  const status = STATUSES.find((s) => s === filter.status);
  const runs = useRuns({ ...(status ? { status } : {}), ...(filter.model === "all" ? {} : { model: filter.model }) });
  // A model that left the whitelist still has runs; offer what is on the page too.
  const names = [...new Set([...(models.data ?? []), ...runs.items.map((r) => r.model), ...(filter.model === "all" ? [] : [filter.model])])].sort();
  const filtered = status !== undefined || filter.model !== "all";
  return (
    <PageBody>
      <PageHeader title={t("runs.title")} lede={t("runs.lede")} />
      <Callout tone="info" className="mb-5">
        {t("runs.noText")}
      </Callout>
      <Segmented
        className="mb-4"
        label={t("runs.status")}
        value={status ?? "all"}
        onValueChange={(v) => setFilter({ status: v })}
        options={[{ value: "all", label: t("runs.all") }, ...STATUSES.map((s) => ({ value: s as string, label: tc(`status.run.${s}`) }))]}
      />
      <Panel flush>
        <FilterBar chips={filter.model === "all" ? [] : [{ key: "m", label: filter.model, onRemove: () => setFilter({ model: "all" }) }]} onClearAll={reset}>
          <label className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-fg-2">{t("runs.model")}</span>
            <NativeSelect value={filter.model} onChange={(e) => setFilter({ model: e.target.value })}>
              <option value="all">{t("runs.allModels")}</option>
              {names.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </NativeSelect>
          </label>
        </FilterBar>
        {runs.isError && !runs.data ? (
          <LoadProblem error={runs.error} onRetry={() => void runs.refetch()} />
        ) : (
          <DataTable
            caption={t("runs.title")}
            rows={runs.data ? runs.items : undefined}
            loading={!runs.data}
            rowKey={(r) => r.id}
            rowLink={(r) => `/admin/runs/${encodeURIComponent(r.id)}`}
            empty={<EmptyState title={t(filtered ? "runs.noMatch" : "runs.empty")}>{t(filtered ? "runs.noMatchBody" : "runs.emptyBody")}</EmptyState>}
            footer={t(runs.hasNextPage ? "runs.loaded" : "runs.count", { count: runs.items.length })}
            columns={[
              { id: "t", header: t("runs.time"), cell: (r) => formatDateTime(r.created_at, locale), sortValue: (r) => r.created_at, nowrap: true, width: "12rem", card: "title" },
              { id: "s", header: t("runs.status"), cell: (r) => <StatusTag family="run" status={r.status} />, sortValue: (r) => r.status, width: "8.5rem", card: "end" },
              {
                id: "m",
                header: t("runs.model"),
                cell: (r) => (
                  <span className="flex flex-wrap items-center gap-x-2">
                    <code className="text-sm break-all">{r.model || t("runs.noModel")}</code>
                    {r.fallback_used && <Badge tone="hold">{t("runs.fallback")}</Badge>}
                  </span>
                ),
                width: "14rem",
              },
              { id: "o", header: t("runs.tools"), cell: (r) => (r.tools.length > 0 ? <span className="text-sm">{r.tools.map((x) => words.tool(x.name)).join(t("runs.arrow"))}</span> : <span className="text-fg-3">{t("settings.none")}</span>), hideBelow: "lg" },
              { id: "e", header: t("runs.error"), cell: (r) => (r.error_code ? words.error(r.error_code) : <span className="text-fg-3">{t("settings.none")}</span>), width: "10rem", hideBelow: "md" },
              { id: "n", header: t("runs.steps"), cell: (r) => r.steps, sortValue: (r) => r.steps, align: "end", width: "5rem", hideBelow: "xl" },
              { id: "k", header: t("runs.tokens"), cell: (r) => `${formatCount(r.usage.input_tokens, locale)} / ${formatCount(r.usage.output_tokens, locale)}`, sortValue: (r) => r.usage.input_tokens + r.usage.output_tokens, align: "end", nowrap: true, width: "9rem", hideBelow: "md" },
              { id: "c", header: t("runs.cost"), cell: (r) => formatUsd(r.cost_usd, locale), sortValue: (r) => r.cost_usd, align: "end", width: "6.5rem", hideBelow: "lg" },
              { id: "d", header: t("runs.duration"), cell: (r) => formatDuration(r.duration_ms), sortValue: (r) => r.duration_ms, align: "end", nowrap: true, width: "6rem" },
              { id: "v", header: t("runs.visit"), cell: (r) => <code className="text-sm">{shortId(r.visit_id)}</code>, width: "6.5rem", hideBelow: "xl" },
            ]}
          />
        )}
        {runs.hasNextPage && <LoadMore onLoad={() => void runs.fetchNextPage()} loading={runs.isFetchingNextPage} />}
      </Panel>
    </PageBody>
  );
}
