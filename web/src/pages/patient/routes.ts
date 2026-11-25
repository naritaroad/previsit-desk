import type { RouteObject } from "react-router";

import { page } from "@/pages/page";

/** Routes under /app. `handle.title` is a key of shell.json and becomes the document title. */
export const patientRoutes: RouteObject[] = [
  { index: true, handle: { title: "page.patient.home" }, lazy: page(() => import("./Home")) },
  { path: "visits", handle: { title: "page.patient.visits" }, lazy: page(() => import("./Visits")) },
  { path: "visits/new", handle: { title: "page.patient.visitNew" }, lazy: page(() => import("./VisitNew")) },
  { path: "visits/:id", handle: { title: "page.patient.visit" }, lazy: page(() => import("./Visit")) },
  { path: "visits/:id/summary", handle: { title: "page.patient.visitSummary" }, lazy: page(() => import("./VisitSummary")) },
  { path: "medications", handle: { title: "page.patient.medications" }, lazy: page(() => import("./Medications")) },
  { path: "rx", handle: { title: "page.patient.rxList" }, lazy: page(() => import("./RxList")) },
  { path: "rx/new", handle: { title: "page.patient.rxNew" }, lazy: page(() => import("./RxNew")) },
  { path: "rx/:id", handle: { title: "page.patient.rxDetail" }, lazy: page(() => import("./RxDetail")) },
  { path: "rx/:id/edit", handle: { title: "page.patient.rxWizard" }, lazy: page(() => import("./RxWizard")) },
  { path: "appointments", handle: { title: "page.patient.appointments" }, lazy: page(() => import("./Appointments")) },
  { path: "appointments/book", handle: { title: "page.patient.appointmentBook" }, lazy: page(() => import("./AppointmentBook")) },
  { path: "messages", handle: { title: "page.patient.messages" }, lazy: page(() => import("./Messages")) },
  { path: "messages/:id", handle: { title: "page.patient.messageThread" }, lazy: page(() => import("./MessageThread")) },
  { path: "profile", handle: { title: "page.patient.profile" }, lazy: page(() => import("./Profile")) },
  { path: "profile/measurements", handle: { title: "page.patient.measurements" }, lazy: page(() => import("./Measurements")) },
  { path: "privacy", handle: { title: "page.patient.privacy" }, lazy: page(() => import("./Privacy")) },
  { path: "settings", handle: { title: "page.patient.settings" }, lazy: page(() => import("./Settings")) },
  { path: "notifications", handle: { title: "page.patient.notifications" }, lazy: page(() => import("./Notifications")) },
];
