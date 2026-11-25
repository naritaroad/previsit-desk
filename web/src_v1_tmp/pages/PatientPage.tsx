// Patient page: chat on the left, trace / summary / refill beside it (a tab bar on narrow screens).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { AppHeader } from "../components/AppHeader.tsx";
import { ChatPane } from "../components/ChatPane.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Icon } from "../components/Icon.tsx";
import { MobileTabBar, PanelTabs, type PaneKey, type PanelKey } from "../components/PanelTabs.tsx";
import { RefillPanel } from "../components/RefillPanel.tsx";
import { SummaryPanel } from "../components/SummaryPanel.tsx";
import { TracePanel } from "../components/TracePanel.tsx";
import { useMeta } from "../hooks/useMeta.ts";
import { useVisit, type VisitController } from "../hooks/useVisit.ts";
import { currentLocale } from "../i18n/index.ts";
import { charCount } from "../lib/composer.ts";
import { describeFailure } from "../lib/errors.ts";
import { todayInTaipei } from "../lib/format.ts";
import { splitMissing } from "../lib/intake.ts";
import { isSent, showEmergency } from "../state/visitReducer.ts";

const HANDOFF_MAX = 300;

function SubmitDialog({ visit, open, onClose, onDone }: { visit: VisitController; open: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const missing = visit.state.intake ? splitMissing(visit.state.intake.missing).required.length : 0;
  return (
    <Dialog open={open} onClose={onClose} title={t("submit.title")}>
      <p>{t("submit.body")}</p>
      {missing > 0 ? <p className="text-sm text-muted">{t("submit.missing", { count: missing })}</p> : null}
      {visit.actionError ? (
        <div className="notice" role="alert">
          <Icon name="alert" />
          <p>{t(describeFailure(visit.actionError).key, describeFailure(visit.actionError).params)}</p>
        </div>
      ) : null}
      <div className="dialog__actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {t("submit.back")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const ok = await visit.submit();
            setBusy(false);
            if (ok) onDone();
          }}
        >
          {busy ? t("submit.sending") : t("submit.confirm")}
        </button>
      </div>
    </Dialog>
  );
}

function HandoffDialog({ visit, open, onClose }: { visit: VisitController; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [ticketNo, setTicketNo] = useState<string | null>(null);
  const length = charCount(note);

  useEffect(() => {
    if (!open) {
      setNote("");
      setTicketNo(null);
    }
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title={t("handoff.title")}>
      {ticketNo ? (
        <>
          <div className="notice notice--info" role="status">
            <Icon name="ticket" />
            <p>
              {t("handoff.done")} <b className="mono">{ticketNo}</b>
            </p>
          </div>
          <div className="dialog__actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              {t("common.close")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p>{t("handoff.body")}</p>
          <div className="form-field">
            <label htmlFor="handoff-note">{t("handoff.note")}</label>
            <textarea id="handoff-note" className="field" rows={3} value={note} onChange={(e) => setNote(e.target.value)} aria-describedby="handoff-count" />
            <span id="handoff-count" className={`form-hint${length > HANDOFF_MAX ? " form-hint--warn" : ""}`}>
              {length}／{HANDOFF_MAX}
              {length > HANDOFF_MAX ? ` ${t("handoff.tooLong")}` : ""}
            </span>
          </div>
          {visit.actionError ? (
            <div className="notice" role="alert">
              <Icon name="alert" />
              <p>{t(describeFailure(visit.actionError).key, describeFailure(visit.actionError).params)}</p>
            </div>
          ) : null}
          <div className="dialog__actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || length > HANDOFF_MAX}
              onClick={async () => {
                setBusy(true);
                const ticket = await visit.handoff(note);
                setBusy(false);
                if (ticket) {
                  setTicketNo(ticket.ticket_no);
                  void visit.refresh(); // the note goes through the red-flag check on the server too
                }
              }}
            >
              {t("handoff.send")}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}

export function PatientPage() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const visit = useVisit(locale);
  const { meta, maxChars } = useMeta();
  const [active, setActive] = useState<PaneKey>("chat");
  const [panel, setPanel] = useState<PanelKey>("trace");
  const [submitOpen, setSubmitOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const { state, phase } = visit;

  useEffect(() => {
    document.title = t("app.title");
  }, [t, locale]);

  const select = (k: PaneKey) => {
    setActive(k);
    if (k !== "chat") setPanel(k);
  };
  const selectPanel = (k: PanelKey) => {
    setPanel(k);
    setActive(k);
  };

  const sent = isSent(state.visit);
  const traceCount = state.trace.filter((r) => r.name !== "pii_filter").length;
  const emergency = showEmergency(state);
  const serverToday = meta?.server_today ?? todayInTaipei();

  return (
    <div className="app" data-active={active} data-panel={panel}>
      <div className="app__grid">
        <AppHeader sub={t("app.sub")} />
        <h1 className="visually-hidden">{t("app.title")}</h1>
        <div className="ai-banner" role="note">
          <Icon name="info" />
          <p>
            <strong>{t("banner.lead")}</strong>
            {t("banner.rest")}
          </p>
          <Link className="ai-banner__more" to="/safety">
            {t("banner.more")}
          </Link>
        </div>
        <div className="app-body" id="main" tabIndex={-1}>
          <ChatPane visit={visit} phase={phase} maxChars={maxChars} onFinish={() => setSubmitOpen(true)} onHandoff={() => setHandoffOpen(true)} />
          <aside className="panel" aria-label={t("panel.label")}>
            <PanelTabs panel={panel} onSelect={selectPanel} traceCount={traceCount} />
            <section className="pane pane--trace" id="pane-trace" role="tabpanel" aria-labelledby="ptab-trace" aria-label={t("panel.trace")}>
              <div className="pane__scroll">
                <TracePanel trace={state.trace} runs={state.runs} guards={state.guards} />
              </div>
            </section>
            <section className="pane pane--summary" id="pane-summary" role="tabpanel" aria-labelledby="ptab-summary" aria-label={t("panel.summary")}>
              <div className="pane__scroll">
                <SummaryPanel intake={state.intake} summary={state.summary} closed={sent} hasVisit={state.visit !== null} onSubmit={() => setSubmitOpen(true)} />
              </div>
            </section>
            <section className="pane pane--refill" id="pane-refill" role="tabpanel" aria-labelledby="ptab-refill" aria-label={t("panel.refill")}>
              <div className="pane__scroll">
                <RefillPanel visit={visit} serverToday={serverToday} />
              </div>
            </section>
          </aside>
        </div>
        <MobileTabBar active={active} onSelect={select} alert={emergency} />
      </div>

      <SubmitDialog
        visit={visit}
        open={submitOpen}
        onClose={() => {
          setSubmitOpen(false);
          visit.clearActionError();
        }}
        onDone={() => {
          setSubmitOpen(false);
          select("summary");
        }}
      />
      <HandoffDialog
        visit={visit}
        open={handoffOpen}
        onClose={() => {
          setHandoffOpen(false);
          visit.clearActionError();
        }}
      />
    </div>
  );
}
