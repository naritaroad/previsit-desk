import { IconChartBar } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import type { Disposition, OversightClass, RxOutcome } from "@/api/types";
import { useOversight, useToday } from "@/data";
import { addDays, isValidDate } from "@/lib/format";
import { DataTable, DateField, EmptyState, Ledger, PageBody, PageHeader, Panel, Progress, Section, Segmented, Skeleton, TextLink, statusIcon, statusTone } from "@/ui";

import { useFmt, useUrlState } from "./lib";
import { PageError, StaleBar } from "./parts";

const DISPOSITIONS: readonly Disposition[] = ["ready", "review", "in_person", "urgent", "excluded"];
const OUTCOMES: readonly RxOutcome[] = ["approve", "visit_required", "decline", "more_info"];
const FEW = 20;
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const decidedOf = (c: OversightClass) => c.decisions.approve + c.decisions.visit_required + c.decisions.decline;

/** How the check and physicians compare, always with how many cases a figure rests on. */
export default function Oversight() {
  const { t } = useTranslation(["clinic", "rx"]);
  const fmt = useFmt();
  const today = useToday();
  const [url, set] = useUrlState({ days: "90", from: "", to: "" });
  const custom = isValidDate(url.from) && isValidDate(url.to);
  const from = custom ? url.from : addDays(today, -(Number(url.days) || 90));
  const to = custom ? url.to : today;
  const query = useOversight({ from, to });
  const d = query.data;
  if (!d && query.isError)
    return (
      <PageBody>
        <PageError error={query.error} onRetry={() => void query.refetch()} />
      </PageBody>
    );
  const classes = d?.by_class ?? [];
  const total = sum(classes.map((c) => c.total));
  const decided = sum(classes.map(decidedOf));
  return (
    <>
      <StaleBar query={query} />
      <PageBody>
        <PageHeader
          title={t("oversight.title")}
          lede={t("oversight.lede")}
          actions={
            <>
              <Segmented
                label={t("oversight.range")}
                value={custom ? "" : url.days}
                onValueChange={(days) => set({ days, from: "", to: "" })}
                options={["7", "30", "90"].map((value) => ({ value, label: t("oversight.days", { count: Number(value) }) }))}
              />
              <span className="inline-flex items-center gap-1.5">
                <DateField className="w-38" aria-label={t("oversight.from")} value={from} max={to} onValueChange={(v) => v && set({ from: v, to })} />
                <span aria-hidden="true">{t("oversight.to_sep")}</span>
                <DateField className="w-38" aria-label={t("oversight.to")} value={to} max={today} onValueChange={(v) => v && set({ from, to: v })} />
              </span>
            </>
          }
          meta={<span className="num">{t("oversight.rangeIs", { from: fmt.date(from, "long"), to: fmt.date(to, "long") })}</span>}
        />
        <Panel title={t("oversight.phaseTitle", { n: d?.phase ?? 1 })}>
          <p className="max-w-[46em]">{t("oversight.phaseBody")}</p>
          <p className="mt-2 max-w-[46em] text-fg-2">{t("oversight.phaseNext")}</p>
        </Panel>

        <Section title={t("oversight.byClass")}>
          <p className="mb-3 max-w-[52em] text-sm text-fg-2">
            {t("oversight.formula")} {t("oversight.notPressure")}
          </p>
          <Panel flush>
            <DataTable
                caption={t("oversight.byClass")}
                rows={d ? classes : undefined}
                loading={!d}
                rowKey={(c) => c.class_id}
                empty={
                  <EmptyState icon={<IconChartBar aria-hidden />} title={t("oversight.empty")}>
                    {t("oversight.emptyBody")}
                  </EmptyState>
                }
                columns={[
                  { id: "class", header: t("oversight.col.class"), width: "11rem", card: "title", sortValue: (c) => c.class, cell: (c) => <span className="font-semibold">{c.class}</span> },
                  {
                    id: "total",
                    header: t("oversight.col.total"),
                    width: "9.5rem",
                    sortValue: (c) => c.total,
                    cell: (c) => (
                      <span className="grid gap-1">
                        <span className="num">{t("oversight.ofThreshold", { n: c.total, total: c.threshold_total })}</span>
                        <Progress value={Math.min(c.total, c.threshold_total)} max={c.threshold_total} label={t("oversight.ofThreshold", { n: c.total, total: c.threshold_total })} />
                      </span>
                    ),
                  },
                  { id: "engine", header: t("oversight.col.engine"), cell: (c) => <Split label={t("oversight.col.engine")} family="disposition" parts={DISPOSITIONS.map((k) => [k, c.engine[k] ?? 0])} /> },
                  { id: "decisions", header: t("oversight.col.decisions"), cell: (c) => <Split label={t("oversight.col.decisions")} family="outcome" parts={OUTCOMES.map((k) => [k, c.decisions[k] ?? 0])} /> },
                  {
                    id: "agree",
                    header: t("oversight.col.agree"),
                    width: "11rem",
                    card: "end",
                    sortValue: (c) => c.agreement_rate,
                    cell: (c) =>
                      c.agreement_rate === null ? (
                        <span className="text-fg-3">{t("oversight.noRate")}</span>
                      ) : (
                        <>
                          <span className="num text-md font-semibold">{fmt.percent(c.agreement_rate)}</span>
                          <span className="num block text-sm text-fg-2">{t("oversight.base", { count: decidedOf(c) })}</span>
                          {decidedOf(c) < FEW && <span className="block text-sm text-fg-2">{t("oversight.few")}</span>}
                        </>
                      ),
                  },
                ]}
              />
          </Panel>
          <p className="num mt-2 text-sm text-fg-2">{t("oversight.totals", { total, decided })}</p>
        </Section>

        <div className="record-cols mt-7">
          <Section title={t("oversight.time")}>
            {d ? (
              <Ledger
                items={[
                  { label: t("oversight.median"), value: d.turnaround.median_h === null ? t("oversight.noRate") : d.turnaround.median_h.toFixed(1), unit: t("oversight.hours") },
                  { label: t("oversight.p90"), value: d.turnaround.p90_h === null ? t("oversight.noRate") : d.turnaround.p90_h.toFixed(1), unit: t("oversight.hours") },
                  { label: t("oversight.returned"), value: d.returned_rate === null ? t("oversight.noRate") : fmt.percent(d.returned_rate) },
                ]}
              />
            ) : (
              <Skeleton className="h-24" />
            )}
            <p className="mt-2 text-sm text-fg-2">{t("oversight.timeNote")}</p>
          </Section>
          <Section title={t("oversight.red")}>
            {d ? <Counts rows={d.red_flags.map((r) => ({ label: t(`redFlag.${r.category}`), n: r.n }))} empty={t("oversight.noRed")} /> : <Skeleton className="h-24" />}
            <p className="mt-2 text-sm">
              <TextLink to="/clinic/rules?tab=red_flags">{t("oversight.seeRules")}</TextLink>
            </p>
          </Section>
          <Section title={t("oversight.guard")}>
            {d ? <Counts rows={d.guard.map((r) => ({ label: t(`guard.${r.kind}`), n: r.n }))} empty={t("oversight.noGuard")} /> : <Skeleton className="h-24" />}
            <p className="mt-2 text-sm text-fg-2">{t("oversight.guardNote")}</p>
          </Section>
        </div>
      </PageBody>
    </>
  );
}

/** A 100% bar with the numbers written out: the colours repeat what the labels say. */
function Split({ parts, family, label }: { parts: [Disposition | RxOutcome, number][]; family: "disposition" | "outcome"; label: string }) {
  const { t } = useTranslation(["clinic", "rx"]);
  const total = sum(parts.map(([, n]) => n));
  const shown = parts.filter(([, n]) => n > 0);
  if (total === 0) return <span className="text-fg-3">{t("oversight.none")}</span>;
  return (
    <span className="block">
      <span className="split-bar" role="img" aria-label={`${label}: ${shown.map(([k, n]) => `${t(`rx:${family}.${k}`)} ${n}`).join(t("patient.dot"))}`}>
        {shown.map(([k, n]) => (
          <span key={k} data-tone={statusTone(family, k)} style={{ flexGrow: n }} />
        ))}
      </span>
      <span className="split-key" aria-hidden="true">
        {shown.map(([k, n]) => {
          const Icon = statusIcon(family, k);
          return (
            <span key={k} data-tone={statusTone(family, k)}>
              <Icon size={15} />
              {t(`rx:${family}.${k}`)} <b className="num">{n}</b>
            </span>
          );
        })}
      </span>
    </span>
  );
}

/** Horizontal bars for a handful of counts, longest first; the figure stands at the end of its bar. */
function Counts({ rows, empty }: { rows: { label: string; n: number }[]; empty: string }) {
  const list = rows.filter((r) => r.n > 0).toSorted((a, b) => b.n - a.n);
  const max = Math.max(1, ...list.map((r) => r.n));
  if (list.length === 0) return <p className="text-fg-2">{empty}</p>;
  return (
    <dl className="count-bars">
      {list.map((r) => (
        <div key={r.label}>
          <dt>{r.label}</dt>
          <dd>
            <span className="bar" style={{ width: `${(r.n / max) * 100}%` }} aria-hidden="true" />
            <span className="num font-semibold">{r.n}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
