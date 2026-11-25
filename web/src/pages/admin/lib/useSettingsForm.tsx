import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "@/api/errors";
import type { AdminSettings } from "@/api/types";
import { staleSettings, useLeaveGuard, useSaveSettings, useSettings } from "@/data";
import { joinList } from "@/lib/format";
import { Banner, Button, DiffMergeDialog, toast, useLocale } from "@/ui";

import { Problem } from "../../pharmacy/shared/problem";
import { useAuditText } from "./audit";
import { changedPaths, leaves, mergeSettings, setLeaf, validate, type Merge } from "./settings";

interface Edit {
  base: AdminSettings;
  mine: AdminSettings;
}

/** Edits of the one settings object. Saved as a whole with its revision; a 409 is merged path by path. */
export function useSettingsForm(models?: readonly string[]) {
  const { t } = useTranslation("admin");
  const { t: te } = useTranslation("errors");
  const query = useSettings();
  const save = useSaveSettings();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [clash, setClash] = useState<{ theirs: AdminSettings; merge: Merge; mine: AdminSettings } | null>(null);
  const [taken, setTaken] = useState<string[]>([]);

  const value = edit?.mine ?? query.data;
  const dirty = useMemo(() => (edit ? changedPaths(edit.base, edit.mine) : []), [edit]);
  const problems = useMemo(() => (value ? validate(value, models) : {}), [value, models]);
  const newer = edit && query.data && query.data.revision > edit.base.revision ? query.data : null;
  useLeaveGuard("admin-settings", dirty.length > 0);

  const set = useCallback(
    (path: string, v: unknown) => {
      setEdit((e) => {
        const from = e ?? (query.data ? { base: query.data, mine: query.data } : null);
        if (!from) return null;
        const mine = setLeaf(from.mine, path, v);
        return changedPaths(from.base, mine).length === 0 ? null : { base: from.base, mine };
      });
    },
    [query.data],
  );

  /** Put my edits on top of a newer version; true when nothing needs a choice. */
  const rebase = (theirs: AdminSettings, from: Edit): boolean => {
    const merge = mergeSettings(from.base, from.mine, theirs);
    if (merge.conflicts.length > 0) {
      setClash({ theirs, merge, mine: from.mine });
      return false;
    }
    setTaken(merge.theirs);
    setEdit(changedPaths(theirs, merge.merged).length > 0 ? { base: theirs, mine: merge.merged } : null);
    return true;
  };
  const submit = (next: Edit | null = edit) => {
    if (!next) return;
    save.mutate(
      { ...next.mine, revision: next.base.revision },
      {
        onSuccess: () => {
          setEdit(null);
          setTaken([]);
          setClash(null);
          toast.ok(t("settings.saved"));
        },
        onError: (e) => {
          const theirs = staleSettings(e);
          if (theirs) rebase(theirs, next);
        },
      },
    );
  };
  /** One change saved at once, on the newest version, without the other edits on the page. */
  const saveNow = (path: string, v: unknown, done: () => void) => {
    if (!query.data) return;
    save.mutate(setLeaf(query.data, path, v), {
      onSuccess: (saved) => {
        if (edit) rebase(saved, { base: edit.base, mine: setLeaf(edit.mine, path, v) });
        done();
      },
    });
  };

  const serverFields = save.error instanceof ApiError ? save.error.fields : {};
  const errorOf = (path: string): string | undefined => {
    const p = problems[path];
    if (p) return p.code === "required" ? te("field.number") : t(`problem.${p.code}`, { min: p.min, max: p.max });
    return serverFields[path];
  };

  return {
    query,
    value,
    set,
    dirty,
    problems,
    errorOf,
    submit,
    saveNow,
    saving: save.isPending,
    error: save.error && !staleSettings(save.error) ? save.error : null,
    discard: () => {
      setEdit(null);
      setTaken([]);
      save.reset();
    },
    newer,
    takeNewer: () => newer && edit && rebase(newer, edit),
    clash,
    closeClash: () => setClash(null),
    resolve: (choice: Record<string, "mine" | "theirs">) => {
      if (!clash) return;
      const m = leaves(clash.mine);
      const th = leaves(clash.theirs);
      let mine = clash.merge.merged;
      for (const p of clash.merge.conflicts) mine = setLeaf(mine, p, choice[p] === "mine" ? m[p] : th[p]);
      setEdit({ base: clash.theirs, mine });
      submit({ base: clash.theirs, mine });
    },
    taken,
  };
}
export type SettingsForm = ReturnType<typeof useSettingsForm>;

export function useSettingValue() {
  const { t } = useTranslation("admin");
  return useCallback(
    (path: string, v: unknown): string => {
      if (v === undefined) return t("settings.absent");
      if (v === null) return path === "ai.monthly_budget_usd" ? t("settings.noLimit") : t("settings.none");
      if (typeof v === "boolean") return t(v ? "system.on" : "system.off");
      if (path === "ai.on_budget") return t(`onBudget.${String(v)}`, { defaultValue: String(v) });
      if (path === "ai.thinking") return t(`thinking.${String(v)}`, { defaultValue: String(v) });
      if (typeof v === "object") {
        const p = v as { in?: number; out?: number };
        return t("settings.price", { in: p.in ?? "", out: p.out ?? "" });
      }
      return String(v);
    },
    [t],
  );
}

/** What is unsaved, saving, refused or changed elsewhere; stays at the bottom while the form is long. */
export function SaveBar({ form }: { form: SettingsForm }) {
  const { t } = useTranslation("admin");
  const locale = useLocale();
  const words = useAuditText();
  const show = useSettingValue();
  const bad = Object.keys(form.problems).length;
  return (
    <>
      <div className="mt-4 grid gap-3 empty:hidden">
        {form.newer && !form.clash && (
          <Banner tone="info" title={t("settings.newer")} actions={<Button size="sm" onClick={form.takeNewer}>{t("settings.takeNewer")}</Button>}>
            {t("settings.newerBody")}
          </Banner>
        )}
        {form.taken.length > 0 && (
          <Banner tone="info" title={t("settings.merged")}>
            {t("settings.mergedBody", { list: joinList(form.taken.map(words.setting), locale) })}
          </Banner>
        )}
        {form.error ? <Problem error={form.error} onRetry={() => form.submit()} /> : null}
      </div>
      {form.dirty.length > 0 && (
        <div className="save-bar" role="region" aria-label={t("settings.unsaved")}>
          <p className="min-w-0 flex-1 basis-64">
            <b>{t("settings.unsavedN", { count: form.dirty.length })}</b>{" "}
            <span className="text-sm text-fg-2">{joinList(form.dirty.map(words.setting), locale)}</span>
            {bad > 0 && <span className="block text-sm text-warn">{t("settings.fixFirst", { count: bad })}</span>}
          </p>
          <Button onClick={form.discard}>{t("settings.discard")}</Button>
          <Button variant="primary" disabled={bad > 0} loading={form.saving} onClick={() => form.submit()}>
            {t("settings.save")}
          </Button>
        </div>
      )}
      {form.clash && (
        <DiffMergeDialog
          open
          onOpenChange={(o) => !o && form.closeClash()}
          theirsLabel={t("settings.theirs", { revision: form.clash.theirs.revision })}
          fields={form.clash.merge.conflicts.map((p) => ({ key: p, label: words.setting(p), mine: show(p, leaves(form.clash!.mine)[p]), theirs: show(p, leaves(form.clash!.theirs)[p]) }))}
          onMerge={form.resolve}
          busy={form.saving}
        />
      )}
    </>
  );
}
