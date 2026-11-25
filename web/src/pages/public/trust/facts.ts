// {{facts.x}} in the documents -> what GET /trust/facts says right now.

import type { Locale, TrustFacts } from "@/api/types";
import { formatDate } from "@/lib/format";

export const FACT_KEYS = [
  "app_version",
  "eval_date",
  "eval_model",
  "eval_passed",
  "eval_total",
  "formulary_excluded",
  "formulary_in_scope",
  "formulary_physician_only",
  "model_fallback",
  "model_primary",
  "oversight_phase",
  "protocol_version",
  "red_flag_rules",
  "retention_days",
  "scope_rules",
] as const;
export type FactKey = (typeof FACT_KEYS)[number];

/** The value as text, or null when the server has not said (no run yet, an older server). */
export function factValue(f: Partial<TrustFacts> | undefined, key: string, locale: Locale): string | null {
  if (!f) return null;
  const n = (v: number | null | undefined) => (typeof v === "number" ? String(v) : null);
  switch (key as FactKey) {
    case "app_version":
      return f.version ?? null;
    case "eval_date":
      return f.eval ? formatDate(f.eval.ran_at, locale, "long") : null;
    case "eval_model":
      return f.eval?.model ?? null;
    case "eval_passed":
      return n(f.eval?.passed);
    case "eval_total":
      return n(f.eval?.total);
    case "formulary_excluded":
      return n(f.formulary_counts?.excluded);
    case "formulary_in_scope":
      return n(f.formulary_counts?.in_scope);
    case "formulary_physician_only":
      return n(f.formulary_counts?.physician_only);
    case "model_fallback":
      return f.models?.fallback ?? null;
    case "model_primary":
      return f.models?.primary ?? null;
    case "oversight_phase":
      return n(f.oversight_phase);
    case "protocol_version":
      return f.protocol_version ?? null;
    case "red_flag_rules":
      return n(f.red_flag_rules);
    case "retention_days":
      return n(f.retention_days);
    case "scope_rules":
      return n(f.scope_rules);
    default:
      return null;
  }
}
