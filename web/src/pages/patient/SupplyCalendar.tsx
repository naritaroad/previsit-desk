import { useTranslation } from "react-i18next";

import type { MedicationCard } from "@/api/types";
import { addDays, formatDate } from "@/lib/format";
import { useLocale } from "@/ui";

/** Month tables: which days the medicine in hand covers, when the next fill can be collected, what was collected. */
export function SupplyCalendar({ med, today }: { med: MedicationCard; today: string }) {
  const { t } = useTranslation("patient");
  const locale = useLocale();
  const last = [med.supply_ends_on, med.next_window?.to ?? "", today].sort().at(-1)!;
  const months: string[] = [];
  for (let m = today.slice(0, 7); m <= last.slice(0, 7) && months.length < 4; m = nextMonth(m)) months.push(m);
  const fills = new Map(med.fills.map((x) => [x.filled_on, x]));
  const win = med.next_window;
  const firstFill = [...fills.keys()].sort()[0];
  const supply = (d: string) => Boolean(firstFill) && d >= firstFill && d <= med.supply_ends_on;
  const inWindow = (d: string) => Boolean(win && d >= win.from && d <= win.to);
  // Sunday first, as on calendars in Taiwan.
  const week = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 10, 1 + i))));
  return (
    <div>
      <div className="cal-months">
        {months.map((m) => {
          const days = daysOf(m);
          return (
            <table key={m} className="cal">
              <caption>{new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`))}</caption>
              <thead>
                <tr>
                  {week.map((w, i) => (
                    <th key={i} scope="col">
                      {w}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {days.map((row, i) => (
                  <tr key={i}>
                    {row.map((d, j) => {
                      if (!d) return <td key={j} data-out="true" />;
                      const fill = fills.get(d);
                      const words = [formatDate(d, locale, "medium"), d === today && t("cal.today"), fill && t("cal.fillN", { n: fill.n }), supply(d) ? t("cal.covered") : t("cal.notCovered"), inWindow(d) && t("cal.window")].filter(Boolean).join(t("common.listSep"));
                      return (
                        <td key={j} data-supply={supply(d)} data-window={inWindow(d)} data-fill={Boolean(fill)} data-today={d === today}>
                          <span aria-hidden="true">{Number(d.slice(8))}</span>
                          <span className="sr-only">{words}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        })}
      </div>
      <ul className="cal-key" aria-hidden="true">
        <li>
          <i data-k="supply" />
          {t("cal.covered")}
        </li>
        {win && (
          <li>
            <i data-k="window" />
            {t("cal.window")}
          </li>
        )}
        <li>
          <i data-k="fill" />
          {t("cal.fill")}
        </li>
        <li>
          <i data-k="today" />
          {t("cal.today")}
        </li>
      </ul>
    </div>
  );
}

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
}

function daysOf(month: string): (string | null)[][] {
  const first = `${month}-01`;
  const lead = new Date(`${first}T00:00:00Z`).getUTCDay();
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = first; d.slice(0, 7) === month; d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
}
