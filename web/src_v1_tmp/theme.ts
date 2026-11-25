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
  syncThemeColor(choice);
}

/**
 * The browser bar colour (<meta name="theme-color">) follows the in-app choice too. index.html ships
 * one tag per OS scheme; with an explicit choice both tags lose their media query and carry the
 * colour of the header surface, and "system" puts the originals back.
 */
function syncThemeColor(choice: ThemeChoice): void {
  const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  for (const m of metas) {
    m.dataset.pvMedia ??= m.getAttribute("media") ?? "";
    m.dataset.pvColor ??= m.content;
  }
  if (choice === "system") {
    for (const m of metas) {
      if (m.dataset.pvMedia) m.setAttribute("media", m.dataset.pvMedia);
      m.content = m.dataset.pvColor ?? m.content;
    }
    return;
  }
  const surface = getComputedStyle(document.documentElement).getPropertyValue("--color-surface").trim();
  for (const m of metas) {
    m.removeAttribute("media");
    if (surface) m.content = surface;
  }
}

/** What the page currently looks like, resolving "system" through the media query. */
export function effectiveTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "system") return choice;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
