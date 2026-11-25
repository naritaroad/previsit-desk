// The two deterministic checks of the server, simplified for the mock: the chronic-refill check and the renewal
// protocol. Numbers come from data/seed (see rules.ts).

import type {
  Disposition,
  EngineResult,
  FiredRule,
  Locale,
  MedicationCard,
  MonitoringValue,
  RefillInput,
  RefillResult,
  RxItem,
} from "../api/types.ts";
import { addDays, daysBetween } from "../lib/format.ts";
import { worstDisposition } from "../lib/rx.ts";
import type { PrescriptionRec } from "./db.ts";
import { CLASSES, DRUGS, GENERAL, L, PROTOCOL_VERSION, type RawMonitoring, type RawQuestion, refillRule, refillRuleOut } from "./rules.ts";

// ------------------------------------------------------------------------------------------- refill

export function checkRefill(input: RefillInput, serverToday: string, locale: Locale): RefillResult {
  const t = (zh: string, en: string) => L(locale, zh, en);
  const today = input.today ?? serverToday;
  const early = refillRule("early_window_days");
  const maxFills = refillRule("max_fills");
  const supplyEnd = addDays(input.last_fill_date, input.days_per_fill);
  const earliest = addDays(supplyEnd, -early);
  const latest = addDays(input.prescription_date, input.total_days);
  const reasons: RefillResult["reasons"] = [];
  const rule = (...keys: string[]) => keys.flatMap((k) => refillRuleOut(k, locale) ?? []);
  const out = (outcome: RefillResult["outcome"], title: string, message: string, rules: RefillResult["rules"], extra: Partial<RefillResult> = {}): RefillResult => ({
    outcome,
    title,
    message,
    today,
    earliest_date: null,
    latest_date: null,
    next_fill_number: null,
    reasons,
    rules,
    handoff: false,
    ticket_no: null,
    ...extra,
  });

  if (input.controlled !== "no") reasons.push({ code: input.controlled === "yes" ? "controlled_drug" : "controlled_unsure", text: t("處方可能含管制藥品，請藥師確認。", "The prescription may contain a controlled drug. Ask the pharmacist.") });
  if (input.symptom_changed) reasons.push({ code: "symptom_changed", text: t("最近症狀有變化，需要醫師重新評估。", "Symptoms have changed recently, so a doctor needs to reassess.") });
  if (input.side_effects) reasons.push({ code: "side_effects", text: t("服藥後有不舒服，需要醫師或藥師評估。", "You feel unwell after the medicine; a doctor or pharmacist should assess it.") });
  if (input.special_status !== "none") reasons.push({ code: "special_status", text: t("特殊狀況可能適用一次領取，請藥師確認。", "A special status may apply. Ask the pharmacist.") });
  if (input.total_days > refillRule("max_total_days") || input.days_per_fill > refillRule("max_days_per_fill"))
    reasons.push({ code: "days_exceed", text: t("給藥日數超過規定，請藥師或醫師確認。", "The number of days is over the limit. Ask the pharmacist or doctor.") });
  if (reasons.length)
    return out("consult", t("請洽藥師或醫師", "Ask the pharmacist or doctor"), t("這張慢箋需要先由藥師或醫師確認，已通知醫療團隊。", "A pharmacist or doctor needs to check this first. The clinic has been notified."), rule("controlled_levels_excluded", "max_total_days", "max_days_per_fill"), { handoff: true });

  const permitted = Math.min(maxFills, Math.ceil(input.total_days / input.days_per_fill));
  if (input.fills_done >= permitted) {
    reasons.push({ code: "fills_exhausted", text: t(`這張慢箋可領的 ${permitted} 次都領完了。`, `All ${permitted} permitted fills have been collected.`) });
    return out("revisit", t("需要回診", "A new visit is needed"), t("請預約門診，或申請續開。", "Book a visit or request a renewal."), rule("max_fills"));
  }
  if (today > latest) {
    reasons.push({ code: "expired", text: t(`慢箋已超過有效期限（${latest}）。`, `The prescription is past its validity date (${latest}).`) });
    return out("revisit", t("需要回診", "A new visit is needed"), t("請預約門診，或申請續開。", "Book a visit or request a renewal."), rule("max_total_days"));
  }
  const window = { earliest_date: earliest, latest_date: latest, next_fill_number: input.fills_done + 1 };
  if (today < earliest) {
    reasons.push({ code: "too_early", text: t(`上次的藥到 ${supplyEnd} 用完，${earliest} 起可以領。`, `The last supply runs out on ${supplyEnd}; you can collect from ${earliest}.`) });
    return out("too_early", t("還沒到可領藥的日子", "Too early for the next refill"), t(`最早 ${earliest} 可以領第 ${window.next_fill_number} 次。`, `The earliest date for fill ${window.next_fill_number} is ${earliest}.`), rule("early_window_days"), window);
  }
  reasons.push({ code: "in_window", text: t(`在領藥期間內（${earliest} 到 ${latest}）。`, `Within the refill window (${earliest} to ${latest}).`) });
  if (today > supplyEnd) reasons.push({ code: "supply_gap", text: t("上次的藥應該已經用完，請盡快領藥。", "The last supply should be used up; collect the next one soon.") });
  return out("eligible", t("可以領藥", "You can collect your refill"), t(`現在可以領第 ${window.next_fill_number} 次。`, `You can collect fill ${window.next_fill_number} now.`), rule("early_window_days", "max_fills"), window);
}

// ------------------------------------------------------------------------------------------- medication card

export function medicationCard(p: PrescriptionRec, today: string, locale: Locale, openRequest: string | null): MedicationCard {
  const drug = DRUGS.get(p.drug_id);
  const ref = drug ?? { drug_id: p.drug_id, name_zh: p.name, name_en: p.name, class_id: "", class_zh: "", class_en: "", controlled_level: 0 };
  const base = {
    prescription_id: p.id,
    drug: { drug_id: ref.drug_id, name_zh: ref.name_zh, name_en: ref.name_en, class_id: ref.class_id, class_zh: ref.class_zh, class_en: ref.class_en, controlled_level: ref.controlled_level },
    dose_text: L(locale, p.dose_zh, p.dose_en),
    source: p.source,
    issued_on: p.issued_on,
    total_days: p.total_days,
    days_per_fill: p.days_per_fill,
    fills: p.fills,
    fills_allowed: p.fills_allowed,
    renewal_scope: p.source === "clinic" ? (drug?.scope ?? "physician_only") : ("physician_only" as const),
    open_request_id: openRequest,
  };
  if (p.source === "self_reported") {
    return { ...base, supply_ends_on: p.issued_on, next_window: null, valid_until: p.issued_on, state: "on_hand", days_left: 0, refill_preview: null };
  }
  const last = p.fills.at(-1)?.filled_on ?? p.issued_on;
  const supplyEnds = addDays(last, p.days_per_fill);
  const validUntil = addDays(p.issued_on, p.total_days);
  const from = addDays(supplyEnds, -refillRule("early_window_days"));
  const done = p.fills.length >= p.fills_allowed;
  const state: MedicationCard["state"] = done
    ? today > supplyEnds
      ? "expired"
      : "finished"
    : today > validUntil
      ? "expired"
      : today > supplyEnds
        ? "late"
        : today >= from
          ? "window_open"
          : daysBetween(today, from) <= 5
            ? "window_soon"
            : "on_hand";
  return {
    ...base,
    supply_ends_on: supplyEnds,
    next_window: done || today > validUntil ? null : { from, to: validUntil },
    valid_until: validUntil,
    state,
    days_left: Math.max(0, daysBetween(today, supplyEnds)),
    refill_preview: checkRefill(
      { prescription_date: p.issued_on, total_days: p.total_days, days_per_fill: p.days_per_fill, fills_done: Math.max(1, p.fills.length), last_fill_date: last, controlled: ref.controlled_level === 1 || ref.controlled_level === 2 ? "yes" : "no", special_status: "none", symptom_changed: false, side_effects: false },
      today,
      locale,
    ),
  };
}

// ------------------------------------------------------------------------------------------- renewal protocol

type Rules = RawQuestion["rules"];
function firstHit(rules: Rules, answer: unknown): Rules[number] | null {
  for (const r of rules) {
    const missing = answer === undefined || answer === null || answer === "";
    const n = typeof answer === "number" ? answer : Number.NaN;
    const v = r.when.value;
    const limit = typeof v === "number" ? v : Number.NaN;
    const hit =
      r.when.op === "missing" ? missing
      : missing ? false
      : r.when.op === "eq" ? answer === v
      : r.when.op === "gt" ? n > limit
      : r.when.op === "gte" ? n >= limit
      : n < limit;
    if (hit) return r;
  }
  return null;
}

export function evaluateItem(
  drugId: string,
  answers: Record<string, unknown>,
  monitoring: Record<string, MonitoringValue>,
  lastSeenDays: number | null,
  today: string,
  locale: Locale,
): NonNullable<RxItem["engine"]> {
  const drug = DRUGS.get(drugId);
  const scope = drug?.scope ?? "physician_only";
  if (scope === "excluded") return { disposition: "excluded", fired: [] };
  const fired: FiredRule[] = [];
  const add = (id: string, label: string, answer: unknown, disposition: Disposition, reason: string, url: string) =>
    fired.push({ question_id: id, label, answer: answer ?? null, disposition, reason, source_url: url || null });
  const cls = CLASSES.get(drug?.class_id ?? "");
  const all = { ...answers, last_seen_days: lastSeenDays };
  for (const q of [...GENERAL, ...(cls?.questions ?? [])]) {
    const a = (all as Record<string, unknown>)[q.id];
    const hit = firstHit(q.rules, a);
    if (hit) add(q.id, L(locale, q.label_zh, q.label_en), a, hit.disposition, L(locale, hit.reason_zh, hit.reason_en), hit.source_url);
  }
  for (const m of cls?.monitoring ?? []) {
    const v = monitoring[m.id];
    const label = L(locale, m.label_zh, m.label_en);
    const hit = firstHit(m.rules, v?.value);
    if (hit) add(m.id, label, v?.value, hit.disposition, L(locale, hit.reason_zh, hit.reason_en), hit.source_url);
    if (isStaleMonitoring(m, v, today)) add(m.id, label, v?.date, m.stale_disposition, L(locale, m.reason_zh, m.reason_en), m.source_url);
  }
  if (scope === "physician_only") {
    const reason = drug ? L(locale, drug.reason_zh, drug.reason_en) : L(locale, "這個藥需要醫師個別評估。", "This medicine needs a doctor's individual assessment.");
    add("scope", L(locale, "藥品範圍", "Medicine scope"), null, "in_person", reason, "");
  }
  return { disposition: worstDisposition(fired.map((f) => f.disposition)) ?? "ready", fired };
}

export function isStaleMonitoring(m: RawMonitoring, v: MonitoringValue | undefined, today: string): boolean {
  if (m.max_age_days === null) return false;
  return !v?.date || daysBetween(v.date, today) > m.max_age_days;
}

export function evaluateRequest(
  items: { class_id: string; scope: RxItem["scope"]; engine: NonNullable<RxItem["engine"]> }[],
  monitoring: Record<string, MonitoringValue>,
  today: string,
  at: string,
  locale: Locale,
): EngineResult {
  const usable = items.filter((i) => i.scope !== "excluded");
  const disposition = (usable.length ? worstDisposition(usable.map((i) => i.engine.disposition)) : "excluded") ?? "ready";
  const stale = new Set<string>();
  for (const i of usable) for (const m of CLASSES.get(i.class_id)?.monitoring ?? []) if (isStaleMonitoring(m, monitoring[m.id], today)) stale.add(m.id);
  const rules = usable.reduce((n, i) => n + i.engine.fired.length, 0);
  const summary =
    rules === 0
      ? L(locale, "沒有觸發規則，資料齊全，待醫師決定。", "No rule was triggered and the information is complete. A doctor decides.")
      : L(locale, `觸發 ${rules} 條規則，請醫師逐項確認。`, `${rules} rules were triggered. The doctor should go through them.`);
  return { protocol_version: PROTOCOL_VERSION, disposition, evaluated_at: at, summary, stale_monitoring: [...stale] };
}
