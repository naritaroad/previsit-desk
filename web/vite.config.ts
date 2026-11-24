import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the Rust API (or scripts/mock-api.mjs) listens on 8088 (API_PROXY_TARGET overrides
// it). The site and the API share one origin through this proxy; in production the API serves dist/.
const api = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8088";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: api, changeOrigin: false } },
  },
  preview: {
    port: 4173,
    proxy: { "/api": { target: api, changeOrigin: false } },
  },
  build: { outDir: "dist", sourcemap: true },
});
