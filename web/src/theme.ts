// Light / dark / follow the system. The choice is a per-viewer convenience kept in localStorage.
// tokens.css reads it from the data-theme attribute on <html>.

import { KEYS, readStorage, writeStorage } from "./lib/storage.ts";

export type ThemeChoice = "light" | "dark" | "system";

export function loadTheme(): ThemeChoice {
  const v = readStorage(KEYS.theme);
  return v === "light" || v === "dark" ? v : "system";
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  writeStorage(KEYS.theme, choice === "system" ? null : choice);
}

/** What the page currently looks like, resolving "system" through the media query. */
export function effectiveTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "system") return choice;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
