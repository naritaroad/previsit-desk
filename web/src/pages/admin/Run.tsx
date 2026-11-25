import { useTranslation } from "react-i18next";
import { useParams } from "react-router";

import { useRun } from "@/data";
import { formatCount, formatDateTime, formatDuration, formatUsd } from "@/lib/format";
import { Badge, Callout, DataTable, DescriptionList, EmptyState, PageBody, PageHeader, Panel, SkeletonRows, StatusTag, useLocale } from "@/ui";

import { LoadProblem } from "../pharmacy/shared/problem";
import { useRunText } from "./lib/runs";

export default function Run() {
  const { t } = useTranslation("admin");
  const locale = useLocale();
  const words = useRunText();
  const { id = "" } = useParams();
  const run = useRun(id);
  const back = { to: "/admin/runs", label: t("runs.title") };
  const r = run.data;
  if (run.isError && !r)
    return (
      <PageBody>
        <PageHeader back={back} title={t("run.title")} />
        <LoadProblem error={run.error} onRetry={() => void run.refetch()} />
      </PageBody>
    );
  if (!r)
    return (
      <PageBody>
        <PageHeader back={back} title={t("run.title")} />
        <SkeletonRows rows={6} />
      </PageBody>
    );
  const longest = Math.max(...r.tools.map((x) => x.duration_ms), 1);
  return (
    <PageBody>
      <PageHeader
        back={back}
        title={t("run.titleAt", { at: formatDateTime(r.created_at, locale) })}
        meta={
          <>
            <StatusTag family="run" status={r.status} />
            {r.fallback_used && <Badge tone="hold">{t("runs.fallback")}</Badge>}
            {r.error_code && <span>{words.error(r.error_code)}</span>}
          </>
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(18rem,1fr)]">
        <div className="grid min-w-0 gap-5">
          <Panel title={t("run.tools")} meta={<span className="num">{t("run.toolCount", { count: r.tools.length })}</span>} flush>
            <DataTable
              caption={t("run.tools")}
              rows={r.tools.map((x, i) => ({ ...x, i }))}
              rowKey={(x) => String(x.i)}
              empty={<EmptyState title={t("run.noTools")}>{t("run.noToolsBody")}</EmptyState>}
              columns={[
                { id: "n", header: t("run.step"), cell: (x) => <span className="num">{x.step ?? x.i + 1}</span>, width: "4.5rem" },
                { id: "t", header: t("run.tool"), cell: (x) => <span className="font-medium">{words.tool(x.name)}</span>, card: "title" },
                { id: "c", header: t("run.code"), cell: (x) => <code className="text-sm">{x.name}</code>, hideBelow: "lg", width: "14rem" },
                { id: "s", header: t("run.source"), cell: (x) => words.source(x.source), width: "7rem" },
                { id: "r", header: t("run.result"), cell: (x) => <Badge tone={x.status === "ok" ? "ok" : x.status === "rejected" ? "hold" : "warn"}>{words.status(x.status)}</Badge>, width: "7rem", card: "end" },
                {
                  id: "d",
                  header: t("runs.duration"),
                  cell: (x) => (
                    <span className="grid gap-1">
                      <span className="num">{formatDuration(x.duration_ms)}</span>
                      <span className="share-bar" aria-hidden="true">
                        <i style={{ width: `${(x.duration_ms / longest) * 100}%` }} data-zero={x.duration_ms === 0} />
                      </span>
                    </span>
                  ),
                  align: "end",
                  width: "8rem",
                },
              ]}
            />
          </Panel>
          {r.guard && (
            <Panel title={t("run.guard")}>
              {r.guard.length === 0 ? (
                <p className="text-fg-2">{t("run.noGuard")}</p>
              ) : (
                <ul className="grid gap-2">
                  {r.guard.map((g, i) => (
                    <li key={i} className="flex flex-wrap gap-2">
                      <Badge tone="warn">{words.guard(g.kind)}</Badge>
                      <span>{words.guardAction(g.action)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
        </div>
        <div className="grid min-w-0 gap-5">
          <Panel title={t("run.usage")}>
            <DescriptionList
              items={[
                { label: t("runs.model"), value: r.model ? <code className="text-sm break-all">{r.model}</code> : t("runs.noModel") },
                { label: t("runs.steps"), value: <span className="num">{r.steps}</span> },
                { label: t("measure.input_tokens"), value: <span className="num">{formatCount(r.usage.input_tokens, locale)}</span> },
                { label: t("measure.output_tokens"), value: <span className="num">{formatCount(r.usage.output_tokens, locale)}</span> },
                { label: t("runs.cost"), value: <span className="num">{formatUsd(r.cost_usd, locale)}</span> },
                { label: t("runs.duration"), value: <span className="num">{formatDuration(r.duration_ms)}</span> },
                { label: t("runs.error"), value: r.error_code ? <code className="text-sm">{r.error_code}</code> : t("settings.none") },
                { label: t("run.id"), value: <code className="text-sm">{r.id}</code> },
                { label: t("runs.visit"), value: <code className="text-sm">{r.visit_id}</code> },
              ]}
            />
          </Panel>
          <Callout tone="info" title={t("run.privacyTitle")}>
            {t("run.privacyBody")}
          </Callout>
        </div>
      </div>
    </PageBody>
  );
}
