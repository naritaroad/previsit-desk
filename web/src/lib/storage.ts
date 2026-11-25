// localStorage keys and guarded access. Storage can be missing or blocked, so every access is wrapped.
// index.html reads pv-theme and pv-text before first paint; keep those two names.

export const KEYS = {
  theme: "pv-theme",
  text: "pv-text",
  locale: "pv-locale",
  density: "pv-density",
  /** Id of the account whose cache may be restored while offline. */
  lastAccount: "pv-last-account",
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
    /* blocked: the page still works, it just forgets */
  }
}
