import { useId, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import type { CalendarDate, Fill, MedicationState } from "@/api/types";
import { addDays, daysBetween, formatDate, formatDateRange, todayInTaipei } from "@/lib/format";

import { cn } from "./cn";
import { useLocale } from "./locale";

/** The part of MedicationCard the strip needs, so a card can be passed as it is. */
export interface RefillStripData {
  issued_on: CalendarDate;
  valid_until: CalendarDate;
  days_per_fill: number;
  fills_allowed: number;
  fills: Pick<Fill, "n" | "filled_on" | "pharmacy_name">[];
  supply_ends_on: CalendarDate;
  next_window: { from: CalendarDate; to: CalendarDate } | null;
  state: MedicationState;
}

export interface RefillStripProps {
  med: RefillStripData;
  today?: CalendarDate;
  /** "full" has the readout and the date axis, "compact" is the cells alone (tables, lists). */
  size?: "full" | "compact";
  className?: string;
}

const md = (d: CalendarDate) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/**
 * Signature element: the dispensing cells of a 慢箋. Each cell is one dispensing drawn to a common time scale, so
 * the same strip shows which fills are done (date stamp), how long the supply lasts, the window for the next one
 * and where today falls. All numbers come from the API; nothing is computed about eligibility here.
 */
export function RefillStrip({ med, today = todayInTaipei(), size = "full", className }: RefillStripProps) {
  const { t } = useTranslation("common");
  const locale = useLocale();
  const id = useId();

  // Where each dispensing sits: filled ones where they happened, the next from its window, later ones after it.
  const fills = [...med.fills].sort((a, b) => a.n - b.n);
  const cells: { n: number; from: CalendarDate; to: CalendarDate; fill: (typeof fills)[number] | null }[] = [];
  for (let n = 1; n <= med.fills_allowed; n++) {
    const fill = fills.find((f) => f.n === n) ?? null;
    const prevEnd = cells.at(-1)?.to ?? med.issued_on;
    const from = fill ? (fill.filled_on < prevEnd && n > 1 ? prevEnd : fill.filled_on) : prevEnd;
    cells.push({ n, from, to: addDays(from, med.days_per_fill), fill });
  }
  const end = [cells.at(-1)?.to ?? med.valid_until, med.valid_until].sort().at(-1)!;
  const start = [cells[0]?.from ?? med.issued_on, med.issued_on].sort()[0];
  const span = Math.max(1, daysBetween(start, end));
  const pos = (d: CalendarDate) => Math.min(100, Math.max(0, (daysBetween(start, d) / span) * 100));
  const next = cells.find((c) => !c.fill) ?? null;
  const win = med.next_window;
  const open = win !== null && today >= win.from && today <= win.to;
  const inRange = today >= start && today <= end;
  const last = cells.at(-1);
  // From the end of the last supply to the date the prescription lapses.
  const tail = last && med.valid_until > last.to ? 100 - pos(last.to) : 0;
  const mid = win ? (pos(win.from) + pos(win.to)) / 2 : 0;
  const done = med.state === "finished" || med.state === "expired";

  const readout = win
    ? open
      ? { big: t("refill.openNow"), small: t("refill.openUntil", { n: next?.n ?? "", date: formatDate(win.to, locale, "medium"), count: daysBetween(today, win.to) }) }
      : today < win.from
        ? { big: t("refill.inDays", { count: daysBetween(today, win.from) }), small: t("refill.windowIs", { n: next?.n ?? "", range: formatDateRange(win.from, win.to, locale) }) }
        : { big: t("refill.late"), small: t("refill.lateBody", { date: formatDate(win.to, locale, "medium") }) }
    : done
      ? { big: t(`refill.${med.state}`), small: t("refill.validUntil", { date: formatDate(med.valid_until, locale, "long") }) }
      : { big: t("refill.noWindow"), small: t("refill.supplyTo", { date: formatDate(med.supply_ends_on, locale, "medium") }) };

  const spoken = [
    t("refill.spokenFills", { done: fills.length, total: med.fills_allowed }),
    ...fills.map((f) => t("refill.spokenFill", { n: f.n, date: formatDate(f.filled_on, locale, "long"), pharmacy: f.pharmacy_name })),
    t("refill.supplyTo", { date: formatDate(med.supply_ends_on, locale, "long") }),
    readout.small,
  ].join(t("list.sentenceSep"));

  if (size === "compact") {
    return (
      <span className={cn("refill-mini", className)} role="img" aria-label={spoken}>
        {cells.map((c) => (
          <span key={c.n} data-state={c.fill ? "done" : c === next ? (open ? "open" : "next") : "later"} className="num">
            {c.n}
          </span>
        ))}
      </span>
    );
  }

  return (
    <figure className={cn("refill @container/refill [container-name:refill]", className)} aria-labelledby={`${id}-c`}>
      <figcaption id={`${id}-c`} className="refill-readout">
        <span className="refill-big" data-open={open}>
          {readout.big}
        </span>
        <span className="refill-small">{readout.small}</span>
      </figcaption>
      <p className="sr-only">{spoken}</p>
      <div className="refill-strip" aria-hidden="true">
        {inRange && (
          <div className="refill-today" style={{ "--x": `${pos(today)}%` } as CSSProperties} data-edge={pos(today) > 82 ? "end" : pos(today) < 14 ? "start" : undefined}>
            <span>{t("refill.today", { date: md(today) })}</span>
          </div>
        )}
        <div className="refill-cells">
          {cells.map((c) => (
            <div key={c.n} className="refill-cell" data-state={c.fill ? "done" : c === next ? "next" : "later"} style={{ left: `${pos(c.from)}%`, width: `${pos(c.to) - pos(c.from)}%` }}>
              <span className="refill-n">{c.n}</span>
              {c.fill && <Stamp date={c.fill.filled_on} label={t("refill.stamp")} />}
              {!c.fill && c === next && <span className="refill-cell-note">{open ? t("refill.cellOpen") : t("refill.cellNext")}</span>}
            </div>
          ))}
          {win && <div className="refill-window" data-open={open} style={{ left: `${pos(win.from)}%`, width: `max(0.75rem, ${pos(win.to) - pos(win.from)}%)` }} />}
          {tail > 0.5 && <div className="refill-tail" style={{ width: `${tail}%` }} />}
        </div>
        <div className="refill-axis">
          {win && (
            <span className="refill-label" style={{ "--x": `${mid}%` } as CSSProperties} data-edge={mid > 88 ? "end" : mid < 12 ? "start" : undefined}>
              {t("refill.lWindow")}
            </span>
          )}
          {tail > 0.5 && (!win || mid < 70) && (
            <span className="refill-label" data-edge="end">
              {t("refill.lValid")} <b className="num">{md(med.valid_until)}</b>
            </span>
          )}
        </div>
      </div>
      <dl className="refill-dates">
        <div>
          <dt>{t("refill.dIssued")}</dt>
          <dd>{formatDate(med.issued_on, locale, "short")}</dd>
        </div>
        <div>
          <dt>{t("refill.dSupply")}</dt>
          <dd>{formatDate(med.supply_ends_on, locale, "short")}</dd>
        </div>
        {win && (
          <div>
            <dt>
              <span className="refill-key" data-open={open} aria-hidden="true" />
              {t("refill.lWindow")}
            </dt>
            <dd>
              {md(win.from)}
              {locale === "zh-TW" ? "\uff5e" : " to "}
              {md(win.to)}
            </dd>
          </div>
        )}
        <div>
          <dt>
            {tail > 0.5 && <span className="refill-key" data-kind="tail" aria-hidden="true" />}
            {t("refill.lValid")}
          </dt>
          <dd>{formatDate(med.valid_until, locale, "short")}</dd>
        </div>
      </dl>
    </figure>
  );
}

/** The round date stamp a dispensing desk puts on the prescription. */
function Stamp({ date, label }: { date: CalendarDate; label: string }) {
  const [, m, d] = date.split("-");
  return (
    <svg className="refill-stamp" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <circle cx="32" cy="32" r="30" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="32" cy="32" r="26.5" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M6.6 24.5h50.8M6.6 40.5h50.8" stroke="currentColor" strokeWidth="1" />
      <text x="32" y="20" textAnchor="middle" fontSize="9.5" fontWeight="600" fill="currentColor">
        {label}
      </text>
      <text x="32" y="37.6" textAnchor="middle" fontSize="14" fontWeight="700" fill="currentColor">
        {`${m}.${d}`}
      </text>
      <text x="32" y="51.5" textAnchor="middle" fontSize="9.5" fontWeight="600" fill="currentColor">
        {date.slice(0, 4)}
      </text>
    </svg>
  );
}
