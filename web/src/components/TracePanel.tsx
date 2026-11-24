// Tool trace: one block per run (model, fallback, token usage) with one expandable row per tool call.
// Source (code / model / form) and status are always an icon plus a word; colour only reinforces.
// Red is reserved for the red-flag hit; failed or rejected calls use neutral and amber styles.

import { useTranslation } from "react-i18next";

import i18n, { currentLocale } from "../i18n/index.ts";
import { formatCount, formatDuration, prettyJson } from "../lib/format.ts";
import { handbookHits, isRedFlagHitResult, piiMasked, traceBrief } from "../lib/trace.ts";
import { groupTrace, type GuardNote, type RunView, type TraceRow, type TraceStatus } from "../state/visitReducer.ts";
import { Icon, type IconName } from "./Icon.tsx";

const SOURCE_ICON: Record<TraceRow["source"], IconName> = { code: "code", model: "spark", form: "form" };
const STATUS_ICON: Record<TraceStatus | "redflag", IconName> = {
  ok: "check",
  rejected: "slash",
  error: "alert",
  redflag: "alert",
  running: "clock",
};

function isRedFlagHit(row: TraceRow): boolean {
  return row.name === "red_flag_precheck" && isRedFlagHitResult(row.result);
}

/** Violation names come from the server in English ("dosage"); show them in the page language. */
function violationText(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") return "";
  return raw
    .split("、")
    .map((v) => (i18n.exists(`trace.guardKind.${v}`) ? i18n.t(`trace.guardKind.${v}`) : v))
    .join("、");
}

function RunHead({ run, guards }: { run: RunView | null; guards: GuardNote[] }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  if (!run) {
    return (
      <div className="run-head">
        <span>{t("trace.formGroup")}</span>
      </div>
    );
  }
  const skipped = run.status === "skipped";
  return (
    <div className="run-head">
      <span>
        {t("trace.model")}{" "}
        <b className="mono">{skipped ? t("trace.noModel") : run.model || "—"}</b>
      </span>
      <span>
        {t("trace.status")} <b>{t(`trace.runStatus.${run.status}`)}</b>
      </span>
      {run.fallback_used ? (
        <span>
          {t("trace.fallback")} <b>{t("trace.fallbackUsed")}</b>
        </span>
      ) : null}
      {!skipped ? (
        <span>
          {t("trace.usage")}{" "}
          <b className="num">
            {formatCount(run.usage.input_tokens, locale)} / {formatCount(run.usage.output_tokens, locale)}
          </b>{" "}
          {t("trace.tokens")}
        </span>
      ) : null}
      {run.steps > 0 ? (
        <span>
          {t("trace.steps")} <b className="num">{run.steps}</b>
        </span>
      ) : null}
      {run.duration_ms ? <span className="num">{formatDuration(run.duration_ms)}</span> : null}
      {guards.map((g, i) => (
        <span key={i} className="chip">
          <Icon name="shield" size="sm" />
          {t(`trace.guard.${g.action}`, { kind: t(`trace.guardKind.${g.kind}`) })}
        </span>
      ))}
    </div>
  );
}

function Row({ row, index }: { row: TraceRow; index: number }) {
  const { t } = useTranslation();
  if (row.name === "pii_filter") {
    // Only written when something was masked; shown as a small notice instead of a tool row.
    const result = row.result as { kinds?: unknown } | undefined;
    const kinds = Array.isArray(result?.kinds) ? result.kinds.join("、") : "";
    return (
      <li className="trace-note">
        <Icon name="shield" size="sm" />
        <span>{t("trace.brief.pii", { count: piiMasked(row.result), kinds })}</span>
      </li>
    );
  }
  const hit = isRedFlagHit(row);
  const brief = row.status === "running" ? null : traceBrief(row.name, row.result);
  // Unknown tool names (a newer server) are shown by their raw name with the generic JSON view.
  const toolLabel = i18n.exists(`trace.tool.${row.name}`) ? t(`trace.tool.${row.name}`) : null;
  const statusKey = hit ? "redflag" : row.status;
  const hasArgs = row.arguments !== undefined && row.arguments !== null;
  return (
    <li>
      <details className={`trace-row${hit ? " trace-row--redflag" : ""}`}>
        <summary>
          <span className="trace-row__step">{index + 1}</span>
          <span className={`src src--${row.source}`}>
            <Icon name={SOURCE_ICON[row.source]} size="sm" />
            {t(`trace.source.${row.source}`)}
          </span>
          <span className="trace-row__name" title={row.name}>
            {row.name}
          </span>
          <span className="trace-row__end">
            <span className={`status status--${statusKey}`}>
              <Icon name={STATUS_ICON[statusKey]} size="sm" />
              {t(`trace.rowStatus.${statusKey}`)}
            </span>
          </span>
        </summary>
        <div className="trace-row__detail">
          <div className="text-muted">
            {t("trace.duration")} <span className="num">{formatDuration(row.duration_ms)}</span>・{t(`trace.sourceNote.${row.source}`)}
          </div>
          {toolLabel ? <div className="trace-row__what">{toolLabel}</div> : null}
          {brief ? <div className="trace-row__brief">{t(brief.key, { ...brief.params, violations: violationText(brief.params?.violations) })}</div> : null}
          {row.name === "search_health_education" && handbookHits(row.result).length ? (
            <ul className="trace-hits">
              {handbookHits(row.result).map((h, i) => (
                <li key={i}>
                  {h.title} <span className="text-muted">{h.section}</span>
                  {h.url ? (
                    <>
                      {" "}
                      <a href={h.url} target="_blank" rel="noopener noreferrer">
                        {h.sourceName || t("trace.hitSource")}
                        <span className="visually-hidden">{t("refill.opensNewTab")}</span>
                      </a>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {hasArgs ? (
            <>
              <div className="trace-row__label">{t("trace.arguments")}</div>
              <pre>{prettyJson(row.arguments)}</pre>
            </>
          ) : null}
          {row.result !== undefined ? (
            <>
              <div className="trace-row__label">{t("trace.result")}</div>
              <pre>{prettyJson(row.result)}</pre>
            </>
          ) : (
            <div className="trace-row__label">{t("trace.running")}</div>
          )}
        </div>
      </details>
    </li>
  );
}

export function TracePanel({ trace, runs, guards }: { trace: TraceRow[]; runs: RunView[]; guards: GuardNote[] }) {
  const { t } = useTranslation();
  if (trace.length === 0 && runs.length === 0) {
    return (
      <div className="empty">
        <Icon name="list" />
        <p>
          {t("trace.empty1")}
          <br />
          {t("trace.empty2")}
        </p>
      </div>
    );
  }
  const groups = groupTrace(trace, runs);
  return (
    <div className="stack">
      {groups.map((g) => (
        <section key={g.key} className="trace-group" aria-label={g.run ? g.run.model || t("trace.noModel") : t("trace.formGroup")}>
          <RunHead run={g.run} guards={guards.filter((x) => x.run_id === g.run?.id)} />
          {g.rows.length ? (
            <ol className="trace" role="list">
              {g.rows.map((r, i) => (
                <Row key={r.id} row={r} index={i} />
              ))}
            </ol>
          ) : null}
        </section>
      ))}
    </div>
  );
}
