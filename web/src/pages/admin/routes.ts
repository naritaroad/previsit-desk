import type { RouteObject } from "react-router";

import { page } from "@/pages/page";

/** Routes under /admin. `handle.title` is a key of shell.json and becomes the document title. */
export const adminRoutes: RouteObject[] = [
  { index: true, handle: { title: "page.admin.overview" }, lazy: page(() => import("./Overview")) },
  { path: "accounts", handle: { title: "page.admin.accounts" }, lazy: page(() => import("./Accounts")) },
  { path: "accounts/:id", handle: { title: "page.admin.account" }, lazy: page(() => import("./Account")) },
  { path: "permissions", handle: { title: "page.admin.permissions" }, lazy: page(() => import("./Permissions")) },
  { path: "ai", handle: { title: "page.admin.aiSettings" }, lazy: page(() => import("./AiSettings")) },
  { path: "oversight", handle: { title: "page.admin.oversight" }, lazy: page(() => import("./Oversight")) },
  { path: "runs", handle: { title: "page.admin.runs" }, lazy: page(() => import("./Runs")) },
  { path: "runs/:id", handle: { title: "page.admin.run" }, lazy: page(() => import("./Run")) },
  { path: "audit", handle: { title: "page.admin.audit" }, lazy: page(() => import("./Audit")) },
  { path: "rules", handle: { title: "page.admin.rules" }, lazy: page(() => import("./Rules")) },
  { path: "eval", handle: { title: "page.admin.eval" }, lazy: page(() => import("./Eval")) },
  { path: "data", handle: { title: "page.admin.data" }, lazy: page(() => import("./Data")) },
  { path: "settings", handle: { title: "page.admin.settings" }, lazy: page(() => import("./Settings")) },
  { path: "notifications", handle: { title: "page.admin.notifications" }, lazy: page(() => import("./Notifications")) },
];
