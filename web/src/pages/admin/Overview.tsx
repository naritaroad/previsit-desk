import { IconChartBar, IconTable } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { AdminOverview, UsageDay } from "@/api/types";
import { useAdminOverview, useAudit, useSavedFilter } from "@/data";
import { formatCompact, formatCount, formatDate, formatDateTime, formatPercent, formatTime, formatUptime, formatUsd } from "@/lib/format";
import { Banner, ButtonLink, DataTable, DescriptionList, Ledger, PageBody, PageHeader, Panel, Progress, Segmented, Skeleton, SkeletonRows, StatusTag, TextLink, Timeline, useLocale } from "@/ui";

import { LoadProblem } from "../pharmacy/shared/problem";
import { personName } from "../pharmacy/shared/names";
import { useAuditText } from "./lib/audit";
import { DayBars } from "./lib/charts";

const DAYS = ["7", "14", "30", "90"] as const;
const QUEUES = ["visits_pending", "red_flag", "rx_review", "rx_overdue", "rx_more_info", "rx_pharmacy", "tickets_open"] as const;
/** Say it before it happens: the calls or the money are about to run out. */
const NEARLY = 0.8;

export default function Overview() {
  const { t } = useTranslation("admin");
  const locale = useLocale();
  const [filter, setFilter] = useSavedFilter<{ days: string; view: string }>("admin-overview", { days: "14", view: "chart" });
  const days = DAYS.find((d) => d === filter.days) ?? "14";
  const o = useAdminOverview(Number(days));
  return (
    <PageBody>
      <PageHeader
        title={t("overview.title")}
        lede={t("overview.lede")}
        meta={o.dataUpdatedAt ? <span>{t("overview.updated", { time: formatTime(new Date(o.dataUpdatedAt), locale) })}</span> : undefined}
        actions={
          <>
            <Segmented label={t("overview.range")} value={days} onValueChange={(v) => setFilter({ days: v })} options={DAYS.map((d) => ({ value: d, label: t("overview.days", { count: Number(d) }) }))} />
            <Segmented
              label={t("overview.view")}
              value={filter.view}
              onValueChange={(v) => setFilter({ view: v })}
              options={[
                { value: "chart", label: <span className="inline-flex items-center gap-1.5"><IconChartBar size={18} aria-hidden />{t("overview.chart")}</span> },
                { value: "table", label: <span className="inline-flex items-center gap-1.5"><IconTable size={18} aria-hidden />{t("overview.table")}</span> },
              ]}
            />
          </>
        }
      />
      {o.isError && !o.data ? (
        <Panel>
          <LoadProblem error={o.error} onRetry={() => void o.refetch()} />
        </Panel>
      ) : !o.data ? (
        <Loading />
      ) : (
        <Loaded o={o.data} view={filter.view} />
      )}
    </PageBody>
  );
}

function Loading() {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.9fr)_minmax(19rem,1fr)]">
      <Panel>
        <div className="grid gap-8 md:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      </Panel>
      <Panel flush>
        <SkeletonRows rows={7} />
      </Panel>
    </div>
  );
}

function Loaded({ o, view }: { o: AdminOverview; view: string }) {
  const { t } = useTranslation("admin");
  const locale = useLocale();
  const { totals, series, queues, system } = o;
  const count = (n: number) => formatCount(n, locale);
  const usd = (n: number) => formatUsd(n, locale);
  const pick = (f: (d: UsageDay) => number) => series.map((d) => ({ day: d.day, value: f(d) }));
  const noPrice = totals.model_calls > 0 && totals.cost_usd === 0;
  const callsNear = totals.daily_call_limit > 0 && totals.calls_today >= totals.daily_call_limit * NEARLY;
  const budget = totals.month_budget_usd;
  const overBudget = budget !== null && totals.month_cost_usd >= budget;
  const nearBudget = budget !== null && !overBudget && totals.month_cost_usd >= budget * NEARLY;

  return (
    <>
      <div className="mb-5 grid gap-3 empty:hidden">
        {!system.db_ok && <Banner tone="warn" role="alert">{t("alert.db")}</Banner>}
        {!system.ai_enabled && (
          <Banner tone="warn" title={t("alert.aiOff")} actions={<ButtonLink size="sm" to="/admin/ai">{t("alert.openAi")}</ButtonLink>}>
            {t("alert.aiOffBody")}
          </Banner>
        )}
        {system.ai_enabled && !system.model_ready && (
          <Banner tone="warn" title={t("alert.model")} actions={<ButtonLink size="sm" to="/admin/ai">{t("alert.openAi")}</ButtonLink>}>
            {t("alert.modelBody")}
          </Banner>
        )}
        {(overBudget || nearBudget) && (
          <Banner tone="warn" title={t(overBudget ? "alert.budgetOver" : "alert.budgetNear")} actions={<ButtonLink size="sm" to="/admin/ai">{t("alert.openAi")}</ButtonLink>}>
            {t("alert.budgetBody", { spent: usd(totals.month_cost_usd), budget: usd(budget) })}
          </Banner>
        )}
        {callsNear && (
          <Banner tone="warn" title={t("alert.calls")}>
            {t("alert.callsBody", { used: count(totals.calls_today), limit: count(totals.daily_call_limit) })}
          </Banner>
        )}
        {(queues.red_flag ?? 0) > 0 && <Banner tone="info">{t("alert.redFlag", { count: queues.red_flag })}</Banner>}
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.9fr)_minmax(19rem,1fr)]">
        <div className="grid min-w-0 gap-5">
          <Panel title={t("overview.volume", { count: series.length })} flush={view === "table"}>
            {view === "table" ? (
              <DataTable
                caption={t("overview.volume", { count: series.length })}
                rows={[...series].reverse()}
                rowKey={(d) => d.day}
                maxHeight="36rem"
                columns={[
                  { id: "d", header: t("overview.day"), cell: (d) => formatDate(d.day, locale, "medium"), sortValue: (d) => d.day, nowrap: true, card: "title" },
                  { id: "v", header: t("measure.visits"), cell: (d) => count(d.visits), sortValue: (d) => d.visits, align: "end" },
                  { id: "x", header: t("measure.rx"), cell: (d) => count(d.rx), sortValue: (d) => d.rx, align: "end" },
                  { id: "r", header: t("measure.red_flags"), cell: (d) => count(d.red_flags), sortValue: (d) => d.red_flags, align: "end" },
                  { id: "c", header: t("measure.model_calls"), cell: (d) => count(d.model_calls), sortValue: (d) => d.model_calls, align: "end" },
                  { id: "i", header: t("measure.input_tokens"), cell: (d) => count(d.input_tokens), sortValue: (d) => d.input_tokens, align: "end", hideBelow: "lg" },
                  { id: "o", header: t("measure.output_tokens"), cell: (d) => count(d.output_tokens), sortValue: (d) => d.output_tokens, align: "end", hideBelow: "lg" },
                  { id: "u", header: t("measure.cost_usd"), cell: (d) => usd(d.cost_usd), sortValue: (d) => d.cost_usd, align: "end" },
                ]}
              />
            ) : (
              <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
                <DayBars title={t("measure.visits")} data={pick((d) => d.visits)} format={count} />
                <DayBars title={t("measure.rx")} data={pick((d) => d.rx)} format={count} />
                <DayBars title={t("measure.red_flags")} data={pick((d) => d.red_flags)} format={count} />
                <DayBars title={t("measure.model_calls")} data={pick((d) => d.model_calls)} format={count} axis={(n) => formatCompact(n, locale)} />
                <DayBars title={t("measure.tokens")} data={pick((d) => d.input_tokens + d.output_tokens)} format={count} axis={(n) => formatCompact(n, locale)} />
                <DayBars title={t("measure.cost_usd")} data={pick((d) => d.cost_usd)} format={usd} axis={(n) => formatUsd(n, locale)} whole={false} note={noPrice ? <NoPrice /> : undefined} />
              </div>
            )}
          </Panel>
          <Activity />
        </div>

        <div className="grid min-w-0 gap-5">
          <Panel title={t("overview.ai")} actions={<ButtonLink size="sm" to="/admin/ai#switch">{t("overview.openSwitch")}</ButtonLink>}>
            <div className="grid gap-4">
              <p className="flex flex-wrap items-center gap-2">
                <StatusTag family="account" status={system.ai_enabled ? "active" : "disabled"} />
                <span>{t(system.ai_enabled ? "overview.aiOn" : "overview.aiOff")}</span>
              </p>
              <Meter label={t("overview.callsToday")} value={totals.calls_today} max={totals.daily_call_limit} text={t("overview.ofLimit", { used: count(totals.calls_today), limit: count(totals.daily_call_limit) })} />
              {budget === null ? (
                <div>
                  <p className="text-sm text-fg-2">{t("overview.monthCost")}</p>
                  <p className="num font-semibold">{usd(totals.month_cost_usd)}</p>
                  <p className="text-sm text-fg-2">{t("overview.noBudget")}</p>
                </div>
              ) : (
                <Meter label={t("overview.monthCost")} value={totals.month_cost_usd} max={budget} text={t("overview.ofLimit", { used: usd(totals.month_cost_usd), limit: usd(budget) })} />
              )}
              {noPrice && (
                <div className="text-sm text-fg-2">
                  <NoPrice />
                </div>
              )}
            </div>
          </Panel>
          <Panel title={t("overview.queues")}>
            <Ledger items={QUEUES.filter((k) => k in queues).map((k) => ({ label: t(`queue.${k}`), value: count(queues[k]), unit: t("unit.items") }))} />
            <p className="mt-3 text-sm text-fg-2">{t("overview.queuesNote")}</p>
          </Panel>
          <Panel title={t("overview.people")}>
            <Ledger
              items={[
                { label: t("overview.patients"), value: count(totals.patients) },
                { label: t("overview.guests"), value: count(totals.guests) },
                { label: t("overview.staff"), value: count(totals.staff) },
              ]}
            />
          </Panel>
          <Panel title={t("overview.system")}>
            <DescriptionList
              items={[
                { label: t("system.version"), value: <span className="num">{system.version}</span> },
                { label: t("system.db"), value: t(system.db_ok ? "system.ok" : "system.down") },
                { label: t("system.model"), value: t(system.model_ready ? "system.readyLong" : "system.notReadyLong") },
                { label: t("system.uptime"), value: formatUptime(system.uptime_s, locale) },
              ]}
            />
          </Panel>
        </div>
      </div>
    </>
  );
}

function NoPrice() {
  const { t } = useTranslation("admin");
  return (
    <>
      {t("overview.noPrice")} <TextLink to="/admin/ai#prices">{t("overview.setPrice")}</TextLink>
    </>
  );
}

function Meter({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  const locale = useLocale();
  return (
    <div>
      <p className="flex flex-wrap justify-between gap-x-3 text-sm">
        <span className="text-fg-2">{label}</span>
        <span className="num">{max > 0 ? formatPercent(value / max, locale) : ""}</span>
      </p>
      <Progress className="my-1" label={label} value={Math.min(value, max)} max={max || 1} />
      <p className="num font-semibold">{text}</p>
    </div>
  );
}

function Activity() {
  const { t } = useTranslation("admin");
  const locale = useLocale();
  const words = useAuditText();
  const audit = useAudit({ limit: 8, kind: "admin" });
  const [open] = useState(8);
  return (
    <Panel title={t("overview.activity")} actions={<ButtonLink size="sm" to="/admin/audit">{t("overview.allAudit")}</ButtonLink>}>
      {audit.isError && !audit.data ? (
        <LoadProblem error={audit.error} onRetry={() => void audit.refetch()} />
      ) : !audit.data ? (
        <SkeletonRows rows={4} />
      ) : audit.items.length === 0 ? (
        <p className="text-fg-2">{t("overview.noActivity")}</p>
      ) : (
        <Timeline
          label={t("overview.activity")}
          items={audit.items.slice(0, open).map((a, i) => ({ id: `${a.at}:${i}`, time: formatDateTime(a.at, locale), dateTime: a.at, what: words.action(a.action), who: personName(a.actor), detail: words.detail(a) || undefined }))}
        />
      )}
    </Panel>
  );
}
