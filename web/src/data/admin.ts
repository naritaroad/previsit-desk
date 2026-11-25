// Admin workspace. Nothing here is written to IndexedDB (see shouldPersist).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminApi } from "../api/endpoints.ts";
import { isStale } from "../api/errors.ts";
import type {
  AccountListParams,
  AccountPatch,
  AccountRow,
  AdminRun,
  AdminSettings,
  AuditEntry,
  AuditParams,
  CreateAccountInput,
  DateRange,
  RunListParams,
} from "../api/types.ts";
import { qk } from "./keys.ts";
import { editLists, invalidate, patchById, restore, useIdempotency, usePaged } from "./util.ts";

const ACCOUNTS = ["admin", "accounts"] as const;
const HOUR = 3_600_000;

export function useAdminOverview(days = 14) {
  return useQuery({ queryKey: qk.adminOverview(days), queryFn: ({ signal }) => adminApi.overview(days, signal), refetchInterval: 60_000 });
}

export function useAccounts(params: Omit<AccountListParams, "cursor"> = {}) {
  return usePaged<AccountRow>(qk.accounts(params), (cursor, signal) => adminApi.accounts({ ...params, cursor }, signal));
}
export function useAccount(id: string) {
  return useQuery({ queryKey: qk.account(id), queryFn: ({ signal }) => adminApi.account(id, signal) });
}
/** The answer holds a one-time password: show it once, then call reset() on the mutation. */
export function useCreateAccount() {
  const qc = useQueryClient();
  const idem = useIdempotency();
  return useMutation({
    mutationFn: (input: CreateAccountInput) => adminApi.createAccount(input, idem.key(input)),
    onSuccess: () => {
      idem.done();
      invalidate(qc, ACCOUNTS);
    },
    gcTime: 0,
  });
}
export function useUpdateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: AccountPatch & { id: string }) => adminApi.updateAccount(id, patch),
    onMutate: ({ id, ...patch }) => editLists<AccountRow>(qc, ["admin", "accounts", "list"], patchById<AccountRow>(id, patch)),
    onError: (_e, _v, snapshot) => restore(qc, snapshot),
    onSuccess: (row) => qc.setQueryData(qk.account(row.id), row),
    onSettled: () => invalidate(qc, ACCOUNTS),
  });
}
export function useResetPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminApi.resetPassword(id),
    onSuccess: () => invalidate(qc, ACCOUNTS),
    gcTime: 0,
  });
}
export function useRevokeAccountSessions() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => adminApi.revokeSessions(id), onSuccess: () => invalidate(qc, ACCOUNTS) });
}

export function usePermissionMatrix() {
  return useQuery({ queryKey: qk.permissions, queryFn: ({ signal }) => adminApi.permissions(signal), staleTime: HOUR });
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: ({ signal }) => adminApi.settings(signal) });
}
/** Takes effect at once. A 409 puts the newer settings in the cache; staleSettings(error) has them too. */
export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: AdminSettings) => adminApi.putSettings(settings),
    onSuccess: (settings) => {
      qc.setQueryData(qk.settings, settings);
      invalidate(qc, ["admin", "overview"], qk.meta);
    },
    onError: (e) => {
      const current = staleSettings(e);
      if (current) qc.setQueryData(qk.settings, current);
    },
  });
}
export function staleSettings(e: unknown): AdminSettings | null {
  return isStale(e) ? (e.current as AdminSettings | null) : null;
}
export function useModels() {
  return useQuery({ queryKey: qk.models, queryFn: ({ signal }) => adminApi.models(signal), staleTime: HOUR });
}

export function useOversight(range: DateRange = {}) {
  return useQuery({ queryKey: qk.oversight(range), queryFn: ({ signal }) => adminApi.oversight(range, signal), placeholderData: (p) => p });
}
export function useRuns(params: Omit<RunListParams, "cursor"> = {}) {
  return usePaged<AdminRun>(qk.runs(params), (cursor, signal) => adminApi.runs({ ...params, cursor }, signal));
}
export function useRun(id: string) {
  return useQuery({ queryKey: qk.run(id), queryFn: ({ signal }) => adminApi.run(id, signal) });
}
export function useAudit(params: Omit<AuditParams, "cursor"> = {}) {
  return usePaged<AuditEntry>(qk.audit(params), (cursor, signal) => adminApi.audit({ ...params, cursor }, signal));
}
export function useRules() {
  return useQuery({ queryKey: qk.rules, queryFn: ({ signal }) => adminApi.rules(signal), staleTime: HOUR });
}
export function useAdminEval() {
  return useQuery({ queryKey: qk.adminEval, queryFn: ({ signal }) => adminApi.eval(signal), staleTime: HOUR });
}
export function useResetDemo() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => adminApi.resetDemo(), onSuccess: () => qc.invalidateQueries() });
}
