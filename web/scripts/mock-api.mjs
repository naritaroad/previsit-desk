// Scripted stand-in for the Rust API (docs/api/contract.md), for working on the web client without
// the backend and for demos while the backend is down. Plain Node, no dependencies.
//
//   npm run mock            listens on 127.0.0.1:8088 (MOCK_PORT overrides)
//
// Behaviour is deterministic and simple on purpose: red-flag words skip the model, prescription
// requests are refused, anything else walks the intake fields in order. Special inputs for testing
// states: "/mock-429" (rate limited), "/mock-budget" (daily budget used up), "/mock-error" (500).
// MOCK_STRESS=1 adds one visit with absurd data (200 trace rows, long unbroken strings).

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.MOCK_PORT ?? 8088);
const MAX_CHARS = 800;
const PRIMARY = "gemini-3.5-flash-lite";
const FALLBACK = "gemini-3.1-flash-lite";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const minutesAgo = (m) => iso(new Date(Date.now() - m * 60_000));
const todayTaipei = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
const addDays = (date, n) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86_400_000).toISOString().slice(0, 10);
};
const dateOk = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

// ---------------------------------------------------------------- text

// Voice of the scripted assistant: a calm clinic nurse. Short plain sentences, no markdown, no
// exclamation marks, no stock "got it!" openers. Each reply echoes one concrete detail the patient
// just said, then asks one question (two at most). The real backend follows the same voice.
const TXT = {
  "zh-TW": {
    opening:
      "您好，我是 AI 預問診助理，不是醫師，不做診斷，也不開藥。我會問您幾個問題，整理成摘要交給醫師。請不要輸入真實姓名、身分證字號或病歷。如果現在有胸痛、呼吸困難這類緊急狀況，請直接撥打 119。先請問，今天哪裡不舒服？",
    redFlagBody:
      "您描述的症狀可能很危急。請馬上撥打 119，或請身邊的人陪您到最近的急診。不要自己開車。這次預問診先暫停，已通知醫療團隊。",
    redFlagMind:
      "您不是一個人。現在就可以打 1925 安心專線，24 小時都有人接。情況危急時請撥 119。這次預問診先暫停，已通知醫療團隊。",
    plainAck: "好，我記下了。",
    afterRedFlag: "這次預問診已經暫停。請先撥打 119 或 1925，或到最近的急診。之後要重新開始，請按「開始新的預問診」。",
    refusal: "這個我不能做。我不能開藥，也不能說明用藥劑量。我已經記下您的需求，看診時醫師會跟您討論。我們先把剛才的問題答完好嗎？",
    refusalInject: "這個我沒辦法照做。我只負責整理看診前的資料。我們繼續剛才的問題好嗎？",
    outOfScope: "這個問題我沒辦法回答，我只負責整理看診前的資料和檢核慢箋。",
    medQuestion: "這個要由醫師判斷，我先記在「想問醫師的問題」。",
    confirmIntro: "我把剛才的內容整理了一下，請您看看有沒有錯：",
    confirmAsk: "沒問題的話，請回覆「確認」，我就交給醫師。",
    done: "已交給醫師。看診時醫師會先看過這份摘要。如果症狀變嚴重，請不要等，直接就醫。",
    closed: "這次預問診已送出，不能再補充。",
    budget: "AI 暫時無法回覆。紅旗檢查與慢箋檢核仍可使用，您也可以按「結束並送出」。",
    // The question for each field.
    q: {
      chief_complaint: "今天哪裡不舒服？",
      "hpi.onset": "是什麼時候開始的？",
      "hpi.course": "從開始到現在，有比較好、比較糟，還是差不多？",
      "hpi.severity": "如果 0 分是完全不痛，10 分是痛到受不了，您大概幾分？",
      "hpi.associated": "還有其他不舒服嗎？像是發燒、噁心或頭暈。",
      past_history: "以前醫師有說過您有什麼慢性病，或開過刀嗎？沒有的話，回答「沒有」就好。",
      medications: "最近有固定在吃的藥或保健食品嗎？沒有就回答「沒有」。",
      allergies: "對藥物或食物有過敏嗎？沒有就回答「沒有」。",
    },
    // What the assistant says back about the answer it just got (e is the patient's own words).
    ack: {
      chief_complaint: (e) => `好，${e}。`,
      "hpi.onset": (e) => `${e}，我記下了。`,
      "hpi.course": (e) => `${e}，好。`,
      "hpi.severity": (e) => `大約 ${e}，我記下了。`,
      "hpi.associated": (e) => `${e}，好。`,
      past_history: (e) => `${e}，我記在這裡。`,
      medications: (e) => `${e}，我記下了。`,
      allergies: (e) => `${e}，好。`,
    },
    refill: {
      eligible: ["可以憑慢箋領藥", "今天在可領藥期間內，請帶慢箋和健保卡到藥局。"],
      too_early: [(d) => `還不能領，${d}起可領`, "第二、三次領藥，要在上次給藥期間屆滿前 10 天內。"],
      revisit: ["這張慢箋不能再領，請回診", "請預約門診，讓醫師重新評估。"],
      consult: ["這次需要藥師或醫師確認", "我們已建立轉交單。到藥局時請告訴藥師，或回診讓醫師評估。"],
      r: {
        in_window: "今天在可領期間內。",
        too_early: "最早可領日是上次給藥屆滿日的前 10 天。",
        expired: "慢箋的有效期限已過。",
        all_filled: "這張慢箋的調劑次數都領完了。",
        bad_days: "給藥日數不符規定：總日數最多 90 天，每次調劑 30 天以內。",
        controlled: "處方可能含第一、二級管制藥品，管制藥不能開在連續處方箋上。",
        symptom: "您說症狀有變化，需要醫師評估要不要調整。",
        side_effects: "您說吃藥後有不舒服，需要醫師或藥師評估。",
        special: "特殊身分可以切結一次領取總藥量，要由藥師確認。",
      },
      rules: {
        max_total_days: "慢性病連續處方箋的有效期，依醫師實際給藥日數計算，最多 90 天。",
        max_days_per_fill: "分次調劑，每次 30 天以內。",
        early_window_days: "第二、三次領藥，要在上次給藥期間屆滿前 10 天內。",
        controlled: "第一、二級管制藥品不能開在連續處方箋上。",
        special: "預定出國、返回離島、遠洋漁船船員、國際航線船員和罕見疾病病人，可以切結一次領取總藥量。",
      },
    },
    narrative: (cc, n) => `病人自述${cc}。已整理 ${n} 個欄位，沒問到的欄位已列出。內容來自病人自述，不是診斷。`,
    disclaimer: "這份摘要由病人自述整理而成，不是診斷，也不是處方。",
    ticketRedFlag: "紅旗命中，請儘快聯絡病人。",
    ticketRx: "病人要求處方或用藥建議，需要醫師處理。",
    ticketPatient: "病人請醫師聯絡。",
    ticketRefill: "慢箋檢核的結果是「請洽藥師或醫師」。",
  },
  en: {
    opening:
      "Hello, I'm an AI pre-visit assistant, not a doctor. I don't diagnose or prescribe. I'll ask a few questions and put the answers into a summary for your doctor. Please don't enter your real name, ID number or medical records. If you have chest pain or trouble breathing right now, call 119. First, what's bothering you today?",
    redFlagBody:
      "What you describe may be an emergency. Call 119 now, or have someone take you to the nearest emergency room. Don't drive yourself. This pre-visit is paused and the care team has been told.",
    redFlagMind:
      "You're not alone. You can call the 1925 hotline right now, 24 hours a day. If you are in immediate danger, call 119. This pre-visit is paused and the care team has been told.",
    plainAck: "Okay, noted.",
    afterRedFlag: "This pre-visit is paused. Please call 119 or 1925, or go to the nearest emergency room first. To start over, choose \"Start a new pre-visit\".",
    refusal: "I can't do that. I can't prescribe or tell you a dose. I've noted your request, and the doctor will talk it over with you at the visit. Shall we finish the questions first?",
    refusalInject: "I can't do that. I only collect information before a visit. Shall we go back to the questions?",
    outOfScope: "I can't answer that. I only collect pre-visit information and check refills.",
    medQuestion: "That is for the doctor to judge. I've noted it under \"Questions for the doctor\".",
    confirmIntro: "Here is what you told me. Please check it:",
    confirmAsk: "If it looks right, reply \"confirm\" and I'll hand it to the doctor.",
    done: "Sent to the doctor, who will read this summary before your visit. If your symptoms get worse, don't wait. Get care right away.",
    closed: "This pre-visit has been sent. You can't add to it.",
    budget: "The AI can't reply right now. Red-flag checks and refill checks still work, or you can choose \"Finish and send\".",
    q: {
      chief_complaint: "What's bothering you today?",
      "hpi.onset": "When did it start?",
      "hpi.course": "Since then, has it got better, worse, or stayed about the same?",
      "hpi.severity": "If 0 is no pain and 10 is unbearable, about where would you put it?",
      "hpi.associated": "Anything else bothering you? For example a fever, nausea or dizziness.",
      past_history: "Has a doctor ever told you about a long-term condition, or have you had surgery? If not, just answer \"none\".",
      medications: "Do you take any medicine or supplements regularly? If not, answer \"none\".",
      allergies: "Any allergies to medicine or food? If not, answer \"none\".",
    },
    ack: {
      chief_complaint: (e) => `Okay, ${e}.`,
      "hpi.onset": (e) => `${e}. I've noted that.`,
      "hpi.course": (e) => `${e}. Okay.`,
      "hpi.severity": (e) => `About ${e}. Noted.`,
      "hpi.associated": (e) => `${e}. Okay.`,
      past_history: (e) => `${e}. I'll put that down.`,
      medications: (e) => `${e}. Noted.`,
      allergies: (e) => `${e}. Okay.`,
    },
    refill: {
      eligible: ["You can refill with this prescription", "Today is inside the refill window. Bring the prescription and your NHI card to a pharmacy."],
      too_early: [(d) => `Not yet. You can refill from ${d}`, "The 2nd and 3rd fills have to be within 10 days before the previous supply ends."],
      revisit: ["This prescription can't be refilled. Book a visit", "Please book a clinic visit so the doctor can reassess."],
      consult: ["A pharmacist or doctor needs to check this", "We've opened a handoff ticket. Tell the pharmacist at the pharmacy, or book a visit for the doctor to assess."],
      r: {
        in_window: "Today is inside the refill window.",
        too_early: "The earliest date is 10 days before the previous supply ends.",
        expired: "The prescription's validity period has passed.",
        all_filled: "All fills of this prescription have been collected.",
        bad_days: "The days don't meet the rules: at most 90 days in total and 30 days per fill.",
        controlled: "The prescription may include a Schedule 1 or 2 controlled drug, which can't be on a refill prescription.",
        symptom: "You said your symptoms changed. A doctor needs to decide whether to adjust.",
        side_effects: "You said you felt unwell after taking it. A doctor or pharmacist needs to assess that.",
        special: "Special status allows signing for one fill of the whole amount. A pharmacist has to confirm.",
      },
      rules: {
        max_total_days: "A chronic-disease refill prescription is valid for the days the doctor prescribed, at most 90.",
        max_days_per_fill: "It is dispensed in parts of at most 30 days.",
        early_window_days: "The 2nd and 3rd fills have to be within 10 days before the previous supply ends.",
        controlled: "Schedule 1 and 2 controlled drugs can't be on a refill prescription.",
        special: "People going abroad, returning to an outlying island, fishing or international crew, and rare-disease patients may sign for one fill of the full amount.",
      },
    },
    narrative: (cc, n) => `Patient reports ${cc}. ${n} fields collected; the ones not asked are listed. Based on the patient's own words, not a diagnosis.`,
    disclaimer: "This summary is built from the patient's own words. It is not a diagnosis or a prescription.",
    ticketRedFlag: "Red flag matched. Contact the patient promptly.",
    ticketRx: "Patient asked for a prescription or medicine advice. Needs a clinician.",
    ticketPatient: "Patient asked a clinician to get in touch.",
    ticketRefill: "The refill check result was \"ask a pharmacist or doctor\".",
  },
};

/** The patient's own words, trimmed, shortened, and turned to second person for Chinese ("我" to "您"). */
function echoOf(text, locale) {
  // The first clause only, never cut mid-word; a clause that is still long is not echoed at all.
  let e = text.trim().split(/[，,。.;；!！?？]/u)[0].trim();
  if (locale === "en") {
    e = e.replace(/\bI've\b/g, "you've").replace(/\bI have\b/g, "you have").replace(/\bI'm\b/g, "you're").replace(/\bI am\b/g, "you are").replace(/\bmy\b/gi, "your").replace(/\bI\b/g, "you");
  } else {
    e = e.replace(/我/g, "您");
  }
  if (locale === "en") e = e.charAt(0).toUpperCase() + e.slice(1);
  return [...e].length > (locale === "en" ? 48 : 24) ? "" : e;
}
const fmtDay = (date, locale) =>
  new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "zh-TW", { month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

const tx = (locale) => TXT[locale] ?? TXT["zh-TW"];

const RULE_URL = "https://www.nhi.gov.tw/ch/dl-16583-02c2bb704a1b4f64a4e366d605bcf29d-1.pdf";
const RULE_URL_EARLY = "https://health.ntuh.gov.tw/health/NTUH_e_Net/NTUH_e_Net_no239/%E7%94%A8%E8%97%A5FAQ_No239.pdf";

// ---------------------------------------------------------------- red flags and scope

const RED_FLAGS = [
  { category: "suicide", label: { "zh-TW": "自傷或自殺念頭", en: "Thoughts of self-harm or suicide" }, mind: true, re: /自殺|想死|不想活|結束生命|傷害自己|suicid|kill myself|end my life/i },
  { category: "chest_pain", label: { "zh-TW": "胸痛", en: "Chest pain" }, re: /胸痛|胸口悶痛|胸口痛|胸悶|心絞痛|chest pain|chest tight/i },
  { category: "dyspnea", label: { "zh-TW": "呼吸困難", en: "Trouble breathing" }, re: /喘不過氣|呼吸困難|無法呼吸|不能呼吸|can'?t breathe|short of breath/i },
  { category: "stroke", label: { "zh-TW": "疑似中風", en: "Possible stroke" }, re: /臉歪|單側無力|半邊無力|口齒不清|說話不清|face droop|slurred/i },
  { category: "consciousness", label: { "zh-TW": "意識不清", en: "Altered consciousness" }, re: /意識不清|昏倒|昏迷|叫不醒|passed out|unconscious/i },
  { category: "gi_bleeding", label: { "zh-TW": "吐血或黑便", en: "Vomiting blood or black stool" }, re: /吐血|解黑便|黑便|vomit(ing)? blood|black stool/i },
  { category: "anaphylaxis", label: { "zh-TW": "疑似嚴重過敏", en: "Possible severe allergic reaction" }, re: /喉嚨緊|喉嚨腫|臉腫|全身蕁麻疹|anaphyla|throat clos/i },
  { category: "seizure", label: { "zh-TW": "癲癇發作", en: "Seizure" }, re: /癲癇|抽搐|痙攣發作|seizure|convuls/i },
];
const NEGATIONS = /(沒有|沒|無|不會|不是|否認|並無|no |not |without |deny )\s*$/i;

function redFlagCheck(text, locale) {
  for (const f of RED_FLAGS) {
    const re = new RegExp(f.re.source, f.re.flags.includes("g") ? f.re.flags : f.re.flags + "g");
    for (const m of text.matchAll(re)) {
      const before = text.slice(Math.max(0, m.index - 4), m.index);
      if (NEGATIONS.test(before)) continue;
      return { category: f.category, label: f.label[locale] ?? f.label["zh-TW"], mind: !!f.mind };
    }
  }
  return null;
}

function scopeCheck(text) {
  if (/忽略(以上|上面|先前)?(的)?(規則|指令|提示)|系統提示詞|ignore (all |the )?(previous|above)|system prompt/i.test(text)) return "injection";
  if (/安眠藥|管制藥|止痛針|嗎啡|吩坦尼|zolpidem|opioid|sleeping pill/i.test(text)) return "controlled_drug";
  if (/幫我開|開(給我)?.{0,4}藥|吃幾顆|吃多少|劑量|幾毫克|幾mg|prescribe|what dose|how many pills/i.test(text)) return "prescription_request";
  return "ok";
}

// ---------------------------------------------------------------- store

const visits = new Map();
const tickets = [];
let ticketSeq = 0;
const sessions = new Set();
const rate = { visitStamps: [], loginFails: 0 };

const emptyIntake = () => ({
  chief_complaint: null,
  hpi: { onset: null, modifiers: null, character: null, location: null, severity: null, course: null, associated: null },
  past_history: { answered: false, items: [] },
  medications: { answered: false, items: [] },
  allergies: { answered: false, items: [] },
  patient_questions: [],
});

// Contract 7.4: the key order is fixed; `missing` and `progress` cover all 11 keys, the stage only the core ones.
const FIELD_ORDER = ["chief_complaint", "hpi.onset", "hpi.course", "hpi.location", "hpi.character", "hpi.severity", "hpi.modifiers", "hpi.associated", "past_history", "medications", "allergies"];
const CORE = new Set(["chief_complaint", "hpi.onset", "hpi.course", "hpi.severity", "hpi.associated", "past_history", "medications", "allergies"]);
// What the scripted assistant asks for, in this order (core fields only; the others stay "suggested").
const ASK_ORDER = ["chief_complaint", "hpi.onset", "hpi.course", "hpi.severity", "hpi.associated", "past_history", "medications", "allergies"];
const NA = "不適用";

function getField(state, key) {
  if (key === "chief_complaint") return state.chief_complaint;
  if (key.startsWith("hpi.")) return state.hpi[key.slice(4)];
  return state[key].answered ? state[key] : null;
}
const missingKeys = (state) => FIELD_ORDER.filter((k) => getField(state, k) === null);
const coreMissing = (state) => ASK_ORDER.filter((k) => getField(state, k) === null);

function intakeView(v) {
  const missing = missingKeys(v.state);
  const stage = v.visit.status === "submitted" || v.visit.status === "reviewed" ? "done" : stageOf(v.state);
  return { state: v.state, stage, missing, progress: { done: FIELD_ORDER.length - missing.length, total: FIELD_ORDER.length } };
}
function stageOf(state) {
  const core = coreMissing(state);
  if (core.length === 0) return "confirm";
  if (core[0] === "chief_complaint") return "chief_complaint";
  if (core[0].startsWith("hpi.")) return "hpi";
  return "background";
}

function newVisit(locale, extra = {}) {
  const id = randomUUID();
  const now = iso();
  const visit = {
    id, locale, status: "active", stage: "chief_complaint", urgency: "routine", created_at: now, updated_at: now,
    submitted_at: null, reviewed_at: null, reviewed_by: null, review_note: null, ...extra,
  };
  const v = { visit, messages: [], state: emptyIntake(), summary: null, redFlag: null, tickets: [], toolCalls: [], runs: [], refills: [], confirming: false, stamps: [] };
  visits.set(id, v);
  return v;
}

function addMessage(v, role, kind, content, run_id = null, created_at = iso()) {
  const m = { id: randomUUID(), role, kind, content, created_at, run_id };
  v.messages.push(m);
  v.visit.updated_at = created_at;
  return m;
}

function addTicket(v, reason, urgency, summary, created_by) {
  ticketSeq += 1;
  const d = todayTaipei().replaceAll("-", "");
  const t = {
    id: randomUUID(), ticket_no: `T-${d}-${String(ticketSeq).padStart(4, "0")}`, visit_id: v.visit.id, reason, urgency, summary,
    status: "open", created_by, created_at: iso(), resolved_at: null, resolved_by: null, resolution_note: null,
  };
  tickets.push(t);
  v.tickets.push(t);
  recomputeUrgency(v);
  return t;
}
function recomputeUrgency(v) {
  const open = v.tickets.filter((t) => t.status === "open");
  v.visit.urgency = open.some((t) => t.urgency === "urgent") ? "urgent" : open.some((t) => t.urgency === "soon") ? "soon" : "routine";
}

function addToolCall(v, run_id, step, name, source, status, args, result, duration_ms, created_at = iso()) {
  const c = { id: randomUUID(), run_id, step, name, source, status, arguments: args, result, duration_ms, created_at };
  v.toolCalls.push(c);
  return c;
}

/** The two code prechecks of a message, in the shapes of contract 7.5. */
function precheckRows(v, runId, chars, hit, verdict, at = iso()) {
  addToolCall(v, runId, 0, "red_flag_precheck", "code", "ok", { chars }, hit ? { hit: true, category: hit.category, label: hit.label, rule_id: `rf-${hit.category}-01` } : { hit: false }, 2, at);
  addToolCall(v, runId, 0, "scope_precheck", "code", "ok", { chars }, { verdict }, 1, at);
}

function buildSummary(v, by) {
  const L = tx(v.visit.locale);
  const s = v.state;
  const notCollected = missingKeys(s);
  const triggered = v.redFlag ? [{ category: v.redFlag.category, label: v.redFlag.label }] : [];
  const cc = s.chief_complaint; // null when submitted before any complaint (contract 7: nullable)
  const ccText = cc ?? (v.visit.locale === "en" ? "(none yet)" : "（尚無）");
  return {
    visit_id: v.visit.id,
    chief_complaint: cc,
    hpi: s.hpi,
    past_history: s.past_history.items,
    medications: s.medications.items,
    allergies: s.allergies.items,
    not_collected: notCollected,
    red_flag_screen: {
      checked: true,
      triggered,
      note: triggered.length ? (v.visit.locale === "en" ? "A red flag was matched." : "命中紅旗規則。") : v.visit.locale === "en" ? "No red-flag rule matched." : "未命中紅旗規則。",
    },
    patient_questions: s.patient_questions,
    narrative: L.narrative(ccText, FIELD_ORDER.length - notCollected.length),
    refill: v.refills.length ? v.refills[v.refills.length - 1].result : null,
    generated_by: by === "model" ? { kind: "model", model: PRIMARY, at: iso() } : { kind: "code", model: null, at: iso() },
    disclaimer: L.disclaimer,
  };
}

/** Patient projection (contract 7.3): clinician-private fields are null. The clinician gets everything. */
function detail(v, forClinician = false) {
  const visit = forClinician ? v.visit : { ...v.visit, reviewed_by: null, review_note: null };
  const tix = forClinician ? v.tickets : v.tickets.map((t) => ({ ...t, resolved_by: null, resolution_note: null }));
  return {
    visit, messages: v.messages, intake: intakeView(v), summary: v.summary, red_flag: v.redFlag,
    tickets: tix, tool_calls: v.toolCalls, runs: v.runs,
    refill_checks: v.refills,
  };
}

/** PII filter (contract 7.5): masks phone numbers and national IDs; returns the masked text and what was masked. */
function maskPii(text) {
  let masked = 0;
  const kinds = new Set();
  const out = text
    .replace(/\b[A-Z][12]\d{8}\b/g, () => (masked++, kinds.add("id_number"), "[已遮蔽]"))
    .replace(/\b09\d{2}[- ]?\d{3}[- ]?\d{3}\b|\b0\d{1,2}[- ]\d{6,8}\b/g, () => (masked++, kinds.add("phone"), "[已遮蔽]"));
  return { text: out, masked, kinds: [...kinds] };
}

// ---------------------------------------------------------------- seeded clinician data

function seed() {
  const mk = (locale, minsAgo, build) => {
    const v = newVisit(locale);
    v.visit.created_at = minutesAgo(minsAgo + 12);
    build(v, minsAgo);
    v.visit.updated_at = minutesAgo(minsAgo);
    return v;
  };
  const chat = (v, role, kind, content, minsAgo, run) => addMessage(v, role, kind, content, run ?? null, minutesAgo(minsAgo));
  const L = tx("zh-TW");

  // 1. urgent red flag
  mk("zh-TW", 6, (v, m) => {
    chat(v, "assistant", "opening", L.opening, m + 12);
    chat(v, "patient", "chat", "我從剛剛開始胸口悶痛，還有點冒冷汗", m);
    v.state.chief_complaint = "胸口悶痛，冒冷汗";
    v.visit.status = "red_flag"; v.visit.stage = "chief_complaint";
    v.redFlag = { category: "chest_pain", label: "胸痛", matched_at: minutesAgo(m), message_id: v.messages[1].id };
    const run = { id: randomUUID(), model: "rules", fallback_used: false, status: "skipped", steps: 0, usage: { input_tokens: 0, output_tokens: 0 }, error_code: null, duration_ms: 3, created_at: minutesAgo(m) };
    v.runs.push(run);
    chat(v, "assistant", "red_flag", L.redFlagBody, m, run.id);
    precheckRows(v, run.id, [...v.messages[1].content].length, { category: "chest_pain", label: "胸痛" }, "ok", minutesAgo(m));
    const t = addTicket(v, "red_flag", "urgent", L.ticketRedFlag, "code");
    t.created_at = minutesAgo(m);
    addToolCall(v, run.id, 1, "transfer_to_clinician", "code", "ok", { reason: "red_flag", urgency: "urgent", summary: L.ticketRedFlag }, { ticket_no: t.ticket_no, deduped: false }, 4, minutesAgo(m));
  });

  // 2. submitted, routine, cough
  mk("zh-TW", 95, (v, m) => {
    const q = L.q;
    chat(v, "assistant", "opening", L.opening, m + 12);
    const turns = [
      ["chief_complaint", "咳嗽三天，晚上比較嚴重"],
      ["hpi.onset", "大概三天前淋雨之後開始"],
      ["hpi.modifiers", "喝熱水會好一點，躺下來會更咳"],
      ["hpi.character", "乾咳，喉嚨有點癢"],
      ["hpi.location", "不適用"],
      ["hpi.severity", "4"],
      ["hpi.course", "差不多，沒有變嚴重"],
      ["hpi.associated", "有一點流鼻水，沒有發燒"],
      ["past_history", "有高血壓"],
      ["medications", "降血壓藥，每天早上一顆"],
      ["allergies", "沒有"],
    ];
    const run = { id: randomUUID(), model: PRIMARY, fallback_used: false, status: "completed", steps: 3, usage: { input_tokens: 8420, output_tokens: 612 }, error_code: null, duration_ms: 5400, created_at: minutesAgo(m) };
    v.runs.push(run);
    let t = m + 11;
    for (const [key, text] of turns) {
      if (q[key]) chat(v, "assistant", "chat", q[key], t, run.id);
      t -= 0.5;
      chat(v, "patient", "chat", text, t);
      t -= 0.5;
      applyPatch(v.state, key, text);
    }
    v.state.patient_questions = ["需不需要做胸部 X 光？"];
    precheckRows(v, run.id, 12, null, "ok", minutesAgo(m + 8));
    addToolCall(v, run.id, 1, "record_intake", "model", "ok", { chief_complaint: "咳嗽三天，晚上比較嚴重", hpi: { onset: "三天前淋雨後" } }, { applied: ["chief_complaint", "hpi.onset"], rejected: [] }, 14, minutesAgo(m + 8));
    addToolCall(v, run.id, 2, "search_health_education", "model", "ok", { query: "咳嗽 何時就醫", top_k: 3 }, {
      hits: [{ section: "cough-when-to-seek-care", title: "咳嗽什麼時候該就醫", source_type: "official", source_name: "衛福部", source_url: "https://www.mohw.gov.tw/", verified_on: "2026-11-25", score: 0.82 }],
    }, 220, minutesAgo(m + 6));
    addToolCall(v, run.id, 3, "output_guard", "code", "ok", { chars: 86 }, { passed: true, violations: [], action: "none" }, 3, minutesAgo(m + 5));
    addToolCall(v, run.id, 4, "save_previsit_summary", "model", "ok", { chief_complaint: "咳嗽三天" }, { saved: true, not_collected: [] }, 31, minutesAgo(m));
    chat(v, "assistant", "chat", L.done, m, run.id);
    v.visit.status = "submitted"; v.visit.stage = "done"; v.visit.submitted_at = minutesAgo(m);
    v.summary = buildSummary(v, "model");
    v.summary.generated_by.at = minutesAgo(m);
  });

  // 3. submitted, refill consult (soon)
  mk("zh-TW", 40, (v, m) => {
    chat(v, "assistant", "opening", L.opening, m + 10);
    chat(v, "patient", "chat", "我想先確認慢性病的藥可不可以領", m + 8);
    chat(v, "assistant", "chat", "可以到右側「慢箋檢核」填寫處方資料，由程式依規則檢核；這裡不會由我判斷。", m + 7);
    v.state.chief_complaint = "慢性病藥物續領確認";
    v.state.past_history = { answered: true, items: ["高血壓", "糖尿病"] };
    v.state.medications = { answered: true, items: ["降血壓藥", "降血糖藥"] };
    const input = { prescription_date: addDays(todayTaipei(), -50), total_days: 90, days_per_fill: 30, fills_done: 1, last_fill_date: addDays(todayTaipei(), -26), controlled: "no", special_status: "none", symptom_changed: false, side_effects: true };
    const result = refillResult(input, "zh-TW", "T-DEMO-0003");
    v.refills.push({ id: randomUUID(), input, result, created_at: minutesAgo(m + 5) });
    addToolCall(v, null, 1, "check_chronic_refill", "form", "ok", input, result, 4, minutesAgo(m + 5));
    const t = addTicket(v, "side_effects", "soon", L.ticketRefill, "form");
    t.ticket_no = "T-DEMO-0003"; t.created_at = minutesAgo(m + 5);
    addToolCall(v, null, 2, "transfer_to_clinician", "code", "ok", { reason: "side_effects", urgency: "soon", summary: L.ticketRefill }, { ticket_no: t.ticket_no, deduped: false }, 4, minutesAgo(m + 5));
    v.visit.status = "submitted"; v.visit.stage = "confirm"; v.visit.submitted_at = minutesAgo(m);
    v.summary = buildSummary(v, "code");
    recomputeUrgency(v);
  });

  // 4. reviewed, routine
  mk("zh-TW", 1500, (v, m) => {
    chat(v, "assistant", "opening", L.opening, m + 10);
    chat(v, "patient", "chat", "右膝疼痛兩週，上下樓梯更痛", m + 8);
    v.state.chief_complaint = "右膝疼痛兩週，上下樓梯更痛";
    v.state.hpi.onset = "兩週前"; v.state.hpi.severity = 6;
    v.state.allergies = { answered: true, items: [] };
    v.visit.status = "reviewed"; v.visit.stage = "done"; v.visit.submitted_at = minutesAgo(m + 2);
    v.visit.reviewed_at = minutesAgo(m - 60); v.visit.reviewed_by = "示範醫師"; v.visit.review_note = "已於門診追蹤。";
    v.summary = buildSummary(v, "code");
  });

  // 4b. reviewed AFTER a red flag: closed screens must still show the 119 / 1925 card (contract 7.1)
  mk("zh-TW", 700, (v, m) => {
    chat(v, "assistant", "opening", L.opening, m + 10);
    chat(v, "patient", "chat", "突然頭很痛，右手沒力氣，說話也有點口齒不清", m + 8);
    v.state.chief_complaint = "突然頭痛、右手無力、口齒不清";
    v.redFlag = { category: "stroke", label: "疑似中風", matched_at: minutesAgo(m + 8), message_id: v.messages[1].id };
    const run = { id: randomUUID(), model: "rules", fallback_used: false, status: "skipped", steps: 0, usage: { input_tokens: 0, output_tokens: 0 }, error_code: null, duration_ms: 3, created_at: minutesAgo(m + 8) };
    v.runs.push(run);
    chat(v, "assistant", "red_flag", L.redFlagBody, m + 8, run.id);
    precheckRows(v, run.id, 21, { category: "stroke", label: "疑似中風" }, "ok", minutesAgo(m + 8));
    const t = addTicket(v, "red_flag", "urgent", L.ticketRedFlag, "code");
    t.created_at = minutesAgo(m + 8); t.status = "resolved"; t.resolved_at = minutesAgo(m - 30); t.resolved_by = "示範醫師"; t.resolution_note = "已電話聯絡，病人已送醫。";
    recomputeUrgency(v);
    v.visit.status = "reviewed"; v.visit.stage = "chief_complaint"; v.visit.submitted_at = minutesAgo(m + 6);
    v.visit.reviewed_at = minutesAgo(m - 30); v.visit.reviewed_by = "示範醫師"; v.visit.review_note = "已電話聯絡，病人已送醫。";
    v.summary = buildSummary(v, "code");
  });

  // 5. in progress, English
  mk("en", 3, (v, m) => {
    const E = tx("en");
    chat(v, "assistant", "opening", E.opening, m + 3);
    chat(v, "patient", "chat", "Stomach ache since this morning", m + 2);
    chat(v, "assistant", "chat", E.q["hpi.onset"], m + 1);
    v.state.chief_complaint = "Stomach ache since this morning";
    const run = { id: randomUUID(), model: PRIMARY, fallback_used: false, status: "completed", steps: 1, usage: { input_tokens: 2100, output_tokens: 90 }, error_code: null, duration_ms: 1900, created_at: minutesAgo(m + 1) };
    v.runs.push(run);
    addToolCall(v, run.id, 1, "record_intake", "model", "ok", { chief_complaint: "Stomach ache since this morning" }, { applied: ["chief_complaint"], rejected: [] }, 11, minutesAgo(m + 1));
  });

  if (process.env.MOCK_STRESS) seedStress();
}

function seedStress() {
  const v = newVisit("zh-TW");
  const L = tx("zh-TW");
  const long = "Ａ".repeat(10) + "x".repeat(260) + "https://example.com/" + "a".repeat(200);
  addMessage(v, "assistant", "opening", L.opening, null, minutesAgo(30));
  addMessage(v, "patient", "chat", `${long} 胸悶 ABCDEFG 混合 mixed 中英文 ${"超長無空白字串".repeat(30)}`, null, minutesAgo(29));
  addMessage(v, "assistant", "chat", `${"回覆".repeat(120)} ${"y".repeat(300)}`, null, minutesAgo(28));
  v.state.chief_complaint = long;
  v.state.hpi.character = "超長無空白字串".repeat(30);
  v.state.medications = { answered: true, items: Array.from({ length: 20 }, (_, i) => `藥物${i}-${"z".repeat(70)}`) };
  const run = { id: randomUUID(), model: "gemini-3.5-flash-lite-" + "x".repeat(80), fallback_used: true, status: "completed", steps: 200, usage: { input_tokens: 9999999, output_tokens: 123456 }, error_code: null, duration_ms: 123456, created_at: minutesAgo(29) };
  v.runs.push(run);
  const names = ["record_intake", "search_health_education", "output_guard", "check_chronic_refill", "transfer_to_clinician", "save_previsit_summary", "brand_new_tool"];
  for (let i = 0; i < 200; i++) {
    addToolCall(v, run.id, i + 1, names[i % names.length], i % 3 === 0 ? "code" : "model", i % 17 === 0 ? "rejected" : i % 29 === 0 ? "error" : "ok", { patch: { x: long, i } }, { ok: true, note: long.repeat(2) }, 5 + i, minutesAgo(28));
  }
  v.visit.status = "submitted"; v.visit.stage = "done"; v.visit.submitted_at = minutesAgo(5);
  v.summary = buildSummary(v, "code");
  v.summary.narrative = long + " " + "。".repeat(10) + "很長的摘要".repeat(40);
  const t = addTicket(v, "other", "soon", long, "model");
  t.created_at = minutesAgo(10);
}

function applyPatch(state, key, text) {
  const t = text.trim().slice(0, 200);
  const none = /^(沒有|無|沒|none|no|nope)\.?$/i.test(t);
  const notApplicable = /^(不適用|n\/a|na|not applicable)\.?$/i.test(t);
  if (key === "chief_complaint") state.chief_complaint = t;
  else if (key === "hpi.severity") {
    const n = Number((t.match(/\d+/) ?? [""])[0]);
    state.hpi.severity = notApplicable || /不知道|說不出|don'?t know/i.test(t) ? "n/a" : Number.isFinite(n) && n >= 0 && n <= 10 && /\d/.test(t) ? n : 5;
  } else if (key.startsWith("hpi.")) state.hpi[key.slice(4)] = notApplicable ? NA : t; // the server normalises every spelling to 不適用
  else state[key] = { answered: true, items: none ? [] : t.split(/[、，,;；]/).map((s) => s.trim()).filter(Boolean).slice(0, 20) };
}

/** A body-part word in the first message also fills the location (a non-core field), like a model would. */
function guessLocation(text) {
  const m = text.match(/頭|胸|腹|肚子|喉嚨|膝|腰|背|stomach|head|chest|throat|knee|back/i);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------- refill rules

function refillResult(input, locale, ticketNo) {
  const L = tx(locale);
  const today = input.today ?? todayTaipei();
  const supplyEnd = addDays(input.last_fill_date, input.days_per_fill);
  const earliest = addDays(supplyEnd, -10);
  const latest = addDays(input.prescription_date, input.total_days);
  const reasons = [];
  const rules = [];
  const rule = (key) => {
    const urls = { early_window_days: RULE_URL_EARLY };
    if (!rules.some((r) => r.key === key)) rules.push({ key, text: L.refill.rules[key], source_url: urls[key] ?? RULE_URL });
  };
  const fills = Math.ceil(input.total_days / input.days_per_fill);
  let outcome;
  if (input.controlled !== "no") {
    outcome = "consult"; reasons.push({ code: "controlled", text: L.refill.r.controlled }); rule("controlled");
  } else if (input.symptom_changed || input.side_effects) {
    outcome = "consult";
    if (input.symptom_changed) reasons.push({ code: "symptom_changed", text: L.refill.r.symptom });
    if (input.side_effects) reasons.push({ code: "side_effects", text: L.refill.r.side_effects });
  } else if (input.special_status !== "none") {
    outcome = "consult"; reasons.push({ code: "special_status", text: L.refill.r.special }); rule("special");
  } else if (input.total_days > 90 || input.days_per_fill > 30) {
    outcome = "revisit"; reasons.push({ code: "bad_days", text: L.refill.r.bad_days }); rule("max_total_days"); rule("max_days_per_fill");
  } else if (today > latest) {
    outcome = "revisit"; reasons.push({ code: "expired", text: L.refill.r.expired }); rule("max_total_days");
  } else if (input.fills_done >= 3 || input.fills_done >= fills) {
    outcome = "revisit"; reasons.push({ code: "all_filled", text: L.refill.r.all_filled }); rule("max_days_per_fill");
  } else if (today < earliest) {
    outcome = "too_early"; reasons.push({ code: "too_early", text: L.refill.r.too_early }); rule("early_window_days");
  } else {
    outcome = "eligible"; reasons.push({ code: "in_window", text: L.refill.r.in_window }); rule("early_window_days");
  }
  let [title, message] = L.refill[outcome];
  if (typeof title === "function") title = title(fmtDay(earliest, locale));
  const handoff = outcome === "consult";
  return {
    outcome, title, message, today,
    earliest_date: outcome === "revisit" ? null : earliest,
    latest_date: latest,
    next_fill_number: outcome === "eligible" || outcome === "too_early" ? input.fills_done + 1 : null,
    reasons, rules, handoff, ticket_no: handoff ? ticketNo ?? null : null,
  };
}

// ---------------------------------------------------------------- http helpers

function send(res, status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "referrer-policy": "same-origin",
    "x-frame-options": "DENY", "cache-control": "no-store", ...headers,
  });
  res.end(text);
}
const fail = (res, status, code, message, extra = {}, headers = {}) => send(res, status, { error: { code, message, ...extra } }, headers);

function localeOf(req, v) {
  if (v) return v.visit.locale;
  return /^en/i.test(req.headers["accept-language"] ?? "") ? "en" : "zh-TW";
}
const em = (req, zh, en) => (localeOf(req) === "en" ? en : zh);

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

function cookie(req, name) {
  const m = (req.headers.cookie ?? "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name);
  return m?.[1] ?? null;
}
const authed = (req) => sessions.has(cookie(req, "pv_session"));

// ---------------------------------------------------------------- SSE turn

/** Red-flag flow shared by messages and handoff notes (contract 7.1): any status moves to red_flag; no duplicate open ticket. */
function applyRedFlag(v, rf, messageId) {
  const hit = { category: rf.category, label: rf.label, matched_at: iso(), message_id: messageId };
  v.redFlag = hit; // the latest hit
  v.visit.status = "red_flag";
  const open = v.tickets.find((t) => t.reason === "red_flag" && t.status === "open");
  const ticket = open ? null : addTicket(v, "red_flag", "urgent", tx(v.visit.locale).ticketRedFlag, "code");
  return { hit, ticket, deduped: !!open, ticketNo: (open ?? ticket).ticket_no };
}

async function handleMessage(req, res, v, rawContent) {
  const locale = v.visit.locale;
  const L = tx(locale);
  v.busy = true; // one message at a time per visit (contract 7.6)
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no",
    "x-content-type-options": "nosniff", connection: "keep-alive",
  });
  let seq = 0;
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ v: 1, seq: ++seq, type, data })}\n\n`);
  const pause = (ms) => sleep(ms);
  try {
    // The PII filter runs first; what is stored (and shown after a reload) is the masked text.
    const pii = maskPii(rawContent);
    const content = pii.text;
    const chars = [...rawContent].length;
    const patientMsg = addMessage(v, "patient", "chat", content);
    emit("message.accepted", { message_id: patientMsg.id, visit_id: v.visit.id });
    await pause(120);

    const rf = redFlagCheck(content, locale);
    const scope = scopeCheck(content);
    const runId = randomUUID();
    const hitView = rf ? { category: rf.category, label: rf.label, matched_at: iso(), message_id: patientMsg.id } : null;
    emit("precheck.completed", { red_flag: hitView, scope, duration_ms: 2 });
    res.write(": keep-alive\n\n"); // the real server sends these every 15 s; the client must ignore them
    await pause(100);

    const piiRow = () => pii.masked > 0 && addToolCall(v, runId, 0, "pii_filter", "code", "ok", { chars }, { masked: pii.masked, kinds: pii.kinds }, 1);
    // A reply written by code, without calling the model.
    const fixed = async (kind, text, { visitUpdated = false } = {}) => {
      const m = addMessage(v, "assistant", kind, text, runId);
      const run = { id: runId, model: "rules", fallback_used: false, status: "skipped", steps: 0, usage: { input_tokens: 0, output_tokens: 0 }, error_code: null, duration_ms: 3, created_at: iso() };
      v.runs.push(run);
      precheckRows(v, runId, chars, rf, scope);
      piiRow();
      emit("message.completed", { message_id: m.id, kind, content: text, run_id: runId });
      if (visitUpdated) emit("visit.updated", v.visit);
      emit("run.completed", { run_id: runId, status: "skipped", steps: 0, usage: run.usage, model: "rules" });
    };

    // 1) red flag: fixed text, no model, in whatever state the visit is in
    if (rf) {
      const r = applyRedFlag(v, rf, patientMsg.id);
      emit("redflag.triggered", { category: rf.category, label: rf.label, message_id: patientMsg.id });
      await pause(80);
      if (r.ticket) {
        emit("ticket.created", r.ticket);
        await pause(80);
      }
      await fixed("red_flag", rf.mind ? L.redFlagMind : L.redFlagBody, { visitUpdated: true });
      addToolCall(v, runId, 1, "transfer_to_clinician", "code", "ok", { reason: "red_flag", urgency: "urgent", summary: L.ticketRedFlag }, { ticket_no: r.ticketNo, deduped: r.deduped }, 4);
      return res.end();
    }
    // 2) closed visits answer 409 before the stream starts; this branch covers a visit that is already in red_flag
    if (v.visit.status === "red_flag") {
      await fixed("notice", L.afterRedFlag);
      return res.end();
    }
    // 3) refusal layer
    if (scope !== "ok") {
      const text = scope === "injection" ? L.refusalInject : L.refusal;
      if (scope !== "injection") {
        const t = addTicket(v, scope === "controlled_drug" ? "controlled_drug" : "prescription_request", "soon", L.ticketRx, "code");
        emit("ticket.created", t);
        await pause(80);
      }
      await fixed("refusal", text);
      return res.end();
    }
    // 4) test hook for the budget state
    if (content.trim() === "/mock-budget") {
      emit("run.started", { run_id: runId, model: PRIMARY });
      const m = addMessage(v, "assistant", "notice", L.budget, runId);
      v.runs.push({ id: runId, model: PRIMARY, fallback_used: false, status: "failed", steps: 0, usage: { input_tokens: 0, output_tokens: 0 }, error_code: "daily_budget_exceeded", duration_ms: 5, created_at: iso() });
      emit("message.completed", { message_id: m.id, kind: "notice", content: L.budget, run_id: runId });
      emit("run.failed", { run_id: runId, code: "daily_budget_exceeded", message: L.budget });
      return res.end();
    }

    // 5) the model run (scripted)
    const run = { id: runId, model: PRIMARY, fallback_used: false, status: "running", steps: 0, usage: { input_tokens: 0, output_tokens: 0 }, error_code: null, duration_ms: 0, created_at: iso() };
    v.runs.push(run);
    emit("run.started", { run_id: runId, model: PRIMARY });
    precheckRows(v, runId, chars, null, "ok");
    const t0 = Date.now();
    let step = 0;
    const tool = async (name, source, args, result, ms, status = "ok") => {
      step += 1;
      const c = addToolCall(v, runId, step, name, source, status, args, result, ms);
      emit("tool.started", { call_id: c.id, step, name, source, arguments: args });
      await pause(Math.max(150, ms));
      emit("tool.completed", { call_id: c.id, step, name, status, result, duration_ms: ms });
    };
    if (pii.masked > 0) await tool("pii_filter", "code", { chars }, { masked: pii.masked, kinds: pii.kinds }, 1);
    const publishIntake = () => emit("intake.updated", intakeView(v));
    const finish = async (reply, usage) => {
      await tool("output_guard", "code", { chars: [...reply].length }, { passed: true, violations: [], action: "none" }, Math.round(2 + Math.random() * 3));
      const words = [...reply];
      for (let i = 0; i < words.length; i += 4) {
        emit("message.delta", { text: words.slice(i, i + 4).join("") });
        await pause(28);
      }
      const m = addMessage(v, "assistant", "chat", reply, runId);
      emit("message.completed", { message_id: m.id, kind: "chat", content: reply, run_id: runId });
      run.status = "completed"; run.steps = step; run.usage = usage; run.duration_ms = Date.now() - t0;
      const stage = intakeView(v).stage;
      if (stage !== v.visit.stage || v.visit.status === "submitted") {
        v.visit.stage = stage;
        emit("visit.updated", v.visit);
      }
      emit("run.completed", { run_id: runId, status: "completed", steps: step, usage, model: PRIMARY });
    };

    await pause(300);
    const tokens = () => ({ input_tokens: 1800 + step * 650 + Math.round(Math.random() * 300), output_tokens: 60 + Math.round(Math.random() * 120) });
    const confirmText = () => `${L.confirmIntro}\n${summaryLines(v)}\n${L.confirmAsk}`;

    // confirm stage: the patient answers the read-back
    if (v.confirming) {
      v.summary = buildSummary(v, "model");
      await tool("save_previsit_summary", "model", { chief_complaint: v.state.chief_complaint }, { saved: true, not_collected: v.summary.not_collected }, 35);
      v.visit.status = "submitted"; v.visit.stage = "done"; v.visit.submitted_at = iso();
      emit("summary.updated", v.summary);
      await pause(100);
      publishIntake();
      await finish(L.done, tokens());
      return res.end();
    }

    const todo = coreMissing(v.state);
    const outOfScope = /天氣|寫程式|股票|笑話|weather|write (me )?(a )?(code|program)|joke/i.test(content);
    const asksMedical = /[？?]|嗎|要不要|該不該|什麼時候|怎麼辦|是不是|癌/.test(content) && todo.length < ASK_ORDER.length;

    if (outOfScope) {
      await finish(`${L.outOfScope} ${L.q[todo[0] ?? "chief_complaint"]}`, tokens());
      return res.end();
    }
    if (todo.length === 0) {
      v.confirming = true;
      await finish(confirmText(), tokens());
      return res.end();
    }
    if (asksMedical) {
      const hits = [{ section: "fever-cough-when-to-seek-care", title: locale === "en" ? "When to seek care for fever or cough" : "發燒與咳嗽何時該就醫", source_type: "official", source_name: "衛福部", source_url: "https://www.mohw.gov.tw/", verified_on: "2026-11-25", score: 0.78 }];
      await tool("search_health_education", "model", { query: content.slice(0, 40), top_k: 3 }, { hits }, 180);
      v.state.patient_questions.push(content.slice(0, 80));
      await tool("record_intake", "model", { patient_questions: [content.slice(0, 80)] }, { applied: ["patient_questions"], rejected: [] }, 12);
      publishIntake();
      await finish(`${L.medQuestion} ${L.q[todo[0]]}`, tokens());
      return res.end();
    }

    const key = todo[0];
    const patch = { [key]: content.trim().slice(0, 200) };
    applyPatch(v.state, key, content);
    const applied = [key];
    if (key === "chief_complaint" && v.state.hpi.location === null) {
      const loc = guessLocation(content);
      if (loc) { v.state.hpi.location = loc; applied.push("hpi.location"); patch.hpi = { location: loc }; }
    }
    await tool("record_intake", "model", patch, { applied, rejected: [] }, 10 + Math.round(Math.random() * 12));
    publishIntake();
    const next = coreMissing(v.state);
    if (next.length === 0) {
      v.confirming = true;
      await finish(confirmText(), tokens());
    } else {
      const shown = key === "hpi.severity" ? String(v.state.hpi.severity === "n/a" ? "N/A" : `${v.state.hpi.severity}${locale === "en" ? "/10" : " 分"}`) : echoOf(content, locale);
      const said = shown ? L.ack[key](shown) : L.plainAck;
      await finish(`${said} ${L.q[next[0]]}`, tokens());
    }
    res.end();
  } finally {
    v.busy = false;
  }
}

function summaryLines(v) {
  const s = v.state;
  const en = v.visit.locale === "en";
  const colon = en ? ": " : "：";
  const sep = en ? ", " : "、";
  const semi = en ? "; " : "；";
  const lines = [
    `${en ? "Main concern" : "主訴"}${colon}${s.chief_complaint}`,
    `${en ? "Onset" : "開始"}${colon}${s.hpi.onset}${semi}${en ? "Severity" : "程度"}${colon}${s.hpi.severity === "n/a" ? "N/A" : `${s.hpi.severity}/10`}`,
    `${en ? "History" : "過去病史"}${colon}${s.past_history.items.join(sep) || (en ? "none" : "無")}`,
    `${en ? "Medicines" : "用藥"}${colon}${s.medications.items.join(sep) || (en ? "none" : "無")}`,
    `${en ? "Allergies" : "過敏"}${colon}${s.allergies.items.join(sep) || (en ? "none" : "無")}`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------- routes

const UUID = "[0-9a-f-]{36}";
const route = (method, re) => (req, path) => req.method === method && re.exec(path);

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  if (!path.startsWith("/api/v1")) return fail(res, 404, "not_found", "not found");
  const p = path.slice("/api/v1".length) || "/";
  const jsonOnly = req.method !== "GET" && req.method !== "HEAD";
  if (jsonOnly && !/application\/json/.test(req.headers["content-type"] ?? "")) {
    return fail(res, 415, "unsupported_media_type", em(req, "請使用 application/json", "Use application/json"));
  }

  if (req.method === "GET" && p === "/health") return send(res, 200, { ok: true, version: "mock-0.1.0", model_ready: true });
  if (req.method === "GET" && p === "/meta") {
    return send(res, 200, {
      app: "PreVisit Desk", version: "mock-0.1.0", server_today: todayTaipei(), models: { primary: PRIMARY, fallback: FALLBACK }, retention_days: 14,
      max_message_chars: MAX_CHARS, daily_limit_reached: false,
      eval: {
        ran_at: minutesAgo(180), model: PRIMARY, total: 62, passed: 60,
        categories: [
          { key: "intake", total: 14, passed: 13 }, { key: "red_flag", total: 18, passed: 18 }, { key: "refill", total: 14, passed: 14 },
          { key: "out_of_scope", total: 8, passed: 8 }, { key: "boundary", total: 8, passed: 7 },
        ],
      },
    });
  }

  // ---- patient
  if (req.method === "POST" && p === "/visits") {
    const body = await readJson(req);
    if (!body || !["zh-TW", "en"].includes(body.locale)) return fail(res, 422, "invalid_request", "locale", { fields: { locale: "zh-TW or en" } });
    const now = Date.now();
    rate.visitStamps = rate.visitStamps.filter((t) => now - t < 600_000);
    if (rate.visitStamps.length >= 30) return fail(res, 429, "rate_limited", em(req, "太頻繁了，請稍後再試。", "Too many requests. Try again later."), {}, { "retry-after": "60" });
    rate.visitStamps.push(now);
    const v = newVisit(body.locale);
    addMessage(v, "assistant", "opening", tx(body.locale).opening);
    return send(res, 201, { visit: v.visit, messages: v.messages });
  }
  let m;
  if ((m = route("GET", new RegExp(`^/visits/(${UUID})$`))(req, p))) {
    const v = visits.get(m[1]);
    return v ? send(res, 200, detail(v)) : fail(res, 404, "not_found", em(req, "找不到這筆預問診，可能已過保留期限。", "This pre-visit was not found or has expired."));
  }
  if ((m = route("POST", new RegExp(`^/visits/(${UUID})/messages$`))(req, p))) {
    const v = visits.get(m[1]);
    if (!v) return fail(res, 404, "not_found", "not found");
    const body = await readJson(req);
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content || [...content].length > MAX_CHARS) return fail(res, 422, "invalid_request", "content", { fields: { content: `1-${MAX_CHARS}` } });
    if (v.busy) return fail(res, 409, "conflict", em(req, "上一則訊息還在處理中。", "The previous message is still being processed."));
    // A red-flag hit is handled in any state; only other messages on a closed visit are refused.
    const closed = v.visit.status === "submitted" || v.visit.status === "reviewed";
    if (closed && !redFlagCheck(maskPii(content).text, v.visit.locale)) return fail(res, 409, "visit_closed", tx(v.visit.locale).closed);
    if (content === "/mock-429") return fail(res, 429, "rate_limited", em(req, "訊息送得太快，請稍等一下。", "You are sending messages too quickly. Please wait a moment."), {}, { "retry-after": "20" });
    if (content === "/mock-error") return fail(res, 500, "internal", "internal");
    return handleMessage(req, res, v, content);
  }
  if ((m = route("POST", new RegExp(`^/visits/(${UUID})/refill-check$`))(req, p))) {
    const v = visits.get(m[1]);
    if (!v) return fail(res, 404, "not_found", "not found");
    const b = await readJson(req);
    const bad = {};
    if (!b) return fail(res, 400, "invalid_request", "json");
    for (const f of ["prescription_date", "last_fill_date"]) if (!dateOk(b[f])) bad[f] = em(req, "日期格式應為 YYYY-MM-DD", "Use YYYY-MM-DD");
    if (b.today !== undefined && !dateOk(b.today)) bad.today = em(req, "日期格式應為 YYYY-MM-DD", "Use YYYY-MM-DD");
    for (const f of ["total_days", "days_per_fill", "fills_done"]) if (!Number.isInteger(b[f]) || b[f] < 1) bad[f] = em(req, "請輸入正整數", "Enter a positive whole number");
    if (!bad.fills_done && b.fills_done > 3) bad.fills_done = em(req, "已領次數為 1 到 3", "Fills done is 1 to 3");
    if (!["no", "yes", "unsure"].includes(b.controlled)) bad.controlled = "no | yes | unsure";
    if (Object.keys(bad).length) return fail(res, 422, "invalid_request", em(req, "欄位內容不正確。", "Some fields are not valid."), { fields: bad });
    const input = { ...b };
    let ticket = null;
    const t0 = Date.now();
    let result = refillResult(input, v.visit.locale, null);
    if (result.handoff) {
      const reason = input.controlled !== "no" ? "controlled_drug" : input.side_effects ? "side_effects" : input.symptom_changed ? "symptom_change" : "special_status";
      ticket = addTicket(v, reason, "soon", tx(v.visit.locale).ticketRefill, "form");
      result = { ...result, ticket_no: ticket.ticket_no };
    }
    const rec = { id: randomUUID(), input, result, created_at: iso() };
    v.refills.push(rec);
    addToolCall(v, null, 1, "check_chronic_refill", "form", "ok", input, result, Date.now() - t0 + 3);
    if (ticket) addToolCall(v, null, 2, "transfer_to_clinician", "code", "ok", { reason: ticket.reason, urgency: ticket.urgency, summary: ticket.summary }, { ticket_no: ticket.ticket_no, deduped: false }, 4);
    v.visit.updated_at = iso();
    return send(res, 200, { result });
  }
  if ((m = route("POST", new RegExp(`^/visits/(${UUID})/submit$`))(req, p))) {
    const v = visits.get(m[1]);
    if (!v) return fail(res, 404, "not_found", "not found");
    // Already submitted / reviewed: idempotent, returns the stored summary (contract 7.1).
    if (v.visit.status === "submitted" || v.visit.status === "reviewed") return send(res, 200, { visit: detail(v).visit, summary: v.summary });
    if (!v.summary) {
      v.summary = buildSummary(v, "code");
      addToolCall(v, null, 1, "save_previsit_summary", "code", "ok", { source: "submit" }, { saved: true, not_collected: v.summary.not_collected }, 6);
    }
    // active -> submitted; a red_flag visit stays red_flag but still gets submitted_at and a summary.
    if (v.visit.status === "active") v.visit.status = "submitted";
    v.visit.stage = "done"; v.visit.submitted_at = v.visit.submitted_at ?? iso(); v.visit.updated_at = iso();
    return send(res, 200, { visit: detail(v).visit, summary: v.summary });
  }
  if ((m = route("POST", new RegExp(`^/visits/(${UUID})/handoff$`))(req, p))) {
    const v = visits.get(m[1]);
    if (!v) return fail(res, 404, "not_found", "not found");
    const b = (await readJson(req)) ?? {};
    if (b.note && [...String(b.note)].length > 300) return fail(res, 422, "invalid_request", "note", { fields: { note: "max 300" } });
    // The note goes through the PII mask and the red-flag check too (contract 7.1).
    const note = b.note ? maskPii(String(b.note)).text : "";
    const rf = note ? redFlagCheck(note, v.visit.locale) : null;
    if (rf) applyRedFlag(v, rf, v.messages.at(-1)?.id ?? "");
    const t = addTicket(v, rf ? "red_flag" : (b.reason ?? "patient_request"), rf ? "urgent" : "soon", note || tx(v.visit.locale).ticketPatient, "form");
    return send(res, 201, { ticket: { ...t, resolved_by: null, resolution_note: null } });
  }

  // ---- clinician
  if (req.method === "POST" && p === "/auth/login") {
    const b = await readJson(req);
    if (b?.username !== "dr_demo" || !b?.password) {
      rate.loginFails += 1;
      if (rate.loginFails > 8) return fail(res, 429, "rate_limited", em(req, "嘗試次數過多，請稍後再試。", "Too many attempts. Try again later."), {}, { "retry-after": "60" });
      return fail(res, 401, "invalid_credentials", em(req, "帳號或密碼不正確。", "Wrong username or password."));
    }
    const token = randomUUID();
    sessions.add(token);
    return send(res, 200, { user: { username: "dr_demo", display_name: "示範醫師", role: "clinician" } }, { "set-cookie": `pv_session=${token}; HttpOnly; SameSite=Lax; Path=/` });
  }
  if (req.method === "POST" && p === "/auth/logout") {
    sessions.delete(cookie(req, "pv_session"));
    return send(res, 200, { ok: true }, { "set-cookie": "pv_session=; Max-Age=0; Path=/" });
  }
  if (req.method === "GET" && p === "/auth/me") {
    if (!authed(req)) return fail(res, 401, "unauthorized", em(req, "請先登入。", "Please sign in."));
    return send(res, 200, { user: { username: "dr_demo", display_name: "示範醫師", role: "clinician" } });
  }
  if (p.startsWith("/clinician/")) {
    if (!authed(req)) return fail(res, 401, "unauthorized", em(req, "請先登入。", "Please sign in."));
    if (req.method === "GET" && p === "/clinician/visits") {
      // pending (default) = submitted or red_flag; submitted | red_flag | reviewed; all.
      const status = url.searchParams.get("status") || "pending";
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      const wanted = (s) => status === "all" || (status === "pending" ? s === "submitted" || s === "red_flag" : s === status);
      const rank = { urgent: 0, soon: 1, routine: 2 };
      const items = [...visits.values()]
        .filter((v) => v.messages.some((x) => x.role === "patient") || v.visit.status !== "active")
        .map((v) => ({
          visit: v.visit, chief_complaint: v.state.chief_complaint, red_flag: v.redFlag ? { category: v.redFlag.category, label: v.redFlag.label } : null,
          open_tickets: v.tickets.filter((t) => t.status === "open").length, has_summary: !!v.summary, message_count: v.messages.length,
          last_activity_at: v.visit.updated_at,
        }))
        .filter((i) => wanted(i.visit.status) && (!q || (i.chief_complaint ?? "").toLowerCase().includes(q)))
        .sort((a, b) => (a.visit.urgency === "urgent" ? 0 : 1) - (b.visit.urgency === "urgent" ? 0 : 1) || b.last_activity_at.localeCompare(a.last_activity_at) || rank[a.visit.urgency] - rank[b.visit.urgency])
        .slice(0, limit);
      return send(res, 200, { items });
    }
    if ((m = route("GET", new RegExp(`^/clinician/visits/(${UUID})$`))(req, p))) {
      const v = visits.get(m[1]);
      return v ? send(res, 200, detail(v, true)) : fail(res, 404, "not_found", "not found");
    }
    if ((m = route("POST", new RegExp(`^/clinician/visits/(${UUID})/review$`))(req, p))) {
      const v = visits.get(m[1]);
      if (!v) return fail(res, 404, "not_found", "not found");
      if (!["submitted", "red_flag"].includes(v.visit.status)) return fail(res, 409, "invalid_state", em(req, "這筆預問診目前不能標記已審閱。", "This pre-visit cannot be marked reviewed now."));
      const b = (await readJson(req)) ?? {};
      v.visit.status = "reviewed"; v.visit.reviewed_at = iso(); v.visit.reviewed_by = "示範醫師"; v.visit.review_note = b.note || null; v.visit.updated_at = iso();
      return send(res, 200, { visit: v.visit });
    }
    if (req.method === "GET" && p === "/clinician/tickets") {
      const status = url.searchParams.get("status") ?? "open";
      const items = tickets
        .filter((t) => status === "all" || t.status === status)
        .map((t) => ({ ...t, chief_complaint: visits.get(t.visit_id)?.state.chief_complaint ?? null }))
        .sort((a, b) => (a.urgency === "urgent" ? 0 : 1) - (b.urgency === "urgent" ? 0 : 1) || b.created_at.localeCompare(a.created_at));
      return send(res, 200, { items });
    }
    if ((m = route("POST", new RegExp(`^/clinician/tickets/(${UUID})/resolve$`))(req, p))) {
      const t = tickets.find((x) => x.id === m[1]);
      if (!t) return fail(res, 404, "not_found", "not found");
      const b = (await readJson(req)) ?? {};
      t.status = "resolved"; t.resolved_at = iso(); t.resolved_by = "示範醫師"; t.resolution_note = b.note || null;
      const v = visits.get(t.visit_id);
      if (v) recomputeUrgency(v);
      return send(res, 200, { ticket: t });
    }
  }
  return fail(res, 404, "not_found", "not found");
}

seed();

createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("mock error:", e?.message ?? e);
    if (!res.headersSent) fail(res, 500, "internal", "internal");
    else res.end();
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`mock API on http://127.0.0.1:${PORT}/api/v1  (clinician login: dr_demo / any password)`);
});
