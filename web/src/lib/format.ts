// Date, time and number formatting. Dates in the contract are Asia/Taipei calendar dates.

const TZ = "Asia/Taipei";

/** Today as YYYY-MM-DD in Taipei. */
export function todayInTaipei(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Add days to a YYYY-MM-DD date (calendar arithmetic, no time zone effects). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function formatDate(value: string | null | undefined, locale: string): string {
  if (!value) return "—";
  const dt = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00+08:00`) : new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { timeZone: TZ, year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(dt);
}

export function formatDateTime(value: string | null | undefined, locale: string): string {
  if (!value) return "—";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    timeZone: TZ,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(dt);
}

export function formatTime(value: string | null | undefined, locale: string): string {
  if (!value) return "—";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(dt);
}

/** 840 ms -> "840 ms", 1240 ms -> "1.2 s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function formatCount(n: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(n);
}

/** 0.923 -> "92%". */
export function formatPercent(part: number, total: number, locale: string): string {
  if (total <= 0) return "—";
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(part / total);
}

/** Pretty-printed JSON for the expandable trace rows; never throws, and caps very large values. */
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
