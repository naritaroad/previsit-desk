// Small hooks and pure helpers shared by the clinic pages.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";

import type { NoteSection, PersonRef, WorkItem } from "@/api/types";
import { useSavedFilter } from "@/data";
import { describeError } from "@/lib/errors";
import { formatDate, formatDateTime, formatPercent, formatRelative, formatSpan, formatTime, joinList, taipeiDate, untilParts, type DateInput, type DateStyle } from "@/lib/format";
import { useLocale } from "@/ui";

/** Formatters bound to the interface language. */
export function useFmt() {
  const locale = useLocale();
  return useMemo(
    () => ({
      locale,
      time: (v: DateInput) => formatTime(v, locale),
      dateTime: (v: DateInput) => formatDateTime(v, locale),
      date: (v: DateInput, style: DateStyle = "medium") => formatDate(v, locale, style),
      rel: (v: DateInput) => formatRelative(v, locale),
      span: (v: DateInput, now?: Date) => formatSpan(v, locale, now),
      percent: (v: number | null | undefined) => formatPercent(v, locale),
      list: (v: readonly string[]) => joinList(v, locale),
      /** Time alone today, date and time on other days. */
      stamp: (v: DateInput) => (v && taipeiDate(v) === taipeiDate() ? formatTime(v, locale) : formatDateTime(v, locale)),
    }),
    [locale],
  );
}
export type Fmt = ReturnType<typeof useFmt>;

/** What went wrong, in the reader's language. */
export function useErrorText() {
  const { t } = useTranslation("errors");
  return useCallback(
    (e: unknown): string => {
      const d = describeError(e);
      return t(d.key, d.params ?? {});
    },
    [t],
  );
}

/** URL search parameters as flat state: defaults stay out of the address, other parameters are kept. */
export function useUrlState<T extends Record<string, string>>(defaults: T): [T, (part: Partial<T>) => void] {
  const [params, setParams] = useSearchParams();
  const value = { ...defaults };
  for (const k of Object.keys(defaults) as (keyof T & string)[]) {
    const v = params.get(k);
    if (v !== null) value[k] = v as T[typeof k];
  }
  const set = (part: Partial<T>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(part)) {
          if (v === undefined || v === "" || v === defaults[k]) next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  return [value, set];
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

/** Re-render every minute, for countdowns. */
export function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** A list kept as JSON text inside the account's saved filters (views, canned replies). */
export function useSavedList<T>(name: string, initial: readonly T[]): [readonly T[], (next: readonly T[]) => void] {
  const [raw, set] = useSavedFilter(name, { items: "" });
  const items = useMemo<readonly T[] | null>(() => {
    if (!raw.items) return null;
    try {
      const v: unknown = JSON.parse(raw.items);
      return Array.isArray(v) ? (v as T[]) : null;
    } catch {
      return null;
    }
  }, [raw.items]);
  return [items ?? initial, (next) => set({ items: JSON.stringify(next) })];
}

export type ClinicDensity = "compact" | "comfortable";
/** Staff lists start compact whatever the account chose for other screens. */
export function useClinicDensity(): [ClinicDensity, (d: ClinicDensity) => void] {
  const [v, set] = useSavedFilter("clinic.view", { density: "compact" });
  return [v.density === "comfortable" ? "comfortable" : "compact", (density) => set({ density })];
}

export const personLabel = (p: PersonRef | null | undefined): string => (p ? [p.display_name, p.title].filter(Boolean).join(" ") : "");
export const samePerson = (a: { id: string } | null | undefined, b: { id: string } | null | undefined): boolean => !!a && !!b && a.id === b.id;

/** Items whose clock has stopped are never overdue. */
const STOPPED: ReadonlySet<string> = new Set(["approved", "partially_approved", "at_pharmacy", "ready", "dispensed", "declined", "visit_required", "more_info", "cancelled", "resolved"]);
export function isOverdue(item: Pick<WorkItem, "type" | "due_at" | "status">, now: Date): boolean {
  if (item.status === "overdue") return true;
  if (item.type !== "rx" || !item.due_at || STOPPED.has(item.status)) return false;
  return untilParts(item.due_at, now)?.past ?? false;
}
/** A visit linked to one of today's appointments. */
export const isTodayClinic = (item: Pick<WorkItem, "type" | "due_at">, now: Date): boolean => item.type === "visit" && item.due_at !== null && taipeiDate(item.due_at) === taipeiDate(now);

export const NOTE_SECTIONS: readonly NoteSection[] = ["subjective", "objective", "assessment", "plan", "patient_message"];
export const NOTE_MAX = 4000;
