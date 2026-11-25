// Result of the refill check: one of four outcomes, each with its own icon, label and outline shape
// (colour is only the fourth cue). Server text (title, message, reasons, rules) is shown as sent.

import { forwardRef, useId } from "react";
import { useTranslation } from "react-i18next";

import type { RefillOutcome, RefillResult } from "../api/types.ts";
import { currentLocale } from "../i18n/index.ts";
import { addDays, formatDate } from "../lib/format.ts";
import { Icon, type IconName } from "./Icon.tsx";

const ICON: Record<RefillOutcome, IconName> = {
  eligible: "check-circle",
  too_early: "clock",
  revisit: "calendar",
  consult: "person-chat",
};
const CLASS: Record<RefillOutcome, string> = {
  eligible: "rcard--eligible",
  too_early: "rcard--too-early",
  revisit: "rcard--revisit",
  consult: "rcard--consult",
};

/** Only http(s) links from the server are rendered as links. */
function safeUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function daysBetween(from: string, to: string): number {
  let n = 0;
  let d = from;
  // Small loop on purpose: the gap is at most a few months and this avoids time zone arithmetic.
  while (d < to && n < 400) {
    d = addDays(d, 1);
    n += 1;
  }
  return n;
}

interface Props {
  result: RefillResult;
  compact?: boolean;
  /** h2 on the patient page (no section heading above it), h3 inside a clinician card. */
  headingLevel?: 2 | 3;
}

export const RefillResultCard = forwardRef<HTMLElement, Props>(function RefillResultCard({ result, compact = false, headingLevel = 3 }, ref) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const { t } = useTranslation();
  const locale = currentLocale();
  const titleId = useId();
  const outcome = result.outcome;

  const dates: { label: string; value: string }[] = [];
  if (result.earliest_date) {
    dates.push({ label: t(outcome === "too_early" ? "refill.earliest" : "refill.windowFrom"), value: formatDate(result.earliest_date, locale) });
  }
  if (outcome === "too_early" && result.earliest_date) {
    dates.push({ label: t("refill.waitLabel"), value: t("refill.waitDays", { count: daysBetween(result.today, result.earliest_date) }) });
  }
  if (outcome === "eligible" && result.next_fill_number) {
    dates.push({ label: t("refill.nextFill"), value: t("refill.fillNumber", { n: result.next_fill_number }) });
  }
  if (result.latest_date) dates.push({ label: t("refill.validUntil"), value: formatDate(result.latest_date, locale) });
  if (outcome === "consult") dates.length = 0;

  return (
    <article ref={ref} tabIndex={-1} className={`rcard ${CLASS[outcome]}${compact ? " rcard--compact" : ""}`} aria-labelledby={titleId}>
      <div className="rcard__head">
        <div className="rcard__icon">
          <Icon name={ICON[outcome]} size="lg" />
        </div>
        <div className="grow">
          <div className="rcard__label">{t(`refill.outcome.${outcome}`)}</div>
          <Heading className="rcard__title" id={titleId}>
            {result.title}
          </Heading>
        </div>
      </div>
      <p className="rcard__msg">{result.message}</p>
      {dates.length ? (
        <dl className="rcard__dates">
          {dates.map((d) => (
            <div key={d.label} className="rcard__date">
              <dt>{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {result.reasons.length ? (
        <ul className="rcard__reasons">
          {result.reasons.map((r) => (
            <li key={r.code}>{r.text}</li>
          ))}
        </ul>
      ) : null}
      {result.ticket_no ? (
        <div className="rcard__ticket">
          <Icon name="ticket" size="sm" />
          <span>
            {t("refill.ticketLead")} <b className="mono">{result.ticket_no}</b>
          </span>
        </div>
      ) : null}
      {result.rules.length ? (
        <details className="rcard__rules">
          <summary>{t("refill.rules", { count: result.rules.length })}</summary>
          <ul className="rcard__rule-list">
            {result.rules.map((r) => {
              const href = safeUrl(r.source_url);
              return (
                <li key={r.key}>
                  {r.text}{" "}
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {t("refill.source")}
                      <span className="visually-hidden">{t("refill.opensNewTab")}</span>
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </article>
  );
});
