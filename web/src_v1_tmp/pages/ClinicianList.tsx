// Clinician home: visits (urgent first), filters, search and the open handoff tickets.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { api, type ClinicianListStatus } from "../api/client.ts";
import type { ClinicianTicket, ClinicianVisitItem } from "../api/types.ts";
import { UrgencyBadge, VisitStatusLabel } from "../components/Badges.tsx";
import { ClinicianShell, useSessionGuard } from "../components/ClinicianShell.tsx";
import { Icon } from "../components/Icon.tsx";
import { currentLocale } from "../i18n/index.ts";
import { describeApiError, type Described } from "../lib/errors.ts";
import { formatDateTime } from "../lib/format.ts";

const FILTERS: { key: ClinicianListStatus; icon?: "alert" }[] = [
  { key: "pending" },
  { key: "red_flag", icon: "alert" },
  { key: "submitted" },
  { key: "reviewed" },
  { key: "all" },
];
const PAGE = 50;
const MAX = 200;
const POLL_MS = 15_000;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function TicketRow({ ticket, onResolve, busy }: { ticket: ClinicianTicket; onResolve: () => void; busy: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="ticket">
      <UrgencyBadge urgency={ticket.urgency} />
      <div>
        <b className="mono">{ticket.ticket_no}</b>
        <div className="text-muted clamp-2" title={ticket.chief_complaint ?? undefined}>
          {t(`ticketReason.${ticket.reason}`)}・{ticket.chief_complaint ?? t("clinician.noComplaint")}
        </div>
        <Link className="text-sm" to={`/clinician/visits/${ticket.visit_id}`}>
          {t("clinician.openVisit")}
        </Link>
      </div>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={onResolve}>
        {t("clinician.resolve")}
      </button>
    </div>
  );
}

export function ClinicianList() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const guard = useSessionGuard();
  const [status, setStatus] = useState<ClinicianListStatus>("pending");
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 300);
  const [limit, setLimit] = useState(PAGE);
  const [items, setItems] = useState<ClinicianVisitItem[] | null>(null);
  const [tickets, setTickets] = useState<ClinicianTicket[]>([]);
  const [error, setError] = useState<Described | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [v, tk] = await Promise.all([api.clinicianVisits({ status, q, limit }), api.clinicianTickets("open")]);
      if (mine !== seq.current) return;
      setItems(v.items);
      setTickets(tk.items);
      setError(null);
    } catch (e) {
      if (mine !== seq.current || guard(e)) return;
      setError(describeApiError(e));
    }
    // guard is stable enough for this: it only wraps a context callback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, q, limit]);

  useEffect(() => {
    void load();
    const id = setInterval(() => document.visibilityState === "visible" && void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => setLimit(PAGE), [status, q]);

  async function resolve(id: string) {
    setResolving(id);
    try {
      await api.resolveTicket(id);
      await load();
    } catch (e) {
      if (!guard(e)) setError(describeApiError(e));
    } finally {
      setResolving(null);
    }
  }

  const pendingCount = items?.filter((i) => i.visit.status === "submitted" || i.visit.status === "red_flag").length ?? 0;
  const urgentCount = items?.filter((i) => i.visit.urgency === "urgent").length ?? 0;
  const filtered = q !== "" || status !== "pending";

  return (
    <ClinicianShell title={t("clinician.listTitle")}>
      <div className="detail-head">
        <h1>{t("clinician.listTitle")}</h1>
        {items ? <span className="text-sm text-muted">{t("clinician.summaryLine", { pending: pendingCount, urgent: urgentCount })}</span> : null}
        <button type="button" className="btn btn-ghost refresh-btn" onClick={() => void load()}>
          <Icon name="refresh" size="sm" />
          {t("common.refresh")}
        </button>
      </div>

      {error ? (
        <div className="notice" role="alert">
          <Icon name={error.key === "errors.offline" ? "wifi" : "alert"} />
          <div>
            <p>{t(error.key, error.params)}</p>
            <button type="button" className="btn btn-secondary btn-compact" onClick={() => void load()}>
              {t("common.retry")}
            </button>
          </div>
        </div>
      ) : null}

      <div className="toolbar" role="group" aria-label={t("clinician.filterLabel")}>
        {FILTERS.map((f) => (
          <button key={f.key} type="button" className="filter" aria-pressed={status === f.key} onClick={() => setStatus(f.key)}>
            {f.icon ? <Icon name={f.icon} size="sm" /> : null}
            {t(`clinician.filter.${f.key}`)}
          </button>
        ))}
        <label className="visually-hidden" htmlFor="cl-q">
          {t("clinician.search")}
        </label>
        <input id="cl-q" className="field search" type="search" placeholder={t("clinician.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {items === null && !error ? (
        <div className="vlist" aria-busy="true" aria-label={t("common.loading")}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div className="vrow" key={i}>
              <div className="skel" />
              <div className="skel" />
              <div className="skel" />
              <div className="skel" />
              <div className="skel" />
            </div>
          ))}
        </div>
      ) : null}

      {items && items.length === 0 ? (
        <div className="empty card">
          <Icon name="list" />
          <p>{filtered ? t("clinician.emptyFiltered") : t("clinician.empty")}</p>
          {filtered ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setStatus("pending");
                setQuery("");
              }}
            >
              {t("clinician.clearFilter")}
            </button>
          ) : null}
        </div>
      ) : null}

      {items && items.length > 0 ? (
        <div className="vlist" role="table" aria-label={t("clinician.listTitle")}>
          <div className="vrow vrow--head" role="row">
            <span role="columnheader">{t("clinician.col.urgency")}</span>
            <span role="columnheader">{t("clinician.col.complaint")}</span>
            <span role="columnheader">{t("clinician.col.status")}</span>
            <span role="columnheader">{t("clinician.col.tickets")}</span>
            <span role="columnheader" style={{ textAlign: "right" }}>
              {t("clinician.col.activity")}
            </span>
          </div>
          {items.map((i) => (
            <Link key={i.visit.id} className={`vrow${i.visit.urgency === "urgent" ? " vrow--urgent" : ""}`} role="row" to={`/clinician/visits/${i.visit.id}`}>
              <span role="cell">
                <UrgencyBadge urgency={i.visit.urgency} />
              </span>
              <span role="cell" className="vrow__cc">
                <b title={i.chief_complaint ?? ""}>{i.chief_complaint ?? <span className="missing">{t("clinician.noComplaint")}</span>}</b>
                <small>
                  {i.red_flag ? `${t("clinician.redFlagPrefix", { label: i.red_flag.label })}・` : ""}
                  {i.has_summary ? t("clinician.hasSummary") : t("clinician.noSummary")}
                </small>
              </span>
              <span role="cell">
                <VisitStatusLabel status={i.visit.status} />
              </span>
              <span role="cell" className="vrow__tickets">
                {i.open_tickets ? t("clinician.ticketCount", { count: i.open_tickets }) : "—"}
              </span>
              <span role="cell" className="vrow__time">
                <time dateTime={i.last_activity_at}>{formatDateTime(i.last_activity_at, locale)}</time>
              </span>
            </Link>
          ))}
        </div>
      ) : null}

      {items && items.length >= limit && limit < MAX ? (
        <button type="button" className="btn btn-secondary load-more" onClick={() => setLimit((n) => Math.min(MAX, n + PAGE))}>
          {t("clinician.loadMore")}
        </button>
      ) : null}

      {tickets.length ? (
        <section className="card" aria-labelledby="tickets-title">
          <h2 className="card__title" id="tickets-title">
            <Icon name="ticket" />
            {t("clinician.openTickets", { count: tickets.length })}
          </h2>
          <div>
            {tickets.map((tk) => (
              <TicketRow key={tk.id} ticket={tk} busy={resolving === tk.id} onResolve={() => void resolve(tk.id)} />
            ))}
          </div>
        </section>
      ) : null}

    </ClinicianShell>
  );
}
