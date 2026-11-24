// Writes every UI string, one per line, so the copy can be linted as plain text:
//   node scripts/dump-copy.mjs [outDir]      (default: ./.copy-dump, git-ignored scratch)
// Produces zh-TW.txt and en.txt. Then, for example:
//   python hwlint.py .copy-dump/zh-TW.txt --genre ui
// Keys are not written, only values; {{placeholders}} are kept as they are.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const localeDir = join(root, "src", "i18n", "locales");
const outDir = process.argv[2] ?? join(root, ".copy-dump");

function values(obj, out = []) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") values(v, out);
    else out.push(String(v).replaceAll("\n", " ").trim());
  }
  return out;
}

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(localeDir).filter((n) => n.endsWith(".json"))) {
  const lines = values(JSON.parse(readFileSync(join(localeDir, f), "utf8")));
  writeFileSync(join(outDir, f.replace(/\.json$/, ".txt")), lines.join("\n") + "\n", "utf8");
  console.log(`${f}: ${lines.length} lines -> ${join(outDir, f.replace(/\.json$/, ".txt"))}`);
}
