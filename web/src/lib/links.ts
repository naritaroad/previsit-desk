// Path builders (contract §9) and guards for links that come from the server.

import type { NotificationKind, Role, WorkItem } from "../api/types.ts";
import { portalOf } from "./permissions.ts";

const id = encodeURIComponent;

export const paths = {
  patient: {
    home: () => "/app",
    visits: () => "/app/visits",
    visitNew: (appointmentId?: string) => `/app/visits/new${appointmentId ? `?appointment=${id(appointmentId)}` : ""}`,
    visit: (visitId: string) => `/app/visits/${id(visitId)}`,
    visitSummary: (visitId: string) => `/app/visits/${id(visitId)}/summary`,
    medications: () => "/app/medications",
    rxList: () => "/app/rx",
    rxNew: (kind?: "refill" | "renewal") => `/app/rx/new${kind ? `?kind=${kind}` : ""}`,
    rx: (rxId: string) => `/app/rx/${id(rxId)}`,
    rxEdit: (rxId: string) => `/app/rx/${id(rxId)}/edit`,
    appointments: () => "/app/appointments",
    appointmentBook: () => "/app/appointments/book",
    messages: () => "/app/messages",
    messageThread: (visitId: string) => `/app/messages/${id(visitId)}`,
    profile: () => "/app/profile",
    measurements: () => "/app/profile/measurements",
    privacy: () => "/app/privacy",
  },
  clinic: {
    home: () => "/clinic",
    worklist: () => "/clinic/worklist",
    visit: (visitId: string) => `/clinic/visits/${id(visitId)}`,
    rxQueue: () => "/clinic/rx",
    rx: (rxId: string) => `/clinic/rx/${id(rxId)}`,
    patients: () => "/clinic/patients",
    patient: (patientId: string) => `/clinic/patients/${id(patientId)}`,
    tickets: () => "/clinic/tickets",
    ticket: (ticketId: string) => `/clinic/tickets/${id(ticketId)}`,
    schedule: () => "/clinic/schedule",
  },
  pharmacy: {
    home: () => "/pharmacy",
    queue: (stage: string) => `/pharmacy/queue/${id(stage)}`,
    rx: (rxId: string) => `/pharmacy/rx/${id(rxId)}`,
    patient: (patientId: string) => `/pharmacy/patients/${id(patientId)}`,
  },
  admin: {
    home: () => "/admin",
    accounts: () => "/admin/accounts",
    account: (accountId: string) => `/admin/accounts/${id(accountId)}`,
    runs: () => "/admin/runs",
    run: (runId: string) => `/admin/runs/${id(runId)}`,
  },
  login: (next?: string) => (next && next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login"),
  trust: () => "/trust",
} as const;

/** The detail page of a visit or an rx request in the reader's own workspace. */
export function visitPath(role: Role, visitId: string): string {
  return portalOf(role) === "patient" ? paths.patient.visit(visitId) : paths.clinic.visit(visitId);
}
export function rxPath(role: Role, rxId: string): string {
  const portal = portalOf(role);
  if (portal === "patient") return paths.patient.rx(rxId);
  return portal === "pharmacy" ? paths.pharmacy.rx(rxId) : paths.clinic.rx(rxId);
}

/** Same-origin absolute path only: "//host", "https:", "javascript:" and backslash tricks are refused. */
export function isInternalLink(link: string | null | undefined): link is string {
  return typeof link === "string" && /^\/(?![/\\])/.test(link) && ![...link].some((c) => c < " " || c === "\\");
}
/** `?next=` after signing in: an internal path, or the fallback. */
export function safeNext(next: string | null | undefined, fallback: string): string {
  return isInternalLink(next) && !next.startsWith("/login") ? next : fallback;
}
/** A server link if it is internal, else null (show the item without a link). */
export function internalLink(link: string | null | undefined): string | null {
  return isInternalLink(link) ? link : null;
}
/** Only http(s) source links are rendered as links. */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export type WorkItemIconName = "visit" | "rx" | "ticket";
export function workItemIcon(item: Pick<WorkItem, "type">): WorkItemIconName {
  return item.type;
}

/** Group of a notification kind, for icons and filters. */
export function notificationGroup(kind: NotificationKind | (string & {})): "visit" | "rx" | "appointment" | "ticket" | "emergency" | "other" {
  if (kind === "red_flag") return "emergency";
  if (kind.startsWith("visit.")) return "visit";
  if (kind.startsWith("rx.") || kind.startsWith("refill.")) return "rx";
  if (kind.startsWith("appt.")) return "appointment";
  if (kind.startsWith("ticket.")) return "ticket";
  return "other";
}
