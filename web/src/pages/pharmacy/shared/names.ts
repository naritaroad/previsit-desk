import type { DrugRef, Locale, PersonRef } from "@/api/types";

/** Both names when they differ: pharmacists read the generic name, patients the Chinese one. */
export function drugName(d: Pick<DrugRef, "name_zh" | "name_en">, locale: Locale): string {
  if (locale === "en") return d.name_en || d.name_zh;
  return d.name_en && d.name_en !== d.name_zh ? `${d.name_zh} ${d.name_en}` : d.name_zh;
}
export function className(d: Pick<DrugRef, "class_zh" | "class_en">, locale: Locale): string {
  return locale === "en" ? d.class_en || d.class_zh : d.class_zh || d.class_en;
}
export function personName(p: Pick<PersonRef, "display_name" | "title">): string {
  return [p.display_name, p.title].filter(Boolean).join(" ");
}
