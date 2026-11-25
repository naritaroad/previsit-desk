import { IconArrowLeft, IconChecks, IconClipboardText, IconLock, IconMessageCircle, IconMessagesOff, IconPrescription, IconUser } from "@tabler/icons-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, useParams } from "react-router";

import type { Ticket, Urgency } from "@/api/types";
import { useDraft, useResolveTicket, useRx, useRxMessage, useTickets, useVisitStream } from "@/data";
import { summaryRows } from "@/lib/intake";
import { paths } from "@/lib/links";
import { allows } from "@/lib/rx";
import { FillPage } from "@/shells/StaffShell";
import { Badge, Banner, Button, ButtonLink, Composer, EmptyState, LoadMore, SearchInput, Segmented, SkeletonRows, StaffBubble, PatientBubble, StatusTag, TextLink, Transcript, toast, useMediaQuery, useOnline } from "@/ui";

import { useErrorText, useFmt, useUrlState } from "./lib";
import { PageError, RoleNote, StaleBar, TextDialog, useDuties } from "./parts";
import { MessageList, ModeBar, StaffComposer } from "./thread";

const RANK: Record<Urgency, number> = { urgent: 0, soon: 1, routine: 2 };

export default function TicketThread() {
  const { id = "" } = useParams();
  return <TicketDesk id={id} />;
}

/** Inbox on the left, one conversation on the right. On narrow screens one of the two. */
export function TicketDesk({ id }: { id?: string }) {
  const { t } = useTranslation("clinic");
  const wide = useMediaQuery("(min-width: 64rem)");
  const all = useTickets("all");
  const ticket = all.items.find((x) => x.id === id);
  const missing = id && !ticket && !all.isPending && !all.hasNextPage;
  const thread =
    id === undefined ? (
      <EmptyState icon={<IconMessageCircle aria-hidden />} title={t("ticket.pick")}>
        {t("ticket.pickBody")}
      </EmptyState>
    ) : ticket ? (
      <Thread key={ticket.id} ticket={ticket} back={!wide} />
    ) : missing ? (
      <EmptyState icon={<IconMessagesOff aria-hidden />} title={t("ticket.gone")} action={<ButtonLink to={paths.clinic.tickets()}>{t("ticket.backToList")}</ButtonLink>}>
        {t("ticket.goneBody")}
      </EmptyState>
    ) : all.isError ? (
      <PageError error={all.error} onRetry={() => void all.refetch()} />
    ) : (
      <SkeletonRows rows={6} />
    );
  return (
    <FillPage
      head={
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-pane py-2.5">
          <h1 className="page-title" tabIndex={-1}>
            {t("ticket.title")}
          </h1>
          <p className="text-sm text-fg-2">{t("ticket.lede")}</p>
        </div>
      }
    >
      <div className="ticket-desk" data-open={id !== undefined}>
        {(wide || id === undefined) && <Inbox />}
        {(wide || id !== undefined) && (
          <section className="min-h-0 min-w-0 bg-bg" aria-label={t("ticket.thread")}>
            {thread}
          </section>
        )}
      </div>
    </FillPage>
  );
}

function Inbox() {
  const { t } = useTranslation(["clinic", "common"]);
  const fmt = useFmt();
  const [url, set] = useUrlState({ status: "open", q: "" });
  const status = url.status === "resolved" ? "resolved" : "open";
  const query = useTickets(status);
  const items = useMemo(() => {
    const q = url.q.trim().toLowerCase();
    return query.items
      .filter((x) => !q || `${x.patient?.display_name ?? ""} ${x.summary} ${x.ticket_no}`.toLowerCase().includes(q))
      .toSorted((a, b) => (status === "open" ? RANK[a.urgency] - RANK[b.urgency] : 0) || b.created_at.localeCompare(a.created_at));
  }, [query.items, url.q, status]);
  const search = new URLSearchParams(Object.entries(url).filter(([k, v]) => v && !(k === "status" && v === "open"))).toString();
  return (
    <div className="ticket-inbox">
      <StaleBar query={query} />
      <div className="grid gap-2 border-b border-rule p-3">
        <Segmented
          label={t("ticket.statusLabel")}
          value={status}
          onValueChange={(v) => set({ status: v })}
          options={[
            { value: "open", label: t("common:status.ticket.open"), count: status === "open" ? items.length : undefined },
            { value: "resolved", label: t("common:status.ticket.resolved") },
          ]}
        />
        <SearchInput value={url.q} onValueChange={(q) => set({ q })} placeholder={t("ticket.search")} />
      </div>
      <div className="scroll-y min-h-0 flex-1">
        {query.isPending ? (
          <SkeletonRows rows={5} />
        ) : query.isError && !query.data ? (
          <PageError error={query.error} onRetry={() => void query.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon={<IconChecks aria-hidden />} title={t(url.q ? "work.noMatch" : `ticket.empty.${status}`)}>
            {t(url.q ? "work.noMatchBody" : `ticket.emptyBody.${status}`)}
          </EmptyState>
        ) : (
          <nav aria-label={t("ticket.title")}>
            <ul>
              {items.map((x) => (
                <li key={x.id}>
                  <NavLink to={{ pathname: `/clinic/tickets/${x.id}`, search }} className="ticket-link" data-urgent={x.urgency === "urgent" && x.status === "open"}>
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="font-semibold">{x.patient?.display_name ?? t("ticket.noPatient")}</span>
                      <time className="num text-sm text-fg-2" dateTime={x.created_at}>
                        {fmt.rel(x.created_at)}
                      </time>
                    </span>
                    <span className="line-clamp-2">{x.summary}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge plain>{t(`ticket.reason.${x.reason}`)}</Badge>
                      {x.urgency !== "routine" && <StatusTag family="urgency" status={x.urgency} />}
                      {x.status === "resolved" && <StatusTag family="ticket" status="resolved" plain />}
                    </span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        )}
        {query.hasNextPage && <LoadMore onLoad={() => void query.fetchNextPage()} loading={query.isFetchingNextPage} />}
      </div>
    </div>
  );
}

function Head({ ticket, back, children }: { ticket: Ticket; back: boolean; children?: ReactNode }) {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const resolve = useResolveTicket();
  const [open, setOpen] = useState(false);
  return (
    <header className="border-b border-rule bg-surface px-pane py-3">
      {back && (
        <TextLink to={paths.clinic.tickets()} quiet className="mb-1 inline-flex min-h-8 items-center gap-1 text-sm">
          <IconArrowLeft size={18} aria-hidden />
          {t("ticket.backToList")}
        </TextLink>
      )}
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-72">
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-bold">
            {ticket.patient?.display_name ?? t("ticket.noPatient")}
            <StatusTag family="ticket" status={ticket.status} />
            {ticket.urgency !== "routine" && <StatusTag family="urgency" status={ticket.urgency} />}
          </h2>
          <p className="num text-sm text-fg-2">{[t(`ticket.reason.${ticket.reason}`), ticket.ticket_no, t(`ticket.by.${ticket.created_by}`), fmt.stamp(ticket.created_at)].join(t("patient.dot"))}</p>
        </div>
        <div className="toolbar">
          {children}
          {ticket.patient && (
            <ButtonLink to={paths.clinic.patient(ticket.patient.id)} size="sm" icon={<IconUser aria-hidden />}>
              {t("preview.patient")}
            </ButtonLink>
          )}
          {ticket.status === "open" && (
            <Button size="sm" variant="primary" icon={<IconChecks aria-hidden />} onClick={() => setOpen(true)}>
              {t("ticket.resolve")}
            </Button>
          )}
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap">{ticket.summary}</p>
      {ticket.status === "resolved" && (
        <Banner tone="ok" role="note" className="mt-3" title={t("ticket.resolvedBy", { name: ticket.resolved_by ?? "", time: fmt.stamp(ticket.resolved_at) })}>
          {ticket.resolution_note}
        </Banner>
      )}
      <TextDialog
        open={open}
        onOpenChange={setOpen}
        title={t("ticket.resolveTitle", { no: ticket.ticket_no })}
        description={t("ticket.resolveBody")}
        label={t("ticket.resolveLabel")}
        confirm={t("ticket.resolve")}
        max={500}
        rows={3}
        onSubmit={async (note) => {
          await resolve.mutateAsync({ id: ticket.id, note });
          toast.ok(t("ticket.resolvedToast", { no: ticket.ticket_no }));
        }}
      />
    </header>
  );
}

function Thread({ ticket, back }: { ticket: Ticket; back: boolean }) {
  const { t } = useTranslation("clinic");
  if (ticket.visit_id) return <VisitThread ticket={ticket} visitId={ticket.visit_id} back={back} />;
  if (ticket.rx_id) return <RxThread ticket={ticket} rxId={ticket.rx_id} back={back} />;
  return (
    <>
      <Head ticket={ticket} back={back} />
      <p className="p-pane text-fg-2">{t("ticket.noThread")}</p>
    </>
  );
}

/** The patient's previsit conversation, live, with the composer for whoever took over. */
function VisitThread({ ticket, visitId, back }: { ticket: Ticket; visitId: string; back: boolean }) {
  const { t } = useTranslation(["clinic", "common"]);
  const duties = useDuties();
  const v = useVisitStream(visitId);
  const rows = v.summary ? summaryRows(v.summary, t("common:list.sep")).filter((r) => r.status === "filled").slice(0, 4) : [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Head ticket={ticket} back={back}>
        <ButtonLink to={paths.clinic.visit(visitId)} size="sm" icon={<IconClipboardText aria-hidden />}>
          {t("ticket.toDesk")}
        </ButtonLink>
      </Head>
      {!v.visit ? (
        v.phase === "error" ? (
          <PageError error={v.error} onRetry={v.reconnect} />
        ) : (
          <SkeletonRows rows={5} />
        )
      ) : (
        <>
          <ModeBar visit={v.visit} canReply={duties.reply} />
          {v.connection === "retrying" && (
            <Banner tone="warn" bleed actions={<Button size="sm" onClick={v.reconnect}>{t("desk.reconnect")}</Button>}>
              {t("desk.retrying")}
            </Banner>
          )}
          {rows.length > 0 && (
            <details className="border-b border-rule bg-surface px-pane py-2">
              <summary className="link inline">{t("ticket.known")}</summary>
              <dl className="dl mt-1">
                {rows.map((r) => (
                  <div key={r.key}>
                    <dt>{t(`field.${r.key}`)}</dt>
                    <dd>{r.value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
          <Transcript label={t("ticket.thread")} follow={`${v.lastSeq}:${v.live?.text.length ?? 0}`} className="min-h-0">
            <MessageList messages={v.messages} patientName={v.visit.patient.display_name} live={v.live?.text} />
          </Transcript>
          <StaffComposer visit={v.visit} canReply={duties.reply} />
        </>
      )}
    </div>
  );
}

/** A ticket from a prescription request: its messages, not a previsit. */
function RxThread({ ticket, rxId, back }: { ticket: Ticket; rxId: string; back: boolean }) {
  const { t } = useTranslation(["clinic", "rx"]);
  const fmt = useFmt();
  const online = useOnline();
  const errorText = useErrorText();
  const query = useRx(rxId);
  const send = useRxMessage(rxId);
  const draft = useDraft<string>(`rx:${rxId}:message`, "");
  const rx = query.data;
  const canSend = rx ? allows(rx, "message") : false;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Head ticket={ticket} back={back}>
        <ButtonLink to={paths.clinic.rx(rxId)} size="sm" icon={<IconPrescription aria-hidden />}>
          {t("ticket.toRx")}
        </ButtonLink>
      </Head>
      {!rx ? (
        query.isError ? (
          <PageError error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <SkeletonRows rows={5} />
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 border-b border-rule bg-surface px-pane py-2">
            <span className="num font-semibold">{rx.no}</span>
            <StatusTag family="rx" status={rx.status} />
            <span>{fmt.list(rx.items.map((i) => (fmt.locale === "en" ? i.drug.name_en : i.drug.name_zh)))}</span>
          </div>
          <Transcript label={t("ticket.thread")} follow={rx.messages.length} className="min-h-0">
            {rx.messages.length === 0 && <p className="text-fg-2">{t("rx.noMessages")}</p>}
            {rx.messages.map((m) =>
              m.author.role === "patient" ? (
                <PatientBubble key={m.id} time={fmt.stamp(m.created_at)} author={t("thread.says", { name: m.author.display_name })}>
                  {m.body}
                </PatientBubble>
              ) : (
                <StaffBubble key={m.id} name={m.author.display_name} title={m.author.title} time={fmt.stamp(m.created_at)}>
                  {m.visibility === "staff" && (
                    <Badge icon={<IconLock aria-hidden />} className="mb-1">
                      {t("rx.staffOnly")}
                    </Badge>
                  )}
                  {m.visibility === "staff" && <br />}
                  {m.body}
                </StaffBubble>
              ),
            )}
          </Transcript>
          {canSend ? (
            <Composer
              value={draft.value}
              onValueChange={(v) => draft.set(v)}
              label={t("thread.composer", { name: rx.patient.display_name })}
              placeholder={t("rx.writePatient")}
              offline={!online}
              running={send.isPending}
              onSend={() => send.mutate({ body: draft.value.trim(), visibility: "all" }, { onSuccess: () => void draft.clear(), onError: (e) => toast.warn(errorText(e)) })}
              accessory={<span className="text-sm text-fg-2">{t("ticket.patientSees")}</span>}
            />
          ) : (
            <RoleNote className="m-4">{t("thread.noReply")}</RoleNote>
          )}
        </>
      )}
    </div>
  );
}
