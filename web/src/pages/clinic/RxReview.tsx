import { IconLock, IconPrinter, IconSend } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";

import { isApiError } from "@/api/errors";
import type { MedicationCard, RxItem, RxRequest } from "@/api/types";
import { staleRx, useAssignRx, useDecideRx, useDraft, useLeaveGuard, usePatient, useRx, useRxMessage, useRxQueue } from "@/data";
import { paths } from "@/lib/links";
import { allows, isOpenRx } from "@/lib/rx";
import { Badge, Banner, Button, ConfirmDialog, DescriptionList, Field, IconButton, PageBody, PageHeader, Panel, SaveState, Segmented, SkeletonRows, StatusTag, Textarea, Timeline, toast } from "@/ui";

import { personLabel, useErrorText, useFmt, useMinute } from "./lib";
import { AssignMenu, DueText, PageError, RoleNote, StaleBar, useDuties } from "./parts";
import { Allergies, MedicationList, PinnedNotes, ProfileItems } from "./patient/blocks";
import { Answers, Monitoring } from "./rx/answers";
import { ItemCard } from "./rx/ItemCard";
import { isOverride, itemProblem, requestOutcome, type ItemDraft } from "./rx/decision";

interface DecisionDraft {
  items: Record<string, ItemDraft>;
  note: string;
  message: string;
  /** Revision of the request the decision was started on. */
  base: number;
}
const EMPTY: ItemDraft = { outcome: null, note: "" };

export default function RxReview() {
  const { id = "" } = useParams();
  const { t } = useTranslation("clinic");
  const query = useRx(id);
  const back = { to: paths.clinic.rxQueue(), label: t("rx.back") };
  if (!query.data)
    return (
      <PageBody>
        {query.isError ? (
          <PageError error={query.error} onRetry={() => void query.refetch()} back={back} />
        ) : (
          <>
            <PageHeader title={t("rx.reviewTitle")} back={back} />
            <SkeletonRows rows={8} />
          </>
        )}
      </PageBody>
    );
  return (
    <>
      <StaleBar query={query} />
      <Review key={id} rx={query.data} />
    </>
  );
}

function Review({ rx }: { rx: RxRequest }) {
  const { t } = useTranslation(["clinic", "rx", "common"]);
  const fmt = useFmt();
  const now = useMinute();
  const errorText = useErrorText();
  const duties = useDuties();
  const record = usePatient(rx.patient.id);
  const assign = useAssignRx();
  const meds = record.data?.medications ?? [];
  const ids = new Set(rx.items.map((i) => i.prescription_id));
  const deciding = allows(rx, "decide") && duties.decide;
  const row = record.data?.row;
  return (
    <PageBody width="full" className="pb-0">
      <PageHeader
        back={{ to: paths.clinic.rxQueue(), label: t("rx.back") }}
        title={
          <>
            <Link to={paths.clinic.patient(rx.patient.id)} className="link" data-quiet="true">
              {rx.patient.display_name}
            </Link>
            <span className="ms-3 text-base font-medium text-fg-2">{[row?.age == null ? null : t("patient.age", { n: row.age }), row?.sex ? t(`patient.sex.${row.sex}`) : null, t(`rx:kind.${rx.kind}`)].filter(Boolean).join(t("patient.dot"))}</span>
          </>
        }
        meta={
          <>
            <span className="num">{rx.no}</span>
            <StatusTag family="rx" status={rx.status} />
            {rx.priority !== "routine" && <StatusTag family="urgency" status={rx.priority} />}
            {isOpenRx(rx.status) && <DueText at={rx.sla_due_at} kind="deadline" now={now} stopped={rx.status !== "in_review" && rx.status !== "submitted"} />}
          </>
        }
        actions={
          <>
            {duties.decide && !deciding && <NextRequest current={rx.id} />}
            {allows(rx, "assign") && <AssignMenu value={rx.assigned_to} busy={assign.isPending} onAssign={(account) => assign.mutate({ id: rx.id, account }, { onError: (e) => toast.warn(errorText(e)) })} />}
            <IconButton label={t("desk.print")} variant="bordered" size="sm" className="no-print" onClick={() => window.print()}>
              <IconPrinter size={20} aria-hidden />
            </IconButton>
          </>
        }
      />
      {rx.priority === "urgent" && isOpenRx(rx.status) && (
        <Banner tone="danger" role="note" className="mb-stack" title={t("rx.urgentTitle")}>
          {t("rx.urgentBody")}
        </Banner>
      )}
      <div className="rx-layout">
        <div className="grid min-w-0 content-start gap-5">
          {rx.engine && (
            <Panel title={t("rx.engine")} meta={<StatusTag family="disposition" status={rx.engine.disposition} />}>
              <p>{rx.engine.summary}</p>
              <p className="mt-2 text-sm text-fg-2">
                {t("rx.notApproval")} {t("rx.engineMeta", { version: rx.engine.protocol_version, time: fmt.dateTime(rx.engine.evaluated_at) })}{" "}
                <Link to="/clinic/rules?tab=protocols" className="link">
                  {t("rx.protocol")}
                </Link>
              </p>
            </Panel>
          )}
          {deciding ? <Decide rx={rx} meds={meds} /> : <ReadOnlyItems rx={rx} meds={meds} canDecide={duties.decide} />}
          {rx.kind === "renewal" && (
            <Panel title={t("rx.answers")}>
              <Answers rx={rx} />
            </Panel>
          )}
          <Panel title={t("rx.monitoring")}>
            <Monitoring rx={rx} readings={record.data?.measurements} />
          </Panel>
        </div>
        <aside className="grid min-w-0 content-start gap-5" aria-label={t("desk.paneContext")}>
          <Panel title={t("rx.patient")}>
            {record.data ? (
              <div className="grid gap-4">
                <PinnedNotes notes={record.data.notes} />
                <section aria-label={t("desk.allergies")}>
                  <h3 className="mb-1 font-semibold">{t("desk.allergies")}</h3>
                  <Allergies profile={record.data.profile} />
                </section>
                <section aria-label={t("desk.conditions")}>
                  <h3 className="mb-1 font-semibold">{t("desk.conditions")}</h3>
                  <ProfileItems items={record.data.profile?.conditions} empty={t("record.noConditions")} />
                </section>
                <section aria-label={t("rx.otherMeds")}>
                  <h3 className="mb-1 font-semibold">{t("rx.otherMeds")}</h3>
                  <MedicationList items={meds.filter((m) => !ids.has(m.prescription_id))} compact />
                </section>
              </div>
            ) : record.isError ? (
              <p className="text-fg-2">{errorText(record.error)}</p>
            ) : (
              <SkeletonRows rows={4} />
            )}
          </Panel>
          <Panel title={t("rx.request")}>
            <DescriptionList
              items={[
                { label: t("rx.sentAt"), value: rx.submitted_at && <span className="num">{fmt.dateTime(rx.submitted_at)}</span> },
                { label: t("rx.pharmacy"), value: rx.pharmacy ? `${rx.pharmacy.name}${t("patient.dot")}${rx.pharmacy.district}` : t("rx.noPharmacy") },
                ...(rx.pickup_window ? [{ label: t("rx.pickup"), value: `${fmt.date(rx.pickup_window.date)} ${t(`rx:pickupSlot.${rx.pickup_window.slot}`)}` }] : []),
                ...(rx.decision_note ? [{ label: t("rx.internalNote"), value: <span className="whitespace-pre-wrap">{rx.decision_note}</span> }] : []),
              ]}
            />
          </Panel>
          <Messages rx={rx} />
          <Panel title={t("rx.timeline")}>
            <Timeline
              label={t("rx.timeline")}
              items={[...rx.timeline].reverse().map((e, i) => ({
                id: `${e.at}-${i}`,
                time: fmt.stamp(e.at),
                dateTime: e.at,
                what: e.text,
                who: personLabel(e.actor) || undefined,
                detail: e.visibility === "staff" ? <Badge icon={<IconLock aria-hidden />}>{t("rx.staffOnly")}</Badge> : undefined,
              }))}
            />
          </Panel>
        </aside>
      </div>
    </PageBody>
  );
}

const medOf = (meds: MedicationCard[], i: RxItem) => meds.find((m) => m.prescription_id === i.prescription_id);

function ReadOnlyItems({ rx, meds, canDecide }: { rx: RxRequest; meds: MedicationCard[]; canDecide: boolean }) {
  const { t } = useTranslation(["clinic", "rx"]);
  return (
    <>
      <RoleNote>{canDecide ? t("rx.notNow", { status: t(`rx:status.${rx.status}`) }) : t("rx.physicianDecides")}</RoleNote>
      {rx.items.map((i, n) => (
        <ItemCard key={i.id} rx={rx} item={i} n={n + 1} med={medOf(meds, i)} draft={null} problem={null} showProblem={false} />
      ))}
    </>
  );
}

/** Decisions per item, kept as a draft until they are sent together. */
function Decide({ rx, meds }: { rx: RxRequest; meds: MedicationCard[] }) {
  const { t } = useTranslation(["clinic", "rx", "common"]);
  const fmt = useFmt();
  const errorText = useErrorText();
  const draft = useDraft<DecisionDraft | null>(`rx:${rx.id}:decision`, null);
  const decide = useDecideRx(rx.id);
  const [show, setShow] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [moved, setMoved] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});

  const d: DecisionDraft = draft.value ?? { items: {}, note: "", message: "", base: rx.revision };
  const set = (part: Partial<DecisionDraft>) => {
    setFields({});
    draft.set((v) => ({ ...(v ?? { items: {}, note: "", message: "", base: rx.revision }), ...part }));
  };
  useLeaveGuard(`rx:${rx.id}`, draft.dirty);
  // Something changed since the decision was started (a reply, a pharmacist's question): say so before it is sent.
  const changed = draft.value !== null && d.base !== rx.revision;
  useEffect(() => setMoved((m) => m || changed), [changed]);

  const item = (i: RxItem) => d.items[i.id] ?? EMPTY;
  const outcomes = rx.items.map((i) => item(i).outcome);
  const issue = rx.items.map((i) => itemProblem(i, d.items[i.id], d.message, rx.pharmacy !== null));
  const decided = outcomes.filter(Boolean).length;
  const result = requestOutcome(outcomes);
  const overrides = rx.items.filter((i) => isOverride(i, item(i).outcome));
  const review = () => {
    setShow(true);
    const first = issue.findIndex(Boolean);
    if (first >= 0) {
      const el = document.getElementById(`rx-item-${rx.items[first].id}`);
      el?.scrollIntoView({ block: "start" });
      el?.querySelector<HTMLElement>("[role=radio],textarea")?.focus();
    } else setConfirm(true);
  };
  const send = async () => {
    try {
      const after = await decide.mutateAsync({
        revision: rx.revision,
        items: rx.items.map((i) => ({ item_id: i.id, outcome: item(i).outcome!, note: item(i).note.trim() || null })),
        note: d.note.trim() || null,
        patient_message: d.message.trim() || null,
      });
      await draft.clear();
      toast.ok(t("rx.sent", { no: rx.no, status: t(`rx:status.${after.status}`) }));
    } catch (e) {
      setConfirm(false);
      if (staleRx(e)) setMoved(true);
      else if (isApiError(e) && e.hasFields) {
        const byItem: Record<string, string> = {};
        for (const [k, m] of Object.entries(e.fields)) byItem[k.replace(/^items\./, "")] = m;
        setFields(byItem);
        setShow(true);
      } else toast.warn(errorText(e));
    }
  };

  if (!draft.ready) return <SkeletonRows rows={6} />;
  return (
    <div className="grid gap-5">
      {moved && changed && (
        <Banner
          tone="warn"
          title={t("rx.movedTitle")}
          role="alert"
          actions={
            <Button size="sm" onClick={() => { set({ base: rx.revision }); setMoved(false); }}>
              {t("rx.movedOk")}
            </Button>
          }
        >
          {t("rx.movedBody", { time: fmt.stamp(rx.updated_at) })}
        </Banner>
      )}
      {draft.conflict && (
        <Banner
          tone="warn"
          title={t("note.deviceTitle")}
          actions={
            <>
              <Button size="sm" onClick={() => draft.resolve("mine")}>{t("rx.keepMine")}</Button>
              <Button size="sm" onClick={() => draft.resolve("theirs")}>{t("rx.useOther")}</Button>
            </>
          }
        >
          {t("rx.deviceBody")}
        </Banner>
      )}
      {rx.items.map((i, n) => (
        <ItemCard key={i.id} rx={rx} item={i} n={n + 1} med={medOf(meds, i)} draft={item(i)} onDraft={(x) => set({ items: { ...d.items, [i.id]: x } })} problem={issue[n]} showProblem={show} serverError={fields[i.id]} />
      ))}
      <Panel title={t("rx.toPatient")}>
        <div className="grid gap-4">
          <Field label={t("rx.message")} hint={t("rx.messageHint")} optional>
            <Textarea rows={4} value={d.message} onChange={(e) => set({ message: e.target.value })} />
          </Field>
          <Preview rx={rx} d={d} result={result} />
          <Field label={t("rx.internalNote")} hint={t("rx.internalHint")} optional>
            <Textarea rows={2} value={d.note} onChange={(e) => set({ note: e.target.value })} />
          </Field>
        </div>
      </Panel>
      <div className="decide-bar no-print">
        <span role="status" className="min-w-0">
          <span className="num font-semibold">{t("rx.progress", { done: decided, total: rx.items.length })}</span>
          <span className="block text-sm text-fg-2">{result ? t(`rx.result.${result}`, { pharmacy: rx.pharmacy?.name ?? "" }) : t("rx.resultNone")}</span>
        </span>
        <span className="ms-auto inline-flex items-center gap-3">
          {draft.value && <SaveState state={draft.conflict ? "conflict" : draft.status === "offline" ? "offline" : draft.status === "saving" ? "saving" : "saved"} savedAt={draft.savedAt ? fmt.time(draft.savedAt) : undefined} />}
          <Button variant="primary" icon={<IconSend aria-hidden />} loading={decide.isPending} onClick={review}>
            {t("rx.send")}
          </Button>
        </span>
      </div>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={t("rx.confirmTitle", { no: rx.no, name: rx.patient.display_name })} description={result ? t(`rx.result.${result}`, { pharmacy: rx.pharmacy?.name ?? "" }) : ""} confirmLabel={t("rx.confirmSend")} busy={decide.isPending} onConfirm={() => void send()}>
        <ul className="divide-y divide-rule">
          {rx.items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{fmt.locale === "en" ? i.drug.name_en : i.drug.name_zh}</span>
              {item(i).outcome && <StatusTag family="outcome" status={item(i).outcome!} />}
              {overrides.includes(i) && <span className="basis-full text-sm text-fg-2">{t("rx.overrideLine", { note: item(i).note })}</span>}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-fg-2">{t("rx.confirmNote")}</p>
      </ConfirmDialog>
    </div>
  );
}

/** The patient's view of this decision, in their words and order. */
function Preview({ rx, d, result }: { rx: RxRequest; d: DecisionDraft; result: ReturnType<typeof requestOutcome> }) {
  const { t } = useTranslation(["clinic", "rx"]);
  const fmt = useFmt();
  if (!result) return null;
  return (
    <div className="preview-card" aria-label={t("rx.preview")}>
      <p className="mb-2 text-sm text-fg-2">{t("rx.preview")}</p>
      <p className="font-semibold">{t(`rx:status.${result}`)}</p>
      <p className="text-fg-2">{t(`rx:statusHint.${result}`)}</p>
      <ul className="mt-2 grid gap-1">
        {rx.items.map((i) => {
          const x = d.items[i.id];
          return (
            <li key={i.id}>
              {fmt.locale === "en" ? i.drug.name_en : i.drug.name_zh}
              {x?.outcome && <StatusTag family="outcome" status={x.outcome} plain className="ms-2" />}
              {x?.outcome && x.outcome !== "approve" && x.note.trim() && <span className="block whitespace-pre-wrap text-fg-2">{x.note.trim()}</span>}
            </li>
          );
        })}
      </ul>
      {d.message.trim() && <p className="mt-2 whitespace-pre-wrap border-t border-rule pt-2">{d.message.trim()}</p>}
    </div>
  );
}

function Messages({ rx }: { rx: RxRequest }) {
  const { t } = useTranslation(["clinic", "errors"]);
  const fmt = useFmt();
  const errorText = useErrorText();
  const send = useRxMessage(rx.id);
  const [visibility, setVisibility] = useState<"all" | "staff">("staff");
  const draft = useDraft<string>(`rx:${rx.id}:message`, "");
  const open = allows(rx, "message");
  const staffOnly = rx.allowed_actions.includes("staff_message") || open;
  const list = rx.messages;
  const submit = () => {
    if (!draft.value.trim()) return;
    send.mutate({ body: draft.value.trim(), visibility: open ? visibility : "staff" }, { onSuccess: () => void draft.clear(), onError: (e) => toast.warn(errorText(e)) });
  };
  return (
    <Panel title={t("rx.messages")}>
      {list.length === 0 ? (
        <p className="text-fg-2">{t("rx.noMessages")}</p>
      ) : (
        <ul className="grid gap-2">
          {list.map((m) => (
            <li key={m.id} className="staff-note" data-visibility={m.visibility}>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-x-2 text-sm text-fg-2">
                  <span className="font-semibold text-fg">{personLabel(m.author)}</span>
                  <span className="num">{fmt.stamp(m.created_at)}</span>
                  {m.visibility === "staff" && <Badge icon={<IconLock aria-hidden />}>{t("rx.staffOnly")}</Badge>}
                </span>
                <span className="block whitespace-pre-wrap wrap-any">{m.body}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {staffOnly && (
        <div className="no-print mt-4 grid gap-2">
          {open && (
            <Segmented
              label={t("rx.who")}
              value={visibility}
              onValueChange={(v) => setVisibility(v as "all" | "staff")}
              options={[
                { value: "staff", label: t("rx.staffOnly") },
                { value: "all", label: t("rx.patientToo") },
              ]}
            />
          )}
          <Field label={t("rx.newMessage")} hideLabel>
            <Textarea rows={2} value={draft.value} onChange={(e) => draft.set(e.target.value)} placeholder={t(visibility === "all" && open ? "rx.writePatient" : "rx.writeTeam")} />
          </Field>
          <Button size="sm" className="justify-self-end" loading={send.isPending} disabled={!draft.value.trim()} onClick={submit}>
            {t(visibility === "all" && open ? "rx.sendPatient" : "rx.sendTeam")}
          </Button>
        </div>
      )}
    </Panel>
  );
}

/** After a decision: the first request that still waits. */
function NextRequest({ current }: { current: string }) {
  const { t } = useTranslation("clinic");
  const navigate = useNavigate();
  const queue = useRxQueue();
  const next = queue.items.find((r) => r.id !== current && (r.status === "in_review" || r.status === "submitted"));
  if (!next) return null;
  return (
    <Button variant="soft" onClick={() => void navigate(paths.clinic.rx(next.id))}>
      {t("desk.next", { name: next.patient.display_name })}
    </Button>
  );
}
