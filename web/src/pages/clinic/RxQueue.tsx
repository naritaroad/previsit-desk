import { IconPrescription, IconRefresh, IconUserPlus } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { RxBucket, RxRequestBrief } from "@/api/types";
import { useCan, useRxQueue } from "@/data";
import { isOpenRx } from "@/lib/rx";
import { paths } from "@/lib/links";
import { FillPage } from "@/shells/StaffShell";
import { Button, DataTable, EmptyState, FilterBar, IconButton, LoadMore, SearchInput, Segmented, Select, StatusTag } from "@/ui";

import { useAssignMany, type Assignable } from "./assign";
import { useDebounced, useFmt, useMinute, useUrlState } from "./lib";
import { AssignDialog, AssignedTo, BulkBar, DueText, PageError, ShortcutHint, StaleBar, useKey, useRowCursor } from "./parts";

const BUCKETS: readonly (RxBucket | "open")[] = ["open", "urgent", "overdue", "mine", "unassigned", "more_info", "pharmacy", "done"];
const DEFAULTS = { bucket: "open", kind: "all", q: "" };
const asItem = (r: RxRequestBrief): Assignable => ({ type: "rx", id: r.id, assigned_to: r.assigned_to });

export default function RxQueue() {
  const { t } = useTranslation(["clinic", "common", "rx"]);
  const fmt = useFmt();
  const now = useMinute();
  const decides = useCan("rx.decide");
  const [url, set] = useUrlState(DEFAULTS);
  const bucket = BUCKETS.find((b) => b === url.bucket) ?? "open";
  const q = useDebounced(url.q.trim());
  const query = useRxQueue(bucket === "open" ? undefined : bucket, q || undefined);
  const items = useMemo(() => query.items.filter((r) => url.kind === "all" || r.kind === url.kind), [query.items, url.kind]);
  const byKey = useMemo(() => new Map(items.map((r) => [r.id, r])), [items]);
  const cursor = useRowCursor(useMemo(() => items.map((r) => r.id), [items]));

  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set()), [bucket]);
  const chosen = [...selected].flatMap((k) => byKey.get(k) ?? []);
  const active = cursor.active ? byKey.get(cursor.active) : undefined;
  const [assigning, setAssigning] = useState<RxRequestBrief[] | null>(null);
  const { assign, busy } = useAssignMany();
  useKey("a", () => setAssigning(chosen.length ? chosen : active ? [active] : null), chosen.length > 0 || Boolean(active));
  const search = useRef<HTMLDivElement>(null);
  useKey("/", () => search.current?.querySelector("input")?.focus());
  const filtered = url.kind !== "all" || url.q !== "";

  return (
    <FillPage
      head={
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-pane py-2.5">
          <h1 className="page-title" tabIndex={-1}>
            {t("rx.title")}
          </h1>
          <div className="scroll-x">
            <Segmented label={t("rx.bucketLabel")} value={bucket} onValueChange={(b) => set({ bucket: b })} options={BUCKETS.map((value) => ({ value, label: value === "open" ? t("rx.open") : t(`rx:bucket.${value}`), count: value === "open" ? undefined : query.counts?.[value] }))} />
          </div>
        </div>
      }
    >
      {query.isError && !query.data ? (
        <PageError error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex h-full min-h-0 flex-col bg-surface">
          <StaleBar query={query} />
          <div ref={search}>
            <FilterBar
              search={<SearchInput value={url.q} onValueChange={(v) => set({ q: v })} placeholder={t("rx.search")} />}
              chips={url.kind !== "all" ? [{ key: "kind", label: t(`rx:kind.${url.kind}`), onRemove: () => set({ kind: "all" }) }] : []}
              end={
                <IconButton label={t("work.refresh")} size="sm" onClick={() => void query.refetch()}>
                  <IconRefresh size={20} aria-hidden className={query.isRefetching ? "animate-spin" : undefined} />
                </IconButton>
              }
            >
              <Select
                size="sm"
                label={t("rx.kindLabel")}
                value={url.kind}
                onValueChange={(kind) => set({ kind })}
                options={[
                  { value: "all", label: t("rx.allKinds") },
                  { value: "renewal", label: t("rx:kind.renewal") },
                  { value: "refill", label: t("rx:kind.refill") },
                ]}
              />
            </FilterBar>
          </div>
          <BulkBar count={chosen.length} onClear={() => setSelected(new Set())}>
            <Button size="sm" variant="soft" icon={<IconUserPlus aria-hidden />} loading={busy} onClick={() => setAssigning(chosen)}>
              {t("bulk.assign")}
            </Button>
          </BulkBar>
          <div ref={cursor.ref} onFocusCapture={cursor.onFocusCapture} className="min-h-0 flex-1 overflow-auto">
            <DataTable
              caption={t("rx.title")}
              rows={query.isPending ? undefined : items}
              loading={query.isPending}
              error={query.isError}
              onRetry={() => void query.refetch()}
              rowKey={(r) => r.id}
              rowLink={(r) => paths.clinic.rx(r.id)}
              isUrgent={(r) => r.priority === "urgent" && isOpenRx(r.status)}
              selection={{ selected, onChange: setSelected }}
              empty={
                <EmptyState icon={<IconPrescription aria-hidden />} title={t(filtered ? "work.noMatch" : "rx.empty")} action={filtered ? <Button onClick={() => set({ kind: "all", q: "" })}>{t("common:filter.clearAll")}</Button> : undefined}>
                  {t(filtered ? "work.noMatchBody" : "rx.emptyBody")}
                </EmptyState>
              }
              columns={[
                {
                  id: "patient",
                  header: t("col.patient"),
                  width: "8rem",
                  card: "title",
                  cell: (r) => (
                    <span className={r.unread ? "font-bold" : "font-semibold"}>
                      {r.unread && <span className="sr-only">{t("common:notif.unread")}</span>}
                      {r.patient.display_name}
                      {r.unread && <span className="unread-mark ms-2 inline-block" aria-hidden="true" />}
                    </span>
                  ),
                },
                {
                  id: "drug",
                  header: t("col.drug"),
                  cell: (r) => (
                    <>
                      <span className="line-clamp-1">{fmt.list(r.drug_names)}</span>
                      <span className="num block text-sm text-fg-2">
                        {t(`rx:kind.${r.kind}`)} {r.no}
                      </span>
                    </>
                  ),
                },
                { id: "check", header: t("col.check"), width: "9rem", hideBelow: "md", cell: (r) => (r.disposition ? <StatusTag family="disposition" status={r.disposition} /> : <span className="text-fg-3">{t("rx.noCheck")}</span>) },
                { id: "status", header: t("col.status"), width: "9rem", card: "end", cell: (r) => <StatusTag family="rx" status={r.status} /> },
                { id: "who", header: t("col.assigned"), width: "7rem", hideBelow: "lg", cell: (r) => <AssignedTo person={r.assigned_to} /> },
                { id: "due", header: t("col.due"), width: "9.5rem", align: "end", nowrap: true, cell: (r) => <DueText at={r.sla_due_at} kind="deadline" now={now} stopped={r.status !== "in_review" && r.status !== "submitted"} /> },
                { id: "sent", header: t("col.sent"), width: "6.5rem", align: "end", nowrap: true, hideBelow: "lg", card: "hide", cell: (r) => <span className="text-fg-2">{fmt.rel(r.submitted_at)}</span> },
              ]}
            />
            {query.hasNextPage && <LoadMore onLoad={() => void query.fetchNextPage()} loading={query.isFetchingNextPage} />}
          </div>
          <div className="dt-foot">
            <span>{t(decides ? "rx.footPhysician" : "rx.footCoordinator")}</span>
            <ShortcutHint
              items={[
                { keys: ["J", "K"], label: t("keys.do.move") },
                { keys: ["Enter"], label: t("keys.do.open") },
                { keys: ["A"], label: t("keys.do.assign") },
              ]}
            />
          </div>
        </div>
      )}
      <AssignDialog open={assigning !== null} onOpenChange={(o) => !o && setAssigning(null)} count={assigning?.length ?? 0} onPick={(p) => assigning && void assign(assigning.map(asItem), p).then(() => setSelected(new Set()))} />
    </FillPage>
  );
}
