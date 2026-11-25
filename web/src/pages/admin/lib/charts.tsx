import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { CalendarDate } from "@/api/types";
import { formatDate } from "@/lib/format";
import { cn, useLocale } from "@/ui";

/** A rounded axis maximum, so the top line has a readable number and bars always start at zero. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v) ?? 10 * p;
}

export interface DayValue {
  day: CalendarDate;
  value: number;
}

/**
 * One measure per chart, one bar per day, axis from zero. The readout names the day under the pointer (or the arrow
 * keys) and is the latest day otherwise. The same numbers are in the page's table view.
 */
export function DayBars({ title, data, format, axis, note, whole = true }: { title: string; data: DayValue[]; format: (n: number) => string; axis?: (n: number) => string; note?: ReactNode; whole?: boolean }) {
  const { t } = useTranslation("admin");
  const locale = useLocale();
  const id = useId();
  const [at, setAt] = useState<number | null>(null);
  const raw = Math.max(...data.map((d) => d.value), 0);
  const max = whole ? Math.max(1, Math.ceil(niceMax(raw))) : niceMax(raw);
  const ticks = whole && max < 4 ? Array.from({ length: max + 1 }, (_, i) => i) : [0, max / 2, max];
  const i = at ?? data.length - 1;
  const cur = data[i];
  const total = data.reduce((n, d) => n + d.value, 0);
  const label = axis ?? format;
  const everyDay = data.length <= 7;
  return (
    <figure className="m-0 min-w-0" aria-labelledby={id}>
      <figcaption id={id} className="flex flex-wrap items-baseline justify-between gap-x-4">
        <span className="font-bold">{title}</span>
        <span className="num text-sm text-fg-2">{t("chart.total", { value: format(total) })}</span>
      </figcaption>
      <p className="num text-sm text-fg-2" aria-live="off">
        {cur ? (
          <>
            {formatDate(cur.day, locale, "medium")} <b className="text-base text-fg">{format(cur.value)}</b>
          </>
        ) : (
          t("chart.none")
        )}
      </p>
      <div
        className="chart-plot"
        role="slider"
        tabIndex={0}
        aria-label={t("chart.slider", { title })}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, data.length - 1)}
        aria-valuenow={i}
        aria-valuetext={cur ? `${formatDate(cur.day, locale, "full")} ${format(cur.value)}` : undefined}
        onKeyDown={(e) => {
          const to = e.key === "ArrowLeft" || e.key === "ArrowDown" ? i - 1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? i + 1 : e.key === "Home" ? 0 : e.key === "End" ? data.length - 1 : null;
          if (to === null) return;
          e.preventDefault();
          setAt(Math.min(data.length - 1, Math.max(0, to)));
        }}
        onBlur={() => setAt(null)}
        onPointerLeave={() => setAt(null)}
      >
        <div className="chart-axis num" aria-hidden="true">
          {ticks.map((v) => (
            <span key={v} style={{ bottom: `${(v / max) * 100}%` }}>
              {label(v)}
            </span>
          ))}
        </div>
        <div className="chart-area" aria-hidden="true">
          {ticks.map((v) => (
            <i key={v} className="chart-line" data-zero={v === 0} style={{ bottom: `${(v / max) * 100}%` }} />
          ))}
          <div className="chart-bars">
            {data.map((d, n) => (
              <span key={d.day} data-active={n === at} onPointerEnter={() => setAt(n)}>
                <i style={{ height: `${(d.value / max) * 100}%` }} data-zero={d.value === 0} />
              </span>
            ))}
          </div>
        </div>
        <div className="chart-x num" aria-hidden="true">
          {data.map((d, n) =>
            everyDay || n === 0 || n === data.length - 1 || (data.length > 10 && n === Math.floor((data.length - 1) / 2)) ? (
              <span key={d.day} style={{ left: `${((n + 0.5) / data.length) * 100}%` }} data-edge={n === 0 && !everyDay ? "start" : n === data.length - 1 && !everyDay ? "end" : undefined}>
                {`${Number(d.day.slice(5, 7))}/${Number(d.day.slice(8, 10))}`}
              </span>
            ) : null,
          )}
        </div>
      </div>
      {note && <div className="mt-1 text-sm text-fg-2">{note}</div>}
    </figure>
  );
}

/** Counts by name: a real table whose last column draws the number. The axis is the largest count, from zero. */
export function CountBars({ caption, head, rows, empty, className }: { caption: string; head: [string, string]; rows: { key: string; label: ReactNode; n: number }[]; empty: ReactNode; className?: string }) {
  const max = Math.max(...rows.map((r) => r.n), 1);
  if (rows.length === 0) return <p className="text-fg-2">{empty}</p>;
  return (
    <table className={cn("count-bars", className)}>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{head[0]}</th>
          <th scope="col">{head[1]}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row">{r.label}</th>
            <td>
              <span className="num">{r.n}</span>
              <i aria-hidden="true" style={{ width: `${(r.n / max) * 100}%` }} data-zero={r.n === 0} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A share of something with its numerator and denominator always written out. */
export function ShareBar({ part, whole, label }: { part: number; whole: number; label: string }) {
  const ratio = whole > 0 ? Math.min(1, part / whole) : 0;
  return (
    <span className="share-bar" role="img" aria-label={label}>
      <i style={{ width: `${ratio * 100}%` }} data-zero={part === 0} />
    </span>
  );
}
