import { IconCheck, IconEye } from "@tabler/icons-react";
import { Tabs as RTabs } from "radix-ui";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn, type Tone } from "./cn";

/* ----- Tabs inside a page ----- */

export function Tabs({ value, defaultValue, onValueChange, label, items, className, panelClassName }: { value?: string; defaultValue?: string; onValueChange?: (v: string) => void; label: string; items: { value: string; label: ReactNode; count?: number; content: ReactNode }[]; className?: string; panelClassName?: string }) {
  return (
    <RTabs.Root value={value} defaultValue={defaultValue ?? items[0]?.value} onValueChange={onValueChange} className={className}>
      <RTabs.List className="tabs-list" aria-label={label}>
        {items.map((i) => (
          <RTabs.Trigger key={i.value} value={i.value} className="tab">
            {i.label}
            {i.count !== undefined && <span className="count num">{i.count}</span>}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {items.map((i) => (
        <RTabs.Content key={i.value} value={i.value} className={cn("pt-stack", panelClassName)}>
          {i.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  );
}

/* ----- People: initials only, never photographs ----- */

/** 林秀琴 -> 林; "Dr. Alan Chen" -> AC */
function initials(name: string): string {
  const clean = name.trim();
  if (/[\u3400-\u9fff]/.test(clean)) return [...clean][0] ?? "";
  const parts = clean.split(/\s+/).filter((p) => !/^(dr|mr|ms|mrs)\.?$/i.test(p));
  return (parts.length > 1 ? parts[0][0] + parts.at(-1)![0] : (parts[0] ?? "").slice(0, 2)).toUpperCase();
}

export function Avatar({ name, size = 36, className }: { name: string; size?: number; className?: string }) {
  return (
    <span className={cn("avatar", className)} style={{ "--avatar": `${size / 16}rem` } as CSSProperties} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function Person({ name, detail, size = 36, className }: { name: string; detail?: ReactNode; size?: number; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2.5", className)}>
      <Avatar name={name} size={size} />
      <span className="min-w-0">
        <span className="block truncate leading-snug font-semibold">{name}</span>
        {detail && <span className="block truncate text-sm leading-snug text-fg-2">{detail}</span>}
      </span>
    </span>
  );
}

/* ----- Ruled data ----- */

export interface DetailItem {
  label: ReactNode;
  value: ReactNode;
  /** FormSheet with two columns: take the whole row. */
  wide?: boolean;
}

function NoValue() {
  const { t } = useTranslation("common");
  return <span className="text-fg-3">{t("list.noValue")}</span>;
}

/** Labels and values with hairlines. The everyday detail list. */
export function DescriptionList({ items, className }: { items: DetailItem[]; className?: string }) {
  return (
    <dl className={cn("dl", className)}>
      {items.map((i, n) => (
        <div key={n}>
          <dt>{i.label}</dt>
          <dd>{i.value ?? <NoValue />}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The printed form: label cells in form ink, values in writing ink. For prescriptions, dispensing checks and
 *  anything a pharmacist would read off a bag. One per view; everything else is a DescriptionList. */
export function FormSheet({ title, note, items, columns = 1, className, children }: { title?: ReactNode; note?: ReactNode; items: DetailItem[]; columns?: 1 | 2; className?: string; children?: ReactNode }) {
  return (
    <div className={cn("form-sheet", className)}>
      {title && (
        <div className="form-sheet-title">
          <span>{title}</span>
          {note && <span>{note}</span>}
        </div>
      )}
      <dl className="form-rows" style={{ "--cols": columns } as CSSProperties}>
        {items.map((i, n) => (
          <div key={n} className="form-row" style={i.wide && columns > 1 ? ({ "--span": columns } as CSSProperties) : undefined}>
            <dt>{i.label}</dt>
            <dd>{i.value ?? <NoValue />}</dd>
          </div>
        ))}
      </dl>
      {children}
    </div>
  );
}

/** Key on the left, figure on the right: totals, counts, usage. */
export function Ledger({ items, className }: { items: { label: ReactNode; value: ReactNode; unit?: ReactNode; total?: boolean }[]; className?: string }) {
  return (
    <dl className={cn("ledger", className)}>
      {items.map((i, n) => (
        <div key={n} data-total={i.total}>
          <dt>{i.label}</dt>
          <dd>
            {i.value}
            {i.unit && <small>{i.unit}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ----- Timeline ----- */

export interface TimelineItem {
  id: string;
  /** Already formatted. */
  time?: ReactNode;
  dateTime?: string;
  what: ReactNode;
  who?: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
  /** Expected, not happened yet. */
  pending?: boolean;
}

export function Timeline({ items, label, className }: { items: TimelineItem[]; label: string; className?: string }) {
  return (
    <ol className={cn("timeline", className)} aria-label={label}>
      {items.map((i) => (
        <li key={i.id} data-pending={i.pending}>
          <time dateTime={i.dateTime}>{i.time}</time>
          <span className="node" aria-hidden="true">
            <span className="dot" data-tone={i.tone}>
              {i.icon ?? (i.pending ? null : <IconCheck aria-hidden />)}
            </span>
          </span>
          <div className="body">
            <p className="what font-medium">{i.what}</p>
            {i.who && <p className="who">{i.who}</p>}
            {i.detail && <div className="mt-1 text-sm text-fg-2">{i.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ----- Stepper ----- */

export type StepState = "done" | "current" | "todo" | "error";

export function Stepper({ steps, label, onStep, className }: { steps: { id: string; label: string; state: StepState }[]; label: string; /** Lets people go back to finished steps. */ onStep?: (id: string) => void; className?: string }) {
  const { t } = useTranslation("common");
  return (
    <nav aria-label={label} className={cn("@container/stepper [container-name:stepper]", className)}>
      <ol className="stepper">
        {steps.map((s, i) => {
          const inner = (
            <>
              <span className="n" aria-hidden="true">
                {s.state === "done" ? <IconCheck stroke={2.5} aria-hidden /> : i + 1}
              </span>
              <span className="label">
                {s.label}
                <span className="sr-only">{t(`step.${s.state}`)}</span>
              </span>
            </>
          );
          return (
            <li key={s.id} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined} className="relative">
              {onStep && (s.state === "done" || s.state === "error") ? (
                <button type="button" onClick={() => onStep(s.id)}>
                  {inner}
                </button>
              ) : (
                inner
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** One step of a wizard: stepper, one question group, a pinned action row. */
export function StepForm({ stepper, title, lede, children, back, next, saveState, aside }: { stepper: ReactNode; title: ReactNode; lede?: ReactNode; children: ReactNode; back?: ReactNode; next: ReactNode; saveState?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="step-form">
      {stepper}
      <div className={cn("step-form-body", aside && "with-aside")}>
        <div className="min-w-0">
          <h1 className="page-title" tabIndex={-1}>
            {title}
          </h1>
          {lede && <p className="mt-2 max-w-[30em] text-md text-fg-2">{lede}</p>}
          <div className="mt-6 grid gap-6">{children}</div>
        </div>
        {aside && <aside className="min-w-0">{aside}</aside>}
      </div>
      <div className="step-form-foot">
        {back}
        <span className="ms-auto">{saveState}</span>
        {next}
      </div>
    </div>
  );
}

/* ----- Presence ----- */

/** Who else has this record open. Quiet, but always in the same place. */
export function PresenceLine({ people, editing, className }: { people: { name: string; title?: string | null }[]; editing?: boolean; className?: string }) {
  const { t } = useTranslation("common");
  if (people.length === 0) return null;
  const names = people.map((p) => [p.name, p.title].filter(Boolean).join(" ")).join(t("list.sep"));
  return (
    <p className={cn("inline-flex items-center gap-1.5 text-sm text-fg-2", className)} role="status">
      <IconEye size={18} aria-hidden />
      {t(editing ? "presence.editing" : "presence.viewing", { names })}
    </p>
  );
}
