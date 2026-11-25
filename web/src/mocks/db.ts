// The mock server's store: plain JSON, kept in localStorage so reloads and other tabs see the same data.
// Records point at people by id; the server joins them (people.ts is a function of the reader's language).

import type {
  AdminSettings,
  Appointment,
  CareStatus,
  ClinicalNoteSections,
  Consent,
  EngineResult,
  Fill,
  HealthProfile,
  IntakeState,
  Locale,
  Measurement,
  Message,
  MonitoringValue,
  NotificationKind,
  PickupWindow,
  PrevisitSummary,
  RedFlagHit,
  RefillCheckRecord,
  Role,
  Run,
  RxItem,
  RxKind,
  RxOutcome,
  RxStatus,
  Stage,
  Ticket,
  ToolCall,
  Urgency,
  VisitMode,
  VisitStatus,
} from "../api/types.ts";

export interface AccountRec {
  id: string;
  username: string | null;
  display_name: string;
  display_name_en: string;
  role: Role;
  title: string | null;
  title_en: string | null;
  avatar: string | null;
  status: "active" | "disabled";
  is_guest: boolean;
  is_demo: boolean;
  locale: Locale;
  preferences: Record<string, unknown>;
  must_change_password: boolean;
  created_at: string;
  last_login_at: string | null;
  expires_at: string | null;
}
export interface SessionRec {
  token: string;
  id: string;
  account_id: string;
  device: string;
  created_at: string;
  last_seen_at: string;
}
export interface PrescriptionRec {
  id: string;
  patient_id: string;
  drug_id: string;
  /** For self-reported medicines that are not in the formulary. */
  name: string;
  dose_zh: string;
  dose_en: string;
  source: "clinic" | "self_reported";
  issued_on: string;
  total_days: number;
  days_per_fill: number;
  fills_allowed: number;
  fills: Fill[];
}
export interface MessageRec extends Omit<Message, "author"> {
  author_id: string | null;
}
export interface NoteRec {
  revision: number;
  version: number;
  status: "draft" | "signed";
  sections: ClinicalNoteSections;
  author_id: string | null;
  signed_by: string | null;
  signed_at: string | null;
  addenda: { body: string; by: string; at: string }[];
  history: { version: number; by: string | null; at: string }[];
}
export interface EventRec {
  seq: number;
  type: string;
  data: unknown;
}
export interface VisitRec {
  id: string;
  patient_id: string;
  title: string;
  locale: Locale;
  status: VisitStatus;
  stage: Stage;
  urgency: Urgency;
  mode: VisitMode;
  pinned: boolean;
  archived: boolean;
  appointment_id: string | null;
  assigned_to: string | null;
  seq: number;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  /** account id -> last seq read */
  reads: Record<string, number>;
  messages: MessageRec[];
  intake: IntakeState;
  evidence: Record<string, string[]>;
  summary: PrevisitSummary | null;
  red_flag: RedFlagHit | null;
  tool_calls: ToolCall[];
  runs: Run[];
  refill_checks: RefillCheckRecord[];
  note: NoteRec | null;
  events: EventRec[];
}
export interface TicketRec extends Omit<Ticket, "patient" | "rx_id"> {
  patient_id: string;
  rx_id: string | null;
}
export interface AppointmentRec extends Omit<Appointment, "physician" | "visit_id" | "department"> {
  physician_id: string;
  patient_id: string;
  department_zh: string;
  department_en: string;
}
export interface RxItemRec {
  id: string;
  prescription_id: string;
  engine: RxItem["engine"];
  refill: RxItem["refill"];
  decision: { outcome: RxOutcome; note: string | null; by: string; at: string } | null;
}
export interface RxEventRec {
  at: string;
  type: string;
  actor_id: string | null;
  zh: string;
  en: string;
  visibility: "all" | "staff";
}
export interface RxRec {
  id: string;
  no: string;
  kind: RxKind;
  status: RxStatus;
  revision: number;
  patient_id: string;
  items: RxItemRec[];
  step: string;
  answers: Record<string, unknown>;
  monitoring: Record<string, MonitoringValue>;
  engine: EngineResult | null;
  pharmacy_id: string | null;
  pickup_window: PickupWindow | null;
  assigned_to: string | null;
  priority: Urgency;
  sla_due_at: string | null;
  decision_note: string | null;
  patient_message: string | null;
  created_at: string;
  submitted_at: string | null;
  updated_at: string;
  timeline: RxEventRec[];
  messages: { id: string; author_id: string; body: string; created_at: string; visibility: "all" | "staff" }[];
  reads: Record<string, string>;
}
export interface NotificationRec {
  id: string;
  account_id: string;
  kind: NotificationKind;
  title_zh: string;
  title_en: string;
  body_zh: string;
  body_en: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
}
export interface CareRec {
  tags: string[];
  care_status: CareStatus;
  physician_id: string | null;
  coordinator_id: string | null;
  last_contact_at: string | null;
  flags: string[];
}
export interface AuditRec {
  at: string;
  actor_id: string;
  kind: "admin" | "access" | "rx" | "auth" | "clinic";
  action: string;
  target: string;
  /** Access rows: whose data. */
  patient_id?: string;
  detail: unknown;
}
/** A scripted assistant turn: steps run one after the other and survive a reload. */
export interface TurnRec {
  id: string;
  visit_id: string;
  run_id: string;
  message_id: string;
  steps: { delay: number; type: string; data: unknown }[];
  next: number;
  dueAt: number;
}
export interface Db {
  v: number;
  seeded_at: string;
  accounts: AccountRec[];
  sessions: SessionRec[];
  profiles: Record<string, HealthProfile>;
  care: Record<string, CareRec>;
  measurements: (Measurement & { patient_id: string })[];
  prescriptions: PrescriptionRec[];
  visits: VisitRec[];
  tickets: TicketRec[];
  appointments: AppointmentRec[];
  rx: RxRec[];
  notifications: NotificationRec[];
  drafts: Record<string, { payload: unknown; revision: number; updated_at: string }>;
  consents: (Consent & { account_id: string })[];
  staff_notes: { id: string; patient_id: string; author_id: string; body: string; pinned: boolean; created_at: string }[];
  contacts: { at: string; patient_id: string; author_id: string; channel: "in_app" | "phone_note"; body: string }[];
  audit: AuditRec[];
  settings: AdminSettings;
  turns: TurnRec[];
  idem: Record<string, { status: number; body: unknown }>;
  counters: { rx: number; ticket: number };
}
/** Raise when the shape or the fixtures change: old stores are thrown away. */
export const DB_VERSION = 4;

export interface TextStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export class MemoryStorage implements TextStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

const DB_KEY = "pv-mock:db";
const STAMP_KEY = "pv-mock:stamp";
const DAY = 86_400_000;

/** Reads the shared store before every request when another tab changed it, and writes after every change. */
export class DbFile {
  private db: Db | null = null;
  private stamp = "";
  private readonly storage: TextStorage;
  private readonly seed: () => Db;

  constructor(storage: TextStorage, seed: () => Db) {
    this.storage = storage;
    this.seed = seed;
  }

  get(): Db {
    const stamp = this.storage.getItem(STAMP_KEY) ?? "";
    if (this.db && stamp === this.stamp && stamp !== "") return this.db;
    const text = this.storage.getItem(DB_KEY);
    if (text) {
      try {
        const db = JSON.parse(text) as Db;
        // Fixtures are relative to "today": a store from another day is replaced.
        if (db.v === DB_VERSION && Date.now() - Date.parse(db.seeded_at) < DAY) {
          this.db = db;
          this.stamp = stamp;
          return db;
        }
      } catch {
        /* replaced below */
      }
    }
    return this.reset();
  }

  save(): void {
    if (!this.db) return;
    this.stamp = `${Date.now()}:${Math.random()}`;
    try {
      this.storage.setItem(DB_KEY, JSON.stringify(this.db));
      this.storage.setItem(STAMP_KEY, this.stamp);
    } catch {
      // Storage full: keep working in memory.
      this.stamp = this.storage.getItem(STAMP_KEY) ?? "memory";
    }
  }

  reset(keepSessions = false): Db {
    const sessions = keepSessions ? (this.db?.sessions ?? []) : [];
    this.db = this.seed();
    this.db.sessions = sessions.filter((s) => this.db!.accounts.some((a) => a.id === s.account_id));
    this.save();
    return this.db;
  }
}

/** A stable UUID for a fixture name, so links keep working across resets. */
export function fid(name: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  const parts: string[] = [];
  for (let round = 0; round < 4; round++) {
    for (const c of `${round}:${name}`) {
      h1 = Math.imul(h1 ^ c.codePointAt(0)!, 0x01000193);
      h2 = Math.imul(h2 ^ c.codePointAt(0)!, 0x5bd1e995);
    }
    parts.push(((h1 ^ h2) >>> 0).toString(16).padStart(8, "0"));
  }
  const hex = parts.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
