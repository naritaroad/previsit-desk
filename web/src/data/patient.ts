// The patient's own data: home, profile, measurements, medications, appointments, consents, access log.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { appointmentsApi, patientApi } from "../api/endpoints.ts";
import { isStale } from "../api/errors.ts";
import type {
  AccessLogEntry,
  Appointment,
  Consent,
  ConsentDoc,
  ConsentState,
  HealthProfile,
  HealthProfileInput,
  Measurement,
  MeasurementInput,
  MeasurementKind,
  SlotParams,
} from "../api/types.ts";
import { uuid } from "../lib/ids.ts";
import { qk } from "./keys.ts";
import { editLists, invalidate, patchById, removeById, restore, useIdempotency, usePaged } from "./util.ts";

export function usePatientHome() {
  return useQuery({ queryKey: qk.home, queryFn: ({ signal }) => patientApi.home(signal) });
}

// ------------------------------------------------------------------------------------------------ profile

export function useProfile() {
  return useQuery({ queryKey: qk.profile, queryFn: ({ signal }) => patientApi.profile(signal) });
}
/** PUT with the revision it was edited from. On a 409 the cache gets the newer profile; staleProfile(error) has it. */
export function useSaveProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: HealthProfileInput) => patientApi.putProfile(input),
    onSuccess: (profile) => {
      qc.setQueryData(qk.profile, profile);
      invalidate(qc, qk.home);
    },
    onError: (e) => {
      const current = staleProfile(e);
      if (current) qc.setQueryData(qk.profile, current);
    },
  });
}
export function staleProfile(e: unknown): HealthProfile | null {
  return isStale(e) ? (e.current as HealthProfile | null) : null;
}

// ------------------------------------------------------------------------------------------------ measurements

export function useMeasurements(kind?: MeasurementKind) {
  return usePaged<Measurement>(qk.measurements(kind), (cursor, signal) => patientApi.measurements({ kind, cursor, limit: 100 }, signal));
}
export function useAddMeasurement() {
  const qc = useQueryClient();
  const idem = useIdempotency();
  return useMutation({
    mutationFn: (input: MeasurementInput) => patientApi.addMeasurement(input, idem.key(input)),
    onMutate: (input) => {
      const row: Measurement = { ...input, id: `new:${uuid()}`, source: "patient" };
      return editLists<Measurement>(qc, qk.measurements(), (items) => [row, ...items].sort((a, b) => b.taken_at.localeCompare(a.taken_at)));
    },
    onError: (_e, _v, snapshot) => restore(qc, snapshot),
    onSuccess: () => idem.done(),
    onSettled: () => invalidate(qc, qk.measurements(), qk.home),
  });
}
export function useDeleteMeasurement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => patientApi.deleteMeasurement(id),
    onMutate: (id) => editLists<Measurement>(qc, qk.measurements(), removeById(id)),
    onError: (_e, _id, snapshot) => restore(qc, snapshot),
    onSettled: () => invalidate(qc, qk.measurements()),
  });
}

// ------------------------------------------------------------------------------------------------ medications

export function useMedications() {
  return useQuery({ queryKey: qk.medications, queryFn: ({ signal }) => patientApi.medications(signal) });
}
export function useAddMedication() {
  const qc = useQueryClient();
  const idem = useIdempotency();
  return useMutation({
    mutationFn: (input: { name: string; dose_text: string }) => patientApi.addMedication(input, idem.key(input)),
    onSuccess: () => {
      idem.done();
      invalidate(qc, qk.medications, qk.home, qk.profile);
    },
  });
}

// ------------------------------------------------------------------------------------------------ appointments

export function useAppointments() {
  return usePaged<Appointment>(qk.appointmentList, (cursor, signal) => appointmentsApi.list({ cursor }, signal));
}
export function useSlots(params: SlotParams, enabled = true) {
  return useQuery({
    queryKey: qk.slots(params),
    queryFn: ({ signal }) => appointmentsApi.slots(params, signal),
    enabled,
    staleTime: 10_000, // other people book too
    meta: { persist: false },
  });
}
/** A slot someone else just took answers 409; the slots are read again. */
export function useBookAppointment() {
  const qc = useQueryClient();
  const idem = useIdempotency();
  return useMutation({
    mutationFn: (input: { slot_id: string; reason: string }) => appointmentsApi.book(input, idem.key(input)),
    onSuccess: () => idem.done(),
    onSettled: () => invalidate(qc, qk.appointments, qk.home),
  });
}
export function useCancelAppointment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => appointmentsApi.cancel(id),
    onMutate: (id) => editLists<Appointment>(qc, qk.appointmentList, patchById<Appointment>(id, { status: "cancelled" })),
    onError: (_e, _id, snapshot) => restore(qc, snapshot),
    onSettled: () => invalidate(qc, qk.appointments, qk.home),
  });
}

// ------------------------------------------------------------------------------------------------ privacy

export function useAccessLog() {
  return usePaged<AccessLogEntry>(qk.accessLog, (cursor, signal) => patientApi.accessLog({ cursor }, signal), { meta: { persist: false } });
}
export interface ConsentStatus {
  /** The newest choice, or null when there is none. */
  latest: Consent | null;
  /** Granted, and for the version in force. */
  valid: boolean;
  currentVersion: string | null;
}
export function consentStatus(state: ConsentState | undefined, doc: ConsentDoc): ConsentStatus {
  const latest = state?.items.find((c) => c.doc === doc) ?? null;
  const currentVersion = state?.current_versions[doc] ?? null;
  return { latest, currentVersion, valid: !!latest?.granted && (currentVersion === null || latest.version === currentVersion) };
}
const consentQuery = { queryKey: qk.consents, queryFn: ({ signal }: { signal: AbortSignal }) => patientApi.consents(signal) };
/** The whole history, newest first; the first entry of a document is the one that counts. */
export function useConsents() {
  return useQuery({ ...consentQuery, select: (s) => s.items });
}
/** History plus the versions in force; consentStatus(data, doc) reads one document. */
export function useConsentState() {
  return useQuery(consentQuery);
}
export function useSetConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { doc: ConsentDoc; version: string; granted: boolean }) => patientApi.setConsent(input),
    onMutate: (input) =>
      editLists<Consent>(qc, qk.consents, (items) => [{ ...input, created_at: new Date().toISOString() }, ...items]),
    onError: (_e, _v, snapshot) => restore(qc, snapshot),
    onSettled: () => invalidate(qc, qk.consents),
  });
}
