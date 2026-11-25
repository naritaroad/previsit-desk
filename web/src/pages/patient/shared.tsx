// Small pieces every patient page uses: formatting in the reader's language, loading and error states, names.

import { IconCloudOff, IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "@/api/errors";
import type { DrugRef, PersonRef } from "@/api/types";
import type { DraftStatus, SaveStatus } from "@/data";
import { describeError } from "@/lib/errors";
import { formatDate, formatDateRange, formatDateTime, formatRelative, formatTime, joinList, type DateInput, type DateStyle } from "@/lib/format";
import { Banner, Button, EmptyState, ErrorState, SkeletonRows, useLocale, type SaveStatus as UiSaveStatus } from "@/ui";

export function useFmt() {
  const locale = useLocale();
  return useMemo(
    () => ({
      locale,
      date: (v: DateInput, style?: DateStyle) => formatDate(v, locale, style),
      dateTime: (v: DateInput) => formatDateTime(v, locale),
      time: (v: DateInput) => formatTime(v, locale),
      relative: (v: DateInput) => formatRelative(v, locale),
      range: (a: string, b: string) => formatDateRange(a, b, locale),
      list: (items: readonly string[]) => joinList(items, locale),
      drug: (d: DrugRef) => (locale === "en" ? d.name_en || d.name_zh : d.name_zh || d.name_en),
      drugAlt: (d: DrugRef) => (locale === "en" ? d.name_zh : d.name_en),
      drugClass: (d: DrugRef) => (locale === "en" ? d.class_en || d.class_zh : d.class_zh || d.class_en),
      /** 陳柏宇 醫師 / Po-Yu Chen, Physician */
      person: (p: PersonRef | null | undefined) => (p ? [p.display_name, p.title].filter(Boolean).join(locale === "en" ? ", " : " ") : ""),
    }),
    [locale],
  );
}

export function useErrorText() {
  const { t } = useTranslation("errors");
  return useCallback(
    (e: unknown) => {
      const d = describeError(e);
      return t(d.key, d.params);
    },
    [t],
  );
}

/** Seconds left of a Retry-After, counted down while shown. */
function useCountdown(seconds: number | null, stamp: unknown): number {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => {
    setLeft(seconds ?? 0);
    if (!seconds) return;
    const until = Date.now() + seconds * 1000;
    const id = setInterval(() => {
      const n = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setLeft(n);
      if (n === 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [seconds, stamp]);
  return left;
}

/** A request that failed, next to what asked for it. Says what happened and what to do; what was typed stays. */
export function ActionError({ error, onRetry, title, className, hideFields }: { error: unknown; onRetry?: () => void; title?: string; className?: string; hideFields?: boolean }) {
  const { t } = useTranslation(["patient", "errors"]);
  const limited = error instanceof ApiError && error.code === "rate_limited" ? (error.retryAfter ?? 30) : null;
  const left = useCountdown(limited, error);
  if (!error) return null;
  const d = describeError(error);
  const fields = !hideFields && error instanceof ApiError ? Object.values(error.fields).filter(Boolean) : [];
  const offline = error instanceof ApiError && error.code === "offline";
  return (
    <Banner
      tone="warn"
      role="alert"
      className={className}
      title={title}
      icon={offline ? <IconCloudOff aria-hidden /> : undefined}
      actions={
        onRetry && d.retryable ? (
          <Button size="sm" icon={<IconRefresh aria-hidden />} onClick={onRetry} disabled={left > 0}>
            {left > 0 ? t("patient:common.retryIn", { seconds: left }) : t("patient:common.retry")}
          </Button>
        ) : undefined
      }
    >
      {t(d.key, limited !== null ? { seconds: left || limited } : d.params)}
      {fields.length > 0 && (
        <ul className="mt-1">
          {fields.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
    </Banner>
  );
}

interface QueryLike<T> {
  data: T | undefined;
  error: unknown;
  isFetching: boolean;
  refetch: () => unknown;
}

/** Loading, failed, or the content. Cached data stays on screen when a refresh fails, with a line that says so. */
export function Gate<T>({ query, children, rows = 4, skeleton }: { query: QueryLike<T>; children: (data: T) => ReactNode; rows?: number; skeleton?: ReactNode }) {
  if (query.data !== undefined) {
    return (
      <>
        <StaleNote query={query} />
        {children(query.data)}
      </>
    );
  }
  if (query.error) return <LoadError error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  return <>{skeleton ?? <SkeletonRows rows={rows} />}</>;
}

/** Shown above older data when the newest could not be read. */
export function StaleNote({ query }: { query: Pick<QueryLike<unknown>, "data" | "error" | "isFetching" | "refetch"> }) {
  const { t } = useTranslation("patient");
  if (!query.error || query.data === undefined) return null;
  return (
    <Banner
      tone="warn"
      className="mb-stack no-print"
      icon={<IconCloudOff aria-hidden />}
      actions={
        <Button size="sm" onClick={() => void query.refetch()} loading={query.isFetching}>
          {t("common.refresh")}
        </Button>
      }
    >
      {t("common.staleShown")}
    </Banner>
  );
}

export function LoadError({ error, onRetry, retrying }: { error: unknown; onRetry?: () => void; retrying?: boolean }) {
  const { t } = useTranslation(["patient", "errors"]);
  const d = describeError(error);
  const missing = error instanceof ApiError && (error.code === "not_found" || error.code === "forbidden");
  if (missing) return <EmptyState title={<h1 tabIndex={-1}>{t("patient:common.notFoundTitle")}</h1>}>{t(d.key, d.params)}</EmptyState>;
  return (
    <ErrorState onRetry={d.retryable ? onRetry : undefined} retrying={retrying}>
      {t(d.key, d.params)}
    </ErrorState>
  );
}

/** Draft and wizard states in the words of the SaveState component. Idle drafts show nothing. */
export function uiSave(status: DraftStatus | SaveStatus, error?: unknown): UiSaveStatus | null {
  if (status === "idle") return null;
  if (status === "offline" && error) return "error";
  return status;
}

/** Debounced copy of a value, for search fields. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Re-render every `ms` so countdowns and "due" lines move. */
export function useNow(ms = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Medicine name with the other language under it, the way a medicine bag prints both. */
export function DrugName({ drug, className }: { drug: DrugRef; className?: string }) {
  const f = useFmt();
  const alt = f.drugAlt(drug);
  return (
    <span className={className}>
      <span className="block font-bold">{f.drug(drug)}</span>
      {alt && alt !== f.drug(drug) && <span className="block text-sm font-normal text-fg-2">{alt}</span>}
    </span>
  );
}
