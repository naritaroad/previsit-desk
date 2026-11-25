// Query keys. Everything is keyed by domain first, so an SSE event can invalidate a whole domain. Keys never
// contain the account id: the cache holds one account at a time (see persist.ts).

import type * as T from "../api/types.ts";

export const qk = {
  me: ["me"] as const,
  sessions: ["sessions"] as const,
  personas: ["public", "personas"] as const,
  notifications: ["notifications"] as const,

  home: ["home"] as const,
  profile: ["profile"] as const,
  measurements: (kind?: T.MeasurementKind) => (kind ? (["measurements", kind] as const) : (["measurements"] as const)),
  accessLog: ["access-log"] as const,
  consents: ["consents"] as const,
  medications: ["medications"] as const,

  visits: ["visits"] as const,
  visitList: (p: T.VisitListParams) => ["visits", "list", p] as const,
  visit: (id: string) => ["visits", "detail", id] as const,
  note: (visitId: string) => ["visits", "note", visitId] as const,

  appointments: ["appointments"] as const,
  appointmentList: ["appointments", "list"] as const,
  slots: (p: T.SlotParams) => ["appointments", "slots", p] as const,

  rx: ["rx"] as const,
  rxList: (p: T.RxListParams) => ["rx", "list", p] as const,
  rxDetail: (id: string) => ["rx", "detail", id] as const,
  rxQueue: (bucket?: T.RxBucket, q?: string) => ["rx", "queue", bucket ?? "all", q ?? ""] as const,

  clinic: ["clinic"] as const,
  clinicOverview: ["clinic", "overview"] as const,
  worklist: (p: T.WorklistParams) => ["clinic", "worklist", p] as const,
  tickets: (status: string) => ["clinic", "tickets", status] as const,
  schedule: (date: T.CalendarDate) => ["clinic", "schedule", date] as const,
  patients: ["patients"] as const,
  patientList: (p: T.PatientListParams) => ["patients", "list", p] as const,
  patient: (id: string) => ["patients", "detail", id] as const,
  staff: ["staff"] as const,

  admin: ["admin"] as const,
  adminOverview: (days: number) => ["admin", "overview", days] as const,
  accounts: (p: T.AccountListParams) => ["admin", "accounts", "list", p] as const,
  account: (id: string) => ["admin", "accounts", "detail", id] as const,
  permissions: ["admin", "permissions"] as const,
  settings: ["admin", "settings"] as const,
  models: ["admin", "models"] as const,
  oversight: (p: T.DateRange) => ["admin", "oversight", p] as const,
  runs: (p: T.RunListParams) => ["admin", "runs", "list", p] as const,
  run: (id: string) => ["admin", "runs", "detail", id] as const,
  audit: (p: T.AuditParams) => ["admin", "audit", p] as const,
  rules: ["admin", "rules"] as const,
  adminEval: ["admin", "eval"] as const,

  health: ["public", "health"] as const,
  meta: ["public", "meta"] as const,
  trustFacts: ["public", "trust-facts"] as const,
  pharmacies: ["public", "pharmacies"] as const,
  handbook: ["public", "handbook"] as const,
  handbookSearch: (q: string) => ["public", "handbook", q] as const,
  protocols: ["public", "protocols"] as const,
  formulary: (p: T.FormularyParams) => ["public", "formulary", p] as const,
} as const;

type Key = readonly unknown[];

/** What an account-stream event makes stale. */
export function keysForEvent(e: T.AccountEvent): Key[] {
  switch (e.type) {
    case "notification":
      return [qk.notifications, ...keysForNotification(e.data.kind)];
    case "visit.changed":
      return [qk.visits, qk.home, qk.clinic, qk.patients];
    case "rx.changed":
      return [["rx", "list"], ["rx", "queue"], qk.rxDetail(e.data.id), qk.home, qk.medications, qk.clinic, qk.patients];
    case "queue.changed":
      return e.data.name === "all" ? [[]] : [qk.clinic, ["rx", "queue"], qk.patients];
  }
}
function keysForNotification(kind: T.NotificationKind): Key[] {
  if (kind.startsWith("appt.")) return [qk.appointments, qk.home];
  if (kind === "refill.window_open") return [qk.medications, qk.home];
  if (kind === "ticket.new" || kind === "red_flag") return [qk.clinic];
  return []; // visit.* and rx.* notifications come with their own visit.changed / rx.changed
}
