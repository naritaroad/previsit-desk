// Whole screens built from the kit: the visual reference for page engineers. Static.

import { IconCheck, IconClock, IconFileText, IconMessageQuestion, IconPhone, IconPlus, IconPrinter, IconSend, IconUserPlus } from "@tabler/icons-react";
import { useState } from "react";

import { AdminShell } from "@/shells/AdminShell";
import { ClinicShell } from "@/shells/ClinicShell";
import { ConversationLink, PatientRail, PatientShell, useFullHeight } from "@/shells/PatientShell";
import { PharmacyShell } from "@/shells/PharmacyShell";
import { PublicShell } from "@/shells/PublicShell";
import { FillPage } from "@/shells/StaffShell";
import { AssistantBubble, Badge, Banner, Button, ButtonLink, Checkbox, Composer, DataTable, DayDivider, DescriptionList, DocLayout, DocumentMeta, EvidenceLine, EvidenceList, EvidenceTable, FieldGroup, FilterBar, FootnoteRef, Footnotes, FormSheet, Ledger, MarginNote, NoteField, NoteSheet, NoticeLine, NumberField, OpeningNote, PageBody, PageHeader, Panel, PatientBubble, Person, Photo, Phrases, PresenceLine, Prose, ProseSection, QuickReplies, RadioRows, RefillStrip, SaveState, SearchInput, Section, Segmented, Select, SplitPane, StaffBubble, StatusTag, StepForm, Stepper, TableOfContents, TextLink, Timeline, Transcript } from "@/ui";
import { MeasurementChart } from "@/ui/measurement-chart";

import { accounts, bp, chen, convos, hsu, meds, pharmacyQueue, refills, TODAY, worklist } from "./fixtures";
import { X } from "./scene-text";
import { T } from "./text";

const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "");

/* ---------- public ---------- */

function PublicHome() {
  return (
    <>
      <section className="site-wrap hero">
        <div className="hero-text">
          <h1 tabIndex={-1}>
            <Phrases text={X.hero} />
          </h1>
          <p>{X.heroLede}</p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <ButtonLink to="/try" variant="primary" size="lg">
              {X.heroCta}
            </ButtonLink>
            <TextLink to="/trust" className="text-md">
              {X.heroLink}
            </TextLink>
          </div>
        </div>
        <div className="hero-photos">
          <Photo slot="medicine_table" ratio="auto" priority sizes="(min-width: 64rem) 38vw, 66vw" />
          <p>{X.heroCaption}</p>
          <Photo slot="consultation" ratio="3 / 4" priority decorative sizes="(min-width: 64rem) 18vw, 30vw" />
        </div>
      </section>
      <section className="site-wrap">
        <div className="strip-feature">
          <div>
            <h2>
              <Phrases text={X.stripTitle} />
            </h2>
            <p>{X.stripBody}</p>
          </div>
          <RefillStrip med={refills.open} today={TODAY} />
        </div>
      </section>
      <section className="site-wrap">
        <ol className="three-acts">
          {X.acts.map((a) => (
            <li key={a.when}>
              <p className="when">{a.when}</p>
              <div>
                <h2>{a.title}</h2>
                <p>{a.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      <section className="photo-band">
        <Photo slot="waiting" ratio="21 / 9" sizes="100vw" caption={<span className="site-wrap block">{X.bandCaption}</span>} />
      </section>
      <section className="site-wrap not-list">
        <h2>{X.notTitle}</h2>
        <ul>
          {X.nots.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>
    </>
  );
}
export function PublicScene() {
  return (
    <PublicShell>
      <PublicHome />
    </PublicShell>
  );
}

export function TrustScene() {
  return (
    <PublicShell>
      <div className="site-wrap site-page">
        <DocLayout toc={<TableOfContents items={X.toc} />}>
          <Prose>
            <h1 tabIndex={-1}>{X.trustTitle}</h1>
            <DocumentMeta items={T.docMeta} />
            <p className="lede">{X.trustLede}</p>
            <div className="mt-16">
              {X.trust.map((s, i) => (
                <ProseSection key={s.id} id={s.id} no={s.no} title={s.title}>
                  {i === 0 && <MarginNote>{X.margin}</MarginNote>}
                  <p>
                    {s.p1}
                    <FootnoteRef n={i + 1} />
                  </p>
                  <p>{s.p2}</p>
                  {i === 0 && (
                    <ul>
                      {X.nots.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  )}
                  {i === 1 && <EvidenceTable caption={T.evidence} rows={T.evidenceRows} />}
                </ProseSection>
              ))}
            </div>
            <Footnotes items={X.notes.map((content, i) => ({ n: i + 1, content }))} />
          </Prose>
        </DocLayout>
      </div>
    </PublicShell>
  );
}

/* ---------- patient ---------- */

function Convos() {
  return (
    <PatientRail>
      <div className="rail-convos">
        <SearchInput value="" onValueChange={() => {}} placeholder={X.searchConvo} className="mb-2" />
        {convos.map((c) => (
          <ConversationLink key={c.id} to={`/app/visits/${c.id}`} title={c.title} time={c.time} unread={c.unread} status={<StatusTag family="visit" status={c.status} plain />} />
        ))}
      </div>
    </PatientRail>
  );
}

export function PatientHomeScene() {
  return (
    <PatientShell counts={{ messages: 2 }}>
      <Convos />
      <PageBody>
        <PageHeader title={X.hello} lede={X.helloLede} />
        <div className="next-visit">
          <div className="date num" aria-hidden="true">
            <span>{X.nvMonth}</span>
            <b>26</b>
            <span>{X.nvDay}</span>
          </div>
          <div className="min-w-0">
            <p className="num text-xl font-bold">{X.nvTime}</p>
            <p>{X.nvWho}</p>
            <p className="text-fg-2">{X.nvTask}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <ButtonLink to="/app/visits/v1" variant="primary">
              {X.nvCta}
            </ButtonLink>
            <ButtonLink to="/app/appointments">{X.nvChange}</ButtonLink>
          </div>
        </div>
        <Section title={X.medTitle} actions={<TextLink to="/app/medications">{X.medAll}</TextLink>}>
          <div className="grid gap-4">
            {meds.slice(0, 2).map((m) => (
              <Panel key={m.name} title={m.name} meta={m.dose} actions={m.refill.state === "window_open" ? <Button variant="soft">{X.medCta}</Button> : undefined}>
                <RefillStrip med={m.refill} today={TODAY} />
              </Panel>
            ))}
          </div>
        </Section>
        <Section title={X.reqTitle}>
          <Panel flush>
            <DataTable
              caption={X.reqTitle}
              rows={X.requests}
              rowKey={(r) => r.no}
              rowLink={() => "/app/rx/1"}
              columns={[
                { id: "w", header: X.hWhat, cell: (r) => r.what, card: "title" },
                { id: "s", header: X.hStatus, cell: (r) => <StatusTag family="rx" status={r.status} />, card: "end" },
                { id: "n", header: X.hNext, cell: (r) => r.next },
              ]}
            />
          </Panel>
        </Section>
      </PageBody>
    </PatientShell>
  );
}

function Chat() {
  useFullHeight();
  const [v, setV] = useState("");
  return (
    <>
      <header className="chat-head">
        <div className="min-w-0">
          <h1 tabIndex={-1}>{X.chatTitle}</h1>
          <p className="num">{X.chatMeta}</p>
        </div>
        <Button size="sm" icon={<IconFileText aria-hidden />}>
          {X.chatSummary}
        </Button>
      </header>
      <Transcript label={X.chatTitle} follow={1}>
        <OpeningNote>{X.opening}</OpeningNote>
        <DayDivider>{X.day}</DayDivider>
        <AssistantBubble time="14:02">{X.m1}</AssistantBubble>
        <PatientBubble time="14:03">{X.m2}</PatientBubble>
        <AssistantBubble time="14:03">{X.m3}</AssistantBubble>
        <PatientBubble time="14:05">{X.m4}</PatientBubble>
        <NoticeLine>{X.notice}</NoticeLine>
        <StaffBubble name={hsu.display_name} title={hsu.title} time="14:08">
          {X.m5}
        </StaffBubble>
        <PatientBubble state="queued">{X.m6}</PatientBubble>
        <AssistantBubble streaming>{X.m7}</AssistantBubble>
      </Transcript>
      <div className="px-4 pb-1">
        <div className="mx-auto max-w-[46rem]">
          <QuickReplies label={X.quickLabel} options={X.quick} onPick={setV} />
        </div>
      </div>
      <Composer value={v} onValueChange={setV} onSend={() => setV("")} label={X.composer} placeholder={X.composer} draft="saved" max={500} accessory={<span className="text-sm text-fg-3">{X.composerNote}</span>} />
    </>
  );
}
export function ChatScene() {
  return (
    <PatientShell counts={{ messages: 2 }}>
      <Convos />
      <Chat />
    </PatientShell>
  );
}

export function WizardScene() {
  const [a, setA] = useState<string | undefined>("y");
  const [b, setB] = useState<string | undefined>();
  const [s, setS] = useState<number | null>(134);
  return (
    <PatientShell>
      <PageBody className="h-full pb-0">
        <StepForm
          stepper={<Stepper label={T.steps} steps={T.stepNames.map((label, i) => ({ id: String(i), label, state: i < 2 ? "done" : i === 2 ? "current" : "todo" }))} onStep={() => {}} />}
          title={X.wizTitle}
          lede={X.wizLede}
          back={<Button>{X.wizBack}</Button>}
          saveState={<SaveState state="saved" savedAt="14:32" />}
          next={<Button variant="primary">{X.wizNext}</Button>}
          aside={<FormSheet title={X.wizDrug} items={X.wizDrugItems} />}
        >
          <FieldGroup label={X.q1}>
            <RadioRows
              label={X.q1}
              columns={2}
              value={a}
              onValueChange={setA}
              options={[
                { value: "y", label: X.yes },
                { value: "n", label: X.no },
              ]}
            />
          </FieldGroup>
          <FieldGroup label={X.q2} hint={X.q2Hint} error={X.q2Err}>
            <RadioRows label={X.q2} value={b} onValueChange={setB} options={X.q2Options} />
          </FieldGroup>
          <FieldGroup label={T.fBp} hint={T.fBpHint}>
            <div className="grid grid-cols-2 gap-3">
              <NumberField aria-label={T.sys} value={s} onValueChange={setS} unit="mmHg" />
              <NumberField aria-label={T.dia} value={83} onValueChange={() => {}} unit="mmHg" />
            </div>
          </FieldGroup>
        </StepForm>
      </PageBody>
    </PatientShell>
  );
}

/* ---------- clinic ---------- */

export function WorklistScene() {
  const [bucket, setBucket] = useState("all");
  const [sel, setSel] = useState<Set<string>>(new Set());
  return (
    <ClinicShell counts={{ worklist: 8, urgent: 1, rx: 3, tickets: 1 }}>
      <FillPage
        head={
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-pane py-3">
            <h1 className="page-title" tabIndex={-1}>
              {T.worklist}
            </h1>
            <Segmented label={T.bucket} value={bucket} onValueChange={setBucket} options={X.buckets} />
            <span className="ms-auto text-sm text-fg-2">{X.clinicDay}</span>
          </div>
        }
      >
        <div className="flex h-full flex-col bg-surface">
          <FilterBar search={<SearchInput value="" onValueChange={() => {}} placeholder={T.fSearch} />} chips={[{ key: "t", label: X.chip, onRemove: () => {} }]} onClearAll={() => {}} end={<Button size="sm" icon={<IconUserPlus aria-hidden />} disabled={sel.size === 0}>{X.assign}</Button>}>
            <Select size="sm" label={T.hAssigned} value="all" onValueChange={() => {}} options={X.assignees} />
          </FilterBar>
          <DataTable
            className="min-h-0 flex-1 overflow-auto"
            caption={T.worklist}
            rows={worklist}
            rowKey={(r) => r.id}
            rowLink={() => "/dev/kit/scene/review"}
            isUrgent={(r) => r.urgency === "urgent"}
            selection={{ selected: sel, onChange: setSel }}
            total={worklist.length}
            columns={[
              { id: "u", header: T.hUrgency, cell: (r) => <StatusTag family="urgency" status={r.urgency} />, card: "end", width: "7rem", sortValue: (r) => ["urgent", "soon", "routine"].indexOf(r.urgency) },
              { id: "p", header: T.hPatient, cell: (r) => <span className="font-semibold">{r.patient.display_name}</span>, sortValue: (r) => r.patient.display_name, card: "title", width: "13rem" },
              {
                id: "t",
                header: T.hTitle,
                cell: (r) => (
                  <>
                    <span className="block">{r.title}</span>
                    <span className="block text-sm text-fg-2">{r.subtitle}</span>
                  </>
                ),
              },
              { id: "k", header: X.hKind, cell: (r) => X.kind[r.type], hideBelow: "lg", width: "6rem" },
              { id: "s", header: X.hStatus, cell: (r) => <StatusTag family={r.type === "rx" ? "rx" : r.type === "ticket" ? "ticket" : "visit"} status={r.status} />, width: "9rem" },
              { id: "a", header: T.hAssigned, cell: (r) => r.assigned_to?.display_name ?? <span className="text-fg-3">{T.none}</span>, hideBelow: "lg", width: "7rem" },
              { id: "d", header: T.hDue, cell: (r) => hhmm(r.due_at), align: "end", sortValue: (r) => r.due_at, nowrap: true, width: "5rem" },
            ]}
          />
        </div>
      </FillPage>
    </ClinicShell>
  );
}

export function ReviewScene() {
  const [note, setNote] = useState({ a: "", p: "", m: "" });
  return (
    <ClinicShell counts={{ worklist: 8, urgent: 1, rx: 3, tickets: 1 }}>
      <FillPage
        head={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-pane py-2.5">
            <h1 tabIndex={-1} className="text-lg font-bold">
              {X.patientLine}
            </h1>
            <StatusTag family="visit" status="submitted" />
            <span className="num text-sm text-fg-2">{X.patientMeta}</span>
            <span className="ms-auto flex flex-wrap items-center gap-3">
              <PresenceLine people={[{ name: hsu.display_name, title: hsu.title }]} />
              <SaveState state="saved" savedAt="14:32" />
              <Button size="sm" icon={<IconPrinter aria-hidden />}>
                {T.print}
              </Button>
              <Button size="sm" variant="primary" icon={<IconCheck aria-hidden />}>
                {X.sign}
              </Button>
            </span>
          </div>
        }
      >
        <SplitPane
          storageKey="gallery-review"
          initial={[25, 40, 35]}
          panes={[
            {
              id: "ctx",
              label: X.paneContext,
              content: (
                <div className="min-h-full bg-surface p-pane">
                  <Section title={X.ctxProfile}>
                    <DescriptionList items={T.detail} />
                  </Section>
                  <Section title={X.ctxMeds}>
                    <ul className="divide-y divide-rule">
                      {meds.map((m) => (
                        <li key={m.name} className="flex items-center justify-between gap-3 py-2">
                          <span className="min-w-0">
                            <span className="block font-medium">{m.name}</span>
                            <span className="block text-sm text-fg-2">{m.dose}</span>
                          </span>
                          <RefillStrip med={m.refill} today={TODAY} size="compact" />
                        </li>
                      ))}
                    </ul>
                  </Section>
                  <Section title={T.bpTitle}>
                    <MeasurementChart kind="bp" items={bp} height={170} />
                  </Section>
                </div>
              ),
            },
            {
              id: "so",
              label: X.paneSO,
              content: (
                <div className="p-pane">
                  <Banner tone="info" role="note">
                    {X.aiNote}
                  </Banner>
                  <Section title={X.sTitle}>
                    <EvidenceList>
                      {X.sLines.map((l) => (
                        <EvidenceLine key={l.text} at={l.at} onEdit={() => {}} onRestore={() => {}} edited={l.edited}>
                          {l.text}
                        </EvidenceLine>
                      ))}
                    </EvidenceList>
                  </Section>
                  <Section title={X.oTitle}>
                    <Ledger items={X.oItems} />
                  </Section>
                  <Section title={X.askTitle}>
                    <EvidenceList>
                      {X.asks.map((l) => (
                        <EvidenceLine key={l} missing>
                          {l}
                        </EvidenceLine>
                      ))}
                    </EvidenceList>
                  </Section>
                </div>
              ),
            },
            {
              id: "ap",
              label: X.paneAP,
              content: (
                <NoteSheet
                  title={X.apTitle}
                  author={X.apAuthor}
                  status={<StatusTag family="note" status="draft" />}
                  footer={
                    <>
                      <Button icon={<IconMessageQuestion aria-hidden />}>{T.dlgTitle}</Button>
                      <Button icon={<IconPhone aria-hidden />}>{X.call}</Button>
                      <Button icon={<IconClock aria-hidden />}>{X.visit}</Button>
                    </>
                  }
                >
                  <NoteField mark="A" label={X.aTitle} placeholder={X.aHint} rows={5} value={note.a} onValueChange={(a) => setNote({ ...note, a })} />
                  <NoteField mark="P" label={X.pTitle} placeholder={X.pHint} rows={5} value={note.p} onValueChange={(p) => setNote({ ...note, p })} />
                  <NoteField tone="patient" label={X.msgTitle} hint={X.msgHint} rows={3} value={note.m} onValueChange={(m) => setNote({ ...note, m })} />
                </NoteSheet>
              ),
            },
          ]}
        />
      </FillPage>
    </ClinicShell>
  );
}

/* ---------- pharmacy ---------- */

const COUNTS = { check: 4, prepare: 2, ready: 6, returned: 0, done: 11 };

export function PharmacyScene() {
  return (
    <PharmacyShell counts={COUNTS}>
      <FillPage
        head={
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-pane py-3">
            <h1 className="page-title" tabIndex={-1}>
              {X.phTitle}
            </h1>
            <SearchInput value="" onValueChange={() => {}} placeholder={X.phSearch} className="max-w-xs" />
            <span className="ms-auto text-sm text-fg-2">{X.phName}</span>
          </div>
        }
      >
        <div className="h-full bg-surface">
          <DataTable
            caption={X.phTitle}
            rows={pharmacyQueue}
            rowKey={(r) => r.id}
            rowLink={() => "/dev/kit/scene/dispense"}
            columns={[
              { id: "no", header: X.hNo, cell: (r) => <span className="num font-semibold">{r.no}</span>, nowrap: true, width: "12rem", card: "title" },
              { id: "p", header: T.hPatient, cell: (r) => <span className="text-base font-semibold">{r.patient.display_name}</span>, width: "9rem" },
              { id: "d", header: X.hDrug, cell: (r) => r.drug_names.join("、") },
              { id: "k", header: X.hKind, cell: (r) => <Badge tone={r.kind === "refill" ? "ink" : "info"}>{X.rxKind[r.kind]}</Badge>, width: "8rem", card: "end" },
              { id: "a", header: X.hRph, cell: (r) => r.assigned_to?.display_name ?? <span className="text-fg-3">{T.none}</span>, width: "7rem" },
              { id: "t", header: X.hSent, cell: (r) => hhmm(r.submitted_at), align: "end", width: "5rem", sortValue: (r) => r.submitted_at },
              { id: "go", header: <span className="sr-only">{X.hAct}</span>, cell: () => <Button size="sm" variant="soft">{X.phStart}</Button>, width: "8rem", align: "end", card: "hide" },
            ]}
          />
        </div>
      </FillPage>
    </PharmacyShell>
  );
}

export function DispenseScene() {
  const [ok, setOk] = useState<Record<string, boolean>>({ identity: true, allergy: true });
  return (
    <PharmacyShell counts={COUNTS}>
      <PageBody>
        <PageHeader back={{ to: "/dev/kit/scene/pharmacy", label: X.phTitle }} title={X.dpTitle} meta={<StatusTag family="rx" status="at_pharmacy" />} actions={<Person name="林秀琴" detail={X.dpPatient} />} />
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
          <div className="grid content-start gap-5">
            <FormSheet title={T.sheetTitle} note="RX-20261125-0012" columns={2} items={T.sheetItems} />
            <Panel>
              <RefillStrip med={refills.open} today={TODAY} />
            </Panel>
          </div>
          <div className="grid content-start gap-5">
            <Panel title={X.dpCheck} footer={<div className="flex flex-wrap gap-2"><Button variant="primary" disabled={Object.values(ok).filter(Boolean).length < 4}>{X.dpDispense}</Button><Button>{X.dpReturn}</Button><Button variant="quiet">{X.dpAsk}</Button></div>}>
              {X.checks.map((c) => (
                <Checkbox key={c.id} label={c.label} hint={c.hint} checked={ok[c.id] ?? false} onCheckedChange={(v) => setOk({ ...ok, [c.id]: v === true })} />
              ))}
            </Panel>
            <Panel title={T.timeline}>
              <Timeline label={T.timeline} items={T.timelineItems.slice(0, 3)} />
            </Panel>
          </div>
        </div>
      </PageBody>
    </PharmacyShell>
  );
}

/* ---------- admin ---------- */

export function AdminScene() {
  return (
    <AdminShell system={X.system}>
      <PageBody>
        <PageHeader title={X.accounts} actions={<Button variant="primary" icon={<IconPlus aria-hidden />}>{X.addAccount}</Button>} />
        <Panel flush>
          <FilterBar search={<SearchInput value="" onValueChange={() => {}} placeholder={X.searchAccount} />}>
            <Select size="sm" label={X.hRole} value="all" onValueChange={() => {}} options={X.roles} />
          </FilterBar>
          <DataTable
            caption={X.accounts}
            rows={accounts}
            rowKey={(r) => r.id}
            onRowOpen={() => {}}
            total={accounts.length}
            columns={[
              { id: "u", header: X.hUser, cell: (r) => <span className="font-semibold">{r.username}</span>, sortValue: (r) => r.username, card: "title" },
              { id: "n", header: X.hName, cell: (r) => r.display_name },
              { id: "r", header: X.hRole, cell: (r) => r.title ?? X.roleName[r.role], sortValue: (r) => r.role },
              { id: "s", header: X.hStatus, cell: (r) => <StatusTag family="account" status={r.status} />, card: "end" },
              { id: "l", header: X.hLast, cell: (r) => (r.last_login_at ? `${r.last_login_at.slice(5, 10).replace("-", "/")} ${hhmm(r.last_login_at)}` : <span className="text-fg-3">{X.never}</span>), nowrap: true, sortValue: (r) => r.last_login_at },
              { id: "c", header: X.hSessions, cell: (r) => r.sessions, align: "end", sortValue: (r) => r.sessions },
            ]}
          />
        </Panel>
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <Panel title={T.ledger}>
            <Ledger items={T.ledgerItems} />
          </Panel>
          <Panel title={X.auditTitle} actions={<Button size="sm" icon={<IconSend aria-hidden />}>{T.export}</Button>}>
            <Timeline label={X.auditTitle} items={X.audit} />
          </Panel>
        </div>
      </PageBody>
    </AdminShell>
  );
}
export const people = { chen, hsu };
