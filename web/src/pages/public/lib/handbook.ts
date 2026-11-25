import type { HandbookEntry } from "@/api/types";

/** "§2.1" is the section number in the handbook; addresses use "2.1". */
export const sectionId = (section: string) => section.replace(/^§/, "");
export const handbookPath = (section: string) => `/handbook/${sectionId(section)}`;

export interface Chapter {
  title: string;
  items: HandbookEntry[];
}
export function chaptersOf(items: readonly HandbookEntry[]): Chapter[] {
  const out: Chapter[] = [];
  for (const e of items) {
    const last = out.at(-1);
    if (last && last.title === e.chapter) last.items.push(e);
    else out.push({ title: e.chapter, items: [e] });
  }
  return out;
}

/** Chapter 2 is the warning signs. */
export const isWarning = (section: string) => sectionId(section).startsWith("2.");

/** Text with its "§3.1" mentions taken out, so they can be links. */
export function withSections(text: string, known: ReadonlySet<string>): { text: string; section: string | null }[] {
  return text.split(/(§\d+\.\d+)/).flatMap((part) => (part ? [{ text: part, section: known.has(part) ? part : null }] : []));
}
