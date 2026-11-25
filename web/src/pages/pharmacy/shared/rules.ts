// The rule data as the pages show it. The Rust server and the typed contract spell some of these objects
// differently; both spellings end up in the same rows here, so a missing source or form shows as "not given" and
// never as an invented value.

import type { Disposition, DrugRef, FormularyItem, Locale, RenewalScope } from "@/api/types";

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Loose) : {});
const list = (v: unknown): Loose[] => (Array.isArray(v) ? v.map(obj) : []);
const text = (...values: unknown[]): string | null => {
  for (const v of values) if (typeof v === "string" && v.trim() !== "") return v;
  return null;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface FormularyRow extends DrugRef {
  scope: RenewalScope;
  reason: string;
  form: string | null;
  strengths: string[];
  sourceType: string | null;
  sourceUrl: string | null;
  verifiedOn: string | null;
}
export function formularyRow(item: FormularyItem): FormularyRow {
  const x = item as unknown as Loose;
  return {
    drug_id: item.drug_id,
    name_zh: item.name_zh,
    name_en: item.name_en,
    class_id: item.class_id,
    class_zh: item.class_zh,
    class_en: item.class_en,
    controlled_level: item.controlled_level,
    scope: (text(x.renewal_scope, x.scope) ?? "physician_only") as RenewalScope,
    reason: text(x.reason, x.scope_reason) ?? "",
    form: text(x.form),
    strengths: Array.isArray(x.strengths) ? x.strengths.map(String) : [],
    sourceType: text(x.source_type),
    sourceUrl: text(x.source_url),
    verifiedOn: text(x.verified_on),
  };
}

export interface RuleLine {
  op: string;
  value: unknown;
  disposition: Disposition;
  reason: string;
  sourceUrl: string | null;
}
export interface QuestionLine {
  id: string;
  label: string;
  kind: string;
  required: boolean;
  rules: RuleLine[];
}
export interface MonitoringLine {
  id: string;
  label: string;
  maxAgeDays: number | null;
  unit: string | null;
  stale: Disposition | null;
  reason: string | null;
  sourceUrl: string | null;
  verifiedOn: string | null;
  rules: RuleLine[];
}
export interface ProtocolClass {
  id: string;
  title: string;
  summary: string | null;
  questions: QuestionLine[];
  monitoring: MonitoringLine[];
}
export interface ProtocolView {
  version: string;
  approvedBy: string | null;
  general: QuestionLine[];
  classes: ProtocolClass[];
  /** False when the server sent questions without the rules behind them. */
  hasRules: boolean;
}

const rules = (v: unknown): RuleLine[] =>
  list(v).map((r) => ({
    op: text(obj(r.when).op) ?? "",
    value: obj(r.when).value ?? null,
    disposition: (text(r.disposition) ?? "review") as Disposition,
    reason: text(r.reason) ?? "",
    sourceUrl: text(r.source_url),
  }));
const questions = (v: unknown): QuestionLine[] =>
  list(v).map((q) => ({ id: text(q.id) ?? "", label: text(q.label) ?? "", kind: text(q.kind) ?? "", required: q.required === true, rules: rules(q.rules) }));

export function protocolView(raw: unknown, locale: Locale): ProtocolView {
  const x = obj(raw);
  const general = Array.isArray(x.general) ? questions(x.general) : questions(obj(x.general).questions);
  const classes = list(x.classes).map(
    (c): ProtocolClass => ({
      id: text(c.class_id) ?? "",
      title: text(c.title, locale === "en" ? c.class_en : c.class_zh, c.class_zh) ?? "",
      summary: text(c.summary),
      questions: questions(c.questions),
      monitoring: list(c.monitoring).map((m) => ({
        id: text(m.id) ?? "",
        label: text(m.label) ?? "",
        maxAgeDays: num(m.max_age_days),
        unit: text(m.unit),
        stale: text(m.stale_disposition) as Disposition | null,
        reason: text(m.reason),
        sourceUrl: text(m.source_url),
        verifiedOn: text(m.verified_on),
        rules: rules(m.rules),
      })),
    }),
  );
  return {
    version: text(x.version) ?? "",
    approvedBy: text(x.approved_by_note),
    general,
    classes,
    hasRules: [...general, ...classes.flatMap((c) => c.questions)].some((q) => q.rules.length > 0),
  };
}

/** Latest date among rows, so each rule set can say when its sources were last checked. */
export function latest(dates: (string | null | undefined)[]): string | null {
  return (
    dates
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1) ?? null
  );
}
export function countBy<T>(rows: readonly T[], key: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return out;
}
