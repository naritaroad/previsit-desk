// One typed function per endpoint of docs/v2/contract.md, grouped like the contract's sections.

import { call, query, seg, unwrap } from "./client.ts";
import type * as T from "./types.ts";

type Signal = AbortSignal | undefined;
const get = <R>(path: string, signal?: Signal) => call<R>("GET", path, { signal });
const post = <R>(path: string, body: unknown = {}, idempotencyKey?: string) =>
  call<R>("POST", path, { body, idempotencyKey });
const put = <R>(path: string, body: unknown) => call<R>("PUT", path, { body });
const patch = <R>(path: string, body: unknown) => call<R>("PATCH", path, { body });
const del = <R = void>(path: string, body?: unknown) => call<R>("DELETE", path, { body });

const me = (body: unknown) => unwrap<T.Me>(body, "me");
const visit = (body: unknown) => unwrap<T.Visit>(body, "visit");
const rx = (body: unknown) => unwrap<T.RxRequest>(body, "request");
const account = (body: unknown) => unwrap<T.AccountRow>(body, "account");

export const authApi = {
  personas: (signal?: Signal) => get<{ items: T.Persona[] }>("/auth/personas", signal).then((r) => r.items),
  guest: (input: T.GuestInput) => post<unknown>("/auth/guest", input).then(me),
  login: (input: T.LoginInput) => post<unknown>("/auth/login", input).then(me),
  logout: () => post<void>("/auth/logout"),
  /** A visitor without a session gets 401 here; that is an answer, not an expired session. */
  me: (signal?: Signal) => call<unknown>("GET", "/auth/me", { signal, quiet401: true }).then(me),
  claim: (input: T.ClaimInput) => post<unknown>("/auth/claim", input).then(me),
  register: (input: T.RegisterInput) => post<unknown>("/auth/register", input).then(me),
  changePassword: (input: T.PasswordInput) => post<void>("/auth/password", input),
};

export const meApi = {
  sessions: (signal?: Signal) => get<{ items: T.SessionInfo[] }>("/me/sessions", signal).then((r) => r.items),
  revokeSession: (id: string) => del(`/me/sessions/${seg(id)}`),
  update: (body: T.MePatch) => patch<unknown>("/me", body).then(me),
  putPreferences: (changes: Record<string, unknown>, keepalive = false) =>
    call<unknown>("PUT", "/me/preferences", { body: { patch: changes }, keepalive }),
  notifications: (p: T.ListParams = {}, signal?: Signal) =>
    get<T.Page<T.Notification>>(`/me/notifications${query(p)}`, signal),
  readNotifications: (ids?: string[]) => post<unknown>("/me/notifications/read", ids ? { ids } : {}),
  draft: <P>(scope: string, signal?: Signal) =>
    get<unknown>(`/me/drafts/${seg(scope)}`, signal).then((b) => unwrap<T.DraftRecord<P>>(b, "draft")),
  putDraft: <P>(scope: string, payload: P, revision: number, keepalive = false) =>
    call<unknown>("PUT", `/me/drafts/${seg(scope)}`, { body: { payload, revision }, keepalive }).then((b) =>
      unwrap<T.DraftRecord<P>>(b, "draft"),
    ),
  deleteDraft: (scope: string) => del(`/me/drafts/${seg(scope)}`),
  export: () => get<T.ExportDocument>("/me/export"),
  remove: () => del("/me", { confirm: "DELETE" }),
  streamPath: () => "/me/stream",
};

export const patientApi = {
  home: (signal?: Signal) => get<T.PatientHome>("/app/home", signal),
  profile: (signal?: Signal) => get<unknown>("/app/profile", signal).then((b) => unwrap<T.HealthProfile>(b, "profile")),
  putProfile: (body: T.HealthProfileInput) =>
    put<unknown>("/app/profile", body).then((b) => unwrap<T.HealthProfile>(b, "profile")),
  measurements: (p: T.ListParams & { kind?: T.MeasurementKind } = {}, signal?: Signal) =>
    get<T.Page<T.Measurement>>(`/app/measurements${query(p)}`, signal),
  addMeasurement: (body: T.MeasurementInput, key?: string) =>
    post<unknown>("/app/measurements", body, key).then((b) => unwrap<T.Measurement>(b, "measurement")),
  deleteMeasurement: (id: string) => del(`/app/measurements/${seg(id)}`),
  accessLog: (p: T.ListParams = {}, signal?: Signal) => get<T.Page<T.AccessLogEntry>>(`/app/access-log${query(p)}`, signal),
  consents: (signal?: Signal) => get<T.ConsentState>("/app/consents", signal),
  setConsent: (body: { doc: T.ConsentDoc; version: string; granted: boolean }) => post<unknown>("/app/consents", body),
  medications: (signal?: Signal) => get<{ items: T.MedicationCard[] }>("/app/medications", signal).then((r) => r.items),
  addMedication: (body: { name: string; dose_text: string }, key?: string) =>
    post<unknown>("/app/medications", body, key).then((b) => unwrap<T.MedicationCard>(b, "medication")),
};

export const visitsApi = {
  list: (p: T.VisitListParams = {}, signal?: Signal) => get<T.Page<T.Visit>>(`/visits${query(p)}`, signal),
  create: (body: T.CreateVisitInput, key?: string) => post<T.VisitDetail>("/visits", body, key),
  get: (id: string, signal?: Signal) => get<T.VisitDetail>(`/visits/${seg(id)}`, signal),
  update: (id: string, body: { title?: string; pinned?: boolean; archived?: boolean }) =>
    patch<unknown>(`/visits/${seg(id)}`, body).then(visit),
  remove: (id: string) => del(`/visits/${seg(id)}`),
  send: (id: string, body: { content: string; client_id: string }) =>
    post<T.SendMessageResult>(`/visits/${seg(id)}/messages`, body),
  staffSend: (id: string, body: { content: string; client_id: string }) =>
    post<unknown>(`/visits/${seg(id)}/staff-messages`, body).then((b) => ({
      message: unwrap<T.Message>(b, "message"),
      run_id: null,
    })),
  streamPath: (id: string, after: number) => `/visits/${seg(id)}/stream${query({ after })}`,
  retryRun: (id: string) => post<{ run_id?: string | null } | undefined>(`/visits/${seg(id)}/runs/retry`),
  patchSummary: (id: string, revision: number, changes: T.SummaryChanges) =>
    patch<unknown>(`/visits/${seg(id)}/summary`, { revision, changes }).then((b) => unwrap<T.PrevisitSummary>(b, "summary")),
  submit: (id: string, key?: string) => post<{ visit: T.Visit; summary: T.PrevisitSummary }>(`/visits/${seg(id)}/submit`, {}, key),
  handoff: (id: string, body: { reason?: T.TicketReason; note?: string }, key?: string) =>
    post<{ ticket: T.Ticket }>(`/visits/${seg(id)}/handoff`, body, key).then((r) => r.ticket),
  refillCheck: (id: string, body: T.RefillInput) =>
    post<{ result: T.RefillResult }>(`/visits/${seg(id)}/refill-check`, body).then((r) => r.result),
  // Clinic side
  assign: (id: string, account_id: string | null) => post<unknown>(`/visits/${seg(id)}/assign`, { account_id }).then(visit),
  takeover: (id: string) => post<unknown>(`/visits/${seg(id)}/takeover`).then(visit),
  release: (id: string) => post<unknown>(`/visits/${seg(id)}/release`).then(visit),
  note: (id: string, signal?: Signal) =>
    get<unknown>(`/visits/${seg(id)}/note`, signal).then((b) => unwrap<T.ClinicalNote>(b, "note")),
  putNote: (id: string, revision: number, sections: T.ClinicalNoteSections) =>
    put<unknown>(`/visits/${seg(id)}/note`, { revision, sections }).then((b) => unwrap<T.ClinicalNote>(b, "note")),
  signNote: (id: string, revision: number) =>
    post<unknown>(`/visits/${seg(id)}/note/sign`, { revision }).then((b) => unwrap<T.ClinicalNote>(b, "note")),
  addendum: (id: string, body: string, key?: string) =>
    post<unknown>(`/visits/${seg(id)}/note/addendum`, { body }, key).then((b) => unwrap<T.ClinicalNote>(b, "note")),
};

export const appointmentsApi = {
  list: (p: T.ListParams = {}, signal?: Signal) => get<T.Page<T.Appointment>>(`/appointments${query(p)}`, signal),
  slots: (p: T.SlotParams, signal?: Signal) =>
    get<{ items: T.AppointmentSlot[] }>(`/appointments/slots${query(p)}`, signal).then((r) => r.items),
  book: (body: { slot_id: string; reason: string }, key?: string) =>
    post<unknown>("/appointments", body, key).then((b) => unwrap<T.Appointment>(b, "appointment")),
  cancel: (id: string) =>
    post<unknown>(`/appointments/${seg(id)}/cancel`).then((b) => unwrap<T.Appointment>(b, "appointment")),
};

export const rxApi = {
  create: (body: { kind: T.RxKind; prescription_ids: string[] }, key?: string) => post<unknown>("/rx", body, key).then(rx),
  list: (p: T.RxListParams = {}, signal?: Signal) => get<T.Page<T.RxRequestBrief>>(`/rx${query(p)}`, signal),
  get: (id: string, signal?: Signal) => get<unknown>(`/rx/${seg(id)}`, signal).then(rx),
  patch: (id: string, revision: number, body: T.RxPatch, keepalive = false) =>
    call<unknown>("PATCH", `/rx/${seg(id)}`, { body: { revision, ...body }, keepalive }).then(rx),
  evaluate: (id: string) => post<unknown>(`/rx/${seg(id)}/evaluate`).then(rx),
  submit: (id: string, revision: number, consent_version: string, key?: string) =>
    post<unknown>(`/rx/${seg(id)}/submit`, { revision, consent_version }, key).then(rx),
  cancel: (id: string, revision: number) => post<unknown>(`/rx/${seg(id)}/cancel`, { revision }).then(rx),
  reply: (id: string, body: { revision: number; body: string; answers?: Record<string, unknown> }) =>
    post<unknown>(`/rx/${seg(id)}/reply`, body).then(rx),
  message: (id: string, body: { body: string; visibility: "all" | "staff" }, key?: string) =>
    post<unknown>(`/rx/${seg(id)}/messages`, body, key).then(rx),
  queue: (p: T.ListParams & { bucket?: T.RxBucket }, signal?: Signal) => get<T.RxQueue>(`/queue/rx${query(p)}`, signal),
  assign: (id: string, account_id: string | null) => post<unknown>(`/rx/${seg(id)}/assign`, { account_id }).then(rx),
  decide: (id: string, body: T.RxDecisionInput, key?: string) => post<unknown>(`/rx/${seg(id)}/decide`, body, key).then(rx),
  pharmacy: (id: string, body: T.PharmacyInput) => post<unknown>(`/rx/${seg(id)}/pharmacy`, body).then(rx),
  protocols: (signal?: Signal) => get<T.ProtocolSet>("/rx/protocols", signal),
  formulary: (p: T.FormularyParams = {}, signal?: Signal) => get<T.Page<T.FormularyItem>>(`/rx/formulary${query(p)}`, signal),
};

export const clinicApi = {
  overview: (signal?: Signal) => get<T.ClinicOverview>("/clinic/overview", signal),
  worklist: (p: T.WorklistParams = {}, signal?: Signal) => get<T.Worklist>(`/clinic/worklist${query(p)}`, signal),
  tickets: (p: T.ListParams & { status?: "open" | "resolved" | "all" } = {}, signal?: Signal) =>
    get<T.Page<T.Ticket>>(`/clinic/tickets${query(p)}`, signal),
  resolveTicket: (id: string, note: string) =>
    post<unknown>(`/clinic/tickets/${seg(id)}/resolve`, { note }).then((b) => unwrap<T.Ticket>(b, "ticket")),
  patients: (p: T.PatientListParams = {}, signal?: Signal) =>
    get<T.Page<T.PatientRow>>(`/clinic/patients${query(p)}`, signal),
  patient: (id: string, signal?: Signal) => get<T.PatientDetail>(`/clinic/patients/${seg(id)}`, signal),
  updatePatient: (id: string, body: T.PatientPatch) =>
    patch<unknown>(`/clinic/patients/${seg(id)}`, body).then((b) => unwrap<T.PatientRow>(b, "row")),
  addNote: (patientId: string, body: { body: string; pinned: boolean }, key?: string) =>
    post<unknown>(`/clinic/patients/${seg(patientId)}/notes`, body, key).then((b) => unwrap<T.StaffNote>(b, "note")),
  updateNote: (noteId: string, body: { body?: string; pinned?: boolean }) =>
    patch<unknown>(`/clinic/notes/${seg(noteId)}`, body).then((b) => unwrap<T.StaffNote>(b, "note")),
  deleteNote: (noteId: string) => del(`/clinic/notes/${seg(noteId)}`),
  contact: (patientId: string, body: T.ContactInput, key?: string) =>
    post<unknown>(`/clinic/patients/${seg(patientId)}/contact`, body, key),
  schedule: (date: T.CalendarDate, signal?: Signal) => get<T.ClinicSchedule>(`/clinic/schedule${query({ date })}`, signal),
  staff: (signal?: Signal) => get<{ items: T.PersonRef[] }>("/staff", signal).then((r) => r.items),
};

export const adminApi = {
  overview: (days: number, signal?: Signal) => get<T.AdminOverview>(`/admin/overview${query({ days })}`, signal),
  accounts: (p: T.AccountListParams = {}, signal?: Signal) => get<T.Page<T.AccountRow>>(`/admin/accounts${query(p)}`, signal),
  account: (id: string, signal?: Signal) => get<unknown>(`/admin/accounts/${seg(id)}`, signal).then(account),
  createAccount: (body: T.CreateAccountInput, key?: string) => post<T.OneTimePassword>("/admin/accounts", body, key),
  updateAccount: (id: string, body: T.AccountPatch) => patch<unknown>(`/admin/accounts/${seg(id)}`, body).then(account),
  resetPassword: (id: string) => post<T.OneTimePassword>(`/admin/accounts/${seg(id)}/reset-password`),
  revokeSessions: (id: string) => post<unknown>(`/admin/accounts/${seg(id)}/revoke-sessions`),
  permissions: (signal?: Signal) => get<T.PermissionMatrix>("/admin/permissions", signal),
  settings: (signal?: Signal) => get<T.AdminSettings>("/admin/settings", signal),
  putSettings: (body: T.AdminSettings) => put<T.AdminSettings>("/admin/settings", body),
  models: (signal?: Signal) => get<{ items: string[] }>("/admin/models", signal).then((r) => r.items),
  oversight: (p: T.DateRange = {}, signal?: Signal) => get<T.OversightReport>(`/admin/oversight${query(p)}`, signal),
  runs: (p: T.RunListParams = {}, signal?: Signal) => get<T.Page<T.AdminRun>>(`/admin/runs${query(p)}`, signal),
  run: (id: string, signal?: Signal) => get<unknown>(`/admin/runs/${seg(id)}`, signal).then((b) => unwrap<T.AdminRun>(b, "run")),
  audit: (p: T.AuditParams = {}, signal?: Signal) => get<T.Page<T.AuditEntry>>(`/admin/audit${query(p)}`, signal),
  rules: (signal?: Signal) => get<T.AdminRules>("/admin/rules", signal),
  eval: (signal?: Signal) => get<T.AdminEval>("/admin/eval", signal),
  resetDemo: () => post<unknown>("/admin/demo/reset", { confirm: "RESET" }),
};

export const publicApi = {
  health: (signal?: Signal) => get<T.Health>("/health", signal),
  meta: (signal?: Signal) => get<T.Meta>("/meta", signal),
  trustFacts: (signal?: Signal) => get<T.TrustFacts>("/trust/facts", signal),
  pharmacies: (signal?: Signal) => get<{ items: T.Pharmacy[] }>("/pharmacies", signal).then((r) => r.items),
  handbook: (signal?: Signal) => get<{ items: T.HandbookEntry[] }>("/handbook", signal).then((r) => r.items),
  searchHandbook: (q: string, signal?: Signal) =>
    get<{ items: T.HandbookHit[] }>(`/handbook/search${query({ q })}`, signal).then((r) => r.items),
};

/**
 * Every method + path of the contract. tests/mocks.test.ts checks that the mock server answers each one, and
 * that this list matches docs/v2/contract.md.
 */
export const CONTRACT_ROUTES: readonly string[] = [
  "POST /auth/guest",
  "GET /auth/personas",
  "POST /auth/login",
  "POST /auth/logout",
  "GET /auth/me",
  "POST /auth/claim",
  "POST /auth/register",
  "POST /auth/password",
  "GET /me/sessions",
  "DELETE /me/sessions/:id",
  "PATCH /me",
  "PUT /me/preferences",
  "GET /me/notifications",
  "POST /me/notifications/read",
  "GET /me/drafts/:scope",
  "PUT /me/drafts/:scope",
  "DELETE /me/drafts/:scope",
  "GET /me/export",
  "DELETE /me",
  "GET /me/stream",
  "GET /app/home",
  "GET /app/profile",
  "PUT /app/profile",
  "GET /app/measurements",
  "POST /app/measurements",
  "DELETE /app/measurements/:id",
  "GET /app/access-log",
  "GET /app/consents",
  "POST /app/consents",
  "GET /visits",
  "POST /visits",
  "GET /visits/:id",
  "PATCH /visits/:id",
  "DELETE /visits/:id",
  "POST /visits/:id/messages",
  "GET /visits/:id/stream",
  "POST /visits/:id/runs/retry",
  "PATCH /visits/:id/summary",
  "POST /visits/:id/submit",
  "POST /visits/:id/handoff",
  "POST /visits/:id/refill-check",
  "GET /appointments",
  "GET /appointments/slots",
  "POST /appointments",
  "POST /appointments/:id/cancel",
  "GET /pharmacies",
  "GET /handbook",
  "GET /handbook/search",
  "GET /app/medications",
  "POST /app/medications",
  "POST /rx",
  "GET /rx",
  "GET /rx/:id",
  "PATCH /rx/:id",
  "POST /rx/:id/evaluate",
  "POST /rx/:id/submit",
  "POST /rx/:id/cancel",
  "POST /rx/:id/reply",
  "POST /rx/:id/messages",
  "GET /queue/rx",
  "POST /rx/:id/assign",
  "POST /rx/:id/decide",
  "POST /rx/:id/pharmacy",
  "GET /rx/protocols",
  "GET /rx/formulary",
  "GET /clinic/overview",
  "GET /clinic/worklist",
  "POST /visits/:id/assign",
  "POST /visits/:id/takeover",
  "POST /visits/:id/release",
  "POST /visits/:id/staff-messages",
  "GET /visits/:id/note",
  "PUT /visits/:id/note",
  "POST /visits/:id/note/sign",
  "POST /visits/:id/note/addendum",
  "GET /clinic/tickets",
  "POST /clinic/tickets/:id/resolve",
  "GET /clinic/patients",
  "GET /clinic/patients/:id",
  "PATCH /clinic/patients/:id",
  "POST /clinic/patients/:id/notes",
  "PATCH /clinic/notes/:id",
  "DELETE /clinic/notes/:id",
  "POST /clinic/patients/:id/contact",
  "GET /clinic/schedule",
  "GET /staff",
  "GET /admin/overview",
  "GET /admin/accounts",
  "POST /admin/accounts",
  "GET /admin/accounts/:id",
  "PATCH /admin/accounts/:id",
  "POST /admin/accounts/:id/reset-password",
  "POST /admin/accounts/:id/revoke-sessions",
  "GET /admin/permissions",
  "GET /admin/settings",
  "PUT /admin/settings",
  "GET /admin/models",
  "GET /admin/oversight",
  "GET /admin/runs",
  "GET /admin/runs/:id",
  "GET /admin/audit",
  "GET /admin/rules",
  "GET /admin/eval",
  "POST /admin/demo/reset",
  "GET /health",
  "GET /meta",
  "GET /trust/facts",
];
