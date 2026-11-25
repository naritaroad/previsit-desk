import { useTranslation } from "react-i18next";

import type { PatientDetail } from "@/api/types";
import type { NoteEditor, VisitStreamHandle } from "@/data";

import { personLabel, useFmt } from "../lib";
import { AddendaList, NoteText } from "./NotePane";
import { lineGroups } from "./model";

/** The paper version: one document, no panes. Unsigned notes say so at the top. */
export function PrintNote({ v, ed, record, now }: { v: VisitStreamHandle; ed: NoteEditor; record: PatientDetail | undefined; now: Date }) {
  const { t } = useTranslation(["clinic", "common"]);
  const fmt = useFmt();
  const visit = v.visit;
  if (!visit || !ed.note || !ed.sections) return null;
  const allergies = record?.profile?.allergies.filter((a) => a.status === "active").map((a) => a.name) ?? [];
  const groups = v.summary ? lineGroups(v.summary, t("common:list.sep")) : [];
  return (
    <article className="print-only print-doc">
      <header>
        <h1>{t("print.title", { name: visit.patient.display_name })}</h1>
        <p>{t("print.demo")}</p>
        <dl className="dl">
          {[
            [t("print.patient"), [visit.patient.display_name, record?.row.age == null ? null : t("patient.age", { n: record.row.age }), record?.row.sex ? t(`patient.sex.${record.row.sex}`) : null].filter(Boolean).join(t("patient.dot"))],
            [t("print.visit"), [visit.title, visit.submitted_at && fmt.dateTime(visit.submitted_at)].filter(Boolean).join(t("patient.dot"))],
            [t("desk.allergies"), allergies.length ? fmt.list(allergies) : t("record.noAllergies")],
            [t("print.status"), ed.note.status === "signed" ? `${t("note.signedBy", { name: personLabel(ed.note.signed_by) })} ${fmt.dateTime(ed.note.signed_at)}` : t("print.unsigned")],
            [t("print.printed"), fmt.dateTime(now)],
          ].map(([k, value]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </header>
      {v.redFlag && <p className="font-bold">{t("flags.red", { label: v.redFlag.label })}</p>}
      <section>
        <h2>{t("desk.s")}</h2>
        {groups.map((g) => (
          <p key={g.id}>
            <b>{t(`desk.group.${g.id}`)}</b> {g.rows.map((r) => t("desk.lineOf", { label: t(`field.${r.key}`), value: r.status === "none" ? t("field.none") : r.value })).join(t("common:list.sentenceSep"))}
          </p>
        ))}
        <p>{t("desk.aiNote")}</p>
      </section>
      <section>
        <h2>{t("print.note")}</h2>
        <NoteText sections={ed.sections} />
      </section>
      {ed.note.addenda.length > 0 && (
        <section>
          <h2>{t("note.addenda")}</h2>
          <AddendaList note={ed.note} fmt={fmt} />
        </section>
      )}
    </article>
  );
}
