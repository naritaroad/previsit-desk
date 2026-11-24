#!/usr/bin/env node
// Contrast check for PreVisit Desk tokens (WCAG 2.x relative luminance).
// Usage: node docs/design/contrast-check.mjs [path/to/tokens.css]
// Reads :root (light) and [data-theme="dark"] blocks, resolves var() aliases,
// checks every specified text/background and UI-boundary pair, exits 1 on any failure.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? resolve(here, '../../web/src/styles/tokens.css');
const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function block(selectorRe) {
  const m = css.match(selectorRe);
  if (!m) throw new Error(`block not found: ${selectorRe}`);
  const start = css.indexOf('{', m.index) + 1;
  let depth = 1, i = start;
  while (depth && i < css.length) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
  const vars = {};
  for (const d of css.slice(start, i - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[d[1]] = d[2].trim();
  return vars;
}

const light = block(/^:root\s*\{/m);
const darkExplicit = block(/^\[data-theme="dark"\]\s*\{/m);
const darkMedia = block(/:root:not\(\[data-theme="light"\]\)\s*\{/);
const dark = { ...light, ...darkExplicit };
// The prefers-color-scheme block must mirror [data-theme="dark"] exactly.
const drift = [...new Set([...Object.keys(darkExplicit), ...Object.keys(darkMedia)])]
  .filter((k) => darkExplicit[k] !== darkMedia[k]);
if (drift.length) { console.error(`Dark blocks differ: ${drift.join(', ')}`); process.exit(1); }

function resolveVar(vars, name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`cycle at ${name}`);
  seen.add(name);
  const v = vars[name];
  if (v === undefined) throw new Error(`missing token ${name}`);
  const ref = v.match(/^var\((--[\w-]+)\)$/);
  return ref ? resolveVar(vars, ref[1], seen) : v;
}

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`not a solid hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
const lum = (rgb) => {
  const [r, g, b] = rgb.map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(hexToRgb(a)), lum(hexToRgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [foreground, background, minimum, note]
const TEXT = 4.5, UI = 3.0;
const surfaces = ['--color-bg', '--color-surface', '--color-surface-raised'];
const pairs = [];
for (const s of [...surfaces, '--color-surface-sunken']) {
  pairs.push(['--color-text', s, TEXT, 'body text']);
  pairs.push(['--color-text-muted', s, TEXT, 'secondary text']);
}
for (const s of surfaces) {
  pairs.push(['--color-text-subtle', s, TEXT, 'captions']);
  pairs.push(['--color-primary', s, TEXT, 'links / primary text']);
  pairs.push(['--color-accent', s, TEXT, 'accent text']);
  pairs.push(['--color-success', s, TEXT, 'status text']);
  pairs.push(['--color-warning', s, TEXT, 'status text']);
  pairs.push(['--color-revisit', s, TEXT, 'status text']);
  pairs.push(['--color-danger', s, TEXT, 'red-flag text']);
  pairs.push(['--color-border-strong', s, UI, 'control boundary']);
  pairs.push(['--color-focus', s, UI, 'focus ring']);
}
pairs.push(
  ['--color-text-muted', '--color-primary-soft', TEXT, 'meta in patient bubble'],
  ['--color-text', '--color-primary-soft', TEXT, 'patient bubble text'],
  ['--color-primary-contrast', '--color-primary', TEXT, 'primary button'],
  ['--color-primary-contrast', '--color-primary-hover', TEXT, 'primary button hover'],
  ['--color-primary-strong', '--color-primary-soft', TEXT, 'selected tab / chip'],
  ['--color-accent', '--color-accent-bg', TEXT, 'consult card / info'],
  ['--color-text', '--color-accent-bg', TEXT, 'text on info bg'],
  ['--color-success', '--color-success-bg', TEXT, 'eligible card'],
  ['--color-text', '--color-success-bg', TEXT, 'text on eligible card'],
  ['--color-warning', '--color-warning-bg', TEXT, 'too_early card'],
  ['--color-text', '--color-warning-bg', TEXT, 'text on too_early card'],
  ['--color-revisit', '--color-revisit-bg', TEXT, 'revisit card'],
  ['--color-text', '--color-revisit-bg', TEXT, 'text on revisit card'],
  ['--color-danger', '--color-danger-bg', TEXT, 'emergency title'],
  ['--color-danger-strong', '--color-danger-bg', TEXT, 'emergency body'],
  ['--color-text', '--color-danger-bg', TEXT, 'text on emergency bg'],
  ['--color-danger-contrast', '--color-danger-solid', TEXT, 'call 119 button'],
  ['--color-danger-solid', '--color-danger-bg', UI, 'call button edge on emergency bg'],
  ['--color-danger-solid', '--color-surface', UI, 'call button edge on surface'],
  ['--color-primary', '--color-surface', UI, 'primary button edge'],
  ['--color-focus', '--color-primary-soft', UI, 'focus ring on selected tab'],
  ['--color-focus', '--color-danger-bg', UI, 'focus ring in emergency card'],
  ['--color-border-strong', '--color-surface-sunken', UI, 'input on sunken'],
);

let failures = 0;
const minByTheme = {};
for (const [themeName, vars] of [['light', light], ['dark', dark]]) {
  console.log(`\n== ${themeName} ==`);
  console.log('ratio  min  result  foreground -> background  (use)');
  let min = Infinity;
  for (const [fg, bg, need, note] of pairs) {
    const f = resolveVar(vars, fg), b = resolveVar(vars, bg);
    const r = ratio(f, b);
    const ok = r >= need;
    if (!ok) failures++;
    if (need === TEXT) min = Math.min(min, r);
    console.log(`${r.toFixed(2).padStart(5)}  ${need.toFixed(1)}  ${ok ? 'PASS' : 'FAIL'}    ${fg} ${f} -> ${bg} ${b}  (${note})`);
  }
  minByTheme[themeName] = min;
}
console.log(`\nPairs checked: ${pairs.length * 2}. Failures: ${failures}.`);
console.log(`Minimum text ratio: light ${minByTheme.light.toFixed(2)}, dark ${minByTheme.dark.toFixed(2)}.`);
process.exit(failures ? 1 : 0);
