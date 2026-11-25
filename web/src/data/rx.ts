// Refill and renewal requests: patient lists, the staff queue, decisions and the pharmacy. The wizard itself is
// useRxWizard (live.ts).

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { rxApi } from "../api/endpoints.ts";
import { ApiError, isStale } from "../api/errors.ts";
import type {
  FormularyItem,
  FormularyParams,
  PersonRef,
  PharmacyAction,
  PharmacyChecks,
  PharmacyInput,
  RefillResult,
  RxBucket,
  RxDecisionInput,
  RxKind,
  RxListParams,
  RxMessage,
  RxQueue,
  RxRequest,
  RxRequestBrief,
} from "../api/types.ts";
import { uuid } from "../lib/ids.ts";
import { useMe } from "./auth.ts";
import { qk } from "./keys.ts";
import { editLists, invalidate, patchById, restore, useIdempotency, usePaged } from "./util.ts";

const LISTS = ["rx", "list"] as const;
const QUEUES = ["rx", "queue"] as const;

/** A newer server version: the detail at once, the lists in the background. */
function putRx(qc: QueryClient, rx: RxRequest): void {
  qc.setQueryData(qk.rxDetail(rx.id), rx);
  invalidate(qc, LISTS, QUEUES, qk.home, qk.medications, qk.clinic, qk.patients);
}
/** The request as it is on the server, when an action was refused because it moved on (409). */
export function staleRx(e: unknown): RxRequest | null {
  return isStale(e) ? (e.current as RxRequest | null) : null;
}
/** Why a refill cannot be sent: the 422 of POST /rx/{id}/submit carries the check's result. */
export function refillRefusal(e: unknown): RefillResult | null {
  if (!(e instanceof ApiError) || e.status !== 422) return null;
  const c = e.current;
  return typeof c === "object" && c !== null && "outcome" in c ? (c as RefillResult) : null;
}
function useOnStale() {
  const qc = useQueryClient();
  return (e: unknown) => {
    const current = staleRx(e);
    if (current) putRx(qc, current);
  };
}

// ------------------------------------------------------------------------------------------------ patient

export function useRxList(params: Omit<RxListParams, "cursor"> = {}) {
  return usePaged<RxRequestBrief>(qk.rxList(params), (cursor, signal) => rxApi.list({ ...params, cursor }, signal));
}
export function useRx(id: string, enabled = true) {
  return useQuery({ queryKey: qk.rxDetail(id), queryFn: ({ signal }) => rxApi.get(id, signal), enabled });
}
/** Starts a draft; go to the wizard with the returned id. */
export function useCreateRx() {
  const qc = useQueryClient();
  const idem = useIdempotency();
  return useMutation({
    mutationFn: (input: { kind: RxKind; prescription_ids: string[] }) => rxApi.create(input, idem.key(input)),
    onSuccess: (rx) => {
      idem.done();
      putRx(qc, rx);
    },
  });
}
export function useCancelRx() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rx: Pick<RxRequest, "id" | "revision">) => rxApi.cancel(rx.id, rx.revision),
    onSuccess: (rx) => putRx(qc, rx),
    onError: useOnStale(),
  });
}
/** Answer a more_info question from the status page (the wizard has its own reply). */
export function useReplyRx(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { revision: number; body: string; answers?: Record<string, unknown> }) => rxApi.reply(id, input),
    onSuccess: (rx) => putRx(qc, rx),
    onError: useOnStale(),
  });
}
/** Message on the request. Shown at once; patients can only use visibility "all". */
export function useRxMessage(id: string) {
  const qc = useQueryClient();
  const me = useMe();
  const idem = useIdempotency();
  const key = qk.rxDetail(id);
  return useMutation({
    mutationFn: (input: { body: string; visibility: "all" | "staff" }) => rxApi.message(id, input, idem.key(input)),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<RxRequest>(key);
      if (before && me) {
        const author: PersonRef = { id: me.id, display_name: me.display_name, role: me.role, title: me.title, avatar: me.avatar };
        const message: RxMessage = { ...input, id: `new:${uuid()}`, author, created_at: new Date().toISOString() };
        qc.setQueryData<RxRequest>(key, { ...before, messages: [...before.messages, message] });
      }
      return before;
    },
    onError: (_e, _v, before) => before && qc.setQueryData(key, before),
    onSuccess: (rx) => {
      idem.done();
      putRx(qc, rx);
    },
  });
}

// ------------------------------------------------------------------------------------------------ staff

/** One bucket of the review queue; `counts` covers every bucket. */
export function useRxQueue(bucket?: RxBucket, q?: string) {
  const query = usePaged<RxRequestBrief, RxQueue>(qk.rxQueue(bucket, q), (cursor, signal) => rxApi.queue({ bucket, q, cursor }, signal), {
    refetchInterval: 60_000, // SLA countdowns and overdue marks move on their own
  });
  return { ...query, counts: query.first?.counts };
}
export function useAssignRx() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, account }: { id: string; account: PersonRef | null }) => rxApi.assign(id, account?.id ?? null),
    onMutate: ({ id, account }) => editLists<RxRequestBrief>(qc, QUEUES, patchById<RxRequestBrief>(id, { assigned_to: account })),
    onError: (_e, _v, snapshot) => restore(qc, snapshot),
    onSuccess: (rx) => putRx(qc, rx),
  });
}
/** The physician's decision on every item. */
export function useDecideRx(id: string) {
  const qc = useQueryClient();
  const idem = useIdempotency();
  return useMutation({
    mutationFn: (input: RxDecisionInput) => rxApi.decide(id, input, idem.key(input)),
    onSuccess: (rx) => {
      idem.done();
      putRx(qc, rx);
    },
    onError: useOnStale(),
  });
}

// ------------------------------------------------------------------------------------------------ pharmacy

export const PHARMACY_CHECKS: readonly (keyof PharmacyChecks)[] = ["identity", "allergy", "interaction", "quantity"];
export function allChecked(checks: Partial<PharmacyChecks>): checks is PharmacyChecks {
  return PHARMACY_CHECKS.every((k) => checks[k] === true);
}
/** Actions that need a written reason. */
export function needsNote(action: PharmacyAction): boolean {
  return action === "return" || action === "ask_physician";
}
export function usePharmacyAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PharmacyInput) => rxApi.pharmacy(id, input),
    onSuccess: (rx) => putRx(qc, rx),
    onError: useOnStale(),
  });
}

// ------------------------------------------------------------------------------------------------ reference data

export function useProtocols() {
  return useQuery({ queryKey: qk.protocols, queryFn: ({ signal }) => rxApi.protocols(signal), staleTime: 3_600_000 });
}
export function useFormulary(params: Omit<FormularyParams, "cursor"> = {}) {
  return usePaged<FormularyItem>(qk.formulary(params), (cursor, signal) => rxApi.formulary({ limit: 100, ...params, cursor }, signal), {
    staleTime: 3_600_000,
  });
}
