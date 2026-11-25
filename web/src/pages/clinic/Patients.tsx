import { IconBookmark, IconBookmarkPlus, IconTag, IconTrash, IconUserSearch } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { clinicApi } from "@/api/endpoints";
import type { CareStatus, PatientPatch, PatientRow } from "@/api/types";
import { qk, useCan, useMe, usePatients, useStaff } from "@/data";
import { paths } from "@/lib/links";
import { FillPage } from "@/shells/StaffShell";
import { Button, DataTable, Dialog, EmptyState, FilterBar, Input, Field, LoadMore, Menu, MenuItem, MenuLabel, MenuSeparator, RadioRows, SearchInput, Segmented, Select, StatusTag, toast } from "@/ui";

import { personLabel, useDebounced, useErrorText, useFmt, useSavedList, useUrlState } from "./lib";
import { BulkBar, PageError, ShortcutHint, StaleBar, TextDialog, useKey, useRowCursor } from "./parts";
import { Flags } from "./patient/blocks";

const CARE: readonly CareStatus[] = ["new", "active", "watch", "inactive"];
const DEFAULTS = { q: "", tag: "", status: "all", assigned: "all" };
type View = typeof DEFAULTS;
interface SavedView extends Omit<View, "q"> {
  name: string;
}

export default function Patients() {
  const { t } = useTranslation(["clinic", "common"]);
  const fmt = useFmt();
  const me = useMe();
  const manages = useCan("patient.manage");
  const [url, set] = useUrlState<View>(DEFAULTS);
  const q = useDebounced(url.q.trim());
  const staff = useStaff(["physician", "coordinator"]);
  const query = usePatients({ limit: 50, ...(q ? { q } : {}), ...(url.tag ? { tag: url.tag } : {}), ...(url.status !== "all" ? { status: url.status as CareStatus } : {}), ...(url.assigned !== "all" ? { assigned: url.assigned } : {}) });
  const items = query.items;
  const tags = useMemo(() => [...new Set(items.flatMap((r) => r.tags))].sort((a, b) => a.localeCompare(b, "zh-Hant")), [items]);
  const [views, setViews] = useSavedList<SavedView>("clinic.patients.views", []);
  const [naming, setNaming] = useState(false);
  const cursor = useRowCursor(useMemo(() => items.map((r) => r.patient.id), [items]));
  const search = useRef<HTMLDivElement>(null);
  useKey("/", () => search.current?.querySelector("input")?.focus());

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const chosen = items.filter((r) => selected.has(r.patient.id));
  const [bulk, setBulk] = useState<"tag" | "status" | null>(null);

  const preset = url.status === "all" && !url.tag && url.assigned === "all" ? "all" : url.assigned === "me" && url.status === "all" && !url.tag ? "me" : url.status === "watch" && url.assigned === "all" && !url.tag ? "watch" : "";
  const chips = [
    ...(url.status !== "all" ? [{ key: "status", label: t(`common:status.care.${url.status}`), onRemove: () => set({ status: "all" }) }] : []),
    ...(url.tag ? [{ key: "tag", label: t("patients.tagIs", { tag: url.tag }), onRemove: () => set({ tag: "" }) }] : []),
    ...(url.assigned !== "all" ? [{ key: "assigned", label: url.assigned === "me" ? t("patients.mine") : personLabel(staff.data?.find((p) => p.id === url.assigned)) || t("patients.assigned"), onRemove: () => set({ assigned: "all" }) }] : []),
  ];
  const filtered = chips.length > 0 || url.q !== "";
  return (
    <FillPage
      head={
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-pane py-2.5">
          <h1 className="page-title" tabIndex={-1}>
            {t("patients.title")}
          </h1>
          <Segmented
            label={t("patients.views")}
            value={preset}
            onValueChange={(v) => set({ ...DEFAULTS, q: url.q, ...(v === "me" ? { assigned: "me" } : v === "watch" ? { status: "watch" } : {}) })}
            options={[
              { value: "all", label: t("patients.all") },
              { value: "me", label: t("patients.mine") },
              { value: "watch", label: t("common:status.care.watch") },
            ]}
          />
          <span className="ms-auto">
            <Menu
              trigger={
                <Button size="sm" icon={<IconBookmark aria-hidden />}>
                  {t("views.menu")}
                </Button>
              }
            >
              <MenuLabel>{t("views.mine")}</MenuLabel>
              {views.length === 0 && <MenuItem disabled>{t("views.empty")}</MenuItem>}
              {views.map((v) => (
                <MenuItem key={v.name} icon={<IconBookmark aria-hidden />} onSelect={() => set({ ...DEFAULTS, ...v })}>
                  {v.name}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem icon={<IconBookmarkPlus aria-hidden />} onSelect={() => setNaming(true)}>
                {t("views.save")}
              </MenuItem>
              {views.map((v) => (
                <MenuItem key={`del-${v.name}`} icon={<IconTrash aria-hidden />} onSelect={() => setViews(views.filter((x) => x.name !== v.name))}>
                  {t("views.delete", { name: v.name })}
                </MenuItem>
              ))}
            </Menu>
          </span>
        </div>
      }
    >
      {query.isError && !query.data ? (
        <PageError error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex h-full min-h-0 flex-col bg-surface">
          <StaleBar query={query} />
          <div ref={search}>
            <FilterBar search={<SearchInput value={url.q} onValueChange={(v) => set({ q: v })} placeholder={t("patients.search")} />} chips={chips} onClearAll={() => set(DEFAULTS)}>
              <Select size="sm" label={t("patients.care")} value={url.status} onValueChange={(status) => set({ status })} options={[{ value: "all", label: t("patients.anyCare") }, ...CARE.map((value) => ({ value, label: t(`common:status.care.${value}`) }))]} />
              <Select size="sm" label={t("patients.tag")} value={url.tag || "all"} onValueChange={(v) => set({ tag: v === "all" ? "" : v })} options={[{ value: "all", label: t("patients.anyTag") }, ...[...new Set([...(url.tag ? [url.tag] : []), ...tags])].map((value) => ({ value, label: value }))]} />
              <Select
                size="sm"
                label={t("patients.assigned")}
                value={url.assigned}
                onValueChange={(assigned) => set({ assigned })}
                options={[{ value: "all", label: t("patients.anyone") }, { value: "me", label: t("patients.mine") }, ...(staff.data ?? []).filter((p) => p.id !== me?.id).map((p) => ({ value: p.id, label: personLabel(p) }))]}
              />
            </FilterBar>
          </div>
          {manages && (
            <BulkBar count={chosen.length} onClear={() => setSelected(new Set())}>
              <Button size="sm" variant="soft" icon={<IconTag aria-hidden />} onClick={() => setBulk("tag")}>
                {t("patients.bulkTag")}
              </Button>
              <Button size="sm" variant="soft" onClick={() => setBulk("status")}>
                {t("patients.bulkStatus")}
              </Button>
            </BulkBar>
          )}
          <div ref={cursor.ref} onFocusCapture={cursor.onFocusCapture} className="min-h-0 flex-1 overflow-auto">
            <DataTable
              caption={t("patients.title")}
              rows={query.isPending ? undefined : items}
              loading={query.isPending}
              error={query.isError}
              onRetry={() => void query.refetch()}
              rowKey={(r) => r.patient.id}
              rowLink={(r) => paths.clinic.patient(r.patient.id)}
              isUrgent={(r) => r.flags.includes("red_flag")}
              selection={manages ? { selected, onChange: setSelected } : undefined}
              empty={
                <EmptyState icon={<IconUserSearch aria-hidden />} title={t(filtered ? "patients.noMatch" : "patients.empty")} action={filtered ? <Button onClick={() => set(DEFAULTS)}>{t("common:filter.clearAll")}</Button> : undefined}>
                  {t(filtered ? "patients.noMatchBody" : "patients.emptyBody")}
                </EmptyState>
              }
              columns={[
                {
                  id: "patient",
                  header: t("col.patient"),
                  width: "10rem",
                  card: "title",
                  sortValue: (r) => r.patient.display_name,
                  cell: (r) => (
                    <>
                      <span className="font-semibold">{r.patient.display_name}</span>
                      <span className="block text-sm text-fg-2">{[r.age === null ? null : t("patient.age", { n: r.age }), r.sex ? t(`patient.sex.${r.sex}`) : null].filter(Boolean).join(t("patient.dot"))}</span>
                    </>
                  ),
                },
                {
                  id: "conditions",
                  header: t("patients.conditions"),
                  cell: (r) => (
                    <>
                      <span className="line-clamp-1">{r.conditions.length ? fmt.list(r.conditions) : <span className="text-fg-3">{t("record.noConditions")}</span>}</span>
                      {(r.tags.length > 0 || r.flags.length > 0) && (
                        <span className="mt-1 flex flex-wrap gap-1.5">
                          <Flags flags={r.flags} />
                          {r.tags.map((x) => (
                            <span key={x} className="tag" data-tone="mute">
                              {x}
                            </span>
                          ))}
                        </span>
                      )}
                    </>
                  ),
                },
                { id: "care", header: t("patients.care"), width: "8rem", card: "end", sortValue: (r) => CARE.indexOf(r.care_status), cell: (r) => <StatusTag family="care" status={r.care_status} /> },
                { id: "open", header: t("patients.open"), width: "6rem", align: "end", sortValue: (r) => r.open_items, cell: (r) => (r.open_items > 0 ? <span className="font-semibold">{r.open_items}</span> : <span className="text-fg-3">0</span>) },
                { id: "team", header: t("patients.team"), width: "9rem", hideBelow: "lg", cell: (r) => <Team row={r} /> },
                { id: "contact", header: t("patients.lastContact"), width: "7.5rem", nowrap: true, hideBelow: "md", sortValue: (r) => r.last_contact_at, cell: (r) => (r.last_contact_at ? fmt.rel(r.last_contact_at) : <span className="text-fg-3">{t("patients.never")}</span>) },
                { id: "next", header: t("patients.next"), width: "10rem", nowrap: true, hideBelow: "xl", sortValue: (r) => r.next_appointment_at, cell: (r) => (r.next_appointment_at ? <span className="num">{fmt.stamp(r.next_appointment_at)}</span> : <span className="text-fg-3">{t("patients.noNext")}</span>) },
              ]}
            />
            {query.hasNextPage && <LoadMore onLoad={() => void query.fetchNextPage()} loading={query.isFetchingNextPage} />}
          </div>
          <div className="dt-foot">
            <span className="num">{query.total === undefined ? t("patients.count", { count: items.length }) : t("common:table.count", { shown: items.length, total: query.total })}</span>
            <ShortcutHint
              items={[
                { keys: ["J", "K"], label: t("keys.do.move") },
                { keys: ["Enter"], label: t("keys.do.open") },
                { keys: ["X"], label: t("keys.do.select") },
                { keys: ["/"], label: t("keys.do.find") },
              ]}
            />
          </div>
        </div>
      )}
      <BulkDialog kind={bulk} rows={chosen} known={tags} onClose={() => setBulk(null)} onDone={() => setSelected(new Set())} />
      <TextDialog
        open={naming}
        onOpenChange={setNaming}
        title={t("views.saveTitle")}
        description={t("views.saveBody")}
        label={t("views.name")}
        confirm={t("views.save")}
        rows={1}
        max={24}
        onSubmit={async (name) => {
          const { q: _q, ...view } = url;
          setViews([...views.filter((v) => v.name !== name), { ...view, name }]);
        }}
      />
    </FillPage>
  );
}

function Team({ row }: { row: PatientRow }) {
  const { t } = useTranslation("clinic");
  if (!row.physician && !row.coordinator) return <span className="text-fg-3">{t("assign.none")}</span>;
  return (
    <>
      {row.physician && <span className="block">{row.physician.display_name}</span>}
      {row.coordinator && <span className="block text-sm text-fg-2">{row.coordinator.display_name}</span>}
    </>
  );
}

/** Add one tag, or set one care status, on every chosen patient. */
function BulkDialog({ kind, rows, known, onClose, onDone }: { kind: "tag" | "status" | null; rows: PatientRow[]; known: string[]; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation(["clinic", "common"]);
  const qc = useQueryClient();
  const errorText = useErrorText();
  const [tag, setTag] = useState("");
  const [status, setStatus] = useState<CareStatus | undefined>();
  const [busy, setBusy] = useState(false);
  const ready = kind === "tag" ? tag.trim() !== "" : status !== undefined;
  const run = async () => {
    const patch = (r: PatientRow): PatientPatch => (kind === "tag" ? { tags: [...new Set([...r.tags, tag.trim()])] } : { care_status: status });
    setBusy(true);
    const done = await Promise.allSettled(rows.map((r) => clinicApi.updatePatient(r.patient.id, patch(r))));
    setBusy(false);
    void qc.invalidateQueries({ queryKey: qk.patients });
    const failed = done.filter((d) => d.status === "rejected");
    if (failed.length) toast.warn(`${t("patients.bulkFailed", { count: failed.length })}${t("common:list.sep")}${errorText(failed[0].reason)}`);
    if (failed.length < rows.length) toast.ok(t("patients.bulkDone", { count: rows.length - failed.length }));
    setTag("");
    setStatus(undefined);
    onClose();
    onDone();
  };
  return (
    <Dialog
      open={kind !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t(kind === "tag" ? "patients.bulkTagTitle" : "patients.bulkStatusTitle", { count: rows.length })}
      footer={
        <>
          <Button onClick={onClose}>{t("common:action.cancel")}</Button>
          <Button variant="primary" disabled={!ready} loading={busy} onClick={() => void run()}>
            {t(kind === "tag" ? "patients.bulkTag" : "patients.bulkStatus")}
          </Button>
        </>
      }
    >
      {kind === "tag" ? (
        <Field label={t("patients.tag")} hint={t("patients.tagHint")}>
          <Input value={tag} maxLength={20} list="known-tags" onChange={(e) => setTag(e.target.value)} autoFocus />
          <datalist id="known-tags">
            {known.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        </Field>
      ) : (
        <RadioRows label={t("patients.care")} value={status} onValueChange={(v) => setStatus(v as CareStatus)} options={CARE.map((value) => ({ value, label: t(`common:status.care.${value}`), hint: t(`patients.careHint.${value}`) }))} />
      )}
    </Dialog>
  );
}
