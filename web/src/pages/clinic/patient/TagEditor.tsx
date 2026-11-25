import { IconPlus, IconX } from "@tabler/icons-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/ui";

const MAX = 12;

/** Tags as chips; Enter adds, the cross removes. Saved at once. */
export function TagEditor({ tags, onChange }: { tags: string[]; onChange: (next: string[]) => void }) {
  const { t } = useTranslation("clinic");
  const id = useId();
  const [text, setText] = useState("");
  const add = () => {
    const tag = text.trim();
    if (tag && !tags.includes(tag) && tags.length < MAX) onChange([...tags, tag]);
    setText("");
  };
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {t("record.tags")}
      </label>
      {tags.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {tags.map((x) => (
            <li key={x} className="filter-chip">
              {x}
              <button type="button" aria-label={t("record.removeTag", { tag: x })} onClick={() => onChange(tags.filter((y) => y !== x))}>
                <IconX size={15} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input id={id} className="control min-w-0 flex-1" value={text} maxLength={20} disabled={tags.length >= MAX} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" icon={<IconPlus aria-hidden />} disabled={!text.trim() || tags.length >= MAX}>
          {t("record.addTag")}
        </Button>
      </form>
    </div>
  );
}
