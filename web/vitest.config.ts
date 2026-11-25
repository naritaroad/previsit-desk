import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@mocks$/, replacement: path("./src/mocks/start.ts") },
      { find: /^@\//, replacement: `${path("./src")}/` },
    ],
  },
  // The mock server reads the project's rule files.
  server: { fs: { allow: [path("."), path("../data")] } },
  test: {
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "http://localhost/" } },
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
    restoreMocks: true,
    // Fixtures read "now"; a fixed zone keeps date texts the same on every machine.
    env: { TZ: "Asia/Taipei" },
    testTimeout: 15_000,
  },
});
