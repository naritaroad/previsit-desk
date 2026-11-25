import type { RouteObject } from "react-router";

import { page } from "@/pages/page";

/** Routes under /. `handle.title` is a key of shell.json and becomes the document title until the page sets its own. */
export const publicRoutes: RouteObject[] = [
  {
    lazy: page(() => import("./Layout")),
    children: [
      { index: true, handle: { title: "page.public.home" }, lazy: page(() => import("./Home")) },
      { path: "service", handle: { title: "page.public.service" }, lazy: page(() => import("./Service")) },
      { path: "clinicians", handle: { title: "page.public.clinicians" }, lazy: page(() => import("./Clinicians")) },
      { path: "trust", handle: { title: "page.public.trustOverview" }, lazy: page(() => import("./TrustOverview")) },
      { path: "trust/:section", handle: { title: "page.public.trustSection" }, lazy: page(() => import("./TrustSection")) },
      { path: "handbook", handle: { title: "page.public.handbook" }, lazy: page(() => import("./Handbook")) },
      { path: "handbook/:id", handle: { title: "page.public.handbookArticle" }, lazy: page(() => import("./HandbookArticle")) },
      { path: "emergency", handle: { title: "page.public.emergency" }, lazy: page(() => import("./Emergency")) },
      { path: "credits", handle: { title: "page.public.credits" }, lazy: page(() => import("./Credits")) },
      { path: "login", handle: { title: "page.public.login" }, lazy: page(() => import("./Login")) },
      { path: "register", handle: { title: "page.public.register" }, lazy: page(() => import("./Register")) },
      { path: "try", handle: { title: "page.public.try" }, lazy: page(() => import("./Try")) },
      { path: "*", handle: { title: "page.notFound" }, lazy: page(() => import("./NotFound")) },
    ],
  },
];
