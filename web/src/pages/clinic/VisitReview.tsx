import { IconAmbulance, IconArrowRight, IconCalendarUp, IconCheck, IconDeviceFloppy, IconDotsVertical, IconHeadset, IconMessageQuestion, IconPhone, IconPrinter, IconTicket } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";

import { isApiError } from "@/api/errors";
import type { ClinicalNote, NoteSection, Ticket } from "@/api/types";
import { useAssignVisit, useContactPatient, useLeaveGuard, useMe, useNoteEditor, useOutbox, usePatient, useResolveTicket, useTakeover, useVisitStream, useWorklist, type NoteEditor, type VisitStreamHandle } from "@/data";
import { internalLink, paths } from "@/lib/links";
import { FillPage } from "@/shells/StaffShell";
import { Banner, Button, ConfirmDialog, DiffMergeDialog, IconButton, Menu, MenuItem, MenuLink, MenuSeparator, PresenceLine, SaveState, SkeletonRows, SplitPane, StatusTag, TextLink, toast, useHotkey, useOnline } from "@/ui";

import { useCannedReplies } from "./canned";
import { NOTE_SECTIONS, personLabel, samePerson, useErrorText, useFmt, useMinute } from "./lib";
import { AssignMenu, PageError, RoleNote, TextDialog, useDuties } from "./parts";
import { questionText } from "./rx/decision";
import { ContextPane } from "./visit/ContextPane";
import { HistoryPopover, NotePane } from "./visit/NotePane";
import { PrintNote } from "./visit/PrintNote";
import { SourcePane, type SourceTab, type Trail } from "./visit/SourcePane";

type DialogName = "ask" | "phone" | "earlier" | "er" | "sign" | "merge" | "device" | null;

/** The review desk: context, what the patient said, and the physician's note side by side. */
export default function VisitReview() {
  const { id = "" } = useParams();
  return <Desk key={id} id={id} />;
}

function Desk({ id }: { id: string }) {
  const { t } = useTranslation("clinic");
  const v = useVisitStream(id);
  if (v.phase === "error" && !v.visit) return <PageError error={v.error} onRetry={v.reconnect} back={{ to: "/clinic/worklist", label: t("desk.backToList") }} />;
  if (!v.visit)
    return (
      <>
        <h1 className="sr-only" tabIndex={-1}>
          {t("desk.title")}
        </h1>
        <SkeletonRows rows={10} className="p-pane" />
      </>
    );
  return <Loaded id={id} v={v} />;
}

function Loaded({ id, v }: { id: string; v: VisitStreamHandle }) {
  const { t } = useTranslation(["clinic", "common", "rx"]);
  const visit = v.visit!;
  const fmt = useFmt();
  const online = useOnline();
  const errorText = useErrorText();
  const duties = useDuties();
  const now = useMinute();
  const me = useMe();
  const ed = useNoteEditor(id);
  const record = usePatient(visit.patient.id);
  const assign = useAssignVisit();
  const [dialog, setDialog] = useState<DialogName>(null);
  const [tab, setTab] = useState<SourceTab>("summary");
  const [trail, setTrail] = useState<Trail | null>(null);
  const [asking, setAsking] = useState<string[]>([]);
  const [errors, setErrors] = useState<Partial<Record<NoteSection, string>>>({});
  useLeaveGuard(`note:${id}`, ed.autosave.status === "saving" || (ed.edited && ed.autosave.dirty), "errors:leave.unsaved");

  const signed = ed.note?.status === "signed";
  const closed = visit.status === "submitted" || visit.status === "red_flag";
  const save = async () => {
    try {
      await ed.save();
      toast.ok(t("note.saved"));
    } catch (e) {
      if (!isApiError(e, "conflict")) toast.warn(errorText(e));
    }
  };
  useHotkey(
    "mod+s",
    (e) => {
      e.preventDefault();
      if (ed.edited && !ed.saving) void save();
    },
    !signed && duties.review,
  );
  const sign = async () => {
    setErrors({});
    try {
      await ed.sign();
      setDialog(null);
      toast.ok(t("note.signedToast", { name: visit.patient.display_name }));
    } catch (e) {
      setDialog(null);
      if (isApiError(e) && e.hasFields) {
        const found: Partial<Record<NoteSection, string>> = {};
        for (const [k, m] of Object.entries(e.fields)) {
          const s = NOTE_SECTIONS.find((x) => k === x || k === `sections.${x}`);
          if (s) found[s] = m;
        }
        setErrors(found);
        const first = NOTE_SECTIONS.find((s) => found[s]);
        if (first) document.querySelector<HTMLElement>(`#note-${first} textarea`)?.focus();
        else toast.warn(errorText(e));
      } else if (!isApiError(e, "conflict")) toast.warn(errorText(e));
    }
  };
  const askSign = () => {
    const s = ed.sections;
    const missing: Partial<Record<NoteSection, string>> = {};
    for (const k of ["assessment", "plan"] as const) if (!s?.[k].trim()) missing[k] = t("note.needed");
    setErrors(missing);
    const first = (["assessment", "plan"] as const).find((k) => missing[k]);
    if (first) document.querySelector<HTMLElement>(`#note-${first} textarea`)?.focus();
    else setDialog("sign");
  };

  const row = record.data?.row;
  const others = visit.mode === "human" && visit.assigned_to && !samePerson(visit.assigned_to, me) ? [visit.assigned_to] : [];
  const openTickets = v.tickets.filter((x) => x.status === "open");

  const head = (
    <>
      <div className="desk-head">
        <div className="min-w-0">
          <h1 tabIndex={-1} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-lg font-bold">
            <Link to={paths.clinic.patient(visit.patient.id)} className="link" data-quiet="true">
              {visit.patient.display_name}
            </Link>
            <span className="text-base font-medium text-fg-2">{[row?.age == null ? null : t("patient.age", { n: row.age }), row?.sex ? t(`patient.sex.${row.sex}`) : null].filter(Boolean).join(t("patient.dot"))}</span>
            <span className="text-base font-medium">{visit.title}</span>
          </h1>
          <p className="num flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-2">
            <StatusTag family="visit" status={visit.status} />
            {visit.urgency !== "routine" && <StatusTag family="urgency" status={visit.urgency} />}
            {visit.appointment && <span>{t("desk.appointment", { time: fmt.stamp(visit.appointment.starts_at), who: visit.appointment.physician.display_name })}</span>}
            {visit.submitted_at && <span>{t("desk.sent", { time: fmt.stamp(visit.submitted_at) })}</span>}
          </p>
        </div>
        <div className="desk-tools">
          <PresenceLine people={others.map((p) => ({ name: p.display_name, title: p.title }))} editing />
          {!signed && ed.edited && <DraftState ed={ed} onConflict={() => setDialog(ed.conflict ? "merge" : "device")} />}
          <HistoryPopover ed={ed} />
          <AssignMenu value={visit.assigned_to} busy={assign.isPending} onAssign={(account) => assign.mutate({ id, account }, { onError: (e) => toast.warn(errorText(e)) })} />
          <IconButton label={t("desk.print")} size="sm" variant="bordered" onClick={() => window.print()}>
            <IconPrinter size={20} aria-hidden />
          </IconButton>
          {!signed && duties.review && (
            <Button size="sm" icon={<IconDeviceFloppy aria-hidden />} disabled={!ed.edited} loading={ed.saving && !ed.signing} onClick={() => void save()}>
              {t("note.save")}
            </Button>
          )}
          {!signed && duties.sign && closed && (
            <Button size="sm" variant="primary" icon={<IconCheck aria-hidden />} loading={ed.signing} onClick={askSign}>
              {t("note.sign")}
            </Button>
          )}
          {signed && <NextItem current={id} />}
        </div>
      </div>
      {!online && <Banner tone="warn" bleed>{t("desk.offline")}</Banner>}
      {online && v.connection === "retrying" && (
        <Banner tone="warn" bleed actions={<Button size="sm" onClick={v.reconnect}>{t("desk.reconnect")}</Button>}>
          {t("desk.retrying")}
        </Banner>
      )}
      {ed.conflict && dialog !== "merge" && (
        <Banner tone="warn" bleed title={t("note.conflictTitle", { name: personLabel(ed.conflict.theirs.author) || t("note.unknown") })} actions={<Button size="sm" onClick={() => setDialog("merge")}>{t("common:save.resolve")}</Button>}>
          {t("note.conflictBody")}
        </Banner>
      )}
      {ed.autosave.conflict && dialog !== "device" && !ed.conflict && (
        <Banner tone="warn" bleed title={t("note.deviceTitle")} actions={<Button size="sm" onClick={() => setDialog("device")}>{t("common:save.resolve")}</Button>}>
          {t("note.deviceBody")}
        </Banner>
      )}
      {openTickets.map((x) => (
        <TicketBar key={x.id} ticket={x} />
      ))}
    </>
  );

  return (
    <>
      <div className="no-print h-full">
        <FillPage head={head}>
          <SplitPane
            storageKey="clinic-desk"
            initial={[26, 41, 33]}
            panes={[
              { id: "context", label: t("desk.paneContext"), min: 16, content: <ContextPane visit={visit} /> },
              {
                id: "source",
                label: t("desk.paneSource"),
                min: 26,
                content: (
                  <SourcePane
                    v={v}
                    tab={tab}
                    onTab={setTab}
                    trail={trail}
                    onTrail={setTrail}
                    canReply={duties.reply}
                    onAsk={(q) => {
                      setAsking(q);
                      setDialog("ask");
                    }}
                  />
                ),
              },
              {
                id: "note",
                label: t("desk.paneNote"),
                min: 24,
                content: (
                  <NotePane visitId={id} ed={ed} summary={v.summary} canSign={duties.sign} canEdit={duties.review} errors={errors}>
                    <div className="desk-actions">
                      {!duties.sign && <RoleNote className="basis-full">{t("note.signPhysician")}</RoleNote>}
                      {duties.sign && !closed && !signed && <RoleNote className="basis-full">{t("note.notSent")}</RoleNote>}
                      {duties.reply && (
                        <Button size="sm" icon={<IconMessageQuestion aria-hidden />} onClick={() => { setAsking([]); setDialog("ask"); }}>
                          {t("action.ask")}
                        </Button>
                      )}
                      {duties.reply && (
                        <Button size="sm" icon={<IconHeadset aria-hidden />} onClick={() => { setTrail(null); setTab("talk"); }}>
                          {t("action.talk")}
                        </Button>
                      )}
                      {duties.manage && (
                        <Button size="sm" icon={<IconPhone aria-hidden />} onClick={() => setDialog("phone")}>
                          {t("action.phone")}
                        </Button>
                      )}
                      {duties.reply && (
                        <Menu
                          side="top"
                          trigger={
                            <IconButton label={t("action.more")} size="sm" variant="bordered" tooltip={false}>
                              <IconDotsVertical size={20} aria-hidden />
                            </IconButton>
                          }
                        >
                          <MenuItem icon={<IconCalendarUp aria-hidden />} onSelect={() => setDialog("earlier")}>
                            {t("action.earlier")}
                          </MenuItem>
                          <MenuItem icon={<IconAmbulance aria-hidden />} onSelect={() => setDialog("er")}>
                            {t("action.er")}
                          </MenuItem>
                          <MenuSeparator />
                          <MenuLink render={(p) => <Link to={paths.clinic.schedule()} {...p} />}>{t("action.schedule")}</MenuLink>
                        </Menu>
                      )}
                    </div>
                  </NotePane>
                ),
              },
            ]}
          />
        </FillPage>
      </div>
      <PrintNote v={v} ed={ed} record={record.data} now={now} />
      <ConfirmDialog open={dialog === "sign"} onOpenChange={(o) => !o && setDialog(null)} title={t("note.signTitle", { name: visit.patient.display_name })} description={t("note.signBody")} confirmLabel={t("note.signConfirm")} busy={ed.signing} onConfirm={() => void sign()}>
        {!ed.sections?.patient_message.trim() && <Banner tone="warn" role="note">{t("note.noMessage")}</Banner>}
      </ConfirmDialog>
      {ed.conflict && <MergeDialog open={dialog === "merge"} onOpenChange={(o) => setDialog(o ? "merge" : null)} ed={ed} />}
      {ed.autosave.conflict && <DeviceDialog open={dialog === "device"} onOpenChange={(o) => setDialog(o ? "device" : null)} ed={ed} />}
      <Contact dialog={dialog} onClose={() => setDialog(null)} v={v} questions={asking} onSent={() => { setTrail(null); setTab("talk"); }} />
    </>
  );
}

function DraftState({ ed, onConflict }: { ed: NoteEditor; onConflict: () => void }) {
  const fmt = useFmt();
  const a = ed.autosave;
  const state = a.conflict || ed.conflict ? "conflict" : a.error ? "error" : a.status === "saving" ? "saving" : a.status === "offline" ? "offline" : "saved";
  return <SaveState state={state} savedAt={a.savedAt ? fmt.time(a.savedAt) : undefined} onResolve={state === "conflict" ? onConflict : () => void a.flush()} />;
}

/** The next item that still waits, so a signed note is not a dead end. */
function NextItem({ current }: { current: string }) {
  const { t } = useTranslation("clinic");
  const navigate = useNavigate();
  const list = useWorklist({ bucket: "pending", limit: 100 });
  const next = list.items.find((i) => i.type === "visit" && i.id !== current) ?? list.items.find((i) => i.type === "rx");
  const link = internalLink(next?.link);
  if (!next || !link) return <TextLink to="/clinic/worklist">{t("desk.backToList")}</TextLink>;
  return (
    <Button size="sm" variant="primary" iconEnd={<IconArrowRight aria-hidden />} onClick={() => void navigate(link)}>
      {t("desk.next", { name: next.patient.display_name })}
    </Button>
  );
}

function TicketBar({ ticket }: { ticket: Ticket }) {
  const { t } = useTranslation("clinic");
  const resolve = useResolveTicket();
  const [open, setOpen] = useState(false);
  return (
    <Banner
      tone={ticket.urgency === "urgent" ? "danger" : "warn"}
      bleed
      role="note"
      icon={<IconTicket aria-hidden />}
      title={
        <>
          {t(`ticket.reason.${ticket.reason}`)} <span className="num font-normal text-fg-2">{ticket.ticket_no}</span>
        </>
      }
      actions={
        <>
          <TextLink to={`/clinic/tickets/${ticket.id}`} className="text-sm">
            {t("ticket.open")}
          </TextLink>
          <Button size="sm" onClick={() => setOpen(true)}>
            {t("ticket.resolve")}
          </Button>
        </>
      }
    >
      <span className="line-clamp-2">{ticket.summary}</span>
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
    </Banner>
  );
}

function MergeDialog({ open, onOpenChange, ed }: { open: boolean; onOpenChange: (o: boolean) => void; ed: NoteEditor }) {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const c = ed.conflict!;
  const theirs: ClinicalNote = c.theirs;
  const fields = NOTE_SECTIONS.filter((k) => c.mine[k] !== theirs.sections[k]).map((k) => ({ key: k, label: t(`note.${k}`), mine: c.mine[k], theirs: theirs.sections[k] }));
  const at = theirs.history.at(-1)?.at;
  return (
    <DiffMergeDialog
      open={open}
      onOpenChange={onOpenChange}
      fields={fields}
      theirsLabel={[personLabel(theirs.author) || t("note.unknown"), at && fmt.stamp(at)].filter(Boolean).join(t("patient.dot"))}
      onMerge={(choice) => {
        const merged = { ...theirs.sections };
        for (const k of NOTE_SECTIONS) if (choice[k] === "mine") merged[k] = c.mine[k];
        ed.resolve({ merged });
        onOpenChange(false);
      }}
    />
  );
}

/** The same person wrote on another device: the draft has two versions. */
function DeviceDialog({ open, onOpenChange, ed }: { open: boolean; onOpenChange: (o: boolean) => void; ed: NoteEditor }) {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const c = ed.autosave.conflict!;
  const mine = c.mine?.sections;
  const theirs = c.theirs?.sections ?? ed.note?.sections;
  if (!mine || !theirs) return null;
  return (
    <DiffMergeDialog
      open={open}
      onOpenChange={onOpenChange}
      fields={NOTE_SECTIONS.filter((k) => mine[k] !== theirs[k]).map((k) => ({ key: k, label: t(`note.${k}`), mine: mine[k], theirs: theirs[k] }))}
      theirsLabel={c.theirsUpdatedAt ? t("note.otherDevice", { time: fmt.stamp(c.theirsUpdatedAt) }) : t("note.otherDeviceGone")}
      onMerge={(choice) => {
        const merged = { ...theirs };
        for (const k of NOTE_SECTIONS) if (choice[k] === "mine") merged[k] = mine[k];
        ed.autosave.resolve({ merged: { sections: merged, base: c.theirs?.base ?? c.mine?.base ?? ed.note?.revision ?? 0 } });
        onOpenChange(false);
      }}
    />
  );
}

/** Everything that leaves the desk: a message in this conversation (a person takes over first) or a phone note. */
function Contact({ dialog, onClose, v, questions, onSent }: { dialog: DialogName; onClose: () => void; v: VisitStreamHandle; questions: string[]; onSent: () => void }) {
  const { t } = useTranslation(["clinic", "common"]);
  const visit = v.visit!;
  const { takeover } = useTakeover(visit.id);
  const outbox = useOutbox(visit.id, "staff");
  const contact = useContactPatient(visit.patient.id);
  const [canned] = useCannedReplies();
  const send = async (text: string) => {
    if (visit.mode !== "human") await takeover.mutateAsync();
    await outbox.send(text);
    toast.ok(t("thread.sentToast", { name: visit.patient.display_name }));
    onSent();
  };
  const kind = dialog === "ask" || dialog === "earlier" || dialog === "er" || dialog === "phone" ? dialog : null;
  const initial = kind === "ask" ? (questions.length ? `${t("action.askIntro")}\n${questionText(questions)}` : "") : kind === "earlier" ? t("action.earlierText") : kind === "er" ? t("common:emergency.body") : "";
  const suggestions =
    kind === "ask"
      ? [...(v.summary?.follow_up ?? []).filter((q) => !questions.includes(q)).map((q) => ({ label: q, text: q })), ...canned.slice(0, 2).map((c) => ({ label: c.title, text: c.body }))]
      : kind === "phone"
        ? (["reached", "missed", "family"] as const).map((k) => ({ label: t(`action.phoneQuick.${k}`), text: t(`action.phoneQuick.${k}`) }))
        : [];
  return (
    <TextDialog
      open={kind !== null}
      onOpenChange={(o) => !o && onClose()}
      title={kind ? t(`action.title.${kind}`, { name: visit.patient.display_name }) : ""}
      description={kind ? t(`action.body.${kind}`) : undefined}
      label={t(kind === "phone" ? "action.phoneLabel" : "action.messageLabel")}
      hint={t(kind === "phone" ? "action.phoneHint" : "action.messageHint")}
      initial={initial}
      confirm={t(kind === "phone" ? "action.savePhone" : "action.send")}
      suggestions={suggestions}
      suggestionsLabel={t("action.suggestions")}
      rows={6}
      before={kind && kind !== "phone" && visit.mode !== "human" ? <Banner tone="info" role="note">{t("action.willTakeOver")}</Banner> : undefined}
      onSubmit={async (text) => {
        if (kind === "phone") {
          await contact.mutateAsync({ channel: "phone_note", body: text });
          toast.ok(t("action.phoneSaved"));
        } else await send(text);
      }}
    />
  );
}
