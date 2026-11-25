// GET /meta once per page load: message limit, retention, model names, last eval summary.

import { useEffect, useState } from "react";

import { api } from "../api/client.ts";
import type { Meta } from "../api/types.ts";

/** Used until /meta answers (or when it cannot be reached); the server enforces the real limit. */
export const FALLBACK_MAX_CHARS = 800;

export function useMeta() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api.meta(controller.signal).then(
      (m) => {
        setMeta(m);
        setFailed(false);
      },
      (e: unknown) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [attempt]);

  return { meta, failed, retry: () => setAttempt((n) => n + 1), maxChars: meta?.max_message_chars ?? FALLBACK_MAX_CHARS };
}
