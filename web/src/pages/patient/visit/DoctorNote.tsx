import { useTranslation } from "react-i18next";

import type { ClinicalNote, Visit } from "@/api/types";
import { cn } from "@/ui";

import { useFmt } from "../shared";

/** The doctor's signed message. Patients get nothing else of the note. */
export function DoctorNote({ note, visit, className }: { note: ClinicalNote | null; visit: Visit; className?: string }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const body = note?.sections.patient_message?.trim();
  if (!note || note.status !== "signed") return null;
  const by = note.signed_by ?? visit.reviewed_by;
  return (
    <section className={cn("doctor-note", className)} aria-label={t("visit.doctorNote")}>
      <header>
        <h2 className="text-lg font-bold">{t("visit.doctorNote")}</h2>
        <p className="text-sm">
          {f.person(by)}
          <span className="num ms-2 text-fg-2">{f.dateTime(note.signed_at ?? visit.reviewed_at)}</span>
        </p>
      </header>
      <div>{body || t("visit.doctorNoteEmpty")}</div>
      {note.addenda.map((a, i) => (
        <div key={i} className="border-t border-rule">
          <p className="text-sm text-fg-2">{t("visit.addendum", { name: f.person(a.by), date: f.dateTime(a.at) })}</p>
          {a.body}
        </div>
      ))}
    </section>
  );
}
