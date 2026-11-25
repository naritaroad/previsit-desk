import { IconX } from "@tabler/icons-react";
import { AlertDialog as RAlert, Dialog as RDialog, DropdownMenu as RMenu, Popover as RPopover, Tooltip as RTooltip } from "radix-ui";
import { type ComponentProps, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Drawer } from "vaul";

import { cn } from "./cn";
import { useMediaQuery, usePortalWs } from "./hooks";

/* Portals leave the shell's DOM, so every popup carries the workspace and density of the shell it came from. */

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RTooltip.Provider delayDuration={450} skipDelayDuration={150}>
      {children}
    </RTooltip.Provider>
  );
}

export function Tooltip({ content, children, side = "bottom" }: { content: ReactNode; children: ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  const ws = usePortalWs();
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content className="tooltip" side={side} sideOffset={6} collisionPadding={8} {...ws}>
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, primary last. */
  footer?: ReactNode;
  width?: string;
  /** Hides the close button for flows that must be answered. */
  noClose?: boolean;
}

export function Dialog({ open, onOpenChange, trigger, title, description, children, footer, width, noClose }: DialogProps) {
  const { t } = useTranslation("common");
  const ws = usePortalWs();
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RDialog.Trigger asChild>{trigger}</RDialog.Trigger>}
      <RDialog.Portal>
        <RDialog.Overlay className="overlay" />
        <RDialog.Content className="dialog" style={{ "--dialog-w": width } as CSSProperties} {...(description ? {} : { "aria-describedby": undefined })} {...ws}>
          <div className="dialog-head">
            <div className="min-w-0 flex-1">
              <RDialog.Title className="dialog-title">{title}</RDialog.Title>
              {description && <RDialog.Description className="mt-1 text-fg-2">{description}</RDialog.Description>}
            </div>
            {!noClose && (
              <RDialog.Close className="icon-btn -me-2 -mt-1" data-size="sm" aria-label={t("action.close")}>
                <IconX size={20} aria-hidden />
              </RDialog.Close>
            )}
          </div>
          {children && <div className="dialog-body">{children}</div>}
          {footer && <div className="dialog-foot">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export interface ConfirmDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  /** Name the object and what happens, e.g. "Delete 3 readings?". */
  title: ReactNode;
  /** The consequence, e.g. whether it can be undone. */
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}

export function ConfirmDialog({ open, onOpenChange, trigger, title, description, confirmLabel, cancelLabel, destructive, busy, onConfirm, children }: ConfirmDialogProps) {
  const { t } = useTranslation("common");
  const ws = usePortalWs();
  return (
    <RAlert.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RAlert.Trigger asChild>{trigger}</RAlert.Trigger>}
      <RAlert.Portal>
        <RAlert.Overlay className="overlay" />
        <RAlert.Content className="dialog" style={{ "--dialog-w": "28rem" } as CSSProperties} {...ws}>
          <div className="dialog-head">
            <div>
              <RAlert.Title className="dialog-title">{title}</RAlert.Title>
              <RAlert.Description className="mt-1.5 text-fg-2">{description}</RAlert.Description>
            </div>
          </div>
          {children && <div className="dialog-body">{children}</div>}
          <div className="dialog-foot">
            <RAlert.Cancel className="btn" data-variant="secondary">
              {cancelLabel ?? t("action.cancel")}
            </RAlert.Cancel>
            <RAlert.Action
              className="btn"
              data-variant={destructive ? "destructive" : "primary"}
              aria-busy={busy || undefined}
              onClick={(e) => {
                if (busy) e.preventDefault();
                else onConfirm();
              }}
            >
              {busy && <span className="spinner" aria-hidden="true" />}
              {confirmLabel}
            </RAlert.Action>
          </div>
        </RAlert.Content>
      </RAlert.Portal>
    </RAlert.Root>
  );
}

export interface SheetProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  /** Keep the title for screen readers only (navigation sheets). */
  hideTitle?: boolean;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  side?: "right" | "left";
  width?: string;
  /** On phones a right sheet becomes a bottom sheet you can drag away. Default true. */
  bottomOnPhone?: boolean;
}

export function Sheet({ open, onOpenChange, trigger, title, hideTitle, description, children, footer, side = "right", width, bottomOnPhone = true }: SheetProps) {
  const { t } = useTranslation("common");
  const ws = usePortalWs();
  const phone = useMediaQuery("(max-width: 40rem)");
  if (phone && bottomOnPhone && side === "right") {
    return (
      <Drawer.Root open={open} onOpenChange={onOpenChange}>
        {trigger && <Drawer.Trigger asChild>{trigger}</Drawer.Trigger>}
        <Drawer.Portal>
          <Drawer.Overlay className="overlay" />
          <Drawer.Content className="sheet" data-side="bottom" aria-describedby={undefined} {...ws}>
            <div className="sheet-handle" aria-hidden="true" />
            <div className={hideTitle ? "sr-only" : "flex items-start gap-3 border-b border-rule px-5 py-3"}>
              <div className="min-w-0 flex-1">
                <Drawer.Title className="text-lg font-bold">{title}</Drawer.Title>
                {description && <p className="text-sm text-fg-2">{description}</p>}
              </div>
              <Drawer.Close className="icon-btn -me-2" data-size="sm" aria-label={t("action.close")}>
                <IconX size={20} aria-hidden />
              </Drawer.Close>
            </div>
            <div className="scroll-y min-h-0 flex-1 p-5">{children}</div>
            {footer && <div className="dialog-foot">{footer}</div>}
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RDialog.Trigger asChild>{trigger}</RDialog.Trigger>}
      <RDialog.Portal>
        <RDialog.Overlay className="overlay" />
        <RDialog.Content className="sheet" data-side={side} style={{ "--sheet-w": width } as CSSProperties} aria-describedby={undefined} {...ws}>
          <div className={hideTitle ? "sr-only" : "flex items-start gap-3 border-b border-rule px-5 py-3"}>
            <div className="min-w-0 flex-1">
              <RDialog.Title className="text-lg font-bold">{title}</RDialog.Title>
              {description && <p className="text-sm text-fg-2">{description}</p>}
            </div>
            <RDialog.Close className="icon-btn -me-2" data-size="sm" aria-label={t("action.close")}>
              <IconX size={20} aria-hidden />
            </RDialog.Close>
          </div>
          <div className={cn("scroll-y min-h-0 flex-1", !hideTitle && "p-5")}>{children}</div>
          {footer && <div className="dialog-foot">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export interface PopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Accessible name when the content has no heading. */
  label?: string;
}
export function Popover({ trigger, children, align = "start", side = "bottom", className, open, onOpenChange, label }: PopoverProps) {
  const ws = usePortalWs();
  return (
    <RPopover.Root open={open} onOpenChange={onOpenChange}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content className={cn("popup p-4", className)} align={align} side={side} sideOffset={6} collisionPadding={12} aria-label={label} {...ws}>
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
export const PopoverClose = RPopover.Close;

export interface MenuProps {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}
export function Menu({ trigger, children, align = "end", side = "bottom", className }: MenuProps) {
  const ws = usePortalWs();
  return (
    <RMenu.Root modal={false}>
      <RMenu.Trigger asChild>{trigger}</RMenu.Trigger>
      <RMenu.Portal>
        <RMenu.Content className={cn("popup menu", className)} align={align} side={side} sideOffset={6} collisionPadding={12} {...ws}>
          {children}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  );
}
export function MenuItem({ icon, children, shortcut, className, ...rest }: Omit<ComponentProps<typeof RMenu.Item>, "asChild"> & { icon?: ReactNode; shortcut?: ReactNode }) {
  return (
    <RMenu.Item className={cn("menu-item", className)} {...rest}>
      {icon ?? <span aria-hidden="true" />}
      <span className="truncate">{children}</span>
      {shortcut ?? <span aria-hidden="true" />}
    </RMenu.Item>
  );
}
/** A menu item that navigates: `<MenuLink render={(p) => <Link to="/x" {...p} />}>`. */
export function MenuLink({ icon, children, render }: { icon?: ReactNode; children: ReactNode; render: (props: { className: string; children: ReactNode }) => ReactElement }) {
  return (
    <RMenu.Item asChild>
      {render({
        className: "menu-item",
        children: (
          <>
            {icon ?? <span aria-hidden="true" />}
            <span className="truncate">{children}</span>
          </>
        ),
      })}
    </RMenu.Item>
  );
}
export function MenuRadioGroup({ label, value, onValueChange, options }: { label: string; value: string; onValueChange: (value: string) => void; options: { value: string; label: string }[] }) {
  return (
    <>
      <RMenu.Label className="menu-label">{label}</RMenu.Label>
      <RMenu.RadioGroup value={value} onValueChange={onValueChange}>
        {options.map((o) => (
          <RMenu.RadioItem key={o.value} value={o.value} className="menu-item" onSelect={(e) => e.preventDefault()}>
            <span className="check-box radio-dot mini-dot" data-state={o.value === value ? "checked" : "unchecked"} aria-hidden="true" />
            <span>{o.label}</span>
            <span aria-hidden="true" />
          </RMenu.RadioItem>
        ))}
      </RMenu.RadioGroup>
    </>
  );
}
export function MenuSeparator() {
  return <RMenu.Separator className="menu-sep" />;
}
export function MenuLabel({ children }: { children: ReactNode }) {
  return <RMenu.Label className="menu-label">{children}</RMenu.Label>;
}
