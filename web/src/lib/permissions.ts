// What the signed-in person may do. The server decides; this only hides what would be refused.

import type { Me, Permission, Role } from "../api/types.ts";

type Holder = Pick<Me, "permissions"> | null | undefined;

/** All of the given permissions. */
export function can(me: Holder, ...permissions: Permission[]): boolean {
  return !!me && permissions.every((p) => me.permissions.includes(p));
}
/** At least one of the given permissions. */
export function canAny(me: Holder, ...permissions: Permission[]): boolean {
  return !!me && permissions.some((p) => me.permissions.includes(p));
}

export type Portal = "public" | "patient" | "clinic" | "pharmacy" | "admin";

const PORTAL_OF: Readonly<Record<Role, Portal>> = {
  patient: "patient",
  physician: "clinic",
  coordinator: "clinic",
  pharmacist: "pharmacy",
  admin: "admin",
};
export const PORTAL_PATH: Readonly<Record<Portal, string>> = {
  public: "/",
  patient: "/app",
  clinic: "/clinic",
  pharmacy: "/pharmacy",
  admin: "/admin",
};

export function portalOf(role: Role): Portal {
  return PORTAL_OF[role];
}
/** Where a person lands after signing in. */
export function homePath(me: Pick<Me, "role"> | null | undefined): string {
  return me ? PORTAL_PATH[PORTAL_OF[me.role]] : PORTAL_PATH.public;
}
/** The workspace a path belongs to. */
export function portalOfPath(pathname: string): Portal {
  for (const portal of ["patient", "clinic", "pharmacy", "admin"] as const) {
    const base = PORTAL_PATH[portal];
    if (pathname === base || pathname.startsWith(`${base}/`)) return portal;
  }
  return "public";
}
/** Whether the signed-in person's role owns the workspace of this path (public paths are open to all). */
export function canEnter(me: Pick<Me, "role"> | null | undefined, pathname: string): boolean {
  const portal = portalOfPath(pathname);
  return portal === "public" || (!!me && PORTAL_OF[me.role] === portal);
}

/** The fixed role -> permission table of the contract (used by mocks and as a reference in tests). */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  patient: ["visit.own", "rx.own", "profile.own", "appt.own"],
  physician: [
    "visit.read",
    "visit.review",
    "note.sign",
    "thread.reply",
    "ticket.handle",
    "patient.read",
    "patient.manage",
    "appt.manage",
    "rx.read",
    "rx.decide",
    "oversight.read",
    "rules.read",
  ],
  coordinator: [
    "visit.read",
    "visit.review",
    "thread.reply",
    "ticket.handle",
    "patient.read",
    "patient.manage",
    "appt.manage",
    "rx.read",
    "oversight.read",
    "rules.read",
  ],
  pharmacist: ["patient.read", "thread.reply", "rx.read", "rx.dispense", "rules.read"],
  admin: ["account.manage", "settings.manage", "audit.read", "oversight.read", "rules.read", "demo.reset"],
};
