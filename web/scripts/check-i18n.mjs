// Checks the UI copy before every build (npm run i18n:check). Namespaces are files: locales/<lng>/<namespace>.json.
//   1. every language has every namespace of the reference (zh-TW) with the same keys, and no empty strings;
//   2. each translation uses the same {{placeholders}} as the reference;
//   3. every key the code asks for exists (t("ns:key"), useTranslation("ns") + t("key"), useTranslation(["a","b"]));
//   4. no words are written straight into components: any CJK in .tsx outside comments, and Latin words in JSX text
//      or in placeholder/title/alt/aria-label/label;
//   5. zh-TW has no Simplified characters and none of the Mainland terms people slip into most often.
// Plural forms (key_one, key_other, ...) count as one key: zh-TW needs the plain key or key_other, en has more.
// Exit code 1 on any error; unused keys are warnings (--strict makes them errors).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "src");
const localeDir = join(src, "i18n", "locales");
const REFERENCE = "zh-TW";
const DEFAULT_NS = "common";
const strict = process.argv.includes("--strict");
/** Development only; its words never reach the build. */
const SKIP = ["src/kit-gallery/", "src/mocks/"];
const PLURAL = /_(zero|one|two|few|many|other)$/;

const errors = [];
const warnings = [];

function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else if (Array.isArray(v)) v.forEach((x, i) => (x && typeof x === "object" ? flatten(x, `${key}.${i}`, out) : out.set(`${key}.${i}`, String(x))));
    else out.set(key, String(v));
  }
  return out;
}
const base = (key) => key.replace(PLURAL, "");
const placeholders = (s) => [...new Set([...s.matchAll(/\{\{\s*(\w+)[^}]*\}\}/g)].map((m) => m[1]))].sort().join(",");

// ---- 1, 2, 5: language files ----
const languages = readdirSync(localeDir).filter((d) => statSync(join(localeDir, d)).isDirectory());
if (!languages.includes(REFERENCE)) {
  console.error(`missing reference language ${REFERENCE}`);
  process.exit(1);
}
const load = (lng) =>
  Object.fromEntries(
    readdirSync(join(localeDir, lng))
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return [f.replace(/\.json$/, ""), flatten(JSON.parse(readFileSync(join(localeDir, lng, f), "utf8")))];
        } catch (e) {
          errors.push(`${lng}/${f}: ${e.message}`);
          return [f.replace(/\.json$/, ""), new Map()];
        }
      }),
  );
const files = Object.fromEntries(languages.map((l) => [l, load(l)]));
const reference = files[REFERENCE];
const refBases = {}; // ns -> Map(base -> value)
for (const [ns, keys] of Object.entries(reference)) {
  refBases[ns] = new Map();
  for (const [k, v] of keys) if (!refBases[ns].has(base(k))) refBases[ns].set(base(k), v);
}
for (const lng of languages) {
  for (const ns of Object.keys(reference)) if (!files[lng][ns]) errors.push(`${lng}/${ns}.json is missing`);
  for (const [ns, keys] of Object.entries(files[lng])) {
    const ref = refBases[ns];
    if (!ref) {
      errors.push(`${lng}/${ns}.json has no ${REFERENCE}/${ns}.json`);
      continue;
    }
    const seen = new Set();
    for (const [key, value] of keys) {
      seen.add(base(key));
      if (!value.trim()) errors.push(`${lng}/${ns}.json: "${key}" is empty`);
      if (lng === REFERENCE) continue;
      const r = ref.get(base(key));
      if (r === undefined) errors.push(`${lng}/${ns}.json: "${key}" is not in ${REFERENCE}`);
      else if (placeholders(value) !== placeholders(r) && !PLURAL.test(key)) errors.push(`${lng}/${ns}.json: "${key}" uses {{${placeholders(value)}}} but ${REFERENCE} uses {{${placeholders(r)}}}`);
    }
    if (lng !== REFERENCE) for (const b of ref.keys()) if (!seen.has(b)) errors.push(`${lng}/${ns}.json: missing "${b}"`);
  }
}
// Common characters whose code point is Simplified only, and Mainland terms that slip in.
const SIMP_ONLY = /[们这说时间诊药单录设备问题资讯发现应该与为从来头动务员处过还进远连运边达选适医护检验询车东书买卖观规视语读让认识计订论证评词译试话详误调谁负责败货质购费]/g;
const TERMS = ["視頻", "軟件", "網絡", "信息化", "默認", "數據庫", "打印", "鼠標", "屏幕", "賬號", "登錄", "註銷", "點擊", "短信", "質量分", "優化體驗", "用戶", "服務器", "激活", "菜單", "二維碼", "在線", "線下", "反饋", "郵箱", "緩存", "保存成功", "加載", "刷新"];
for (const [ns, keys] of Object.entries(reference)) {
  for (const [key, value] of keys) {
    const bad = [...value.matchAll(SIMP_ONLY)].map((m) => m[0]);
    if (bad.length) errors.push(`${REFERENCE}/${ns}.json: "${key}" has Simplified characters: ${[...new Set(bad)].join("")}`);
    for (const t of TERMS) if (value.includes(t)) errors.push(`${REFERENCE}/${ns}.json: "${key}" uses 「${t}」`);
  }
}

// ---- 3 & 4: source files ----
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(tsx?|jsx?)$/.test(name) && !/\.(test|spec)\./.test(name) ? [path] : [];
  });
}
const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;
const WORDS = /[A-Za-z]{2,}/;
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[\s;{}(,])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));
const used = {};
const dynamic = {};
for (const ns of Object.keys(refBases)) {
  used[ns] = new Set();
  dynamic[ns] = new Set();
}
const has = (ns, key) => refBases[ns]?.has(key) || [...(refBases[ns]?.keys() ?? [])].some((k) => k.startsWith(`${key}.`));

for (const file of walk(src)) {
  const rel = relative(root, file).replaceAll("\\", "/");
  if (SKIP.some((s) => rel.startsWith(s))) continue;
  const raw = readFileSync(file, "utf8");
  const code = stripComments(raw);

  const scopes = new Set();
  for (const m of code.matchAll(/useTranslation\(\s*(?:\[([^\]]*)\]|["'`]([\w-]+)["'`])?\s*[,)]/g)) {
    if (m[1]) for (const n of m[1].matchAll(/["'`]([\w-]+)["'`]/g)) scopes.add(n[1]);
    else scopes.add(m[2] ?? DEFAULT_NS);
  }
  if (scopes.size === 0) scopes.add(DEFAULT_NS);

  for (const m of code.matchAll(/\b(?:t|tc|ts|exists|i18nKey=\{?)\(?\s*(["'`])((?:[\w-]+:)?[\w.$\-{}()?|&!='"\s]+?)\1/g)) {
    const full = m[2];
    if (!/^(?:[\w-]+:)?[\w-]+(?:\.|$|\$)/.test(full) && !full.includes("${")) continue;
    const [nsPart, keyPart] = full.includes(":") && !full.startsWith("${") ? [full.slice(0, full.indexOf(":")), full.slice(full.indexOf(":") + 1)] : [null, full];
    const candidates = nsPart ? [nsPart] : [...scopes];
    const dyn = keyPart.indexOf("${");
    if (dyn === -1) {
      const hit = candidates.find((ns) => has(ns, keyPart));
      if (hit) used[hit].add(keyPart);
      else if (candidates.some((ns) => refBases[ns])) errors.push(`${rel}: t("${full}") has no entry in ${REFERENCE}/${candidates.join(", ")}`);
      else warnings.push(`${rel}: namespace "${candidates.join(", ")}" does not exist yet (t("${full}"))`);
    } else {
      const prefix = keyPart.slice(0, dyn);
      const hit = candidates.filter((ns) => refBases[ns] && (prefix === "" || [...refBases[ns].keys()].some((k) => k.startsWith(prefix))));
      if (hit.length === 0 && candidates.some((ns) => refBases[ns])) errors.push(`${rel}: t(\`${full}\`) matches no key in ${REFERENCE}/${candidates.join(", ")}`);
      for (const ns of hit) dynamic[ns].add(prefix);
    }
  }
  // Keys passed around as plain strings: "ns:key.path", and "key.path" in lookup tables and route handles.
  for (const m of code.matchAll(/["'`](?:([\w-]+):)?([a-zA-Z][\w-]*(?:\.[\w-]+)+)["'`]/g)) {
    for (const ns of m[1] ? [m[1]] : Object.keys(refBases)) if (refBases[ns]?.has(m[2])) used[ns].add(m[2]);
  }

  if (!file.endsWith("x")) continue;
  code.split("\n").forEach((line, i) => {
    if (CJK.test(line)) errors.push(`${rel}:${i + 1}: hard-coded Chinese "${line.trim().slice(0, 60)}" (move it to the language files)`);
  });
  for (const m of code.matchAll(/(?<![=\w)\]])>([^<>{}()=;&|"]*)</g)) {
    const text = m[1].trim();
    if (text && !/^[,:?]/.test(text) && WORDS.test(text)) errors.push(`${rel}: hard-coded text "${text.slice(0, 60)}"`);
  }
  for (const m of code.matchAll(/\b(placeholder|title|alt|aria-label|label)="([^"]*)"/g)) if (WORDS.test(m[2])) errors.push(`${rel}: hard-coded ${m[1]}="${m[2]}"`);
}

for (const [ns, bases] of Object.entries(refBases))
  for (const key of bases.keys()) {
    if (used[ns].has(key) || [...dynamic[ns]].some((p) => key.startsWith(p)) || [...used[ns]].some((u) => key.startsWith(`${u}.`))) continue;
    (strict ? errors : warnings).push(`unused key ${ns}:${key}`);
  }

if (warnings.length) console.warn(warnings.slice(0, 40).map((w) => `warning: ${w}`).join("\n") + (warnings.length > 40 ? `\n(${warnings.length - 40} more warnings)` : ""));
for (const e of errors) console.error(`error: ${e}`);
const total = Object.values(refBases).reduce((n, m) => n + m.size, 0);
const summary = `${total} keys in ${Object.keys(refBases).length} namespaces × ${languages.length} languages (${languages.join(", ")})`;
if (errors.length) {
  console.error(`i18n check failed: ${errors.length} error(s); ${summary}`);
  process.exit(1);
}
console.log(`i18n check passed: ${summary}${warnings.length ? `, ${warnings.length} warning(s)` : ""}`);
