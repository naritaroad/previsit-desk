import { IconArrowBackUp, IconLock, IconPencil, IconQuote } from "@tabler/icons-react";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Popover } from "./overlay";
import { cn } from "./cn";

/* ----- Subjective and objective lines: collected by the AI, each one traceable, each one editable ----- */

export function EvidenceList({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <ul className={cn("evidence", className)} aria-label={label}>
      {children}
    </ul>
  );
}

export interface EvidenceLineProps {
  children: ReactNode;
  /** Where it was said, e.g. "13:04". Jumps to the message. */
  at?: string;
  onJump?: () => void;
  /** The physician changed this line: who, when, and what the AI had written. */
  edited?: { by: string; at: string; original: string };
  onEdit?: () => void;
  onRestore?: () => void;
  /** Not answered by the patient. */
  missing?: boolean;
}

export function EvidenceLine({ children, at, onJump, edited, onEdit, onRestore, missing }: EvidenceLineProps) {
  const { t } = useTranslation("common");
  return (
    <li className="evidence-line" data-edited={Boolean(edited)} data-missing={missing}>
      <div className="min-w-0">
        <p>{children}</p>
        {edited && (
          <p className="evidence-edit">
            <IconPencil size={15} aria-hidden />
            {t("review.editedBy", { name: edited.by, time: edited.at })}
            <Popover
              label={t("review.original")}
              className="max-w-sm"
              trigger={
                <button type="button" className="link">
                  {t("review.original")}
                </button>
              }
            >
              <p className="text-sm text-fg-2">{t("review.originalNote")}</p>
              <p className="mt-1">{edited.original}</p>
              {onRestore && (
                <button type="button" className="link mt-3 inline-flex items-center gap-1" onClick={onRestore}>
                  <IconArrowBackUp size={16} aria-hidden />
                  {t("review.restore")}
                </button>
              )}
            </Popover>
          </p>
        )}
      </div>
      <span className="evidence-tools">
        {onEdit && (
          <button type="button" className="icon-btn evidence-pen" data-size="sm" aria-label={t("review.editLine")} onClick={onEdit}>
            <IconPencil size={17} aria-hidden />
          </button>
        )}
        {at && (
          <button type="button" className="link num inline-flex items-center gap-1 text-sm" onClick={onJump} aria-label={t("review.jump", { time: at })}>
            <IconQuote size={15} aria-hidden />
            {at}
          </button>
        )}
      </span>
    </li>
  );
}

/* ----- Assessment and plan: one sheet of paper, the physician's own hand ----- */

export interface NoteSheetProps {
  title: ReactNode;
  /** Who is writing, shown like the signature line of a chart. */
  author: ReactNode;
  status?: ReactNode;
  /** Signed: the sheet is locked and says so. */
  signed?: { by: string; at: string } | null;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function NoteSheet({ title, author, status, signed, children, footer, className }: NoteSheetProps) {
  const { t } = useTranslation("common");
  return (
    <section className={cn("note-sheet", className)} data-signed={Boolean(signed)} aria-label={typeof title === "string" ? title : undefined}>
      <header>
        <h2>{title}</h2>
        <span className="text-sm text-fg-2">{author}</span>
        {status && <span className="ms-auto">{status}</span>}
      </header>
      {children}
      {signed && (
        <p className="note-signed">
          <IconLock size={17} aria-hidden />
          {t("review.signed", { name: signed.by, time: signed.at })}
        </p>
      )}
      {footer && <footer>{footer}</footer>}
    </section>
  );
}

export interface NoteFieldProps {
  /** The margin letter: A, P. Omit for other sections. */
  mark?: string;
  label: string;
  hint?: ReactNode;
  value: string;
  onValueChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  readOnly?: boolean;
  /** "patient" marks the text the patient will read. */
  tone?: "clinical" | "patient";
}

export function NoteField({ mark, label, hint, value, onValueChange, placeholder, rows = 4, readOnly, tone = "clinical" }: NoteFieldProps) {
  const id = useId();
  const [focus, setFocus] = useState(false);
  return (
    <div className="note-field" data-tone={tone} data-focus={focus}>
      <label htmlFor={id}>
        {mark && (
          <span className="mark" aria-hidden="true">
            {mark}
          </span>
        )}
        <span>{label}</span>
      </label>
      <div className="min-w-0">
        {hint && (
          <p className="text-note text-fg-2" id={`${id}-h`}>
            {hint}
          </p>
        )}
        <textarea id={id} aria-describedby={hint ? `${id}-h` : undefined} value={value} rows={rows} readOnly={readOnly} placeholder={placeholder} style={{ minHeight: `calc(${rows} * var(--note-line))` }} onChange={(e) => onValueChange(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} />
      </div>
    </div>
  );
}
