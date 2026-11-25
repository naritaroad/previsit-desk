import { useTranslation } from "react-i18next";
import { useParams } from "react-router";

import type { Message } from "@/api/types";
import { useDraft, useMeta, useOutbox, useRx, useVisitStream } from "@/data";
import { taipeiDate } from "@/lib/format";
import { useFullHeight } from "@/shells/PatientShell";
import { ButtonLink, Composer, DayDivider, EmptyState, NoticeLine, PageBody, PageHeader, PatientBubble, SkeletonRows, StaffBubble, StatusTag, TextLink, Transcript, useOnline } from "@/ui";

import { Messages } from "./RxDetail";
import { Gate, LoadError, useFmt } from "./shared";
import { parseThread } from "./threads";
import { DoctorNote } from "./visit/DoctorNote";

export default function MessageThread() {
  const { t } = useTranslation("patient");
  const { id } = useParams();
  const thread = parseThread(id);
  if (!thread)
    return (
      <PageBody>
        <EmptyState title={<h1 tabIndex={-1}>{t("common.notFoundTitle")}</h1>} action={<ButtonLink to="/app/messages">{t("msgs.title")}</ButtonLink>}>
          {t("msgs.badLink")}
        </EmptyState>
      </PageBody>
    );
  return thread.kind === "rx" ? <RxThread key={thread.id} id={thread.id} /> : <VisitThread key={thread.id} id={thread.id} />;
}

function RxThread({ id }: { id: string }) {
  const { t } = useTranslation(["patient", "rx"]);
  const f = useFmt();
  const query = useRx(id);
  return (
    <PageBody width="read">
      <Gate query={query} rows={5}>
        {(rx) => (
          <>
            <PageHeader
              title={`${t(`rx:kind.${rx.kind}`)}${t("patient:common.colon")}${f.list(rx.items.map((i) => f.drug(i.drug)))}`}
              back={{ to: "/app/messages", label: t("patient:msgs.title") }}
              meta={
                <>
                  <StatusTag family="rx" status={rx.status} />
                  <TextLink to={`/app/rx/${rx.id}`}>{t("patient:msgs.seeRequest")}</TextLink>
                </>
              }
            />
            <Messages rx={rx} heading={false} />
          </>
        )}
      </Gate>
    </PageBody>
  );
}

/** The part of a previsit that is between the patient and people: from the first staff message or hand-over on. */
function peoplePart(messages: readonly Message[]): Message[] {
  const start = messages.findIndex((m) => m.role === "staff" || m.kind === "handoff");
  return start < 0 ? [] : messages.slice(start).filter((m) => m.role === "staff" || m.role === "patient" || m.kind === "handoff" || m.kind === "notice");
}

function VisitThread({ id }: { id: string }) {
  useFullHeight();
  const { t } = useTranslation("patient");
  const f = useFmt();
  const state = useVisitStream(id);
  const outbox = useOutbox(id);
  const draft = useDraft<string>(`visit:${id}:composer`, "");
  const meta = useMeta();
  const online = useOnline();
  const visit = state.visit;
  if (state.phase === "error" && !state.loaded)
    return (
      <PageBody>
        <LoadError error={state.error} onRetry={state.reconnect} />
      </PageBody>
    );
  if (!visit)
    return (
      <PageBody>
        <SkeletonRows rows={5} />
      </PageBody>
    );
  const list = peoplePart(state.messages);
  const pending = outbox.items.filter((i) => !state.messages.some((m) => m.client_id === i.client_id));
  const human = visit.mode === "human";
  let day = "";
  const send = () => {
    const text = draft.value.trim();
    if (text) void outbox.send(text).then(() => draft.clear());
  };
  return (
    <>
      <header className="chat-head">
        <div className="min-w-0 flex-1">
          <h1 tabIndex={-1}>{visit.title}</h1>
          <p>{human ? t("visits.human", { name: f.person(visit.assigned_to) || t("common.careTeam") }) : t("msgs.aiMode")}</p>
        </div>
        <ButtonLink size="sm" to={`/app/visits/${id}`}>
          {t("msgs.fullVisit")}
        </ButtonLink>
      </header>
      <Transcript label={visit.title} follow={`${list.length}:${pending.length}`}>
        {list.length === 0 && !state.note && <p className="text-fg-2">{t("msgs.threadEmpty")}</p>}
        {list.map((m) => {
          const d = taipeiDate(m.created_at);
          const divider = d !== day;
          day = d;
          const common = { time: f.time(m.created_at), dateTime: m.created_at };
          return (
            <div key={m.id} className="grid min-w-0 gap-6">
              {divider && <DayDivider>{f.date(m.created_at, "full")}</DayDivider>}
              {m.role === "staff" ? (
                <StaffBubble {...common} name={m.author?.display_name ?? t("common.careTeam")} title={m.author?.title}>
                  {m.content}
                </StaffBubble>
              ) : m.role === "patient" ? (
                <PatientBubble {...common}>{m.content}</PatientBubble>
              ) : (
                <NoticeLine>{m.content}</NoticeLine>
              )}
            </div>
          );
        })}
        {pending.map((i) => (
          <PatientBubble key={i.client_id} state={i.status === "failed" ? "failed" : i.status === "queued" && (!online || i.attempts > 0) ? "queued" : "sending"} onRetry={() => outbox.retry(i.client_id)}>
            {i.content}
          </PatientBubble>
        ))}
        <DoctorNote note={state.note} visit={visit} />
      </Transcript>
      <Composer
        value={draft.value}
        onValueChange={(v) => draft.set(v)}
        onSend={send}
        disabled={!human || !draft.ready}
        disabledReason={human ? undefined : t(visit.status === "reviewed" || visit.submitted_at ? "msgs.closedDone" : "msgs.closedAi")}
        max={meta.data?.max_message_chars ?? 500}
        label={t("visit.composerHuman")}
        placeholder={t("visit.composerHuman")}
        draft={draft.status === "saved" || draft.status === "saving" || draft.status === "offline" ? draft.status : null}
        queued={pending.filter((i) => i.status === "queued").length}
        offline={!online}
        autoFocus
      />
    </>
  );
}
