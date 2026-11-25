// Visits: lists and actions. The conversation itself is useVisitStream (live.ts).

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { visitsApi } from "../api/endpoints.ts";
import { isStale } from "../api/errors.ts";
import type {
  ClinicalNote,
  ClinicalNoteSections,
  CreateVisitInput,
  NoteSection,
  PersonRef,
  PrevisitSummary,
  RefillInput,
  SummaryChanges,
  TicketReason,
  Visit,
  VisitDetail,
  VisitListParams,
} from "../api/types.ts";
import { applySummaryChanges } from "../lib/intake.ts";
import { useDraft } from "./live.ts";
import { qk } from "./keys.ts";
import { editLists, invalidate, patchById, removeById, restore, useIdempotency, usePaged } from "./util.ts";

const LISTS = ["visits", "list"] as const;

/** Pinned first, then by last activity: the order the server uses, kept during optimistic edits. */
export function sortVisits(items: Visit[]): Visit[] {
  return [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.last_activity_at.localeCompare(a.last_activity_at));
}

export function useVisits(params: Omit<VisitListParams, "cursor"> = {}) {
  return usePaged<Visit>(qk.visitList(params), (cursor, signal) => visitsApi.list({ ...params, cursor }, signal));
}

/** The stored detail without a stream (review desk header, print view). */
export function useVisitDetail(id: string, enabled = true) {
  return useQuery({ queryKey: qk.visit(id), queryFn: ({ signal }) => visitsApi.get(id, signal), enabled });
}

export function useCreateVisit() {
  const qc = useQueryClient();
  const idem = useIdempotency();
  return useMutation({
    mutationFn: (input: CreateVisitInput = {}) => visitsApi.create(input, idem.key(input)),
    onSuccess: (detail) => {
      idem.done();
      qc.setQueryData(qk.visit(detail.visit.id), detail);
      invalidate(qc, LISTS, qk.home, qk.appointments);
    },
  });
}

function putVisit(qc: QueryClient, visit: Visit): void {
  qc.setQueryData<VisitDetail>(qk.visit(visit.id), (d) => (d ? { ...d, visit } : d));
}

/** Rename, pin, archive. Archived visits leave the list at once. */
export function useUpdateVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; title?: string; pinned?: boolean; archived?: boolean }) => visitsApi.update(id, patch),
    onMutate: ({ id, ...patch }) =>
      editLists<Visit>(qc, LISTS, (items) => {
        const next = patchById<Visit>(id, patch)(items);
        return sortVisits(patch.archived === undefined ? next : removeById<Visit>(id)(next));
      }),
    onError: (_e, _v, snapshot) => restore(qc, snapshot),
    onSuccess: (visit) => putVisit(qc, visit),
    onSettled: () => invalidate(qc, LISTS, qk.home),
  });
}

export function useDeleteVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => visitsApi.remove(id),
    onMutate: (id) => editLists<Visit>(qc, LISTS, removeById(id)),
    onError: (_e, _id, snapshot) => restore(qc, snapshot),
    onSuccess: (_r, id) => qc.removeQueries({ queryKey: qk.visit(id) }),
    onSettled: () => invalidate(qc, LISTS, qk.home),
  });
}

/** Patient edits the summary before sending. A 409 carries the newer summary: read it with staleSummary(error). */
export function usePatchSummary(visitId: string) {
  const qc = useQueryClient();
  const key = qk.visit(visitId);
  return useMutation({
    mutationFn: ({ revision, changes }: { revision: number; changes: SummaryChanges }) => visitsApi.patchSummary(visitId, revision, changes),
    onMutate: async ({ changes }) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<VisitDetail>(key);
      if (before?.summary) qc.setQueryData<VisitDetail>(key, { ...before, summary: applySummaryChanges(before.summary, changes) });
      return before;
    },
    onSuccess: (summary) => qc.setQueryData<VisitDetail>(key, (d) => (d ? { ...d, summary } : d)),
    onError: (e, _v, before) => {
      const current = staleSummary(e);
      if (before) qc.setQueryData<VisitDetail>(key, current ? { ...before, summary: current } : before);
    },
  });
}
export function staleSummary(e: unknown): PrevisitSummary | null {
  return isStale(e) ? (e.current as PrevisitSummary | null) : null;
}

export function useSubmitVisit(visitId: string) {
  const qc = useQueryClient();
  const idem = useIdempotency();
  return useMutation({
    mutationFn: () => visitsApi.submit(visitId, idem.key(visitId)),
    onSuccess: ({ visit, summary }) => {
      qc.setQueryData<VisitDetail>(qk.visit(visitId), (d) => (d ? { ...d, visit, summary } : d));
      invalidate(qc, LISTS, qk.home, qk.appointments);
    },
  });
}
/** "Ask the clinic to contact me". */
export function useHandoff(visitId: string) {
  const qc = useQueryClient();
  const idem = useIdempotency();
  return useMutation({
    mutationFn: (input: { reason?: TicketReason; note?: string }) => visitsApi.handoff(visitId, input, idem.key(input)),
    onSuccess: (ticket) => {
      idem.done();
      qc.setQueryData<VisitDetail>(qk.visit(visitId), (d) => (d ? { ...d, tickets: [...d.tickets.filter((t) => t.id !== ticket.id), ticket] } : d));
    },
  });
}
export function useRefillCheck(visitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RefillInput) => visitsApi.refillCheck(visitId, input),
    onSuccess: () => invalidate(qc, qk.visit(visitId)),
  });
}

// ------------------------------------------------------------------------------------------ staff actions

const STAFF_KEYS = [LISTS, qk.clinic, qk.patients] as const;

export function useAssignVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, account }: { id: string; account: PersonRef | null }) => visitsApi.assign(id, account?.id ?? null),
    onMutate: ({ id, account }) => editLists<Visit>(qc, LISTS, patchById<Visit>(id, { assigned_to: account })),
    onError: (_e, _v, snapshot) => restore(qc, snapshot),
    onSuccess: (visit) => putVisit(qc, visit),
    onSettled: () => invalidate(qc, ...STAFF_KEYS),
  });
}
/** Take over the conversation (the assistant pauses), or hand it back. */
export function useTakeover(visitId: string) {
  const qc = useQueryClient();
  const settled = {
    onSuccess: (visit: Visit) => putVisit(qc, visit),
    onSettled: () => invalidate(qc, ...STAFF_KEYS),
  };
  return {
    takeover: useMutation({ mutationFn: () => visitsApi.takeover(visitId), ...settled }),
    release: useMutation({ mutationFn: () => visitsApi.release(visitId), ...settled }),
  };
}

// ------------------------------------------------------------------------------------------ clinical note

export function useNote(visitId: string, enabled = true) {
  return useQuery({ queryKey: qk.note(visitId), queryFn: ({ signal }) => visitsApi.note(visitId, signal), enabled, staleTime: 0 });
}

interface NoteDraft {
  sections: ClinicalNoteSections;
  /** Note revision the text was written against. */
  base: number;
}
export interface NoteEditor {
  note: ClinicalNote | undefined;
  loading: boolean;
  error: Error | null;
  /** What the editor shows: unsaved text if there is any, else the stored note. */
  sections: ClinicalNoteSections | undefined;
  set: (section: NoteSection, text: string) => void;
  edited: boolean;
  /** Autosave of the unsaved text (survives reload, other tabs and devices). */
  autosave: ReturnType<typeof useDraft<NoteDraft | null>>;
  /** Store a new note version; resolves with it. */
  save: () => Promise<ClinicalNote | null>;
  saving: boolean;
  /** Save what is unsaved, then sign. Locks the note, marks the visit reviewed, notifies the patient. */
  sign: () => Promise<ClinicalNote | null>;
  signing: boolean;
  addendum: (body: string) => Promise<ClinicalNote>;
  addingAddendum: boolean;
  /** Someone stored another version meanwhile. */
  conflict: { mine: ClinicalNoteSections; theirs: ClinicalNote } | null;
  resolve: (choice: "mine" | "theirs" | { merged: ClinicalNoteSections }) => void;
  discard: () => Promise<void>;
}

/** Everything the review desk needs for A, P and the message to the patient. */
export function useNoteEditor(visitId: string): NoteEditor {
  const qc = useQueryClient();
  const query = useNote(visitId);
  const note = query.data;
  const draft = useDraft<NoteDraft | null>(`note:${visitId}`, null);
  const idem = useIdempotency();
  const mine = note?.status === "signed" ? null : draft.value;
  const put = (n: ClinicalNote) => qc.setQueryData(qk.note(visitId), n);
  const onStale = (e: unknown) => {
    if (isStale(e) && e.current) put(e.current as ClinicalNote);
  };

  const save = useMutation({
    mutationFn: (d: NoteDraft) => visitsApi.putNote(visitId, d.base, d.sections),
    onSuccess: async (n) => {
      put(n);
      await draft.clear();
    },
    onError: onStale,
  });
  const sign = useMutation({
    mutationFn: (revision: number) => visitsApi.signNote(visitId, revision),
    onSuccess: (n) => {
      put(n);
      void draft.clear();
      invalidate(qc, qk.visit(visitId), ...STAFF_KEYS);
    },
    onError: onStale,
  });
  const addendum = useMutation({
    mutationFn: (body: string) => visitsApi.addendum(visitId, body, idem.key(body)),
    onSuccess: (n) => {
      idem.done();
      put(n);
    },
  });

  const stale = !!mine && !!note && mine.base !== note.revision;
  return {
    note,
    loading: query.isPending || !draft.ready,
    error: query.error,
    sections: mine?.sections ?? note?.sections,
    set: (section, text) => {
      if (!note || note.status === "signed") return;
      draft.set((d) => ({ sections: { ...(d?.sections ?? note.sections), [section]: text }, base: d?.base ?? note.revision }));
    },
    edited: mine !== null,
    autosave: draft,
    save: async () => (mine ? save.mutateAsync(mine) : (note ?? null)),
    saving: save.isPending,
    sign: async () => {
      const saved = mine ? await save.mutateAsync(mine) : note;
      // A generated draft (revision 0) has to be stored before it can be signed.
      if (!saved) return null;
      const stored = saved.revision === 0 ? await save.mutateAsync({ sections: saved.sections, base: 0 }) : saved;
      return sign.mutateAsync(stored.revision);
    },
    signing: sign.isPending,
    addendum: (body) => addendum.mutateAsync(body),
    addingAddendum: addendum.isPending,
    conflict: stale && mine && note ? { mine: mine.sections, theirs: note } : null,
    resolve: (choice) => {
      if (!note || !mine) return;
      if (choice === "theirs") void draft.clear();
      else draft.set({ sections: choice === "mine" ? mine.sections : choice.merged, base: note.revision });
    },
    discard: () => draft.clear(),
  };
}
