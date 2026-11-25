// Fictional previsit conversations in every state, written as short scripts. The builder turns a script into
// messages, runs, tool calls, intake, evidence and a summary with consistent ids and times.

import { INTAKE_FIELDS, type ClinicalNoteSections, type IntakeState, type MessageKind, type PrevisitSummary, type TicketReason, type ToolName, type Urgency, type VisitStatus } from "../../api/types.ts";
import { EMPTY_INTAKE, isCoreField } from "../../lib/intake.ts";
import { type AppointmentRec, fid, type MessageRec, type NoteRec, type TicketRec, type VisitRec } from "../db.ts";

export const OPENING_ZH =
  "您好，我是 AI 預問診助理，不是醫師，不做診斷，也不開藥。我會問您幾個問題，整理成摘要交給醫師。請不要輸入真實姓名、身分證字號或病歷。如果現在有胸痛、呼吸困難這類緊急狀況，請直接撥打 119。先請問，今天哪裡不舒服？";
export const OPENING_EN =
  "Hello. I'm an AI previsit assistant, not a doctor. I don't diagnose or prescribe. I'll ask a few questions and prepare a summary for your doctor. Please don't enter real names, ID numbers or records. If you have chest pain, trouble breathing or another emergency, call 119 now. What brings you in today?";
export const RED_FLAG_ZH = "您描述的症狀可能很危急。請馬上撥打 119，或請身邊的人陪您到最近的急診。不要自己開車。這次預問診先暫停，已通知醫療團隊。";
export const RED_FLAG_EN = "What you describe may be serious. Call 119 now, or have someone take you to the nearest emergency department. Don't drive yourself. This previsit is paused and the clinic has been notified.";
export const REFUSAL_ZH = "這個我不能做。我不能開藥，也不能說明用藥劑量。我已經記下您的需求，看診時醫師會跟您討論。我們先把剛才的問題答完好嗎？";
export const REFUSAL_EN = "I can't do that. I can't prescribe or explain doses. I've noted your request and the doctor will discuss it with you. Shall we finish the questions first?";
export const DISCLAIMER_ZH = "由 AI 預問診整理，未經醫師確認，不是診斷。";
export const DISCLAIMER_EN = "Prepared by the AI previsit assistant. Not confirmed by a doctor and not a diagnosis.";

type Fields = Partial<Record<string, string | number | string[]>>;
/** p patient, a assistant, s staff, rf red flag text, ref refusal, n notice */
type Turn = [who: "p" | "a" | "s" | "rf" | "ref" | "n", text: string, fields?: Fields];

export interface VisitScript {
  key: string;
  patient: string;
  title: string;
  /** Minutes ago the conversation started, and minutes between messages. */
  ago: number;
  pace?: number;
  status: VisitStatus;
  urgency?: Urgency;
  mode?: "human";
  pinned?: boolean;
  archived?: boolean;
  appointment?: string;
  assigned?: "dr" | "dr2" | "cm";
  turns: Turn[];
  questions?: string[];
  followUp?: string[];
  narrative?: string;
  redFlag?: { category: VisitRec["red_flag"] extends infer R ? (R extends { category: infer C } ? C : never) : never; label: string };
  ticket?: { reason: TicketReason; urgency: Urgency; summary: string; resolved?: string };
  lastRun?: "interrupted" | "failed";
  note?: { status: "draft" | "signed"; by: "dr" | "dr2"; sections: Partial<ClinicalNoteSections>; addendum?: string };
  /** Minutes ago it was sent / reviewed. */
  submittedAgo?: number;
  reviewedAgo?: number;
}

export const SCRIPTS: readonly VisitScript[] = [
  {
    key: "lin-glucose",
    patient: "lin",
    title: "早上血糖偏高",
    ago: 95,
    pace: 2,
    status: "active",
    pinned: true,
    appointment: "lin-next",
    turns: [
      ["p", "這禮拜早上量血糖都比較高，想問醫師", { chief_complaint: "這週清晨血糖偏高" }],
      ["a", "好，我先記下來。大概是從哪一天開始變高的？"],
      ["p", "禮拜日開始，之前大概一百二，現在一百四五", { "hpi.onset": "上週日開始，原本約 120，現在 140 到 150", "hpi.course": "這幾天維持偏高" }],
      ["a", "這幾天吃的東西或作息有不一樣嗎？例如吃得比較晚。"],
      ["p", "有，孫子來住，晚上會一起吃水果和點心", { "hpi.modifiers": "晚上多吃水果和點心" }],
      ["a", "了解。有沒有覺得特別口渴、常跑廁所，或其他不舒服？"],
      ["p", "有比較渴，其他還好", { "hpi.associated": "口渴，沒有其他不舒服", "hpi.severity": "n/a" }],
      ["a", "健康檔案裡有高血壓和第二型糖尿病，對盤尼西林過敏。這些都還對嗎？"],
      ["p", "對，沒錯", { past_history: ["高血壓", "第二型糖尿病"], allergies: ["盤尼西林"] }],
      ["a", "目前紀錄上的藥有 amlodipine、losartan、metformin 和 atorvastatin，另外自己吃葉黃素。有增減嗎？"],
    ],
    questions: ["晚上可以吃水果嗎"],
  },
  {
    key: "lin-dizzy",
    patient: "lin",
    title: "起身時頭暈",
    ago: 1500,
    status: "submitted",
    appointment: "lin-today",
    assigned: "dr",
    submittedAgo: 1440,
    turns: [
      ["p", "最近站起來會暈一下", { chief_complaint: "起身時頭暈" }],
      ["a", "這樣的情形多久了？"],
      ["p", "差不多兩個禮拜", { "hpi.onset": "約兩週前" }],
      ["a", "每次大概持續多久？有越來越頻繁嗎？"],
      ["p", "幾秒鐘就好了，一天大概兩三次，沒有變多", { "hpi.course": "每次數秒，一天兩三次，沒有增加" }],
      ["a", "0 到 10 分，影響您生活的程度大概幾分？"],
      ["p", "三分吧", { "hpi.severity": 3 }],
      ["a", "頭暈的時候，有心悸、視線模糊、耳鳴，或差點跌倒嗎？"],
      ["p", "眼前會黑一下，沒有跌倒", { "hpi.associated": "短暫眼前發黑，沒有跌倒、心悸或耳鳴", "hpi.character": "站起來的瞬間輕飄飄的" }],
      ["a", "過去病史一樣是高血壓和糖尿病，對嗎？最近藥有換過嗎？"],
      ["p", "對，上個月血壓藥有多一顆", { past_history: ["高血壓", "第二型糖尿病"], medications: ["amlodipine", "losartan（上個月新增）", "metformin", "atorvastatin"], allergies: ["盤尼西林"] }],
      ["a", "我整理了一下：兩週來起身時頭暈數秒，會眼前發黑，沒有跌倒；上個月血壓藥新增一種。這樣對嗎？"],
      ["p", "對"],
      ["a", "已經整理好，按「結束並送出」就會交給醫師。"],
    ],
    questions: ["血壓藥要不要減", "需不需要抽血"],
    followUp: ["新增的血壓藥從哪一天開始吃", "在家量的站姿血壓", "有沒有脫水或腹瀉"],
    narrative: "62 歲女性，高血壓與第二型糖尿病。約兩週前開始在起身時頭暈數秒，伴短暫眼前發黑，一天兩三次，沒有跌倒、心悸或耳鳴。自述上個月血壓藥增加一種。",
  },
  {
    key: "lin-cough",
    patient: "lin",
    title: "咳嗽兩週",
    ago: 84_000,
    status: "reviewed",
    assigned: "dr",
    submittedAgo: 83_900,
    reviewedAgo: 82_700,
    turns: [
      ["p", "咳嗽咳了兩個禮拜", { chief_complaint: "咳嗽兩週" }],
      ["a", "咳嗽有痰嗎？什麼時候比較明顯？"],
      ["p", "乾咳，晚上躺下來比較咳", { "hpi.onset": "兩週前", "hpi.character": "乾咳", "hpi.modifiers": "晚上躺下比較明顯" }],
      ["a", "有發燒、喘或胸口不舒服嗎？"],
      ["p", "都沒有", { "hpi.associated": "沒有發燒、喘或胸口不適", "hpi.course": "差不多，沒有變嚴重", "hpi.severity": 4 }],
      ["a", "病史和用藥跟上次一樣嗎？"],
      ["p", "一樣", { past_history: ["高血壓", "第二型糖尿病"], medications: ["amlodipine", "losartan", "metformin"], allergies: ["盤尼西林"] }],
      ["a", "好，已整理完成。"],
    ],
    narrative: "62 歲女性，乾咳兩週，夜間平躺較明顯，沒有發燒、喘或胸口不適。",
    followUp: ["是否使用 ACEI 類藥物", "胃食道逆流症狀"],
    note: {
      status: "signed",
      by: "dr",
      sections: {
        subjective: "乾咳兩週，夜間平躺較明顯。無發燒、喘、胸口不適。",
        objective: "病人自述居家血壓 130/80 上下。",
        assessment: "考慮上呼吸道感染後咳嗽，另需排除胃食道逆流。",
        plan: "胸部 X 光；兩週後追蹤；症狀加重提前回診。",
        patient_message: "這次的咳嗽多半是感冒之後留下來的，先觀察兩週。晚餐不要太晚吃，睡覺時枕頭墊高一點。如果發燒、咳血或會喘，請提早回來。",
      },
      addendum: "胸部 X 光已完成，結果正常，已通知病人。",
    },
  },
  {
    key: "lin-knee",
    patient: "lin",
    title: "膝蓋痠痛",
    ago: 210_000,
    status: "reviewed",
    archived: true,
    submittedAgo: 209_900,
    reviewedAgo: 208_000,
    turns: [
      ["p", "爬樓梯右膝會痠", { chief_complaint: "爬樓梯時右膝痠痛" }],
      ["a", "多久了？有沒有受傷過？"],
      ["p", "半年了，沒受傷", { "hpi.onset": "半年", "hpi.location": "右膝", "hpi.course": "慢慢加重", "hpi.severity": 4, "hpi.associated": "沒有腫" }],
    ],
    narrative: "62 歲女性，右膝爬樓梯時痠痛半年，沒有外傷或腫脹。",
  },
  {
    key: "wang-chest",
    patient: "wang",
    title: "胸口悶",
    ago: 22,
    pace: 1,
    status: "red_flag",
    urgency: "urgent",
    turns: [
      ["p", "早上起來就覺得累", { chief_complaint: "早上起來很累" }],
      ["a", "是今天才這樣，還是這幾天都這樣？"],
      ["p", "今天，而且胸口很悶，左手有點麻", { "hpi.onset": "今天早上" }],
      ["rf", RED_FLAG_ZH],
      ["p", "我兒子要載我去醫院了"],
      ["n", "這次預問診已經暫停。請先撥打 119，或到最近的急診。之後要重新開始，請按「開始新的預問診」。"],
    ],
    redFlag: { category: "chest_pain", label: "胸痛或胸悶" },
    ticket: { reason: "red_flag", urgency: "urgent", summary: "紅旗：胸痛或胸悶。病人自述今天胸口悶、左手麻，正前往醫院。" },
  },
  {
    key: "chang-night",
    patient: "chang",
    title: "夜咳、喘鳴",
    ago: 190,
    pace: 2,
    status: "submitted",
    appointment: "chang-today",
    assigned: "dr",
    submittedAgo: 160,
    turns: [
      ["p", "天氣變冷之後晚上一直咳，睡不好", { chief_complaint: "天冷後夜間咳嗽，睡不好" }],
      ["a", "從哪一天開始？"],
      ["p", "大概上禮拜三", { "hpi.onset": "上週三" }],
      ["a", "咳的時候有沒有咻咻的聲音，或半夜被咳醒？"],
      ["p", "有咻咻聲，這禮拜半夜醒來兩次", { "hpi.character": "有喘鳴聲", "hpi.course": "這週半夜咳醒兩次，比上週明顯", "hpi.modifiers": "天冷、躺下時明顯" }],
      ["a", "這一週用急救型的吸入劑用了幾次？"],
      ["p", "四次，用完會好一點", { "hpi.associated": "急救型吸入劑一週四次，使用後改善；沒有發燒" }],
      ["a", "0 到 10 分，大概幾分？"],
      ["p", "晚上六分，白天兩分", { "hpi.severity": 6 }],
      ["a", "病史有氣喘和過敏性鼻炎，對塵蟎過敏。控制型吸入劑每天都有用嗎？"],
      ["p", "有，不過最近有兩天忘記", { past_history: ["氣喘", "過敏性鼻炎"], medications: ["budesonide／formoterol 吸入劑（最近忘記兩天）", "cetirizine"], allergies: ["塵蟎"] }],
      ["a", "好，已整理完成，請您確認後送出。"],
    ],
    questions: ["吸入劑要不要換"],
    followUp: ["吸入技巧", "過去一年是否使用過口服類固醇或掛急診"],
    narrative: "45 歲男性，氣喘。上週三起夜間咳嗽並有喘鳴，這週夜咳醒兩次，急救型吸入劑用了四次、使用後改善。控制型吸入劑有兩天忘記使用。沒有發燒。",
  },
  {
    key: "li-toe",
    patient: "li",
    title: "腳趾紅腫痛",
    ago: 310,
    status: "submitted",
    urgency: "soon",
    submittedAgo: 280,
    turns: [
      ["p", "右腳大拇趾又腫起來了，很痛", { chief_complaint: "右腳大拇趾腫痛", "hpi.location": "右腳大拇趾" }],
      ["a", "什麼時候開始的？"],
      ["p", "昨天半夜痛醒", { "hpi.onset": "昨天半夜" }],
      ["a", "現在走路可以嗎？0 到 10 分大概幾分？"],
      ["p", "要跛著走，八分", { "hpi.severity": 8, "hpi.course": "到今天早上更腫" }],
      ["a", "有發燒、傷口，或其他關節也痛嗎？"],
      ["p", "沒有發燒，只有那一個地方", { "hpi.associated": "沒有發燒，其他關節不痛", "hpi.character": "紅、熱、抽痛" }],
      ["a", "最近飲食或喝酒有不一樣嗎？"],
      ["p", "前天聚餐有喝啤酒吃海鮮", { "hpi.modifiers": "發作前一天喝啤酒、吃海鮮", past_history: ["痛風", "高血壓"], medications: ["allopurinol", "valsartan"], allergies: [] }],
      ["a", "了解，我整理好了。如果開始發燒或整隻腳腫起來，請不要等，直接就醫。"],
    ],
    followUp: ["發作期間 allopurinol 有沒有自行停用", "腎功能"],
    narrative: "56 歲男性，痛風與高血壓。昨天半夜右腳大拇趾紅腫抽痛痛醒，8 分，需跛行，沒有發燒。發作前一天聚餐喝啤酒、吃海鮮。",
    ticket: { reason: "patient_request", urgency: "soon", summary: "病人希望今天能加掛，右腳大拇趾腫痛 8 分。" },
  },
  {
    key: "huang-tsh",
    patient: "huang",
    title: "甲狀腺抽血時間",
    ago: 130,
    pace: 4,
    status: "active",
    mode: "human",
    assigned: "cm",
    turns: [
      ["p", "我想問什麼時候要抽甲狀腺的血", { chief_complaint: "詢問甲狀腺抽血時間" }],
      ["a", "這個要看醫師的安排，我先記下來。最近有沒有不舒服？"],
      ["p", "比較怕冷、容易累。可以請人直接回我嗎", { "hpi.associated": "怕冷、容易累" }],
      ["n", "已請醫療團隊接手，AI 先暫停回覆。"],
      ["s", "黃小姐您好，我是個案管理師許雅雯。您上次抽血是四月，醫師安排這個月再抽一次，抽血前一天晚上照常吃飯就好，不用空腹。"],
      ["p", "好，那禮拜五早上可以嗎"],
      ["s", "可以，週五上午八點半到十一點都能抽。怕冷和容易累的情形我先記在這裡，醫師看診前會先看到。"],
    ],
    ticket: { reason: "patient_request", urgency: "routine", summary: "病人希望由人員回覆抽血時間。" },
  },
  {
    key: "cheng-followup",
    patient: "cheng",
    title: "腎功能追蹤",
    ago: 1700,
    status: "reviewed",
    appointment: "cheng-done",
    assigned: "dr",
    submittedAgo: 1650,
    reviewedAgo: 240,
    turns: [
      ["p", "我女兒幫我打字。媽媽來看抽血報告", { chief_complaint: "回診看抽血報告" }],
      ["a", "好的。最近媽媽有沒有新的不舒服，例如腳腫、喘、吃不下？"],
      ["p", "腳踝傍晚會腫一點，早上就消了", { "hpi.associated": "傍晚腳踝輕微水腫，早上消退", "hpi.onset": "約一個月", "hpi.course": "差不多", "hpi.severity": 2 }],
      ["a", "血糖和血壓在家量得如何？"],
      ["p", "血壓一百四上下，血糖早上一百三", { past_history: ["第二型糖尿病", "慢性腎臟病第三期", "高血壓"], medications: ["sitagliptin", "telmisartan", "鈣片"], allergies: ["顯影劑"] }],
      ["a", "好，已整理完成。"],
    ],
    narrative: "78 歲女性，由女兒協助填寫。回診看報告；傍晚腳踝輕微水腫約一個月，早上消退。居家血壓約 140，清晨血糖約 130。",
    followUp: ["水腫是否合併體重增加", "鈣片劑量"],
    note: {
      status: "signed",
      by: "dr",
      sections: {
        subjective: "女兒代填。傍晚腳踝輕微水腫約一個月，早上消退。",
        objective: "自述居家血壓 140 上下、清晨血糖 130。eGFR 44（30 天前）。",
        assessment: "慢性腎臟病第三期，腎功能與上次相近；輕度下肢水腫。",
        plan: "維持目前用藥，三個月後抽血；記錄體重；水腫加重提前回診。",
        patient_message: "這次腎功能和上次差不多。請每天早上量體重，三天內多兩公斤或會喘就提早回來。鹽吃淡一點，止痛藥先問過我們再吃。",
      },
    },
  },
  {
    key: "liu-stopped",
    patient: "liu",
    title: "想了解抽血前準備",
    ago: 48,
    status: "active",
    lastRun: "interrupted",
    turns: [
      ["p", "下禮拜要抽血，不知道要不要空腹", { chief_complaint: "詢問抽血前準備" }],
      ["a", "抽血單上有寫飯前血糖或血脂的話，通常要空腹八小時。您的單子上有寫哪些項目？"],
      ["p", "有血糖、血脂、糖化血色素"],
    ],
  },
  {
    key: "kuo-migraine",
    patient: "kuo",
    title: "頭痛變頻繁",
    ago: 620,
    status: "submitted",
    assigned: "dr",
    submittedAgo: 560,
    turns: [
      ["p", "頭痛這個月變多，已經第五次了", { chief_complaint: "頭痛頻率增加" }],
      ["a", "以前大概一個月幾次？這次的痛法跟以前一樣嗎？"],
      ["p", "以前兩三次。痛法一樣，右邊一跳一跳的", { "hpi.onset": "這個月", "hpi.character": "右側搏動性疼痛，與過去相同", "hpi.location": "右側太陽穴", "hpi.course": "由每月兩三次增為五次" }],
      ["a", "每次持續多久？最痛大概幾分？"],
      ["p", "半天，七分", { "hpi.severity": 7 }],
      ["a", "有怕光、想吐，或手腳麻、看東西不清楚嗎？"],
      ["p", "會怕光想吐，其他沒有", { "hpi.associated": "畏光、噁心；沒有肢體麻木或視力變化", "hpi.modifiers": "熬夜、月經前比較容易發作" }],
      ["a", "目前固定吃的藥和過敏有變動嗎？"],
      ["p", "只有過敏藥，對花粉過敏", { past_history: ["過敏性鼻炎", "偏頭痛"], medications: ["fexofenadine"], allergies: ["花粉"] }],
      ["a", "好，我整理好了，請確認。"],
    ],
    questions: ["是不是要吃預防的藥"],
    followUp: ["一個月使用止痛藥的天數", "避孕方式"],
    narrative: "34 歲女性，偏頭痛。本月頭痛由每月兩三次增為五次，型態與過去相同（右側搏動、畏光、噁心），每次約半天，7 分。熬夜與月經前較易發作。",
    note: {
      status: "draft",
      by: "dr",
      sections: {
        subjective: "本月頭痛五次，型態同過去：右側搏動、畏光、噁心，約半天，7 分。熬夜與月經前較易發作。",
        objective: "無自述量測。",
        assessment: "偏頭痛，頻率增加。需確認止痛藥使用天數。",
        plan: "",
        patient_message: "",
      },
    },
  },
  {
    key: "hsieh-new",
    patient: "hsieh",
    title: "新的預問診",
    ago: 6,
    status: "active",
    appointment: "hsieh-next",
    turns: [],
  },
  {
    key: "wu-sleep",
    patient: "wu",
    title: "睡不好",
    ago: 2900,
    status: "submitted",
    submittedAgo: 2860,
    turns: [
      ["p", "最近都睡不好", { chief_complaint: "睡不好" }],
      ["a", "是不容易睡著，還是半夜會醒？"],
      ["p", "半夜起來上廁所就睡不著了", { "hpi.character": "夜尿後無法再入睡", "hpi.onset": "約一個月" }],
      ["a", "一個晚上大概起來幾次？"],
      ["p", "三次。安眠藥可不可以多開一點給我", { "hpi.course": "每晚夜尿約三次" }],
      ["ref", REFUSAL_ZH],
      ["p", "好啦", { "hpi.severity": 5, "hpi.associated": "白天沒精神", past_history: ["高血壓", "高血脂", "攝護腺肥大", "失眠"], medications: ["amlodipine", "rosuvastatin", "tamsulosin", "zolpidem"], allergies: [] }],
      ["a", "謝謝，我已經整理好，也把安眠藥的需求記下來給醫師。"],
    ],
    questions: ["安眠藥可以多開嗎"],
    followUp: ["夜尿次數與飲水時間", "是否有跌倒"],
    narrative: "71 歲男性，夜尿每晚約三次，醒後無法入睡約一個月，白天沒精神。病人詢問安眠藥，已轉交醫師。",
    ticket: { reason: "controlled_drug", urgency: "soon", summary: "病人要求增加安眠藥（管制藥品），AI 已拒絕並轉交。" },
  },
  {
    key: "tsai-reflux",
    patient: "tsai",
    title: "胸口灼熱感",
    ago: 4400,
    status: "submitted",
    submittedAgo: 4380,
    turns: [
      ["p", "吃完宵夜躺下會火燒心", { chief_complaint: "宵夜後躺下有灼熱感" }],
      ["a", "這樣多久了？一週大概幾次？"],
      ["p", "三個月，一週三四次", { "hpi.onset": "三個月", "hpi.course": "每週三四次，沒有變嚴重", "hpi.modifiers": "宵夜後躺下明顯" }],
      ["a", "有吞不下去、體重變輕、吐血或黑便嗎？"],
      ["p", "都沒有", { "hpi.associated": "沒有吞嚥困難、體重減輕、吐血或黑便", "hpi.severity": 4, "hpi.character": "灼熱感", "hpi.location": "胸骨後方", past_history: ["胃食道逆流"], medications: ["omeprazole"], allergies: [] }],
      ["a", "了解，已整理完成。"],
    ],
    narrative: "29 歲男性，胃食道逆流。三個月來宵夜後平躺時灼熱感，每週三四次，沒有吞嚥困難、體重減輕、吐血或黑便。",
    followUp: ["體重與腰圍", "是否規則服藥"],
  },
];

// ------------------------------------------------------------------------------------------------ builder

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const MIN = 60_000;
const MODEL = "gemini-3.5-flash-lite";

export function emptyIntake(): IntakeState {
  return structuredClone(EMPTY_INTAKE.state);
}
export function setField(state: IntakeState, key: string, value: string | number | string[]): void {
  if (key === "chief_complaint") state.chief_complaint = String(value);
  else if (key === "past_history" || key === "medications" || key === "allergies") state[key] = { answered: true, items: Array.isArray(value) ? value : [String(value)] };
  else if (key === "hpi.severity") state.hpi.severity = typeof value === "number" ? value : "n/a";
  else if (key.startsWith("hpi.")) state.hpi[key.slice(4) as Exclude<keyof IntakeState["hpi"], "severity">] = String(value);
}
export function missingFields(state: IntakeState): string[] {
  return INTAKE_FIELDS.filter((k) => {
    if (k === "chief_complaint") return state.chief_complaint === null;
    if (k === "past_history" || k === "medications" || k === "allergies") return !state[k].answered;
    return state.hpi[k.slice(4) as keyof IntakeState["hpi"]] === null;
  });
}
export function stageOf(state: IntakeState): VisitRec["stage"] {
  const missing = missingFields(state).filter(isCoreField);
  if (missing.includes("chief_complaint")) return "chief_complaint";
  if (missing.some((k) => k.startsWith("hpi."))) return "hpi";
  return missing.length ? "background" : "confirm";
}

export function buildSummary(visitId: string, state: IntakeState, evidence: Record<string, string[]>, at: string, o: { revision: number; narrative?: string; followUp?: string[]; redFlags?: PrevisitSummary["red_flag_screen"]["triggered"]; en?: boolean }): PrevisitSummary {
  const triggered = o.redFlags ?? [];
  return {
    visit_id: visitId,
    revision: o.revision,
    edited_by_patient: false,
    chief_complaint: state.chief_complaint,
    hpi: state.hpi,
    past_history: state.past_history.items,
    medications: state.medications.items,
    allergies: state.allergies.items,
    not_collected: missingFields(state),
    red_flag_screen: {
      checked: true,
      triggered,
      note: triggered.length
        ? (o.en ? "Red flag triggered; the patient was told to seek care at once." : "已觸發紅旗並請病人立即就醫。")
        : (o.en ? "Every message was checked. No red flag." : "每則訊息都檢查過，沒有觸發紅旗。"),
    },
    patient_questions: state.patient_questions,
    follow_up: o.followUp ?? [],
    evidence,
    narrative: o.narrative ?? "",
    refill: null,
    generated_by: { kind: o.narrative ? "model" : "code", model: o.narrative ? MODEL : null, at },
    disclaimer: o.en ? DISCLAIMER_EN : DISCLAIMER_ZH,
  };
}

const KIND: Record<Turn[0], [MessageRec["role"], MessageKind]> = {
  p: ["patient", "chat"],
  a: ["assistant", "chat"],
  s: ["staff", "chat"],
  rf: ["assistant", "red_flag"],
  ref: ["assistant", "refusal"],
  n: ["assistant", "notice"],
};

export function buildVisits(now: number, appointments: AppointmentRec[]): { visits: VisitRec[]; tickets: TicketRec[] } {
  const tickets: TicketRec[] = [];
  const visits = SCRIPTS.map((s, index): VisitRec => {
    const id = fid(`visit:${s.key}`);
    const start = now - s.ago * MIN;
    const pace = (s.pace ?? 1) * MIN;
    const messages: MessageRec[] = [];
    const runs: VisitRec["runs"] = [];
    const tool_calls: VisitRec["tool_calls"] = [];
    const intake = emptyIntake();
    const evidence: Record<string, string[]> = {};
    let seq = 1;
    let at = start;
    const push = (role: MessageRec["role"], kind: MessageKind, content: string, runId: string | null): MessageRec => {
      const m: MessageRec = {
        id: fid(`message:${s.key}:${messages.length}`),
        client_id: role === "patient" ? fid(`client:${s.key}:${messages.length}`) : null,
        seq: seq++,
        role,
        kind,
        author_id: role === "staff" ? fid("account:cm") : null,
        content,
        created_at: iso(at),
        run_id: runId,
        status: "ok",
      };
      messages.push(m);
      return m;
    };
    const call = (runId: string | null, step: number, name: ToolName, args: unknown, result: unknown, ms: number, source: "code" | "model" = "code") => {
      tool_calls.push({ id: fid(`call:${s.key}:${tool_calls.length}`), run_id: runId, step, name, source, status: "ok", arguments: args, result, duration_ms: ms, created_at: iso(at) });
    };
    push("assistant", "opening", OPENING_ZH, null);
    let lastPatient: { m: MessageRec; fields?: Fields } | null = null;
    for (const [who, text, fields] of s.turns) {
      at += pace;
      const [role, kind] = KIND[who];
      if (who === "p") {
        const m = push(role, kind, text, null);
        const hit = who === "p" && s.redFlag && text.includes("胸口");
        call(null, 0, "red_flag_precheck", { chars: [...text].length }, hit ? { hit: true, category: s.redFlag!.category, label: s.redFlag!.label, rule_id: "cp-01" } : { hit: false }, 1);
        call(null, 0, "scope_precheck", { chars: [...text].length }, { verdict: text.includes("安眠藥") ? "controlled_drug" : "ok" }, 1);
        for (const [k, v] of Object.entries(fields ?? {})) {
          if (v === undefined) continue;
          setField(intake, k, v);
          evidence[k] = [...(evidence[k] ?? []), m.id];
        }
        lastPatient = { m, fields };
        continue;
      }
      at += 2500;
      const runId = fid(`run:${s.key}:${runs.length}`);
      const modelRun = who === "a";
      if (who === "a" || who === "rf" || who === "ref") {
        runs.push({ id: runId, model: modelRun ? MODEL : "", fallback_used: false, status: modelRun ? "completed" : "skipped", steps: modelRun ? 2 : 0, usage: modelRun ? { input_tokens: 2100 + runs.length * 240, output_tokens: 130 + runs.length * 9 } : { input_tokens: 0, output_tokens: 0 }, error_code: null, duration_ms: modelRun ? 1400 + ((index * 37 + runs.length * 211) % 1600) : 4, created_at: iso(at - 2000) });
        if (modelRun) {
          const applied = Object.keys(lastPatient?.fields ?? {});
          if (applied.length) call(runId, 1, "record_intake", lastPatient?.fields, { applied, rejected: [] }, 6, "model");
          if (text.includes("空腹")) call(runId, 1, "search_health_education", { query: "抽血 空腹", top_k: 3 }, { hits: [{ section: "§1.1", title: "就醫前準備清單", source_type: "official", source_name: "衛生福利部", source_url: "https://mohw.gov.tw/cp-16-45967-1.html", verified_on: "2026-11-25", score: 0.71 }] }, 38, "model");
          call(runId, 2, "output_guard", { chars: [...text].length }, { passed: true, violations: [], action: "none" }, 2);
        }
      }
      push(role, kind, text, who === "s" || who === "n" ? null : runId);
    }
    if (s.lastRun) {
      at += 3000;
      runs.push({ id: fid(`run:${s.key}:last`), model: MODEL, fallback_used: false, status: s.lastRun, steps: 1, usage: { input_tokens: 2400, output_tokens: 0 }, error_code: s.lastRun === "failed" ? "model_error" : null, duration_ms: 0, created_at: iso(at) });
    }
    intake.patient_questions = s.questions ?? [];
    const lastAt = iso(at);
    const submitted = s.submittedAgo === undefined ? null : iso(now - s.submittedAgo * MIN);
    const reviewed = s.reviewedAgo === undefined ? null : iso(now - s.reviewedAgo * MIN);
    const withSummary = submitted !== null || s.status === "red_flag";
    const redFlagMessage = s.redFlag ? messages.findLast((m) => m.role === "patient" && m.content.includes("胸口")) : undefined;
    const by = s.note ? fid(`account:${s.note.by}`) : null;
    const sections: ClinicalNoteSections = { subjective: "", objective: "", assessment: "", plan: "", patient_message: "", ...s.note?.sections };
    const signedAt = s.note?.status === "signed" ? (reviewed ?? lastAt) : null;
    const note: NoteRec | null = s.note
      ? {
          revision: 2,
          version: 1,
          status: s.note.status,
          sections,
          author_id: by,
          signed_by: signedAt ? by : null,
          signed_at: signedAt,
          addenda: s.note.addendum && by ? [{ body: s.note.addendum, by, at: iso(Date.parse(signedAt ?? lastAt) + 3 * 86_400_000) }] : [],
          history: [{ version: 1, by, at: signedAt ?? lastAt }],
        }
      : null;
    if (s.ticket) {
      tickets.push({
        id: fid(`ticket:${s.key}`),
        ticket_no: "",
        visit_id: id,
        rx_id: null,
        patient_id: fid(`account:${s.patient}`),
        reason: s.ticket.reason,
        urgency: s.ticket.urgency,
        summary: s.ticket.summary,
        status: s.ticket.resolved ? "resolved" : "open",
        created_by: s.ticket.reason === "patient_request" ? "form" : "code",
        created_at: redFlagMessage?.created_at ?? lastAt,
        resolved_at: null,
        resolved_by: null,
        resolution_note: s.ticket.resolved ?? null,
      });
    }
    return {
      id,
      patient_id: fid(`account:${s.patient}`),
      title: s.title,
      locale: "zh-TW",
      status: s.status,
      stage: s.status === "active" ? stageOf(intake) : "done",
      urgency: s.urgency ?? s.ticket?.urgency ?? "routine",
      mode: s.mode ?? "ai",
      pinned: s.pinned ?? false,
      archived: s.archived ?? false,
      appointment_id: s.appointment ? (appointments.find((a) => a.id === fid(`appointment:${s.appointment}`))?.id ?? null) : null,
      assigned_to: s.assigned ? fid(`account:${s.assigned}`) : null,
      seq: seq - 1,
      created_at: iso(start),
      updated_at: reviewed ?? submitted ?? lastAt,
      last_activity_at: reviewed ?? submitted ?? lastAt,
      submitted_at: submitted,
      reviewed_at: reviewed,
      reviewed_by: reviewed ? (by ?? fid("account:dr")) : null,
      reads: { [fid(`account:${s.patient}`)]: seq - 1 },
      messages,
      intake,
      evidence,
      summary: withSummary
        ? buildSummary(id, intake, evidence, submitted ?? lastAt, { revision: 1, narrative: s.narrative, followUp: s.followUp, redFlags: s.redFlag ? [s.redFlag] : [] })
        : null,
      red_flag: s.redFlag && redFlagMessage ? { ...s.redFlag, matched_at: redFlagMessage.created_at, message_id: redFlagMessage.id } : null,
      tool_calls,
      runs,
      refill_checks: [],
      note,
      events: [],
    };
  });
  return { visits, tickets };
}
