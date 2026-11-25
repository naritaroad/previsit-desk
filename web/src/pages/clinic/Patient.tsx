import { IconCalendarEvent, IconClipboardText, IconEye, IconFileCheck, IconMessage, IconNote, IconPhone, IconPin, IconPinnedOff, IconPrescription, IconTicket, IconTrash } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";

import type { CareStatus, PatientDetail, PersonRef, StaffNote, TimelineEntry } from "@/api/types";
import { useContactPatient, useDraft, useMe, usePatient, usePatientNotes, useStaff, useUpdatePatient } from "@/data";
import { internalLink, paths } from "@/lib/links";
import { Banner, Button, Checkbox, ConfirmDialog, DataTable, EmptyState, Field, IconButton, PageBody, PageHeader, Panel, Section, Segmented, Select, SkeletonRows, StatusTag, Tabs, TextLink, Textarea, Timeline, toast } from "@/ui";

import { personLabel, samePerson, useErrorText, useFmt, useMinute, useUrlState } from "./lib";
import { AssignedTo, DueText, PageError, RoleNote, StaleBar, TextDialog, useDuties } from "./parts";
import { Allergies, Flags, LabResults, MedicationList, PinnedNotes, ProfileFacts, ProfileItems, Readings, VisitLinks } from "./patient/blocks";
import { useCannedReplies } from "./canned";
import { TagEditor } from "./patient/TagEditor";

const CARE: readonly CareStatus[] = ["new", "active", "watch", "inactive"];

export default function Patient() {
  const { id = "" } = useParams();
  const { t } = useTranslation("clinic");
  const query = usePatient(id);
  const back = { to: paths.clinic.patients(), label: t("patients.back") };
  if (!query.data)
    return (
      <PageBody>
        {query.isError ? (
          <PageError error={query.error} onRetry={() => void query.refetch()} back={back} />
        ) : (
          <>
            <PageHeader title={t("patients.record")} back={back} />
            <SkeletonRows rows={8} />
          </>
        )}
      </PageBody>
    );
  return (
    <>
      <StaleBar query={query} />
      <Record key={id} id={id} d={query.data} back={back} />
    </>
  );
}

function Record({ id, d, back }: { id: string; d: PatientDetail; back: { to: string; label: string } }) {
  const { t } = useTranslation(["clinic", "common", "rx"]);
  const fmt = useFmt();
  const now = useMinute();
  const errorText = useErrorText();
  const duties = useDuties();
  const [url, set] = useUrlState({ tab: "timeline" });
  const update = useUpdatePatient(id);
  const contact = useContactPatient(id);
  const [canned] = useCannedReplies();
  const [dialog, setDialog] = useState<"message" | "phone" | null>(null);
  const row = d.row;
  const onError = (e: unknown) => toast.warn(errorText(e));
  const open = d.rx.filter((r) => ["submitted", "in_review", "more_info", "at_pharmacy", "returned", "ready"].includes(r.status));
  const openTickets = d.tickets.filter((x) => x.status === "open");

  const tabs: { value: string; label: string; count?: number; content: ReactNode }[] = [
    { value: "timeline", label: t("record.tab.timeline"), content: <RecordTimeline entries={d.timeline} /> },
    {
      value: "profile",
      label: t("record.tab.profile"),
      content: (
        <div className="record-cols">
          <Section title={t("desk.conditions")}>
            <ProfileItems items={d.profile?.conditions} empty={t("record.noConditions")} />
          </Section>
          <Section title={t("desk.allergies")}>
            <Allergies profile={d.profile} />
          </Section>
          <Section title={t("record.family")}>
            <ProfileItems items={d.profile?.family_history} empty={t("record.noFamily")} />
          </Section>
          <Section title={t("record.selfMeds")}>
            <ProfileItems items={d.profile?.medications} empty={t("record.noSelfMeds")} />
          </Section>
          <Section title={t("record.facts")}>
            <ProfileFacts profile={d.profile} />
          </Section>
        </div>
      ),
    },
    { value: "medicines", label: t("record.tab.medicines"), count: d.medications.length, content: <MedicationList items={d.medications} /> },
    {
      value: "readings",
      label: t("record.tab.readings"),
      content: (
        <div className="record-cols">
          <Section title={t("desk.readings")}>
            <Readings items={d.measurements} height={240} />
          </Section>
          <Section title={t("desk.labs")}>
            <LabResults items={d.measurements} />
          </Section>
        </div>
      ),
    },
    { value: "visits", label: t("record.tab.visits"), count: d.visits.length, content: <VisitLinks visits={d.visits} /> },
    {
      value: "rx",
      label: t("record.tab.rx"),
      count: d.rx.length,
      content: (
        <DataTable
          caption={t("record.tab.rx")}
          rows={d.rx}
          rowKey={(r) => r.id}
          rowLink={(r) => paths.clinic.rx(r.id)}
          empty={<EmptyState icon={<IconPrescription aria-hidden />} title={t("record.noRx")} />}
          columns={[
            { id: "no", header: t("rx.number"), width: "12rem", card: "title", cell: (r) => <span className="num font-semibold">{r.no}</span> },
            { id: "drug", header: t("col.drug"), cell: (r) => fmt.list(r.drug_names) },
            { id: "kind", header: t("rx.kindLabel"), width: "7rem", hideBelow: "md", cell: (r) => t(`rx:kind.${r.kind}`) },
            { id: "status", header: t("col.status"), width: "9rem", card: "end", cell: (r) => <StatusTag family="rx" status={r.status} /> },
            { id: "who", header: t("col.assigned"), width: "7rem", hideBelow: "lg", cell: (r) => <AssignedTo person={r.assigned_to} /> },
            { id: "due", header: t("col.due"), width: "9rem", align: "end", nowrap: true, cell: (r) => <DueText at={r.sla_due_at} kind="deadline" now={now} stopped={r.status !== "in_review" && r.status !== "submitted"} /> },
          ]}
        />
      ),
    },
    {
      value: "appointments",
      label: t("record.tab.appointments"),
      count: d.appointments.length,
      content: (
        <DataTable
          caption={t("record.tab.appointments")}
          rows={d.appointments}
          rowKey={(a) => a.id}
          empty={<EmptyState icon={<IconCalendarEvent aria-hidden />} title={t("record.noAppointments")} />}
          columns={[
            { id: "at", header: t("col.time"), width: "12rem", card: "title", cell: (a) => <span className="num font-semibold">{fmt.dateTime(a.starts_at)}</span> },
            { id: "who", header: t("col.physician"), width: "9rem", cell: (a) => personLabel(a.physician) },
            { id: "reason", header: t("col.reason"), cell: (a) => [a.reason, a.department, t(`appt.mode.${a.mode}`)].filter(Boolean).join(t("patient.dot")) },
            { id: "status", header: t("col.status"), width: "8rem", card: "end", cell: (a) => <StatusTag family="appointment" status={a.status} /> },
            { id: "visit", header: t("col.previsit"), width: "8rem", cell: (a) => (a.visit_id ? <TextLink to={paths.clinic.visit(a.visit_id)}>{t("record.openVisit")}</TextLink> : <span className="text-fg-3">{t("common:status.previsit.none")}</span>) },
          ]}
        />
      ),
    },
    { value: "notes", label: t("record.tab.notes"), count: d.notes.length, content: <Notes id={id} notes={d.notes} entries={d.timeline} canWrite={duties.manage} /> },
  ];

  return (
    <PageBody width="full">
      <PageHeader
        back={back}
        title={
          <>
            {row.patient.display_name}
            <span className="ms-3 text-base font-medium text-fg-2">{[row.age === null ? null : t("patient.age", { n: row.age }), row.sex ? t(`patient.sex.${row.sex}`) : null].filter(Boolean).join(t("patient.dot"))}</span>
          </>
        }
        meta={
          <>
            <StatusTag family="care" status={row.care_status} />
            <Flags flags={row.flags} />
            {row.last_contact_at && <span>{t("record.lastContact", { when: fmt.rel(row.last_contact_at) })}</span>}
            {row.next_appointment_at && <span className="num">{t("record.nextVisit", { when: fmt.dateTime(row.next_appointment_at) })}</span>}
          </>
        }
        actions={
          <>
            {duties.reply && (
              <Button size="sm" icon={<IconMessage aria-hidden />} onClick={() => setDialog("message")}>
                {t("record.message")}
              </Button>
            )}
            {duties.manage && (
              <Button size="sm" icon={<IconPhone aria-hidden />} onClick={() => setDialog("phone")}>
                {t("action.phone")}
              </Button>
            )}
          </>
        }
      />
      <Banner tone="mute" role="note" icon={<IconEye aria-hidden />} className="mb-stack">
        {t("record.logged")}
      </Banner>
      <div className="record-layout">
        <div className="min-w-0">
          <Tabs label={t("patients.record")} value={tabs.some((x) => x.value === url.tab) ? url.tab : "timeline"} onValueChange={(tab) => set({ tab })} items={tabs} />
        </div>
        <aside className="grid min-w-0 content-start gap-5" aria-label={t("record.side")}>
          <Panel title={t("desk.allergies")}>
            <Allergies profile={d.profile} />
          </Panel>
          {(open.length > 0 || openTickets.length > 0) && (
            <Panel title={t("record.openItems")} flush>
              <ul className="divide-y divide-rule">
                {openTickets.map((x) => (
                  <li key={x.id} className="px-pane py-2">
                    <TextLink to={`/clinic/tickets/${x.id}`}>{t(`ticket.reason.${x.reason}`)}</TextLink>
                    <span className="line-clamp-2 block text-sm text-fg-2">{x.summary}</span>
                  </li>
                ))}
                {open.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-pane py-2">
                    <TextLink to={paths.clinic.rx(r.id)}>{fmt.list(r.drug_names)}</TextLink>
                    <StatusTag family="rx" status={r.status} />
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          {d.notes.some((n) => n.pinned) && (
            <Panel title={t("record.pinned")}>
              <PinnedNotes notes={d.notes} />
            </Panel>
          )}
          <Panel title={t("record.care")}>
            {duties.manage ? (
              <div className="grid gap-4">
                <Field label={t("patients.care")}>
                  <Select value={row.care_status} onValueChange={(v) => update.mutate({ patch: { care_status: v as CareStatus } }, { onError })} options={CARE.map((value) => ({ value, label: t(`common:status.care.${value}`), hint: t(`patients.careHint.${value}`) }))} />
                </Field>
                <People row={row} onPhysician={(p) => update.mutate({ patch: { physician_id: p?.id ?? null }, physician: p }, { onError })} onCoordinator={(p) => update.mutate({ patch: { coordinator_id: p?.id ?? null }, coordinator: p }, { onError })} />
                <TagEditor tags={row.tags} onChange={(tags) => update.mutate({ patch: { tags } }, { onError })} />
              </div>
            ) : (
              <RoleNote>{t("record.noManage")}</RoleNote>
            )}
          </Panel>
        </aside>
      </div>
      <TextDialog
        open={dialog !== null}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t(dialog === "phone" ? "action.title.phone" : "record.messageTitle", { name: row.patient.display_name })}
        description={t(dialog === "phone" ? "action.body.phone" : "record.messageBody")}
        label={t(dialog === "phone" ? "action.phoneLabel" : "action.messageLabel")}
        confirm={t(dialog === "phone" ? "action.savePhone" : "action.send")}
        suggestionsLabel={t("action.suggestions")}
        suggestions={dialog === "phone" ? (["reached", "missed", "family"] as const).map((k) => ({ label: t(`action.phoneQuick.${k}`), text: t(`action.phoneQuick.${k}`) })) : canned.map((c) => ({ label: c.title, text: c.body }))}
        onSubmit={async (body) => {
          await contact.mutateAsync({ channel: dialog === "phone" ? "phone_note" : "in_app", body });
          toast.ok(t(dialog === "phone" ? "action.phoneSaved" : "thread.sentToast", { name: row.patient.display_name }));
        }}
      />
    </PageBody>
  );
}

function People({ row, onPhysician, onCoordinator }: { row: PatientDetail["row"]; onPhysician: (p: PersonRef | null) => void; onCoordinator: (p: PersonRef | null) => void }) {
  const { t } = useTranslation("clinic");
  const staff = useStaff(["physician", "coordinator"]);
  const pick = (role: PersonRef["role"], current: PersonRef | null) => {
    const list = (staff.data ?? []).filter((p) => p.role === role);
    return current && !list.some((p) => samePerson(p, current)) ? [current, ...list] : list;
  };
  const select = (label: string, role: PersonRef["role"], current: PersonRef | null, on: (p: PersonRef | null) => void) => {
    const list = pick(role, current);
    return (
      <Field label={label}>
        <Select value={current?.id ?? "none"} onValueChange={(v) => on(list.find((p) => p.id === v) ?? null)} options={[{ value: "none", label: t("assign.none") }, ...list.map((p) => ({ value: p.id, label: personLabel(p) }))]} />
      </Field>
    );
  };
  return (
    <>
      {select(t("record.physician"), "physician", row.physician, onPhysician)}
      {select(t("record.coordinator"), "coordinator", row.coordinator, onCoordinator)}
    </>
  );
}

// ------------------------------------------------------------------------------------------------ timeline

const GROUPS = ["all", "visit", "rx", "appointment", "contact", "ticket"] as const;
type Group = (typeof GROUPS)[number];
function groupOf(kind: string): Exclude<Group, "all"> {
  if (kind.startsWith("rx")) return "rx";
  if (kind.startsWith("appointment") || kind.startsWith("appt")) return "appointment";
  if (kind.startsWith("contact") || kind.startsWith("note.staff")) return "contact";
  if (kind.startsWith("ticket")) return "ticket";
  return "visit";
}
const ICONS = { visit: IconClipboardText, rx: IconPrescription, appointment: IconCalendarEvent, contact: IconPhone, ticket: IconTicket };

function RecordTimeline({ entries }: { entries: TimelineEntry[] }) {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const [group, setGroup] = useState<Group>("all");
  const [shown, setShown] = useState(30);
  const list = entries.filter((e) => group === "all" || groupOf(e.kind) === group);
  return (
    <>
      <div className="scroll-x mb-4">
        <Segmented label={t("record.filter")} value={group} onValueChange={(v) => setGroup(v as Group)} options={GROUPS.map((value) => ({ value, label: t(`record.kind.${value}`), count: value === "all" ? undefined : entries.filter((e) => groupOf(e.kind) === value).length }))} />
      </div>
      {list.length === 0 ? (
        <EmptyState title={t("record.noTimeline")}>{t("record.noTimelineBody")}</EmptyState>
      ) : (
        <Timeline
          label={t("record.tab.timeline")}
          items={list.slice(0, shown).map((e, i) => {
            const link = internalLink(e.link);
            const g = groupOf(e.kind);
            const Icon = e.kind === "note" || e.kind === "visit.reviewed" ? IconFileCheck : ICONS[g];
            return {
              id: `${e.at}-${i}`,
              time: fmt.stamp(e.at),
              dateTime: e.at,
              what: link ? (
                <TextLink to={link} quiet>
                  {e.title}
                </TextLink>
              ) : (
                <span className="whitespace-pre-wrap">{e.title}</span>
              ),
              who: personLabel(e.actor) || t(`record.kind.${g}`),
              icon: <Icon aria-hidden />,
              pending: new Date(e.at) > new Date(),
            };
          })}
        />
      )}
      {list.length > shown && (
        <Button size="sm" className="mt-3" onClick={() => setShown(shown + 30)}>
          {t("record.older", { count: list.length - shown })}
        </Button>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------------ notes and contact

function Notes({ id, notes, entries, canWrite }: { id: string; notes: StaffNote[]; entries: TimelineEntry[]; canWrite: boolean }) {
  const { t } = useTranslation(["clinic", "common"]);
  const fmt = useFmt();
  const me = useMe();
  const errorText = useErrorText();
  const { add, update, remove } = usePatientNotes(id);
  const draft = useDraft<string>(`patient:${id}:note`, "");
  const [pinned, setPinned] = useState(false);
  const [gone, setGone] = useState<StaffNote | null>(null);
  const onError = (e: unknown) => toast.warn(errorText(e));
  const contacts = entries.filter((e) => e.kind.startsWith("contact"));
  return (
    <div className="record-cols">
      <Section title={t("record.staffNotes")}>
        <p className="mb-3 text-sm text-fg-2">{t("record.staffNotesBody")}</p>
        {canWrite && (
          <div className="mb-4 grid gap-2">
            <Field label={t("record.newNote")}>
              <Textarea rows={2} value={draft.value} maxLength={1000} onChange={(e) => draft.set(e.target.value)} />
            </Field>
            <span className="flex flex-wrap items-center justify-between gap-2">
              <Checkbox label={t("record.pin")} checked={pinned} onCheckedChange={(v) => setPinned(v === true)} />
              <Button
                size="sm"
                icon={<IconNote aria-hidden />}
                disabled={!draft.value.trim()}
                loading={add.isPending}
                onClick={() =>
                  add.mutate(
                    { body: draft.value.trim(), pinned },
                    {
                      onSuccess: () => {
                        void draft.clear();
                        setPinned(false);
                      },
                      onError,
                    },
                  )
                }
              >
                {t("record.addNote")}
              </Button>
            </span>
          </div>
        )}
        {notes.length === 0 ? (
          <p className="text-fg-2">{t("record.noNotes")}</p>
        ) : (
          <ul className="grid gap-2">
            {notes.map((n) => (
              <li key={n.id} className="staff-note" data-pinned={n.pinned}>
                <span className="min-w-0 flex-1">
                  <span className="block whitespace-pre-wrap wrap-any">{n.body}</span>
                  <span className="text-sm text-fg-2">
                    {personLabel(n.author)} {fmt.dateTime(n.created_at)}
                  </span>
                </span>
                {canWrite && (
                  <span className="flex flex-none">
                    <IconButton label={t(n.pinned ? "record.unpin" : "record.pinThis")} size="sm" onClick={() => update.mutate({ id: n.id, pinned: !n.pinned }, { onError })}>
                      {n.pinned ? <IconPinnedOff size={18} aria-hidden /> : <IconPin size={18} aria-hidden />}
                    </IconButton>
                    {samePerson(n.author, me) && (
                      <IconButton label={t("record.deleteNote")} size="sm" onClick={() => setGone(n)}>
                        <IconTrash size={18} aria-hidden />
                      </IconButton>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t("record.contactLog")}>
        {contacts.length === 0 ? (
          <p className="text-fg-2">{t("record.noContacts")}</p>
        ) : (
          <ul className="grid gap-2">
            {contacts.map((c, i) => (
              <li key={`${c.at}-${i}`} className="staff-note">
                {c.kind.includes("phone") ? <IconPhone size={18} className="mt-1 flex-none text-fg-3" aria-label={t("record.byPhone")} /> : <IconMessage size={18} className="mt-1 flex-none text-fg-3" aria-label={t("record.inApp")} />}
                <span className="min-w-0">
                  <span className="block whitespace-pre-wrap wrap-any">{c.title}</span>
                  <span className="text-sm text-fg-2">
                    {personLabel(c.actor)} {fmt.dateTime(c.at)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <ConfirmDialog
        open={gone !== null}
        onOpenChange={(o) => !o && setGone(null)}
        title={t("record.deleteTitle")}
        description={t("record.deleteBody")}
        confirmLabel={t("record.deleteNote")}
        destructive
        busy={remove.isPending}
        onConfirm={() => gone && remove.mutate(gone.id, { onSuccess: () => setGone(null), onError })}
      />
    </div>
  );
}
