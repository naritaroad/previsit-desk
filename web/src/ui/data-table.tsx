import { IconArrowDown, IconArrowUp, IconArrowsSort, IconCheck, IconChevronLeft, IconChevronRight, IconMinus } from "@tabler/icons-react";
import { Checkbox as RCheckbox } from "radix-ui";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import { Button, IconButton } from "./button";
import { cn } from "./cn";
import { EmptyState, ErrorState, SkeletonRows } from "./feedback";

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Gives a client-side sort. For server sorting use `sortable` and `onSortChange`. */
  sortValue?: (row: T) => string | number | null;
  sortable?: boolean;
  align?: "start" | "end";
  nowrap?: boolean;
  /** CSS width, e.g. "9rem". */
  width?: string;
  /** Phone cards: "title" is the first line, "end" sits at its right, "hide" is dropped. Default is a labelled row. */
  card?: "title" | "end" | "hide" | "row";
  /** Hide the column when the table itself (not the window) is narrower than 44, 56 or 72rem. */
  hideBelow?: "md" | "lg" | "xl";
}

export interface Sort {
  id: string;
  dir: "asc" | "desc";
}

export interface DataTableProps<T> {
  caption: string;
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  /** Opening a row: Enter, click. Return a path. */
  rowLink?: (row: T) => string;
  onRowOpen?: (row: T) => void;
  isUrgent?: (row: T) => boolean;
  selectedKey?: string | null;
  /** Checkboxes for batch actions. */
  selection?: { selected: ReadonlySet<string>; onChange: (next: Set<string>) => void };
  sort?: Sort | null;
  onSortChange?: (s: Sort | null) => void;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  empty?: ReactNode;
  /** Cursor paging. */
  onNext?: () => void;
  onPrev?: () => void;
  loadingMore?: boolean;
  total?: number;
  footer?: ReactNode;
  maxHeight?: string;
  className?: string;
}

/**
 * Rows: Up/Down or J/K move, Enter opens, X or Space selects, Home/End jump. Only one row is in the tab order.
 */
export function DataTable<T>(p: DataTableProps<T>) {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const [ownSort, setOwnSort] = useState<Sort | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const body = useRef<HTMLTableSectionElement>(null);
  const sort = p.sort !== undefined ? p.sort : ownSort;

  const rows = useMemo(() => {
    const list = p.rows ?? [];
    const col = p.onSortChange ? undefined : p.columns.find((c) => c.id === sort?.id);
    if (!sort || !col?.sortValue) return list;
    const get = col.sortValue;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1; // blanks last either way
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "zh-Hant")) * dir;
    });
  }, [p.rows, p.columns, p.onSortChange, sort]);

  const toggleSort = (id: string) => {
    const next: Sort | null = sort?.id !== id ? { id, dir: "asc" } : sort.dir === "asc" ? { id, dir: "desc" } : null;
    if (p.onSortChange) p.onSortChange(next);
    else setOwnSort(next);
  };
  const open = (row: T) => {
    if (p.onRowOpen) p.onRowOpen(row);
    else if (p.rowLink) void navigate(p.rowLink(row));
  };
  const toggle = (key: string) => {
    if (!p.selection) return;
    const next = new Set(p.selection.selected);
    if (!next.delete(key)) next.add(key);
    p.selection.onChange(next);
  };
  const focusRow = (i: number) => {
    const el = body.current?.rows[Math.max(0, Math.min(rows.length - 1, i))];
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, i: number, row: T) => {
    if (e.target !== e.currentTarget) return;
    const k = e.key.toLowerCase();
    if (k === "arrowdown" || k === "j") focusRow(i + 1);
    else if (k === "arrowup" || k === "k") focusRow(i - 1);
    else if (k === "home") focusRow(0);
    else if (k === "end") focusRow(rows.length - 1);
    else if (k === "enter") open(row);
    else if (k === " " || k === "x") p.selection ? toggle(p.rowKey(row)) : open(row);
    else return;
    e.preventDefault();
  };

  if (p.loading && !p.rows) return <SkeletonRows rows={6} className={p.className} />;
  if (p.error && !p.rows) return <ErrorState onRetry={p.onRetry} className={p.className} />;
  if (rows.length === 0) return <div className={p.className}>{p.empty ?? <EmptyState title={t("state.empty")} />}</div>;

  const clickable = Boolean(p.rowLink ?? p.onRowOpen);
  const tabStop = cursor !== null && rows.some((r) => p.rowKey(r) === cursor) ? cursor : (p.selectedKey ?? p.rowKey(rows[0]));
  const all = p.selection ? rows.every((r) => p.selection!.selected.has(p.rowKey(r))) : false;
  const some = p.selection ? rows.some((r) => p.selection!.selected.has(p.rowKey(r))) : false;
  const title = p.columns.find((c) => c.card === "title") ?? p.columns[0];
  const end = p.columns.find((c) => c.card === "end");
  const cardRows = p.columns.filter((c) => c !== title && c !== end && c.card !== "hide");

  return (
    <div className={cn("@container/dt [container-name:dt]", p.className)}>
      <div className="dt-wrap" style={{ maxHeight: p.maxHeight }}>
        <table className="dt" data-cards="true">
          <caption className="sr-only">{p.caption}</caption>
          <colgroup>
            {p.selection && <col style={{ width: "2.75rem" }} />}
            {p.columns.map((c) => (
              <col key={c.id} style={c.width ? { width: c.width } : undefined} data-hide={c.hideBelow} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {p.selection && (
                <th scope="col">
                  <RCheckbox.Root
                    className="check-box m-0"
                    aria-label={t("table.selectAll")}
                    checked={all ? true : some ? "indeterminate" : false}
                    onCheckedChange={() => p.selection!.onChange(all ? new Set() : new Set(rows.map(p.rowKey)))}
                  >
                    <RCheckbox.Indicator>{all ? <IconCheck stroke={3} aria-hidden /> : <IconMinus stroke={3} aria-hidden />}</RCheckbox.Indicator>
                  </RCheckbox.Root>
                </th>
              )}
              {p.columns.map((c) => {
                const active = sort?.id === c.id;
                const canSort = Boolean(c.sortValue ?? c.sortable);
                return (
                  <th key={c.id} scope="col" data-align={c.align} data-hide={c.hideBelow} aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : canSort ? "none" : undefined}>
                    {canSort ? (
                      <button type="button" onClick={() => toggleSort(c.id)}>
                        {c.header}
                        {active ? sort!.dir === "asc" ? <IconArrowUp aria-hidden /> : <IconArrowDown aria-hidden /> : <IconArrowsSort aria-hidden />}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody ref={body}>
            {rows.map((row, i) => {
              const key = p.rowKey(row);
              return (
                <tr
                  key={key}
                  tabIndex={key === tabStop ? 0 : -1}
                  data-clickable={clickable}
                  data-urgent={p.isUrgent?.(row)}
                  aria-selected={p.selection ? p.selection.selected.has(key) : p.selectedKey === undefined ? undefined : p.selectedKey === key}
                  onFocus={() => setCursor(key)}
                  onKeyDown={(e) => onKey(e, i, row)}
                  onClick={
                    clickable
                      ? (e) => {
                          if ((e.target as HTMLElement).closest("a,button,input,label,[role=checkbox]") || String(getSelection() ?? "")) return;
                          open(row);
                        }
                      : undefined
                  }
                >
                  {p.selection && (
                    <td>
                      <RCheckbox.Root className="check-box m-0" aria-label={t("table.selectRow")} checked={p.selection.selected.has(key)} onCheckedChange={() => toggle(key)}>
                        <RCheckbox.Indicator>
                          <IconCheck stroke={3} aria-hidden />
                        </RCheckbox.Indicator>
                      </RCheckbox.Root>
                    </td>
                  )}
                  {p.columns.map((c) => (
                    <td key={c.id} data-align={c.align} data-nowrap={c.nowrap} data-flex={c.width === undefined} data-hide={c.hideBelow}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        <ul className="dt-cards" aria-label={p.caption}>
          {rows.map((row) => {
            const inner = (
              <>
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0 font-semibold">{title.cell(row)}</span>
                  {end && <span className="flex-none">{end.cell(row)}</span>}
                </span>
                <dl>
                  {cardRows.map((c) => (
                    <div key={c.id} className="contents">
                      <dt>{c.header}</dt>
                      <dd className="wrap-any">{c.cell(row)}</dd>
                    </div>
                  ))}
                </dl>
              </>
            );
            return (
              <li key={p.rowKey(row)}>
                {p.rowLink && !p.onRowOpen ? (
                  <Link to={p.rowLink(row)} className="dt-card" data-urgent={p.isUrgent?.(row)}>
                    {inner}
                  </Link>
                ) : clickable ? (
                  <div role="button" tabIndex={0} className="dt-card cursor-pointer" data-urgent={p.isUrgent?.(row)} onClick={() => open(row)} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open(row)}>
                    {inner}
                  </div>
                ) : (
                  <div className="dt-card">{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {(p.onNext ?? p.onPrev ?? p.footer ?? p.total) !== undefined && (
        <div className="dt-foot">
          <span className="num">{p.footer ?? (p.total !== undefined ? t("table.count", { shown: rows.length, total: p.total }) : null)}</span>
          {(p.onNext || p.onPrev) && <Pagination onPrev={p.onPrev} onNext={p.onNext} loading={p.loadingMore} />}
        </div>
      )}
    </div>
  );
}

/** Cursor paging: the API has no page numbers, so neither does the control. */
export function Pagination({ onPrev, onNext, loading }: { onPrev?: () => void; onNext?: () => void; loading?: boolean }) {
  const { t } = useTranslation("common");
  return (
    <nav aria-label={t("a11y.pagination")} className="flex items-center gap-1">
      <IconButton label={t("action.prevPage")} size="sm" disabled={!onPrev || loading} onClick={onPrev}>
        <IconChevronLeft size={20} aria-hidden />
      </IconButton>
      <IconButton label={t("action.nextPage")} size="sm" disabled={!onNext || loading} onClick={onNext}>
        <IconChevronRight size={20} aria-hidden />
      </IconButton>
    </nav>
  );
}

/** For lists that grow instead of paging (notifications, conversations). */
export function LoadMore({ onLoad, loading }: { onLoad: () => void; loading?: boolean }) {
  const { t } = useTranslation("common");
  return (
    <div className="flex justify-center p-4">
      <Button onClick={onLoad} loading={loading}>
        {t("action.loadMore")}
      </Button>
    </div>
  );
}
