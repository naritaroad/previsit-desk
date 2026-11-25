// Orchestrates one patient visit: create / resume (GET), send a message and fold the SSE stream
// into state, refill checks, submit and handoff. All server data goes through src/api/client.ts.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { ApiError, api, sendMessage } from "../api/client.ts";
import type { Locale, RefillInput, RefillResult, Ticket, TicketReason } from "../api/types.ts";
import { KEYS, isVisitId, readStorage, writeStorage } from "../lib/storage.ts";
import { initialVisitState, visitReducer, type Failure } from "../state/visitReducer.ts";

/** idle: no visit yet; loading: resuming; ready; missing: the stored visit is gone (404); offline: could not reach the server. */
export type VisitPhase = "idle" | "loading" | "ready" | "missing" | "offline";

function failureOf(e: unknown): Failure {
  if (e instanceof ApiError) {
    if (e.code === "rate_limited") return { code: "rate_limited", message: e.message, retryAfter: e.retryAfter };
    if (e.code === "visit_closed") return { code: "visit_closed", message: e.message };
    if (e.code === "conflict") return { code: "conflict", message: e.message };
    if (e.code === "offline") return { code: "network", message: e.message };
    return { code: "unknown", message: e.message };
  }
  return { code: "unknown", message: e instanceof Error ? e.message : "" };
}

export function useVisit(locale: Locale) {
  const [state, dispatch] = useReducer(visitReducer, initialVisitState);
  const [phase, setPhase] = useState<VisitPhase>(() => (isVisitId(readStorage(KEYS.visitId)) ? "loading" : "idle"));
  const [actionError, setActionError] = useState<Failure | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastTextRef = useRef<string>("");
  const visitIdRef = useRef<string | null>(null);
  visitIdRef.current = state.visit?.id ?? null;

  const load = useCallback(async (id: string, quiet = false) => {
    if (!quiet) setPhase("loading");
    try {
      const detail = await api.getVisit(id);
      dispatch({ type: "loaded", detail });
      writeStorage(KEYS.visitId, id);
      setPhase("ready");
      return true;
    } catch (e) {
      if (quiet) return false;
      if (e instanceof ApiError && e.code === "not_found") {
        writeStorage(KEYS.visitId, null);
        dispatch({ type: "reset" });
        setPhase("missing");
      } else {
        setPhase("offline");
      }
      return false;
    }
  }, []);

  // Resume the stored visit once.
  useEffect(() => {
    const id = readStorage(KEYS.visitId);
    if (isVisitId(id)) void load(id);
    return () => abortRef.current?.abort();
  }, [load]);

  const start = useCallback(async (): Promise<string | null> => {
    setActionError(null);
    try {
      const { visit, messages } = await api.createVisit(locale);
      writeStorage(KEYS.visitId, visit.id);
      dispatch({ type: "created", visit, messages });
      setPhase("ready");
      return visit.id;
    } catch (e) {
      setActionError(failureOf(e));
      return null;
    }
  }, [locale]);

  /** Forget the current visit and open a fresh one (after a red flag, after submit, or on request). */
  const startNew = useCallback(async () => {
    abortRef.current?.abort();
    writeStorage(KEYS.visitId, null);
    dispatch({ type: "reset" });
    return start();
  }, [start]);

  const send = useCallback(
    async (text: string) => {
      const id = visitIdRef.current;
      if (!id) return;
      lastTextRef.current = text;
      dispatch({ type: "patient_sent", localId: `local-${Date.now()}`, content: text, at: new Date().toISOString() });
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await sendMessage(id, text, (envelope) => dispatch({ type: "stream", envelope }), controller.signal);
        // Reconcile with what the server stored (real ids, persisted trace, notice messages).
        await load(id, true);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        dispatch({ type: "send_failed", failure: failureOf(e) });
        if (e instanceof ApiError && e.code === "visit_closed") await load(id, true);
        else if (!(e instanceof ApiError && e.status > 0)) await load(id, true); // network cut mid-stream: the server may have finished
      }
    },
    [load],
  );

  const retry = useCallback(() => {
    if (lastTextRef.current) void send(lastTextRef.current);
  }, [send]);

  const refill = useCallback(
    async (input: RefillInput): Promise<RefillResult> => {
      let id = visitIdRef.current;
      if (!id) id = await start();
      if (!id) throw new ApiError(0, "offline", "no visit");
      const { result } = await api.refillCheck(id, input);
      // Reload for the persisted trace row, the ticket and the stored check record.
      await load(id, true);
      return result;
    },
    [start, load],
  );

  const submit = useCallback(async () => {
    const id = visitIdRef.current;
    if (!id) return false;
    setActionError(null);
    try {
      const { visit, summary } = await api.submit(id);
      dispatch({ type: "submitted", visit, summary });
      await load(id, true);
      return true;
    } catch (e) {
      setActionError(failureOf(e));
      if (e instanceof ApiError && e.code === "visit_closed") await load(id, true);
      return false;
    }
  }, [load]);

  const handoff = useCallback(
    async (note: string, reason: TicketReason = "patient_request"): Promise<Ticket | null> => {
      const id = visitIdRef.current;
      if (!id) return null;
      setActionError(null);
      try {
        const { ticket } = await api.handoff(id, reason, note.trim() || undefined);
        dispatch({ type: "ticket_added", ticket });
        return ticket;
      } catch (e) {
        setActionError(failureOf(e));
        return null;
      }
    },
    [],
  );

  /** Quiet re-read of the visit (no loading state), e.g. after a handoff that may have raised a red flag. */
  const refresh = useCallback(async () => {
    const id = visitIdRef.current;
    if (id) await load(id, true);
  }, [load]);

  const reload = useCallback(() => {
    const id = visitIdRef.current ?? readStorage(KEYS.visitId);
    if (isVisitId(id)) void load(id);
  }, [load]);

  return {
    state,
    phase,
    actionError,
    clearActionError: () => setActionError(null),
    dismissFailure: () => dispatch({ type: "dismiss_failure" }),
    start,
    startNew,
    send,
    retry,
    refill,
    submit,
    handoff,
    reload,
    refresh,
  };
}

export type VisitController = ReturnType<typeof useVisit>;
