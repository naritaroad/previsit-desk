// Puts the fixtures together. Everything is relative to now, so "today" always has appointments, deadlines and
// activity.

import { addDays, daysBetween, taipeiDate, taipeiInstant } from "../../lib/format.ts";
import { type AccountRec, type AppointmentRec, type AuditRec, type Db, DB_VERSION, fid, type NotificationRec } from "../db.ts";
import { PATIENTS, type PersonSeed, measurements, prescriptions, profileOf, STAFF } from "./people.ts";
import { buildRx } from "./rx.ts";
import { buildVisits } from "./visits.ts";

const MIN = 60_000;
const DAY = 86_400_000;

export function seedDb(now = Date.now()): Db {
  const today = taipeiDate(now);
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const minutesAgo = (m: number) => iso(now - m * MIN);
  const account = (p: PersonSeed, i: number): AccountRec => ({
    id: fid(`account:${p.key}`),
    username: p.username,
    display_name: p.zh,
    display_name_en: p.en,
    role: p.role,
    title: p.title?.[0] ?? null,
    title_en: p.title?.[1] ?? null,
    avatar: null,
    status: "active",
    is_guest: false,
    is_demo: p.key !== "admin",
    locale: "zh-TW",
    preferences: {},
    must_change_password: false,
    created_at: iso(now - (120 - i) * DAY),
    last_login_at: p.username ? minutesAgo(30 + i * 45) : null,
    expires_at: null,
  });
  const accounts = [...STAFF, ...PATIENTS].map(account);

  // ---- appointments: today at the clinic, plus past and coming ones ----
  const appt = (key: string, patient: string, physician: "dr" | "dr2", days: number, time: string, o: Partial<AppointmentRec> = {}): AppointmentRec => ({
    id: fid(`appointment:${key}`),
    patient_id: fid(`account:${patient}`),
    physician_id: fid(`account:${physician}`),
    department_zh: physician === "dr" ? "慢性病門診" : "家庭醫學科",
    department_en: physician === "dr" ? "Chronic care clinic" : "Family medicine",
    starts_at: taipeiInstant(addDays(today, days), time),
    minutes: 15,
    mode: "in_person",
    status: "booked",
    reason: null,
    room: physician === "dr" ? "3 診" : "5 診",
    ...o,
  });
  const appointments: AppointmentRec[] = [
    appt("cheng-done", "cheng", "dr", 0, "09:00", { status: "completed", reason: "看抽血報告" }),
    appt("lin-today", "lin", "dr", 0, "09:30", { status: "checked_in", reason: "頭暈" }),
    appt("chang-today", "chang", "dr", 0, "10:00", { status: "checked_in", reason: "夜咳" }),
    appt("li-today", "li", "dr", 0, "10:15", { reason: "腳趾腫痛加掛" }),
    appt("kuo-today", "kuo", "dr2", 0, "14:00", { reason: "頭痛" }),
    appt("tsai-today", "tsai", "dr2", 0, "14:30", { reason: "胃不舒服", mode: "video", room: null }),
    appt("liu-today", "liu", "dr", 0, "15:00", { status: "cancelled", reason: "抽血報告" }),
    appt("wu-today", "wu", "dr", 0, "15:15", { reason: "睡不好" }),
    appt("huang-today", "huang", "dr2", 0, "16:00", { reason: "甲狀腺追蹤" }),
    appt("lin-next", "lin", "dr", 6, "09:15", { reason: "血糖追蹤" }),
    appt("hsieh-next", "hsieh", "dr", 2, "11:00", { reason: "拔牙前評估" }),
    appt("wang-next", "wang", "dr", 5, "10:30", { reason: "心律追蹤" }),
    appt("cheng-next", "cheng", "dr", 90, "09:00", { reason: "三個月追蹤" }),
    appt("lin-past", "lin", "dr", -58, "09:30", { status: "completed", reason: "咳嗽" }),
    appt("chang-past", "chang", "dr", -86, "10:30", { status: "completed" }),
    appt("wu-past", "wu", "dr", -95, "10:30", { status: "completed" }),
    appt("huang-past", "huang", "dr2", -88, "14:30", { status: "completed" }),
    appt("li-past", "li", "dr", -44, "15:00", { status: "completed" }),
    appt("wang-past", "wang", "dr", -22, "15:30", { status: "completed" }),
    appt("tsai-past", "tsai", "dr2", -92, "16:00", { status: "completed" }),
    appt("liu-past", "liu", "dr", -400, "11:00", { status: "completed" }),
    appt("kuo-past", "kuo", "dr2", -30, "14:15", { status: "completed" }),
    appt("hsieh-past", "hsieh", "dr", -60, "11:15", { status: "completed" }),
  ];
  const lastSeenDays = (patientId: string): number | null => {
    const seen = appointments
      .filter((a) => a.patient_id === patientId && a.status === "completed")
      .map((a) => daysBetween(taipeiDate(a.starts_at), today))
      .filter((d) => d >= 0);
    return seen.length ? Math.min(...seen) : null;
  };

  const rxList = prescriptions(today);
  const { visits, tickets } = buildVisits(now, appointments);
  const rx = buildRx(now, today, rxList, lastSeenDays);

  // The urgent renewal has its own ticket.
  const urgent = rx.find((r) => r.priority === "urgent");
  if (urgent) {
    tickets.push({
      id: fid("ticket:tsai-urgent"),
      ticket_no: "",
      visit_id: null,
      rx_id: urgent.id,
      patient_id: urgent.patient_id,
      reason: "red_flag",
      urgency: "urgent",
      summary: `續開申請 ${urgent.no}：病人回答有黑便，已請病人立即就醫。`,
      status: "open",
      created_by: "code",
      created_at: urgent.submitted_at ?? minutesAgo(60),
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
    });
  }
  tickets.push({
    id: fid("ticket:resolved"),
    ticket_no: "",
    visit_id: fid("visit:lin-cough"),
    rx_id: null,
    patient_id: fid("account:lin"),
    reason: "side_effects",
    urgency: "soon",
    summary: "病人詢問乾咳是否與血壓藥有關。",
    status: "resolved",
    created_by: "model",
    created_at: iso(now - 58 * DAY),
    resolved_at: iso(now - 57 * DAY),
    resolved_by: "許雅雯",
    resolution_note: "已電話說明，醫師看診時一併評估。",
  });
  tickets.sort((a, b) => a.created_at.localeCompare(b.created_at));
  tickets.forEach((t, i) => {
    t.ticket_no = `T-${taipeiDate(t.created_at).replaceAll("-", "")}-${String(i + 1).padStart(4, "0")}`;
  });

  // ---- notifications ----
  const notify = (to: string, kind: NotificationRec["kind"], min: number, texts: [string, string, string, string], link: string | null, read = false): NotificationRec => ({
    id: fid(`notification:${to}:${kind}:${min}`),
    account_id: fid(`account:${to}`),
    kind,
    title_zh: texts[0],
    title_en: texts[1],
    body_zh: texts[2],
    body_en: texts[3],
    link,
    read_at: read ? minutesAgo(Math.max(0, min - 5)) : null,
    created_at: minutesAgo(min),
  });
  const rxId = (key: string) => fid(`rx:${key}`);
  const notifications: NotificationRec[] = [
    notify("lin", "rx.ready", 180, ["藥已備好", "Your medicine is ready", "安和示範藥局已備好 metformin，請於領藥時段前往。", "Anhe Demo Pharmacy has prepared metformin."], `/app/rx/${rxId("lin-metformin-ready")}`),
    notify("lin", "rx.more_info", 300, ["醫師請您補充資料", "The doctor needs more information", "續開申請有一個問題要請您回覆。", "Please answer one question about your renewal request."], `/app/rx/${rxId("lin-sita-more")}`),
    notify("lin", "refill.window_open", 2000, ["可以預約領藥了", "Refill window is open", "amlodipine 已進入可領藥的期間。", "You can now refill amlodipine."], "/app/medications"),
    notify("lin", "appt.reminder", 1200, ["看診提醒", "Appointment reminder", "今天 09:30 慢性病門診，陳柏宇醫師。", "Today 09:30, Chronic care clinic, Dr Po-Yu Chen."], "/app/appointments", true),
    notify("lin", "visit.reviewed", 82_700, ["醫師已看過您的預問診", "Your previsit was reviewed", "陳柏宇醫師留了一段話給您。", "Dr Po-Yu Chen left you a message."], `/app/visits/${fid("visit:lin-cough")}`, true),
    notify("dr", "red_flag", 21, ["紅旗：胸痛或胸悶", "Red flag: chest pain or tightness", "王淑芬的預問診觸發紅旗，已請病人就醫。", "A red flag was raised in Shu-Fen Wang's previsit."], `/clinic/visits/${fid("visit:wang-chest")}`),
    notify("dr", "rx.new", 60, ["緊急續開申請", "Urgent renewal request", "蔡宗翰的申請有危急徵象。", "Tsung-Han Tsai's request contains a danger sign."], `/clinic/rx/${rxId("tsai-urgent")}`),
    notify("dr", "visit.submitted", 160, ["預問診已送出", "Previsit sent", "張志明送出今天看診的預問診。", "Chih-Ming Chang sent the previsit for today."], `/clinic/visits/${fid("visit:chang-night")}`),
    notify("dr", "rx.overdue", 600, ["續開申請逾時", "Renewal request overdue", "吳金水的申請已超過處理時間。", "Chin-Shui Wu's request is past its due time."], `/clinic/rx/${rxId("wu-bp-lipid")}`),
    notify("dr", "ticket.new", 280, ["新的轉交單", "New ticket", "李國華希望今天加掛。", "Kuo-Hua Li asks to be seen today."], `/clinic/visits/${fid("visit:li-toe")}`, true),
    notify("cm", "ticket.new", 120, ["新的轉交單", "New ticket", "黃美玲希望由人員回覆。", "Mei-Ling Huang asks for a person."], `/clinic/visits/${fid("visit:huang-tsh")}`),
    notify("cm", "red_flag", 21, ["紅旗：胸痛或胸悶", "Red flag: chest pain or tightness", "王淑芬的預問診觸發紅旗，已請病人就醫。", "A red flag was raised in Shu-Fen Wang's previsit."], `/clinic/visits/${fid("visit:wang-chest")}`),
    notify("rph", "rx.new", 120, ["新的領藥預約", "New refill pickup", "郭怡婷預約明天下午領藥。", "Yi-Ting Kuo booked a pickup for tomorrow afternoon."], `/pharmacy/rx/${rxId("kuo-fexo")}`),
    notify("rph", "rx.new", 1320, ["新的調劑項目", "New item to dispense", "李國華的 allopurinol 續開已由醫師同意。", "Kuo-Hua Li's allopurinol renewal was approved."], `/pharmacy/rx/${rxId("li-allopurinol")}`),
  ];

  // ---- audit and access ----
  const audit: AuditRec[] = [];
  const log = (min: number, actor: string, kind: AuditRec["kind"], action: string, target: string, detail: unknown = {}, patient?: string) =>
    audit.push({ at: minutesAgo(min), actor_id: fid(`account:${actor}`), kind, action, target, detail, ...(patient ? { patient_id: fid(`account:${patient}`) } : {}) });
  log(4, "dr", "access", "visit.read", `visit:${fid("visit:chang-night")}`, { resource: "預問診" }, "chang");
  log(12, "dr", "access", "patient.read", "patient", { resource: "病人資料" }, "lin");
  log(13, "dr", "access", "visit.read", `visit:${fid("visit:lin-dizzy")}`, { resource: "預問診" }, "lin");
  log(20, "cm", "access", "visit.read", `visit:${fid("visit:wang-chest")}`, { resource: "預問診" }, "wang");
  log(60, "dr", "rx", "rx.decide", `rx:${rxId("liu-visit")}`, { outcome: "approve" });
  log(75, "dr", "auth", "login", "session", { device: "Windows · Edge" });
  log(180, "rph", "rx", "rx.ready", `rx:${rxId("lin-metformin-ready")}`);
  log(182, "rph", "access", "rx.read", `rx:${rxId("lin-metformin-ready")}`, { resource: "領藥預約" }, "lin");
  log(240, "dr", "clinic", "note.sign", `visit:${fid("visit:cheng-followup")}`, { version: 1 });
  log(300, "dr", "rx", "rx.more_info", `rx:${rxId("lin-sita-more")}`);
  log(302, "dr", "access", "rx.read", `rx:${rxId("lin-sita-more")}`, { resource: "續開申請" }, "lin");
  log(420, "admin", "admin", "settings.update", "settings", { changed: ["ai.daily_call_limit"] });
  log(424, "admin", "auth", "login", "session", { device: "Windows · Chrome" });
  log(900, "cm", "access", "patient.read", "patient", { resource: "病人資料" }, "lin");
  log(1440, "admin", "admin", "account.create", "account:guest", { role: "patient" });
  log(2880, "admin", "admin", "account.reset_password", "account:rph_demo");
  log(4320, "dr", "rx", "rx.decide", `rx:${rxId("liu-declined")}`, { outcome: "decline" });
  log(8600, "dr", "access", "patient.read", "patient", { resource: "病人資料" }, "lin");

  return {
    v: DB_VERSION,
    seeded_at: iso(now),
    accounts,
    sessions: [],
    profiles: Object.fromEntries(PATIENTS.map((p) => [fid(`account:${p.key}`), profileOf(p, iso(now - 6 * DAY))])),
    care: Object.fromEntries(
      PATIENTS.map((p) => [
        fid(`account:${p.key}`),
        {
          tags: [...p.tags],
          care_status: p.care,
          physician_id: p.physician ? fid(`account:${p.physician}`) : null,
          coordinator_id: p.coordinator ? fid(`account:${p.coordinator}`) : null,
          last_contact_at: p.contactDaysAgo === null ? null : iso(now - p.contactDaysAgo * DAY - 90 * MIN),
          flags: [...p.flags],
        },
      ]),
    ),
    measurements: measurements(today),
    prescriptions: rxList,
    visits,
    tickets,
    appointments,
    rx,
    notifications,
    drafts: {},
    consents: PATIENTS.filter((p) => p.username).flatMap((p) =>
      (["terms", "ai_disclosure"] as const).map((doc) => ({ account_id: fid(`account:${p.key}`), doc, version: "2026-11", granted: true, created_at: iso(now - 30 * DAY) })),
    ),
    staff_notes: [
      { id: fid("note:1"), patient_id: fid("account:wang"), author_id: fid("account:cm"), body: "兒子在同一間工廠上班，緊急時可以請他陪同就醫。", pinned: true, created_at: iso(now - 12 * DAY) },
      { id: fid("note:2"), patient_id: fid("account:wang"), author_id: fid("account:dr"), body: "抗凝血藥由心臟科追蹤，線上申請一律請回診。", pinned: false, created_at: iso(now - 22 * DAY) },
      { id: fid("note:3"), patient_id: fid("account:wu"), author_id: fid("account:cm"), body: "獨居，上週浴室滑了一下沒受傷。已建議裝扶手，下個月再問。", pinned: true, created_at: iso(now - 14 * DAY) },
      { id: fid("note:4"), patient_id: fid("account:cheng"), author_id: fid("account:cm"), body: "用藥由女兒分裝，聯絡請打女兒手機（病歷系統內）。", pinned: true, created_at: iso(now - 40 * DAY) },
      { id: fid("note:5"), patient_id: fid("account:lin"), author_id: fid("account:cm"), body: "最近孫子同住，點心吃得比較多。下次衛教帶食物份量圖卡。", pinned: false, created_at: iso(now - 6 * DAY) },
      { id: fid("note:6"), patient_id: fid("account:liu"), author_id: fid("account:cm"), body: "兩次約抽血沒來。戒菸門診第三次已完成。", pinned: false, created_at: iso(now - 9 * DAY) },
    ],
    contacts: [
      { at: iso(now - 6 * DAY), patient_id: fid("account:lin"), author_id: fid("account:cm"), channel: "phone_note", body: "電話衛教：晚餐後水果一份就好，下次回診帶血糖紀錄。" },
      { at: iso(now - 2 * DAY), patient_id: fid("account:chang"), author_id: fid("account:cm"), channel: "in_app", body: "提醒每天使用控制型吸入劑，用完漱口。" },
      { at: iso(now - 14 * DAY), patient_id: fid("account:wu"), author_id: fid("account:cm"), channel: "phone_note", body: "確認跌倒情形，無外傷。" },
    ],
    audit,
    settings: {
      revision: 3,
      ai: {
        enabled: true,
        primary: "gemini-3.5-flash-lite",
        fallback: "gemini-3.1-flash-lite",
        thinking: "low",
        temperature: 0.3,
        max_steps: 6,
        daily_call_limit: 2000,
        per_client_daily_limit: 120,
        monthly_budget_usd: 20,
        on_budget: "fallback",
        prices: { "gemini-3.5-flash-lite": { in: 0.1, out: 0.4 }, "gemini-3.1-flash-lite": { in: 0.075, out: 0.3 } },
      },
      limits: { messages_per_10min: 30, visits_per_10min: 6, max_messages_per_visit: 80 },
      rx: { sla_hours_routine: 48, sla_hours_soon: 24, oversight_phase: 1 },
      retention_days: 30,
    },
    turns: [],
    idem: {},
    counters: { rx: rx.length, ticket: tickets.length },
  };
}
