// Who is signed in, and the account's own settings.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { authApi, meApi } from "../api/endpoints.ts";
import type { ClaimInput, GuestInput, LoginInput, MePatch, PasswordInput, Permission, RegisterInput, SessionInfo } from "../api/types.ts";
import { can as canDo, canAny as canAnyDo, homePath } from "../lib/permissions.ts";
import { qk } from "./keys.ts";
import { useData } from "./provider.tsx";
import { editLists, invalidate, removeById, restore } from "./util.ts";

/** Status, the account, and the actions that change who is signed in. */
export function useAuth() {
  const { auth, refresh, signOut } = useData();
  // PATCH /me, preferences and notification counts update the cached copy.
  const cached = useMe();
  const me = auth.me && cached?.id === auth.me.id ? cached : auth.me;
  return {
    ...auth,
    me,
    isSignedIn: auth.status === "authenticated" || auth.status === "offline",
    /** Signed in with a one-time password: show the password form before anything else (the API answers 403). */
    mustChangePassword: me?.must_change_password ?? false,
    home: homePath(me),
    can: (...p: Permission[]) => canDo(me, ...p),
    canAny: (...p: Permission[]) => canAnyDo(me, ...p),
    refresh,
    logout: signOut,
  };
}

/** The signed-in account, or null. */
export function useMe() {
  const { auth } = useData();
  const { data } = useQuery({
    queryKey: qk.me,
    queryFn: ({ signal }) => authApi.me(signal),
    enabled: auth.status === "authenticated",
    staleTime: 60_000,
  });
  return auth.me ? (data ?? auth.me) : null;
}

/** True when the signed-in account has all the given permissions. */
export function useCan(...permissions: Permission[]): boolean {
  return canDo(useMe(), ...permissions);
}

export function useLogin() {
  const { signIn } = useData();
  return useMutation({
    mutationFn: async (input: LoginInput) => {
      const me = await authApi.login(input);
      await signIn(me);
      return me;
    },
  });
}
export function useGuest() {
  const { signIn } = useData();
  return useMutation({
    mutationFn: async (input: GuestInput) => {
      const me = await authApi.guest(input);
      await signIn(me);
      return me;
    },
  });
}
export function useRegister() {
  const { signIn } = useData();
  return useMutation({
    mutationFn: async (input: RegisterInput) => {
      const me = await authApi.register(input);
      await signIn(me);
      return me;
    },
  });
}
/** Guest sandbox → regular account; everything in it stays. */
export function useClaim() {
  const { signIn } = useData();
  return useMutation({
    mutationFn: async (input: ClaimInput) => {
      const me = await authApi.claim(input);
      await signIn(me);
      return me;
    },
  });
}
export function useChangePassword() {
  const { refresh } = useData();
  return useMutation({
    mutationFn: (input: PasswordInput) => authApi.changePassword(input),
    onSuccess: () => refresh(),
  });
}
export function usePersonas() {
  return useQuery({ queryKey: qk.personas, queryFn: ({ signal }) => authApi.personas(signal), staleTime: 3_600_000 });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  const { signIn } = useData();
  return useMutation({
    mutationFn: (patch: MePatch) => meApi.update(patch),
    onSuccess: async (me, patch) => {
      await signIn(me);
      // Server texts (notifications, drug questions) come in the account's language.
      if (patch.locale) await qc.invalidateQueries();
    },
  });
}

export function useSessions() {
  return useQuery({ queryKey: qk.sessions, queryFn: ({ signal }) => meApi.sessions(signal) });
}
export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => meApi.revokeSession(id),
    onMutate: (id) => editLists<SessionInfo>(qc, qk.sessions, removeById(id)),
    onError: (_e, _id, snapshot) => restore(qc, snapshot),
    onSettled: () => invalidate(qc, qk.sessions),
  });
}

/** Saves GET /me/export as a file. */
export function useExport() {
  return useMutation({
    mutationFn: async () => {
      const data = await meApi.export();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `previsit-desk-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  });
}

export function useDeleteAccount() {
  const { cache, refresh } = useData();
  return useMutation({
    mutationFn: () => meApi.remove(),
    onSuccess: async () => {
      await cache.deactivate("logout");
      await refresh();
    },
  });
}
