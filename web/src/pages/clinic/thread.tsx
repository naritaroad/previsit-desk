// The conversation as staff read it: patient, assistant and people are never confused, and any message can be the
// target of an evidence link. The composer works while a person has taken over.

import { IconArrowBackUp, IconHeadset, IconInfoCircle, IconMessage2, IconPhoneCall, IconRobotOff, IconShieldCheck } from "@tabler/icons-react";
import { Fragment, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Message, Visit } from "@/api/types";
import { useDraft, useMe, useOutbox, useTakeover } from "@/data";
import { taipeiDate } from "@/lib/format";
import { AssistantBubble, Banner, Button, Composer, ConfirmDialog, DayDivider, Menu, MenuItem, MenuLabel, NoticeLine, PatientBubble, StaffBubble, toast, useOnline } from "@/ui";

import { personLabel, samePerson, useErrorText, useFmt } from "./lib";
import { useCannedReplies } from "./canned";

export const messageDomId = (id: string) => `m-${id}`;

/** Marks every occurrence of a search text. */
function Marked({ text, q }: { text: string; q: string }) {
  if (!q) return text;
  const parts: ReactNode[] = [];
  const low = text.toLowerCase();
  const needle = q.toLowerCase();
  let at = 0;
  for (let i = low.indexOf(needle); i !== -1; i = low.indexOf(needle, i + needle.length)) {
    parts.push(text.slice(at, i), <mark key={i}>{text.slice(i, i + needle.length)}</mark>);
    at = i + needle.length;
  }
  return [...parts, text.slice(at)].map((p, i) => <Fragment key={i}>{p}</Fragment>);
}

export interface MessageListProps {
  messages: Message[];
  patientName: string;
  highlight?: string | null;
  q?: string;
  live?: string | null;
  /** The message is the target of an evidence link and takes focus. */
  focusable?: boolean;
}

export function MessageList({ messages, patientName, highlight, q = "", live, focusable }: MessageListProps) {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  let day = "";
  return (
    <>
      {messages.map((m) => {
        const d = taipeiDate(m.created_at);
        const divider = d !== day ? <DayDivider key={`d-${d}`}>{fmt.date(d, "medium")}</DayDivider> : null;
        day = d;
        const base = { time: fmt.time(m.created_at), dateTime: m.created_at, highlighted: highlight === m.id };
        const text = <Marked text={m.content} q={q} />;
        const body =
          m.kind === "red_flag" ? (
            <section className="chat-note" data-kind="redflag">
              <IconPhoneCall aria-hidden />
              <div>
                <p className="font-semibold">{t("thread.redFlag")}</p>
                {text}
              </div>
            </section>
          ) : m.kind === "refusal" ? (
            <section className="chat-note" data-kind="refusal">
              <IconShieldCheck aria-hidden />
              <div>
                <p className="font-semibold">{t("thread.refusal")}</p>
                {text}
              </div>
            </section>
          ) : m.kind === "opening" ? (
            <section className="chat-note" data-kind="opening">
              <IconInfoCircle aria-hidden />
              <div>{text}</div>
            </section>
          ) : m.kind === "notice" || m.kind === "handoff" ? (
            <NoticeLine>{text}</NoticeLine>
          ) : m.role === "patient" ? (
            <PatientBubble {...base} author={t("thread.says", { name: patientName })}>
              {text}
            </PatientBubble>
          ) : m.role === "staff" ? (
            <StaffBubble {...base} name={m.author?.display_name ?? t("thread.staff")} title={m.author?.title}>
              {text}
            </StaffBubble>
          ) : (
            <AssistantBubble {...base} interrupted={m.status === "interrupted"}>
              {text}
            </AssistantBubble>
          );
        return (
          <Fragment key={m.id}>
            {divider}
            <div id={messageDomId(m.id)} className="thread-item" data-target={highlight === m.id} tabIndex={focusable ? -1 : undefined}>
              {body}
            </div>
          </Fragment>
        );
      })}
      {live && <AssistantBubble streaming>{live}</AssistantBubble>}
    </>
  );
}

/** Who answers the patient right now, and how to change that. */
export function ModeBar({ visit, canReply }: { visit: Visit; canReply: boolean }) {
  const { t } = useTranslation("clinic");
  const me = useMe();
  const errorText = useErrorText();
  const { takeover, release } = useTakeover(visit.id);
  const [ask, setAsk] = useState<"takeover" | "release" | null>(null);
  const human = visit.mode === "human";
  const other = human && visit.assigned_to && !samePerson(visit.assigned_to, me) ? visit.assigned_to : null;
  const run = (m: typeof takeover, done: string) =>
    m.mutate(undefined, {
      onSuccess: () => {
        setAsk(null);
        toast.ok(done);
      },
      onError: (e) => toast.warn(errorText(e)),
    });
  return (
    <>
      <Banner
        tone={human ? (other ? "warn" : "ok") : "mute"}
        bleed
        icon={human ? <IconHeadset aria-hidden /> : <IconMessage2 aria-hidden />}
        actions={
          canReply ? (
            human ? (
              <Button size="sm" icon={<IconArrowBackUp aria-hidden />} onClick={() => setAsk("release")}>
                {t("thread.release")}
              </Button>
            ) : (
              <Button size="sm" variant="soft" icon={<IconHeadset aria-hidden />} onClick={() => setAsk("takeover")}>
                {t("thread.takeover")}
              </Button>
            )
          ) : undefined
        }
      >
        {human ? (other ? t("thread.modeOther", { name: personLabel(other) }) : t("thread.modeMe")) : t("thread.modeAi")}
      </Banner>
      <ConfirmDialog
        open={ask !== null}
        onOpenChange={(o) => !o && setAsk(null)}
        title={t(ask === "release" ? "thread.releaseTitle" : "thread.takeoverTitle", { name: visit.patient.display_name })}
        description={t(ask === "release" ? "thread.releaseBody" : "thread.takeoverBody")}
        confirmLabel={t(ask === "release" ? "thread.release" : "thread.takeover")}
        busy={takeover.isPending || release.isPending}
        onConfirm={() => (ask === "release" ? run(release, t("thread.released")) : run(takeover, t("thread.taken")))}
      />
    </>
  );
}

/** Reply to the patient as a named person. Drafts survive a reload; sending works through the offline queue. */
export function StaffComposer({ visit, canReply }: { visit: Visit; canReply: boolean }) {
  const { t } = useTranslation("clinic");
  const online = useOnline();
  const draft = useDraft<string>(`visit:${visit.id}:staff`, "");
  const outbox = useOutbox(visit.id, "staff");
  const [canned] = useCannedReplies();
  const human = visit.mode === "human";
  const queued = outbox.items.filter((i) => i.status === "queued").length;
  const send = () => {
    const text = draft.value.trim();
    if (!text) return;
    void outbox.send(text).then(() => draft.clear());
  };
  return (
    <div className="staff-composer no-print">
      {outbox.items
        .filter((i) => i.status !== "sent")
        .map((i) => (
          <div key={i.client_id} className="px-4 pt-2">
            <PatientBubble state={i.status === "failed" ? "failed" : i.status === "sending" ? "sending" : "queued"} onRetry={() => outbox.retry(i.client_id)} author={t("thread.youSay")}>
              {i.content}
            </PatientBubble>
          </div>
        ))}
      <Composer
        value={draft.value}
        onValueChange={(v) => draft.set(v)}
        onSend={send}
        label={t("thread.composer", { name: visit.patient.display_name })}
        placeholder={t("thread.placeholder")}
        disabled={!human || !canReply}
        disabledReason={
          <span className="inline-flex items-center gap-2">
            <IconRobotOff size={18} aria-hidden />
            {canReply ? t("thread.needTakeover") : t("thread.noReply")}
          </span>
        }
        draft={draft.status === "saving" ? "saving" : draft.status === "offline" ? "offline" : draft.value ? "saved" : null}
        queued={queued}
        offline={!online}
        accessory={
          human && canReply ? (
            <Menu
              align="start"
              side="top"
              trigger={
                <Button size="sm" variant="quiet">
                  {t("thread.canned")}
                </Button>
              }
            >
              <MenuLabel>{t("thread.cannedHint")}</MenuLabel>
              {canned.map((c) => (
                <MenuItem key={c.title} onSelect={() => draft.set((v) => (v.trim() ? `${v.trimEnd()}\n${c.body}` : c.body))}>
                  {c.title}
                </MenuItem>
              ))}
            </Menu>
          ) : undefined
        }
      />
    </div>
  );
}
