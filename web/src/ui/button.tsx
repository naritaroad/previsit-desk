import { Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { Link as RouterLink, type LinkProps as RouterLinkProps } from "react-router";

import { cn } from "./cn";
import { Tooltip } from "./overlay";

export type ButtonVariant = "primary" | "secondary" | "soft" | "ghost" | "quiet" | "destructive" | "emergency";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonLook {
  /** One `primary` per view. `destructive` is black ink, `emergency` (red) only for 119/1925 actions. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  icon?: ReactNode;
  iconEnd?: ReactNode;
}

export interface ButtonProps extends Omit<ComponentProps<"button">, "children">, ButtonLook {
  children: ReactNode;
  /** Keeps the label, swaps the icon for a spinner and ignores clicks; focus stays on the button. */
  loading?: boolean;
}

export function Button({ variant = "secondary", size = "md", block, icon, iconEnd, loading, className, children, onClick, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn("btn", className)}
      data-variant={variant}
      data-size={size}
      data-block={block}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={loading ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : icon}
      <span className="min-w-0">{children}</span>
      {iconEnd}
    </button>
  );
}

/** Looks like a button, navigates like a link. */
export function ButtonLink({ variant = "secondary", size = "md", block, icon, iconEnd, className, children, ...rest }: Omit<RouterLinkProps, "children"> & ButtonLook & { children: ReactNode }) {
  return (
    <RouterLink className={cn("btn", className)} data-variant={variant} data-size={size} data-block={block} {...rest}>
      {icon}
      <span className="min-w-0">{children}</span>
      {iconEnd}
    </RouterLink>
  );
}

/** Same look on any element, e.g. `<ButtonSlot variant="emergency"><a href="tel:119">`. */
export function ButtonSlot({ variant = "secondary", size = "md", block, className, ...rest }: ComponentProps<typeof Slot.Root> & ButtonLook) {
  return <Slot.Root className={cn("btn", className)} data-variant={variant} data-size={size} data-block={block} {...rest} />;
}

export interface IconButtonProps extends Omit<ComponentProps<"button">, "children"> {
  /** Required: the accessible name, also shown as a tooltip. */
  label: string;
  children: ReactNode;
  variant?: "plain" | "bordered" | "primary";
  size?: "sm" | "md";
  pressed?: boolean;
  tooltip?: boolean;
  tooltipSide?: "top" | "right" | "bottom" | "left";
}

export function IconButton({ label, children, variant = "plain", size = "md", pressed, tooltip = true, tooltipSide = "bottom", className, type = "button", ...rest }: IconButtonProps) {
  const button = (
    <button type={type} aria-label={label} aria-pressed={pressed} className={cn("icon-btn", className)} data-variant={variant} data-size={size} {...rest}>
      {children}
    </button>
  );
  return tooltip ? (
    <Tooltip content={label} side={tooltipSide}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}

export function TextLink({ className, quiet, ...rest }: RouterLinkProps & { quiet?: boolean }) {
  return <RouterLink className={cn("link", className)} data-quiet={quiet} {...rest} />;
}

/** Outside links open in a new tab and carry no referrer. */
export function ExternalLink({ className, ...rest }: ComponentProps<"a">) {
  return <a className={cn("link", className)} rel="noreferrer noopener" target="_blank" {...rest} />;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn("kbd", className)}>{children}</kbd>;
}
