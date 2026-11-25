// Fictional accounts, health profiles, prescriptions and readings. All people are invented.

import type { HealthProfile, Measurement, ProfileItem } from "../../api/types.ts";
import { addDays, taipeiInstant } from "../../lib/format.ts";
import { type AccountRec, type CareRec, fid, type PrescriptionRec } from "../db.ts";
import { PHARMACY_SEED } from "../rules.ts";

export interface PersonSeed {
  key: string;
  username: string | null;
  zh: string;
  en: string;
  role: AccountRec["role"];
  title?: [string, string];
}
export const STAFF: readonly PersonSeed[] = [
  { key: "admin", username: "naritaroad", zh: "系統管理員", en: "Administrator", role: "admin", title: ["系統管理", "Administration"] },
  { key: "dr", username: "dr_demo", zh: "陳柏宇", en: "Po-Yu Chen", role: "physician", title: ["醫師", "Physician"] },
  { key: "dr2", username: null, zh: "周怡君", en: "Yi-Chun Chou", role: "physician", title: ["醫師", "Physician"] },
  { key: "rph", username: "rph_demo", zh: "吳思穎", en: "Szu-Ying Wu", role: "pharmacist", title: ["藥師", "Pharmacist"] },
  { key: "cm", username: "cm_demo", zh: "許雅雯", en: "Ya-Wen Hsu", role: "coordinator", title: ["個案管理師", "Care coordinator"] },
];

export interface PatientSeed extends PersonSeed {
  born: number;
  sex: "female" | "male";
  height: number;
  conditions: [name: string, detail: string | null, since: string][];
  allergies: [name: string, detail: string | null][];
  family: [name: string, detail: string | null][];
  lifestyle: [smoking: string, alcohol: string, exercise: string];
  self?: [name: string, detail: string][];
  pharmacy: string;
  tags: string[];
  care: CareRec["care_status"];
  physician: "dr" | "dr2" | null;
  coordinator: "cm" | null;
  contactDaysAgo: number | null;
  flags: string[];
}

const patient = (p: Omit<PatientSeed, "role">): PatientSeed => ({ ...p, role: "patient" });
export const PATIENTS: readonly PatientSeed[] = [
  patient({ key: "lin", username: "patient_demo", zh: "林秀琴", en: "Hsiu-Chin Lin", born: 1964, sex: "female", height: 156, conditions: [["高血壓", "固定吃藥，早上量血壓", "2015"], ["第二型糖尿病", "上次糖化血色素 7.2%", "2018"]], allergies: [["盤尼西林", "打針後全身起疹子"]], family: [["糖尿病", "母親"], ["中風", "父親，68 歲"]], lifestyle: ["不抽菸", "過年過節喝一點", "每天走路 30 分鐘"], self: [["葉黃素", "早餐後一顆"]], pharmacy: "ph-anhe", tags: ["三高", "慢箋"], care: "active", physician: "dr", coordinator: "cm", contactDaysAgo: 6, flags: [] }),
  patient({ key: "chang", username: null, zh: "張志明", en: "Chih-Ming Chang", born: 1981, sex: "male", height: 174, conditions: [["氣喘", "換季容易發作", "2009"], ["過敏性鼻炎", null, "2005"]], allergies: [["塵蟎", "打噴嚏、流鼻水"]], family: [["氣喘", "姊姊"]], lifestyle: ["三年前戒菸", "不喝酒", "每週打一次羽球"], pharmacy: "ph-minsheng", tags: ["氣喘"], care: "active", physician: "dr", coordinator: "cm", contactDaysAgo: 2, flags: [] }),
  patient({ key: "wu", username: null, zh: "吳金水", en: "Chin-Shui Wu", born: 1955, sex: "male", height: 165, conditions: [["高血壓", null, "2008"], ["高血脂", null, "2012"], ["攝護腺肥大", "夜尿兩三次", "2017"], ["失眠", "睡前吃安眠藥", "2021"]], allergies: [], family: [["高血壓", "父母"]], lifestyle: ["每天半包菸", "晚餐配一瓶啤酒", "早上公園散步"], pharmacy: "ph-anhe", tags: ["三高", "獨居"], care: "watch", physician: "dr", coordinator: "cm", contactDaysAgo: 14, flags: ["跌倒風險"] }),
  patient({ key: "huang", username: null, zh: "黃美玲", en: "Mei-Ling Huang", born: 1988, sex: "female", height: 162, conditions: [["甲狀腺機能低下", "產後發現", "2020"]], allergies: [["海鮮", "嘴唇癢"]], family: [["甲狀腺疾病", "母親"]], lifestyle: ["不抽菸", "不喝酒", "每週兩次瑜伽"], pharmacy: "ph-heping", tags: ["甲狀腺"], care: "active", physician: "dr2", coordinator: "cm", contactDaysAgo: 0, flags: [] }),
  patient({ key: "li", username: null, zh: "李國華", en: "Kuo-Hua Li", born: 1970, sex: "male", height: 170, conditions: [["痛風", "今年發作兩次", "2016"], ["高血壓", null, "2019"]], allergies: [], family: [["痛風", "哥哥"]], lifestyle: ["不抽菸", "應酬時喝", "很少運動"], pharmacy: "ph-minsheng", tags: ["痛風", "慢箋"], care: "active", physician: "dr", coordinator: null, contactDaysAgo: 21, flags: [] }),
  patient({ key: "wang", username: null, zh: "王淑芬", en: "Shu-Fen Wang", born: 1959, sex: "female", height: 158, conditions: [["心房顫動", "吃抗凝血藥", "2022"], ["高血壓", null, "2013"]], allergies: [["阿斯匹靈", "胃痛"]], family: [["心臟病", "父親"]], lifestyle: ["不抽菸", "不喝酒", "每天做體操"], pharmacy: "ph-anhe", tags: ["心臟", "抗凝血"], care: "watch", physician: "dr", coordinator: "cm", contactDaysAgo: 0, flags: ["使用抗凝血藥"] }),
  patient({ key: "tsai", username: null, zh: "蔡宗翰", en: "Tsung-Han Tsai", born: 1997, sex: "male", height: 178, conditions: [["胃食道逆流", "宵夜後比較明顯", "2023"]], allergies: [], family: [], lifestyle: ["偶爾抽", "週末喝啤酒", "每週健身三次"], pharmacy: "ph-heping", tags: [], care: "new", physician: "dr2", coordinator: null, contactDaysAgo: null, flags: [] }),
  patient({ key: "cheng", username: null, zh: "鄭玉珠", en: "Yu-Chu Cheng", born: 1948, sex: "female", height: 151, conditions: [["第二型糖尿病", null, "2003"], ["慢性腎臟病第三期", "三個月抽一次血", "2019"], ["高血壓", null, "2001"]], allergies: [["顯影劑", "起疹子"]], family: [["腎臟病", "妹妹"]], lifestyle: ["不抽菸", "不喝酒", "女兒陪著走路"], self: [["鈣片", "晚餐後一顆"]], pharmacy: "ph-anhe", tags: ["三高", "腎臟", "女兒協助"], care: "watch", physician: "dr", coordinator: "cm", contactDaysAgo: 1, flags: ["腎功能追蹤"] }),
  patient({ key: "liu", username: null, zh: "劉家豪", en: "Chia-Hao Liu", born: 1975, sex: "male", height: 172, conditions: [["第二型糖尿病", null, "2021"], ["高血脂", null, "2018"]], allergies: [], family: [["糖尿病", "父母"]], lifestyle: ["每天一包菸", "每天喝", "沒有運動"], pharmacy: "ph-minsheng", tags: ["三高", "戒菸門診"], care: "active", physician: "dr", coordinator: "cm", contactDaysAgo: 9, flags: ["未完成抽血"] }),
  patient({ key: "kuo", username: null, zh: "郭怡婷", en: "Yi-Ting Kuo", born: 1992, sex: "female", height: 160, conditions: [["過敏性鼻炎", null, "2010"], ["偏頭痛", "每個月兩三次", "2016"]], allergies: [["花粉", "眼睛癢"]], family: [["偏頭痛", "母親"]], lifestyle: ["不抽菸", "偶爾喝紅酒", "每週跑步兩次"], pharmacy: "ph-heping", tags: ["過敏"], care: "active", physician: "dr2", coordinator: null, contactDaysAgo: 30, flags: [] }),
  patient({ key: "hsieh", username: null, zh: "謝文雄", en: "Wen-Hsiung Hsieh", born: 1962, sex: "male", height: 168, conditions: [["冠狀動脈疾病", "放過一支支架", "2024"], ["高血脂", null, "2015"]], allergies: [], family: [["心肌梗塞", "哥哥"]], lifestyle: ["裝支架後戒菸", "不喝酒", "心臟復健運動"], pharmacy: "ph-anhe", tags: ["心臟", "三高"], care: "watch", physician: "dr", coordinator: "cm", contactDaysAgo: 4, flags: ["支架後抗血小板"] }),
];

export function profileOf(p: PatientSeed, updatedAt: string): HealthProfile {
  const item = (kind: string, i: number, name: string, detail: string | null, since: string | null, source: ProfileItem["source"]): ProfileItem => ({
    id: fid(`${p.key}:${kind}:${i}`),
    name,
    detail,
    since,
    source,
    status: "active",
  });
  return {
    revision: 3,
    display_name: p.zh,
    birth_year: p.born,
    sex: p.sex,
    height_cm: p.height,
    conditions: p.conditions.map(([n, d, s], i) => item("condition", i, n, d, s, "clinic")),
    medications: (p.self ?? []).map(([n, d], i) => item("medication", i, n, d, null, "patient")),
    allergies: p.allergies.map(([n, d], i) => item("allergy", i, n, d, null, i === 0 ? "clinic" : "patient")),
    family_history: p.family.map(([n, d], i) => item("family", i, n, d, null, "patient")),
    lifestyle: { smoking: p.lifestyle[0], alcohol: p.lifestyle[1], exercise: p.lifestyle[2] },
    preferred_pharmacy_id: p.pharmacy,
    contact_preference: "in_app",
    updated_at: updatedAt,
  };
}

/** key, patient, drug, dose as the prescription record shows it, issued N days ago, fills at N days ago */
type RxSeed = [key: string, patient: string, drug: string, zh: string, en: string, issued: number, fills: number[]];
const PRESCRIPTIONS: readonly RxSeed[] = [
  ["lin-amlodipine", "lin", "amlodipine", "5 mg，每天一次，每次一顆，早餐後", "5 mg, one tablet once a day after breakfast", 52, [52, 23]],
  ["lin-losartan", "lin", "losartan", "50 mg，每天一次，每次一顆，早餐後", "50 mg, one tablet once a day after breakfast", 89, [89, 60, 29]],
  ["lin-metformin", "lin", "metformin", "500 mg，每天兩次，每次一顆，早晚餐後", "500 mg, one tablet twice a day after breakfast and dinner", 40, [40, 12]],
  ["lin-sitagliptin", "lin", "sitagliptin", "100 mg，每天一次，每次一顆，早餐後", "100 mg, one tablet once a day after breakfast", 88, [88, 59, 31]],
  ["lin-atorvastatin", "lin", "atorvastatin", "20 mg，每天一次，每次一顆，睡前", "20 mg, one tablet once a day at bedtime", 10, [10]],
  ["chang-bud", "chang", "budesonide_formoterol", "160/4.5 mcg，每天兩次，每次吸一口", "160/4.5 mcg, one inhalation twice a day", 86, [86, 57, 28]],
  ["chang-cetirizine", "chang", "cetirizine", "10 mg，每天一次，每次一顆，睡前", "10 mg, one tablet once a day at bedtime", 33, [33, 4]],
  ["wu-amlodipine", "wu", "amlodipine", "5 mg，每天一次，每次一顆，早餐後", "5 mg, one tablet once a day after breakfast", 95, [95, 66, 36]],
  ["wu-rosuvastatin", "wu", "rosuvastatin", "10 mg，每天一次，每次一顆，晚餐後", "10 mg, one tablet once a day after dinner", 95, [95, 66, 36]],
  ["wu-tamsulosin", "wu", "tamsulosin", "0.4 mg，每天一次，每次一顆，晚餐後", "0.4 mg, one capsule once a day after dinner", 60, [60, 31]],
  ["wu-zolpidem", "wu", "zolpidem", "睡前使用，依處方", "At bedtime, as prescribed", 20, [20]],
  ["huang-levo", "huang", "levothyroxine", "50 mcg，每天一次，每次一顆，早餐前空腹", "50 mcg, one tablet once a day before breakfast", 88, [88, 59, 30]],
  ["li-allopurinol", "li", "allopurinol", "100 mg，每天一次，每次一顆，飯後", "100 mg, one tablet once a day after a meal", 91, [91, 61, 31]],
  ["li-valsartan", "li", "valsartan", "80 mg，每天一次，每次一顆，早餐後", "80 mg, one tablet once a day after breakfast", 61, [61, 30, 1]],
  ["wang-apixaban", "wang", "apixaban", "5 mg，每天兩次，每次一顆", "5 mg, one tablet twice a day", 50, [50, 22]],
  ["wang-bisoprolol", "wang", "bisoprolol", "2.5 mg，每天一次，每次一顆，早餐後", "2.5 mg, one tablet once a day after breakfast", 54, [54, 24]],
  ["tsai-omeprazole", "tsai", "omeprazole", "20 mg，每天一次，每次一顆，早餐前", "20 mg, one capsule once a day before breakfast", 92, [92, 62, 33]],
  ["cheng-sitagliptin", "cheng", "sitagliptin", "50 mg，每天一次，每次一顆，早餐後", "50 mg, one tablet once a day after breakfast", 87, [87, 58, 29]],
  ["cheng-telmisartan", "cheng", "telmisartan", "40 mg，每天一次，每次一顆，早餐後", "40 mg, one tablet once a day after breakfast", 87, [87, 58, 29]],
  ["liu-metformin", "liu", "metformin", "850 mg，每天兩次，每次一顆，早晚餐後", "850 mg, one tablet twice a day after breakfast and dinner", 94, [94, 64, 34]],
  ["liu-rosuvastatin", "liu", "rosuvastatin", "10 mg，每天一次，每次一顆，晚餐後", "10 mg, one tablet once a day after dinner", 94, [94, 64, 34]],
  ["kuo-fexofenadine", "kuo", "fexofenadine", "180 mg，每天一次，每次一顆", "180 mg, one tablet once a day", 25, [25]],
  ["hsieh-clopidogrel", "hsieh", "clopidogrel", "75 mg，每天一次，每次一顆，早餐後", "75 mg, one tablet once a day after breakfast", 90, [90, 60, 30]],
  ["hsieh-atorvastatin", "hsieh", "atorvastatin", "40 mg，每天一次，每次一顆，睡前", "40 mg, one tablet once a day at bedtime", 90, [90, 60, 30]],
];

const pharmacyName = (patientKey: string): string => {
  const id = PATIENTS.find((p) => p.key === patientKey)?.pharmacy;
  return PHARMACY_SEED.find((p) => p.id === id)?.zh.name ?? "安和示範藥局";
};

export function prescriptions(today: string): PrescriptionRec[] {
  return PRESCRIPTIONS.map(([key, owner, drug, zh, en, issued, fills]) => ({
    id: fid(`prescription:${key}`),
    patient_id: fid(`account:${owner}`),
    drug_id: drug,
    name: "",
    dose_zh: zh,
    dose_en: en,
    source: "clinic" as const,
    issued_on: addDays(today, -issued),
    total_days: 90,
    days_per_fill: 30,
    fills_allowed: 3,
    fills: fills.map((d, i) => ({ n: i + 1, filled_on: addDays(today, -d), pharmacy_name: pharmacyName(owner) })),
  }));
}

/** Blood pressure, glucose, weight and lab results: enough points for a trend, with ordinary day-to-day variation. */
export function measurements(today: string): (Measurement & { patient_id: string })[] {
  const out: (Measurement & { patient_id: string })[] = [];
  let n = 0;
  const add = (owner: string, kind: Measurement["kind"], daysAgo: number, time: string, values: Measurement["values"], source: Measurement["source"] = "patient") => {
    n += 1;
    out.push({ id: fid(`measurement:${n}`), patient_id: fid(`account:${owner}`), kind, values, taken_at: taipeiInstant(addDays(today, -daysAgo), time), source });
  };
  const wave = (i: number, size: number) => Math.round(Math.sin(i * 1.7) * size + Math.cos(i * 0.6) * size * 0.6);
  for (let d = 0; d < 28; d++) {
    if (d % 6 !== 5) add("lin", "bp", d, "07:20", { systolic: 132 + wave(d, 6), diastolic: 80 + wave(d + 3, 4) });
    if (d % 7 === 0) add("lin", "weight", d, "07:10", { value: 63.4 - wave(d, 2) / 10, unit: "kg" });
    if (d % 3 === 0) add("lin", "glucose", d, "06:50", { value: 128 + wave(d + 1, 12), unit: "mg/dL" });
    if (d % 2 === 0) add("cheng", "bp", d, "08:00", { systolic: 141 + wave(d, 7), diastolic: 78 + wave(d, 4) });
    if (d % 4 === 0) add("wang", "pulse", d, "09:00", { value: 78 + wave(d, 8), unit: "bpm" });
    if (d % 5 === 0) add("li", "bp", d, "21:30", { systolic: 136 + wave(d, 5), diastolic: 86 + wave(d, 3) });
  }
  add("lin", "lab", 75, "09:30", { name: "HbA1c", value: 7.2, unit: "%" }, "clinic");
  add("lin", "lab", 258, "09:30", { name: "HbA1c", value: 7.6, unit: "%" }, "clinic");
  add("lin", "lab", 75, "09:30", { name: "eGFR", value: 82, unit: "mL/min/1.73 m²" }, "clinic");
  add("lin", "lab", 75, "09:30", { name: "LDL-C", value: 96, unit: "mg/dL" }, "clinic");
  add("cheng", "lab", 30, "10:00", { name: "eGFR", value: 44, unit: "mL/min/1.73 m²" }, "clinic");
  add("cheng", "lab", 30, "10:00", { name: "HbA1c", value: 7.1, unit: "%" }, "clinic");
  add("li", "lab", 44, "08:40", { name: "Uric acid", value: 6.8, unit: "mg/dL" }, "clinic");
  add("liu", "lab", 400, "08:40", { name: "HbA1c", value: 8.1, unit: "%" }, "clinic");
  add("huang", "lab", 210, "09:10", { name: "TSH", value: 2.4, unit: "mIU/L" }, "clinic");
  return out;
}
