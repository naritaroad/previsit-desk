import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";

export type Workspace = "public" | "patient" | "clinic" | "pharmacy" | "admin";
export type Density = "comfortable" | "compact";

/** Set by each shell. Popups read it because portals render outside the shell's element. */
export const WorkspaceContext = createContext<{ ws: Workspace; density: Density }>({ ws: "public", density: "comfortable" });

export function useWorkspace() {
  return useContext(WorkspaceContext);
}
export function usePortalWs(): { "data-ws": Workspace; "data-density": Density } {
  const { ws, density } = useContext(WorkspaceContext);
  return { "data-ws": ws, "data-density": density };
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const m = matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => matchMedia(query).matches,
    () => false,
  );
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      addEventListener("online", cb);
      addEventListener("offline", cb);
      return () => {
        removeEventListener("online", cb);
        removeEventListener("offline", cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

/** Global shortcut such as "mod+k" or "/". Plain keys are ignored while the user is typing or composing Chinese. */
export function useHotkey(combo: string, handler: (e: KeyboardEvent) => void, enabled = true) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const parts = combo.toLowerCase().split("+");
    const key = parts.at(-1)!;
    const mod = parts.includes("mod");
    const shift = parts.includes("shift");
    const on = (e: KeyboardEvent) => {
      if (e.isComposing || e.key.toLowerCase() !== key) return;
      if (mod !== (e.ctrlKey || e.metaKey) || (shift && !e.shiftKey)) return;
      const el = e.target as HTMLElement | null;
      const typing = el?.isContentEditable || /^(input|textarea|select)$/i.test(el?.tagName ?? "");
      if (typing && !mod) return;
      ref.current(e);
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [combo, enabled]);
}

export function usePersistentState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage can be blocked; the setting then lasts for this visit only */
      }
    },
    [key],
  );
  return [value, set];
}
