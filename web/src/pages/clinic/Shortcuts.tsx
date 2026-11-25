import { useTranslation } from "react-i18next";

import { Dialog, Kbd } from "@/ui";

/** Every plain-key shortcut of the workspace, in one place. Also shown in Settings. */
export const SHORTCUTS: readonly { group: string; items: readonly { keys: readonly string[]; label: string }[] }[] = [
  {
    group: "everywhere",
    items: [
      { keys: ["Ctrl", "K"], label: "search" },
      { keys: ["?"], label: "help" },
    ],
  },
  {
    group: "lists",
    items: [
      { keys: ["J"], label: "next" },
      { keys: ["K"], label: "previous" },
      { keys: ["Enter"], label: "open" },
      { keys: ["X"], label: "select" },
      { keys: ["A"], label: "assign" },
      { keys: ["/"], label: "find" },
    ],
  },
  {
    group: "desk",
    items: [
      { keys: ["Ctrl", "S"], label: "save" },
      { keys: ["1"], label: "summary" },
      { keys: ["2"], label: "transcript" },
      { keys: ["3"], label: "log" },
      { keys: ["Esc"], label: "back" },
    ],
  },
];

export function ShortcutTable() {
  const { t } = useTranslation("clinic");
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      {SHORTCUTS.map((g) => (
        <section key={g.group} aria-label={t(`keys.${g.group}`)}>
          <h3 className="mb-1 font-semibold">{t(`keys.${g.group}`)}</h3>
          <dl className="ledger">
            {g.items.map((i) => (
              <div key={i.label}>
                <dt>{t(`keys.do.${i.label}`)}</dt>
                <dd className="inline-flex gap-1">
                  {i.keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation("clinic");
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("keys.title")} width="40rem">
      <ShortcutTable />
    </Dialog>
  );
}
