import { configure } from "@testing-library/react";
import { afterEach } from "vitest";

import { setApiBase } from "../src/api/client.ts";
import { setDefaultKV } from "../src/data/core/kv.ts";

// Node's fetch needs absolute URLs; the mock server answers any origin.
setApiBase("http://localhost/api/v2");

// Generous: the suite also runs next to builds on a busy machine.
configure({ asyncUtilTimeout: 6000 });

afterEach(() => {
  setDefaultKV(null);
  localStorage.clear();
  sessionStorage.clear();
});
