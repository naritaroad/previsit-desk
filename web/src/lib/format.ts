// Dates, times and numbers for zh-TW and en. Instants are shown in Asia/Taipei wherever the browser is;
// calendar dates (YYYY-MM-DD) are Taipei dates and never shift. Pure functions: pass `now` in tests.

import type { CalendarDate, Instant, Locale, PickupSlot } from "../api/types.ts";

export const TIME_ZONE = "Asia/Taipei";
const DASH = "—";
const DAY_MS = 86_400_000;

export type DateInput = string | number | Date | null | undefined;

const cache = new Map<string, Intl.DateTimeFormat>();
function dtf(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + JSON.stringify(options);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, ...options });
    cache.set(key, f);
  }
  return f;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  // Noon in Taipei: the calendar day is the same in every formatter option.
  const d = typeof value === "string" && DATE_ONLY.test(value) ? new Date(`${value}T12:00:00+08:00`) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The Taipei calendar day of an instant, as YYYY-MM-DD. */
export function taipeiDate(at: DateInput = new Date()): CalendarDate {
  return dtf("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(toDate(at) ?? new Date());
}
export const todayInTaipei = (now: Date = new Date()): CalendarDate => taipeiDate(now);

/** Calendar arithmetic without time zone effects. */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  const ms = (x: CalendarDate) => {
    const [y, m, d] = x.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / DAY_MS);
}

export function isValidDate(value: string): value is CalendarDate {
  if (!DATE_ONLY.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Instant of a Taipei wall-clock time: ("2026-11-26", "09:30") -> 2026-11-26T01:30:00Z. */
export function taipeiInstant(date: CalendarDate, time = "00:00"): Instant {
  return new Date(`${date}T${time}:00+08:00`).toISOString().replace(".000Z", "Z");
}

/** Value for <input type="datetime-local"> in Taipei time. */
export function toLocalInput(at: DateInput = new Date()): string {
  const d = toDate(at) ?? new Date();
  const parts = Object.fromEntries(
    dtf("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
/** The reverse of toLocalInput. */
export function fromLocalInput(value: string): Instant {
  const [date, time = "00:00"] = value.split("T");
  return taipeiInstant(date, time.slice(0, 5));
}

/** full 2026年11月25日（週三） · long 2026年11月25日 · medium 11月25日（三） · short 2026/11/25 · month_day 11月25日 */
export type DateStyle = "full" | "long" | "medium" | "short" | "month_day";

export function formatDate(value: DateInput, locale: Locale, style: DateStyle = "long"): string {
  const d = toDate(value);
  if (!d) return typeof value === "string" && value !== "" ? value : DASH;
  if (locale === "zh-TW") {
    const weekday = dtf(locale, { weekday: "narrow" }).format(d);
    const ymd = dtf(locale, { year: "numeric", month: "long", day: "numeric" }).format(d);
    const md = dtf(locale, { month: "long", day: "numeric" }).format(d);
    if (style === "full") return `${ymd}（週${weekday}）`;
    if (style === "long") return ymd;
    if (style === "medium") return `${md}（${weekday}）`;
    if (style === "month_day") return md;
    return dtf(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  }
  if (style === "full") return dtf(locale, { weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(d);
  if (style === "long") return dtf(locale, { year: "numeric", month: "long", day: "numeric" }).format(d);
  if (style === "medium") return dtf(locale, { weekday: "short", month: "short", day: "numeric" }).format(d);
  if (style === "month_day") return dtf(locale, { month: "short", day: "numeric" }).format(d);
  return dtf(locale, { year: "numeric", month: "short", day: "numeric" }).format(d);
}

/** 14:05 in both languages (24-hour clock). */
export function formatTime(value: DateInput, locale: Locale): string {
  const d = toDate(value);
  return d ? dtf(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d) : DASH;
}

/** 11月25日（三）14:05 / Wed, Nov 25, 14:05; the year is added when it is not the current one. */
export function formatDateTime(value: DateInput, locale: Locale, now: Date = new Date()): string {
  const d = toDate(value);
  if (!d) return DASH;
  const sameYear = taipeiDate(d).slice(0, 4) === taipeiDate(now).slice(0, 4);
  const date = formatDate(d, locale, sameYear ? "medium" : "short");
  const gap = locale === "en" ? ", " : sameYear ? "" : " ";
  return `${date}${gap}${formatTime(d, locale)}`;
}

export function formatDateRange(from: CalendarDate, to: CalendarDate, locale: Locale): string {
  if (from === to) return formatDate(from, locale, "month_day");
  const sep = locale === "zh-TW" ? "～" : " – ";
  return `${formatDate(from, locale, "month_day")}${sep}${formatDate(to, locale, "month_day")}`;
}

const rtf: Partial<Record<Locale, Intl.RelativeTimeFormat>> = {};
function relative(locale: Locale): Intl.RelativeTimeFormat {
  return (rtf[locale] ??= new Intl.RelativeTimeFormat(locale, { numeric: "auto" }));
}

/** 剛剛 / 5 分鐘前 / 昨天 / 3 天後; after a week the date itself. */
export function formatRelative(value: DateInput, locale: Locale, now: Date = new Date()): string {
  const d = toDate(value);
  if (!d) return DASH;
  const seconds = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return locale === "zh-TW" ? "剛剛" : "just now";
  if (abs < 3600) return relative(locale).format(Math.trunc(seconds / 60) || Math.sign(seconds), "minute");
  const days = daysBetween(taipeiDate(now), taipeiDate(d));
  if (days === 0) return relative(locale).format(Math.trunc(seconds / 3600), "hour");
  if (Math.abs(days) <= 7) return relative(locale).format(days, "day");
  return formatDate(d, locale, taipeiDate(d).slice(0, 4) === taipeiDate(now).slice(0, 4) ? "month_day" : "short");
}

/** Relative text for a calendar date: 今天, 明天, 3 天後, 2 天前. */
export function formatRelativeDay(date: CalendarDate, locale: Locale, today: CalendarDate = todayInTaipei()): string {
  return relative(locale).format(daysBetween(today, date), "day");
}

export interface Until {
  past: boolean;
  days: number;
  hours: number;
  minutes: number;
}
/** Time until (or since, when past) a deadline. */
export function untilParts(value: DateInput, now: Date = new Date()): Until | null {
  const d = toDate(value);
  if (!d) return null;
  const ms = d.getTime() - now.getTime();
  const total = Math.floor(Math.abs(ms) / 60_000);
  return { past: ms < 0, days: Math.floor(total / 1440), hours: Math.floor((total % 1440) / 60), minutes: total % 60 };
}

/** "3 小時 20 分鐘" / "3 hr 20 min": the distance to a deadline, without words such as 還有 or 逾時. */
export function formatSpan(value: DateInput, locale: Locale, now: Date = new Date()): string {
  const p = untilParts(value, now);
  if (!p) return DASH;
  const unit = (n: number, u: "day" | "hour" | "minute") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: locale === "zh-TW" ? "long" : "short" }).format(n);
  if (p.days >= 1) return p.days >= 3 || p.hours === 0 ? unit(p.days, "day") : `${unit(p.days, "day")} ${unit(p.hours, "hour")}`;
  if (p.hours >= 1)
    return p.hours >= 6 || p.minutes === 0 ? unit(p.hours, "hour") : `${unit(p.hours, "hour")} ${unit(p.minutes, "minute")}`;
  return unit(p.minutes, "minute");
}

/** 840 ms, 1.2 s, 2 min 5 s; for run and tool timings. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Uptime: 3 天 4 小時 / 3 days 4 hr. */
export function formatUptime(seconds: number, locale: Locale): string {
  return formatSpan(new Date(seconds * 1000), locale, new Date(0));
}

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

export function formatNumber(n: number | null | undefined, locale: Locale, maximumFractionDigits = 1): string {
  return finite(n) ? new Intl.NumberFormat(locale, { maximumFractionDigits }).format(n) : DASH;
}
export function formatCount(n: number | null | undefined, locale: Locale): string {
  return formatNumber(n, locale, 0);
}

/** 1.2 萬 / 12K, for axis labels and stat tiles. */
export function formatCompact(n: number | null | undefined, locale: Locale): string {
  return finite(n) ? new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n) : DASH;
}

/** A ratio 0..1 as a percentage; a dash when there is nothing to divide. */
export function formatPercent(ratio: number | null | undefined, locale: Locale, maximumFractionDigits = 0): string {
  return finite(ratio) ? new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits }).format(ratio) : DASH;
}

export function formatUsd(n: number | null | undefined, locale: Locale): string {
  if (!finite(n)) return DASH;
  const digits = n !== 0 && Math.abs(n) < 1 ? 4 : 2;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(n);
}

/** Age on a given day from a birth year (only the year is stored). */
export function ageFrom(birthYear: number | null, today: CalendarDate = todayInTaipei()): number | null {
  return birthYear === null ? null : Number(today.slice(0, 4)) - birthYear;
}

/** First `max` code points with an ellipsis; never cuts a surrogate pair. */
export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** A list joined the way the language does it: 甲、乙 / A, B. */
export function joinList(items: readonly string[], locale: Locale): string {
  return items.join(locale === "zh-TW" ? "、" : ", ");
}

/** Wall-clock range of a pickup slot, shown next to the translated slot name. */
export const PICKUP_HOURS: Readonly<Record<PickupSlot, readonly [string, string]>> = {
  morning: ["09:00", "12:00"],
  afternoon: ["14:00", "17:30"],
  evening: ["18:30", "21:00"],
};

/** Pretty JSON for trace rows; never throws and caps very large values. */
export function prettyJson(value: unknown, cap = 4000): string {
  if (value === undefined) return "";
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > cap ? `${text.slice(0, cap)}\n…` : text;
}
