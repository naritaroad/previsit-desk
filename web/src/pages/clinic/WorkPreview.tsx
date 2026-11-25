import { IconArrowRight, IconClick, IconUser } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { PersonRef, WorkItem } from "@/api/types";
import { useRx, useTickets, useVisitDetail } from "@/data";
import { summaryRows } from "@/lib/intake";
import { internalLink, paths } from "@/lib/links";
import { Banner, ButtonLink, DescriptionList, EmptyState, Skeleton, StatusTag, TextLink } from "@/ui";

import { useDebounced, useErrorText, useFmt } from "./lib";
import { AssignMenu, DueText, WorkStatus } from "./parts";

/** The short version of one item. Loaded only after resting on a row: every read of a record is logged. */
export function WorkPreview({ item, now, onAssign }: { item: WorkItem | undefined; now: Date; onAssign: (i: WorkItem, p: PersonRef | null) => void }) {
  const { t } = useTranslation("clinic");
  const rested = useDebounced(item ? `${item.type}:${item.id}` : "", 450);
  if (!item)
    return (
      <div className="h-full bg-bg">
        <EmptyState icon={<IconClick aria-hidden />} title={t("preview.none")}>
          {t("preview.noneBody")}
        </EmptyState>
      </div>
    );
  const link = internalLink(item.link);
  const ready = rested === `${item.type}:${item.id}`;
  return (
    <article className="flex min-h-full flex-col bg-bg" aria-label={t("preview.of", { name: item.patient.display_name })}>
      <header className="border-b border-rule bg-surface px-pane py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-bold">{item.patient.display_name}</h2>
          <WorkStatus item={item} now={now} />
          {item.urgency !== "routine" && <StatusTag family="urgency" status={item.urgency} />}
        </div>
        <p className="mt-1">{item.title}</p>
        <p className="mt-1 text-sm text-fg-2">
          <DueText at={item.due_at} kind={item.type === "visit" ? "appointment" : "deadline"} now={now} />
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {link && (
            <ButtonLink to={link} size="sm" variant="primary" iconEnd={<IconArrowRight aria-hidden />}>
              {t(`preview.open.${item.type}`)}
            </ButtonLink>
          )}
          <ButtonLink to={paths.clinic.patient(item.patient.id)} size="sm" icon={<IconUser aria-hidden />}>
            {t("preview.patient")}
          </ButtonLink>
          {item.type !== "ticket" && <AssignMenu value={item.assigned_to} onAssign={(p) => onAssign(item, p)} />}
        </div>
      </header>
      <div className="flex-1 p-pane">
        {!ready ? <Lines /> : item.type === "visit" ? <VisitPreview id={item.id} /> : item.type === "rx" ? <RxPreview id={item.id} /> : <TicketPreview item={item} />}
      </div>
      <p className="px-pane pb-3 text-sm text-fg-3">{t("preview.logged")}</p>
    </article>
  );
}

function Lines() {
  return (
    <div className="grid gap-3" role="presentation">
      <Skeleton className="w-3/4" />
      <Skeleton />
      <Skeleton className="w-5/6" />
      <Skeleton className="w-2/3" />
    </div>
  );
}
function Failed({ error }: { error: unknown }) {
  const text = useErrorText();
  return <Banner tone="warn">{text(error)}</Banner>;
}
function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-1 font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function VisitPreview({ id }: { id: string }) {
  const { t } = useTranslation(["clinic", "common"]);
  const query = useVisitDetail(id);
  if (query.isError && !query.data) return <Failed error={query.error} />;
  if (!query.data) return <Lines />;
  const { summary, red_flag, messages } = query.data;
  const last = messages.findLast((m) => m.role === "patient");
  const rows = summary ? summaryRows(summary, t("common:list.sep")).filter((r) => r.status === "filled" || r.status === "none") : [];
  return (
    <>
      {red_flag && (
        <Banner tone="danger" role="note" className="mb-4" title={t("flags.red", { label: red_flag.label })}>
          {messages.find((m) => m.id === red_flag.message_id)?.content}
        </Banner>
      )}
      {rows.length > 0 ? (
        <Block title={t("preview.said")}>
          <DescriptionList items={rows.slice(0, 7).map((r) => ({ label: t(`field.${r.key}`), value: r.status === "none" ? t("field.none") : r.value }))} />
        </Block>
      ) : (
        last && <Block title={t("preview.lastMessage")}>{last.content}</Block>
      )}
      {summary && summary.follow_up.length > 0 && (
        <Block title={t("desk.followUp")}>
          <ul className="dash-list">
            {summary.follow_up.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Block>
      )}
      <p className="text-sm text-fg-2">{t("desk.aiNote")}</p>
    </>
  );
}

function RxPreview({ id }: { id: string }) {
  const { t } = useTranslation("clinic");
  const query = useRx(id);
  const { locale } = useFmt();
  if (query.isError && !query.data) return <Failed error={query.error} />;
  if (!query.data) return <Lines />;
  const rx = query.data;
  return (
    <>
      {rx.engine && (
        <Block title={t("rx.engine")}>
          <p className="mb-2">
            <StatusTag family="disposition" status={rx.engine.disposition} />
          </p>
          <p>{rx.engine.summary}</p>
        </Block>
      )}
      <Block title={t("rx.items")}>
        <ul className="divide-y divide-rule">
          {rx.items.map((i) => (
            <li key={i.id} className="py-2">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{locale === "en" ? i.drug.name_en : i.drug.name_zh}</span>
                {i.engine && <StatusTag family="disposition" status={i.engine.disposition} />}
              </span>
              <span className="block text-sm text-fg-2">{i.dose_text}</span>
              {i.engine?.fired.slice(0, 3).map((f) => (
                <span key={f.question_id} className="block text-sm">
                  {f.reason}
                </span>
              ))}
            </li>
          ))}
        </ul>
      </Block>
      <p className="text-sm text-fg-2">{t("rx.notApproval")}</p>
    </>
  );
}

function TicketPreview({ item }: { item: WorkItem }) {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const tickets = useTickets("all");
  const ticket = tickets.items.find((x) => x.id === item.id);
  if (!ticket) return tickets.isPending ? <Lines /> : <p>{item.subtitle}</p>;
  return (
    <>
      <Block title={t("ticket.summary")}>
        <p className="whitespace-pre-wrap">{ticket.summary}</p>
      </Block>
      <DescriptionList
        items={[
          { label: t("ticket.reasonLabel"), value: t(`ticket.reason.${ticket.reason}`) },
          { label: t("ticket.byLabel"), value: t(`ticket.by.${ticket.created_by}`) },
          { label: t("ticket.at"), value: fmt.dateTime(ticket.created_at) },
          { label: t("ticket.no"), value: <span className="num">{ticket.ticket_no}</span> },
        ]}
      />
      <p className="mt-4">
        <TextLink to={`/clinic/tickets/${ticket.id}`}>{t("preview.thread")}</TextLink>
      </p>
    </>
  );
}
