// Runs tests/contract.live.test.ts against a throwaway backend: its own PostgreSQL container and a copy of the
// built API, with passwords generated here and never written anywhere. The shared development database, its
// accounts and .env are not touched.
//
//   node scripts/live-contract.mjs            needs Docker and backend/target/debug/previsit-api(.exe)
//   KEEP=1 node scripts/live-contract.mjs     leaves the instance running until Ctrl+C (for a browser check)

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const root = join(web, "..");
const DB_PORT = Number(process.env.LIVE_DB_PORT ?? 5456);
const API_PORT = Number(process.env.LIVE_API_PORT ?? 8098);
const IMAGE = "postgres:18.6-trixie"; // same as compose.yaml
const name = `previsit-live-${process.pid}`;
const secret = () => randomBytes(18).toString("base64url");
const dbPassword = secret();
const accounts = {
  ADMIN_PASSWORD: secret(),
  CLINICIAN_PASSWORD: secret(),
  PHARMACIST_PASSWORD: secret(),
  COORDINATOR_PASSWORD: secret(),
  DEMO_PATIENT_PASSWORD: secret(),
};

const exe = ["previsit-api.exe", "previsit-api"].map((f) => join(root, "backend", "target", "debug", f)).find(existsSync);
if (!exe) {
  console.error("build the API first: cd backend && cargo build");
  process.exit(1);
}
// A copy outside the project: the API looks for .env next to the project's data and must not find it.
const dir = mkdtempSync(join(tmpdir(), "previsit-live-"));
const copy = join(dir, exe.endsWith(".exe") ? "previsit-api.exe" : "previsit-api");
copyFileSync(exe, copy);

let api = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cleanup() {
  api?.kill();
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      spawnSync(process.execPath, ["-e", "setTimeout(()=>{},300)"]);
    }
  }
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

try {
  const run = spawnSync("docker", ["run", "-d", "--rm", "--name", name, "--tmpfs", "/var/lib/postgresql", "-p", `127.0.0.1:${DB_PORT}:5432`, "-e", "POSTGRES_DB=previsit", "-e", "POSTGRES_USER=previsit", "-e", "POSTGRES_PASSWORD", IMAGE], {
    env: { ...process.env, POSTGRES_PASSWORD: dbPassword },
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (run.status !== 0) throw new Error("docker run failed");
  for (let i = 0; i < 60; i++) {
    if (spawnSync("docker", ["exec", name, "pg_isready", "-U", "previsit", "-d", "previsit", "-h", "127.0.0.1"], { stdio: "ignore" }).status === 0) break;
    await sleep(500);
  }
  await sleep(500);

  api = spawn(copy, [], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      ...accounts,
      DATABASE_URL: `postgres://previsit:${dbPassword}@127.0.0.1:${DB_PORT}/previsit`,
      BIND_ADDR: `127.0.0.1:${API_PORT}`,
      DATA_DIR: join(root, "data"),
      WEB_DIR: join(dir, "web"),
      LLM_MODEL: "mock",
      COOKIE_SECURE: "false",
      RATE_MESSAGES_PER_10MIN: "500",
      RATE_VISITS_PER_10MIN: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  for (const s of [api.stdout, api.stderr]) s.on("data", (d) => (log = (log + d).slice(-4000)));
  const base = `http://127.0.0.1:${API_PORT}/api/v2`;
  let ready = false;
  for (let i = 0; i < 80 && !ready && api.exitCode === null; i++) {
    ready = await fetch(`${base}/health`).then((r) => r.ok, () => false);
    if (!ready) await sleep(500);
  }
  if (!ready) {
    console.error(log.replaceAll(dbPassword, "***"));
    throw new Error("the API did not start");
  }
  console.log(`live API on ${base} (throwaway database)`);
  const test = spawnSync(process.execPath, [join(web, "node_modules", "vitest", "vitest.mjs"), "run", "tests/contract.live.test.ts", ...process.argv.slice(2)], {
    cwd: web,
    env: { ...process.env, ...accounts, ADMIN_USERNAME: "naritaroad", CLINICIAN_USERNAME: "dr_demo", API_BASE: base, LIVE_RESET: "1" },
    stdio: "inherit",
  });
  if (process.env.KEEP === "1") {
    console.log("KEEP=1: running until Ctrl+C");
    await new Promise(() => {});
  }
  process.exitCode = test.status ?? 1;
} catch (e) {
  console.error(String(e));
  process.exitCode = 1;
} finally {
  cleanup();
}
