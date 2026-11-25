import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "./button";
import { Dialog } from "./overlay";

export interface DiffField {
  key: string;
  label: string;
  mine: string;
  theirs: string;
}

export interface DiffMergeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Only the fields that differ. */
  fields: DiffField[];
  mineLabel?: ReactNode;
  /** Who and when, e.g. "陳柏宇 醫師，14:32". */
  theirsLabel: ReactNode;
  onMerge: (choice: Record<string, "mine" | "theirs">) => void;
  busy?: boolean;
}

/** Marks the part that changed: common prefix and suffix stay plain. */
function changed(text: string, other: string): [string, string, string] {
  const a = [...text];
  const b = [...other];
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return [a.slice(0, i).join(""), a.slice(i, a.length - j).join(""), a.slice(a.length - j).join("")];
}

/** A 409 conflict: the record changed while this draft was being edited. Nothing is thrown away until a choice is made. */
export function DiffMergeDialog({ open, onOpenChange, fields, mineLabel, theirsLabel, onMerge, busy }: DiffMergeDialogProps) {
  const { t } = useTranslation("common");
  const [choice, setChoice] = useState<Record<string, "mine" | "theirs">>({});
  const pick = (key: string) => choice[key];
  const left = fields.filter((f) => !pick(f.key)).length;
  const all = (side: "mine" | "theirs") => setChoice(Object.fromEntries(fields.map((f) => [f.key, side])));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("merge.title")}
      description={t("merge.body")}
      width="52rem"
      footer={
        <>
          <span className="me-auto self-center text-sm text-fg-2" role="status">
            {left > 0 ? t("merge.left", { count: left }) : t("merge.ready")}
          </span>
          <Button onClick={() => onOpenChange(false)}>{t("merge.later")}</Button>
          <Button variant="primary" disabled={left > 0} loading={busy} onClick={() => onMerge(choice)}>
            {t("merge.save")}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => all("mine")}>
          {t("merge.allMine")}
        </Button>
        <Button size="sm" onClick={() => all("theirs")}>
          {t("merge.allTheirs")}
        </Button>
      </div>
      {fields.map((f) => (
        <div key={f.key} className="diff-row">
          <p className="mb-2 font-semibold" id={`diff-${f.key}`}>
            {f.label}
          </p>
          <div className="diff-cols" role="radiogroup" aria-labelledby={`diff-${f.key}`}>
            {(["mine", "theirs"] as const).map((side) => {
              const [pre, mid, post] = side === "mine" ? changed(f.mine, f.theirs) : changed(f.theirs, f.mine);
              return (
                <button key={side} type="button" role="radio" aria-checked={pick(f.key) === side} className="diff-opt" onClick={() => setChoice({ ...choice, [f.key]: side })}>
                  <span className="mb-1 block text-sm text-fg-2">{side === "mine" ? (mineLabel ?? t("merge.mine")) : theirsLabel}</span>
                  {pre + mid + post === "" ? <span className="text-fg-3">{t("merge.blank")}</span> : null}
                  {pre}
                  {mid && <mark>{mid}</mark>}
                  {post}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </Dialog>
  );
}
