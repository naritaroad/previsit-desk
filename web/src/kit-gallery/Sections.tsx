import { IconArchive, IconCalendarPlus, IconCopy, IconDots, IconDownload, IconFileText, IconFilter, IconInbox, IconPencil, IconPin, IconPlus, IconPrinter, IconTrash } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";

import { Avatar, Badge, Banner, Button, ButtonLink, Callout, Checkbox, Combobox, CommandPalette, ConfirmDialog, CountBadge, DataTable, DateField, DescriptionList, Dialog, DiffMergeDialog, DocumentMeta, EmergencyButton, EmergencyPanel, EmptyState, ErrorState, EvidenceTable, ExternalLink, Field, FieldGroup, FilterBar, FormSheet, IconButton, Input, Kbd, Ledger, Menu, MenuItem, MenuSeparator, NativeSelect, NotificationList, NumberField, Panel, PasswordInput, Person, Photo, Popover, PresenceLine, Progress, RadioRows, RefillStrip, SaveState, SearchInput, Segmented, Select, Sheet, SkeletonRows, Spinner, StatusTag, Stepper, Switch, Tabs, TextLink, Textarea, Timeline, Tooltip, toast } from "@/ui";
import { MeasurementChart } from "@/ui/measurement-chart";

import { bp, chen, hsu, notifications, refills, TODAY, worklist, W } from "./fixtures";
import { T } from "./text";

function Block({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className="mb-14">
      <h2 className="mb-5 border-b-2 border-ink pb-1 text-xl font-bold text-ink-text">{title}</h2>
      <div className={className ?? "grid gap-6"}>{children}</div>
    </section>
  );
}
const Row = ({ children }: { children: ReactNode }) => <div className="flex flex-wrap items-center gap-3">{children}</div>;

export function Sections() {
  const [radio, setRadio] = useState("a");
  const [yn, setYn] = useState<string | undefined>();
  const [seg, setSeg] = useState("mine");
  const [sel, setSel] = useState<string | undefined>();
  const [combo, setCombo] = useState<string | null>(null);
  const [num, setNum] = useState<number | null>(132);
  const [date, setDate] = useState<string | null>(TODAY);
  const [q, setQ] = useState("");
  const [sw, setSw] = useState(true);
  const [ck, setCk] = useState(true);
  const [cmd, setCmd] = useState(false);
  const [merge, setMerge] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set(["2"]));
  const colors = ["bg", "surface", "sunken", "ink", "ink-soft", "ink-line", "rule", "rule-strong", "fg", "fg-2", "fg-3", "ok", "info", "warn", "hold", "danger"];
  return (
    <>
      <Block title={W.sections[0]}>
        <div className="grid grid-cols-4 gap-px border border-rule bg-rule sm:grid-cols-8">
          {colors.map((c) => (
            <div key={c} className="bg-surface p-2 text-xs">
              <span className="mb-1 block h-12 border border-rule" style={{ background: `var(--${c})` }} />
              {c}
            </div>
          ))}
        </div>
        <div className="grid gap-2">
          {(["5xl", "4xl", "3xl", "2xl", "xl", "lg", "md", "base", "sm", "xs"] as const).map((s) => (
            <p key={s} style={{ fontSize: `var(--text-${s})` }} className={`text-${s} ${s.length > 2 ? "font-bold" : ""}`}>
              {T.type}
            </p>
          ))}
        </div>
      </Block>

      <Block title={W.sections[1]}>
        <Row>
          <Button variant="primary">{T.send}</Button>
          <Button>{T.save}</Button>
          <Button variant="soft">{T.add}</Button>
          <Button variant="ghost">{T.more}</Button>
          <Button variant="quiet">{T.later}</Button>
          <Button variant="destructive" icon={<IconTrash aria-hidden />}>
            {T.del}
          </Button>
          <Button variant="emergency">119</Button>
        </Row>
        <Row>
          <Button variant="primary" size="lg" icon={<IconPlus aria-hidden />}>
            {T.start}
          </Button>
          <Button variant="primary" loading>
            {T.send}
          </Button>
          <Button variant="primary" disabled>
            {T.send}
          </Button>
          <Button size="sm">{T.save}</Button>
          <ButtonLink to="/dev/kit" icon={<IconFileText aria-hidden />}>
            {T.summary}
          </ButtonLink>
          <IconButton label={T.edit}>
            <IconPencil size={20} aria-hidden />
          </IconButton>
          <IconButton label={T.pin} variant="bordered">
            <IconPin size={20} aria-hidden />
          </IconButton>
          <IconButton label={T.add} variant="primary">
            <IconPlus size={20} aria-hidden />
          </IconButton>
          <IconButton label={T.pin} pressed>
            <IconPin size={20} aria-hidden />
          </IconButton>
          <TextLink to="/dev/kit">{T.link}</TextLink>
          <ExternalLink href="https://www.nhi.gov.tw/">{T.nhi}</ExternalLink>
          <Kbd>Ctrl K</Kbd>
        </Row>
      </Block>

      <Block title={W.sections[2]} className="grid gap-8 lg:grid-cols-2">
        <Field label={T.fName} hint={T.fNameHint}>
          <Input defaultValue={T.name} />
        </Field>
        <Field label={T.fUser} error={T.fUserErr} required>
          <Input defaultValue="lin" autoCapitalize="none" />
        </Field>
        <Field label={T.fPass}>
          <PasswordInput defaultValue="demo-value" />
        </Field>
        <Field label={T.fNote} optional>
          <Textarea placeholder={T.fNotePh} />
        </Field>
        <Field label={T.fPharmacy}>
          <Combobox label={T.fPharmacy} value={combo} onValueChange={setCombo} options={T.pharmacies.map((p) => ({ value: p.id, label: p.name, hint: p.hint, keywords: [p.hint] }))} />
        </Field>
        <Field label={T.fSlot}>
          <Select value={sel} onValueChange={setSel} options={T.slots} />
        </Field>
        <Field label={T.fDept}>
          <NativeSelect defaultValue="a">
            <option value="a">{T.dept}</option>
          </NativeSelect>
        </Field>
        <Field label={T.fDate}>
          <DateField value={date} onValueChange={setDate} />
        </Field>
        <FieldGroup label={T.fBp} hint={T.fBpHint}>
          <div className="grid grid-cols-2 gap-3">
            <NumberField aria-label={T.sys} value={num} onValueChange={setNum} unit="mmHg" />
            <NumberField aria-label={T.dia} value={84} onValueChange={() => {}} unit="mmHg" steppers />
          </div>
        </FieldGroup>
        <Field label={T.fSearch} hideLabel>
          <SearchInput value={q} onValueChange={setQ} placeholder={T.fSearch} />
        </Field>
        <FieldGroup label={T.qSame}>
          <RadioRows
            label={T.qSame}
            columns={2}
            value={yn}
            onValueChange={setYn}
            options={[
              { value: "y", label: T.yes },
              { value: "n", label: T.no },
            ]}
          />
        </FieldGroup>
        <FieldGroup label={T.qPick}>
          <RadioRows
            label={T.qPick}
            value={radio}
            onValueChange={setRadio}
            options={[
              { value: "a", label: T.pharmacies[0].name, hint: T.pharmacies[0].hint, end: <span className="num text-sm text-fg-2">350 m</span> },
              { value: "b", label: T.pharmacies[1].name, hint: T.pharmacies[1].hint, end: <span className="num text-sm text-fg-2">1.1 km</span> },
              { value: "c", label: T.pharmacies[2].name, hint: T.closed, disabled: true },
            ]}
          />
        </FieldGroup>
        <div>
          <Checkbox label={T.consent} hint={T.consentHint} checked={ck} onCheckedChange={(v) => setCk(v === true)} />
          <Checkbox label={T.consent} disabled />
          <Switch label={T.aiOn} hint={T.aiHint} checked={sw} onCheckedChange={setSw} />
        </div>
        <div className="grid content-start gap-4">
          <Segmented label={T.bucket} value={seg} onValueChange={setSeg} options={T.buckets} />
          <Stepper
            label={T.steps}
            steps={T.stepNames.map((label, i) => ({ id: String(i), label, state: i < 2 ? "done" : i === 2 ? "current" : "todo" }))}
            onStep={() => {}}
          />
          <Progress label={T.steps} value={2} max={6} />
        </div>
      </Block>

      <Block title={W.sections[3]}>
        <Row>
          <Dialog title={T.dlgTitle} description={T.dlgBody} trigger={<Button>Dialog</Button>} footer={<Button variant="primary">{T.save}</Button>}>
            <Field label={T.fNote}>
              <Textarea />
            </Field>
          </Dialog>
          <ConfirmDialog title={T.delTitle} description={T.delBody} confirmLabel={T.del} destructive onConfirm={() => toast.ok(T.deleted, { action: { label: T.undo, onClick: () => {} } })} trigger={<Button>Confirm</Button>} />
          <Sheet title={T.sheet} trigger={<Button>Sheet</Button>} footer={<Button variant="primary">{T.save}</Button>}>
            <DescriptionList items={T.detail} />
          </Sheet>
          <Popover trigger={<Button icon={<IconFilter aria-hidden />}>Popover</Button>} label="filter">
            <Checkbox label={T.onlyMine} />
            <Checkbox label={T.onlyLate} />
          </Popover>
          <Menu
            trigger={
              <IconButton label={T.more} variant="bordered" tooltip={false}>
                <IconDots size={20} aria-hidden />
              </IconButton>
            }
          >
            <MenuItem icon={<IconPencil aria-hidden />} shortcut={<Kbd>E</Kbd>}>
              {T.edit}
            </MenuItem>
            <MenuItem icon={<IconPrinter aria-hidden />}>{T.print}</MenuItem>
            <MenuItem icon={<IconDownload aria-hidden />} disabled>
              {T.export}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<IconArchive aria-hidden />}>{T.archive}</MenuItem>
          </Menu>
          <Tooltip content={T.tip}>
            <Button>Tooltip</Button>
          </Tooltip>
          <Button onClick={() => toast.ok(T.saved)}>Toast</Button>
          <Button onClick={() => toast.warn(T.saveFail, { action: { label: T.retry, onClick: () => {} } })}>Toast + action</Button>
          <Button onClick={() => setMerge(true)}>Diff merge</Button>
          <EmergencyButton />
        </Row>
        <DiffMergeDialog open={merge} onOpenChange={setMerge} theirsLabel={T.theirs} fields={T.diff} onMerge={() => setMerge(false)} />
      </Block>

      <Block title={W.sections[4]}>
        <div className="grid gap-3">
          <Banner tone="info" title={T.bInfo} actions={<Button size="sm">{T.continue}</Button>}>
            {T.bInfoBody}
          </Banner>
          <Banner tone="warn" title={T.bWarn}>
            {T.bWarnBody}
          </Banner>
          <Callout tone="hold" title={T.bHold} />
          <Callout tone="ok">{T.bOk}</Callout>
        </div>
        <Row>
          <SaveState state="saved" savedAt="14:32" />
          <SaveState state="saving" />
          <SaveState state="offline" />
          <SaveState state="conflict" onResolve={() => setMerge(true)} />
          <SaveState state="error" onResolve={() => {}} />
          <Spinner label={T.loading} />
          <PresenceLine people={[{ name: hsu.display_name, title: hsu.title }]} editing />
          <CountBadge count={7} />
          <CountBadge count={120} />
          <CountBadge count={2} tone="danger" />
        </Row>
        <Row>
          {["draft", "submitted", "in_review", "more_info", "approved", "declined", "visit_required", "at_pharmacy", "returned", "ready", "dispensed", "cancelled"].map((s) => (
            <StatusTag key={s} family="rx" status={s} />
          ))}
        </Row>
        <Row>
          {["routine", "soon", "urgent"].map((s) => (
            <StatusTag key={s} family="urgency" status={s} />
          ))}
          {["ready", "review", "in_person", "urgent", "excluded"].map((s) => (
            <StatusTag key={s} family="disposition" status={s} />
          ))}
          <Badge tone="ink">{T.tag}</Badge>
        </Row>
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel flush>
            <EmptyState icon={<IconInbox aria-hidden />} title={T.emptyTitle} action={<Button icon={<IconCalendarPlus aria-hidden />}>{T.book}</Button>}>
              {T.emptyBody}
            </EmptyState>
          </Panel>
          <Panel flush>
            <ErrorState onRetry={() => {}} />
          </Panel>
          <Panel flush>
            <SkeletonRows rows={4} />
          </Panel>
        </div>
        <EmergencyPanel />
        <EmergencyPanel kind="crisis" />
      </Block>

      <Block title={W.sections[5]}>
        <Panel title={T.worklist} flush>
          <FilterBar search={<SearchInput value={q} onValueChange={setQ} />} chips={[{ key: "a", label: T.onlyMine, onRemove: () => {} }]} onClearAll={() => {}}>
            <Select size="sm" label={T.bucket} value="all" onValueChange={() => {}} options={T.statuses} />
          </FilterBar>
          <DataTable
            caption={T.worklist}
            rows={worklist}
            rowKey={(r) => r.id}
            onRowOpen={() => {}}
            isUrgent={(r) => r.urgency === "urgent"}
            selection={{ selected: picked, onChange: setPicked }}
            total={42}
            onNext={() => {}}
            columns={[
              { id: "p", header: T.hPatient, cell: (r) => <Person name={r.patient.display_name} size={28} />, sortValue: (r) => r.patient.display_name, card: "title" },
              { id: "t", header: T.hTitle, cell: (r) => r.title, width: "32%" },
              { id: "u", header: T.hUrgency, cell: (r) => <StatusTag family="urgency" status={r.urgency} />, card: "end", sortValue: (r) => ["urgent", "soon", "routine"].indexOf(r.urgency) },
              { id: "a", header: T.hAssigned, cell: (r) => r.assigned_to?.display_name ?? T.none, hideBelow: "lg" },
              { id: "d", header: T.hDue, cell: (r) => r.due_at?.slice(11, 16), align: "end", sortValue: (r) => r.due_at, nowrap: true },
            ]}
          />
        </Panel>
        <div className="grid gap-6 lg:grid-cols-2">
          <FormSheet title={T.sheetTitle} note="RX-20261125-0012" columns={2} items={T.sheetItems} />
          <Panel title={T.ledger}>
            <Ledger items={T.ledgerItems} />
          </Panel>
          <Panel title={T.detailTitle}>
            <DescriptionList items={T.detail} />
          </Panel>
          <Panel title={T.timeline}>
            <Timeline label={T.timeline} items={T.timelineItems} />
          </Panel>
        </div>
        <Panel title={T.bpTitle}>
          <MeasurementChart kind="bp" items={bp} target={{ from: 120, to: 135, label: T.target }} />
        </Panel>
        <Tabs
          label="tabs"
          items={[
            { value: "a", label: T.worklist, count: 8, content: T.tabBody },
            { value: "b", label: T.timeline, content: T.tabBody },
          ]}
        />
        <Row>
          <Avatar name="林秀琴" />
          <Avatar name="Muhammad Rizal" />
          <Person name={chen.display_name} detail={chen.title} />
        </Row>
      </Block>

      <Block title={W.sections[6]}>
        {(["open", "soon", "fresh", "late", "finished", "lastDays", "two"] as const).map((k) => (
          <Panel key={k}>
            <RefillStrip med={refills[k]} today={TODAY} />
          </Panel>
        ))}
        <Row>
          {(["open", "soon", "late", "finished"] as const).map((k) => (
            <RefillStrip key={k} med={refills[k]} today={TODAY} size="compact" />
          ))}
        </Row>
      </Block>

      <Block title={W.sections[8]}>
        <DocumentMeta items={T.docMeta} />
        <EvidenceTable caption={T.evidence} rows={T.evidenceRows} />
        <div className="grid gap-6 md:grid-cols-3">
          <Photo slot="medicine_table" ratio="4 / 3" credit />
          <Photo slot="notes_hand" ratio="4 / 3" credit />
          <Photo slot="not_there_yet" ratio="4 / 3" />
        </div>
      </Block>

      <Block title={W.sections[9]}>
        <Row>
          <Button onClick={() => setCmd(true)}>Command palette</Button>
        </Row>
        <CommandPalette open={cmd} onOpenChange={setCmd} groups={[{ id: "go", title: T.worklist, entries: worklist.map((w) => ({ id: w.id, label: w.patient.display_name, hint: w.title, icon: <IconCopy aria-hidden />, onSelect: () => toast.info(w.title) })) }]} />
        <Panel title={T.notif} flush className="max-w-md">
          <NotificationList items={notifications} />
        </Panel>
      </Block>
    </>
  );
}
