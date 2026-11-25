import type { RouteObject } from "react-router";

import { page } from "@/pages/page";

/** Routes under /pharmacy. `handle.title` is a key of shell.json and becomes the document title. */
export const pharmacyRoutes: RouteObject[] = [
  { index: true, handle: { title: "page.pharmacy.queue" }, lazy: page(() => import("./Queue")) },
  { path: "queue/:stage", handle: { title: "page.pharmacy.queue" }, lazy: page(() => import("./Queue")) },
  { path: "rx/:id", handle: { title: "page.pharmacy.rxDispense" }, lazy: page(() => import("./RxDispense")) },
  { path: "patients/:id", handle: { title: "page.pharmacy.patient" }, lazy: page(() => import("./Patient")) },
  { path: "history", handle: { title: "page.pharmacy.history" }, lazy: page(() => import("./History")) },
  { path: "formulary", handle: { title: "page.pharmacy.formulary" }, lazy: page(() => import("./Formulary")) },
  { path: "rules", handle: { title: "page.pharmacy.rules" }, lazy: page(() => import("./Rules")) },
  { path: "settings", handle: { title: "page.pharmacy.settings" }, lazy: page(() => import("./Settings")) },
  { path: "notifications", handle: { title: "page.pharmacy.notifications" }, lazy: page(() => import("./Notifications")) },
];
