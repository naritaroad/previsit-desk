import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Locale } from "@/api/types";
import { useTrustFacts } from "@/data";
import { useLocale } from "@/ui";

import { useResumed } from "../lib/live";
import { type DocEntry, loadAll, loadDoc, type TrustDoc } from "./docs";
import { factValue } from "./facts";

export function useFacts() {
  const locale = useLocale();
  const q = useResumed(useTrustFacts());
  const value = useCallback((key: string) => factValue(q.data, key, locale), [q.data, locale]);
  return { value, state: q.data ? ("ready" as const) : q.isError ? ("failed" as const) : ("loading" as const), at: q.dataUpdatedAt };
}

interface Loaded<T> {
  /** Stays on the previous language until the new one is there, so nothing collapses in between. */
  data: T | null;
  locale: Locale | null;
  failed: boolean;
  retry: () => void;
}

function useLoaded<T>(load: (locale: Locale) => Promise<T>, key: string): Loaded<T> {
  const locale = useLocale();
  const [state, setState] = useState<{ key: string; locale: Locale; data: T } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let on = true;
    setFailed(false);
    load(locale).then(
      (data) => on && setState({ key, locale, data }),
      () => on && setFailed(true),
    );
    return () => {
      on = false;
    };
    // `load` is rebuilt on every render; `key` says when it means something else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, locale, attempt]);
  return { data: state?.key === key ? state.data : null, locale: state?.key === key ? state.locale : null, failed, retry: () => setAttempt((n) => n + 1) };
}

export function useDoc(entry: DocEntry): Loaded<TrustDoc> {
  return useLoaded((l) => loadDoc(entry, l), entry.slug);
}
export function useAllDocs(enabled: boolean): Loaded<TrustDoc[]> {
  return useLoaded<TrustDoc[]>((l) => (enabled ? loadAll(l) : Promise.resolve([])), enabled ? "all" : "none");
}

/**
 * Keeps the reading position when the language changes: remembers the section at the top of the screen and how far
 * into it the reader was, and goes back there when the other language is on the page.
 */
export function useKeepPosition(rendered: string) {
  const at = useRef<{ id: string; ratio: number } | null>(null);
  const last = useRef(rendered);

  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      const top = 140;
      let found: { id: string; ratio: number } | null = null;
      for (const el of document.querySelectorAll<HTMLElement>(".prose-section[data-level='2']")) {
        const r = el.getBoundingClientRect();
        if (r.top <= top) found = { id: el.id, ratio: Math.min(1, (top - r.top) / Math.max(1, r.height)) };
      }
      at.current = found;
    };
    const onScroll = () => {
      frame ||= requestAnimationFrame(read);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  useLayoutEffect(() => {
    if (last.current === rendered) return;
    last.current = rendered;
    const pos = at.current;
    const el = pos && document.getElementById(pos.id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + r.top + r.height * pos.ratio - 140 });
  }, [rendered]);
}
