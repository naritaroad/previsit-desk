// The summary, one field at a time: what it says, where it came from, and an editor for that field only.

import { IconPencil, IconPlus, IconQuote, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { IntakeFieldKey, IntakeState, PrevisitSummary, SummaryChanges } from "@/api/types";
import { staleSummary, usePatchSummary } from "@/data";
import { intakeRows, isCoreField, summaryRows, type IntakeRow } from "@/lib/intake";
import { Button, Checkbox, DiffMergeDialog, Field, IconButton, Input, Textarea, toast } from "@/ui";

import { ActionError } from "../shared";

export const fieldKey = (key: string) => `field.${key.replace(".", "_")}`;
const LIST_FIELDS: ReadonlySet<string> = new Set(["past_history", "medications", "allergies"]);

function useRowText() {
  const { t } = useTranslation("patient");
  return (r: IntakeRow): { text: string; muted: boolean } => {
    if (r.status === "filled") return { text: r.value, muted: false };
    if (r.status === "none") return { text: t("sum.none"), muted: false };
    if (r.status === "na") return { text: t("sum.na"), muted: true };
    return { text: t("sum.missing"), muted: true };
  };
}

/** Rows while the conversation is going on: what the assistant has noted so far. Read only. */
export function IntakeFields({ state, onCorrect }: { state: IntakeState; onCorrect?: (label: string) => void }) {
  const { t } = useTranslation("patient");
  const text = useRowText();
  return (
    <dl>
      {intakeRows(state, t("common.listSep")).map((r) => {
        const v = text(r);
        if (r.status === "missing" && !isCoreField(r.key)) return null;
        return (
          <div key={r.key} className="sum-row">
            <dt>{t(fieldKey(r.key))}</dt>
            <dd className={v.muted ? "text-fg-3" : undefined}>{v.text}</dd>
            {onCorrect && r.status !== "missing" && (
              <dd className="sum-tools">
                <button type="button" className="link" onClick={() => onCorrect(t(fieldKey(r.key)))}>
                  <IconPencil size={16} aria-hidden />
                  {t("sum.tellCorrection")}
                </button>
              </dd>
            )}
          </div>
        );
      })}
    </dl>
  );
}

export function SummaryFields({ visitId, summary, editable, onJump }: { visitId: string; summary: PrevisitSummary; editable: boolean; onJump?: (messageId: string) => void }) {
  const { t } = useTranslation("patient");
  const text = useRowText();
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <dl>
      {summaryRows(summary, t("common.listSep")).map((r) =>
        editing === r.key ? (
          <div key={r.key} className="sum-row">
            <dt className="sr-only">{t(fieldKey(r.key))}</dt>
            <dd>
              <FieldEditor visitId={visitId} summary={summary} row={r} onClose={() => setEditing(null)} />
            </dd>
          </div>
        ) : (
          <div key={r.key} className="sum-row">
            <dt>{t(fieldKey(r.key))}</dt>
            <dd className={text(r).muted ? "text-fg-3" : undefined}>{text(r).text}</dd>
            {(editable || r.evidence.length > 0) && (
              <dd className="sum-tools no-print">
                {editable && (
                  <button type="button" className="link" onClick={() => setEditing(r.key)} aria-label={t("sum.editField", { field: t(fieldKey(r.key)) })}>
                    <IconPencil size={16} aria-hidden />
                    {t(r.status === "missing" ? "sum.add" : "sum.edit")}
                  </button>
                )}
                {onJump &&
                  r.evidence.slice(0, 3).map((id, i) => (
                    <button key={id} type="button" className="link" onClick={() => onJump(id)} aria-label={t("sum.fromField", { field: t(fieldKey(r.key)), n: i + 1 })}>
                      <IconQuote size={16} aria-hidden />
                      {r.evidence.length > 1 ? t("sum.fromN", { n: i + 1 }) : t("sum.from")}
                    </button>
                  ))}
              </dd>
            )}
          </div>
        ),
      )}
      <Questions visitId={visitId} summary={summary} editable={editable} />
    </dl>
  );
}

type Value = string | number | string[] | null;

/** One field's editor. A save that meets a newer summary asks which version to keep. */
function useFieldSave(visitId: string, summary: PrevisitSummary, onDone: () => void) {
  const { t } = useTranslation("patient");
  const patch = usePatchSummary(visitId);
  const [conflict, setConflict] = useState<{ key: string; mine: Value; current: PrevisitSummary } | null>(null);
  const save = (key: string, value: Value, revision = summary.revision) =>
    patch.mutate(
      { revision, changes: { [key]: value } as SummaryChanges },
      {
        onSuccess: () => {
          setConflict(null);
          toast.ok(t("sum.saved"));
          onDone();
        },
        onError: (e) => {
          const current = staleSummary(e);
          if (current) setConflict({ key, mine: value, current });
        },
      },
    );
  const show = (v: Value) => (Array.isArray(v) ? v.join(t("common.listSep")) : v === null ? "" : String(v));
  const theirs = (s: PrevisitSummary, key: string): Value => {
    if (key === "patient_questions" || key === "past_history" || key === "medications" || key === "allergies") return s[key];
    if (key === "chief_complaint") return s.chief_complaint;
    return s.hpi[key.slice(4) as keyof PrevisitSummary["hpi"]];
  };
  const dialog = conflict && (
    <DiffMergeDialog
      open
      onOpenChange={(o) => !o && setConflict(null)}
      fields={[{ key: conflict.key, label: t(fieldKey(conflict.key)), mine: show(conflict.mine), theirs: show(theirs(conflict.current, conflict.key)) }]}
      theirsLabel={t("sum.theirs")}
      busy={patch.isPending}
      onMerge={(choice) => {
        if (choice[conflict.key] === "mine") save(conflict.key, conflict.mine, conflict.current.revision);
        else {
          setConflict(null);
          onDone();
        }
      }}
    />
  );
  return { save, saving: patch.isPending, error: conflict ? null : patch.error, dialog };
}

function FieldEditor({ visitId, summary, row, onClose }: { visitId: string; summary: PrevisitSummary; row: IntakeRow; onClose: () => void }) {
  const { t } = useTranslation("patient");
  const { save, saving, error, dialog } = useFieldSave(visitId, summary, onClose);
  const key = row.key as IntakeFieldKey;
  const label = t(fieldKey(key));
  const list = LIST_FIELDS.has(key);
  const [textValue, setText] = useState(list ? (row.items ?? []).join("\n") : key === "hpi.severity" ? "" : row.value);
  const [none, setNone] = useState(list && row.status === "none");
  const [score, setScore] = useState<number | "n/a" | null>(key === "hpi.severity" ? summary.hpi.severity : null);
  const submit = () => {
    if (key === "hpi.severity") save(key, score);
    else if (list)
      save(
        key,
        none
          ? []
          : textValue
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
      );
    else save(key, textValue.trim() || null);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="grid gap-3"
    >
      {key === "hpi.severity" ? (
        <div className="field">
          <p className="field-label">{label}</p>
          <Scale value={typeof score === "number" ? score : null} onPick={setScore} label={label} />
          <Checkbox label={t("sum.notApplicable")} checked={score === "n/a"} onCheckedChange={(c) => setScore(c === true ? "n/a" : null)} />
        </div>
      ) : list ? (
        <>
          <Field label={label} hint={t("sum.onePerLine")} disabled={none}>
            <Textarea rows={3} value={textValue} onChange={(e) => setText(e.target.value)} autoFocus />
          </Field>
          <Checkbox label={t("sum.noneOfThese")} checked={none} onCheckedChange={(c) => setNone(c === true)} />
        </>
      ) : (
        <Field label={label}>
          <Textarea rows={2} value={textValue} onChange={(e) => setText(e.target.value)} autoFocus />
        </Field>
      )}
      <ActionError error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="sm" loading={saving}>
          {t("common.save")}
        </Button>
        <Button size="sm" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
      {dialog}
    </form>
  );
}

/** Questions for the doctor: the part of the summary only the patient can write. */
function Questions({ visitId, summary, editable }: { visitId: string; summary: PrevisitSummary; editable: boolean }) {
  const { t } = useTranslation("patient");
  const [text, setText] = useState("");
  const { save, saving, error, dialog } = useFieldSave(visitId, summary, () => setText(""));
  const items = summary.patient_questions;
  if (!editable && items.length === 0) return null;
  const add = () => {
    const q = text.trim();
    if (q) save("patient_questions", [...items, q]);
  };
  return (
    <div className="sum-row">
      <dt>{t("field.patient_questions")}</dt>
      <dd>
        {items.length > 0 && (
          <ul>
            {items.map((q, i) => (
              <li key={`${i}-${q}`} className="flex items-start gap-2">
                <span className="min-w-0 flex-1 py-1">{q}</span>
                {editable && (
                  <IconButton size="sm" label={t("sum.removeQuestion", { question: q })} onClick={() => save("patient_questions", items.filter((_, n) => n !== i))}>
                    <IconTrash size={18} aria-hidden />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {editable && (
          <form
            className="mt-2 grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Field label={t("sum.addQuestion")} hideLabel={items.length > 0}>
              <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("sum.questionExample")} />
            </Field>
            <div>
              <Button type="submit" size="sm" icon={<IconPlus aria-hidden />} loading={saving} disabled={text.trim() === ""}>
                {t("sum.addQuestionDo")}
              </Button>
            </div>
            <ActionError error={error} />
          </form>
        )}
        {dialog}
      </dd>
    </div>
  );
}

/** 0 to 10 as one row of keys; two rows on narrow phones. */
export function Scale({ value, onPick, label }: { value: number | null; onPick: (n: number) => void; label: string }) {
  const { t } = useTranslation("patient");
  return (
    <div>
      <div className="scale" role="group" aria-label={label}>
        {Array.from({ length: 11 }, (_, n) => (
          <button key={n} type="button" aria-pressed={value === n} onClick={() => onPick(n)}>
            {n}
          </button>
        ))}
      </div>
      <p className="scale-ends" aria-hidden="true">
        <span>{t("quick.scaleLow")}</span>
        <span>{t("quick.scaleHigh")}</span>
      </p>
    </div>
  );
}
