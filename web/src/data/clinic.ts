// Clinic workspace: overview, worklist, tickets, patients, internal notes, schedule.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { clinicApi } from "../api/endpoints.ts";
import type {
  CalendarDate,
  ContactInput,
  PatientDetail,
  PatientListParams,
  PatientPatch,
  PatientRow,
  PersonRef,
  Role,
  StaffNote,
  Ticket,
  WorkItem,
  Worklist,
  WorklistParams,
} from "../api/types.ts";
import { qk } from "./keys.ts";
import { editLists, invalidate, restore, useIdempotency, usePaged } from "./util.ts";

const MINUTE = 60_000;

export function useClinicOverview() {
  return useQuery({ queryKey: qk.clinicOverview, queryFn: ({ signal }) => clinicApi.overview(signal), refetchInterval: MINUTE });
}
export function useWorklist(params: Omit<WorklistParams, "cursor"> = {}) {
  const query = usePaged<WorkItem, Worklist>(qk.worklist(params), (cursor, signal) => clinicApi.worklist({ ...params, cursor }, signal), {
    refetchInterval: MINUTE,
  });
  return { ...query, counts: query.first?.counts };
}
export function useTickets(status: "open" | "resolved" | "all" = "open") {
  return usePaged<Ticket>(qk.tickets(status), (cursor, signal) => clinicApi.tickets({ status, cursor }, signal));
}
export function useResolveTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => clinicApi.resolveTicket(id, note),
    // It leaves the open list at once; the other lists are read again.
    onMutate: ({ id }) => editLists<Ticket>(qc, qk.tickets("open"), (items) => items.filter((t) => t.id !== id)),
    onError: (_e, _v, snapshot) => restore(qc, snapshot),
    onSettled: () => invalidate(qc, qk.clinic, qk.visits, qk.patients),
  });
}
export function useSchedule(date: CalendarDate) {
  return useQuery({ queryKey: qk.schedule(date), queryFn: ({ signal }) => clinicApi.schedule(date, signal), refetchInterval: 2 * MINUTE });
}
/** People work can be assigned to, optionally of some roles only. */
export function useStaff(roles?: readonly Role[]) {
  return useQuery({
    queryKey: qk.staff,
    queryFn: ({ signal }) => clinicApi.staff(signal),
    staleTime: 10 * MINUTE,
    select: (people) => (roles ? people.filter((p) => roles.includes(p.role)) : people),
  });
}

// ------------------------------------------------------------------------------------------------ patients

export function usePatients(params: Omit<PatientListParams, "cursor"> = {}) {
  return usePaged<PatientRow>(qk.patientList(params), (cursor, signal) => clinicApi.patients({ ...params, cursor }, signal));
}
export function usePatient(id: string) {
  return useQuery({ queryKey: qk.patient(id), queryFn: ({ signal }) => clinicApi.patient(id, signal) });
}

/** Tags, care status, responsible people. Pass the people so the row can show them at once. */
export function useUpdatePatient(id: string) {
  const qc = useQueryClient();
  const key = qk.patient(id);
  return useMutation({
    mutationFn: (input: { patch: PatientPatch; physician?: PersonRef | null; coordinator?: PersonRef | null }) =>
      clinicApi.updatePatient(id, input.patch),
    onMutate: async ({ patch, physician, coordinator }) => {
      const part: Partial<PatientRow> = {
        ...(patch.tags ? { tags: patch.tags } : {}),
        ...(patch.care_status ? { care_status: patch.care_status } : {}),
        ...(physician !== undefined ? { physician } : {}),
        ...(coordinator !== undefined ? { coordinator } : {}),
      };
      const lists = await editLists<PatientRow>(qc, ["patients", "list"], (items) =>
        items.map((r) => (r.patient.id === id ? { ...r, ...part } : r)),
      );
      await qc.cancelQueries({ queryKey: key });
      const detail = qc.getQueryData<PatientDetail>(key);
      if (detail) qc.setQueryData<PatientDetail>(key, { ...detail, row: { ...detail.row, ...part } });
      return { lists, detail };
    },
    onError: (_e, _v, ctx) => {
      restore(qc, ctx?.lists);
      if (ctx?.detail) qc.setQueryData(key, ctx.detail);
    },
    onSettled: () => invalidate(qc, qk.patients),
  });
}

/** Internal notes of a patient: add, pin or edit, delete. */
export function usePatientNotes(patientId: string) {
  const qc = useQueryClient();
  const key = qk.patient(patientId);
  const idem = useIdempotency();
  const edit = async (fn: (notes: StaffNote[]) => StaffNote[]) => {
    await qc.cancelQueries({ queryKey: key });
    const before = qc.getQueryData<PatientDetail>(key) ?? null;
    if (before) qc.setQueryData<PatientDetail>(key, { ...before, notes: fn(before.notes) });
    return before;
  };
  const undo = (_e: unknown, _v: unknown, before: PatientDetail | null | undefined) => {
    if (before) qc.setQueryData(key, before);
  };
  const onSettled = () => invalidate(qc, key);
  return {
    add: useMutation({
      mutationFn: (input: { body: string; pinned: boolean }) => clinicApi.addNote(patientId, input, idem.key(input)),
      onSuccess: () => idem.done(),
      onSettled,
    }),
    update: useMutation({
      mutationFn: ({ id, ...patch }: { id: string; body?: string; pinned?: boolean }) => clinicApi.updateNote(id, patch),
      onMutate: ({ id, ...patch }) => edit((notes) => notes.map((n) => (n.id === id ? { ...n, ...patch } : n))),
      onError: undo,
      onSettled,
    }),
    remove: useMutation({
      mutationFn: (id: string) => clinicApi.deleteNote(id),
      onMutate: (id) => edit((notes) => notes.filter((n) => n.id !== id)),
      onError: undo,
      onSettled,
    }),
  };
}
/** Write to the patient in the app, or record a phone call. */
export function useContactPatient(patientId: string) {
  const qc = useQueryClient();
  const idem = useIdempotency();
  return useMutation({
    mutationFn: (input: ContactInput) => clinicApi.contact(patientId, input, idem.key(input)),
    onSuccess: () => {
      idem.done();
      invalidate(qc, qk.patients, qk.visits, qk.clinic);
    },
  });
}
