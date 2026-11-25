import { IconSearch } from "@tabler/icons-react";
import { Command } from "cmdk";
import { Dialog as RDialog } from "radix-ui";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Kbd } from "./button";
import { useHotkey, usePortalWs } from "./hooks";

export interface CommandEntry {
  id: string;
  label: string;
  hint?: ReactNode;
  keywords?: string[];
  icon?: ReactNode;
  shortcut?: string;
  onSelect: () => void;
}
export interface CommandGroup {
  id: string;
  title: string;
  entries: CommandEntry[];
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: CommandGroup[];
  placeholder?: string;
  /** Records from the server (patients, requests). Called as the user types. */
  onQuery?: (q: string) => void;
  loading?: boolean;
}

/** Opens and closes without animation: it is used all day. */
export function CommandPalette({ open, onOpenChange, groups, placeholder, onQuery, loading }: CommandPaletteProps) {
  const { t } = useTranslation("common");
  const ws = usePortalWs();
  const [q, setQ] = useState("");
  useHotkey("mod+k", (e) => {
    e.preventDefault();
    onOpenChange(!open);
  });
  return (
    <RDialog.Root
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setQ("");
      }}
    >
      <RDialog.Portal>
        <RDialog.Overlay className="overlay [animation:none]" />
        <RDialog.Content className="command" aria-describedby={undefined} {...ws}>
          <RDialog.Title className="sr-only">{t("command.title")}</RDialog.Title>
          <Command label={t("command.title")} loop>
            <div className="command-input">
              <IconSearch size={20} aria-hidden />
              <Command.Input
                value={q}
                onValueChange={(v) => {
                  setQ(v);
                  onQuery?.(v);
                }}
                placeholder={placeholder ?? t("command.placeholder")}
              />
              {loading ? <span className="spinner text-fg-3" aria-hidden="true" /> : <Kbd>Esc</Kbd>}
            </div>
            <Command.List>
              <Command.Empty>{t("state.noMatch")}</Command.Empty>
              {groups
                .filter((g) => g.entries.length > 0)
                .map((g) => (
                  <Command.Group key={g.id} heading={g.title}>
                    {g.entries.map((e) => (
                      <Command.Item
                        key={e.id}
                        value={`${g.id}:${e.id}`}
                        keywords={[e.label, ...(e.keywords ?? [])]}
                        className="menu-item"
                        onSelect={() => {
                          onOpenChange(false);
                          setQ("");
                          e.onSelect();
                        }}
                      >
                        {e.icon ?? <span aria-hidden="true" />}
                        <span className="min-w-0 truncate">
                          {e.label}
                          {e.hint && <span className="ms-2 text-sm text-fg-2">{e.hint}</span>}
                        </span>
                        {e.shortcut ? <Kbd>{e.shortcut}</Kbd> : <span aria-hidden="true" />}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
            </Command.List>
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
