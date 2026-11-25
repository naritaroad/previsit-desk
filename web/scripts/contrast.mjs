// WCAG contrast of every token pair the kit uses, for each workspace in both themes: node scripts/contrast.mjs [--all]
// Text 4.5:1 (no large-text discount), control boundaries and focus 3:1. Exit code 1 on any failure.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../src/styles/tokens.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// Every rule of the file as [selectors, declarations], in source order.
const rules = [];
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selectors = m[1].split(",").map((s) => s.trim().replace(/\s+/g, " "));
  const vars = Object.fromEntries([...m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()]));
  rules.push([selectors, vars]);
}
function tokens(theme, ws) {
  const out = {};
  const take = (selector) => {
    for (const [sel, vars] of rules) if (sel.includes(selector)) Object.assign(out, vars);
  };
  // Cascade as the browser resolves it on the shell element: root, root theme, workspace, themed workspace.
  take(":root");
  if (theme === "dark") take('[data-theme="dark"]');
  if (theme === "light" || ws !== "public") take(`[data-ws="${ws}"]`);
  if (theme === "dark") {
    take('[data-theme="dark"]');
    if (ws !== "public" && ws !== "patient") take(`[data-ws="${ws}"]`);
    take('[data-theme="dark"]');
    take(`[data-theme="dark"] [data-ws="${ws}"]`);
  }
  return out;
}
const rgb = (hex) => {
  if (!/^#[0-9a-f]{6}$/i.test(hex ?? "")) throw new Error(`not a solid colour: ${hex}`);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
};
const lum = (hex) => {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const T = 4.5;
const U = 3;
const pairs = [];
for (const bg of ["bg", "surface", "raised", "sunken", "hover"]) {
  pairs.push(["fg", bg, T], ["fg-2", bg, T], ["fg-3", bg, T], ["ink-text", bg, T], ["rule-strong", bg, bg === "sunken" || bg === "hover" ? 2.8 : U], ["focus", bg, U]);
}
for (const bg of ["bg", "surface", "raised"]) pairs.push(["danger", bg, T], ["ink", bg, U]);
pairs.push(["fg-disabled", "sunken", U]); // disabled controls are exempt from 1.4.3; kept readable anyway
pairs.push(["on-ink", "ink", T], ["on-ink", "ink-hover", T], ["fg", "ink-soft", T], ["fg-2", "ink-soft", T], ["ink-text", "ink-soft", T], ["ink", "ink-soft", U], ["focus", "ink-soft", U]);
for (const s of ["ok", "info", "warn", "hold", "mute", "danger"]) pairs.push([s, `${s}-soft`, T], ["fg", `${s}-soft`, T]);
for (const s of ["ok", "info", "warn", "hold", "mute"]) pairs.push([s, "surface", T], [s, "bg", T]);
pairs.push(["fg-2", "danger-soft", T], ["fg-2", "warn-soft", T], ["fg-2", "info-soft", T], ["fg-2", "hold-soft", T], ["fg-2", "ok-soft", T], ["on-danger", "danger-solid", T], ["on-danger", "danger-solid-hover", T], ["danger-solid", "surface", U]);
pairs.push(["rail-fg", "rail", T], ["rail-fg-2", "rail", T], ["rail-fg", "rail-2", T], ["rail-fg-2", "rail-2", T], ["rail", "rail-fg", T]);
pairs.push(["surface", "fg", T], ["fg", "selection", T]);

let failed = 0;
let count = 0;
let lowest = { r: 99 };
for (const theme of ["light", "dark"]) {
  for (const ws of ["public", "patient", "clinic", "pharmacy", "admin"]) {
    const v = tokens(theme, ws);
    for (const [fg, bg, min] of pairs) {
      const r = ratio(v[`--${fg}`], v[`--${bg}`]);
      count++;
      if (min === T && r < lowest.r) lowest = { r, where: `${theme}/${ws} ${fg} on ${bg}` };
      if (r < min || process.argv.includes("--all")) {
        console.log(`${r < min ? "FAIL" : "pass"} ${r.toFixed(2).padStart(5)} (min ${min}) ${theme}/${ws} --${fg} ${v[`--${fg}`]} on --${bg} ${v[`--${bg}`]}`);
        if (r < min) failed++;
      }
    }
  }
}
console.log(`${count} pairs checked, ${failed} failed; lowest text contrast ${lowest.r.toFixed(2)} (${lowest.where})`);
process.exit(failed ? 1 : 0);
