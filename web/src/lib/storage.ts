// localStorage wrappers. Storage can be missing or blocked (private windows), so every access is guarded.

export const KEYS = {
  visitId: "previsit.visitId",
  theme: "pv-theme",
  locale: "previsit.locale",
} as const;

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the page still works, it just forgets */
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stored visit id is only trusted if it looks like a UUID. */
export function isVisitId(value: string | null): value is string {
  return value !== null && UUID.test(value);
}
