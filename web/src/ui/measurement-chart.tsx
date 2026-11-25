import { useId } from "react";
import { useTranslation } from "react-i18next";
import { CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { Measurement, MeasurementKind } from "@/api/types";
import { formatDate, formatDateTime } from "@/lib/format";

import { cn } from "./cn";
import { useLocale } from "./locale";

export interface MeasurementChartProps {
  kind: MeasurementKind;
  items: Measurement[];
  /** Shaded reference range, only when the clinic has set one for this patient. Never a built-in norm. */
  target?: { from: number; to: number; label: string } | null;
  height?: number;
  className?: string;
}

interface Point {
  t: number;
  a: number | null;
  b: number | null;
  source: string;
}

/**
 * Patient readings over time. Series differ by stroke and marker as well as tone, and the same numbers are in a
 * table for screen readers and for printing. Own-reported readings are hollow, clinic readings solid.
 */
export function MeasurementChart({ kind, items, target, height = 240, className }: MeasurementChartProps) {
  const { t } = useTranslation("common");
  const locale = useLocale();
  const id = useId();
  const bp = kind === "bp";
  const data: Point[] = items
    .filter((m) => m.kind === kind)
    .map((m) => ({
      t: new Date(m.taken_at).getTime(),
      a: (bp ? m.values.systolic : m.values.value) ?? null,
      b: bp ? (m.values.diastolic ?? null) : null,
      source: m.source,
    }))
    .sort((x, y) => x.t - y.t);
  const unit = t(`measure.unit.${kind}`);
  const nameA = bp ? t("measure.systolic") : t(`measure.kind.${kind}`);
  const nameB = t("measure.diastolic");

  if (data.length === 0) return <p className="py-6 text-fg-2">{t("measure.empty")}</p>;

  const values = data.flatMap((d) => [d.a, d.b]).filter((v): v is number => v !== null);
  const lo = Math.min(...values, target?.from ?? Infinity);
  const hi = Math.max(...values, target?.to ?? -Infinity);
  const pad = Math.max(2, (hi - lo) * 0.15);
  const domain: [number, number] = [Math.floor((lo - pad) / 5) * 5, Math.ceil((hi + pad) / 5) * 5];
  const last = data.at(-1)!;

  const dot = (shape: "circle" | "square") =>
    function Dot(p: { cx?: number; cy?: number; payload?: Point; index?: number }) {
      if (p.cx === undefined || p.cy === undefined || Number.isNaN(p.cy)) return <g key={p.index} />;
      const own = p.payload?.source === "patient";
      const common = { fill: own ? "var(--surface)" : "var(--ink)", stroke: "var(--ink)", strokeWidth: 2 };
      return shape === "circle" ? <circle key={p.index} cx={p.cx} cy={p.cy} r={4} {...common} /> : <rect key={p.index} x={p.cx - 3.5} y={p.cy - 3.5} width={7} height={7} {...common} />;
    };

  return (
    <figure className={cn("m-0", className)} aria-labelledby={id}>
      <figcaption id={id} className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="num text-2xl font-bold">
          {last.a}
          {bp && `/${last.b}`}
        </span>
        <span className="text-fg-2">
          {unit}
          <span className="ms-3 text-sm">{t("measure.latest", { date: formatDateTime(new Date(last.t), locale) })}</span>
        </span>
        <span className="ms-auto flex flex-wrap gap-x-4 text-sm text-fg-2" aria-hidden="true">
          <Legend shape="circle" label={nameA} />
          {bp && <Legend shape="square" dashed label={nameB} />}
        </span>
      </figcaption>
      <div style={{ height }} aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }} accessibilityLayer={false}>
            <CartesianGrid stroke="var(--rule)" vertical={false} />
            {target && <ReferenceArea y1={target.from} y2={target.to} fill="var(--ink-soft)" fillOpacity={1} />}
            <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(v: number) => formatDate(new Date(v), locale, "month_day")} tick={{ fill: "var(--fg-2)", fontSize: 13 }} stroke="var(--rule-strong)" tickLine={false} minTickGap={40} />
            <YAxis domain={domain} tick={{ fill: "var(--fg-2)", fontSize: 13 }} axisLine={false} tickLine={false} width={44} />
            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke: "var(--rule-strong)" }}
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload as Point | undefined;
                if (!active || !p) return null;
                return (
                  <div className="popup px-3 py-2 text-sm">
                    <p className="num font-bold">
                      {p.a}
                      {bp && `/${p.b}`} <span className="font-normal text-fg-2">{unit}</span>
                    </p>
                    <p className="text-fg-2">{formatDateTime(new Date(p.t), locale)}</p>
                    <p className="text-fg-2">{t(`status.source.${p.source}`)}</p>
                  </div>
                );
              }}
            />
            <Line type="linear" dataKey="a" stroke="var(--ink)" strokeWidth={2} dot={dot("circle")} activeDot={{ r: 6, fill: "var(--ink)" }} isAnimationActive={false} connectNulls />
            {bp && <Line type="linear" dataKey="b" stroke="var(--ink)" strokeWidth={2} strokeDasharray="5 4" dot={dot("square")} activeDot={{ r: 6, fill: "var(--ink)" }} isAnimationActive={false} connectNulls />}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {target && <p className="mt-1 text-sm text-fg-2">{target.label}</p>}
      <table className="sr-only">
        <caption>{t(`measure.kind.${kind}`)}</caption>
        <thead>
          <tr>
            <th scope="col">{t("measure.when")}</th>
            <th scope="col">{nameA}</th>
            {bp && <th scope="col">{nameB}</th>}
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.t}>
              <td>{formatDateTime(new Date(d.t), locale)}</td>
              <td>{d.a}</td>
              {bp && <td>{d.b}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function Legend({ shape, label, dashed }: { shape: "circle" | "square"; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="28" height="12" aria-hidden="true" focusable="false">
        <path d="M0 6h28" stroke="var(--ink)" strokeWidth="2" strokeDasharray={dashed ? "5 4" : undefined} />
        {shape === "circle" ? <circle cx="14" cy="6" r="4" fill="var(--ink)" /> : <rect x="10.5" y="2.5" width="7" height="7" fill="var(--ink)" />}
      </svg>
      {label}
    </span>
  );
}
