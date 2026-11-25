import "@/styles/index.css";

import { startMocks } from "@mocks";
import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";

import { DataProvider } from "@/data/provider";
import { i18nReady, preloadNamespaces } from "@/i18n";
import { Toaster, TooltipProvider } from "@/ui";

import { createRouter } from "./router";
import { SessionProvider } from "./session";

// Copy used by every frame is loaded before the first paint, so nothing flashes keys.
void Promise.all([startMocks(), i18nReady.then(() => preloadNamespaces("shell", "rx"))]).then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Suspense>
        <DataProvider>
          <SessionProvider>
            <TooltipProvider>
              <RouterProvider router={createRouter()} />
              <Toaster />
            </TooltipProvider>
          </SessionProvider>
        </DataProvider>
      </Suspense>
    </StrictMode>,
  );
});
