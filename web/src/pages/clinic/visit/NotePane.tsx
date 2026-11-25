import { IconChevronDown, IconFileCheck, IconHistory, IconPencilPlus } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { ClinicalNoteSections, NoteSection, PrevisitSummary } from "@/api/types";
import { useMe, type NoteEditor } from "@/data";
import { Badge, Banner, Button, Field, NoteField, NoteSheet, Popover, SkeletonRows, StatusTag, Textarea, cn, toast } from "@/ui";

import { changed, diffText } from "../diff";
import { NOTE_MAX, personLabel, useErrorText, useFmt, type Fmt } from "../lib";
import { DiffView, RoleNote } from "../parts";
import { draftFromSummary } from "./model";

/**
 * The sections as the AI first drafted them. The API only sends them while nothing is stored (revision 0), so they are
 * kept in the account's query cache from then on; for a note stored before, S is composed again from the summary.
 */
function useAiDraft(visitId: string, ed: NoteEditor, summary: PrevisitSummary | null): Partial<Record<NoteSection, { text: string; rebuilt: boolean }>> {
  const { t, i18n } = useTranslation("clinic");
  const qc = useQueryClient();
  const key = useMemo(() => ["visits", "ai-draft", visitId], [visitId]);
  const note = ed.note;
  useEffect(() => {
    if (note?.revision === 0) qc.setQueryData(key, { subjective: note.sections.subjective, objective: note.sections.objective });
  }, [note, qc, key]);
  const kept = qc.getQueryData<Pick<ClinicalNoteSections, "subjective" | "objective">>(key) ?? (note?.revision === 0 ? note.sections : undefined);
  return useMemo(() => {
    if (kept) return { subjective: { text: kept.subjective, rebuilt: false }, objective: { text: kept.objective, rebuilt: false } };
    if (!summary) return {};
    return { subjective: { text: draftFromSummary(summary, (k, p) => t(k, p ?? {}), i18n.resolvedLanguage === "en"), rebuilt: true } };
  }, [kept, summary, t, i18n.resolvedLanguage]);
}

export interface NotePaneProps {
  visitId: string;
  ed: NoteEditor;
  summary: PrevisitSummary | null;
  canSign: boolean;
  canEdit: boolean;
  errors: Partial<Record<NoteSection, string>>;
  /** Bottom actions. */
  children?: ReactNode;
}

/** Right pane: the note. S and O start from the AI's draft, A, P and the message are a blank page for the physician. */
export function NotePane({ visitId, ed, summary, canSign, canEdit, errors, children }: NotePaneProps) {
  const { t } = useTranslation("clinic");
  const me = useMe();
  const draft = useAiDraft(visitId, ed, summary);
  if (ed.loading || !ed.sections) return <div className="min-h-full bg-surface p-pane">{ed.error ? <NoteError error={ed.error} /> : <SkeletonRows rows={6} />}</div>;
  if (ed.note?.status === "signed") return <SignedNote ed={ed} canSign={canSign} />;
  const s = ed.sections;
  return (
    <div className="flex min-h-full flex-col bg-surface">
      <div className="grid flex-1 content-start gap-5 p-pane">
        {(["subjective", "objective"] as const).map((k) => (
          <DraftSection key={k} section={k} value={s[k]} draft={draft[k]} readOnly={!canEdit} onChange={(v) => ed.set(k, v)} />
        ))}
        {canSign ? (
          <div className="sheet-frame">
            <NoteSheet title={t("note.sheet")} author={t("note.writtenBy", { name: personLabel(me) })} status={<StatusTag family="note" status="draft" />}>
              {(["assessment", "plan", "patient_message"] as const).map((k) => {
                const error = errors[k] ?? (over(s[k]) ? t("note.tooLong", { max: NOTE_MAX }) : undefined);
                return (
                  <div key={k} id={`note-${k}`}>
                    <NoteField
                      mark={k === "assessment" ? "A" : k === "plan" ? "P" : undefined}
                      tone={k === "patient_message" ? "patient" : "clinical"}
                      label={t(`note.${k}`)}
                      hint={error ? <span className="font-semibold text-warn">{error}</span> : t(`note.hint.${k}`)}
                      rows={k === "patient_message" ? 3 : 4}
                      value={s[k]}
                      onValueChange={(v) => ed.set(k, v)}
                    />
                  </div>
                );
              })}
            </NoteSheet>
          </div>
        ) : (
          <>
            <RoleNote>{t("note.physicianOnly")}</RoleNote>
            {(["assessment", "plan", "patient_message"] as const).map((k) => (
              <div key={k}>
                <h3 className="field-label">{t(`note.${k}`)}</h3>
                <p className={cn("whitespace-pre-wrap", !s[k] && "text-fg-3")}>{s[k] || t("note.blank")}</p>
              </div>
            ))}
          </>
        )}
        {canSign && s.patient_message.trim() && <MessagePreview text={s.patient_message} />}
      </div>
      {children}
    </div>
  );
}

const over = (text: string) => [...text].length > NOTE_MAX;

function NoteError({ error }: { error: Error }) {
  const text = useErrorText();
  return <Banner tone="warn">{text(error)}</Banner>;
}

/** Collapsed to a few lines: the same words are in the middle pane. Opens to edit, with what changed since the draft. */
function DraftSection({ section, value, draft, readOnly, onChange }: { section: "subjective" | "objective"; value: string; draft?: { text: string; rebuilt: boolean }; readOnly: boolean; onChange: (v: string) => void }) {
  const { t } = useTranslation("clinic");
  const [open, setOpen] = useState(false);
  const [compare, setCompare] = useState(false);
  const parts = useMemo(() => (draft ? diffText(draft.text.trim(), value.trim()) : []), [draft, value]);
  const edited = changed(parts);
  return (
    <section className="draft-section" aria-label={t(`note.${section}`)}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="field-label">{t(`note.${section}`)}</h3>
        <Badge tone={edited ? "info" : "mute"}>{t(edited ? "note.edited" : "note.aiDraft")}</Badge>
        <span className="ms-auto flex flex-wrap gap-x-3">
          {edited && (
            <button type="button" className="link text-sm" aria-pressed={compare} onClick={() => setCompare(!compare)}>
              {t(compare ? "note.hideDiff" : "note.showDiff")}
            </button>
          )}
          <button type="button" className="link inline-flex items-center gap-1 text-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
            {t(readOnly ? (open ? "note.less" : "note.more") : open ? "note.closeEdit" : "note.openEdit")}
            <IconChevronDown size={16} className={cn("transition-transform", open && "rotate-180")} aria-hidden />
          </button>
        </span>
      </div>
      {compare && edited ? (
        <>
          <DiffView parts={parts} label={t("note.diffLabel")} />
          <p className="mt-1 flex flex-wrap items-center gap-x-4 text-sm text-fg-2">
            <span>{t("note.diffKey")}</span>
            {draft?.rebuilt && <span>{t("note.rebuilt")}</span>}
            {!readOnly && (
              <button type="button" className="link" onClick={() => onChange(draft?.text ?? "")}>
                {t("note.restore")}
              </button>
            )}
          </p>
        </>
      ) : null}
      {open && !readOnly ? (
        <Textarea rows={7} className="mt-2" aria-label={t(`note.${section}`)} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        !compare && <p className={cn("mt-1 whitespace-pre-wrap text-fg-2", !open && "line-clamp-3")}>{value || t("note.blank")}</p>
      )}
    </section>
  );
}

/** What arrives in the patient's app, signed with a name. */
function MessagePreview({ text }: { text: string }) {
  const { t } = useTranslation("clinic");
  return (
    <details className="text-sm">
      <summary className="link inline">{t("note.preview")}</summary>
      <div className="preview-card">
        <p className="mb-1 font-semibold">{t("note.previewTitle")}</p>
        <p className="whitespace-pre-wrap">{text}</p>
      </div>
    </details>
  );
}

export function HistoryPopover({ ed }: { ed: NoteEditor }) {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const items = [...(ed.note?.history ?? [])].sort((a, b) => b.version - a.version || b.at.localeCompare(a.at));
  if (items.length === 0) return null;
  return (
    <Popover
      align="end"
      label={t("note.history")}
      className="w-80"
      trigger={
        <Button size="sm" variant="quiet" icon={<IconHistory aria-hidden />}>
          {t("note.version", { n: ed.note?.version || items[0].version })}
        </Button>
      }
    >
      <h2 className="mb-1 font-bold">{t("note.history")}</h2>
      <ul className="divide-y divide-rule">
        {items.map((h, i) => (
          <li key={`${h.version}-${i}`} className="flex items-baseline justify-between gap-3 py-1.5">
            <span>
              <span className="num font-semibold">{t("note.version", { n: h.version })}</span>
              <span className="block text-sm text-fg-2">{personLabel(h.by) || t("note.unknown")}</span>
            </span>
            <time className="num text-sm text-fg-2" dateTime={h.at}>
              {fmt.stamp(h.at)}
            </time>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-fg-2">{t("note.historyNote")}</p>
    </Popover>
  );
}

function SignedNote({ ed, canSign }: { ed: NoteEditor; canSign: boolean }) {
  const { t } = useTranslation(["clinic", "errors"]);
  const fmt = useFmt();
  const errorText = useErrorText();
  const note = ed.note!;
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    if (!text.trim()) return setError(t("errors:field.required"));
    setError(null);
    try {
      await ed.addendum(text.trim());
      setText("");
      toast.ok(t("note.addendumDone"));
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="grid min-h-full content-start gap-5 bg-surface p-pane">
      <Banner tone="ok" icon={<IconFileCheck aria-hidden />} title={t("note.signedBy", { name: personLabel(note.signed_by) })}>
        {t("note.signedAt", { time: fmt.dateTime(note.signed_at) })} {t("note.locked")}
      </Banner>
      <NoteText sections={note.sections} />
      <section aria-label={t("note.addenda")}>
        <h3 className="field-label mb-1">{t("note.addenda")}</h3>
        {note.addenda.length === 0 && <p className="text-fg-2">{t("note.noAddenda")}</p>}
        <AddendaList note={note} fmt={fmt} />
      </section>
      {canSign ? (
        <Field label={t("note.addendum")} hint={t("note.addendumHint")} error={error}>
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          <Button className="mt-2 justify-self-start" icon={<IconPencilPlus aria-hidden />} loading={ed.addingAddendum} onClick={() => void add()}>
            {t("note.addAddendum")}
          </Button>
        </Field>
      ) : (
        <RoleNote>{t("note.addendumPhysician")}</RoleNote>
      )}
    </div>
  );
}

export function AddendaList({ note, fmt }: { note: NonNullable<NoteEditor["note"]>; fmt: Fmt }) {
  return (
    <ul className="grid gap-2">
      {note.addenda.map((a, i) => (
        <li key={`${a.at}-${i}`} className="staff-note">
          <span>
            <span className="block whitespace-pre-wrap">{a.body}</span>
            <span className="text-sm text-fg-2">
              {personLabel(a.by)} {fmt.dateTime(a.at)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function NoteText({ sections }: { sections: ClinicalNoteSections }) {
  const { t } = useTranslation("clinic");
  return (
    <>
      {(["subjective", "objective", "assessment", "plan", "patient_message"] as const).map((k) => (
        <section key={k} aria-label={t(`note.${k}`)}>
          <h3 className="field-label mb-1">{t(`note.${k}`)}</h3>
          <p className={cn("whitespace-pre-wrap", !sections[k] && "text-fg-3")}>{sections[k] || t("note.blank")}</p>
        </section>
      ))}
    </>
  );
}
