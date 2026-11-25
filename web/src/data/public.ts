// Public endpoints: no sign-in needed. Kept across accounts (the answers are the same for everyone).

import { useQuery } from "@tanstack/react-query";

import { publicApi } from "../api/endpoints.ts";
import { todayInTaipei } from "../lib/format.ts";
import { qk } from "./keys.ts";

const HOUR = 3_600_000;

export function useMeta() {
  return useQuery({ queryKey: qk.meta, queryFn: ({ signal }) => publicApi.meta(signal), staleTime: 5 * 60_000 });
}
/** The server's Asia/Taipei date; this device's clock until it is known. */
export function useToday(): string {
  return useMeta().data?.server_today ?? todayInTaipei();
}
export function useHealth() {
  return useQuery({ queryKey: qk.health, queryFn: ({ signal }) => publicApi.health(signal), refetchInterval: 60_000 });
}
export function useTrustFacts() {
  return useQuery({ queryKey: qk.trustFacts, queryFn: ({ signal }) => publicApi.trustFacts(signal), staleTime: HOUR });
}
export function usePharmacies() {
  return useQuery({ queryKey: qk.pharmacies, queryFn: ({ signal }) => publicApi.pharmacies(signal), staleTime: HOUR });
}
export function useHandbook() {
  return useQuery({ queryKey: qk.handbook, queryFn: ({ signal }) => publicApi.handbook(signal), staleTime: HOUR });
}
/** Pass a debounced query; nothing is sent for fewer than 2 characters. */
export function useHandbookSearch(q: string) {
  const text = q.trim();
  return useQuery({
    queryKey: qk.handbookSearch(text),
    queryFn: ({ signal }) => publicApi.searchHandbook(text, signal),
    enabled: [...text].length >= 2,
    staleTime: HOUR,
    placeholderData: (p) => p,
  });
}
