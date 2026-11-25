import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useLocale, useMediaQuery } from "@/ui";

import { useList } from "./common";

interface Part {
  t: string;
  m?: number;
}
interface Turn {
  who: "ai" | "patient";
  parts: Part[];
}
interface FieldRow {
  label: string;
  value: string;
  m: number;
  missing?: boolean;
  blank?: boolean;
}
interface Line {
  m: number;
  d: string;
}

/**
 * What a patient said, beside what the doctor reads, with a drawn line from each sentence to its field. On a narrow
 * screen the two are stacked and the numbers carry the link; choosing a field marks its sentence either way.
 */
export function Excerpt() {
  const { t } = useTranslation("public");
  const ts = useList();
  const turns = ts<Turn[]>("home.excerpt.turns");
  const fields = ts<FieldRow[]>("home.excerpt.fields");
  const locale = useLocale();
  const [active, setActive] = useState(1);
  const [lines, setLines] = useState<Line[]>([]);
  const wide = useMediaQuery("(min-width: 64rem)");
  const box = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const root = box.current;
    if (!root) return;
    const o = root.getBoundingClientRect();
    const chat = root.querySelector(".excerpt-chat")?.getBoundingClientRect();
    if (!chat) return;
    const marks = [...root.querySelectorAll<HTMLElement>("[data-mark]")];
    const next: Line[] = [];
    marks.forEach((el, i) => {
      const m = Number(el.dataset.mark);
      const row = root.querySelector<HTMLElement>(`[data-field="${m}"]`)?.getBoundingClientRect();
      const rect = [...el.getClientRects()].at(-1);
      if (!row || !rect) return;
      // Sentences that share a line of text leave it at different heights.
      const after = marks.slice(i + 1).filter((other) => Math.abs(other.getBoundingClientRect().bottom - rect.bottom) < 4).length;
      const x1 = rect.right - o.left;
      const y1 = rect.bottom - o.top - 1 + after * 4;
      const x2 = row.left - o.left;
      const y2 = row.top + row.height / 2 - o.top;
      // Each line has its own lane in the gutter, so no two run on top of each other.
      const gutter = row.left - chat.right;
      const lane = chat.right - o.left + (gutter * (i + 1.5)) / (marks.length + 2);
      next.push({ m, d: `M${x1.toFixed(1)} ${y1.toFixed(1)}H${lane.toFixed(1)}V${y2.toFixed(1)}H${x2.toFixed(1)}` });
    });
    setLines(next);
  }, []);

  useLayoutEffect(() => {
    if (wide) measure();
  }, [wide, measure, locale]);
  useEffect(() => {
    if (!wide || !box.current) return;
    const ro = new ResizeObserver(measure);
    ro.observe(box.current);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [wide, measure]);

  return (
    <div className="excerpt" ref={box}>
      <svg className="excerpt-lines" aria-hidden="true" focusable="false">
        {lines.map((l) => (
          <path key={l.m} d={l.d} data-active={l.m === active} />
        ))}
        {lines
          .filter((l) => l.m === active)
          .map((l) => (
            <path key={`a${l.m}`} d={l.d} data-active="true" pathLength={1} className="draw" />
          ))}
      </svg>
      <ol className="excerpt-chat" aria-label={t("home.excerpt.chatLabel")}>
        {turns.map((turn, i) => (
          <li key={i} data-who={turn.who}>
            <p className="excerpt-who">{t(turn.who === "ai" ? "home.excerpt.ai" : "home.excerpt.patient")}</p>
            <p className="excerpt-say">
              {turn.parts.map((p, j) =>
                p.m ? (
                  <span key={j} data-mark={p.m} data-active={p.m === active} className="excerpt-mark">
                    {p.t}
                    <sup className="num" aria-hidden="true">
                      {p.m}
                    </sup>
                  </span>
                ) : (
                  <span key={j}>{p.t}</span>
                ),
              )}
            </p>
          </li>
        ))}
      </ol>
      <div className="excerpt-sheet form-sheet">
        <div className="form-sheet-title">
          <span>{t("home.excerpt.sheetTitle")}</span>
          <span>{t("home.excerpt.sheetNote")}</span>
        </div>
        <ul>
          {fields.map((f) => (
            <li key={f.label} data-field={f.m || undefined} data-active={f.m > 0 && f.m === active} data-blank={f.blank} data-missing={f.missing}>
              {f.m > 0 ? (
                <button type="button" aria-pressed={f.m === active} onClick={() => setActive(f.m)} onMouseEnter={() => setActive(f.m)} onFocus={() => setActive(f.m)}>
                  <span className="excerpt-label">{f.label}</span>
                  <span className="excerpt-value">{f.value}</span>
                  <span className="excerpt-no num" aria-hidden="true">
                    {f.m}
                  </span>
                  <span className="sr-only">
                    {t("home.excerpt.from", {
                      label: turns
                        .flatMap((x) => x.parts)
                        .filter((p) => p.m === f.m)
                        .map((p) => p.t)
                        .join(""),
                    })}
                  </span>
                </button>
              ) : (
                <div>
                  <span className="excerpt-label">{f.label}</span>
                  <span className="excerpt-value">{f.value}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
