import { IconBookmark, IconBookmarkPlus, IconClipboardText, IconInbox, IconMessages, IconPrescription, IconRefresh, IconTrash, IconUserPlus } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import type { WorkItem, WorklistBucket } from "@/api/types";
import { useMe, useSavedFilter, useWorklist } from "@/data";
import { internalLink } from "@/lib/links";
import { FillPage } from "@/shells/StaffShell";
import { Button, DataTable, EmptyState, FilterBar, IconButton, LoadMore, Menu, MenuItem, MenuLabel, MenuSeparator, SearchInput, Segmented, Select, SplitPane, StatusTag, useMediaQuery } from "@/ui";

import { useAssignMany } from "./assign";
import { isOverdue, isTodayClinic, samePerson, useDebounced, useFmt, useMinute, useSavedList, useUrlState } from "./lib";
import { AssignDialog, AssignedTo, BulkBar, DueText, PageError, ShortcutHint, StaleBar, TextDialog, WorkStatus, useEnterOpens, useKey, useRowCursor } from "./parts";
import { WorkPreview } from "./WorkPreview";

const BUCKETS: readonly WorklistBucket[] = ["urgent", "pending", "mine", "waiting", "done"];
const ICON = { visit: IconClipboardText, rx: IconPrescription, ticket: IconMessages };
const DEFAULTS = { bucket: "pending", type: "all", who: "all", only: "all", sort: "urgency", q: "" };
type View = typeof DEFAULTS;
interface SavedView extends Omit<View, "q"> {
  name: string;
}
const keyOf = (i: Pick<WorkItem, "type" | "id">) => `${i.type}:${i.id}`;

export default function Worklist() {
  const { t } = useTranslation(["clinic", "common"]);
  const fmt = useFmt();
  const me = useMe();
  const now = useMinute();
  const navigate = useNavigate();
  const [last, setLast] = useSavedFilter("clinic.worklist", { type: "all", who: "all", sort: "urgency" });
  const [url, setUrl] = useUrlState<View>({ ...DEFAULTS, ...last });
  const set = (part: Partial<View>) => {
    setUrl(part);
    const keep = Object.fromEntries(Object.entries(part).filter(([k]) => k === "type" || k === "who" || k === "sort"));
    if (Object.keys(keep).length) setLast(keep);
  };
  const [views, setViews] = useSavedList<SavedView>("clinic.worklist.views", []);
  const [naming, setNaming] = useState(false);

  const bucket = BUCKETS.find((b) => b === url.bucket) ?? "pending";
  const q = useDebounced(url.q);
  const query = useWorklist({ bucket, limit: 100, ...(q.trim() ? { q: q.trim() } : {}), ...(url.sort !== "urgency" ? { sort: url.sort } : {}) });
  const items = useMemo(
    () =>
      query.items.filter(
        (i) =>
          (url.type === "all" || i.type === url.type) &&
          (url.who === "all" || (url.who === "me" ? samePerson(i.assigned_to, me) : i.assigned_to === null)) &&
          (url.only === "all" || (url.only === "overdue" ? isOverdue(i, now) : isTodayClinic(i, now))),
      ),
    [query.items, url.type, url.who, url.only, me, now],
  );
  const byKey = useMemo(() => new Map(items.map((i) => [keyOf(i), i])), [items]);
  const keys = useMemo(() => items.map(keyOf), [items]);

  const split = useMediaQuery("(min-width: 80rem)");
  const cursor = useRowCursor(keys);
  const active = cursor.active ? byKey.get(cursor.active) : undefined;
  const onEnter = useEnterOpens(cursor, (k) => internalLink(byKey.get(k)?.link) ?? undefined);
  const open = (i: WorkItem) => {
    const link = internalLink(i.link);
    if (link) void navigate(link);
  };

  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set()), [bucket]);
  const chosen = [...selected].flatMap((k) => byKey.get(k) ?? []);
  const [assigning, setAssigning] = useState<WorkItem[] | null>(null);
  const { assign, busy } = useAssignMany();
  useKey("a", () => setAssigning(chosen.length ? chosen : active ? [active] : null), chosen.length > 0 || Boolean(active));
  const search = useRef<HTMLDivElement>(null);
  useKey("/", () => search.current?.querySelector("input")?.focus());

  const filtered = url.type !== "all" || url.who !== "all" || url.only !== "all" || url.q !== "";
  const clear = () => set({ type: "all", who: "all", only: "all", q: "" });
  const chips = [
    ...(url.only !== "all" ? [{ key: "only", label: t(`work.only.${url.only}`), onRemove: () => set({ only: "all" }) }] : []),
    ...(url.type !== "all" ? [{ key: "type", label: t(`work.type.${url.type}`), onRemove: () => set({ type: "all" }) }] : []),
    ...(url.who !== "all" ? [{ key: "who", label: t(`work.who.${url.who}`), onRemove: () => set({ who: "all" }) }] : []),
  ];

  const list = (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <StaleBar query={query} />
      <div ref={search}>
        <FilterBar
          search={<SearchInput value={url.q} onValueChange={(v) => set({ q: v })} placeholder={t("work.search")} />}
          chips={chips}
          onClearAll={clear}
          end={
            <>
              <Select size="sm" label={t("work.sortLabel")} value={url.sort} onValueChange={(sort) => set({ sort })} options={["urgency", "due", "updated"].map((value) => ({ value, label: t(`work.sort.${value}`) }))} />
              <IconButton label={t("work.refresh")} size="sm" onClick={() => void query.refetch()}>
                <IconRefresh size={20} aria-hidden className={query.isRefetching ? "animate-spin" : undefined} />
              </IconButton>
            </>
          }
        >
          <Select size="sm" label={t("work.onlyLabel")} value={url.only} onValueChange={(only) => set({ only })} options={["all", "overdue", "today"].map((value) => ({ value, label: t(`work.only.${value}`) }))} />
          <Select size="sm" label={t("work.typeLabel")} value={url.type} onValueChange={(type) => set({ type })} options={["all", "visit", "rx", "ticket"].map((value) => ({ value, label: t(`work.type.${value}`) }))} />
          <Select size="sm" label={t("work.whoLabel")} value={url.who} onValueChange={(who) => set({ who })} options={["all", "me", "none"].map((value) => ({ value, label: t(`work.who.${value}`) }))} />
        </FilterBar>
      </div>
      <BulkBar count={chosen.length} onClear={() => setSelected(new Set())}>
        <Button size="sm" variant="soft" icon={<IconUserPlus aria-hidden />} loading={busy} onClick={() => setAssigning(chosen)}>
          {t("bulk.assign")}
        </Button>
      </BulkBar>
      <div ref={cursor.ref} onFocusCapture={cursor.onFocusCapture} onKeyDownCapture={onEnter} className="min-h-0 flex-1 overflow-auto" onDoubleClick={() => active && open(active)}>
        <DataTable
          caption={t("work.caption", { bucket: t(`work.bucket.${bucket}`) })}
          rows={query.isPending ? undefined : items}
          loading={query.isPending}
          error={query.isError}
          onRetry={() => void query.refetch()}
          rowKey={keyOf}
          onRowOpen={(i) => (split ? cursor.setActive(keyOf(i)) : open(i))}
          isUrgent={(i) => i.urgency === "urgent" && bucket !== "done"}
          selection={{ selected, onChange: setSelected }}
          empty={
            <EmptyState icon={<IconInbox aria-hidden />} title={t(filtered ? "work.noMatch" : `work.empty.${bucket}`)} action={filtered ? <Button onClick={clear}>{t("common:filter.clearAll")}</Button> : undefined}>
              {t(filtered ? "work.noMatchBody" : `work.emptyBody.${bucket}`)}
            </EmptyState>
          }
          columns={[
            {
              id: "patient",
              header: t("col.patient"),
              card: "title",
              width: "8.5rem",
              cell: (i) => (
                <span className="inline-flex items-center gap-2 font-semibold">
                  {i.patient.display_name}
                </span>
              ),
            },
            {
              id: "what",
              header: t("col.what"),
              cell: (i) => {
                const Icon = ICON[i.type];
                return (
                  <span className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                    <Icon size={18} className="mt-0.5 text-fg-3" aria-label={t(`work.type.${i.type}`)} />
                    <span className="min-w-0">
                      <span className="line-clamp-1">{i.title}</span>
                      {i.subtitle && i.subtitle !== i.title && <span className="line-clamp-1 text-sm text-fg-2">{i.subtitle}</span>}
                    </span>
                  </span>
                );
              },
            },
            { id: "urgency", header: t("col.urgency"), width: "6.5rem", hideBelow: "md", cell: (i) => <StatusTag family="urgency" status={i.urgency} plain={i.urgency === "routine"} /> },
            { id: "status", header: t("col.status"), width: "8.5rem", card: "end", cell: (i) => <WorkStatus item={i} now={now} /> },
            { id: "who", header: t("col.assigned"), width: "7rem", hideBelow: "lg", cell: (i) => (i.type === "ticket" ? <span className="text-fg-3">{t("work.noAssign")}</span> : <AssignedTo person={i.assigned_to} />) },
            {
              id: "due",
              header: t("col.due"),
              width: "9.5rem",
              align: "end",
              nowrap: true,
              cell: (i) => <DueText at={i.due_at} kind={i.type === "visit" ? "appointment" : "deadline"} now={now} stopped={bucket === "done" || bucket === "waiting"} />,
            },
            { id: "updated", header: t("col.updated"), width: "6.5rem", align: "end", nowrap: true, hideBelow: "lg", card: "hide", cell: (i) => <span className="text-fg-2">{fmt.rel(i.updated_at)}</span> },
          ]}
        />
        {query.hasNextPage && <LoadMore onLoad={() => void query.fetchNextPage()} loading={query.isFetchingNextPage} />}
      </div>
      <div className="dt-foot">
        <span className="num">{t("work.count", { count: items.length })}</span>
        <ShortcutHint
          items={[
            { keys: ["J", "K"], label: t("keys.do.move") },
            { keys: ["Enter"], label: t("keys.do.open") },
            { keys: ["X"], label: t("keys.do.select") },
            { keys: ["A"], label: t("keys.do.assign") },
          ]}
        />
      </div>
    </div>
  );

  return (
    <FillPage
      head={
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-pane py-2.5">
          <h1 className="page-title" tabIndex={-1}>
            {t("work.title")}
          </h1>
          <div className="scroll-x">
            <Segmented label={t("work.bucketLabel")} value={bucket} onValueChange={(b) => set({ bucket: b })} options={BUCKETS.map((value) => ({ value, label: t(`work.bucket.${value}`), count: query.counts?.[value] }))} />
          </div>
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
      ) : split ? (
        <SplitPane
          storageKey="clinic-worklist"
          initial={[66, 34]}
          stackBelow="1px"
          panes={[
            { id: "list", label: t("work.title"), content: list, min: 45 },
            { id: "preview", label: t("preview.title"), content: <WorkPreview item={active} now={now} onAssign={(i, p) => void assign([i], p)} />, min: 24 },
          ]}
        />
      ) : (
        list
      )}
      <AssignDialog open={assigning !== null} onOpenChange={(o) => !o && setAssigning(null)} count={assigning?.length ?? 0} onPick={(p) => assigning && void assign(assigning, p).then(() => setSelected(new Set()))} />
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
          const { q: _q, ...view } = { ...DEFAULTS, ...url };
          setViews([...views.filter((v) => v.name !== name), { ...view, name }]);
        }}
      />
    </FillPage>
  );
}
