// Clinician detail: summary, tickets, the whole conversation, the tool trace and the review box.

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { ApiError, api } from "../api/client.ts";
import type { Message, VisitDetail } from "../api/types.ts";
import { UrgencyBadge } from "../components/Badges.tsx";
import { ClinicianShell, useSessionGuard } from "../components/ClinicianShell.tsx";
import { Icon } from "../components/Icon.tsx";
import { RefillResultCard } from "../components/RefillResultCard.tsx";
import { IntakePreview, SummaryView } from "../components/SummaryPanel.tsx";
import { TracePanel } from "../components/TracePanel.tsx";
import { currentLocale } from "../i18n/index.ts";
import { describeApiError, type Described } from "../lib/errors.ts";
import { formatDateTime } from "../lib/format.ts";
import { visitReducer, initialVisitState } from "../state/visitReducer.ts";

function whoOf(m: Message): "ai" | "patient" | "rule" {
  if (m.role === "patient") return "patient";
  return m.kind === "red_flag" || m.kind === "refusal" || m.kind === "notice" ? "rule" : "ai";
}

export function ClinicianVisit() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const { id = "" } = useParams();
  const guard = useSessionGuard();
  const noteId = useId();
  const [detail, setDetail] = useState<VisitDetail | null>(null);
  const [error, setError] = useState<(Described & { notFound: boolean }) | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<Described | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api.clinicianVisit(id));
      setError(null);
    } catch (e) {
      if (guard(e)) return;
      setError({ ...describeApiError(e), notFound: e instanceof ApiError && e.code === "not_found" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);

  // Reuse the patient-side reducer to turn stored tool calls and runs into trace rows.
  const traceState = useMemo(() => (detail ? visitReducer(initialVisitState, { type: "loaded", detail }) : null), [detail]);

  async function review() {
    setBusy(true);
    setActionError(null);
    try {
      await api.review(id, note.trim() || undefined);
      await load();
    } catch (e) {
      if (!guard(e)) setActionError(describeApiError(e));
    } finally {
      setBusy(false);
    }
  }

  async function resolve(ticketId: string) {
    setResolving(ticketId);
    try {
      await api.resolveTicket(ticketId);
      await load();
    } catch (e) {
      if (!guard(e)) setActionError(describeApiError(e));
    } finally {
      setResolving(null);
    }
  }

  const complaint = detail?.intake.state.chief_complaint ?? detail?.summary?.chief_complaint ?? null;
  const title = complaint ?? t("clinician.noComplaint");

  return (
    <ClinicianShell title={detail ? title : t("clinician.detailTitle")}>
      <Link className="btn btn-ghost back-link" to="/clinician">
        <Icon name="back" />
        {t("clinician.backToList")}
      </Link>

      {error ? (
        <div className="notice" role="alert">
          <Icon name={error.key === "errors.offline" ? "wifi" : "alert"} />
          <div>
            <p>{t(error.notFound ? "clinician.visitMissing" : error.key, error.params)}</p>
            {!error.notFound ? (
              <button type="button" className="btn btn-secondary btn-compact" onClick={() => void load()}>
                {t("common.retry")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {!detail && !error ? (
        <div className="stack-sm" aria-busy="true" aria-label={t("common.loading")}>
          <div className="skel" style={{ width: "50%" }} />
          <div className="skel" />
          <div className="skel" style={{ width: "70%" }} />
        </div>
      ) : null}

      {detail && traceState ? (
        <>
          <div className="detail-head">
            <UrgencyBadge urgency={detail.visit.urgency} />
            <h1 className="detail-head__title" title={title}>
              {title}
            </h1>
            <span className="text-sm text-muted">
              {t(`visitStatus.${detail.visit.status}`)}・{formatDateTime(detail.visit.updated_at, locale)}・{t("clinician.messageCount", { count: detail.messages.length })}
            </span>
          </div>

          {detail.red_flag ? (
            <div className="screen-hit screen-hit--block" role="note">
              <Icon name="alert" />
              <span>{t("clinician.redFlagBanner", { label: detail.red_flag.label, time: formatDateTime(detail.red_flag.matched_at, locale) })}</span>
            </div>
          ) : null}

          <div className="detail">
            <div className="stack">
              <section className="card" aria-labelledby="sum-title">
                <h2 className="card__title" id="sum-title">
                  <Icon name="doc" />
                  {t("clinician.summaryTitle")}
                </h2>
                {detail.summary ? (
                  <SummaryView summary={detail.summary} />
                ) : (
                  <>
                    <p className="text-sm text-muted">{t("clinician.noSummaryYet")}</p>
                    <IntakePreview intake={detail.intake} />
                  </>
                )}
              </section>

              {detail.refill_checks.length ? (
                <section className="card" aria-labelledby="refill-title">
                  <h2 className="card__title" id="refill-title">
                    <Icon name="pill" />
                    {t("clinician.refillTitle")}
                  </h2>
                  <RefillResultCard result={detail.refill_checks[detail.refill_checks.length - 1].result} compact />
                </section>
              ) : null}

              <section className="card" aria-labelledby="tickets-title">
                <h2 className="card__title" id="tickets-title">
                  <Icon name="ticket" />
                  {t("clinician.ticketsTitle")}
                </h2>
                {detail.tickets.length === 0 ? (
                  <p className="text-sm text-muted">{t("clinician.noTickets")}</p>
                ) : (
                  detail.tickets.map((tk) => (
                    <div className="ticket" key={tk.id}>
                      <UrgencyBadge urgency={tk.urgency} />
                      <div>
                        <b className="mono">{tk.ticket_no}</b>
                        <div className="text-muted">
                          {t(`ticketReason.${tk.reason}`)}・{tk.summary}
                        </div>
                        {tk.status === "resolved" ? (
                          <div className="text-xs text-muted">
                            {t("clinician.resolvedBy", { name: tk.resolved_by ?? "—", time: formatDateTime(tk.resolved_at, locale) })}
                            {tk.resolution_note ? `・${tk.resolution_note}` : ""}
                          </div>
                        ) : null}
                      </div>
                      {tk.status === "open" ? (
                        <button type="button" className="btn btn-secondary" disabled={resolving === tk.id} onClick={() => void resolve(tk.id)}>
                          {t("clinician.resolve")}
                        </button>
                      ) : (
                        <span className="vstatus vstatus--reviewed">
                          <Icon name="check" size="sm" />
                          {t("clinician.resolved")}
                        </span>
                      )}
                    </div>
                  ))
                )}
              </section>
            </div>

            <div className="stack">
              <section className="card" aria-labelledby="convo-title">
                <h2 className="card__title" id="convo-title">
                  <Icon name="chat" />
                  {t("clinician.conversationTitle")}
                </h2>
                <div className="convo" tabIndex={0} role="log" aria-label={t("clinician.conversationTitle")}>
                  {detail.messages.map((m) => (
                    <div className="line" key={m.id}>
                      <span className="who">{t(`clinician.who.${whoOf(m)}`)}</span>
                      <span className="line__text">{m.content}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="card" aria-labelledby="trace-title">
                <h2 className="card__title" id="trace-title">
                  <Icon name="list" />
                  {t("clinician.traceTitle")}
                </h2>
                <div className="trace-scroll" tabIndex={0} role="region" aria-label={t("clinician.traceTitle")}>
                  <TracePanel trace={traceState.trace} runs={traceState.runs} guards={[]} />
                </div>
              </section>
            </div>
          </div>

          <section className="card" aria-labelledby="review-title">
            <h2 className="card__title" id="review-title">
              <Icon name="check-circle" />
              {t("clinician.reviewTitle")}
            </h2>
            {detail.visit.status === "reviewed" ? (
              <p>
                {t("clinician.reviewedBy", { name: detail.visit.reviewed_by ?? "—", time: formatDateTime(detail.visit.reviewed_at, locale) })}
                {detail.visit.review_note ? <span className="review-note">{detail.visit.review_note}</span> : null}
              </p>
            ) : detail.visit.status === "submitted" || detail.visit.status === "red_flag" ? (
              <div className="review-box">
                <div className="form-field" style={{ flex: "1 1 260px" }}>
                  <label htmlFor={noteId}>{t("clinician.reviewNote")}</label>
                  <textarea id={noteId} className="field" rows={2} placeholder={t("clinician.reviewPlaceholder")} value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void review()}>
                  {t("clinician.review")}
                </button>
              </div>
            ) : (
              <p className="text-sm text-muted">{t("clinician.reviewNotYet")}</p>
            )}
            {actionError ? (
              <div className="notice" role="alert">
                <Icon name="alert" />
                <p>{t(actionError.key, actionError.params)}</p>
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </ClinicianShell>
  );
}
