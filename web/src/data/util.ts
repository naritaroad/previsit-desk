// Shared pieces of the query hooks: cursor lists, optimistic list edits, idempotency keys that live as long as
// one user intent.

import {
  type InfiniteData,
  type QueryClient,
  type QueryKey,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
} from "@tanstack/react-query";
import { useMemo, useRef } from "react";

import type { Page } from "../api/types.ts";
import { newIdempotencyKey } from "../lib/ids.ts";

export type PagedResult<T, P extends Page<T> = Page<T>> = UseInfiniteQueryResult<InfiniteData<P>> & {
  /** All loaded items, in order. */
  items: T[];
  total: number | undefined;
  /** The first page, for lists that carry counts. */
  first: P | undefined;
};

export function usePaged<T, P extends Page<T> = Page<T>>(
  queryKey: QueryKey,
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<P>,
  o: { enabled?: boolean; staleTime?: number; refetchInterval?: number; meta?: Record<string, unknown> } = {},
): PagedResult<T, P> {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => fetchPage(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: (prev) => prev, // keep the list while a filter loads
    ...o,
  });
  const pages = query.data?.pages;
  const items = useMemo(() => pages?.flatMap((p) => p.items) ?? [], [pages]);
  return { ...query, items, total: pages?.[0]?.total, first: pages?.[0] } as PagedResult<T, P>;
}

type Cached = [QueryKey, unknown][];

/** Put back what an optimistic edit replaced. */
export function restore(qc: QueryClient, snapshot: Cached | undefined): void {
  for (const [key, data] of snapshot ?? []) qc.setQueryData(key, data);
}

const isPage = (v: unknown): v is Page<unknown> => typeof v === "object" && v !== null && Array.isArray((v as Page<unknown>).items);
const isInfinite = (v: unknown): v is InfiniteData<Page<unknown>> =>
  typeof v === "object" && v !== null && Array.isArray((v as InfiniteData<unknown>).pages);

/** Map the items of whatever list shape is cached (array, page, infinite pages). Other shapes stay as they are. */
export function mapItems<T>(data: unknown, fn: (items: T[]) => T[]): unknown {
  if (Array.isArray(data)) return fn(data as T[]);
  if (isPage(data)) return { ...data, items: fn(data.items as T[]) };
  if (isInfinite(data)) return { ...data, pages: data.pages.map((p) => (isPage(p) ? { ...p, items: fn(p.items as T[]) } : p)) };
  return data;
}

/** Edit every cached list under a key prefix and return what it was before. */
export async function editLists<T>(qc: QueryClient, prefix: QueryKey, fn: (items: T[]) => T[]): Promise<Cached> {
  await qc.cancelQueries({ queryKey: prefix });
  const snapshot = qc.getQueriesData({ queryKey: prefix });
  for (const [key, data] of snapshot) qc.setQueryData(key, mapItems<T>(data, fn));
  return snapshot;
}

export const patchById =
  <T extends { id: string }>(id: string, part: Partial<T>) =>
  (items: T[]): T[] =>
    items.map((x) => (x.id === id ? { ...x, ...part } : x));
export const removeById =
  <T extends { id: string }>(id: string) =>
  (items: T[]): T[] =>
    items.filter((x) => x.id !== id);

export function invalidate(qc: QueryClient, ...keys: QueryKey[]): void {
  for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
}

/**
 * Idempotency-Key for a form: the same key while the same input is retried, a new one after success or when
 * the input changes. `key(input)` before the request, `done()` when it succeeded.
 */
export function useIdempotency(): { key: (input: unknown) => string; done: () => void } {
  const ref = useRef<{ for: string; key: string } | null>(null);
  return useMemo(
    () => ({
      key: (input: unknown) => {
        const fingerprint = JSON.stringify(input ?? null);
        if (ref.current?.for !== fingerprint) ref.current = { for: fingerprint, key: newIdempotencyKey() };
        return ref.current.key;
      },
      done: () => {
        ref.current = null;
      },
    }),
    [],
  );
}
