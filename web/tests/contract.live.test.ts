// The contract suite against a running backend. Skipped unless API_BASE is set:
//
//   API_BASE=http://127.0.0.1:8088/api/v2 npx vitest run tests/contract.live.test.ts
//
// It writes data (guest accounts, requests, a note, an account; settings are put back), so use a throwaway
// instance: `node scripts/live-contract.mjs` starts one with its own database and generated passwords.
// Passwords come from the environment under the backend's own names; a role without one is skipped, and nothing
// here prints them.

import { setApiBase } from "../src/api/client.ts";
import { contract, type Who } from "./contract.suite.ts";

const { env } = process;
const realFetch = globalThis.fetch;
const jars = new Map<Who, string>();

contract({
  name: "live backend",
  skip: !env.API_BASE,
  reset: env.LIVE_RESET === "1",
  logins: {
    physician: [env.CLINICIAN_USERNAME || "dr_demo", env.CLINICIAN_PASSWORD],
    coordinator: ["cm_demo", env.COORDINATOR_PASSWORD],
    pharmacist: ["rph_demo", env.PHARMACIST_PASSWORD],
    admin: [env.ADMIN_USERNAME || "naritaroad", env.ADMIN_PASSWORD],
  },
  start(who) {
    setApiBase(env.API_BASE ?? "");
    // One cookie jar per person in front of Node's fetch.
    globalThis.fetch = async (input, init) => {
      const person = who();
      const jar = jars.get(person);
      const headers = new Headers(init?.headers);
      if (jar) headers.set("Cookie", jar);
      const res = await realFetch(input, { ...init, headers });
      for (const c of res.headers.getSetCookie()) if (c.startsWith("pv_session=")) jars.set(person, c.split(";")[0]);
      return res;
    };
  },
  stop() {
    globalThis.fetch = realFetch;
    setApiBase("http://localhost/api/v2");
  },
});
