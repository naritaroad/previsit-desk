// Fictional refill and renewal requests in every state. Answers and readings are given here; the engine results
// are computed from them with the project's own protocol, so they always match the rules.

import type { MonitoringValue, RxOutcome, RxStatus, Urgency } from "../../api/types.ts";
import { addDays } from "../../lib/format.ts";
import { identityKey, worstDisposition } from "../../lib/rx.ts";
import { type PrescriptionRec, type RxEventRec, type RxRec, fid } from "../db.ts";
import { evaluateItem, evaluateRequest, medicationCard } from "../engine.ts";
import { calmAnswers, DRUGS } from "../rules.ts";

interface RxScript {
  key: string;
  patient: string;
  kind: "refill" | "renewal";
  status: RxStatus;
  items: string[];
  /** Hours ago it was created and sent. */
  created: number;
  submitted?: number;
  step?: string;
  /** Only answers that matter; the others are filled with ones that fire nothing. */
  answers?: Record<string, unknown>;
  monitoring?: Record<string, [value: number | undefined, daysAgo: number]>;
  pharmacy?: string;
  pickup?: [inDays: number, slot: "morning" | "afternoon" | "evening"];
  assigned?: "dr" | "dr2" | "rph";
  priority?: Urgency;
  decide?: { by: "dr" | "dr2"; ago: number; outcomes: Record<string, [RxOutcome, string | null]>; note?: string; patient?: string };
  events?: [hoursAgo: number, type: string, by: string | null, zh: string, en: string, visibility?: "staff"][];
  messages?: [hoursAgo: number, by: string, body: string, visibility?: "staff"][];
}

const SCRIPTS: readonly RxScript[] = [
  {
    key: "lin-losartan-draft",
    patient: "lin",
    kind: "renewal",
    status: "draft",
    items: ["lin-losartan"],
    created: 20,
    step: "safety",
    answers: { taking_as_prescribed: "all", urgent_symptoms_now: false, new_or_worse_symptoms: false },
    pharmacy: "ph-anhe",
  },
  {
    key: "lin-metformin-ready",
    patient: "lin",
    kind: "refill",
    status: "ready",
    items: ["lin-metformin"],
    created: 30,
    submitted: 29,
    pharmacy: "ph-anhe",
    pickup: [0, "evening"],
    assigned: "rph",
    events: [
      [29, "submitted", "lin", "送出領藥預約", "Refill pickup sent"],
      [27, "accepted", "rph", "藥局開始處理", "Pharmacy started"],
      [3, "ready", "rph", "備藥完成，可以領藥", "Ready for pickup"],
    ],
  },
  {
    key: "lin-amlodipine-cancelled",
    patient: "lin",
    kind: "refill",
    status: "cancelled",
    items: ["lin-amlodipine"],
    created: 400,
    submitted: 399,
    pharmacy: "ph-anhe",
    pickup: [-15, "morning"],
    events: [
      [399, "submitted", "lin", "送出領藥預約", "Refill pickup sent"],
      [396, "cancelled", "lin", "病人取消申請", "Cancelled by the patient"],
    ],
  },
  {
    key: "chang-inhaler",
    patient: "chang",
    kind: "renewal",
    status: "in_review",
    items: ["chang-bud"],
    created: 7,
    submitted: 6,
    answers: { gina_day: true, gina_night: true, gina_reliever: true, gina_activity: false, gina_exacerbation: false, taking_as_prescribed: "missed_some" },
    pharmacy: "ph-minsheng",
    events: [[6, "submitted", "chang", "送出續開申請", "Renewal request sent"]],
  },
  {
    key: "wu-bp-lipid",
    patient: "wu",
    kind: "renewal",
    status: "in_review",
    items: ["wu-amlodipine", "wu-rosuvastatin", "wu-zolpidem"],
    created: 60,
    submitted: 58,
    answers: { home_sbp: 148, home_dbp: 84, dizzy_standing: true, ccb_ankle_swelling: true, ccb_palpitations: false, statin_muscle: false, statin_dark_urine: false, statin_liver: false },
    monitoring: { bp_check: [undefined, 3], lipid_panel: [undefined, 380] },
    pharmacy: "ph-anhe",
    assigned: "dr",
    priority: "soon",
    events: [
      [58, "submitted", "wu", "送出續開申請", "Renewal request sent"],
      [50, "assigned", "cm", "指派給陳柏宇醫師", "Assigned to Dr Po-Yu Chen", "staff"],
    ],
    messages: [[49, "cm", "病人獨居，頭暈那題我再打電話確認一次。", "staff"]],
  },
  {
    key: "huang-levo",
    patient: "huang",
    kind: "renewal",
    status: "more_info",
    items: ["huang-levo"],
    created: 76,
    submitted: 75,
    answers: { pregnancy_status: "no", levo_dose_changed: false, levo_too_much: false, levo_too_little: true, levo_timing: true },
    monitoring: { tsh_test: [undefined, 210] },
    pharmacy: "ph-heping",
    assigned: "dr2",
    events: [
      [75, "submitted", "huang", "送出續開申請", "Renewal request sent"],
      [20, "more_info", "dr2", "醫師請您補充資料", "The doctor asked for more information"],
    ],
    messages: [[20, "dr2", "您說常和鈣片一起吃。鈣片是哪一種、一天幾顆、跟甲狀腺藥隔多久吃？麻煩補充一下。"]],
  },
  {
    key: "li-allopurinol",
    patient: "li",
    kind: "renewal",
    status: "at_pharmacy",
    items: ["li-allopurinol"],
    created: 90,
    submitted: 89,
    answers: { urate_rash: false, urate_flare: true, urate_cvd: false, urate_liver: false },
    monitoring: { serum_urate: [6.8, 44] },
    pharmacy: "ph-minsheng",
    assigned: "rph",
    decide: { by: "dr", ago: 22, outcomes: { "li-allopurinol": ["approve", null] }, patient: "這次先照原來的藥續開。下次回診帶最近的飲食紀錄來，我們一起看。" },
    events: [
      [89, "submitted", "li", "送出續開申請", "Renewal request sent"],
      [22, "decided", "dr", "醫師同意續開", "Approved by the doctor"],
      [22, "at_pharmacy", null, "轉到民生示範藥局", "Sent to Minsheng Demo Pharmacy"],
    ],
  },
  {
    key: "cheng-partial",
    patient: "cheng",
    kind: "renewal",
    status: "partially_approved",
    items: ["cheng-telmisartan", "cheng-sitagliptin"],
    created: 50,
    submitted: 49,
    answers: { home_sbp: 141, home_dbp: 78, dizzy_standing: false, raas_angioedema: false, raas_cough: false, raas_bloodtest_after_change: false, dpp4_pancreatitis: false, dpp4_joint: false, dpp4_blisters: false, dpp4_heart_failure: true },
    monitoring: { egfr_k_annual: [undefined, 30], bp_check: [undefined, 1], a1c: [7.1, 30], egfr_annual: [undefined, 30], uacr_annual: [undefined, 95], eye_exam: [undefined, 420], foot_exam: [undefined, 30] },
    pharmacy: "ph-anhe",
    assigned: "dr",
    decide: { by: "dr", ago: 4, outcomes: { "cheng-telmisartan": ["approve", null], "cheng-sitagliptin": ["visit_required", "新的腳腫需要當面評估。"] }, patient: "血壓藥先續開。血糖藥因為腳踝腫，請先約門診讓我看過再決定，這幾天照常吃。" },
    events: [
      [49, "submitted", "cheng", "送出續開申請", "Renewal request sent"],
      [4, "decided", "dr", "部分項目同意，其他需要回診", "Some items approved, others need a visit"],
    ],
  },
  {
    key: "liu-declined",
    patient: "liu",
    kind: "renewal",
    status: "declined",
    items: ["liu-metformin"],
    created: 130,
    submitted: 128,
    answers: { taking_as_prescribed: "stopped", met_gi: true, sick_day: false, met_contrast_surgery: false, met_lactic: false },
    monitoring: { a1c: [8.1, 400] },
    pharmacy: "ph-minsheng",
    assigned: "dr",
    decide: { by: "dr", ago: 70, outcomes: { "liu-metformin": ["decline", "超過一年沒有抽血，而且已自行停藥，需要先回診。"] }, patient: "您停藥有一陣子了，也超過一年沒抽血，我沒辦法直接續開。請先約門診，抽血那天空腹來。" },
    events: [
      [128, "submitted", "liu", "送出續開申請", "Renewal request sent"],
      [70, "decided", "dr", "醫師沒有同意續開", "Not approved by the doctor"],
    ],
  },
  {
    key: "liu-visit",
    patient: "liu",
    kind: "renewal",
    status: "approved",
    items: ["liu-rosuvastatin"],
    created: 26,
    submitted: 25,
    answers: { statin_muscle: false, statin_dark_urine: false, statin_liver: false },
    monitoring: { lipid_panel: [undefined, 120] },
    pharmacy: "ph-minsheng",
    assigned: "dr",
    decide: { by: "dr", ago: 1, outcomes: { "liu-rosuvastatin": ["approve", null] }, patient: "血脂藥照原來的續開。" },
    events: [
      [25, "submitted", "liu", "送出續開申請", "Renewal request sent"],
      [1, "decided", "dr", "醫師同意續開", "Approved by the doctor"],
    ],
  },
  {
    key: "kuo-fexo",
    patient: "kuo",
    kind: "refill",
    status: "submitted",
    items: ["kuo-fexofenadine"],
    created: 3,
    submitted: 2,
    pharmacy: "ph-heping",
    pickup: [1, "afternoon"],
    events: [[2, "submitted", "kuo", "送出領藥預約", "Refill pickup sent"]],
  },
  {
    key: "hsieh-clopidogrel",
    patient: "hsieh",
    kind: "renewal",
    status: "visit_required",
    items: ["hsieh-clopidogrel"],
    created: 100,
    submitted: 98,
    answers: { ap_black_stool: false, ap_indication: "stent_or_event", ap_bleeding: true, ap_procedure: true },
    pharmacy: "ph-anhe",
    assigned: "dr",
    decide: { by: "dr", ago: 60, outcomes: { "hsieh-clopidogrel": ["visit_required", "近期要拔牙且容易瘀青，需當面討論。"] }, patient: "您最近要拔牙，又容易瘀青，這個藥請不要自己停，先約這週的門診討論。" },
    events: [
      [98, "submitted", "hsieh", "送出續開申請", "Renewal request sent"],
      [60, "decided", "dr", "醫師請您回診", "The doctor asked for a visit"],
    ],
  },
  {
    key: "wang-bisoprolol",
    patient: "wang",
    kind: "refill",
    status: "returned",
    items: ["wang-bisoprolol"],
    created: 70,
    submitted: 69,
    pharmacy: "ph-anhe",
    pickup: [0, "morning"],
    assigned: "rph",
    events: [
      [69, "submitted", "wang", "送出領藥預約", "Refill pickup sent"],
      [66, "accepted", "rph", "藥局開始處理", "Pharmacy started"],
      [48, "returned", "rph", "藥局退回：病人說醫院剛換過藥，請先確認處方", "Returned: the patient says the hospital changed the medicine, please confirm the prescription"],
    ],
    messages: [[48, "rph", "病人電話中說上週在醫院換了心律的藥，這張慢箋先不調劑，請醫師確認。", "staff"]],
  },
  {
    key: "li-valsartan-done",
    patient: "li",
    kind: "refill",
    status: "dispensed",
    items: ["li-valsartan"],
    created: 60,
    submitted: 59,
    pharmacy: "ph-minsheng",
    pickup: [-1, "evening"],
    assigned: "rph",
    events: [
      [59, "submitted", "li", "送出領藥預約", "Refill pickup sent"],
      [55, "accepted", "rph", "藥局開始處理", "Pharmacy started"],
      [40, "ready", "rph", "備藥完成，可以領藥", "Ready for pickup"],
      [26, "dispensed", "rph", "已領藥（第 3 次）", "Collected (fill 3)"],
    ],
  },
  {
    key: "tsai-urgent",
    patient: "tsai",
    kind: "renewal",
    status: "in_review",
    items: ["tsai-omeprazole"],
    created: 2,
    submitted: 1,
    answers: { ppi_black_stool: true, ppi_alarm: false, ppi_reviewed: false },
    pharmacy: "ph-heping",
    priority: "urgent",
    events: [
      [1, "submitted", "tsai", "送出續開申請", "Renewal request sent"],
      [1, "urgent", null, "回答有危急徵象，已請病人立即就醫並開立緊急單", "Danger sign in the answers; the patient was told to seek care and an urgent ticket was opened"],
    ],
  },
  {
    key: "chang-cetirizine-ph",
    patient: "chang",
    kind: "refill",
    status: "at_pharmacy",
    items: ["chang-cetirizine"],
    created: 12,
    submitted: 11,
    pharmacy: "ph-minsheng",
    pickup: [1, "morning"],
    events: [
      [11, "submitted", "chang", "送出領藥預約", "Refill pickup sent"],
      [10, "accepted", "rph", "藥局開始處理", "Pharmacy started"],
    ],
  },
  {
    key: "lin-sita-more",
    patient: "lin",
    kind: "renewal",
    status: "more_info",
    items: ["lin-sitagliptin"],
    created: 52,
    submitted: 51,
    answers: { dpp4_pancreatitis: false, dpp4_joint: true, dpp4_blisters: false, dpp4_heart_failure: false },
    monitoring: { a1c: [7.2, 75], egfr_annual: [undefined, 75], uacr_annual: [undefined, 75], eye_exam: [undefined, 200], foot_exam: [undefined, 75] },
    pharmacy: "ph-anhe",
    assigned: "dr",
    events: [
      [51, "submitted", "lin", "送出續開申請", "Renewal request sent"],
      [5, "more_info", "dr", "醫師請您補充資料", "The doctor asked for more information"],
    ],
    messages: [[5, "dr", "您說關節會痛，是哪個關節、從什麼時候開始、有沒有腫起來？"]],
  },
];

const HOUR = 3_600_000;

export function buildRx(now: number, today: string, prescriptions: PrescriptionRec[], lastSeenDays: (patientId: string) => number | null): RxRec[] {
  const iso = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString().replace(/\.\d{3}Z$/, "Z");
  const who = (key: string | null | undefined) => (key ? fid(`account:${key}`) : null);
  return SCRIPTS.map((s, index): RxRec => {
    const id = fid(`rx:${s.key}`);
    const patient_id = fid(`account:${s.patient}`);
    const monitoring: Record<string, MonitoringValue> = Object.fromEntries(
      Object.entries(s.monitoring ?? {}).map(([k, [value, ago]]) => [k, { ...(value === undefined ? {} : { value }), date: addDays(today, -ago), source: "patient" as const }]),
    );
    const classes = s.items.map((key) => DRUGS.get(prescriptions.find((x) => x.id === fid(`prescription:${key}`))?.drug_id ?? "")?.class_id ?? "");
    const filled = s.submitted === undefined ? {} : s.kind === "renewal" ? calmAnswers(classes) : { symptom_changed: false, side_effects: false, special_status: "none" };
    const answers: Record<string, unknown> = { ...filled, ...s.answers };
    const rows = s.items.map((key) => {
      const p = prescriptions.find((x) => x.id === fid(`prescription:${key}`));
      if (!p) throw new Error(`unknown prescription ${key}`);
      const drug = DRUGS.get(p.drug_id);
      if (!drug) throw new Error(`unknown drug ${p.drug_id}`);
      const itemId = fid(`rxitem:${s.key}:${key}`);
      if (s.kind === "renewal" && s.status !== "draft") answers[identityKey(itemId)] = true;
      const decision = s.decide?.outcomes[key];
      return {
        p,
        drug,
        item: {
          id: itemId,
          prescription_id: p.id,
          engine: s.kind === "renewal" && s.submitted !== undefined ? evaluateItem(p.drug_id, answers, monitoring, lastSeenDays(patient_id), today, "zh-TW") : null,
          refill: s.kind === "refill" ? medicationCard(p, today, "zh-TW", null).refill_preview : null,
          decision: s.decide && decision ? { outcome: decision[0], note: decision[1], by: who(s.decide.by)!, at: iso(s.decide.ago) } : null,
        },
      };
    });
    const engineItems = rows.flatMap((r) => (r.item.engine ? [{ class_id: r.drug.class_id, scope: r.drug.scope, engine: r.item.engine }] : []));
    const engine = engineItems.length ? evaluateRequest(engineItems, monitoring, today, iso(s.submitted ?? 0), "zh-TW") : null;
    const priority: Urgency = s.priority ?? (engine && worstDisposition([engine.disposition]) === "in_person" ? "soon" : "routine");
    const timeline: RxEventRec[] = [
      { at: iso(s.created), type: "created", actor_id: patient_id, zh: "建立申請", en: "Request started", visibility: "all" },
      ...(s.events ?? []).map(([h, type, by, zh, en, visibility]): RxEventRec => ({ at: iso(h), type, actor_id: who(by), zh, en, visibility: visibility ?? "all" })),
    ];
    const created = iso(s.created);
    return {
      id,
      no: `RX-${created.slice(0, 10).replaceAll("-", "")}-${String(index + 1).padStart(4, "0")}`,
      kind: s.kind,
      status: s.status,
      revision: s.status === "draft" ? 4 : 6,
      patient_id,
      items: rows.map((r) => r.item),
      step: s.step ?? "review",
      answers,
      monitoring,
      engine,
      pharmacy_id: s.pharmacy ?? null,
      pickup_window: s.pickup ? { date: addDays(today, s.pickup[0]), slot: s.pickup[1] } : null,
      assigned_to: who(s.assigned),
      priority,
      sla_due_at: s.submitted === undefined ? null : iso(s.submitted - (priority === "urgent" ? 1 : priority === "soon" ? 24 : 48)),
      decision_note: s.decide?.note ?? null,
      patient_message: s.decide?.patient ?? null,
      created_at: created,
      submitted_at: s.submitted === undefined ? null : iso(s.submitted),
      updated_at: timeline.at(-1)?.at ?? created,
      timeline,
      messages: (s.messages ?? []).map(([h, by, body, visibility], i) => ({ id: fid(`rxmsg:${s.key}:${i}`), author_id: who(by)!, body, created_at: iso(h), visibility: visibility ?? "all" })),
      reads: { [patient_id]: iso(s.created - 0.5 > 0 ? s.created - 0.5 : 0) },
    };
  });
}
