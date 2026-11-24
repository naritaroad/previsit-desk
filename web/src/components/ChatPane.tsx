// Left pane of the patient page: header with stage and progress, the conversation, notices and the
// composer. The emergency card sticks to the top whenever the server reports a red-flag hit.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import type { RedFlagHit } from "../api/types.ts";
import { currentLocale } from "../i18n/index.ts";
import { charCount, composerBlock, counterState, shouldSendOnKey } from "../lib/composer.ts";
import { describeFailure } from "../lib/errors.ts";
import { formatCount, formatTime } from "../lib/format.ts";
import type { VisitController, VisitPhase } from "../hooks/useVisit.ts";
import { composerMode, redFlagText, showEmergency, type ChatMessage } from "../state/visitReducer.ts";
import { Icon } from "./Icon.tsx";
import { ProgressBar } from "./SummaryPanel.tsx";

function MessageBubble({ m, onRetry }: { m: ChatMessage; onRetry: () => void }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const time = formatTime(m.created_at, locale);

  if (m.role === "patient") {
    const state = m.pending ? (
      <span>{t("chat.sending")}</span>
    ) : m.failed ? (
      <span className="msg__failed">{t("chat.notSent")}</span>
    ) : (
      <time dateTime={m.created_at}>{time}</time>
    );
    return (
      <div className="msg msg--patient">
        <div className="msg__body">
          <div className="msg__bubble">{m.content}</div>
          <div className="msg__meta">
            {state}
            {m.failed ? (
              <button type="button" className="link-btn" onClick={onRetry}>
                {t("chat.resend")}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const opening = m.kind === "opening";
  const tag =
    m.kind === "opening" ? (
      <span className="kind-tag">
        <Icon name="info" size="sm" />
        {t("chat.tagOpening")}
      </span>
    ) : m.kind === "red_flag" || m.kind === "refusal" ? (
      <span className="kind-tag">
        <Icon name="shield" size="sm" />
        {t("chat.tagRule")}
      </span>
    ) : m.kind === "notice" ? (
      <span className="kind-tag">
        <Icon name="info" size="sm" />
        {t("chat.tagNotice")}
      </span>
    ) : null;
  return (
    <div className={`msg msg--assistant${opening ? " msg--opening" : ""}`}>
      <div className="msg__avatar" aria-hidden="true">
        <Icon name="chat" size="sm" />
      </div>
      <div className="msg__body">
        <div className="msg__bubble">{m.content}</div>
        <div className="msg__meta">
          <time dateTime={m.created_at}>{time}</time>
          {tag}
        </div>
      </div>
    </div>
  );
}

function CallButton({ number, kind, label }: { number: "119" | "1925"; kind: string; label: string }) {
  return (
    <a className={`call-btn call-btn--${kind}`} href={`tel:${number}`}>
      <Icon name="phone" size="lg" />
      <span>
        <span className="call-btn__num">{number}</span>
        <span className="call-btn__label">{label}</span>
      </span>
    </a>
  );
}

export function EmergencyCard({ hit, text, ticketNo }: { hit: RedFlagHit; text: string | null; ticketNo: string | null }) {
  const { t } = useTranslation();
  const mind = hit.category === "suicide";
  const call119 = <CallButton key="119" number="119" kind="119" label={t("emergency.call119")} />;
  const call1925 = <CallButton key="1925" number="1925" kind="1925" label={t("emergency.call1925")} />;
  return (
    <div className="emergency-wrap">
      <section className="emergency" role="alert" aria-labelledby="em-title">
        <div className="emergency__head">
          <div className="emergency__icon" aria-hidden="true">
            <Icon name="alert" size="lg" />
          </div>
          <div>
            <h2 className="emergency__title" id="em-title">
              {mind ? t("emergency.titleMind") : t("emergency.title")}
            </h2>
            <p className="emergency__hit">{t("emergency.hit", { label: hit.label })}</p>
          </div>
        </div>
        <p className="emergency__text">{text ?? t(mind ? "emergency.fallbackMind" : "emergency.fallback")}</p>
        <div className="emergency__actions">{mind ? [call1925, call119] : [call119, call1925]}</div>
        {ticketNo ? <p className="emergency__foot">{t("emergency.ticket", { no: ticketNo })}</p> : null}
      </section>
    </div>
  );
}

interface ComposerProps {
  visit: VisitController;
  maxChars: number;
  onFinish: () => void;
  onHandoff: () => void;
}

function Composer({ visit, maxChars, onFinish, onHandoff }: ComposerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const { state } = visit;
  const mode = composerMode(state.visit);
  const count = charCount(text);
  const block = composerBlock(text, maxChars, state.busy, mode !== "open");
  const counter = counterState(count, maxChars);
  const locale = currentLocale();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  function submit() {
    if (block) return;
    const value = text.trim();
    setText("");
    void visit.send(value);
    ref.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (shouldSendOnKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) {
      e.preventDefault();
      submit();
    }
  }

  if (mode !== "open") {
    return (
      <div className="composer">
        <div className="composer__inner">
          <div className="composer__closed">
            <span>{t(mode === "paused" ? "composer.paused" : "composer.closed")}</span>
            <button type="button" className="btn btn-secondary" onClick={() => void visit.startNew()}>
              {t("composer.startNew")}
            </button>
          </div>
          {mode === "closed" ? <p className="composer__emergency-note">{t("composer.emergencyNote")}</p> : null}
        </div>
      </div>
    );
  }

  const counterId = "composer-count";
  return (
    <div className="composer">
      <div className="composer__inner">
        <label className="visually-hidden" htmlFor="composer-input">
          {t("composer.label")}
        </label>
        <div className="composer__row">
          <textarea
            id="composer-input"
            ref={ref}
            className="field"
            rows={1}
            value={text}
            placeholder={t("composer.placeholder")}
            aria-describedby={counterId}
            aria-invalid={counter === "over" ? true : undefined}
            enterKeyHint="send"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="button" className="btn btn-primary" aria-label={t("composer.send")} disabled={block !== null} onClick={submit}>
            <Icon name="send" />
          </button>
        </div>
        <div className="composer__foot">
          <span id={counterId} className={`composer__count composer__count--${counter}`}>
            {t("composer.hint")}・<span className="num">{formatCount(count, locale)}／{formatCount(maxChars, locale)}</span>
            {counter === "over" ? ` ${t("composer.tooLong")}` : ""}
          </span>
          <span className="composer__actions">
            <button type="button" className="btn btn-ghost btn-compact" onClick={onHandoff} disabled={state.visit === null}>
              {t("composer.handoff")}
            </button>
            <button type="button" className="btn btn-ghost btn-compact" onClick={onFinish} disabled={state.visit === null || state.busy}>
              {t("composer.finish")}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

function Skeleton() {
  const { t } = useTranslation();
  return (
    <div className="stack-sm" aria-busy="true" aria-label={t("common.loading")}>
      <div className="skel" style={{ width: "60%" }} />
      <div className="skel" />
      <div className="skel" style={{ width: "80%" }} />
    </div>
  );
}

interface ChatPaneProps {
  visit: VisitController;
  phase: VisitPhase;
  maxChars: number;
  onFinish: () => void;
  onHandoff: () => void;
}

export function ChatPane({ visit, phase, maxChars, onFinish, onHandoff }: ChatPaneProps) {
  const { t } = useTranslation();
  const { state } = visit;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const emergency = showEmergency(state);
  const mode = composerMode(state.visit);
  const lastMessage = state.messages.at(-1);
  const failure = state.failure;
  // The server also stores a fixed notice for failed runs; do not show the same news twice.
  const noticeAlreadyShown = failure && lastMessage?.kind === "notice" && lastMessage.role === "assistant";
  const failureText = failure && !noticeAlreadyShown ? describeFailure(failure) : null;
  const ticketNo = state.tickets.find((x) => x.reason === "red_flag" && x.status === "open")?.ticket_no ?? state.tickets.find((x) => x.reason === "red_flag")?.ticket_no ?? null;

  // Keep the newest text in view unless the reader scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.messages.length, state.streaming?.text, state.busy, phase]);

  const typing = state.busy && !state.streaming;

  return (
    <section className="pane pane--chat" id="pane-chat" aria-label={t("chat.paneLabel")}>
      <div className="pane__head">
        <span className="pane__title">{t("chat.title")}</span>
        {state.visit && phase === "ready" ? (
          mode === "paused" ? (
            <span className="urg urg--urgent">
              <Icon name="alert" size="sm" />
              {t("chat.paused")}
            </span>
          ) : mode === "closed" ? (
            <span className="stage-chip">{t("stage.done")}</span>
          ) : (
            <>
              <span className="stage-chip">{t(`stage.${state.intake?.stage ?? state.visit.stage}`)}</span>
              {state.intake ? <ProgressBar intake={state.intake} /> : null}
            </>
          )
        ) : null}
      </div>

      <div
        className="pane__scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {emergency && state.redFlag ? <EmergencyCard hit={state.redFlag} text={redFlagText(state.messages)} ticketNo={ticketNo} /> : null}

        {phase === "idle" || phase === "missing" ? (
          <div className="start-card">
            <Icon name="chat" size="lg" />
            <h2>{t(phase === "missing" ? "chat.missingTitle" : "chat.startTitle")}</h2>
            <p>{t(phase === "missing" ? "chat.missingBody" : "chat.startBody")}</p>
            <button type="button" className="btn btn-primary" onClick={() => void visit.start()}>
              {t(phase === "missing" ? "composer.startNew" : "chat.start")}
            </button>
            {visit.actionError ? (
              <div className="notice" role="alert">
                <Icon name="alert" />
                <p>{t(describeFailure(visit.actionError).key, describeFailure(visit.actionError).params)}</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {phase === "loading" ? <Skeleton /> : null}

        {phase === "offline" ? (
          <div className="notice" role="alert">
            <Icon name="wifi" />
            <div>
              <b>{t("errors.offlineTitle")}</b>
              <p>{t("errors.offlineLoad")}</p>
              <button type="button" className="btn btn-secondary btn-compact" onClick={visit.reload}>
                {t("common.retry")}
              </button>
            </div>
          </div>
        ) : null}

        {phase === "ready" ? (
          <div className="chat-log" role="log" aria-live="polite" aria-relevant="additions" aria-busy={state.busy} aria-label={t("chat.logLabel")}>
            {state.messages.map((m) => (
              <MessageBubble key={m.id} m={m} onRetry={visit.retry} />
            ))}
            {state.streaming ? (
              <div className="msg msg--assistant">
                <div className="msg__avatar" aria-hidden="true">
                  <Icon name="chat" size="sm" />
                </div>
                <div className="msg__body">
                  <div className="msg__bubble">
                    {state.streaming.text}
                    <span className="caret" aria-hidden="true" />
                  </div>
                  <div className="msg__meta">
                    <span>{t("chat.replying")}</span>
                  </div>
                </div>
              </div>
            ) : typing ? (
              <div className="msg msg--assistant">
                <div className="msg__avatar" aria-hidden="true">
                  <Icon name="chat" size="sm" />
                </div>
                <div className="msg__body">
                  <div className="msg__bubble typing" aria-label={t("chat.typing")}>
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {phase === "ready" ? (
        <div className="pane__notices">
          {state.piiMasked > 0 ? (
            <div className="notice notice--info" role="status">
              <Icon name="shield" />
              <p>{t("chat.piiMasked")}</p>
            </div>
          ) : null}
          {failureText ? (
            <div className="notice" role="status">
              <Icon name={failureText.key === "errors.offline" ? "wifi" : "alert"} />
              <div>
                <p>{t(failureText.key, failureText.params)}</p>
                {failureText.retryable && state.messages.some((m) => m.failed) ? (
                  <button type="button" className="btn btn-secondary btn-compact" onClick={visit.retry}>
                    {t("chat.resend")}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {visit.actionError ? (
            <div className="notice" role="status">
              <Icon name="alert" />
              <p>{t(describeFailure(visit.actionError).key, describeFailure(visit.actionError).params)}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {phase === "ready" ? <Composer visit={visit} maxChars={maxChars} onFinish={onFinish} onHandoff={onHandoff} /> : null}
    </section>
  );
}

