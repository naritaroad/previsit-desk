import { IconBuildingStore, IconCheck, IconFileCheck, IconPackage, IconPrinter, IconSend, IconStethoscope } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useParams, useSearchParams } from "react-router";

import type { RxEvent, RxRequest, RxStatus } from "@/api/types";
import { useCancelRx, useDraft, useReplyRx, useRx, useRxMessage } from "@/data";
import { formatSpan } from "@/lib/format";
import { allows, isOpenRx, patientTimeline, rxProgress } from "@/lib/rx";
import {
  Banner,
  Button,
  ButtonLink,
  Callout,
  ConfirmDialog,
  DescriptionList,
  EmergencyPanel,
  Field,
  PageBody,
  PageHeader,
  SaveState,
  Section,
  StatusTag,
  Textarea,
  TextLink,
  Timeline,
  toast,
  type TimelineItem,
} from "@/ui";

import { isUrgentRx, shortNo } from "./rx/rules";
import { ActionError, Gate, uiSave, useFmt, useNow } from "./shared";
import { RefillNote } from "./visit/TurnRecord";

export default function RxDetail() {
  const { id = "" } = useParams();
  const query = useRx(id);
  return (
    <PageBody>
      <Gate query={query} rows={8}>
        {(rx) => (rx.status === "draft" ? <Navigate to={`/app/rx/${id}/edit`} replace /> : <Detail key={id} rx={rx} />)}
      </Gate>
    </PageBody>
  );
}

function Detail({ rx }: { rx: RxRequest }) {
  const { t } = useTranslation(["patient", "rx"]);
  const f = useFmt();
  const [params] = useSearchParams();
  const events = patientTimeline(rx.timeline);
  const urgent = isUrgentRx(rx);
  return (
    <>
      <PageHeader
        title={`${t(`rx:kind.${rx.kind}`)}${t("patient:common.colon")}${f.list(rx.items.map((i) => f.drug(i.drug)))}`}
        back={{ to: "/app/rx", label: t("patient:rx.title") }}
        meta={
          <>
            <StatusTag family="rx" status={rx.status} />
            <span className="num">{rx.no}</span>
            {rx.submitted_at && <span className="num">{t("patient:rxd.submitted", { date: f.dateTime(rx.submitted_at) })}</span>}
          </>
        }
      />
      {params.get("sent") && isOpenRx(rx.status) && !urgent && (
        <Banner tone="ok" className="mb-stack" title={t("patient:rxd.sentTitle")}>
          {t(rx.kind === "renewal" ? "patient:rxd.sentBody" : "patient:rxd.sentBodyRefill")}
        </Banner>
      )}
      {urgent && (
        <EmergencyPanel className="mb-8" title={t("patient:wizard.urgentTitle")}>
          <p>{rx.engine?.disposition === "urgent" ? rx.engine.summary : t("patient:rxd.urgentBody")}</p>
        </EmergencyPanel>
      )}
      <Track rx={rx} events={events} />
      <NextAct rx={rx} />
      {rx.status === "more_info" && <Reply rx={rx} />}
      <Outcome rx={rx} />
      {(rx.status === "at_pharmacy" || rx.status === "ready" || rx.status === "approved" || rx.status === "partially_approved") && rx.pharmacy && <Slip rx={rx} />}
      <div className="mt-8 grid gap-x-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="min-w-0">
          <Section title={t("patient:rxd.history")}>
            <History rx={rx} events={events} />
          </Section>
          <Messages rx={rx} />
        </div>
        <div className="min-w-0">
          <Section title={t("patient:rxd.details")}>
            <DescriptionList
              items={[
                ...rx.items.map((i) => ({ label: f.drug(i.drug), value: i.dose_text || t("patient:meds.noDose") })),
                { label: t("patient:wizard.pharmacy"), value: rx.pharmacy?.name ?? null },
                ...(rx.pickup_window ? [{ label: t("patient:wizard.pickupDate"), value: `${f.date(rx.pickup_window.date, "medium")} ${t(`rx:pickupSlot.${rx.pickup_window.slot}`)}` }] : []),
                ...(rx.assigned_to ? [{ label: t("patient:rxd.handler"), value: f.person(rx.assigned_to) }] : []),
              ]}
            />
          </Section>
          {rx.kind === "renewal" && rx.engine && rx.engine.disposition !== "urgent" && (
            <Section title={t("patient:wizard.checkTitle")}>
              <p className="text-fg-2">{t("patient:wizard.checkBody")}</p>
              <ul className="mt-2 grid gap-2">
                {rx.items
                  .flatMap((i) => i.engine?.fired ?? [])
                  .filter((x, i, all) => all.findIndex((y) => y.question_id === x.question_id && y.reason === x.reason) === i)
                  .map((x) => (
                    <li key={`${x.question_id}-${x.reason}`}>{x.reason}</li>
                  ))}
              </ul>
            </Section>
          )}
          {allows(rx, "cancel") && <Cancel rx={rx} />}
        </div>
      </div>
    </>
  );
}

const STEP_ICON: Partial<Record<RxStatus, typeof IconSend>> = { submitted: IconSend, in_review: IconStethoscope, approved: IconFileCheck, at_pharmacy: IconBuildingStore, ready: IconPackage, dispensed: IconCheck };
/** Which event marks a step as reached, newest names first. */
const STEP_EVENTS: Partial<Record<RxStatus, readonly string[]>> = {
  submitted: ["submitted"],
  in_review: ["review_started", "assigned"],
  approved: ["approved", "partially_approved", "decided"],
  at_pharmacy: ["accepted", "accept", "sent_to_pharmacy"],
  ready: ["ready"],
  dispensed: ["dispensed"],
};

/** The way of a parcel: where it is now, what is behind it, what is still to come. */
function Track({ rx, events }: { rx: RxRequest; events: RxEvent[] }) {
  const { t } = useTranslation(["patient", "rx", "common"]);
  const f = useFmt();
  const { steps, index, left } = rxProgress(rx.kind, rx.status);
  if (left) return null; // cancelled, declined or sent to a visit: the box below says what happened
  const at = (s: RxStatus) => events.findLast((e) => STEP_EVENTS[s]?.includes(e.type))?.at;
  const finished = rx.status === "dispensed";
  return (
    <ol className="track" aria-label={t("patient:rxd.track")}>
      {steps.map((s, i) => {
        const state = i < index || (finished && i === index) ? "done" : i === index ? "current" : "todo";
        const Icon = state === "done" ? IconCheck : (STEP_ICON[s] ?? IconCheck);
        const when = state === "todo" ? undefined : at(s);
        return (
          <li key={s} data-state={state} aria-current={state === "current" ? "step" : undefined}>
            <Icon aria-hidden />
            <span>
              {t(`patient:rxd.step_${s}`)}
              <span className="sr-only">{t(`common:step.${state}`)}</span>
            </span>
            {when ? <time dateTime={when}>{f.dateTime(when)}</time> : <span aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

const WHO: Record<RxStatus, "you" | "doctor" | "pharmacy" | "none"> = {
  draft: "you",
  submitted: "doctor",
  in_review: "doctor",
  more_info: "you",
  approved: "pharmacy",
  partially_approved: "pharmacy",
  declined: "you",
  visit_required: "you",
  at_pharmacy: "pharmacy",
  returned: "doctor",
  ready: "you",
  dispensed: "none",
  cancelled: "none",
};

/** Whose turn it is, until when, and the one thing the patient can do. */
function NextAct({ rx }: { rx: RxRequest }) {
  const { t } = useTranslation(["patient", "rx"]);
  const f = useFmt();
  const now = useNow();
  const who = rx.kind === "refill" && (rx.status === "submitted" || rx.status === "returned") ? "pharmacy" : WHO[rx.status];
  const waiting = who === "doctor" || who === "pharmacy";
  const visit = rx.status === "visit_required" || rx.status === "declined" || rx.items.some((i) => i.decision?.outcome === "visit_required");
  return (
    <section className="next-act mt-5" aria-label={t("patient:rxd.nextTitle")}>
      <p className="text-fg-2">{t(`patient:rxd.who_${who}`)}</p>
      <p className="big">{t(`rx:statusHint.${rx.status}`)}</p>
      {waiting && rx.sla_due_at && (
        <p className="num">
          {rx.overdue || new Date(rx.sla_due_at) < now
            ? t("patient:rxd.overdue", { date: f.dateTime(rx.sla_due_at) })
            : t("patient:rxd.expected", { date: f.dateTime(rx.sla_due_at), span: formatSpan(rx.sla_due_at, f.locale, now) })}
        </p>
      )}
      {waiting && rx.overdue && <p className="text-fg-2">{t("patient:rxd.overdueBody")}</p>}
      {rx.status === "ready" && <p>{t("patient:rxd.bring")}</p>}
      {waiting && rx.kind === "renewal" && <p className="text-sm text-fg-2">{t("patient:rxd.notPrescription")}</p>}
      {visit && (
        <div className="mt-2 flex flex-wrap gap-3">
          <ButtonLink variant="primary" to="/app/appointments/book">
            {t("patient:advice.bookVisit")}
          </ButtonLink>
          <ButtonLink to={`/app/messages/rx-${rx.id}`}>{t("patient:rxd.ask")}</ButtonLink>
        </div>
      )}
      {rx.status === "returned" && (
        <p>
          <TextLink to={`/app/messages/rx-${rx.id}`}>{t("patient:rxd.ask")}</TextLink>
        </p>
      )}
      {rx.status === "cancelled" && (
        <p>
          <TextLink to="/app/medications">{t("patient:rxd.backToMeds")}</TextLink>
        </p>
      )}
    </section>
  );
}

/** What was decided, item by item, and the doctor's words. */
function Outcome({ rx }: { rx: RxRequest }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const decided = rx.items.filter((i) => i.decision && i.decision.outcome !== "more_info");
  const refill = rx.items.map((i) => i.refill).find((r) => r && r.outcome !== "eligible");
  if (decided.length === 0 && !(rx.decision_note && rx.status !== "more_info") && !refill) return null;
  const by = decided[0]?.decision?.by;
  return (
    <Section title={t("rxd.decision")}>
      {rx.decision_note && rx.status !== "more_info" && (
        <div className="doctor-note mb-4">
          <header>
            <b>{t("rxd.doctorSays")}</b>
            <span className="text-sm">{f.person(by)}</span>
          </header>
          <div>{rx.decision_note}</div>
        </div>
      )}
      {decided.length > 0 && (
        <ul className="row-list">
          {decided.map((i) => (
            <li key={i.id} className="row-item">
              <div className="row-link">
                <span className="row-main">
                  <span className="row-title">{f.drug(i.drug)}</span>
                  {i.decision?.note && <span className="row-sub">{i.decision.note}</span>}
                  <span className="row-sub num">
                    {f.person(i.decision?.by)} {f.dateTime(i.decision?.at)}
                  </span>
                </span>
                <span className="row-end">
                  <StatusTag family="outcome" status={i.decision!.outcome} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {decided.some((i) => i.decision?.outcome === "approve") && <p className="mt-3 text-fg-2">{t("rxd.approveNote")}</p>}
      {refill && <RefillNote result={refill} />}
    </Section>
  );
}

/** What to show at the counter. A number to read out, no picture code to scan. */
function Slip({ rx }: { rx: RxRequest }) {
  const { t } = useTranslation(["patient", "rx"]);
  const f = useFmt();
  const p = rx.pharmacy!;
  return (
    <Section
      title={t("patient:slip.title")}
      actions={
        <Button size="sm" className="no-print" icon={<IconPrinter aria-hidden />} onClick={() => print()}>
          {t("patient:slip.print")}
        </Button>
      }
    >
      <div className="slip">
        <div className="min-w-0 p-5">
          <DescriptionList
            items={[
              { label: t("patient:slip.patient"), value: rx.patient.display_name },
              { label: t("patient:slip.drugs"), value: f.list(rx.items.filter((i) => !i.decision || i.decision.outcome === "approve").map((i) => f.drug(i.drug))) },
              {
                label: t("patient:wizard.pharmacy"),
                value: (
                  <>
                    <span className="block font-semibold">{p.name}</span>
                    <span className="block">
                      {p.district} {p.address}
                    </span>
                    <span className="block text-fg-2">{t("patient:pharm.hours", { hours: p.hours })}</span>
                  </>
                ),
              },
              ...(rx.pickup_window ? [{ label: t("patient:wizard.pickupDate"), value: `${f.date(rx.pickup_window.date, "full")} ${t(`rx:pickupSlot.${rx.pickup_window.slot}`)}` }] : []),
              { label: t("patient:slip.bring"), value: t("patient:slip.bringValue") },
            ]}
          />
        </div>
        <div className="slip-no">
          <span>{t("patient:slip.number")}</span>
          <b>{shortNo(rx.no)}</b>
          <span className="num text-sm text-fg-2">{rx.no}</span>
          <StatusTag family="rx" status={rx.status} />
        </div>
      </div>
      <p className="mt-2 text-sm text-fg-2">{t(rx.status === "ready" ? "patient:slip.readyNote" : "patient:slip.waitNote")}</p>
    </Section>
  );
}

function History({ rx, events }: { rx: RxRequest; events: RxEvent[] }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const { steps, index, left } = rxProgress(rx.kind, rx.status);
  const items: TimelineItem[] = [...events].reverse().map((e, i) => ({
    id: `${e.at}-${e.type}-${i}`,
    time: f.dateTime(e.at),
    dateTime: e.at,
    what: e.text,
    who: e.actor ? f.person(e.actor) : undefined,
    tone: e.type === "urgent" ? "danger" : undefined,
  }));
  if (!left && rx.status !== "dispensed" && index + 1 < steps.length) items.unshift({ id: "next", time: t("rxd.notYet"), what: t(`rxd.step_${steps[index + 1]}`), pending: true });
  return <Timeline label={t("rxd.history")} items={items} />;
}

/** The doctor asked for something. The answer is a draft until it is sent, on every device. */
function Reply({ rx }: { rx: RxRequest }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const draft = useDraft<string>(`rx:${rx.id}:reply`, "");
  const reply = useReplyRx(rx.id);
  const [tried, setTried] = useState(false);
  const asked = rx.items.filter((i) => i.decision?.outcome === "more_info" && i.decision.note);
  const save = uiSave(draft.status, draft.error);
  const send = () => {
    const body = draft.value.trim();
    if (!body) {
      setTried(true);
      return;
    }
    reply.mutate(
      { revision: rx.revision, body, answers: rx.answers },
      {
        onSuccess: () => {
          toast.ok(t("rxd.replied"));
          void draft.clear();
        },
      },
    );
  };
  return (
    <Section title={t("rxd.doctorAsks")}>
      {rx.decision_note && <p className="mb-3 text-md whitespace-pre-wrap">{rx.decision_note}</p>}
      {asked.length > 0 && (
        <ul className="mb-3 grid gap-1">
          {asked.map((i) => (
            <li key={i.id}>
              <b>{f.drug(i.drug)}</b>
              {t("common.colon")}
              {i.decision!.note}
            </li>
          ))}
        </ul>
      )}
      <Field label={t("rxd.replyLabel")} hint={t("rxd.replyHint")} error={tried && !draft.value.trim() ? t("rxd.replyNeeded") : undefined}>
        <Textarea rows={4} maxLength={2000} value={draft.value} onChange={(e) => draft.set(e.target.value)} disabled={!draft.ready} />
      </Field>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button variant="primary" loading={reply.isPending} onClick={send}>
          {t("wizard.sendReply")}
        </Button>
        <ButtonLink to={`/app/rx/${rx.id}/edit`}>{t("rxd.editAnswers")}</ButtonLink>
        {save && draft.value.trim() !== "" && <SaveState state={save} savedAt={draft.savedAt ? f.time(draft.savedAt) : undefined} />}
      </div>
      <ActionError error={reply.error} className="mt-3" title={t("wizard.sendFailed")} onRetry={send} />
      {draft.conflict && (
        <Callout
          tone="warn"
          className="mt-3"
          title={t("rxd.otherDraft")}
          actions={
            <>
              <Button size="sm" onClick={() => draft.resolve("mine")}>
                {t("rxd.keepMine")}
              </Button>
              <Button size="sm" onClick={() => draft.resolve("theirs")}>
                {t("rxd.keepTheirs")}
              </Button>
            </>
          }
        >
          {draft.conflict.theirs ?? t("visit.draftGone")}
        </Callout>
      )}
    </Section>
  );
}

/** Messages on this request: the pharmacy and the doctor see the same list. */
export function Messages({ rx, heading = true }: { rx: RxRequest; heading?: boolean }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const draft = useDraft<string>(`rx:${rx.id}:message`, "");
  const send = useRxMessage(rx.id);
  const can = allows(rx, "message");
  const list = rx.messages.filter((m) => m.visibility === "all");
  if (!can && list.length === 0) return null;
  const submit = () => {
    const body = draft.value.trim();
    if (body) send.mutate({ body, visibility: "all" }, { onSuccess: () => void draft.clear() });
  };
  const body = (
    <>
      {list.length === 0 ? (
        <p className="text-fg-3">{t("rxd.noMessages")}</p>
      ) : (
        <ul className="grid gap-4" role="log" aria-label={t("rxd.messages")}>
          {list.map((m) => {
            const mine = m.author.role === "patient";
            return (
              <li key={m.id} className="msg" data-from={mine ? "patient" : "staff"}>
                {!mine && <p className="msg-author">{f.person(m.author)}</p>}
                <div className="bubble" data-kind={mine ? "patient" : "staff"} data-state={m.id.startsWith("new:") ? "queued" : undefined}>
                  {m.body}
                </div>
                <p className="msg-meta num">{m.id.startsWith("new:") ? t("rxd.sending") : f.dateTime(m.created_at)}</p>
              </li>
            );
          })}
        </ul>
      )}
      {can && (
        <form
          className="mt-5 grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field label={t("rxd.newMessage")} hint={t("rxd.newMessageHint")}>
            <Textarea rows={3} maxLength={2000} value={draft.value} onChange={(e) => draft.set(e.target.value)} disabled={!draft.ready} />
          </Field>
          <div>
            <Button type="submit" loading={send.isPending} disabled={draft.value.trim() === ""} icon={<IconSend aria-hidden />}>
              {t("rxd.sendMessage")}
            </Button>
          </div>
          <ActionError error={send.error} title={t("rxd.messageFailed")} onRetry={submit} />
        </form>
      )}
    </>
  );
  return heading ? <Section title={t("rxd.messages")}>{body}</Section> : body;
}

function Cancel({ rx }: { rx: RxRequest }) {
  const { t } = useTranslation("patient");
  const cancel = useCancelRx();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-8">
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        trigger={<Button variant="destructive">{t("rxd.cancel")}</Button>}
        title={t("rxd.cancelTitle", { no: rx.no })}
        description={t("rxd.cancelBody")}
        confirmLabel={t("rxd.cancelDo")}
        cancelLabel={t("rxd.cancelKeep")}
        destructive
        busy={cancel.isPending}
        onConfirm={() => cancel.mutate({ id: rx.id, revision: rx.revision }, { onSuccess: () => toast.ok(t("rxd.cancelled")) })}
      />
      <ActionError error={cancel.error} className="mt-3" title={t("rxd.cancelFailed")} />
    </div>
  );
}
