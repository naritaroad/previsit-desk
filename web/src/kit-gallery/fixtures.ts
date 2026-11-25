// Sample content for the component gallery. Development only; everyone here is fictional.

import type { Me, Measurement, Notification, RxRequestBrief, WorkItem, AccountRow } from "@/api/types";
import type { RefillStripData } from "@/ui";

export const TODAY = "2026-11-25";
const person = (id: string, display_name: string, role: Me["role"], title: string | null = null) => ({ id, display_name, role, title, avatar: null });

export const lin = person("p1", "林秀琴", "patient");
export const chen = person("d1", "陳柏宇", "physician", "家醫科醫師");
export const wu = person("r1", "吳思穎", "pharmacist", "藥師");
export const hsu = person("c1", "許雅雯", "coordinator", "個案管理師");

export function me(role: Me["role"], name: string, title: string | null = null): Me {
  return {
    id: "me",
    username: "demo",
    display_name: name,
    role,
    title,
    avatar: null,
    is_guest: role === "patient",
    is_demo: true,
    locale: "zh-TW",
    preferences: {},
    permissions: ["oversight.read", "rules.read"],
    unread_notifications: 3,
    must_change_password: false,
    expires_at: null,
  };
}

export const refills: Record<"open" | "soon" | "fresh" | "late" | "finished" | "lastDays" | "two", RefillStripData> = {
  // Three-day window at the very end, today on the last day.
  lastDays: {
    issued_on: "2026-08-30",
    valid_until: "2026-11-25",
    days_per_fill: 28,
    fills_allowed: 3,
    fills: [
      { n: 1, filled_on: "2026-09-02", pharmacy_name: "和平藥局" },
      { n: 2, filled_on: "2026-10-01", pharmacy_name: "和平藥局" },
    ],
    supply_ends_on: "2026-10-29",
    next_window: { from: "2026-11-23", to: "2026-11-25" },
    state: "window_open",
  },
  // Two fills, one-day window.
  two: {
    issued_on: "2026-11-24",
    valid_until: "2027-01-22",
    days_per_fill: 30,
    fills_allowed: 2,
    fills: [{ n: 1, filled_on: "2026-11-24", pharmacy_name: "和平藥局" }],
    supply_ends_on: "2026-12-24",
    next_window: { from: "2026-12-24", to: "2026-12-24" },
    state: "on_hand",
  },
  open: {
    issued_on: "2026-10-03",
    valid_until: "2026-12-31",
    days_per_fill: 28,
    fills_allowed: 3,
    fills: [
      { n: 1, filled_on: "2026-10-03", pharmacy_name: "和平藥局" },
      { n: 2, filled_on: "2026-10-30", pharmacy_name: "和平藥局" },
    ],
    supply_ends_on: "2026-11-28",
    next_window: { from: "2026-11-18", to: "2026-11-28" },
    state: "window_open",
  },
  soon: {
    issued_on: "2026-10-08",
    valid_until: "2027-01-05",
    days_per_fill: 28,
    fills_allowed: 3,
    fills: [
      { n: 1, filled_on: "2026-10-08", pharmacy_name: "大安森林藥局" },
      { n: 2, filled_on: "2026-11-05", pharmacy_name: "大安森林藥局" },
    ],
    supply_ends_on: "2026-12-03",
    next_window: { from: "2026-11-27", to: "2026-12-03" },
    state: "window_soon",
  },
  fresh: {
    issued_on: "2026-11-20",
    valid_until: "2027-02-17",
    days_per_fill: 28,
    fills_allowed: 3,
    fills: [{ n: 1, filled_on: "2026-11-20", pharmacy_name: "和平藥局" }],
    supply_ends_on: "2026-12-18",
    next_window: { from: "2026-12-08", to: "2026-12-18" },
    state: "on_hand",
  },
  late: {
    issued_on: "2026-09-18",
    valid_until: "2026-12-16",
    days_per_fill: 28,
    fills_allowed: 3,
    fills: [{ n: 1, filled_on: "2026-09-20", pharmacy_name: "和平藥局" }],
    supply_ends_on: "2026-10-18",
    next_window: { from: "2026-10-08", to: "2026-10-18" },
    state: "late",
  },
  finished: {
    issued_on: "2026-08-20",
    valid_until: "2026-11-17",
    days_per_fill: 28,
    fills_allowed: 3,
    fills: [
      { n: 1, filled_on: "2026-08-20", pharmacy_name: "和平藥局" },
      { n: 2, filled_on: "2026-09-15", pharmacy_name: "和平藥局" },
      { n: 3, filled_on: "2026-10-12", pharmacy_name: "和平藥局" },
    ],
    supply_ends_on: "2026-11-09",
    next_window: null,
    state: "finished",
  },
};

export const meds = [
  { name: "Amlodipine 5 mg", generic: "Amlodipine", dose: "每日 1 次，早餐後 1 顆", cls: "降血壓藥", refill: refills.open },
  { name: "Metformin 500 mg", generic: "Metformin", dose: "每日 2 次，早晚餐後各 1 顆", cls: "降血糖藥", refill: refills.soon },
  { name: "Atorvastatin 10 mg", generic: "Atorvastatin", dose: "每日 1 次，睡前 1 顆", cls: "降血脂藥", refill: refills.finished },
];

export const bp: Measurement[] = [
  [10, 2, 148, 92],
  [10, 9, 144, 90],
  [10, 16, 139, 88],
  [10, 24, 141, 86],
  [10, 31, 136, 85],
  [11, 6, 134, 84],
  [11, 12, 138, 86],
  [11, 18, 132, 82],
  [11, 24, 134, 83],
].map(([m, d, s, di], i) => ({ id: `m${i}`, kind: "bp", values: { systolic: s, diastolic: di }, taken_at: `2026-${m}-${String(d).padStart(2, "0")}T00:30:00Z`, source: i % 4 === 0 ? "clinic" : "patient" }));

export const notifications: Notification[] = [
  { id: "n1", kind: "rx.ready", title: "降血壓藥可以領取了", body: "和平藥局已備好，請帶健保卡於 11 月 28 日前領取。", link: "/app/rx/1", read_at: null, created_at: "2026-11-25T03:20:00Z" },
  { id: "n2", kind: "visit.reviewed", title: "陳柏宇醫師看過您的預問診", body: "醫師留了一段話給您。", link: "/app/visits/1", read_at: null, created_at: "2026-11-24T09:10:00Z" },
  { id: "n3", kind: "appt.reminder", title: "明天 09:40 有門診", body: "家醫科 3 診，請提前 10 分鐘報到。", link: "/app/appointments", read_at: null, created_at: "2026-11-25T00:00:00Z" },
  { id: "n4", kind: "refill.window_open", title: "降血壓藥第 3 次可以領了", body: "", link: "/app/medications", read_at: "2026-11-19T01:00:00Z", created_at: "2026-11-18T00:00:00Z" },
];

export const convos = [
  { id: "v1", title: "胸口悶、爬樓梯會喘", time: "剛剛", status: "active", unread: true },
  { id: "v2", title: "血壓藥快吃完，想先問副作用", time: "昨天", status: "submitted", unread: false },
  { id: "v3", title: "回診前整理：血糖紀錄", time: "11月18日", status: "reviewed", unread: false },
  { id: "v4", title: "膝蓋痛三個星期", time: "10月30日", status: "reviewed", unread: false },
];

const item = (id: string, type: WorkItem["type"], name: string, title: string, subtitle: string, urgency: WorkItem["urgency"], status: string, assigned: typeof chen | null, due: string | null, updated: string): WorkItem =>
  ({ id, type, patient: person(`p${id}`, name, "patient"), title, subtitle, urgency, status, assigned_to: assigned, due_at: due, updated_at: updated, link: "/clinic" }) as WorkItem;

export const worklist: WorkItem[] = [
  item("1", "visit", "林秀琴", "胸悶、活動後喘", "紅旗：胸痛類，14:02 命中", "urgent", "red_flag", chen, "2026-11-25T06:30:00Z", "2026-11-25T06:02:00Z"),
  item("2", "rx", "張文雄", "續開：降血壓藥、降血脂藥", "RX-20261125-0007，引擎：請醫師判斷", "soon", "in_review", null, "2026-11-25T09:00:00Z", "2026-11-25T05:41:00Z"),
  item("3", "visit", "黃美玲", "頭暈兩週，量到血壓偏高", "預問診完成 11／12 項", "routine", "submitted", chen, "2026-11-26T01:40:00Z", "2026-11-25T05:12:00Z"),
  item("4", "ticket", "歐陽淑芬", "想問停藥後再吃的時間", "超出 AI 範圍，病人要求真人", "soon", "open", hsu, "2026-11-25T08:00:00Z", "2026-11-25T04:55:00Z"),
  item("5", "rx", "李建國", "續開：降血糖藥", "RX-20261125-0004，引擎：符合協定", "routine", "in_review", chen, "2026-11-26T04:00:00Z", "2026-11-25T03:30:00Z"),
  item("6", "visit", "吳春生", "膝蓋痛三個星期", "預問診完成 12／12 項", "routine", "submitted", null, "2026-11-26T02:20:00Z", "2026-11-25T02:15:00Z"),
  item("7", "rx", "陳麗華", "續開：降血壓藥", "RX-20261124-0011，等病人補血壓", "routine", "more_info", chen, "2026-11-25T04:00:00Z", "2026-11-24T08:20:00Z"),
  item("8", "visit", "Muhammad Rizal bin Abdullah", "Cough for 10 days, worse at night", "預問診完成 9／12 項", "routine", "submitted", null, "2026-11-26T06:00:00Z", "2026-11-25T01:05:00Z"),
];

const brief = (id: string, no: string, name: string, kind: RxRequestBrief["kind"], status: RxRequestBrief["status"], drugs: string[], at: string, assigned: typeof wu | null): RxRequestBrief =>
  ({ id, no, kind, status, priority: "routine", patient: person(`q${id}`, name, "patient"), drug_names: drugs, disposition: "ready", assigned_to: assigned, submitted_at: at, sla_due_at: "2026-11-25T09:00:00Z", overdue: false, updated_at: at, unread: false }) as RxRequestBrief;

export const pharmacyQueue: RxRequestBrief[] = [
  brief("1", "RX-20261125-0012", "林秀琴", "refill", "at_pharmacy", ["Amlodipine 5 mg"], "2026-11-25T05:50:00Z", null),
  brief("2", "RX-20261125-0009", "張文雄", "renewal", "at_pharmacy", ["Valsartan 80 mg", "Atorvastatin 10 mg"], "2026-11-25T05:10:00Z", wu),
  brief("3", "RX-20261125-0006", "蔡金水", "refill", "at_pharmacy", ["Metformin 500 mg"], "2026-11-25T03:42:00Z", wu),
  brief("4", "RX-20261125-0003", "王陳秀英", "refill", "at_pharmacy", ["Amlodipine 5 mg", "Aspirin 100 mg"], "2026-11-25T02:08:00Z", null),
];

const acct = (id: string, username: string, display_name: string, role: AccountRow["role"], title: string | null, status: AccountRow["status"], sessions: number, last: string | null): AccountRow =>
  ({ id, username, display_name, role, title, status, is_guest: false, is_demo: true, created_at: "2026-11-20T00:00:00Z", last_login_at: last, sessions }) as AccountRow;
export const accounts: AccountRow[] = [
  acct("1", "naritaroad", "站台管理員", "admin", null, "active", 2, "2026-11-25T05:58:00Z"),
  acct("2", "dr_demo", "陳柏宇", "physician", "家醫科醫師", "active", 1, "2026-11-25T05:40:00Z"),
  acct("3", "rph_demo", "吳思穎", "pharmacist", "藥師", "active", 1, "2026-11-25T04:12:00Z"),
  acct("4", "cm_demo", "許雅雯", "coordinator", "個案管理師", "active", 0, "2026-11-24T09:30:00Z"),
  acct("5", "patient_demo", "林秀琴", "patient", null, "active", 1, "2026-11-25T06:01:00Z"),
  acct("6", "old_staff", "測試帳號", "coordinator", null, "disabled", 0, null),
];

/** Interface words used only by the gallery. */
export const W = {
  kit: "元件庫",
  scenes: "場景",
  sections: ["基礎", "按鈕與連結", "表單", "彈出層", "狀態與回饋", "資料", "用藥", "對話", "文件", "搜尋與通知"],
};
