// Hooks over the controllers in core/: the live visit, the outbox, drafts, the rx wizard and the leave guard.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { ApiError } from "../api/errors.ts";
import type { VisitDetail } from "../api/types.ts";
import { DraftController, type DraftConflict, type DraftState, type DraftStatus } from "./core/draft.ts";
import { leaveGuard, type LeaveReason } from "./core/leaveGuard.ts";
import type { OutboxItem } from "./core/outbox.ts";
import { RxWizard, type WizardState } from "./core/rxWizard.ts";
import { VisitStream, type VisitStreamState } from "./core/visitStream.ts";
import { qk } from "./keys.ts";
import { useData, useStore } from "./provider.tsx";

/** A controller that lives as long as its key and the component. */
function useController<C extends { start(): void; stop(): void }>(create: () => C, key: string): C {
  const [box, setBox] = useState(() => ({ key, c: create() }));
  let current = box;
  if (box.key !== key) {
    current = { key, c: create() };
    setBox(current);
  }
  const { c } = current;
  useEffect(() => {
    c.start();
    return () => c.stop();
  }, [c]);
  return c;
}

// ------------------------------------------------------------------------------------------------ visit

export interface VisitStreamHandle extends VisitStreamState {
  /** Try loading again (error state) or reconnect now. */
  reconnect: () => void;
  /** Run the last interrupted or failed turn again. */
  retryRun: () => void;
  retrying: boolean;
  retryError: Error | null;
  canRetry: boolean;
}

/** One visit, live, for the patient's chat and the staff's thread. */
export function useVisitStream(visitId: string): VisitStreamHandle {
  const { env, outbox, onSent, busyVisits, auth } = useData();
  const qc = useQueryClient();
  const stream = useController(
    () =>
      new VisitStream({
        visitId,
        env,
        initial: qc.getQueryData<VisitDetail>(qk.visit(visitId)),
        onLoaded: (d) => {
          qc.setQueryData(qk.visit(visitId), d);
          // Reading clears has_unread in lists.
          if (d.visit.has_unread) void qc.invalidateQueries({ queryKey: ["visits", "list"] });
        },
        onIdle: () => {
          busyVisits.delete(visitId);
          void qc.invalidateQueries({ queryKey: ["visits", "list"] });
        },
      }),
    `${auth.me?.id ?? ""}:${visitId}`,
  );
  const state = useStore(stream.state);

  useEffect(() => onSent((id, result) => id === visitId && stream.onSent(result)), [onSent, stream, visitId]);

  // Tell the outbox when a turn is running here, and when it may go on.
  const running = state.run.phase === "running";
  useEffect(() => {
    if (running && state.visit?.mode !== "human") busyVisits.add(visitId);
    else {
      busyVisits.delete(visitId);
      outbox?.poke();
    }
    return () => {
      busyVisits.delete(visitId);
    };
  }, [busyVisits, outbox, running, state.visit?.mode, visitId]);

  // Our own messages that the stream confirmed leave the outbox.
  useEffect(() => {
    if (!outbox) return;
    const ids = state.messages.flatMap((m) => (m.client_id ? [m.client_id] : []));
    if (ids.length) void outbox.confirm(ids);
  }, [outbox, state.messages]);

  const retry = useMutation({ mutationFn: () => stream.retryRun() });
  return {
    ...state,
    reconnect: () => stream.reconnect(),
    retryRun: () => retry.mutate(),
    retrying: retry.isPending,
    retryError: retry.error,
    canRetry: state.run.phase === "interrupted" || state.run.phase === "failed",
  };
}

// ------------------------------------------------------------------------------------------------ outbox

export interface OutboxHandle {
  /** Messages of this visit not yet in the stream, oldest first. Show them after the conversation. */
  items: OutboxItem[];
  send: (content: string) => Promise<string>;
  retry: (clientId: string) => void;
  /** Takes back an unsent message; resolves with its text for the composer. */
  discard: (clientId: string) => Promise<string | null>;
  hasUnsent: boolean;
}
const EMPTY_OUTBOX = { get: () => EMPTY_STATE, subscribe: () => () => undefined };
const EMPTY_STATE = { ready: false, items: [] as OutboxItem[], leader: false };

export function useOutbox(visitId: string, kind: "patient" | "staff" = "patient"): OutboxHandle {
  const { outbox } = useData();
  const { items } = useStore(outbox?.state ?? EMPTY_OUTBOX);
  const mine = useMemo(() => items.filter((i) => i.visit_id === visitId), [items, visitId]);
  return {
    items: mine,
    send: async (content) => {
      if (!outbox) throw new Error("not signed in");
      return outbox.enqueue({ visit_id: visitId, content: content.trim(), kind });
    },
    retry: (clientId) => void outbox?.retry(clientId),
    discard: async (clientId) => outbox?.discard(clientId) ?? null,
    hasUnsent: mine.some((i) => i.status !== "sent"),
  };
}

/** Unsent messages of the whole account, for the shell's "2 messages waiting" line. */
export function useUnsentCount(): { queued: number; failed: number } {
  const { outbox } = useData();
  const { items } = useStore(outbox?.state ?? EMPTY_OUTBOX);
  return {
    queued: items.filter((i) => i.status === "queued" || i.status === "sending").length,
    failed: items.filter((i) => i.status === "failed").length,
  };
}

// ------------------------------------------------------------------------------------------------ drafts

export interface DraftHandle<T> {
  ready: boolean;
  value: T;
  set: (next: T | ((prev: T) => T)) => void;
  status: DraftStatus;
  dirty: boolean;
  savedAt: string | null;
  conflict: DraftConflict<T> | null;
  /** Answer of the merge dialog. */
  resolve: (choice: "mine" | "theirs" | { merged: T }) => void;
  error: ApiError | null;
  flush: () => Promise<void>;
  /** The draft was used or thrown away. */
  clear: () => Promise<void>;
}

/** Autosaved draft. Scope names: visit:<id>:composer, note:<visit id>, rx:<id>:reply, … (letters, digits, : _ - .) */
export function useDraft<T>(scope: string, initial: T, o: { debounceMs?: number } = {}): DraftHandle<T> {
  const { env, auth } = useData();
  const accountId = auth.me?.id ?? "anonymous";
  const controller = useController(
    () => new DraftController<T>({ scope, accountId, initial, env, debounceMs: o.debounceMs }),
    `${accountId}:${scope}`,
  );
  const s: DraftState<T> = useStore(controller.state);
  return {
    ready: s.ready,
    value: s.value,
    status: s.status,
    dirty: s.dirty,
    savedAt: s.savedAt,
    conflict: s.conflict,
    error: s.error,
    set: useCallback((next) => controller.set(next), [controller]),
    resolve: useCallback((choice) => controller.resolve(choice), [controller]),
    flush: useCallback(() => controller.flush(), [controller]),
    clear: useCallback(() => controller.clear(), [controller]),
  };
}

// ------------------------------------------------------------------------------------------------ rx wizard

export interface RxWizardHandle extends WizardState {
  wizard: RxWizard;
}
/** The refill / renewal wizard of one request; call methods on `wizard` (goTo, setAnswer, submit, …). */
export function useRxWizard(id: string): RxWizardHandle {
  const { env, auth } = useData();
  const qc = useQueryClient();
  const accountId = auth.me?.id ?? "anonymous";
  const wizard = useController(
    () =>
      new RxWizard({
        id,
        accountId,
        env,
        onServer: (rx) => {
          const before = qc.getQueryData<{ status: string }>(qk.rxDetail(id));
          qc.setQueryData(qk.rxDetail(id), rx);
          if (before?.status !== rx.status) {
            for (const queryKey of [["rx", "list"], qk.home, qk.medications]) void qc.invalidateQueries({ queryKey });
          }
        },
      }),
    `${accountId}:${id}`,
  );
  return { ...useStore(wizard.state), wizard };
}

// ------------------------------------------------------------------------------------------------ leave guard

/**
 * Warn before closing the tab, and let the shell ask before navigating, while `active`. Use it for work that
 * would really be lost or stay unsent; drafts are saved anyway.
 */
export function useLeaveGuard(id: string, active: boolean, messageKey = "errors:leave.unsaved"): void {
  useEffect(() => (active ? leaveGuard.set({ id, messageKey }) : undefined), [active, id, messageKey]);
}
/** What is unsent or unsaved right now (for useBlocker and for the logout confirmation). */
export function useLeaveReasons(): readonly LeaveReason[] {
  return useStore(leaveGuard.state);
}
