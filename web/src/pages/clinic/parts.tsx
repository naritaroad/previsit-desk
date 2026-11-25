// Pieces several clinic pages share.

import { IconAlertTriangle, IconCheck, IconClock, IconClockX, IconExternalLink, IconLock, IconMapQuestion, IconRefresh, IconUserCheck, IconUserMinus, IconUserPlus } from "@tabler/icons-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import type { PersonRef, Role, WorkItem } from "@/api/types";
import { useCan, useMe, useStaff } from "@/data";
import { isApiError } from "@/api/errors";
import { safeExternalUrl } from "@/lib/links";
import { Avatar, Badge, Banner, Button, ButtonLink, Dialog, EmptyState, ErrorState, ExternalLink, Kbd, Menu, MenuItem, MenuSeparator, Person, StatusTag, Textarea, cn, useHotkey, useOnline } from "@/ui";

import type { DiffPart } from "./diff";
import { isOverdue, personLabel, samePerson, useErrorText, useFmt } from "./lib";

// ------------------------------------------------------------------------------------------------ states

/** A page that could not load: no permission, gone, or something that may work on a second try. */
export function PageError({ error, onRetry, back }: { error: unknown; onRetry?: () => void; back?: { to: string; label: string } }) {
  const { t } = useTranslation("clinic");
  const text = useErrorText();
  const link = back && (
    <ButtonLink to={back.to} variant="primary">
      {back.label}
    </ButtonLink>
  );
  if (isApiError(error, "forbidden"))
    return (
      <EmptyState icon={<IconLock aria-hidden />} title={<h1 tabIndex={-1}>{t("state.forbiddenTitle")}</h1>} action={link}>
        {t("state.forbiddenBody")}
      </EmptyState>
    );
  if (isApiError(error, "not_found"))
    return (
      <EmptyState icon={<IconMapQuestion aria-hidden />} title={<h1 tabIndex={-1}>{t("state.goneTitle")}</h1>} action={link}>
        {t("state.goneBody")}
      </EmptyState>
    );
  return (
    <ErrorState title={<h1 tabIndex={-1}>{t("state.failedTitle")}</h1>} onRetry={onRetry}>
      {text(error)}
    </ErrorState>
  );
}

type Freshness = Pick<UseQueryResult, "data" | "isError" | "fetchStatus" | "dataUpdatedAt" | "refetch">;
/** What is on screen may be old: the last read failed or is waiting for the network. */
export function StaleBar({ query, bleed = true }: { query: Freshness; bleed?: boolean }) {
  const { t } = useTranslation(["clinic", "common"]);
  const fmt = useFmt();
  const online = useOnline();
  const stale = query.data !== undefined && (query.isError || query.fetchStatus === "paused" || !online);
  if (!stale) return null;
  return (
    <Banner
      tone="warn"
      bleed={bleed}
      actions={
        online ? (
          <Button size="sm" icon={<IconRefresh aria-hidden />} onClick={() => void query.refetch()}>
            {t("common:action.retry")}
          </Button>
        ) : undefined
      }
    >
      {t(online ? "state.stale" : "state.staleOffline", { time: fmt.stamp(query.dataUpdatedAt) })}
    </Banner>
  );
}

/** Why a control is not here. Coordinators do everything except signing and deciding. */
export function RoleNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("flex items-start gap-2 rounded-control border border-dashed border-rule-strong px-3 py-2 text-sm text-fg-2", className)} role="note">
      <IconLock size={18} className="mt-0.5 flex-none" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

// ------------------------------------------------------------------------------------------------ labels

/** Status of a work item, including the server's extra "overdue". */
export function WorkStatus({ item, now }: { item: WorkItem; now: Date }) {
  const { t } = useTranslation("clinic");
  if (isOverdue(item, now))
    return (
      <Badge tone="warn" icon={<IconClockX aria-hidden />}>
        {t("work.overdue")}
      </Badge>
    );
  return <StatusTag family={item.type === "rx" ? "rx" : item.type === "ticket" ? "ticket" : "visit"} status={item.status} />;
}

/** Time left, time over, or when the appointment is. */
export function DueText({ at, kind, now, stopped, className }: { at: string | null; kind: "deadline" | "appointment"; now: Date; stopped?: boolean; className?: string }) {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  if (!at) return <span className={cn("text-fg-3", className)}>{t("work.noDue")}</span>;
  if (kind === "appointment") return <span className={cn("num", className)}>{t("work.seenAt", { time: fmt.stamp(at) })}</span>;
  if (stopped) return <span className={cn("num text-fg-2", className)}>{fmt.stamp(at)}</span>;
  const past = new Date(at) < now;
  return (
    <span className={cn("num inline-flex items-center gap-1", past && "font-semibold text-warn", className)} title={fmt.dateTime(at)}>
      {past ? <IconClockX size={16} aria-hidden /> : <IconClock size={16} className="text-fg-3" aria-hidden />}
      {t(past ? "work.over" : "work.left", { span: fmt.span(at, now) })}
    </span>
  );
}

export function Nobody() {
  const { t } = useTranslation("clinic");
  return <span className="text-fg-3">{t("assign.none")}</span>;
}
export function AssignedTo({ person }: { person: PersonRef | null }) {
  const { t } = useTranslation("clinic");
  const me = useMe();
  if (!person) return <Nobody />;
  return samePerson(person, me) ? <span className="font-semibold">{t("assign.me")}</span> : <span>{person.display_name}</span>;
}

/** A source in the rules: the host is what people recognise. */
export function SourceLink({ url, label }: { url: string | null | undefined; label?: ReactNode }) {
  const { t } = useTranslation("clinic");
  const safe = safeExternalUrl(url);
  if (!safe) return null;
  return (
    <ExternalLink href={safe} className="inline-flex items-center gap-1 text-sm">
      {label ?? t("source.at", { host: new URL(safe).hostname.replace(/^www\./, "") })}
      <IconExternalLink size={15} aria-hidden />
      <span className="sr-only">{t("source.newTab")}</span>
    </ExternalLink>
  );
}

export function DiffView({ parts, label }: { parts: DiffPart[]; label: string }) {
  return (
    <p className="diff-view" aria-label={label}>
      {parts.map((p, i) => (p.op === "add" ? <ins key={i}>{p.text}</ins> : p.op === "del" ? <del key={i}>{p.text}</del> : <span key={i}>{p.text}</span>))}
    </p>
  );
}

// ------------------------------------------------------------------------------------------------ assigning

const CLINIC_ROLES: readonly Role[] = ["physician", "coordinator"];

/** People to choose from, me first. */
function useAssignees() {
  const me = useMe();
  const staff = useStaff(CLINIC_ROLES);
  const people = [...(staff.data ?? [])].sort((a, b) => Number(samePerson(b, me)) - Number(samePerson(a, me)) || a.role.localeCompare(b.role) * -1);
  return { me, people, loading: staff.isPending, failed: staff.isError, retry: () => void staff.refetch() };
}

export function AssignMenu({ value, onAssign, size = "sm", busy }: { value: PersonRef | null; onAssign: (p: PersonRef | null) => void; size?: "sm" | "md"; busy?: boolean }) {
  const { t } = useTranslation("clinic");
  const { me, people, loading } = useAssignees();
  return (
    <Menu
      align="start"
      trigger={
        <Button size={size} icon={value ? <IconUserCheck aria-hidden /> : <IconUserPlus aria-hidden />} loading={busy}>
          {value ? t("assign.to", { name: samePerson(value, me) ? t("assign.me") : value.display_name }) : t("assign.none")}
        </Button>
      }
    >
      {loading && <MenuItem disabled>{t("assign.loading")}</MenuItem>}
      {people.map((p) => (
        <MenuItem key={p.id} icon={samePerson(p, value) ? <IconCheck aria-hidden /> : undefined} onSelect={() => onAssign(p)}>
          {samePerson(p, me) ? t("assign.toMe") : personLabel(p)}
        </MenuItem>
      ))}
      {value && (
        <>
          <MenuSeparator />
          <MenuItem icon={<IconUserMinus aria-hidden />} onSelect={() => onAssign(null)}>
            {t("assign.clear")}
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

/** Opened with A or from the bulk bar: one list, me on top, so A then Enter takes the item. */
export function AssignDialog({ open, onOpenChange, count, onPick, note }: { open: boolean; onOpenChange: (o: boolean) => void; count: number; onPick: (p: PersonRef | null) => void; note?: ReactNode }) {
  const { t } = useTranslation("clinic");
  const { me, people, loading, failed, retry } = useAssignees();
  const pick = (p: PersonRef | null) => {
    onOpenChange(false);
    onPick(p);
  };
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const d = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const all = [...e.currentTarget.querySelectorAll("button")];
    all[(all.indexOf(document.activeElement as HTMLButtonElement) + d + all.length) % all.length]?.focus();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("assign.title", { count })} description={note} width="26rem">
      {failed ? (
        <ErrorState onRetry={retry} />
      ) : (
        <ul className="pick-list" onKeyDown={onKey}>
          {loading && <li className="px-2 py-3 text-fg-2">{t("assign.loading")}</li>}
          {people.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => pick(p)} autoFocus={samePerson(p, me)}>
                <Person name={p.display_name} detail={p.title} size={32} />
                {samePerson(p, me) && <span className="text-sm text-fg-2">{t("assign.me")}</span>}
              </button>
            </li>
          ))}
          <li>
            <button type="button" onClick={() => pick(null)}>
              <span className="inline-flex items-center gap-2.5">
                <IconUserMinus size={20} aria-hidden />
                {t("assign.clear")}
              </span>
            </button>
          </li>
        </ul>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ lists

const overlayOpen = () => document.querySelector("[role=dialog],[role=alertdialog],[role=menu],[role=listbox]") !== null;

/**
 * Keyboard for a DataTable whose rows are in the order of `keys`: J and K work from anywhere on the page, the focused
 * row is the active one. DataTable itself handles the keys while a row has focus.
 */
export function useRowCursor(keys: readonly string[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const focus = (i: number) => {
    const rows = ref.current?.querySelectorAll<HTMLTableRowElement>("tbody tr");
    const row = rows?.[Math.max(0, Math.min(rows.length - 1, i))];
    row?.focus();
    row?.scrollIntoView({ block: "nearest" });
  };
  const step = (d: number) => (e: globalThis.KeyboardEvent) => {
    if (e.defaultPrevented || overlayOpen()) return;
    e.preventDefault();
    const i = active ? keys.indexOf(active) : -1;
    focus(i < 0 ? 0 : i + d);
  };
  useHotkey("j", step(1));
  useHotkey("k", step(-1));
  const onFocusCapture = (e: FocusEvent<HTMLDivElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLTableRowElement>("tbody tr");
    const card = row ? null : (e.target as HTMLElement).closest(".dt-cards > li");
    const i = row ? row.sectionRowIndex : card ? [...card.parentElement!.children].indexOf(card) : -1;
    if (i >= 0 && keys[i]) setActive(keys[i]);
  };
  return { ref, active: active && keys.includes(active) ? active : null, setActive, onFocusCapture };
}

/** A plain-key shortcut that keeps out of the way of open dialogs. */
export function useKey(combo: string, run: () => void, enabled = true) {
  useHotkey(
    combo,
    (e) => {
      if (e.defaultPrevented || overlayOpen()) return;
      e.preventDefault();
      run();
    },
    enabled,
  );
}

/** Open a record from a list with Enter although a click only selects it. */
export function useEnterOpens(ref: { active: string | null }, link: (key: string) => string | undefined) {
  const navigate = useNavigate();
  return (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || !(e.target as HTMLElement).matches("tbody tr") || !ref.active) return;
    const to = link(ref.active);
    if (!to) return;
    e.preventDefault();
    e.stopPropagation();
    void navigate(to);
  };
}

/** Appears over the list while rows are selected. */
export function BulkBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  const { t } = useTranslation("clinic");
  if (count === 0) return null;
  return (
    <div className="bulk-bar" role="region" aria-label={t("bulk.label")}>
      <span className="font-semibold" role="status">
        {t("bulk.selected", { count })}
      </span>
      {children}
      <Button size="sm" variant="quiet" className="ms-auto" onClick={onClear}>
        {t("bulk.clear")}
      </Button>
    </div>
  );
}

export function ShortcutHint({ items }: { items: { keys: string[]; label: string }[] }) {
  return (
    <ul className="hidden flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-2 lg:flex">
      {items.map((i) => (
        <li key={i.label} className="inline-flex items-center gap-1.5">
          {i.keys.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
          {i.label}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------------------------------------ small forms

export interface TextDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  label: string;
  hint?: ReactNode;
  initial?: string;
  confirm: string;
  /** Sentences to add with one click; the text stays editable. */
  suggestions?: { label: string; text: string }[];
  suggestionsLabel?: string;
  required?: boolean;
  max?: number;
  rows?: number;
  before?: ReactNode;
  /** Resolves when done; throws to keep the dialog open with the reason. */
  onSubmit: (text: string) => Promise<unknown>;
}

/** One text, one action. Keeps what was typed when the request fails. */
export function TextDialog({ open, onOpenChange, title, description, label, hint, initial = "", confirm, suggestions, suggestionsLabel, required = true, max = 1000, rows = 5, before, onSubmit }: TextDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} width="36rem">
      {open && <TextForm {...{ onOpenChange, label, hint, initial, confirm, suggestions, suggestionsLabel, required, max, rows, before, onSubmit }} />}
    </Dialog>
  );
}
function TextForm({ onOpenChange, label, hint, initial = "", confirm, suggestions, suggestionsLabel, required, max = 1000, rows, before, onSubmit }: Omit<TextDialogProps, "open" | "title" | "description">) {
  const { t } = useTranslation(["clinic", "common", "errors"]);
  const id = useId();
  const errorText = useErrorText();
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const over = [...text].length > max;
  const submit = async () => {
    if (required && !text.trim()) return setError(t("errors:field.required"));
    if (over) return setError(t("errors:field.messageLong"));
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text.trim());
      onOpenChange(false);
    } catch (e) {
      setError((isApiError(e) && Object.values(e.fields)[0]) || errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {before}
      {suggestions && suggestions.length > 0 && (
        <div className="grid gap-1.5" role="group" aria-label={suggestionsLabel}>
          <span className="text-sm text-fg-2">{suggestionsLabel}</span>
          <span className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <Button key={s.label} size="sm" onClick={() => setText((v) => (v.trim() ? `${v.trimEnd()}\n${s.text}` : s.text))}>
                {s.label}
              </Button>
            ))}
          </span>
        </div>
      )}
      <div className="field">
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
        {hint && (
          <p className="field-hint" id={`${id}-h`}>
            {hint}
          </p>
        )}
        <Textarea id={id} rows={rows} value={text} autoFocus aria-invalid={Boolean(error) || over || undefined} aria-describedby={cn(hint && `${id}-h`, error && `${id}-e`) || undefined} onChange={(e) => setText(e.target.value)} />
        <span className={cn("num text-end text-sm text-fg-3", over && "font-semibold text-warn")}>{t("form.count", { n: [...text].length, max })}</span>
        {error && (
          <p className="field-error" id={`${id}-e`} role="alert">
            <IconAlertTriangle aria-hidden />
            <span>{error}</span>
          </p>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-3">
        <Button onClick={() => onOpenChange(false)}>{t("common:action.cancel")}</Button>
        <Button type="submit" variant="primary" loading={busy}>
          {confirm}
        </Button>
      </div>
    </form>
  );
}

/** Physician and coordinator differ in exactly two permissions. */
export function useDuties() {
  return { sign: useCan("note.sign"), decide: useCan("rx.decide"), reply: useCan("thread.reply"), manage: useCan("patient.manage"), review: useCan("visit.review") };
}

/** Name, age and sex in one line. */
export function PatientLine({ name, age, sex, size = 32 }: { name: string; age: number | null; sex: string | null; size?: number }) {
  const { t } = useTranslation("clinic");
  const detail = [age === null ? null : t("patient.age", { n: age }), sex ? t(`patient.sex.${sex}`) : null].filter(Boolean).join(t("patient.dot"));
  return (
    <span className="inline-flex min-w-0 items-center gap-2.5">
      <Avatar name={name} size={size} />
      <span className="min-w-0 truncate">
        <span className="font-semibold">{name}</span>
        {detail && <span className="ms-2 text-fg-2">{detail}</span>}
      </span>
    </span>
  );
}
