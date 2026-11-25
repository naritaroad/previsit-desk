import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AdminRules } from "@/api/types";
import { formatDate } from "@/lib/format";
import { safeExternalUrl } from "@/lib/links";
import { Callout, DataTable, EmptyState, ExternalLink, FilterBar, NativeSelect, Panel, SearchInput, StatusTag, useLocale } from "@/ui";

import { countBy, latest, type MonitoringLine, type ProtocolView, type QuestionLine, type RuleLine } from "./rules";

export function SourceLink({ url }: { url: string | null | undefined }) {
  const { t } = useTranslation("pharmacy");
  const safe = safeExternalUrl(url);
  return safe ? (
    <ExternalLink href={safe} className="wrap-any text-sm">
      {new URL(safe).hostname}
    </ExternalLink>
  ) : (
    <span className="text-sm text-fg-3">{t("rules.noSource")}</span>
  );
}

/* ----- 慢箋 refill rules ----- */

export function RefillRules({ rows }: { rows: AdminRules["refill"] }) {
  const { t } = useTranslation("pharmacy");
  const locale = useLocale();
  const checked = latest(rows.map((r) => r.verified_on));
  return (
    <>
      <p className="mb-3 max-w-[46em] text-fg-2">
        {t("rules.refillLede")} {checked && t("rules.checkedOn", { date: formatDate(checked, locale, "short") })}
      </p>
      <Panel flush>
        <DataTable
          caption={t("rules.refill")}
          rows={rows}
          rowKey={(r) => r.key}
          columns={[
            { id: "t", header: t("rules.rule"), cell: (r) => r.text, card: "title" },
            {
              id: "v",
              header: t("rules.value"),
              cell: (r) => (
                <span className="num whitespace-nowrap">
                  <b className="text-lg">{r.value}</b> <span className="text-sm text-fg-2">{r.unit ? t(`rules.unit.${r.unit}`, { defaultValue: r.unit }) : ""}</span>
                </span>
              ),
              width: "8rem",
              align: "end",
              card: "end",
            },
            { id: "s", header: t("rules.source"), cell: (r) => <SourceLink url={r.source_url} />, width: "13rem" },
            { id: "k", header: t("rules.key"), cell: (r) => <code className="text-sm">{r.key}</code>, hideBelow: "xl", width: "13rem" },
          ]}
        />
      </Panel>
    </>
  );
}

/* ----- red flags ----- */

export function RedFlagRules({ rows }: { rows: AdminRules["red_flags"] }) {
  const { t } = useTranslation("pharmacy");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const counts = useMemo(() => countBy(rows, (r) => r.category), [rows]);
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => (cat === "all" || r.category === cat) && (!needle || `${r.id} ${r.label} ${r.pattern} ${r.note}`.toLowerCase().includes(needle)));
  return (
    <>
      <p className="mb-3 max-w-[46em] text-fg-2">{t("rules.redLede", { count: rows.length })}</p>
      <Panel flush>
        <FilterBar search={<SearchInput value={q} onValueChange={setQ} placeholder={t("rules.searchPattern")} />}>
          <NativeSelect aria-label={t("rules.category")} value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="all">{t("rules.allCategories")}</option>
            {Object.entries(counts).map(([c, n]) => (
              <option key={c} value={c}>
                {t("rules.withCount", { name: t(`redFlag.${c}`, { defaultValue: c }), n })}
              </option>
            ))}
          </NativeSelect>
        </FilterBar>
        <DataTable
          caption={t("rules.redFlags")}
          rows={shown}
          rowKey={(r) => r.id}
          total={rows.length}
          empty={<EmptyState title={t("rules.noMatch")} />}
          columns={[
            { id: "id", header: t("rules.id"), cell: (r) => <code className="text-sm">{r.id}</code>, sortValue: (r) => r.id, width: "6rem", card: "end" },
            { id: "c", header: t("rules.category"), cell: (r) => <span className="font-medium">{r.label}</span>, sortValue: (r) => r.category, width: "13rem", card: "title" },
            { id: "l", header: t("rules.lang"), cell: (r) => t(`rules.langs.${r.lang}`, { defaultValue: r.lang }), width: "5rem" },
            { id: "p", header: t("rules.pattern"), cell: (r) => <code className="text-sm break-all">{r.pattern}</code> },
            { id: "n", header: t("rules.note"), cell: (r) => <span className="text-sm text-fg-2">{r.note}</span>, hideBelow: "lg", width: "18rem" },
          ]}
        />
      </Panel>
    </>
  );
}

/* ----- scope (what the assistant refuses) ----- */

export function ScopeRules({ rows }: { rows: AdminRules["scope"] }) {
  const { t } = useTranslation("pharmacy");
  return (
    <>
      <p className="mb-3 max-w-[46em] text-fg-2">{t("rules.scopeLede", { count: rows.length })}</p>
      <Panel flush>
        <DataTable
          caption={t("rules.scope")}
          rows={rows}
          rowKey={(r) => r.id}
          total={rows.length}
          columns={[
            { id: "id", header: t("rules.id"), cell: (r) => <code className="text-sm">{r.id}</code>, sortValue: (r) => r.id, width: "6rem", card: "end" },
            { id: "v", header: t("rules.verdict"), cell: (r) => <span className="font-medium">{t(`rules.verdicts.${r.verdict}`, { defaultValue: r.verdict })}</span>, sortValue: (r) => r.verdict, width: "12rem", card: "title" },
            { id: "l", header: t("rules.lang"), cell: (r) => t(`rules.langs.${r.lang}`, { defaultValue: r.lang }), width: "5rem" },
            { id: "p", header: t("rules.pattern"), cell: (r) => <code className="text-sm break-all">{r.pattern}</code> },
            { id: "n", header: t("rules.note"), cell: (r) => <span className="text-sm text-fg-2">{r.note}</span>, hideBelow: "lg", width: "18rem" },
          ]}
        />
      </Panel>
    </>
  );
}

/* ----- renewal protocols ----- */

function When({ rule }: { rule: RuleLine }) {
  const { t } = useTranslation("pharmacy");
  if (rule.op === "eq" && typeof rule.value === "boolean") return <>{t(rule.value ? "rules.when.yes" : "rules.when.no")}</>;
  return <>{t(`rules.when.${rule.op}`, { value: String(rule.value ?? ""), defaultValue: `${rule.op} ${String(rule.value ?? "")}` })}</>;
}

function RuleList({ rules }: { rules: RuleLine[] }) {
  const { t } = useTranslation("pharmacy");
  if (rules.length === 0) return <span className="text-sm text-fg-3">{t("rules.noRules")}</span>;
  return (
    <ul className="grid gap-2">
      {rules.map((r, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="num text-sm font-medium">
            <When rule={r} />
          </span>
          <StatusTag family="disposition" status={r.disposition} />
          <span className="text-sm text-fg-2">{r.reason}</span>
        </li>
      ))}
    </ul>
  );
}

function Questions({ rows, caption }: { rows: QuestionLine[]; caption: string }) {
  const { t } = useTranslation("pharmacy");
  return (
    <DataTable
      caption={caption}
      rows={rows}
      rowKey={(r) => r.id}
      empty={<EmptyState title={t("rules.noQuestions")} />}
      columns={[
        {
          id: "q",
          header: t("rules.question"),
          cell: (r) => (
            <>
              <span className="block">{r.label}</span>
              <span className="block text-sm text-fg-2">
                {t(`rules.kind.${r.kind}`, { defaultValue: r.kind })}
                {r.required ? t("rules.requiredMark") : ""}
              </span>
            </>
          ),
          card: "title",
          width: "24rem",
        },
        { id: "r", header: t("rules.fires"), cell: (r) => <RuleList rules={r.rules} /> },
      ]}
    />
  );
}

function Monitoring({ rows, caption }: { rows: MonitoringLine[]; caption: string }) {
  const { t } = useTranslation("pharmacy");
  return (
    <DataTable
      caption={caption}
      rows={rows}
      rowKey={(r) => r.id}
      columns={[
        {
          id: "q",
          header: t("rules.monitoring"),
          cell: (r) => (
            <>
              <span className="block">{r.label}</span>
              <span className="block text-sm text-fg-2">{r.maxAgeDays === null ? t("rules.noMaxAge") : t("rules.maxAge", { count: r.maxAgeDays })}</span>
            </>
          ),
          card: "title",
          width: "24rem",
        },
        {
          id: "r",
          header: t("rules.fires"),
          cell: (r) => (
            <div className="grid gap-2">
              {r.stale && (
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-medium">{t("rules.whenStale")}</span>
                  <StatusTag family="disposition" status={r.stale} />
                  <span className="text-sm text-fg-2">{r.reason}</span>
                </p>
              )}
              {(r.rules.length > 0 || !r.stale) && <RuleList rules={r.rules} />}
            </div>
          ),
        },
        { id: "s", header: t("rules.source"), cell: (r) => <SourceLink url={r.sourceUrl} />, width: "12rem", hideBelow: "md" },
      ]}
    />
  );
}

export function ProtocolRules({ view }: { view: ProtocolView }) {
  const { t } = useTranslation("pharmacy");
  const [id, setId] = useState("general");
  const current = view.classes.find((c) => c.id === id);
  return (
    <>
      <div className="mb-3 max-w-[46em] text-fg-2">
        <p>{t("rules.protocolLede", { version: view.version, classes: view.classes.length })}</p>
        {view.approvedBy && <p className="mt-1 font-medium text-fg">{view.approvedBy}</p>}
      </div>
      {!view.hasRules && (
        <Callout tone="info" className="mb-3">
          {t("rules.rulesNotSent")}
        </Callout>
      )}
      <Panel flush>
        <FilterBar>
          <label className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-fg-2">{t("rules.chooseClass")}</span>
            <NativeSelect value={id} onChange={(e) => setId(e.target.value)}>
              <option value="general">{t("rules.general")}</option>
              {view.classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </NativeSelect>
          </label>
        </FilterBar>
        {current?.summary && <p className="max-w-[46em] px-pane py-3">{current.summary}</p>}
        <Questions caption={current ? current.title : t("rules.general")} rows={current ? current.questions : view.general} />
        {current && current.monitoring.length > 0 && (
          <div className="border-t border-rule">
            <Monitoring caption={t("rules.monitoring")} rows={current.monitoring} />
          </div>
        )}
      </Panel>
      {current === undefined && <p className="mt-3 text-sm text-fg-2">{t("rules.generalNote")}</p>}
    </>
  );
}
