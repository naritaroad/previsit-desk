import type { RouteObject } from "react-router";

import { page } from "@/pages/page";

/** Routes under /clinic. `handle.title` is a key of shell.json and becomes the document title. */
export const clinicRoutes: RouteObject[] = [
  { index: true, handle: { title: "page.clinic.overview" }, lazy: page(() => import("./Overview")) },
  { path: "worklist", handle: { title: "page.clinic.worklist" }, lazy: page(() => import("./Worklist")) },
  { path: "visits/:id", handle: { title: "page.clinic.visitReview" }, lazy: page(() => import("./VisitReview")) },
  { path: "rx", handle: { title: "page.clinic.rxQueue" }, lazy: page(() => import("./RxQueue")) },
  { path: "rx/:id", handle: { title: "page.clinic.rxReview" }, lazy: page(() => import("./RxReview")) },
  { path: "tickets", handle: { title: "page.clinic.tickets" }, lazy: page(() => import("./Tickets")) },
  { path: "tickets/:id", handle: { title: "page.clinic.ticketThread" }, lazy: page(() => import("./TicketThread")) },
  { path: "patients", handle: { title: "page.clinic.patients" }, lazy: page(() => import("./Patients")) },
  { path: "patients/:id", handle: { title: "page.clinic.patient" }, lazy: page(() => import("./Patient")) },
  { path: "schedule", handle: { title: "page.clinic.schedule" }, lazy: page(() => import("./Schedule")) },
  { path: "oversight", handle: { title: "page.clinic.oversight" }, lazy: page(() => import("./Oversight")) },
  { path: "rules", handle: { title: "page.clinic.rules" }, lazy: page(() => import("./Rules")) },
  { path: "settings", handle: { title: "page.clinic.settings" }, lazy: page(() => import("./Settings")) },
  { path: "notifications", handle: { title: "page.clinic.notifications" }, lazy: page(() => import("./Notifications")) },
];
