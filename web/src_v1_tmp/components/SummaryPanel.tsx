// "Summary for the doctor": the stored summary when there is one, otherwise a live preview built
// from IntakeView with progress and the fields still missing.

import { useTranslation } from "react-i18next";

import type { IntakeView, PrevisitSummary, RefillResult } from "../api/types.ts";
import { currentLocale } from "../i18n/index.ts";
import { formatDateTime } from "../lib/format.ts";
import { EMPTY_INTAKE, intakeRows, isKnownField, progressPercent, splitMissing, summaryToState, type IntakeRow } from "../lib/intake.ts";
import { Icon } from "./Icon.tsx";
import { RefillResultCard } from "./RefillResultCard.tsx";

export function useFieldLabel() {
  const { t } = useTranslation();
  return (key: string) => {
    if (!isKnownField(key)) return key;
    const name = key.replace(".", "_");
    return t(`intake.field.${name}`);
  };
}

function Value({ row }: { row: IntakeRow }) {
  const { t } = useTranslation();
  if (row.status === "missing") return <span className="missing">{t("intake.missing")}</span>;
  if (row.status === "na") return <>{t("intake.notApplicable")}</>;
  if (row.status === "none") return <>{t("intake.none")}</>;
  return <span className={row.key === "hpi.severity" ? "num" : undefined}>{row.value}</span>;
}

function Rows({ rows, keys }: { rows: IntakeRow[]; keys: string[] }) {
  const label = useFieldLabel();
  return (
    <dl className="kv">
      {rows
        .filter((r) => keys.includes(r.key))
        .map((r) => (
          <div key={r.key} className="kv__row">
            <dt>{label(r.key)}</dt>
            <dd>
              <Value row={r} />
            </dd>
          </div>
        ))}
    </dl>
  );
}

const HPI_KEYS = ["hpi.onset", "hpi.modifiers", "hpi.character", "hpi.location", "hpi.severity", "hpi.course", "hpi.associated"];
const BACKGROUND_KEYS = ["past_history", "medications", "allergies"];

export function ProgressBar({ intake }: { intake: IntakeView }) {
  const { t } = useTranslation();
  const pct = progressPercent(intake);
  return (
    <span className="progress">
      <span className="num">{t("chat.progress", { done: intake.progress.done, total: intake.progress.total })}</span>
      <span
        className="progress__bar"
        role="progressbar"
        aria-label={t("chat.progressLabel")}
        aria-valuemin={0}
        aria-valuemax={intake.progress.total}
        aria-valuenow={intake.progress.done}
      >
        <span style={{ transform: `scaleX(${pct / 100})` }} />
      </span>
    </span>
  );
}

/** Body shared by the patient preview and the stored summary, built from rows. */
function FieldBlocks({ rows, chief, questions }: { rows: IntakeRow[]; chief: IntakeRow | undefined; questions: string[] }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="sum-block">
        <div className="sum-label">{t("summary.chiefComplaint")}</div>
        <p>{chief && chief.status === "filled" ? <b>{chief.value}</b> : <span className="missing">{t("intake.missing")}</span>}</p>
      </div>
      <div className="sum-block">
        <div className="sum-label">{t("summary.hpi")}</div>
        <Rows rows={rows} keys={HPI_KEYS} />
      </div>
      <div className="sum-block">
        <div className="sum-label">{t("summary.background")}</div>
        <Rows rows={rows} keys={BACKGROUND_KEYS} />
      </div>
      {questions.length ? (
        <div className="sum-block">
          <div className="sum-label">{t("summary.questions")}</div>
          <ul className="sum-list">
            {questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export function IntakePreview({ intake }: { intake: IntakeView | null }) {
  const { t } = useTranslation();
  const label = useFieldLabel();
  const view = intake ?? EMPTY_INTAKE;
  const rows = intakeRows(view.state, t("intake.listSeparator"));
  const { required, suggested } = splitMissing(view.missing);
  return (
    <div>
      <div className="sum-block">
        <div className="sum-label">{t("summary.progress")}</div>
        <div className="row">
          <span className="stage-chip">{t(`stage.${view.stage}`)}</span>
          <ProgressBar intake={view} />
        </div>
      </div>
      <FieldBlocks rows={rows} chief={rows.find((r) => r.key === "chief_complaint")} questions={view.state.patient_questions} />
      {required.length ? (
        <div className="sum-block">
          <div className="sum-label">{t("summary.stillMissing")}</div>
          <div className="cluster">
            {required.map((k) => (
              <span key={k} className="chip">
                {label(k)}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="screen-ok">
          <Icon name="check-circle" />
          <span>{t("summary.complete")}</span>
        </div>
      )}
      {suggested.length ? (
        <div className="sum-block">
          <div className="sum-label">{t("summary.suggested")}</div>
          <div className="cluster">
            {suggested.map((k) => (
              <span key={k} className="chip chip--soft">
                {label(k)}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SummaryView({ summary, showRefill = false }: { summary: PrevisitSummary; showRefill?: boolean }) {
  const { t } = useTranslation();
  const label = useFieldLabel();
  const locale = currentLocale();
  const state = summaryToState(summary);
  const rows = intakeRows(state, t("intake.listSeparator"));
  const screen = summary.red_flag_screen;
  const by = summary.generated_by;
  return (
    <div>
      {summary.narrative ? (
        <div className="sum-block">
          <div className="sum-label">{t("summary.narrative")}</div>
          <p className="text-sm">{summary.narrative}</p>
        </div>
      ) : null}
      <FieldBlocks rows={rows} chief={rows.find((r) => r.key === "chief_complaint")} questions={summary.patient_questions} />
      <div className="sum-block">
        <div className="sum-label">{t("summary.redFlagScreen")}</div>
        {screen.triggered.length ? (
          <div className="screen-hit">
            <Icon name="alert" />
            <span>
              {t("summary.redFlagHit", { labels: screen.triggered.map((x) => x.label).join("、") })}
              {screen.note ? ` ${screen.note}` : ""}
            </span>
          </div>
        ) : (
          <div className="screen-ok">
            <Icon name="check-circle" />
            <span>{screen.checked ? t("summary.redFlagNone") : t("summary.redFlagNotChecked")}</span>
          </div>
        )}
      </div>
      {summary.not_collected.length ? (
        <div className="sum-block">
          <div className="sum-label">{t("summary.notCollected")}</div>
          <div className="cluster">
            {summary.not_collected.map((k) => (
              <span key={k} className="chip">
                {label(k)}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {showRefill && summary.refill ? (
        <div className="sum-block">
          <div className="sum-label">{t("summary.refill")}</div>
          <RefillResultCard result={summary.refill as RefillResult} compact />
        </div>
      ) : null}
      <p className="note-box">
        {by.kind === "model"
          ? t("summary.byModel", { model: by.model ?? "", time: formatDateTime(by.at, locale) })
          : t("summary.byCode", { time: formatDateTime(by.at, locale) })}{" "}
        {summary.disclaimer}
      </p>
    </div>
  );
}

interface SummaryPanelProps {
  intake: IntakeView | null;
  summary: PrevisitSummary | null;
  closed: boolean;
  hasVisit: boolean;
  onSubmit: () => void;
}

export function SummaryPanel({ intake, summary, closed, hasVisit, onSubmit }: SummaryPanelProps) {
  const { t } = useTranslation();
  return (
    <div className="stack">
      {summary ? <SummaryView summary={summary} /> : <IntakePreview intake={intake} />}
      {closed ? (
        <div className="notice notice--info" role="status">
          <Icon name="check-circle" />
          <p>{t("summary.sent")}</p>
        </div>
      ) : (
        <button type="button" className="btn btn-primary btn-block" disabled={!hasVisit} onClick={onSubmit}>
          {t("composer.finish")}
        </button>
      )}
    </div>
  );
}
