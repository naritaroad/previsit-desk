// What the review desk shows, computed from one visit. Pure, so tests can check it.

import type { Message, PrevisitSummary, RedFlagHit, RefillCheckRecord } from "@/api/types";
import { summaryRows, type IntakeRow } from "@/lib/intake";
import { traceBrief, type TraceRow } from "@/lib/trace";

// ------------------------------------------------------------------------------------------------ S lines

export const LINE_GROUPS = [
  { id: "complaint", keys: ["chief_complaint"] },
  { id: "hpi", keys: ["hpi.onset", "hpi.course", "hpi.location", "hpi.character", "hpi.severity", "hpi.modifiers"] },
  { id: "ros", keys: ["hpi.associated"] },
  { id: "background", keys: ["past_history", "medications", "allergies"] },
] as const;

export interface LineGroup {
  id: (typeof LINE_GROUPS)[number]["id"];
  rows: IntakeRow[];
}
/** The organised lines, history and review of systems apart; fields nobody asked about are listed elsewhere. */
export function lineGroups(summary: PrevisitSummary, sep: string): LineGroup[] {
  const rows = summaryRows(summary, sep).filter((r) => r.status !== "missing" && r.status !== "na");
  return LINE_GROUPS.map((g) => ({ id: g.id, rows: g.keys.flatMap((k) => rows.find((r) => r.key === k) ?? []) })).filter((g) => g.rows.length > 0);
}

/** Messages an evidence list points to, in conversation order. Ids that are gone are dropped. */
export function evidenceMessages(ids: readonly string[], messages: readonly Message[]): Message[] {
  return messages.filter((m) => ids.includes(m.id));
}

// ------------------------------------------------------------------------------------------------ rule hits

export interface RuleHit {
  id: string;
  kind: "red_flag" | "scope" | "guard" | "pii" | "refill";
  /** i18next key and parameters, or ready text. */
  key?: string;
  params?: Record<string, string | number>;
  text?: string;
  at: string;
  messageId: string | null;
  sources: string[];
}

/** The patient message a check belongs to: the last one written before it ran. */
function messageAt(messages: readonly Message[], at: string): string | null {
  const limit = Date.parse(at) + 1500;
  return messages.findLast((m) => m.role === "patient" && Date.parse(m.created_at) <= limit)?.id ?? null;
}

export function ruleHits(v: { redFlag: RedFlagHit | null; trace: readonly TraceRow[]; messages: readonly Message[]; refillChecks: readonly RefillCheckRecord[] }): RuleHit[] {
  const out: RuleHit[] = [];
  if (v.redFlag) out.push({ id: "red", kind: "red_flag", key: "flags.red", params: { label: v.redFlag.label }, at: v.redFlag.matched_at, messageId: v.redFlag.message_id, sources: [] });
  for (const row of v.trace) {
    const r = row.result as Record<string, unknown> | null | undefined;
    if (typeof r !== "object" || r === null) continue;
    const brief = traceBrief(row.name, r);
    const base = { id: row.id, at: row.created_at, messageId: messageAt(v.messages, row.created_at), sources: [] as string[] };
    if (row.name === "red_flag_precheck" && r.hit === true) {
      const same = v.redFlag && (base.messageId === v.redFlag.message_id || r.label === v.redFlag.label);
      if (!same) out.push({ ...base, kind: "red_flag", key: "flags.red", params: { label: String(r.label ?? "") } });
    } else if (row.name === "scope_precheck" && r.verdict && r.verdict !== "ok" && brief) out.push({ ...base, kind: "scope", key: brief.key, params: brief.params });
    else if (row.name === "output_guard" && r.passed !== true && brief) out.push({ ...base, kind: "guard", key: brief.key, params: brief.params });
    else if (row.name === "pii_filter" && Number(r.masked) > 0 && brief) out.push({ ...base, kind: "pii", key: brief.key, params: brief.params });
  }
  for (const c of v.refillChecks)
    out.push({ id: c.id, kind: "refill", text: c.result.title, at: c.created_at, messageId: null, sources: [...new Set(c.result.rules.map((x) => x.source_url).filter(Boolean))] });
  const rank = { red_flag: 0, scope: 1, refill: 2, guard: 3, pii: 4 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.at.localeCompare(b.at));
}

// ------------------------------------------------------------------------------------------------ the AI draft of S

type Label = (key: string, params?: Record<string, unknown>) => string;

/**
 * The S text the server composes from the summary (backend notes.rs, subjective_text). Needed for the comparison once a
 * note was stored, because the API then returns the stored text only.
 */
export function draftFromSummary(s: PrevisitSummary, label: Label, en: boolean): string {
  const [colon, sep, list] = en ? [": ", "; ", ", "] : ["：", "；", "、"];
  const gone = new Set(s.not_collected);
  const line = (key: string, text: string) => `${label(`field.${key}`)}${colon}${text}`;
  const out: string[] = [];
  if (s.chief_complaint) out.push(line("chief_complaint", s.chief_complaint));
  const h = s.hpi;
  const hpi = (
    [
      ["hpi.onset", h.onset],
      ["hpi.course", h.course],
      ["hpi.location", h.location],
      ["hpi.character", h.character],
      ["hpi.modifiers", h.modifiers],
      ["hpi.associated", h.associated],
    ] as const
  ).flatMap(([k, v]) => (v ? [line(k, v)] : []));
  if (typeof h.severity === "number") hpi.push(line("hpi.severity", label("field.severityOf", { n: h.severity })));
  if (hpi.length) out.push(hpi.join(sep));
  for (const key of ["past_history", "medications", "allergies"] as const) if (!gone.has(key)) out.push(line(key, s[key].length ? s[key].join(list) : label("field.none")));
  if (s.patient_questions.length) out.push(line("patient_questions", s.patient_questions.join(sep)));
  if (s.not_collected.length) out.push(line("not_collected", s.not_collected.map((k) => label(`field.${k}`)).join(list)));
  return out.join("\n");
}
