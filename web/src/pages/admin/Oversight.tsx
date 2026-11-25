import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { DateRange, OversightClass, OversightReport } from "@/api/types";
import { useOversight, useSavedFilter, useToday } from "@/data";
import { addDays, formatCount, formatDate, formatNumber, formatPercent } from "@/lib/format";
import { Banner, DataTable, DateField, EmptyState, Field, Ledger, PageBody, PageHeader, Panel, Segmented, SkeletonRows, useLocale } from "@/ui";

import { LoadProblem } from "../pharmacy/shared/problem";
import { CountBars, ShareBar } from "./lib/charts";

const PRESETS = ["30", "90", "180"] as const;

/** Decisions the engine made a prediction about, and how many of them it got the same way as the physician. */
export function agreement(c: OversightClass): { agreed: number | null; of: number } {
  const decided = c.decisions.approve + c.decisions.decline + c.decisions.visit_required;
  const of = Math.max(0, decided - (c.review_decided ?? 0));
  return { agreed: c.agreement_rate === null ? null : Math.round(c.agreement_rate * of), of };
}

export default function Oversight() {
  const { t } = useTranslation("admin");
  const locale = useLocale();
  const today = useToday();
  const [filter, setFilter] = useSavedFilter<{ preset: string }>("admin-oversight", { preset: "90" });
  const [custom, setCustom] = useState<{ from: string | null; to: string | null }>({ from: null, to: null });
  const isCustom = filter.preset === "custom";
  const reversed = Boolean(isCustom && custom.from && custom.to && custom.from > custom.to);
  const range: DateRange = isCustom
    ? reversed
      ? {}
      : { ...(custom.from ? { from: custom.from } : {}), ...(custom.to ? { to: custom.to } : {}) }
    : { from: addDays(today, 1 - Number(PRESETS.find((p) => p === filter.preset) ?? "90")), to: today };
  const o = useOversight(range);
  return (
    <PageBody>
      <PageHeader
        title={t("oversight.title")}
        lede={t("oversight.lede")}
        meta={range.from && range.to ? <span className="num">{t("oversight.range", { from: formatDate(range.from, locale, "short"), to: formatDate(range.to, locale, "short") })}</span> : undefined}
        actions={
          <Segmented
            label={t("oversight.period")}
            value={filter.preset}
            onValueChange={(v) => setFilter({ preset: v })}
            options={[...PRESETS.map((p) => ({ value: p as string, label: t("overview.days", { count: Number(p) }) })), { value: "custom", label: t("oversight.custom") }]}
          />
        }
      />
      {isCustom && (
        <div className="mb-5 flex flex-wrap gap-4">
          <Field label={t("oversight.from")} error={reversed ? t("oversight.reversed") : undefined}>
            <DateField value={custom.from} max={custom.to ?? today} onValueChange={(v) => setCustom({ ...custom, from: v })} />
          </Field>
          <Field label={t("oversight.to")}>
            <DateField value={custom.to} max={today} onValueChange={(v) => setCustom({ ...custom, to: v })} />
          </Field>
        </div>
      )}
      {o.isError && !o.data ? <LoadProblem error={o.error} onRetry={() => void o.refetch()} /> : !o.data ? <SkeletonRows rows={10} /> : <Loaded o={o.data} />}
    </PageBody>
  );
}

function Loaded({ o }: { o: OversightReport }) {
  const { t } = useTranslation("admin");
  const locale = useLocale();
  const hours = (h: number | null) => (h === null ? null : formatNumber(h, locale));
  const total = o.by_class.reduce((n, c) => n + c.total, 0);
  const threshold = o.by_class[0]?.threshold_total;
  const n = (v: number) => formatCount(v, locale);
  return (
    <div className="grid gap-5">
      <Panel title={t("phase.title", { n: o.phase })}>
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <p className="max-w-[40em]">{t("phase.now")}</p>
            <p className="mt-2 max-w-[40em] text-fg-2">{t("phase.noSwitch")}</p>
          </div>
          <div>
            <p className="font-bold">{t("phase.laterTitle")}</p>
            <ol className="mt-1 list-decimal ps-5">
              <li>{threshold === undefined ? t("phase.need1Any") : t("phase.need1", { count: threshold })}</li>
              <li>{t("phase.need2")}</li>
              <li>{t("phase.need3")}</li>
              <li>{t("phase.need4")}</li>
              <li>{t("phase.need5")}</li>
            </ol>
            <p className="mt-2 text-sm text-fg-2">{t("phase.none")}</p>
          </div>
        </div>
      </Panel>

      <Panel title={t("oversight.classes")} meta={<span className="num">{t("oversight.classesMeta", { count: o.by_class.length, total: n(total) })}</span>} flush>
        <DataTable
          caption={t("oversight.classes")}
          rows={o.by_class}
          rowKey={(c) => c.class_id}
          empty={<EmptyState title={t("oversight.empty")}>{t("oversight.emptyBody")}</EmptyState>}
          columns={[
            { id: "c", header: t("oversight.class"), cell: (c) => <span className="font-semibold">{c.class}</span>, sortValue: (c) => c.class, card: "title" },
            {
              id: "n",
              header: t("oversight.progress"),
              cell: (c) => (
                <span className="grid gap-1">
                  <span className="num whitespace-nowrap">
                    <b>{n(c.total)}</b> / {n(c.threshold_total)}
                  </span>
                  <ShareBar part={c.total} whole={c.threshold_total} label={t("oversight.progressLabel", { n: c.total, total: c.threshold_total })} />
                </span>
              ),
              sortValue: (c) => c.total,
              width: "9rem",
            },
            {
              id: "a",
              header: t("oversight.agreement"),
              cell: (c) => {
                const a = agreement(c);
                return c.agreement_rate === null || a.of === 0 ? (
                  <span className="text-fg-3">{t("oversight.noAgreement")}</span>
                ) : (
                  <span className="whitespace-nowrap">
                    <b className="num">{formatPercent(c.agreement_rate, locale)}</b> <span className="num text-sm text-fg-2">{t("oversight.ofN", { agreed: a.agreed, of: a.of })}</span>
                  </span>
                );
              },
              sortValue: (c) => c.agreement_rate,
              width: "11rem",
              card: "end",
            },
            { id: "e", header: t("oversight.engine"), cell: (c) => <Counts rows={(["ready", "review", "in_person", "urgent"] as const).map((k) => [`rx:disposition.${k}`, c.engine[k] ?? 0])} />, width: "17rem", hideBelow: "lg" },
            { id: "d", header: t("oversight.decisions"), cell: (c) => <Counts rows={(["approve", "visit_required", "decline", "more_info"] as const).map((k) => [`rx:outcome.${k}`, c.decisions[k] ?? 0])} />, width: "17rem", hideBelow: "lg" },
            { id: "r", header: t("oversight.review"), cell: (c) => n(c.review_decided ?? 0), align: "end", width: "8rem", hideBelow: "md" },
          ]}
        />
      </Panel>
      <div className="grid gap-2 text-sm text-fg-2">
        <p className="max-w-[60em]">{t("oversight.howAgreement")}</p>
        <p className="max-w-[60em]">{t("oversight.small")}</p>
        <p className="max-w-[60em]">{t("oversight.bias")}</p>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-3">
        <Panel title={t("oversight.turnaround")}>
          <Ledger
            items={[
              { label: t("oversight.median"), value: hours(o.turnaround.median_h) ?? t("oversight.noData"), unit: o.turnaround.median_h === null ? undefined : t("unit.hours") },
              { label: t("oversight.p90"), value: hours(o.turnaround.p90_h) ?? t("oversight.noData"), unit: o.turnaround.p90_h === null ? undefined : t("unit.hours") },
              { label: t("oversight.returned"), value: o.returned_rate === null ? t("oversight.noData") : formatPercent(o.returned_rate, locale, 1) },
            ]}
          />
          <p className="mt-3 text-sm text-fg-2">{t("oversight.turnaroundNote")}</p>
        </Panel>
        <Panel title={t("oversight.redFlags")}>
          <CountBars
            caption={t("oversight.redFlags")}
            head={[t("rulesWords.category"), t("unit.times")]}
            rows={o.red_flags.map((r) => ({ key: r.category, label: t(`pharmacy:redFlag.${r.category}`, { defaultValue: r.category }), n: r.n }))}
            empty={t("oversight.noRedFlags")}
          />
          <p className="mt-3 text-sm text-fg-2">{t("oversight.redNote")}</p>
        </Panel>
        <Panel title={t("oversight.guard")}>
          <CountBars caption={t("oversight.guard")} head={[t("rulesWords.kind"), t("unit.times")]} rows={o.guard.map((g) => ({ key: g.kind, label: t(`guard.${g.kind}`, { defaultValue: g.kind }), n: g.n }))} empty={t("oversight.noGuard")} />
          <p className="mt-3 text-sm text-fg-2">{t("oversight.guardNote")}</p>
        </Panel>
      </div>
      <Banner tone="info" role="note">
        {t("oversight.noPatients")}
      </Banner>
    </div>
  );
}

/** Four counts in one cell, each with its name: a class with three cases must not look like a distribution. */
function Counts({ rows }: { rows: [string, number][] }) {
  const { t } = useTranslation(["admin", "rx"]);
  return (
    <dl className="grid grid-cols-2 gap-x-4 text-sm">
      {rows.map(([key, n]) => (
        <div key={key} className="flex justify-between gap-2">
          <dt className="text-fg-2">{t(key)}</dt>
          <dd className={n === 0 ? "num text-fg-3" : "num font-semibold"}>{n}</dd>
        </div>
      ))}
    </dl>
  );
}
