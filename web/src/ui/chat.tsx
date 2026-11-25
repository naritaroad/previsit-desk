import { IconArrowDown, IconArrowUp, IconCloudOff, IconInfoCircle, IconLoader2, IconNotebook, IconPlayerStopFilled, IconRefresh, IconShieldCheck, IconStethoscope } from "@tabler/icons-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "./button";
import { cn } from "./cn";
import { Avatar } from "./display";
import { EmergencyPanel } from "./emergency";

/* ----- Bubbles ----- */

export interface BubbleProps {
  children: ReactNode;
  /** Already formatted, e.g. 14:05. */
  time?: string;
  dateTime?: string;
  id?: string;
  /** Scroll target of an evidence link in the review desk. */
  highlighted?: boolean;
}

/** What the patient wrote. `state` covers the offline queue and failed sends. */
export function PatientBubble({ children, time, dateTime, id, highlighted, state = "sent", onRetry, author }: BubbleProps & { state?: "sent" | "sending" | "queued" | "failed"; onRetry?: () => void; author?: string }) {
  const { t } = useTranslation("common");
  return (
    <div className="msg" data-from="patient" data-highlight={highlighted} id={id}>
      <div className="bubble" data-kind="patient" data-state={state}>
        <span className="sr-only">{author ?? t("chat.you")}</span>
        {children}
      </div>
      <p className="msg-meta">
        {state === "sent" && time && <time dateTime={dateTime}>{time}</time>}
        {state === "sending" && t("chat.sending")}
        {state === "queued" && (
          <>
            <IconCloudOff size={16} aria-hidden /> {t("chat.queued")}
          </>
        )}
        {state === "failed" && (
          <>
            {t("chat.failed")}
            <button type="button" className="link" onClick={onRetry}>
              {t("action.resend")}
            </button>
          </>
        )}
      </p>
    </div>
  );
}

/** The AI. Set on the page itself with a label, not in a coloured balloon: it reads like a page of the form. */
export function AssistantBubble({ children, time, dateTime, id, highlighted, streaming, interrupted, onRetry }: BubbleProps & { streaming?: boolean; interrupted?: boolean; onRetry?: () => void }) {
  const { t } = useTranslation("common");
  return (
    <div className="msg" data-from="assistant" data-highlight={highlighted} id={id}>
      <p className="msg-author">
        <span className="msg-mark" aria-hidden="true">
          <IconNotebook size={16} />
        </span>
        {t("chat.assistant")}
        {time && (
          <time dateTime={dateTime} className="font-normal text-fg-3">
            {time}
          </time>
        )}
      </p>
      <div className="bubble" data-kind="assistant" aria-busy={streaming || undefined}>
        {children}
        {streaming && <span className="caret" aria-hidden="true" />}
      </div>
      {interrupted && (
        <div className="msg-interrupted">
          <span>{t("chat.interrupted")}</span>
          {onRetry && (
            <Button size="sm" icon={<IconRefresh aria-hidden />} onClick={onRetry}>
              {t("action.retry")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Waiting for the first word. Says what is happening, not three bouncing dots. */
export function AssistantThinking({ label }: { label?: string }) {
  const { t } = useTranslation("common");
  return (
    <div className="msg" data-from="assistant" role="status">
      <p className="msg-author">
        <span className="msg-mark" aria-hidden="true">
          <IconLoader2 size={16} className="animate-spin" />
        </span>
        <span className="font-normal text-fg-2">{label ?? t("chat.thinking")}</span>
      </p>
    </div>
  );
}

/** A person from the clinic. Always signed with name and title, so it can never be taken for the AI. */
export function StaffBubble({ children, time, dateTime, id, highlighted, name, title }: BubbleProps & { name: string; title?: string | null }) {
  return (
    <div className="msg" data-from="staff" data-highlight={highlighted} id={id}>
      <p className="msg-author">
        <Avatar name={name} size={28} />
        {name}
        {title && <span className="font-normal text-fg-2">{title}</span>}
        {time && (
          <time dateTime={dateTime} className="font-normal text-fg-3">
            {time}
          </time>
        )}
      </p>
      <div className="bubble" data-kind="staff">
        {children}
      </div>
    </div>
  );
}

/** Opening disclosure: who this is, what it will not do. Fixed text from the server. */
export function OpeningNote({ children }: { children: ReactNode }) {
  const { t } = useTranslation("common");
  return (
    <section className="chat-note" data-kind="opening" aria-label={t("chat.openingLabel")}>
      <IconInfoCircle aria-hidden />
      <div>{children}</div>
    </section>
  );
}

/** Something happened in the conversation: taken over, handed back, closed. */
export function NoticeLine({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <p className="chat-notice" role="note">
      {icon ?? <IconStethoscope size={18} aria-hidden />}
      <span>{children}</span>
    </p>
  );
}

/** The AI was asked for something only a clinician may do. Says so and offers the next step. */
export function RefusalNote({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const { t } = useTranslation("common");
  return (
    <section className="chat-note" data-kind="refusal" aria-label={t("chat.refusalLabel")}>
      <IconShieldCheck aria-hidden />
      <div>
        {children}
        {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
      </div>
    </section>
  );
}

/** Red flag card: fixed text from the rules, then the emergency numbers. Stays in the transcript. */
export function RedFlagNote({ children, kind = "medical" }: { children: ReactNode; kind?: "medical" | "crisis" }) {
  return <EmergencyPanel kind={kind}>{children}</EmergencyPanel>;
}

export function DayDivider({ children }: { children: ReactNode }) {
  return (
    <p className="chat-day" role="separator">
      <span>{children}</span>
    </p>
  );
}

/* ----- Transcript: follows the newest message unless the reader scrolled up ----- */

export function Transcript({ children, follow, label, className }: { children: ReactNode; /** Change this value (last seq, text length) whenever content grows. */ follow: unknown; label: string; className?: string }) {
  const { t } = useTranslation("common");
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const col = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (pinned && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [follow, pinned]);
  // Fonts, cards and streamed text change the height after render.
  useEffect(() => {
    if (!pinned || !col.current) return;
    const ro = new ResizeObserver(() => {
      if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    });
    ro.observe(col.current);
    return () => ro.disconnect();
  }, [pinned]);
  return (
    <div className={cn("transcript", className)}>
      <div
        ref={ref}
        className="transcript-scroll"
        role="log"
        aria-label={label}
        aria-live="polite"
        aria-relevant="additions"
        tabIndex={0}
        data-focus-silent
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 64);
        }}
      >
        <div ref={col} className="transcript-col">{children}</div>
      </div>
      {!pinned && (
        <Button size="sm" className="transcript-jump" icon={<IconArrowDown aria-hidden />} onClick={() => setPinned(true)}>
          {t("chat.jump")}
        </Button>
      )}
    </div>
  );
}

/* ----- Composer ----- */

export interface ComposerProps {
  value: string;
  onValueChange: (v: string) => void;
  onSend: () => void;
  /** Stop a running turn. Shown instead of Send. */
  onStop?: () => void;
  running?: boolean;
  disabled?: boolean;
  disabledReason?: ReactNode;
  max?: number;
  placeholder?: string;
  label: string;
  /** Draft state from the data layer. */
  draft?: "saved" | "saving" | "offline" | null;
  /** Messages waiting for the network. */
  queued?: number;
  offline?: boolean;
  /** Under the box: suggested replies, attach. */
  accessory?: ReactNode;
  autoFocus?: boolean;
  className?: string;
}

const codePoints = (s: string) => [...s].length;

/** Enter sends, Shift+Enter breaks the line, and Enter that confirms a Chinese candidate does neither. */
export function Composer({ value, onValueChange, onSend, onStop, running, disabled, disabledReason, max = 2000, placeholder, label, draft, queued = 0, offline, accessory, autoFocus, className }: ComposerProps) {
  const { t } = useTranslation("common");
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const count = codePoints(value);
  const over = count > max;
  const near = count >= max * 0.9;
  const canSend = !disabled && !over && value.trim() !== "";

  // field-sizing covers Chromium and Safari; this covers the rest.
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el || CSS.supports("field-sizing", "content")) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, []);
  useLayoutEffect(fit, [value, fit]);
  useEffect(() => {
    if (autoFocus && matchMedia("(pointer: fine)").matches) ref.current?.focus();
  }, [autoFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    // On phones Enter is a new line; the send button is right there.
    if (matchMedia("(pointer: coarse)").matches) return;
    e.preventDefault();
    if (canSend && !running) onSend();
  };

  return (
    <form
      className={cn("composer", className)}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend && !running) onSend();
      }}
    >
      {disabled && disabledReason ? (
        <p className="composer-closed">{disabledReason}</p>
      ) : (
        <div className="composer-box" data-over={over}>
          <textarea
            ref={ref}
            rows={1}
            aria-label={label}
            aria-invalid={over || undefined}
            placeholder={placeholder}
            value={value}
            disabled={disabled}
            enterKeyHint="enter"
            onChange={(e) => onValueChange(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              // Safari fires keydown after compositionend for the same key press.
              setTimeout(() => {
                composing.current = false;
              }, 0);
            }}
            onKeyDown={onKeyDown}
          />
          {running && onStop ? (
            <button type="button" className="composer-send" aria-label={t("chat.stop")} onClick={onStop}>
              <IconPlayerStopFilled size={20} aria-hidden />
            </button>
          ) : (
            <button type="submit" className="composer-send" aria-label={offline ? t("chat.sendLater") : t("chat.send")} disabled={!canSend || running}>
              <IconArrowUp size={22} stroke={2.25} aria-hidden />
            </button>
          )}
        </div>
      )}
      <div className="composer-foot">
        {accessory}
        <span className="ms-auto flex items-center gap-3" role="status">
          {queued > 0 && (
            <span className="save-state" data-state="offline">
              <IconCloudOff aria-hidden />
              {t("chat.queuedCount", { count: queued })}
            </span>
          )}
          {queued === 0 && offline && (
            <span className="save-state" data-state="offline">
              <IconCloudOff aria-hidden />
              {t("chat.offline")}
            </span>
          )}
          {!offline && draft && value.trim() !== "" && <span className="text-sm text-fg-3">{t(`chat.draft.${draft}`)}</span>}
          {near && <span className={cn("num text-sm", over ? "font-semibold text-warn" : "text-fg-2")}>{t("chat.count", { count, max })}</span>}
        </span>
      </div>
    </form>
  );
}

/** Short answers the patient can tap. At most four, full width on phones. */
export function QuickReplies({ options, onPick, label }: { options: string[]; onPick: (text: string) => void; label: string }) {
  return (
    <div className="quick-replies" role="group" aria-label={label}>
      {options.map((o) => (
        <Button key={o} size="sm" variant="secondary" onClick={() => onPick(o)}>
          {o}
        </Button>
      ))}
    </div>
  );
}
