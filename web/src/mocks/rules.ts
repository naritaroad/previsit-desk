// The project's own rule files, read by the mock so it shows the same questions, scopes and red flags as the
// server (data/seed and data/rag stay the only source). Only loaded in `--mode mock` and in tests.

import formularyCsv from "../../../data/seed/formulary.csv?raw";
import redFlagsCsv from "../../../data/seed/red_flags.csv?raw";
import refillRulesCsv from "../../../data/seed/refill_rules.csv?raw";
import scopeRulesCsv from "../../../data/seed/scope_rules.csv?raw";
import personasJson from "../../../data/seed/demo/personas.json";
import pharmaciesJson from "../../../data/seed/demo/pharmacies.json";
import protocolsJson from "../../../data/seed/renewal_protocols.json";
import handbookMd from "../../../data/rag/health_education.zh-TW.md?raw";
import type {
  Disposition,
  DrugRef,
  FormularyItem,
  HandbookEntry,
  Locale,
  Persona,
  Pharmacy,
  PrecheckScope,
  ProtocolQuestion,
  ProtocolSet,
  RedFlagCategory,
  RenewalScope,
} from "../api/types.ts";

/** Pick the text of a locale. */
export const L = (locale: Locale, zh: string, en: string): string => (locale === "en" ? en : zh);

/** RFC 4180: quoted fields, doubled quotes, CRLF. First row is the header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  const [header, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

// ------------------------------------------------------------------------------------------- formulary

export interface Drug extends DrugRef {
  scope: RenewalScope;
  form: string;
  strengths: string[];
  source_type: string;
  source_url: string | null;
  verified_on: string | null;
  reason_zh: string;
  reason_en: string;
}
export const DRUGS: ReadonlyMap<string, Drug> = new Map(
  parseCsv(formularyCsv).map((r) => [
    r.drug_id,
    {
      drug_id: r.drug_id,
      name_zh: r.name_zh,
      name_en: r.name_en,
      class_id: r.class_id,
      class_zh: r.class_zh,
      class_en: r.class_en,
      controlled_level: Number(r.controlled_level) || 0,
      scope: r.renewal_scope as RenewalScope,
      form: r.form,
      strengths: r.strengths ? r.strengths.split("|") : [],
      source_type: r.source_type,
      source_url: r.source_url || null,
      verified_on: r.verified_on || null,
      reason_zh: r.reason_zh,
      reason_en: r.reason_en,
    },
  ]),
);
export function drugRef(drugId: string): DrugRef {
  const d = DRUGS.get(drugId);
  if (!d) throw new Error(`unknown drug ${drugId}`);
  return { drug_id: d.drug_id, name_zh: d.name_zh, name_en: d.name_en, class_id: d.class_id, class_zh: d.class_zh, class_en: d.class_en, controlled_level: d.controlled_level };
}
export function formulary(locale: Locale): FormularyItem[] {
  return [...DRUGS.values()].map(({ reason_zh, reason_en, scope, ...d }) => ({ ...d, renewal_scope: scope, reason: L(locale, reason_zh, reason_en) }));
}
export function formularyCounts(): Record<RenewalScope, number> {
  const counts: Record<RenewalScope, number> = { in_scope: 0, physician_only: 0, excluded: 0 };
  for (const d of DRUGS.values()) counts[d.scope] += 1;
  return counts;
}

// ------------------------------------------------------------------------------------------- protocols

interface RawRule {
  when: { op: "eq" | "missing" | "gt" | "gte" | "lt"; value?: unknown };
  disposition: Disposition;
  reason_zh: string;
  reason_en: string;
  source_url: string;
}
export interface RawQuestion {
  id: string;
  kind: ProtocolQuestion["kind"];
  label_zh: string;
  label_en: string;
  help_zh?: string;
  help_en?: string;
  options?: { value: string; label_zh: string; label_en: string }[];
  unit?: string;
  min?: number;
  max?: number;
  required?: boolean;
  rules: RawRule[];
}
export interface RawMonitoring {
  id: string;
  label_zh: string;
  label_en: string;
  max_age_days: number | null;
  value_kind: "date_only" | "number";
  unit: string;
  rules: RawRule[];
  stale_disposition: Disposition;
  reason_zh: string;
  reason_en: string;
  source_type: string;
  source_url: string;
  verified_on: string;
}
interface RawClass {
  class_id: string;
  title_zh: string;
  title_en: string;
  summary_zh: string;
  summary_en: string;
  questions: RawQuestion[];
  monitoring: RawMonitoring[];
}
const raw = protocolsJson as unknown as { version: string; approved_by_note_zh?: string; approved_by_note_en?: string; general: { questions: RawQuestion[] }; classes: RawClass[] };
export const PROTOCOL_VERSION = raw.version;
export const GENERAL = raw.general.questions;
export const CLASSES: ReadonlyMap<string, RawClass> = new Map(raw.classes.map((c) => [c.class_id, c]));

export function question(q: RawQuestion, scope: "general" | "class", classId: string | null, locale: Locale): ProtocolQuestion {
  return {
    id: q.id,
    scope,
    class_id: classId,
    kind: q.kind,
    label: L(locale, q.label_zh, q.label_en),
    help: q.help_zh ? L(locale, q.help_zh, q.help_en ?? q.help_zh) : null,
    options: (q.options ?? []).map((o) => ({ value: o.value, label: L(locale, o.label_zh, o.label_en) })),
    unit: q.unit || null,
    min: q.min ?? null,
    max: q.max ?? null,
    required: q.required ?? false,
    max_age_days: null,
  };
}
export function monitoringQuestion(m: RawMonitoring, classId: string, locale: Locale): ProtocolQuestion {
  return {
    id: m.id,
    scope: "monitoring",
    class_id: classId,
    kind: m.value_kind === "number" ? "number" : "date",
    label: L(locale, m.label_zh, m.label_en),
    help: L(locale, m.reason_zh, m.reason_en),
    options: [],
    unit: m.unit || null,
    min: null,
    max: null,
    required: false,
    max_age_days: m.max_age_days,
  };
}
/** An answer that fires no rule, so fixtures only spell out what matters. Undefined when there is none to give. */
export function calmAnswer(q: RawQuestion): unknown {
  const fires = (v: unknown) => q.rules.some((r) => r.when.op === "eq" && r.when.value === v);
  if (q.kind === "boolean") return fires(false);
  if (q.kind === "choice") return q.options?.find((o) => !fires(o.value))?.value;
  return undefined;
}
export function calmAnswers(classIds: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const q of [...GENERAL, ...classIds.flatMap((id) => CLASSES.get(id)?.questions ?? [])]) {
    const a = calmAnswer(q);
    if (a !== undefined) out[q.id] = a;
  }
  return out;
}
const yesNo = (id: string, label: string): ProtocolQuestion => ({ id, scope: "general", class_id: null, kind: "boolean", label, help: null, options: [], unit: null, min: null, max: null, required: true, max_age_days: null });
/** What a refill request asks (the same inputs as the refill check). */
export function refillQuestions(locale: Locale): ProtocolQuestion[] {
  const special: [string, string, string][] = [
    ["none", "沒有", "None"],
    ["going_abroad", "即將出國", "Going abroad"],
    ["returning_island", "返回離島", "Returning to an offshore island"],
    ["ocean_fishing_crew", "遠洋漁船船員", "Ocean-going fishing crew"],
    ["international_crew", "國際航線船員或機組人員", "International ship or flight crew"],
    ["rare_disease", "罕見疾病", "Rare disease"],
  ];
  return [
    yesNo("symptom_changed", L(locale, "最近症狀有沒有變化？", "Have your symptoms changed recently?")),
    yesNo("side_effects", L(locale, "吃藥之後有沒有不舒服？", "Have you felt unwell after taking the medicine?")),
    { ...yesNo("special_status", L(locale, "有沒有下列情況？", "Does any of these apply?")), kind: "choice", options: special.map(([value, zh, en]) => ({ value, label: L(locale, zh, en) })) },
  ];
}
/** One yes/no per item, the general questions, then each class once, then monitoring. */
export function questionsFor(items: readonly { id: string; class_id: string; name: string }[], locale: Locale): ProtocolQuestion[] {
  const classIds = [...new Set(items.map((i) => i.class_id))];
  const out = new Map<string, ProtocolQuestion>();
  for (const i of items) out.set(`same_as_record:${i.id}`, yesNo(`same_as_record:${i.id}`, L(locale, `${i.name}：跟你現在吃的一樣嗎？`, `${i.name}: is this how you take it now?`)));
  for (const q of GENERAL) out.set(q.id, question(q, "general", null, locale));
  for (const id of classIds) for (const q of CLASSES.get(id)?.questions ?? []) if (!out.has(q.id)) out.set(q.id, question(q, "class", id, locale));
  for (const id of classIds) for (const m of CLASSES.get(id)?.monitoring ?? []) if (!out.has(m.id)) out.set(m.id, monitoringQuestion(m, id, locale));
  return [...out.values()];
}
export function protocolSet(locale: Locale): ProtocolSet {
  const rules = (list: RawRule[]) => list.map((r) => ({ when: { op: r.when.op, value: r.when.value ?? null }, disposition: r.disposition, reason: L(locale, r.reason_zh, r.reason_en), source_url: r.source_url || null }));
  const questions = (list: RawQuestion[]) => list.map((q) => ({ id: q.id, kind: q.kind, label: L(locale, q.label_zh, q.label_en), required: q.required ?? false, rules: rules(q.rules) }));
  return {
    version: PROTOCOL_VERSION,
    approved_by_note: L(locale, raw.approved_by_note_zh ?? "", raw.approved_by_note_en ?? ""),
    general: { questions: questions(GENERAL) },
    classes: [...CLASSES.values()].map((c) => ({
      class_id: c.class_id,
      title: L(locale, c.title_zh, c.title_en),
      summary: L(locale, c.summary_zh, c.summary_en),
      questions: questions(c.questions),
      monitoring: c.monitoring.map((m) => ({
        id: m.id,
        label: L(locale, m.label_zh, m.label_en),
        max_age_days: m.max_age_days,
        value_kind: m.value_kind,
        unit: m.unit,
        rules: rules(m.rules),
        stale_disposition: m.stale_disposition,
        reason: L(locale, m.reason_zh, m.reason_en),
        source_type: m.source_type || null,
        source_url: m.source_url || null,
        verified_on: m.verified_on || null,
      })),
    })),
  };
}

// ------------------------------------------------------------------------------------------- prechecks

export const RED_FLAG_ROWS = parseCsv(redFlagsCsv);
export const SCOPE_ROWS = parseCsv(scopeRulesCsv);
/** Rust named groups (?P<m>) are (?<m>) in JavaScript. */
const regex = (pattern: string): RegExp | null => {
  try {
    return new RegExp(pattern.replaceAll("(?P<", "(?<"), "iu");
  } catch {
    return null;
  }
};
const FLAGS = RED_FLAG_ROWS.map((r) => ({ id: r.id, category: r.category as RedFlagCategory, zh: r.label_zh, en: r.label_en, re: regex(r.pattern) }));
const SCOPES = SCOPE_ROWS.map((r) => ({ verdict: r.verdict as PrecheckScope, re: regex(r.pattern) }));
const NEGATION = /(沒有?|無|不會|未|no |not |without )[^，。,.]{0,6}$/i;

export function redFlag(text: string): { id: string; category: RedFlagCategory; zh: string; en: string } | null {
  for (const f of FLAGS) {
    const m = f.re?.exec(text);
    if (m && !NEGATION.test(text.slice(0, m.index))) return f;
  }
  return null;
}
export function scopeOf(text: string): PrecheckScope {
  return SCOPES.find((s) => s.re?.test(text))?.verdict ?? "ok";
}

// ------------------------------------------------------------------------------------------- refill rules

export const REFILL_ROWS = parseCsv(refillRulesCsv);
export function refillRule(key: string): number {
  return Number(REFILL_ROWS.find((r) => r.key === key)?.value);
}
export function refillRuleOut(key: string, locale: Locale): { key: string; text: string; source_url: string } | null {
  const r = REFILL_ROWS.find((x) => x.key === key);
  return r ? { key, text: L(locale, r.text_zh, r.text_en), source_url: r.source_url } : null;
}

// ------------------------------------------------------------------------------------------- personas, handbook

interface RawPersona {
  id: string;
  display_name: string;
  display_name_en: string;
  age_band: string;
  summary_zh: string;
  summary_en: string;
}
export const PERSONAS: readonly Persona[] = (personasJson as RawPersona[]).map((p) => ({ id: p.id, display_name: p.display_name, display_name_en: p.display_name_en, age_band: p.age_band, summary_zh: p.summary_zh, summary_en: p.summary_en }));

interface RawPharmacy extends Pharmacy {
  name_en: string;
  district_en: string;
  address_en: string;
  hours_en: string;
  services_en: string[];
}
export const PHARMACY_SEED: readonly { id: string; zh: Omit<Pharmacy, "id">; en: Omit<Pharmacy, "id"> }[] = (pharmaciesJson as RawPharmacy[]).map((p) => ({
  id: p.id,
  zh: { name: p.name, district: p.district, address: p.address, hours: p.hours, services: p.services },
  en: { name: p.name_en, district: p.district_en, address: p.address_en, hours: p.hours_en, services: p.services_en },
}));

export const HANDBOOK: readonly HandbookEntry[] = (() => {
  const out: HandbookEntry[] = [];
  let chapter = "";
  for (const block of handbookMd.replaceAll("\r", "").split(/\n(?=#{2,3} )/)) {
    const head = /^## (.+)/.exec(block);
    if (head && !block.startsWith("###")) {
      chapter = head[1].trim();
      continue;
    }
    const m = /^### §(\S+)\s+(.+)\n> (.+)\n+([\s\S]*)$/.exec(block);
    if (!m) continue;
    const meta = Object.fromEntries(
      m[3].split("; ").map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
    );
    out.push({
      section: `§${m[1]}`,
      title: m[2].trim(),
      chapter,
      text: m[4].trim(),
      source_type: meta.source_type ?? "project",
      source_name: meta.source_name ?? "",
      source_url: meta.source_url || null,
      verified_on: meta.verified_on ?? "",
    });
  }
  return out;
})();
export function searchHandbook(q: string): { entry: HandbookEntry; score: number }[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return HANDBOOK.map((entry) => {
    const hay = `${entry.title} ${entry.text}`.toLowerCase();
    const score = terms.reduce((n, t) => n + (entry.title.toLowerCase().includes(t) ? 2 : hay.includes(t) ? 1 : 0), 0);
    return { entry, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}
