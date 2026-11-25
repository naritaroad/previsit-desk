// The settings form: bounds (the same as backend/src/settings.rs, which checks again), what changed, and how two
// people's edits come together after a 409. Pure, tested in tests/admin-settings.test.ts.

import type { AdminSettings } from "@/api/types";

/** Settings people edit, one path each. Prices are one path per model. */
export const BOUNDS: Readonly<Record<string, readonly [number, number]>> = {
  "ai.temperature": [0, 2],
  "ai.max_steps": [1, 12],
  "ai.daily_call_limit": [0, 100_000],
  "ai.per_client_daily_limit": [0, 100_000],
  "ai.monthly_budget_usd": [0, 100_000],
  "limits.messages_per_10min": [1, 1000],
  "limits.visits_per_10min": [1, 1000],
  "limits.max_messages_per_visit": [1, 500],
  "rx.sla_hours_routine": [1, 720],
  "rx.sla_hours_soon": [1, 720],
  retention_days: [1, 365],
};
export const PRICE_MAX = 1000;
export const THINKING = ["default", "minimal", "low", "medium", "high"] as const;
const WHOLE = new Set(Object.keys(BOUNDS).filter((k) => k !== "ai.temperature" && k !== "ai.monthly_budget_usd"));

export function leaves(s: AdminSettings): Record<string, unknown> {
  const { prices, ...ai } = s.ai;
  const out: Record<string, unknown> = { retention_days: s.retention_days };
  for (const [k, v] of Object.entries(ai)) out[`ai.${k}`] = v;
  for (const [k, v] of Object.entries(s.limits)) out[`limits.${k}`] = v;
  out["rx.sla_hours_routine"] = s.rx.sla_hours_routine;
  out["rx.sla_hours_soon"] = s.rx.sla_hours_soon;
  for (const [model, p] of Object.entries(prices)) out[`ai.prices.${model}`] = p;
  return out;
}
export function setLeaf(s: AdminSettings, path: string, value: unknown): AdminSettings {
  if (path.startsWith("ai.prices.")) {
    const model = path.slice("ai.prices.".length);
    const prices = { ...s.ai.prices };
    if (value === undefined || value === null) delete prices[model];
    else prices[model] = value as { in: number; out: number };
    return { ...s, ai: { ...s.ai, prices } };
  }
  if (path === "retention_days") return { ...s, retention_days: value as number };
  const [group, key] = path.split(".") as ["ai" | "limits" | "rx", string];
  return { ...s, [group]: { ...s[group], [key]: value } };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function changedPaths(a: AdminSettings, b: AdminSettings): string[] {
  const x = leaves(a);
  const y = leaves(b);
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => !same(x[k], y[k]));
}

export interface Merge {
  /** Their version with my edits that nobody else touched. */
  merged: AdminSettings;
  /** Both of us changed these, differently. */
  conflicts: string[];
  /** What they changed that I had not touched. */
  theirs: string[];
}
export function mergeSettings(base: AdminSettings, mine: AdminSettings, theirs: AdminSettings): Merge {
  const m = leaves(mine);
  const t = leaves(theirs);
  const myChanges = changedPaths(base, mine);
  const theirChanges = changedPaths(base, theirs);
  const conflicts = myChanges.filter((p) => theirChanges.includes(p) && !same(m[p], t[p]));
  let merged = theirs;
  for (const p of myChanges) if (!conflicts.includes(p)) merged = setLeaf(merged, p, m[p]);
  return { merged, conflicts, theirs: theirChanges.filter((p) => !myChanges.includes(p)) };
}

export type Problem = { code: "required" | "range" | "whole" | "same" | "choice"; min?: number; max?: number };
export function validate(s: AdminSettings, models: readonly string[] | undefined): Record<string, Problem> {
  const out: Record<string, Problem> = {};
  const l = leaves(s);
  for (const [path, [min, max]] of Object.entries(BOUNDS)) {
    const v = l[path];
    if (v === null && path === "ai.monthly_budget_usd") continue;
    if (typeof v !== "number" || !Number.isFinite(v)) out[path] = { code: "required" };
    else if (v < min || v > max) out[path] = { code: "range", min, max };
    else if (WHOLE.has(path) && !Number.isInteger(v)) out[path] = { code: "whole" };
  }
  if (models && !models.includes(s.ai.primary)) out["ai.primary"] = { code: "choice" };
  if (s.ai.fallback !== null && s.ai.fallback === s.ai.primary) out["ai.fallback"] = { code: "same" };
  else if (models && s.ai.fallback !== null && !models.includes(s.ai.fallback)) out["ai.fallback"] = { code: "choice" };
  for (const [model, p] of Object.entries(s.ai.prices)) {
    if (![p.in, p.out].every((n) => typeof n === "number" && Number.isFinite(n))) out[`ai.prices.${model}`] = { code: "required" };
    else if ([p.in, p.out].some((n) => n < 0 || n > PRICE_MAX)) out[`ai.prices.${model}`] = { code: "range", min: 0, max: PRICE_MAX };
  }
  return out;
}

/** Models in use whose cost would be counted as zero because no price is set. */
export function unpriced(s: AdminSettings): string[] {
  return [s.ai.primary, s.ai.fallback].filter((m): m is string => m !== null && !(m in s.ai.prices));
}
