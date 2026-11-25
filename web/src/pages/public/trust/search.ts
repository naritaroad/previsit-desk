// Full-text search over the trust documents, in the page: twelve documents are small enough to scan on every key.

import { type Section, sectionsOf, type TrustDoc } from "./docs";

export interface SearchEntry extends Section {
  slug: string;
  order: number;
  docTitle: string;
}
export interface Piece {
  text: string;
  hit: boolean;
}
export interface SearchHit extends SearchEntry {
  score: number;
  snippet: Piece[];
}

const fold = (s: string) => s.normalize("NFKC").toLowerCase();

export function buildIndex(docs: TrustDoc[], titleOf: (slug: string) => string, fact?: (k: string) => string): SearchEntry[] {
  return docs.flatMap((d) => sectionsOf(d, fact).map((s) => ({ ...s, slug: d.slug, order: d.order, docTitle: titleOf(d.slug) })));
}

export function termsOf(query: string): string[] {
  return [...new Set(fold(query).split(/[\s，、,;；]+/).filter(Boolean))];
}

function countOf(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n += 1;
  return n;
}

/** Cut around the first hit and mark every term. Folding can change lengths, so text is folded per character. */
export function snippetOf(text: string, terms: string[], radius = 46): Piece[] {
  const chars = [...text];
  const starts: number[] = [];
  let flat = "";
  for (const c of chars) {
    starts.push(flat.length);
    flat += fold(c);
  }
  const charAt = (pos: number) => {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > pos) i -= 1;
    return i;
  };
  const marks = new Array<boolean>(chars.length).fill(false);
  let first = -1;
  for (const t of terms) {
    for (let p = flat.indexOf(t); p !== -1; p = flat.indexOf(t, p + t.length)) {
      const a = charAt(p);
      const b = charAt(p + t.length - 1);
      for (let i = a; i <= b; i++) marks[i] = true;
      if (first === -1 || a < first) first = a;
    }
  }
  const from = Math.max(0, (first === -1 ? 0 : first) - radius);
  const to = Math.min(chars.length, from + radius * 3);
  const out: Piece[] = [];
  for (let i = from; i < to; i++) {
    const last = out.at(-1);
    if (last && last.hit === marks[i]) last.text += chars[i];
    else out.push({ text: chars[i], hit: marks[i] });
  }
  if (from > 0) out.unshift({ text: "…", hit: false });
  if (to < chars.length) out.push({ text: "…", hit: false });
  return out;
}

/** Sections that contain every term; titles weigh more, longer sections less. */
export function search(entries: SearchEntry[], query: string): SearchHit[] {
  const terms = termsOf(query);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const e of entries) {
    const title = fold(`${e.docTitle} ${e.title}`);
    const text = fold(e.text);
    let score = 0;
    let all = true;
    for (const t of terms) {
      const inTitle = countOf(title, t);
      const inText = countOf(text, t);
      if (inTitle + inText === 0) {
        all = false;
        break;
      }
      score += inTitle * 12 + Math.min(inText, 6) * (1 + 300 / (300 + text.length));
    }
    if (all) hits.push({ ...e, score, snippet: snippetOf(e.text, terms) });
  }
  return hits.sort((a, b) => b.score - a.score || a.order - b.order);
}
