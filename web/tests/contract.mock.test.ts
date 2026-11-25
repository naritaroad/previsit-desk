// The same suite against the mock server: what pages see in `--mode mock` has the shapes of the real backend.

import { contract, type Who } from "./contract.suite.ts";
import { type Mock, mock } from "./helpers.ts";

const SESSION = "pv-mock:session";
let m: Mock;
let mocked: typeof fetch;

contract({
  name: "mock server",
  reset: true,
  logins: {
    physician: ["dr_demo", "any-password"],
    coordinator: ["cm_demo", "any-password"],
    pharmacist: ["rph_demo", "any-password"],
    admin: ["naritaroad", "any-password"],
  },
  start(who) {
    m = mock();
    mocked = globalThis.fetch;
    const tokens = new Map<Who, string | null>();
    // The mock keeps one session per browser; switch it for each person, one request at a time.
    let queue: Promise<unknown> = Promise.resolve();
    globalThis.fetch = (input, init) => {
      const person = who();
      const answer = queue.then(async () => {
        const token = tokens.get(person) ?? null;
        if (token) m.server.storage.setItem(SESSION, token);
        else m.server.storage.removeItem(SESSION);
        const res = await mocked(input, init);
        tokens.set(person, m.server.currentToken());
        return res;
      });
      queue = answer.catch(() => undefined);
      return answer;
    };
  },
  stop() {
    m.stop();
  },
});
