import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { EvalSummary } from "@/api/types";
import { useAdminEval } from "@/data";
import { formatDateTime, formatPercent } from "@/lib/format";
import { Badge, Callout, DataTable, EmptyState, FilterBar, Ledger, NativeSelect, PageBody, PageHeader, Panel, Segmented, SkeletonRows, useLocale } from "@/ui";

import { LoadProblem } from "../pharmacy/shared/problem";
import { ShareBar } from "./lib/charts";

/** Sent by the server with full runs; not every version has them. */
interface EvalExtra {
  style?: Record<string, number>;
  cases?: { id: string; category: string; passed: boolean }[];
}
type Summary = EvalSummary & EvalExtra;

const COMMANDS = ["cd backend", "cargo run -- eval"];

export default function Eval() {
  const { t } = useTranslation("admin");
  const ev = useAdminEval();
  const latest = ev.data?.latest as Summary | null | undefined;
  return (
    <PageBody>
      <PageHeader title={t("eval.title")} lede={t("eval.lede")} />
      {ev.isError && !ev.data ? (
        <LoadProblem error={ev.error} onRetry={() => void ev.refetch()} />
      ) : !ev.data ? (
        <SkeletonRows rows={8} />
      ) : !latest ? (
        <Panel>
          <EmptyState title={t("eval.none")}>{t("eval.noneBody")}</EmptyState>
        </Panel>
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(19rem,1fr)]">
          <div className="grid min-w-0 gap-5">
            <Latest s={latest} />
            <Trend history={ev.data.history} />
            <Cases s={latest} />
          </div>
          <div className="grid min-w-0 gap-5">
            <How />
            {latest.style && <Style style={latest.style} />}
            <Callout tone="info" title={t("eval.limitsTitle")}>
              <ul className="list-disc ps-5">
                <li>{t("eval.limit1")}</li>
                <li>{t("eval.limit2")}</li>
                <li>{t("eval.limit3")}</li>
              </ul>
            </Callout>
          </div>
        </div>
      )}
    </PageBody>
  );
}

function Latest({ s }: { s: Summary }) {
  const { t } = useTranslation("admin");
  const locale = useLocale();
  return (
    <Panel
      title={t("eval.latest")}
      meta={
        <>
          <span className="num">{formatDateTime(s.ran_at, locale)}</span>
          <code>{s.model}</code>
        </>
      }
      flush
    >
      <p className="px-pane py-3">
        <b className="num text-xl">{t("eval.passed", { passed: s.passed, total: s.total })}</b>{" "}
        <span className="text-fg-2">{s.passed === s.total ? t("eval.allPassed") : t("eval.failedN", { count: s.total - s.passed })}</span>
      </p>
      <DataTable
        caption={t("eval.categories")}
        rows={s.categories}
        rowKey={(c) => c.key}
        columns={[
          {
            id: "c",
            header: t("eval.category"),
            cell: (c) => (
              <>
                <span className="block font-medium">{t(`evalCategory.${c.key}`, { defaultValue: c.key })}</span>
                <span className="block text-sm text-fg-2">{t(`evalCategoryHint.${c.key}`, { defaultValue: "" })}</span>
              </>
            ),
            card: "title",
          },
          { id: "n", header: t("eval.passCount"), cell: (c) => <span className="num whitespace-nowrap">{t("eval.passed", { passed: c.passed, total: c.total })}</span>, align: "end", width: "8rem", card: "end" },
          { id: "b", header: t("eval.share"), cell: (c) => <ShareBar part={c.passed} whole={c.total} label={formatPercent(c.total > 0 ? c.passed / c.total : null, locale)} />, width: "12rem", hideBelow: "md" },
        ]}
      />
    </Panel>
  );
}

/** Runs with different question sets are not one series: the total is written next to every pass rate. */
function Trend({ history }: { history: EvalSummary[] }) {
  const { t } = useTranslation("admin");
  const locale = useLocale();
  const rows = [...history].sort((a, b) => b.ran_at.localeCompare(a.ran_at));
  const totals = new Set(rows.map((r) => r.total));
  return (
    <Panel title={t("eval.trend")} meta={<span className="num">{t("eval.runCount", { count: rows.length })}</span>} flush>
      {rows.length < 3 && <p className="px-pane py-3 text-fg-2">{t("eval.tooFew")}</p>}
      {totals.size > 1 && <p className="px-pane py-3 text-fg-2">{t("eval.totalsDiffer")}</p>}
      <DataTable
        caption={t("eval.trend")}
        rows={rows}
        rowKey={(r) => `${r.ran_at}:${r.model}`}
        empty={<EmptyState title={t("eval.noHistory")} />}
        columns={[
          { id: "t", header: t("runs.time"), cell: (r) => formatDateTime(r.ran_at, locale), nowrap: true, width: "12rem", card: "title" },
          { id: "m", header: t("runs.model"), cell: (r) => <code className="text-sm break-all">{r.model}</code>, width: "13rem" },
          { id: "p", header: t("eval.passCount"), cell: (r) => <span className="num whitespace-nowrap">{t("eval.passed", { passed: r.passed, total: r.total })}</span>, align: "end", width: "8rem", card: "end" },
          {
            id: "s",
            header: t("eval.share"),
            cell: (r) => (
              <span className="grid grid-cols-[minmax(0,1fr)_3.5rem] items-center gap-2">
                <ShareBar part={r.passed} whole={r.total} label={t("eval.passed", { passed: r.passed, total: r.total })} />
                <span className="num text-end text-sm">{formatPercent(r.total > 0 ? r.passed / r.total : null, locale)}</span>
              </span>
            ),
          },
          { id: "f", header: t("eval.failing"), cell: (r) => { const bad = r.categories.filter((c) => c.passed < c.total); return bad.length > 0 ? <span className="text-sm">{bad.map((c) => t("eval.failingItem", { name: t(`evalCategory.${c.key}`, { defaultValue: c.key }), n: c.total - c.passed })).join(t("pharmacy:listSep"))}</span> : <span className="text-fg-3">{t("settings.none")}</span>; }, hideBelow: "lg" },
        ]}
      />
    </Panel>
  );
}

function Cases({ s }: { s: Summary }) {
  const { t } = useTranslation("admin");
  const cases = s.cases;
  const [show, setShow] = useState("all");
  const [cat, setCat] = useState("all");
  if (!cases || cases.length === 0)
    return (
      <Panel title={t("eval.cases")}>
        <p className="text-fg-2">{t("eval.casesNotSent")}</p>
      </Panel>
    );
  const failed = cases.filter((c) => !c.passed);
  const rows = cases.filter((c) => (show === "all" || !c.passed) && (cat === "all" || c.category === cat));
  return (
    <Panel title={t("eval.cases")} flush>
      <FilterBar>
        <Segmented
          label={t("eval.show")}
          value={show}
          onValueChange={setShow}
          options={[
            { value: "all", label: t("eval.showAll"), count: cases.length },
            { value: "failed", label: t("eval.showFailed"), count: failed.length },
          ]}
        />
        <NativeSelect aria-label={t("eval.category")} value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="all">{t("eval.allCategories")}</option>
          {[...new Set(cases.map((c) => c.category))].map((c) => (
            <option key={c} value={c}>
              {t(`evalCategory.${c}`, { defaultValue: c })}
            </option>
          ))}
        </NativeSelect>
      </FilterBar>
      <DataTable
        caption={t("eval.cases")}
        rows={rows}
        rowKey={(c) => c.id}
        maxHeight="32rem"
        total={cases.length}
        empty={<EmptyState title={t("eval.noFailed")} />}
        columns={[
          { id: "i", header: t("eval.caseId"), cell: (c) => <code className="text-sm">{c.id}</code>, sortValue: (c) => c.id, width: "9rem", card: "title" },
          { id: "c", header: t("eval.category"), cell: (c) => t(`evalCategory.${c.category}`, { defaultValue: c.category }), sortValue: (c) => c.category },
          { id: "p", header: t("eval.result"), cell: (c) => <Badge tone={c.passed ? "ok" : "warn"}>{t(c.passed ? "eval.pass" : "eval.fail")}</Badge>, sortValue: (c) => Number(c.passed), width: "8rem", card: "end" },
        ]}
      />
      <p className="px-pane py-3 text-sm text-fg-2">{t("eval.casesNote")}</p>
    </Panel>
  );
}

function How() {
  const { t } = useTranslation("admin");
  return (
    <Panel title={t("eval.how")}>
      <ol className="list-decimal ps-5">
        <li>{t("eval.how1")}</li>
        <li>{t("eval.how2")}</li>
        <li>{t("eval.how3")}</li>
      </ol>
      <pre className="mt-3 overflow-auto rounded-control bg-sunken p-3 text-sm" tabIndex={0}>
        {COMMANDS.join("\n")}
      </pre>
      <p className="mt-3 text-sm text-fg-2">{t("eval.howCost")}</p>
    </Panel>
  );
}

function Style({ style }: { style: Record<string, number> }) {
  const { t } = useTranslation("admin");
  return (
    <Panel title={t("eval.style")}>
      <Ledger items={Object.entries(style).map(([k, v]) => ({ label: t(`evalStyle.${k}`, { defaultValue: k }), value: v, unit: t("unit.replies") }))} />
      <p className="mt-3 text-sm text-fg-2">{t("eval.styleNote")}</p>
    </Panel>
  );
}
