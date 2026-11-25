import { IconCheck, IconChevronDown, IconSearch } from "@tabler/icons-react";
import { Command } from "cmdk";
import { Popover as RPopover } from "radix-ui";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "./cn";
import { usePortalWs } from "./hooks";

export interface ComboOption {
  value: string;
  label: string;
  /** Extra words that should match while typing (English name, district). */
  keywords?: string[];
  hint?: ReactNode;
  disabled?: boolean;
}

export interface ComboboxProps {
  value: string | null;
  onValueChange: (v: string) => void;
  options: ComboOption[];
  label: string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  /** Server-side search: called on every keystroke; local filtering is then off. */
  onSearch?: (q: string) => void;
  loading?: boolean;
  id?: string;
}

/** Searchable single choice: pharmacies, drugs, staff. Under about eight options use Select or RadioRows. */
export function Combobox({ value, onValueChange, options, label, placeholder, searchPlaceholder, emptyText, className, onSearch, loading, id }: ComboboxProps) {
  const { t } = useTranslation("common");
  const ws = usePortalWs();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <RPopover.Root open={open} onOpenChange={setOpen}>
      <RPopover.Trigger id={id} role="combobox" aria-expanded={open} aria-label={current ? `${label}: ${current.label}` : label} className={cn("control flex items-center justify-between gap-2 text-start", className)}>
        <span className={cn("truncate", !current && "text-fg-3")}>{current?.label ?? placeholder ?? t("field.choose")}</span>
        <IconChevronDown size={18} className="flex-none text-fg-2" aria-hidden />
      </RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content className="popup overflow-hidden" align="start" sideOffset={4} collisionPadding={12} style={{ width: "max(var(--radix-popover-trigger-width), 16rem)" }} {...ws}>
          <Command shouldFilter={!onSearch} label={label} loop>
            <div className="flex items-center gap-2 border-b border-rule px-3">
              <IconSearch size={18} className="flex-none text-fg-3" aria-hidden />
              <Command.Input placeholder={searchPlaceholder ?? t("action.search")} onValueChange={onSearch} className="h-ctl w-full min-w-0 bg-transparent outline-none placeholder:text-fg-3" />
              {loading && <span className="spinner text-fg-3" aria-hidden="true" />}
            </div>
            <Command.List className="max-h-72 overflow-y-auto overscroll-contain p-1">
              <Command.Empty className="px-3 py-4 text-fg-2">{emptyText ?? t("state.noMatch")}</Command.Empty>
              {options.map((o) => (
                <Command.Item
                  key={o.value}
                  value={o.value}
                  keywords={[o.label, ...(o.keywords ?? [])]}
                  disabled={o.disabled}
                  className="menu-item"
                  onSelect={() => {
                    onValueChange(o.value);
                    setOpen(false);
                  }}
                >
                  {o.value === value ? <IconCheck aria-hidden /> : <span aria-hidden="true" />}
                  <span className="min-w-0 py-1">
                    <span className="block">{o.label}</span>
                    {o.hint && <span className="block text-sm text-fg-2">{o.hint}</span>}
                  </span>
                  <span aria-hidden="true" />
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
