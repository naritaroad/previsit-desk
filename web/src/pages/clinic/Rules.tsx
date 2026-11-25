import { IconListSearch } from "@tabler/icons-react";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { AdminRules, Disposition, ProtocolRule, ProtocolRuleMonitoring, ProtocolRuleQuestion } from "@/api/types";
import { useRules } from "@/data";
import { Badge, DataTable, EmptyState, PageBody, PageHeader, Panel, SearchInput, SkeletonRows, StatusTag, Tabs } from "@/ui";

import { useDebounced, useFmt, useUrlState } from "./lib";
import { PageError, SourceLink, StaleBar } from "./parts";

const has = (q: string, ...texts: (string | null | undefined)[]) => q === "" || texts.some((x) => x?.toLowerCase().includes(q));

/** The rules exactly as the program reads them. Nothing can be edited here. */
export default function Rules() {
  const { t } = useTranslation(["clinic", "rx"]);
  const [url, set] = useUrlState({ tab: "red_flags", q: "" });
  const query = useRules();
  const q = useDebounced(url.q.trim().toLowerCase(), 150);
  const d = query.data;
  if (!d)
    return (
      <PageBody>
        {query.isError ? (
          <PageError error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <PageHeader title={t("rules.title")} />
            <SkeletonRows rows={10} />
          </>
        )}
      </PageBody>
    );
  return (
    <>
      <StaleBar query={query} />
      <PageBody>
        <PageHeader title={t("rules.title")} lede={t("rules.lede")} actions={<SearchInput className="w-72" value={url.q} onValueChange={(v) => set({ q: v })} placeholder={t("rules.search")} />} />
        <RuleTabs d={d} q={q} tab={url.tab} onTab={(tab) => set({ tab })} />
      </PageBody>
    </>
  );
}

function RuleTabs({ d, q, tab, onTab }: { d: AdminRules; q: string; tab: string; onTab: (t: string) => void }) {
  const { t } = useTranslation(["clinic", "rx"]);
  const fmt = useFmt();
  const red = useMemo(() => d.red_flags.filter((r) => has(q, r.id, r.label, r.pattern, r.note, t(`redFlag.${r.category}`))), [d, q, t]);
  const scope = useMemo(() => d.scope.filter((r) => has(q, r.id, r.pattern, r.note, t(`verdict.${r.verdict}`))), [d, q, t]);
  const refill = useMemo(() => d.refill.filter((r) => has(q, r.key, r.text, r.value)), [d, q]);
  const drugs = useMemo(() => d.formulary.filter((r) => has(q, r.name_zh, r.name_en, r.class_zh, r.class_en, r.reason)), [d, q]);
  const nothing = (
    <EmptyState icon={<IconListSearch aria-hidden />} title={t("rules.noMatch")}>
      {t("rules.noMatchBody")}
    </EmptyState>
  );
  const items: { value: string; label: string; count: number; content: ReactNode }[] = [
    {
      value: "red_flags",
      label: t("rules.tab.red_flags"),
      count: red.length,
      content: (
        <Tab note={t("rules.note.red_flags")} empty={red.length === 0 ? nothing : null}>
          <DataTable
            caption={t("rules.tab.red_flags")}
            rows={red}
            rowKey={(r) => `${r.id}-${r.lang}`}
            columns={[
              { id: "id", header: t("rules.col.id"), width: "8rem", cell: (r) => <code className="code">{r.id}</code>, sortValue: (r) => r.id },
              { id: "cat", header: t("rules.col.category"), width: "9rem", cell: (r) => t(`redFlag.${r.category}`), sortValue: (r) => r.category },
              { id: "label", header: t("rules.col.label"), width: "12rem", card: "title", cell: (r) => <span className="font-semibold">{r.label}</span> },
              { id: "pattern", header: t("rules.col.pattern"), cell: (r) => <Pattern text={r.pattern} /> },
              { id: "lang", header: t("rules.col.lang"), width: "6rem", hideBelow: "lg", cell: (r) => r.lang },
            ]}
          />
        </Tab>
      ),
    },
    {
      value: "scope",
      label: t("rules.tab.scope"),
      count: scope.length,
      content: (
        <Tab note={t("rules.note.scope")} empty={scope.length === 0 ? nothing : null}>
          <DataTable
            caption={t("rules.tab.scope")}
            rows={scope}
            rowKey={(r) => `${r.id}-${r.lang}`}
            columns={[
              { id: "id", header: t("rules.col.id"), width: "8rem", cell: (r) => <code className="code">{r.id}</code>, sortValue: (r) => r.id },
              { id: "verdict", header: t("rules.col.verdict"), width: "12rem", card: "title", cell: (r) => <span className="font-semibold">{t(`verdict.${r.verdict}`)}</span>, sortValue: (r) => r.verdict },
              { id: "pattern", header: t("rules.col.pattern"), cell: (r) => <Pattern text={r.pattern} /> },
              { id: "note", header: t("rules.col.note"), hideBelow: "lg", cell: (r) => r.note || <span className="text-fg-3">{t("rules.noNote")}</span> },
            ]}
          />
        </Tab>
      ),
    },
    {
      value: "refill",
      label: t("rules.tab.refill"),
      count: refill.length,
      content: (
        <Tab note={t("rules.note.refill")} empty={refill.length === 0 ? nothing : null}>
          <DataTable
            caption={t("rules.tab.refill")}
            rows={refill}
            rowKey={(r) => r.key}
            columns={[
              { id: "text", header: t("rules.col.rule"), card: "title", cell: (r) => r.text },
              { id: "value", header: t("rules.col.value"), width: "8rem", align: "end", cell: (r) => <span className="num font-semibold">{[r.value, r.unit].filter(Boolean).join(" ")}</span> },
              { id: "source", header: t("rules.col.source"), width: "13rem", cell: (r) => <SourceLink url={r.source_url} /> },
              { id: "checked", header: t("rules.col.checked"), width: "8rem", nowrap: true, cell: (r) => <span className="num">{fmt.date(r.verified_on, "short")}</span> },
            ]}
          />
        </Tab>
      ),
    },
    {
      value: "protocols",
      label: t("rules.tab.protocols"),
      count: d.protocols.classes.length,
      content: <Protocols d={d} q={q} nothing={nothing} />,
    },
    {
      value: "formulary",
      label: t("rules.tab.formulary"),
      count: drugs.length,
      content: (
        <Tab note={t("rules.note.formulary")} empty={drugs.length === 0 ? nothing : null}>
          <DataTable
            caption={t("rules.tab.formulary")}
            rows={drugs}
            rowKey={(r) => r.drug_id}
            columns={[
              {
                id: "drug",
                header: t("col.drug"),
                card: "title",
                sortValue: (r) => r.name_zh,
                cell: (r) => (
                  <>
                    <span className="font-semibold">{fmt.locale === "en" ? r.name_en : r.name_zh}</span>
                    <span className="ms-2 text-fg-2">{fmt.locale === "en" ? r.name_zh : r.name_en}</span>
                  </>
                ),
              },
              { id: "class", header: t("rules.col.class"), width: "14rem", sortValue: (r) => r.class_zh, cell: (r) => (fmt.locale === "en" ? r.class_en : r.class_zh) },
              { id: "level", header: t("rules.col.controlled"), width: "8rem", hideBelow: "lg", sortValue: (r) => r.controlled_level, cell: (r) => (r.controlled_level > 0 ? <Badge tone="warn">{t("rx.controlled", { n: r.controlled_level })}</Badge> : <span className="text-fg-3">{t("rules.notControlled")}</span>) },
              { id: "scope", header: t("rx.scope"), width: "11rem", card: "end", sortValue: (r) => r.renewal_scope, cell: (r) => <StatusTag family="scope" status={r.renewal_scope} /> },
              { id: "why", header: t("rules.col.why"), cell: (r) => r.reason },
              { id: "source", header: t("rules.col.source"), width: "11rem", hideBelow: "lg", cell: (r) => <SourceLink url={r.source_url} /> },
            ]}
          />
        </Tab>
      ),
    },
  ];
  return <Tabs label={t("rules.title")} value={items.some((i) => i.value === tab) ? tab : "red_flags"} onValueChange={onTab} items={items} />;
}

function Tab({ note, empty, children }: { note: string; empty: ReactNode; children: ReactNode }) {
  return (
    <>
      <p className="mb-3 max-w-[52em] text-fg-2">{note}</p>
      <Panel flush>{empty ?? children}</Panel>
    </>
  );
}

/** Long patterns open on request; they are for checking, not for reading. */
function Pattern({ text }: { text: string }) {
  const { t } = useTranslation("clinic");
  if (text.length < 60) return <code className="code wrap-any">{text}</code>;
  return (
    <details>
      <summary className="pattern-summary">
        <code className="code">{`${text.slice(0, 56)}…`}</code>
        <span className="link text-sm">{t("rules.more")}</span>
      </summary>
      <code className="code mt-1 block wrap-any">{text}</code>
    </details>
  );
}

function Protocols({ d, q, nothing }: { d: AdminRules; q: string; nothing: ReactNode }) {
  const { t } = useTranslation("clinic");
  const match = (x: { id: string; label: string; rules: ProtocolRule[] }) => has(q, x.id, x.label, ...x.rules.map((r) => r.reason));
  const general = d.protocols.general.questions.filter(match);
  const classes = d.protocols.classes
    .map((c) => {
      const named = q !== "" && has(q, c.title, c.summary, c.class_id);
      return named ? c : { ...c, questions: c.questions.filter(match), monitoring: c.monitoring.filter((m) => match(m) || has(q, m.reason)) };
    })
    .filter((c) => c.questions.length + c.monitoring.length > 0 || q === "");
  if (general.length === 0 && classes.length === 0) return <Panel flush>{nothing}</Panel>;
  return (
    <>
      <p className="mb-3 max-w-[52em] text-fg-2">
        {t("rules.note.protocols")} <span className="num">{t("rules.version", { v: d.protocols.version })}</span> {d.protocols.approved_by_note}
      </p>
      <div className="grid gap-3">
        {general.length > 0 && <Group title={t("rules.general")} open questions={general} monitoring={[]} />}
        {classes.map((c) => (
          <Group key={c.class_id} title={c.title} summary={c.summary} open={q !== ""} questions={c.questions} monitoring={c.monitoring} />
        ))}
      </div>
    </>
  );
}

/** "equals yes", "at least 160": the condition in words. */
function useCondition() {
  const { t } = useTranslation("clinic");
  return (r: ProtocolRule): string => {
    const v = r.when.value;
    const text = typeof v === "boolean" ? t(v ? "rx.yes" : "rx.no") : Array.isArray(v) ? v.map(String).join(t("patient.dot")) : v === null || v === undefined ? "" : String(v);
    return t(`rules.op.${r.when.op}`, { value: text, defaultValue: `${r.when.op} ${text}` });
  };
}

function RuleLine({ when, disposition, reason, source }: { when: string; disposition: Disposition; reason: string; source: string | null }) {
  return (
    <li className="rule-line">
      <StatusTag family="disposition" status={disposition} />
      <span className="min-w-0">
        <span className="text-fg-2">{when}</span> {reason} <SourceLink url={source} />
      </span>
    </li>
  );
}

function Group({ title, summary, questions, monitoring, open }: { title: string; summary?: string; questions: ProtocolRuleQuestion[]; monitoring: ProtocolRuleMonitoring[]; open: boolean }) {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const condition = useCondition();
  const rules = (list: ProtocolRule[]) => list.map((r, i) => <RuleLine key={i} when={condition(r)} disposition={r.disposition} reason={r.reason} source={r.source_url} />);
  return (
    <details className="panel" open={open}>
      <summary className="panel-head cursor-pointer">
        <h2 className="panel-title">{title}</h2>
        <span className="num text-sm text-fg-2">{t("rules.questions", { count: questions.length + monitoring.length })}</span>
      </summary>
      <div className="panel-body">
        {summary && <p className="mb-4 max-w-[52em] text-fg-2">{summary}</p>}
        <div className="record-cols">
          {questions.length > 0 && (
            <section aria-label={t("rules.asked")}>
              <h3 className="font-semibold">{t("rules.asked")}</h3>
              <ul className="divide-y divide-rule">
                {questions.map((x) => (
                  <li key={x.id} className="py-2">
                    <span className="font-medium">{x.label}</span>
                    <span className="ms-2 text-sm text-fg-2">{[t(`rules.answer.${x.kind}`), x.required ? t("rules.required") : null].filter(Boolean).join(t("patient.dot"))}</span>
                    {x.rules.length > 0 && <ul className="mt-1 grid gap-1">{rules(x.rules)}</ul>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {monitoring.length > 0 && (
            <section aria-label={t("rules.monitored")}>
              <h3 className="font-semibold">{t("rules.monitored")}</h3>
              <ul className="divide-y divide-rule">
                {monitoring.map((m) => (
                  <li key={m.id} className="py-2">
                    <span className="font-medium">{m.label}</span>
                    {m.unit && <span className="ms-2 text-sm text-fg-2">{m.unit}</span>}
                    <ul className="mt-1 grid gap-1">
                      {rules(m.rules)}
                      {m.max_age_days !== null && <RuleLine when={t("rules.maxAge", { count: m.max_age_days })} disposition={m.stale_disposition} reason={m.reason} source={m.source_url} />}
                    </ul>
                    {m.verified_on && <span className="num text-sm text-fg-3">{t("rules.verified", { date: fmt.date(m.verified_on, "short") })}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </details>
  );
}
