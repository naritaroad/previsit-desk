import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { useTrustFacts } from "@/data";
import { addDays, daysBetween, formatDate, todayInTaipei } from "@/lib/format";
import { safeExternalUrl } from "@/lib/links";
import { Button, ExternalLink, IconButton, RefillStrip, useLocale } from "@/ui";

import { useResumed } from "../lib/live";
import { axisOf, DEMO_RX, type DemoRxInput, fillOn, viewOn } from "../lib/refillDemo";

/** Half the width of the (invisible) slider thumb: the slider overhangs by this much, so its ends are the strip's. */
const THUMB = 22;

/**
 * The refill strip with its day line as a handle. Everything is worked out here; only the wording of the rule is the
 * server's. The handle is a range input laid over the strip, so arrow keys, Home/End and screen readers work too.
 */
export function RefillDemo({ rule = true }: { rule?: boolean }) {
  const { t } = useTranslation("public");
  const locale = useLocale();
  const facts = useResumed(useTrustFacts());
  const id = useId();
  const today = useMemo(() => todayInTaipei(), []);
  const issuedOn = addDays(today, -DEMO_RX.issuedDaysAgo);
  const [day, setDay] = useState(today);
  const [fills, setFills] = useState<string[]>([issuedOn]);
  const stage = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<CSSProperties | null>(null);

  const rx: DemoRxInput = { issuedOn, totalDays: DEMO_RX.totalDays, daysPerFill: DEMO_RX.daysPerFill, fills, pharmacy: t("home.strip.pharmacy") };
  const view = viewOn(rx, day);
  const axis = axisOf(view.strip);
  const span = daysBetween(axis.start, axis.end);
  const index = Math.min(span, daysBetween(axis.start, day));
  const move = (i: number) => setDay(addDays(axis.start, Math.min(span, Math.max(0, i))));

  // Where the kit drew the flag row and the cells.
  useLayoutEffect(() => {
    const root = stage.current;
    if (!root) return;
    const place = () => {
      const strip = root.querySelector(".refill-strip")?.getBoundingClientRect();
      const cells = root.querySelector(".refill-cells")?.getBoundingClientRect();
      if (!strip || !cells) return;
      const o = root.getBoundingClientRect();
      setArea({ top: strip.top - o.top, height: cells.bottom - strip.top + 18, left: cells.left - o.left - THUMB, width: cells.width + THUMB * 2 });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  const state = t(`home.strip.state.${view.state}`, { n: view.nextFill ?? "", days: view.gapDays, date: view.opensOn ? formatDate(view.opensOn, locale, "month_day") : "" });
  const changed = day !== today || fills.length !== 1;
  const early = facts.data?.refill_rules?.find((r) => r.key === "early_window_days");
  const source = safeExternalUrl(early?.source_url);

  return (
    <div className="refill-demo">
      <div className="refill-demo-stage" ref={stage}>
        <RefillStrip med={view.strip} today={day} />
        <label htmlFor={id} className="sr-only">
          {t("home.strip.slider")}
        </label>
        <input
          id={id}
          type="range"
          className="day-range"
          style={area ?? undefined}
          min={0}
          max={span}
          step={1}
          value={index}
          aria-valuetext={t("home.strip.valueText", { date: formatDate(day, locale, "long"), state })}
          onChange={(e) => move(Number(e.target.value))}
        />
      </div>
      <div className="refill-demo-controls">
        <div className="refill-demo-day">
          <span className="field-label" aria-hidden="true">
            {t("home.strip.slider")}
          </span>
          <IconButton label={t("home.strip.prev")} tooltip={false} variant="bordered" disabled={index <= 0} onClick={() => move(index - 1)}>
            <IconChevronLeft size={20} aria-hidden />
          </IconButton>
          <output htmlFor={id} className="num day-out">
            {formatDate(day, locale, "medium")}
          </output>
          <IconButton label={t("home.strip.next")} tooltip={false} variant="bordered" disabled={index >= span} onClick={() => move(index + 1)}>
            <IconChevronRight size={20} aria-hidden />
          </IconButton>
        </div>
        <p className="refill-demo-state" data-ok={view.canFill} aria-live="polite">
          {state}
        </p>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Button variant="soft" disabled={!view.canFill} onClick={() => setFills(fillOn(rx, day))}>
            {t("home.strip.fill", { date: formatDate(day, locale, "month_day"), n: view.nextFill ?? DEMO_RX.totalDays / DEMO_RX.daysPerFill })}
          </Button>
          {changed && (
            <button
              type="button"
              className="link inline-flex min-h-11 items-center"
              onClick={() => {
                setDay(today);
                setFills([issuedOn]);
              }}
            >
              {fills.length > 1 ? t("home.strip.reset") : t("home.strip.today")}
            </button>
          )}
        </div>
      </div>
      {rule && (
        <p className="refill-demo-rule">
          {t("home.strip.rule")}
          {early ? early.text : t("home.strip.ruleFallback")}
          {source && (
            <>
              {" "}
              <ExternalLink href={source}>{t("home.strip.ruleSource")}</ExternalLink>
            </>
          )}
        </p>
      )}
    </div>
  );
}
