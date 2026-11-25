import { IconAlertTriangle, IconArrowsDiff, IconCircleCheck, IconCloudCheck, IconCloudOff, IconCloudUp, IconInfoCircle, IconMailForward, IconPhoneCall, IconRefresh } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Toaster as SonnerToaster, toast as sonner } from "sonner";

import { Button } from "./button";
import { cn, type Tone } from "./cn";
import { usePortalWs } from "./hooks";

const TONE_ICON: Record<Tone, typeof IconInfoCircle> = {
  mute: IconInfoCircle,
  info: IconInfoCircle,
  ink: IconInfoCircle,
  ok: IconCircleCheck,
  warn: IconAlertTriangle,
  hold: IconMailForward,
  danger: IconPhoneCall,
};

export interface BannerProps {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  /** Edge to edge, under a page header. */
  bleed?: boolean;
  /** `alert` interrupts a screen reader; leave off unless the user must know now. */
  role?: "status" | "alert" | "note";
  className?: string;
}

/** A state of the page the reader should know about: offline, overdue, draft restored. */
export function Banner({ tone = "info", title, children, actions, icon, bleed, role = "status", className }: BannerProps) {
  const Icon = TONE_ICON[tone];
  return (
    <div className={cn("banner", className)} data-tone={tone} data-bleed={bleed} role={role}>
      {icon ?? <Icon aria-hidden />}
      <div className="min-w-0">
        {title && <p className="banner-title">{title}</p>}
        {children && <div className={cn(title ? "text-fg-2" : undefined)}>{children}</div>}
      </div>
      {actions && <div className="banner-actions">{actions}</div>}
    </div>
  );
}

/** A note inside content. Not live, not an alert. */
export function Callout(props: Omit<BannerProps, "role" | "bleed">) {
  return <Banner {...props} role="note" />;
}

export function EmptyState({ icon, title, children, action, className }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("empty", className)}>
      {icon}
      <div className="empty-title">{title}</div>
      {children && <div className="max-w-[26em]">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ title, children, onRetry, retrying, className }: { title?: ReactNode; children?: ReactNode; onRetry?: () => void; retrying?: boolean; className?: string }) {
  const { t } = useTranslation("common");
  return (
    <div className={cn("empty", className)} role="alert">
      <IconAlertTriangle aria-hidden />
      <div className="empty-title">{title ?? t("error.loadTitle")}</div>
      <div className="max-w-[26em]">{children ?? t("error.loadBody")}</div>
      {onRetry && (
        <Button className="mt-2" icon={<IconRefresh aria-hidden />} onClick={onRetry} loading={retrying}>
          {t("action.retry")}
        </Button>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span className={cn("skeleton h-4 w-full", className)} aria-hidden="true" />;
}

/** Placeholder rows with the height of real ones, so nothing jumps when data arrives. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  const { t } = useTranslation("common");
  return (
    <div className={className} role="status" aria-label={t("state.loading")}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-row items-center gap-4 border-b border-rule px-cell-x">
          <Skeleton className="w-1/5" />
          <Skeleton className={["w-2/5", "w-1/3", "w-1/2"][i % 3]} />
          <Skeleton className="ms-auto w-16" />
        </div>
      ))}
    </div>
  );
}

export function Spinner({ label, className }: { label?: string; className?: string }) {
  const { t } = useTranslation("common");
  return (
    <span className={cn("inline-flex items-center gap-2 text-fg-2", className)} role="status">
      <span className="spinner" aria-hidden="true" />
      <span className={label ? undefined : "sr-only"}>{label ?? t("state.loading")}</span>
    </span>
  );
}

export function Progress({ value, max = 100, label, className }: { value: number; max?: number; label: string; className?: string }) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div className={cn("progress", className)} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <span style={{ transform: `scaleX(${ratio})` }} />
    </div>
  );
}

export type SaveStatus = "saved" | "saving" | "offline" | "conflict" | "error";

/** Where the draft is. Goes in the header of anything that saves by itself. */
export function SaveState({ state, savedAt, onResolve, className }: { state: SaveStatus; savedAt?: string; onResolve?: () => void; className?: string }) {
  const { t } = useTranslation("common");
  const Icon = { saved: IconCloudCheck, saving: IconCloudUp, offline: IconCloudOff, conflict: IconArrowsDiff, error: IconAlertTriangle }[state];
  return (
    <span className={cn("save-state", className)} data-state={state === "error" ? "conflict" : state} role="status">
      <Icon aria-hidden />
      {state === "saved" && savedAt ? t("save.savedAt", { time: savedAt }) : t(`save.${state}`)}
      {onResolve && (state === "conflict" || state === "error") && (
        <button type="button" className="link ms-1" onClick={onResolve}>
          {state === "conflict" ? t("save.resolve") : t("action.retry")}
        </button>
      )}
    </span>
  );
}

/* ----- Toasts: confirmations that need no answer. Errors that block the task go inline instead. ----- */

export function Toaster() {
  const { t } = useTranslation("common");
  const ws = usePortalWs();
  return (
    <div {...ws}>
      <SonnerToaster position="bottom-center" offset={{ bottom: "calc(1.25rem + var(--safe-b))" }} mobileOffset={{ bottom: "calc(5rem + var(--safe-b))" }} containerAriaLabel={t("a11y.toasts")} toastOptions={{ unstyled: true, style: { width: "min(26rem, calc(100vw - 2rem))" } }} />
    </div>
  );
}

interface ToastOptions {
  action?: { label: string; onClick: () => void };
  duration?: number;
  id?: string;
}

function show(tone: "ok" | "warn" | "info", message: string, o: ToastOptions = {}) {
  const Icon = TONE_ICON[tone];
  return sonner.custom(
    (id) => (
      <div className="toast">
        <Icon aria-hidden />
        <span>{message}</span>
        {o.action && (
          <button
            type="button"
            onClick={() => {
              o.action!.onClick();
              sonner.dismiss(id);
            }}
          >
            {o.action.label}
          </button>
        )}
      </div>
    ),
    { duration: o.duration ?? (o.action ? 8000 : 4500), id: o.id },
  );
}

export const toast = {
  ok: (message: string, o?: ToastOptions) => show("ok", message, o),
  warn: (message: string, o?: ToastOptions) => show("warn", message, o),
  info: (message: string, o?: ToastOptions) => show("info", message, o),
  dismiss: (id?: string | number) => sonner.dismiss(id),
};
