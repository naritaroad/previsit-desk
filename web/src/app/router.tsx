// Routes. Each workspace owns its table in src/pages/<workspace>/routes.ts; this file only adds shells, guards and
// error boundaries. Shells and pages are lazy, so each workspace is its own set of chunks.

import type { ComponentType } from "react";
import { createBrowserRouter, Outlet, ScrollRestoration, type RouteObject } from "react-router";

import { preloadNamespaces, type Namespace } from "@/i18n";
import { adminRoutes } from "@/pages/admin/routes";
import { clinicRoutes } from "@/pages/clinic/routes";
import { patientRoutes } from "@/pages/patient/routes";
import { pharmacyRoutes } from "@/pages/pharmacy/routes";
import { publicRoutes } from "@/pages/public/routes";

import { NotFound, RouteError } from "./errors";
import { FullPageLoading, RequireWorkspace } from "./guards";
import { RouteFocus } from "./route-focus";

function Root() {
  return (
    <>
      <RouteFocus />
      <Outlet />
      <ScrollRestoration />
    </>
  );
}

/** Errors and unknown paths inside a workspace keep its shell. */
function inShell(children: RouteObject[]): RouteObject[] {
  return [{ errorElement: <RouteError />, children: [...children, { path: "*", element: <NotFound />, handle: { title: "page.notFound" } }] }];
}

const shells = {
  public: () => import("@/shells/PublicShell"),
  // The connected shells (counts from the API) live next to the pages that own those queries.
  patient: () => import("@/pages/patient/Shell"),
  clinic: () => import("@/pages/clinic/Shell"),
  pharmacy: () => import("@/pages/pharmacy/Shell"),
  admin: () => import("@/pages/admin/Shell"),
};

function workspace(ws: Namespace, path: string, load: () => Promise<{ default: ComponentType }>, routes: RouteObject[]): RouteObject {
  return {
    path,
    lazy: async () => {
      const [{ default: Shell }] = await Promise.all([load(), preloadNamespaces(ws)]);
      return {
        Component: () => (
          <RequireWorkspace>
            <Shell />
          </RequireWorkspace>
        ),
      };
    },
    errorElement: <RouteError bare />,
    children: inShell(routes),
  };
}

const gallery: RouteObject[] = __KIT_GALLERY__ ? [{ path: "/dev/kit/*", lazy: async () => ({ Component: (await import("@/kit-gallery/Gallery")).default }) }] : [];

export function createRouter() {
  return createBrowserRouter([
    {
      element: <Root />,
      errorElement: <RouteError bare />,
      hydrateFallbackElement: <FullPageLoading />,
      children: [
        ...gallery,
        workspace("patient", "/app", shells.patient, patientRoutes),
        workspace("clinic", "/clinic", shells.clinic, clinicRoutes),
        workspace("pharmacy", "/pharmacy", shells.pharmacy, pharmacyRoutes),
        workspace("admin", "/admin", shells.admin, adminRoutes),
        {
          lazy: async () => {
            const [{ default: Component }] = await Promise.all([shells.public(), preloadNamespaces("public")]);
            return { Component: () => <Component /> };
          },
          errorElement: <RouteError bare />, children: inShell(publicRoutes) },
      ],
    },
  ]);
}
