// The trust documents: front matter, sections, references. The prose lives in src/content/trust and is not changed
// here; headings get numbers and language-independent ids ("s3", "s3-1") so a link or a reading position survives a
// change of language.

import type { Locale } from "@/api/types";
import index from "@/content/trust/index.json";

export interface DocEntry {
  order: number;
  slug: string;
  file: string;
  title: Record<Locale, string>;
  summary: Record<Locale, string>;
}
export const DOCS = index.documents as DocEntry[];
export const DOC_SET = { version: index.version, effective: index.effective, next_review: index.next_review };
export const REFERENCES_SLUG = "references-and-changelog";

/** Short names used by older links and the site footer. */
const ALIAS: Readonly<Record<string, string>> = {
  oversight: "human-oversight",
  "renewal-safety": "medication-renewal",
  privacy: "privacy-and-data",
  evidence: "evaluation",
  references: REFERENCES_SLUG,
  changelog: REFERENCES_SLUG,
};
export function resolveSlug(slug: string): { doc: DocEntry | null; redirect: string | null } {
  const direct = DOCS.find((d) => d.slug === slug);
  if (direct) return { doc: direct, redirect: null };
  const target = DOCS.find((d) => d.slug === ALIAS[slug]);
  // The changelog is the last section of its document.
  return target ? { doc: null, redirect: `/trust/${target.slug}${slug === "changelog" ? "#s3" : ""}` } : { doc: null, redirect: null };
}

export interface Heading {
  id: string;
  no: string;
  title: string;
  level: 2 | 3;
}
export interface TrustDoc {
  slug: string;
  order: number;
  meta: Record<string, string>;
  /** Markdown without front matter and without comments. */
  body: string;
  headings: Heading[];
}

const FRONT = /^---\n([\s\S]*?)\n---\n/;
const LINK_DEF = /^\[r\d+\]:.*$/gm;

export function stripComments(md: string): string {
  return md.replace(/ ?<!--[\s\S]*?-->/g, "");
}

/** Lines outside fenced code, so "# comment" in a shell block is not a heading. */
function proseLines(body: string): string[] {
  let fence = false;
  return body.split("\n").map((l) => {
    if (/^\s*(```|~~~)/.test(l)) {
      fence = !fence;
      return "";
    }
    return fence ? "" : l;
  });
}

export function headingsOf(body: string, order: number): Heading[] {
  const out: Heading[] = [];
  let h2 = 0;
  let h3 = 0;
  for (const line of proseLines(body)) {
    const m = /^(##|###) (.+?)\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === "##") {
      h2 += 1;
      h3 = 0;
      out.push({ id: `s${h2}`, no: `${order}.${h2}`, title: m[2], level: 2 });
    } else {
      h3 += 1;
      out.push({ id: `s${h2}-${h3}`, no: `${order}.${h2}.${h3}`, title: m[2], level: 3 });
    }
  }
  return out;
}

export function parseDoc(raw: string, entry: Pick<DocEntry, "slug" | "order">): TrustDoc {
  const text = raw.replaceAll("\r\n", "\n");
  const front = FRONT.exec(text);
  const meta: Record<string, string> = {};
  for (const line of front?.[1].split("\n") ?? []) {
    const i = line.indexOf(":");
    if (i > 0)
      meta[line.slice(0, i).trim()] = line
        .slice(i + 1)
        .trim()
        .replace(/^"(.*)"$/, "$1");
  }
  const body = stripComments(front ? text.slice(front[0].length) : text).trim();
  return { slug: entry.slug, order: entry.order, meta, body, headings: headingsOf(body, entry.order) };
}

const files = import.meta.glob<string>("../../../content/trust/*/*.md", { query: "?raw", import: "default" });
const cache = new Map<string, Promise<TrustDoc>>();

export function loadDoc(entry: DocEntry, locale: Locale): Promise<TrustDoc> {
  const key = `${locale}/${entry.file}`;
  let p = cache.get(key);
  if (!p) {
    const load = files[`../../../content/trust/${key}`];
    p = load ? load().then((raw) => parseDoc(raw, entry)) : Promise.reject(new Error(`missing ${key}`));
    // A chunk that failed to load is tried again next time.
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}
export function loadAll(locale: Locale): Promise<TrustDoc[]> {
  return Promise.all(DOCS.map((d) => loadDoc(d, locale)));
}

/* ----- references ----- */

/** Numbered entries of the first section of the references document. */
export function referencesOf(doc: TrustDoc): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of proseLines(doc.body)) {
    if (/^## /.test(line) && out.size > 0) break;
    const m = /^(\d+)\. (.+)$/.exec(line);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}
/** Reference numbers cited as [text][r12], in order of first use. */
export function citedIn(doc: Pick<TrustDoc, "body">): number[] {
  return [...new Set([...doc.body.matchAll(/\]\[r(\d+)\]/g)].map((m) => Number(m[1])))];
}
/** "[ref. 3][r3]" becomes a link to the note at the foot of the page. */
export function linkReferences(body: string): string {
  return body
    .replace(LINK_DEF, "")
    .replace(/\[([^\][]+)\]\[r(\d+)\]/g, "[$1](#fn-$2)")
    .trimEnd();
}

/* ----- text for search ----- */

export interface Section {
  id: string;
  no: string;
  title: string;
  text: string;
}
/** Plain text per heading, for searching and snippets. */
export function sectionsOf(doc: TrustDoc, fact: (key: string) => string = () => ""): Section[] {
  const out: Section[] = [];
  let i = -1;
  let fence = false;
  let buffer: string[] = [];
  const flush = () => {
    const h = doc.headings[i];
    const text = buffer
      .filter((l) => !/^\|[\s:|-]+\|$/.test(l.trim()) && !/^\[r\d+\]:/.test(l))
      .join(" ")
      .replace(/\{\{facts\.(\w+)\}\}/g, (_, k: string) => fact(k))
      .replace(/\[([^\][]+)\](?:\[[^\]]*\]|\([^)]*\))/g, "$1")
      .replace(/[`*|>]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (h && text) out.push({ id: h.id, no: h.no, title: h.title, text });
    buffer = [];
  };
  for (const line of doc.body.split("\n")) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (!fence && /^#{2,3} /.test(line)) {
      flush();
      i += 1;
      continue;
    }
    buffer.push(line.replace(/^\s*(?:[-*]|\d+\.) /, ""));
  }
  flush();
  return out;
}
