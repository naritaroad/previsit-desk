import { IconArrowLeft, IconX } from "@tabler/icons-react";
import { useCallback, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink } from "react-router";

import { cn } from "./cn";
import { useMediaQuery } from "./hooks";
import { Phrases } from "./phrases";

/* ----- Page frame ----- */

export interface PageHeaderProps {
  title: ReactNode;
  /** One or two lines under the title. */
  lede?: ReactNode;
  /** Where "back" goes; shown as a link above the title. */
  back?: { to: string; label: string };
  actions?: ReactNode;
  /** Status tags, save state, timestamps. */
  meta?: ReactNode;
  className?: string;
}

/** The h1 is the focus target after navigation (see app/route-focus.tsx). */
export function PageHeader({ title, lede, back, actions, meta, className }: PageHeaderProps) {
  return (
    <header className={cn("mb-stack", className)}>
      {back && (
        <Link to={back.to} className="link mb-2 inline-flex min-h-8 items-center gap-1 text-sm" data-quiet="true">
          <IconArrowLeft size={18} aria-hidden />
          {back.label}
        </Link>
      )}
      <div className="page-head">
        <div className="min-w-0">
          <h1 className="page-title" tabIndex={-1}>
            {typeof title === "string" ? <Phrases text={title} /> : title}
          </h1>
          {lede && <p className="mt-1.5 max-w-[38em] text-fg-2">{lede}</p>}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-fg-2">{meta}</div>}
        </div>
        {actions && <div className="toolbar">{actions}</div>}
      </div>
    </header>
  );
}

/** Page content with the workspace gutters. `width="read"` for forms and single-task pages. */
export function PageBody({ children, width = "wide", className }: { children: ReactNode; width?: "read" | "wide" | "full"; className?: string }) {
  return <div className={cn("mx-auto w-full px-4 py-6 sm:px-6 lg:px-8", width === "read" && "max-w-3xl", width === "wide" && "max-w-page", className)}>{children}</div>;
}

export function Panel({ title, actions, meta, children, flush, className, as: As = "section", footer }: { title?: ReactNode; actions?: ReactNode; meta?: ReactNode; children?: ReactNode; /** No body padding: tables, lists. */ flush?: boolean; className?: string; as?: "section" | "div" | "article" | "aside"; footer?: ReactNode }) {
  const id = useId();
  return (
    <As className={cn("panel", className)} aria-labelledby={title ? id : undefined}>
      {(title || actions) && (
        <div className="panel-head">
          {title && (
            <h2 className="panel-title" id={id}>
              {title}
            </h2>
          )}
          {meta && <div className="flex flex-wrap items-center gap-2 text-sm text-fg-2">{meta}</div>}
          {actions && <div className="toolbar ms-auto">{actions}</div>}
        </div>
      )}
      <div className={flush ? undefined : "panel-body"}>{children}</div>
      {footer && <div className="border-t border-rule px-pane py-3">{footer}</div>}
    </As>
  );
}

/** A titled block on the page ground, without a box. Prefer this to Panel when nothing needs enclosing. */
export function Section({ title, actions, children, className }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={cn("section", className)} aria-labelledby={id}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={id} className="section-title">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Toolbar({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="toolbar" aria-label={label} className={cn("toolbar", className)}>
      {children}
    </div>
  );
}

export function FilterBar({ search, children, chips, onClearAll, end, className }: { search?: ReactNode; children?: ReactNode; chips?: { key: string; label: string; onRemove: () => void }[]; onClearAll?: () => void; end?: ReactNode; className?: string }) {
  const { t } = useTranslation("common");
  return (
    <div className={cn("filterbar", className)} role="search">
      {search && <div className="grow">{search}</div>}
      {children}
      {chips?.map((c) => (
        <span key={c.key} className="filter-chip">
          {c.label}
          <button type="button" aria-label={t("filter.remove", { name: c.label })} onClick={c.onRemove}>
            <IconX size={15} aria-hidden />
          </button>
        </span>
      ))}
      {Boolean(chips?.length) && onClearAll && (
        <button type="button" className="link text-sm" onClick={onClearAll}>
          {t("filter.clearAll")}
        </button>
      )}
      {end && <div className="toolbar ms-auto">{end}</div>}
    </div>
  );
}

/* ----- Tabs that are pages ----- */

/** Route tabs: each tab is a URL, so back, refresh and links work. */
export function NavTabs({ label, items, className }: { label: string; items: { to: string; label: ReactNode; count?: number; end?: boolean }[]; className?: string }) {
  return (
    <nav aria-label={label} className={cn("tabs-list", className)}>
      {items.map((i) => (
        <NavLink key={i.to} to={i.to} end={i.end} className="tab inline-flex items-center no-underline">
          {i.label}
          {i.count !== undefined && <span className="count num">{i.count}</span>}
        </NavLink>
      ))}
    </nav>
  );
}

/* ----- Split pane ----- */

export interface SplitPaneProps {
  /** 2 or 3 panes. Widths in percent, remembered per `storageKey`. */
  panes: { id: string; label: string; content: ReactNode; min?: number }[];
  initial: number[];
  storageKey?: string;
  /** Below this width panes become tabs. */
  stackBelow?: string;
  className?: string;
}

export function SplitPane({ panes, initial, storageKey, stackBelow = "64rem", className }: SplitPaneProps) {
  const { t } = useTranslation("common");
  const stacked = useMediaQuery(`(max-width: ${stackBelow})`);
  const box = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(panes[0].id);
  const [sizes, setSizes] = useState<number[]>(() => {
    try {
      const raw = storageKey ? localStorage.getItem(`pv-split:${storageKey}`) : null;
      const saved = raw ? (JSON.parse(raw) as number[]) : null;
      return saved?.length === panes.length ? saved : initial;
    } catch {
      return initial;
    }
  });
  const [drag, setDrag] = useState<number | null>(null);

  const resize = useCallback(
    (i: number, delta: number) => {
      setSizes((cur) => {
        const next = [...cur];
        const total = cur[i] + cur[i + 1];
        const minA = panes[i].min ?? 18;
        const minB = panes[i + 1].min ?? 18;
        next[i] = Math.min(total - minB, Math.max(minA, cur[i] + delta));
        next[i + 1] = total - next[i];
        if (storageKey) {
          try {
            localStorage.setItem(`pv-split:${storageKey}`, JSON.stringify(next));
          } catch {
            /* kept for this visit only */
          }
        }
        return next;
      });
    },
    [panes, storageKey],
  );

  if (stacked) {
    return (
      <div className={cn("flex h-full min-h-0 flex-col", className)}>
        <div role="tablist" aria-label={t("a11y.panes")} className="tabs-list flex-none bg-surface px-4">
          {panes.map((p) => (
            <button key={p.id} type="button" role="tab" id={`pane-tab-${p.id}`} aria-controls={`pane-${p.id}`} aria-selected={p.id === active} data-state={p.id === active ? "active" : "inactive"} className="tab" onClick={() => setActive(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        {panes.map((p) => (
          <div key={p.id} id={`pane-${p.id}`} role="tabpanel" aria-labelledby={`pane-tab-${p.id}`} hidden={p.id !== active} className="split-pane flex-1">
            {p.content}
          </div>
        ))}
      </div>
    );
  }
  const template = sizes.map((s, i) => (i < sizes.length - 1 ? `minmax(0, ${s}fr) 1px` : `minmax(0, ${s}fr)`)).join(" ");
  return (
    <div ref={box} className={cn("split", className)} style={{ gridTemplateColumns: template } as CSSProperties}>
      {panes.flatMap((p, i) => {
        const pane = (
          <section key={p.id} aria-label={p.label} className="split-pane">
            {p.content}
          </section>
        );
        if (i === panes.length - 1) return [pane];
        return [
          pane,
          <div
            key={`${p.id}-handle`}
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t("a11y.resize", { name: p.label })}
            aria-valuenow={Math.round(sizes[i])}
            aria-valuemin={p.min ?? 18}
            aria-valuemax={100}
            className="split-handle"
            data-dragging={drag === i}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") resize(i, -2);
              else if (e.key === "ArrowRight") resize(i, 2);
              else return;
              e.preventDefault();
            }}
            onDoubleClick={() => setSizes(initial)}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              setDrag(i);
            }}
            onPointerMove={(e) => {
              if (drag !== i || !box.current) return;
              resize(i, (e.movementX / box.current.clientWidth) * 100);
            }}
            onPointerUp={() => setDrag(null)}
            onLostPointerCapture={() => setDrag(null)}
          />,
        ];
      })}
    </div>
  );
}
