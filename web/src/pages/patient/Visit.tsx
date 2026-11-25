import { IconFileText, IconHeadset, IconPhoneCall, IconPlugConnectedX, IconRefresh, IconSend, IconUserHeart } from "@tabler/icons-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router";

import type { Message } from "@/api/types";
import { useDraft, useHandoff, useLeaveGuard, useMeta, useOutbox, useVisitStream, type OutboxItem, type VisitStreamHandle } from "@/data";
import { composerMode, isSent } from "@/lib/composer";
import { describeRunFailure } from "@/lib/errors";
import { taipeiDate } from "@/lib/format";
import { groupTrace, type TraceGroup } from "@/lib/trace";
import { useFullHeight } from "@/shells/PatientShell";
import {
  AssistantBubble,
  AssistantThinking,
  Banner,
  Button,
  ButtonLink,
  Composer,
  DayDivider,
  DiffMergeDialog,
  NoticeLine,
  OpeningNote,
  PageBody,
  PatientBubble,
  QuickReplies,
  RedFlagNote,
  RefusalNote,
  Sheet,
  SkeletonRows,
  StaffBubble,
  StatusTag,
  Transcript,
  useMediaQuery,
  useOnline,
  usePersistentState,
} from "@/ui";

import { ActionError, LoadError, useErrorText, useFmt } from "./shared";
import { DoctorNote } from "./visit/DoctorNote";
import { Facts } from "./visit/Facts";
import { appendText, askedIn, CHIPS } from "./visit/quick";
import { ReviewScreen } from "./visit/ReviewScreen";
import { SectionsLine, sectionsOf, SidePanel } from "./visit/SidePanel";
import { Scale } from "./visit/SummaryFields";
import { Sources, ToolOutcomes, TurnRecord } from "./visit/TurnRecord";

export default function Visit() {
  const { id = "" } = useParams();
  // A new visit gets new controllers and clean local state.
  return <VisitScreen key={id} id={id} />;
}

function VisitScreen({ id }: { id: string }) {
  useFullHeight();
  const state = useVisitStream(id);
  const [params, setParams] = useSearchParams();
  const outbox = useOutbox(id);
  const reviewing = params.get("step") === "review";
  useLeaveGuard(`outbox:${id}`, outbox.hasUnsent, "errors:leave.unsent");

  if (state.phase === "error" && !state.loaded)
    return (
      <PageBody>
        <LoadError error={state.error} onRetry={state.reconnect} />
      </PageBody>
    );
  if (!state.visit)
    return (
      <PageBody>
        <SkeletonRows rows={6} />
      </PageBody>
    );
  if (reviewing && !isSent(state.visit))
    return (
      <ReviewScreen
        state={state}
        unsent={outbox.items.filter((i) => i.status !== "sent").length}
        onBack={() => setParams({}, { replace: true })}
        onDone={() => setParams({}, { replace: true })}
      />
    );
  return <Conversation id={id} state={state} outbox={outbox} onReview={() => setParams({ step: "review" })} />;
}

type OutboxHandle = ReturnType<typeof useOutbox>;

function Conversation({ id, state, outbox, onReview }: { id: string; state: VisitStreamHandle; outbox: OutboxHandle; onReview: () => void }) {
  const { t } = useTranslation(["patient", "errors"]);
  const f = useFmt();
  const wide = useMediaQuery("(min-width: 75rem)");
  const online = useOnline();
  const meta = useMeta();
  const visit = state.visit!;
  const sent = isSent(visit);
  const mode = composerMode(visit);
  const draft = useDraft<string>(`visit:${id}:composer`, "");
  const [panel, setPanel] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [factsOff, setFactsOff] = usePersistentState(`pv-facts:${id}`, false);
  const max = meta.data?.max_message_chars ?? 500;

  const focusComposer = () => document.querySelector<HTMLTextAreaElement>(".visit-chat .composer textarea")?.focus();
  const addText = (text: string) => {
    draft.set((v) => appendText(v, text, t("patient:common.clauseSep")));
    focusComposer();
  };
  const jump = (messageId: string) => {
    setPanel(false);
    setHighlight(messageId);
    // After the sheet has closed on phones.
    setTimeout(() => {
      const el = document.getElementById(`m-${messageId}`);
      el?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      el?.setAttribute("tabindex", "-1");
      el?.focus({ preventScroll: true });
    }, wide ? 0 : 320);
  };
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), 6000);
    return () => clearTimeout(timer);
  }, [highlight]);

  const send = async (text: string) => {
    await outbox.send(text);
  };
  const sendDraft = () => {
    const text = draft.value.trim();
    if (!text) return;
    void send(text).then(() => draft.clear());
  };

  const pending = outbox.items.filter((i) => i.status !== "sent" || !state.messages.some((m) => m.client_id === i.client_id));
  const pendingShown = pending.filter((i) => !state.messages.some((m) => m.client_id === i.client_id));
  const running = state.run.phase === "running";
  const lastMessage = state.messages.at(-1);
  const asked = mode === "open" && !running && pendingShown.length === 0 && lastMessage?.role === "assistant" && (lastMessage.kind === "chat" || lastMessage.kind === "opening") ? askedIn(lastMessage.content) : null;
  const intake = state.intake?.state;
  const showFacts =
    mode === "open" && !sent && !factsOff && !running && Boolean(intake?.chief_complaint) && Boolean(intake && (!intake.past_history.answered || !intake.medications.answered || !intake.allergies.answered));
  const sections = sectionsOf(state.intake, state.summary, sent);
  const aiOff = meta.data && mode === "open" && (!meta.data.ai_enabled || meta.data.daily_limit_reached);

  return (
    <>
      <header className="chat-head">
        <div className="min-w-0 flex-1">
          <h1 tabIndex={-1}>{visit.title}</h1>
          <p className="num">
            <StatusTag family="visit" status={visit.status} plain />
            {visit.appointment && <span className="ms-2">{t("patient:visit.forAppt", { date: f.dateTime(visit.appointment.starts_at), doctor: f.person(visit.appointment.physician) })}</span>}
          </p>
        </div>
        {!wide && (
          <Button size="sm" icon={<IconFileText aria-hidden />} onClick={() => setPanel(true)}>
            {t("patient:sum.short")}
          </Button>
        )}
        {!sent && mode !== "human" && (
          <Button size="sm" variant="primary" icon={<IconSend aria-hidden />} onClick={onReview}>
            {t("patient:visit.finish")}
          </Button>
        )}
        {sent && (
          <ButtonLink size="sm" to={`/app/visits/${id}/summary`}>
            {t("patient:visit.seeSummary")}
          </ButtonLink>
        )}
      </header>

      {state.redFlag && <RedFlagStrip />}
      {mode === "human" && (
        <p className="visit-strip" data-tone="human" role="status">
          <IconUserHeart aria-hidden />
          <span>{t("patient:visit.humanNow", { name: f.person(visit.assigned_to) || t("patient:common.careTeam") })}</span>
        </p>
      )}
      {!wide && !sent && mode === "open" && (
        <div className="visit-strip num">
          <div className="w-full">
            <SectionsLine sections={sections} />
          </div>
        </div>
      )}
      {(state.connection === "retrying" || state.connection === "offline") && online && (
        <p className="visit-strip" data-tone="warn" role="status">
          <IconPlugConnectedX aria-hidden />
          <span>{t("errors:connection.retrying")}</span>
          <button type="button" className="link" onClick={state.reconnect}>
            {t("patient:visit.reconnect")}
          </button>
        </p>
      )}

      <div className="visit-grid" data-panel={wide}>
        <div className="visit-chat">
          <Transcript label={visit.title} follow={`${state.messages.length}:${state.live?.text.length ?? 0}:${pendingShown.length}:${state.run.phase}`}>
            <Messages state={state} highlight={highlight} />
            {pendingShown.map((i) => (
              <OutboxBubble key={i.client_id} item={i} outbox={outbox} online={online} onTakeBack={addText} />
            ))}
            {running && state.live && state.live.text !== "" && <AssistantBubble streaming>{state.live.text}</AssistantBubble>}
            {running && (!state.live || state.live.text === "") && <Thinking state={state} />}
            <RunProblem state={state} />
            {sent && (
              <NoticeLine>
                {visit.status === "reviewed" ? t("patient:visit.reviewedLine", { name: f.person(visit.reviewed_by), date: f.dateTime(visit.reviewed_at) }) : t("patient:visit.sentLine", { date: f.dateTime(visit.submitted_at) })}
              </NoticeLine>
            )}
            <DoctorNote note={state.note} visit={visit} />
          </Transcript>

          <div className="visit-under grid gap-2">
            {aiOff && (
              <Banner tone="warn" title={t(meta.data?.ai_enabled ? "patient:visit.budgetTitle" : "patient:visit.aiOffTitle")}>
                {t("patient:visit.aiOffBody")}
              </Banner>
            )}
            {showFacts && (
              <Facts
                onDismiss={() => setFactsOff(true)}
                onSend={(text) => {
                  setFactsOff(true);
                  void send(text);
                }}
              />
            )}
            {asked === "severity" && draft.value === "" && <Scale value={null} label={t("patient:quick.scaleLabel")} onPick={(n) => addText(t("patient:quick.scaleText", { n }))} />}
            {asked && asked !== "severity" && draft.value === "" && (
              <QuickReplies label={t("patient:quick.label")} options={CHIPS[asked].map((k) => t(`patient:quick.${asked}.${k}`))} onPick={addText} />
            )}
          </div>

          {mode === "paused" ? (
            <PausedFoot id={id} onReview={onReview} sent={sent} tickets={state.tickets.map((x) => x.ticket_no)} />
          ) : (
            <Composer
              value={draft.value}
              onValueChange={(v) => draft.set(v)}
              onSend={sendDraft}
              disabled={mode === "closed" || !draft.ready}
              disabledReason={
                mode === "closed" ? (
                  <>
                    {t("patient:visit.closed")} <ButtonLink size="sm" to="/app/messages">{t("patient:visit.closedMessages")}</ButtonLink>
                  </>
                ) : undefined
              }
              max={max}
              label={t("patient:visit.composer")}
              placeholder={mode === "human" ? t("patient:visit.composerHuman") : t("patient:visit.composer")}
              draft={draft.status === "saved" || draft.status === "saving" || draft.status === "offline" ? draft.status : null}
              queued={pending.filter((i) => i.status === "queued").length}
              offline={!online}
              autoFocus
              accessory={mode === "open" ? <ComposerNotes id={id} tickets={state.tickets.length} /> : undefined}
            />
          )}
        </div>
        {wide && (
          <aside className="visit-panel" aria-label={t("patient:sum.title")}>
            <SidePanel visit={visit} intake={state.intake} summary={state.summary} onJump={jump} onCorrect={(label) => addText(t("patient:sum.correctionText", { field: label }))} />
          </aside>
        )}
      </div>
      {!wide && (
        <Sheet open={panel} onOpenChange={setPanel} title={t("patient:sum.title")}>
          <SidePanel
            visit={visit}
            intake={state.intake}
            summary={state.summary}
            onJump={jump}
            heading={false}
            onCorrect={(label) => {
              setPanel(false);
              addText(t("patient:sum.correctionText", { field: label }));
            }}
          />
        </Sheet>
      )}
      <DraftConflict draft={draft} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------- transcript

function Messages({ state, highlight }: { state: VisitStreamHandle; highlight: string | null }) {
  const groups = useMemo(() => {
    const map = new Map<string, TraceGroup>();
    for (const g of groupTrace(state.trace, state.runs)) map.set(g.key, g);
    return map;
  }, [state.trace, state.runs]);
  let day = "";
  // The record belongs under the last message of its run.
  const lastOfRun = new Map<string, string>();
  for (const m of state.messages) if (m.run_id && m.role === "assistant") lastOfRun.set(m.run_id, m.id);
  return (
    <>
      {state.messages.map((m) => {
        const d = taipeiDate(m.created_at);
        const divider = d !== day && m.kind !== "opening";
        if (divider) day = d;
        const group = m.run_id && lastOfRun.get(m.run_id) === m.id ? groups.get(m.run_id) : undefined;
        return <MessageItem key={m.id} message={m} divider={divider} group={group} state={state} highlighted={highlight === m.id} />;
      })}
    </>
  );
}

function MessageItem({ message: m, divider, group, state, highlighted }: { message: Message; divider: boolean; group?: TraceGroup; state: VisitStreamHandle; highlighted: boolean }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const common = { id: `m-${m.id}`, time: f.time(m.created_at), dateTime: m.created_at, highlighted };
  const ticket = state.tickets.find((x) => x.reason !== "red_flag" && x.status === "open");
  let body: ReactNode;
  if (m.role === "patient") body = <PatientBubble {...common}>{m.content}</PatientBubble>;
  else if (m.role === "staff")
    body = (
      <StaffBubble {...common} name={m.author?.display_name ?? t("common.careTeam")} title={m.author?.title}>
        {m.content}
      </StaffBubble>
    );
  else if (m.kind === "opening") body = <OpeningNote>{m.content}</OpeningNote>;
  else if (m.kind === "red_flag") body = <RedFlagNote kind={state.redFlag?.category === "suicide" ? "crisis" : "medical"}>{m.content}</RedFlagNote>;
  else if (m.kind === "refusal")
    body = (
      <RefusalNote
        actions={
          <>
            {ticket && <span className="num self-center text-sm">{t("visit.ticketLine", { no: ticket.ticket_no })}</span>}
            <ButtonLink size="sm" to="/app/medications">
              {t("visit.toMeds")}
            </ButtonLink>
            <ButtonLink size="sm" to="/app/messages">
              {t("visit.toMessages")}
            </ButtonLink>
          </>
        }
      >
        {m.content}
      </RefusalNote>
    );
  else if (m.kind === "notice" || m.kind === "handoff") body = <NoticeLine>{m.content}</NoticeLine>;
  else
    body = (
      <AssistantBubble {...common} interrupted={m.status === "interrupted"} onRetry={state.canRetry && !state.retrying ? state.retryRun : undefined}>
        {m.content}
      </AssistantBubble>
    );
  return (
    <>
      {divider && <DayDivider>{f.date(m.created_at, "full")}</DayDivider>}
      {group ? (
        <div className="grid min-w-0 gap-1">
          {body}
          <Sources rows={group.rows} />
          <ToolOutcomes rows={group.rows} />
          <TurnRecord group={group} />
        </div>
      ) : (
        body
      )}
    </>
  );
}

function Thinking({ state }: { state: VisitStreamHandle }) {
  const { t } = useTranslation("patient");
  const active = state.trace.findLast((r) => r.status === "running");
  return <AssistantThinking label={active ? t(`trace.doing.${active.name}`, { defaultValue: t("trace.doing.default") }) : undefined} />;
}

/** A turn that stopped: what happened, and one button to run it again when that can help. */
function RunProblem({ state }: { state: VisitStreamHandle }) {
  const { t } = useTranslation(["patient", "errors"]);
  const { phase, code } = state.run;
  const last = state.messages.at(-1);
  if (phase !== "failed" && phase !== "interrupted") return null;
  if (last?.status === "interrupted") return null; // its bubble has the button
  const d = describeRunFailure(code);
  return (
    <Banner
      tone="warn"
      role="alert"
      actions={
        state.canRetry && d.retryable ? (
          <Button size="sm" icon={<IconRefresh aria-hidden />} onClick={state.retryRun} loading={state.retrying}>
            {t("patient:visit.retryTurn")}
          </Button>
        ) : undefined
      }
    >
      {t(d.key, d.params)}
      {state.retryError && <RetryError error={state.retryError} />}
    </Banner>
  );
}
function RetryError({ error }: { error: Error }) {
  const text = useErrorText();
  return <p className="mt-1">{text(error)}</p>;
}

function OutboxBubble({ item, outbox, online, onTakeBack }: { item: OutboxItem; outbox: OutboxHandle; online: boolean; onTakeBack: (text: string) => void }) {
  const { t } = useTranslation(["patient", "errors"]);
  const errorText = useErrorTextByCode();
  // Online and never tried: it waits for the running turn, not for the network.
  const state = item.status === "failed" ? "failed" : item.status === "queued" && (!online || item.attempts > 0) ? "queued" : "sending";
  return (
    <div className="grid justify-items-end gap-1">
      <PatientBubble state={state} onRetry={() => outbox.retry(item.client_id)}>
        {item.content}
      </PatientBubble>
      {item.status === "failed" && (
        <p className="flex flex-wrap items-center justify-end gap-x-3 text-sm text-fg-2">
          {item.error && <span>{errorText(item.error)}</span>}
          <button type="button" className="link min-h-11" onClick={() => void outbox.discard(item.client_id).then((text) => text && onTakeBack(text))}>
            {t("patient:visit.takeBack")}
          </button>
        </p>
      )}
    </div>
  );
}
function useErrorTextByCode() {
  const { t } = useTranslation("errors");
  return (e: NonNullable<OutboxItem["error"]>) => {
    switch (e.code) {
      case "rate_limited":
        return t("errors:rateLimited", { seconds: e.retryAfter ?? 30 });
      case "visit_closed":
        return t("errors:visitClosed");
      case "offline":
        return t("errors:offline");
      case "payload_too_large":
        return t("errors:tooLarge");
      default:
        return e.message || t("errors:internal");
    }
  };
}

// ---------------------------------------------------------------------------------------------- around the composer

function RedFlagStrip() {
  const { t } = useTranslation("patient");
  return (
    <div className="visit-strip" data-tone="danger">
      <IconPhoneCall aria-hidden />
      <span>{t("visit.redFlagStrip")}</span>
      <span className="calls">
        <a className="btn" data-variant="emergency" data-size="sm" href="tel:119">
          {t("visit.call119")}
        </a>
        <a className="btn" data-variant="secondary" data-size="sm" href="tel:1925">
          {t("visit.call1925")}
        </a>
      </span>
    </div>
  );
}

/** After a red flag the assistant stops. What is left: send what there is, or be called by the clinic. */
function PausedFoot({ id, sent, onReview, tickets }: { id: string; sent: boolean; onReview: () => void; tickets: string[] }) {
  const { t } = useTranslation("patient");
  return (
    <div className="composer">
      <div className="composer-closed">
        <p>{t("visit.paused")}</p>
        {tickets.length > 0 && <p className="num mt-1">{t("visit.pausedTicket", { no: tickets[tickets.length - 1] })}</p>}
        <div className="mt-3 flex flex-wrap gap-3">
          {!sent && (
            <Button size="sm" onClick={onReview}>
              {t("visit.sendAnyway")}
            </Button>
          )}
          <HandoffButton id={id} />
        </div>
      </div>
    </div>
  );
}

function ComposerNotes({ id, tickets }: { id: string; tickets: number }) {
  const { t } = useTranslation("patient");
  return (
    <span className="flex flex-wrap items-center gap-x-3">
      <span className="text-fg-3">{t("visit.fictional")}</span>
      <HandoffButton id={id} quiet again={tickets > 0} />
    </span>
  );
}

/** "Ask the clinic to contact me", with an optional note. */
function HandoffButton({ id, quiet, again }: { id: string; quiet?: boolean; again?: boolean }) {
  const { t } = useTranslation("patient");
  const handoff = useHandoff(id);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const done = handoff.data;
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      title={t("handoff.title")}
      trigger={
        quiet ? (
          <button type="button" className="link inline-flex min-h-8 items-center gap-1">
            <IconHeadset size={17} aria-hidden />
            {t("handoff.open")}
          </button>
        ) : (
          <Button size="sm" icon={<IconHeadset aria-hidden />}>
            {t("handoff.open")}
          </Button>
        )
      }
      footer={
        done ? (
          <Button block onClick={() => setOpen(false)}>
            {t("common.close")}
          </Button>
        ) : (
          <Button variant="primary" block loading={handoff.isPending} onClick={() => handoff.mutate({ reason: "patient_request", ...(note.trim() ? { note: note.trim() } : {}) })}>
            {t("handoff.send")}
          </Button>
        )
      }
    >
      {done ? (
        <Banner tone="ok" title={t("handoff.done")}>
          {t("handoff.doneBody", { no: done.ticket_no })}
        </Banner>
      ) : (
        <div className="grid gap-4">
          <p>{t("handoff.body")}</p>
          {again && <p className="text-fg-2">{t("handoff.again")}</p>}
          <label className="field">
            <span className="field-label">{t("handoff.note")}</span>
            <textarea className="control" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <ActionError error={handoff.error} />
        </div>
      )}
    </Sheet>
  );
}

/** The same unsent message was written on two devices. */
function DraftConflict({ draft }: { draft: ReturnType<typeof useDraft<string>> }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const c = draft.conflict;
  const [later, setLater] = useState(false);
  useEffect(() => {
    if (!c) setLater(false);
  }, [c]);
  if (!c || later) return null;
  return (
    <DiffMergeDialog
      open
      onOpenChange={(o) => !o && setLater(true)}
      fields={[{ key: "text", label: t("visit.composer"), mine: c.mine, theirs: c.theirs ?? "" }]}
      theirsLabel={c.theirs === null ? t("visit.draftGone") : t("visit.draftOther", { date: f.dateTime(c.theirsUpdatedAt) })}
      onMerge={(choice) => draft.resolve(choice.text === "mine" ? "mine" : "theirs")}
    />
  );
}
