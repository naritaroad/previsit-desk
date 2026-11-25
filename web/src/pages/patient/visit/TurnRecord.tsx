import { IconAlertTriangle, IconCheck, IconChevronRight, IconLoader2 } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import type { RefillResult } from "@/api/types";
import { formatCount, formatDuration, prettyJson } from "@/lib/format";
import { isInternalLink, safeExternalUrl } from "@/lib/links";
import { traceBrief, type TraceGroup, type TraceRow } from "@/lib/trace";
import { ButtonLink, Callout, ExternalLink, StatusTag, TextLink, useLocale } from "@/ui";

import { useFmt } from "../shared";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** What happened for one reply: plain words first, the raw JSON one click further, model and usage last. */
export function TurnRecord({ group }: { group: TraceGroup }) {
  const { t } = useTranslation(["patient", "rx", "common"]);
  const locale = useLocale();
  const { run, rows } = group;
  const tokens = run ? run.usage.input_tokens + run.usage.output_tokens : 0;
  const skipped = run?.status === "skipped" || (!run?.model && rows.length > 0);
  return (
    <details className="turn no-print">
      <summary>
        <IconChevronRight className="chev" aria-hidden />
        {skipped ? t("patient:trace.titleRules", { count: rows.length }) : t("patient:trace.title", { count: rows.length })}
      </summary>
      <div className="turn-body">
        <p className="mb-1 text-fg-2">{skipped ? t("patient:trace.leadRules") : t("patient:trace.lead")}</p>
        {rows.length > 0 && (
          <ol className="turn-steps">
            {rows.map((r) => (
              <Step key={r.id} row={r} />
            ))}
          </ol>
        )}
        {run && (
          <p className="turn-foot">
            <StatusTag family="run" status={run.status} plain />
            {run.model && (
              <span>
                {t("patient:trace.model")} <span className="font-code">{run.model}</span>
                {run.fallback_used ? t("patient:trace.fallback") : ""}
              </span>
            )}
            {tokens > 0 && (
              <span className="num">
                {t("patient:trace.usage", { input: formatCount(run.usage.input_tokens, locale), output: formatCount(run.usage.output_tokens, locale) })}
              </span>
            )}
            {run.duration_ms !== null && <span className="num">{formatDuration(run.duration_ms)}</span>}
          </p>
        )}
      </div>
    </details>
  );
}

function Step({ row }: { row: TraceRow }) {
  const { t } = useTranslation(["patient", "rx"]);
  const brief = row.status === "ok" ? traceBrief(row.name, row.result) : null;
  const Icon = row.status === "running" ? IconLoader2 : row.status === "ok" ? IconCheck : IconAlertTriangle;
  return (
    <li data-status={row.status}>
      <Icon aria-hidden className={row.status === "running" ? "animate-spin" : undefined} />
      <span className="min-w-0">
        <span className="font-medium">{t(`patient:trace.tool.${row.name}`, { defaultValue: row.name })}</span>
        <span className="block text-fg-2">
          {brief ? t(brief.key, brief.params) : row.status === "running" ? t("patient:trace.running") : row.status === "rejected" ? t("patient:trace.rejected") : row.status === "error" ? t("patient:trace.error") : null}
        </span>
      </span>
      <span className="num text-fg-3">{row.duration_ms === null ? "" : formatDuration(row.duration_ms)}</span>
      <details>
        <summary>{t("patient:trace.raw")}</summary>
        <p className="mt-1 text-fg-3">
          <span className="font-code">{row.name}</span> {t(`patient:trace.source.${row.source}`)}
        </p>
        <pre tabIndex={0} aria-label={t("patient:trace.input")}>
          {prettyJson(row.arguments)}
        </pre>
        {row.result !== undefined && (
          <pre tabIndex={0} aria-label={t("patient:trace.output")}>
            {prettyJson(row.result)}
          </pre>
        )}
      </details>
    </li>
  );
}

/** Handbook sections a reply is based on. */
export function Sources({ rows }: { rows: readonly TraceRow[] }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const hits = rows
    .filter((r) => r.name === "search_health_education" && r.status === "ok" && isObj(r.result))
    .flatMap((r) => {
      const list = (r.result as Obj).hits;
      return Array.isArray(list) ? list.filter(isObj) : [];
    });
  const unique = hits.filter((h, i) => hits.findIndex((x) => x.section === h.section) === i);
  if (unique.length === 0) return null;
  return (
    <section className="sources" aria-label={t("sources.title")}>
      <p className="sources-title">{t("sources.title")}</p>
      <ul>
        {unique.map((h) => {
          const url = safeExternalUrl(str(h.source_url));
          return (
            <li key={str(h.section)}>
              <TextLink to={`/handbook/${encodeURIComponent(str(h.section))}`}>
                {str(h.section)} {str(h.title)}
              </TextLink>
              <span className="block text-sm text-fg-2">
                {url ? <ExternalLink href={url}>{str(h.source_name)}</ExternalLink> : str(h.source_name)}
                {h.verified_on ? ` ${t("sources.checked", { date: f.date(str(h.verified_on), "short") })}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Results the patient can act on: the refill check, and a request draft the assistant opened. */
export function ToolOutcomes({ rows }: { rows: readonly TraceRow[] }) {
  const { t } = useTranslation(["patient", "rx"]);
  const ok = rows.filter((r) => r.status === "ok" && isObj(r.result));
  const refills = ok.filter((r) => r.name === "check_chronic_refill").map((r) => r.result as unknown as RefillResult);
  const drafts = ok.filter((r) => (r.name as string) === "start_rx_draft").map((r) => r.result as Obj);
  if (refills.length + drafts.length === 0) return null;
  return (
    <div className="grid gap-3">
      {refills.map((r, i) => (
        <RefillNote key={i} result={r} />
      ))}
      {drafts.map((d, i) =>
        isInternalLink(str(d.link)) ? (
          <Callout
            key={i}
            tone="info"
            title={t("patient:visit.draftTitle")}
            actions={
              <ButtonLink size="sm" to={str(d.link)}>
                {t("patient:visit.draftOpen")}
              </ButtonLink>
            }
          >
            {t("patient:visit.draftBody")}
          </Callout>
        ) : null,
      )}
    </div>
  );
}

const REFILL_TONE = { eligible: "ok", too_early: "info", revisit: "hold", consult: "warn" } as const;

/** The program's refill check, in the server's words, with its reasons and rules. */
export function RefillNote({ result: r }: { result: RefillResult }) {
  const { t } = useTranslation("patient");
  return (
    <Callout tone={REFILL_TONE[r.outcome] ?? "info"} title={r.title}>
      <p>{r.message}</p>
      {r.reasons?.length > 0 && (
        <ul className="mt-1">
          {r.reasons.map((x) => (
            <li key={x.code}>{x.text}</li>
          ))}
        </ul>
      )}
      {r.ticket_no && <p className="mt-1 num">{t("visit.ticket", { no: r.ticket_no })}</p>}
      {r.rules?.length > 0 && (
        <details className="turn">
          <summary>
            <IconChevronRight className="chev" aria-hidden />
            {t("visit.rules")}
          </summary>
          <ul className="grid gap-1">
            {r.rules.map((x) => {
              const url = safeExternalUrl(x.source_url);
              return (
                <li key={x.key}>
                  {x.text} {url && <ExternalLink href={url}>{t("visit.ruleSource")}</ExternalLink>}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </Callout>
  );
}
