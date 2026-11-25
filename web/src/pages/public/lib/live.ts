// Public data, with one guard: a request that was cancelled while the page found out who is signed in is asked again.

import type { UseQueryResult } from "@tanstack/react-query";
import { useEffect } from "react";

export function useResumed<T>(q: UseQueryResult<T>): UseQueryResult<T> {
  const stuck = q.isPending && q.fetchStatus === "idle";
  const { refetch } = q;
  useEffect(() => {
    if (stuck) void refetch();
  }, [stuck, refetch]);
  return q;
}
