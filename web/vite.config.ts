import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the Rust API listens on 8088 (API_PROXY_TARGET overrides it). The site and the API
// share one origin through this proxy; in production the API serves dist/.
const api = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8088";
const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// `vite --mode mock` (npm run dev:mock) and `vite build --mode mock`: `@mocks` resolves to the mock server
// entry in src/mocks/start.ts; every other mode gets a no-op, so no mock code or data can reach dist/.
const MOCK_ENTRY = path("./src/mocks/start.ts");
const NO_MOCKS = path("./src/app/no-mocks.ts");

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^@mocks$/, replacement: mode === "mock" && existsSync(MOCK_ENTRY) ? MOCK_ENTRY : NO_MOCKS },
      { find: /^@\//, replacement: `${path("./src")}/` },
    ],
  },
  define: {
    // The component gallery (/dev/kit) exists in `vite dev` and in mock builds only.
    __KIT_GALLERY__: JSON.stringify(mode !== "production"),
  },
  server: {
    port: Number(process.env.PORT ?? 5173),
    proxy: mode === "mock" ? undefined : { "/api": { target: api, changeOrigin: false } },
  },
  preview: {
    port: 4173,
    proxy: { "/api": { target: api, changeOrigin: false } },
  },
  build: {
    outDir: "dist",
    // No source maps in production: they would ship inside the image next to dist/.
    sourcemap: false,
    // Small woff2 subsets stay files; inlining them as data: would put glyphs nobody needs in the CSS.
    assetsInlineLimit: (file: string) => (/\.woff2?$/.test(file) ? false : undefined),
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Pages are lazy already; these groups keep shared vendor code out of the entry and stable across builds.
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/, priority: 30 },
            { name: "charts", test: /node_modules[\\/](recharts|d3-[a-z]+|victory-vendor|@reduxjs|redux|redux-thunk|react-redux|immer|reselect|es-toolkit|decimal\.js-light|eventemitter3)[\\/]/, priority: 25 },
            { name: "radix", test: /node_modules[\\/](@radix-ui|radix-ui|@floating-ui|react-remove-scroll|react-remove-scroll-bar|aria-hidden)[\\/]/, priority: 20 },
            { name: "i18n", test: /node_modules[\\/](i18next|react-i18next|i18next-browser-languagedetector)[\\/]/, priority: 20 },
            { name: "query", test: /node_modules[\\/]@tanstack[\\/]/, priority: 20 },
          ],
        },
      },
    },
  },
}));
