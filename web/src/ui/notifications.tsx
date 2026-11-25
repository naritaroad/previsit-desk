import { IconBell, IconChecks } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { Notification } from "@/api/types";
import { formatRelative } from "@/lib/format";

import { EmptyState, SkeletonRows } from "./feedback";
import { useLocale } from "./locale";
import { Popover } from "./overlay";
import { CountBadge } from "./tag";

export interface NotificationListProps {
  items: Notification[] | undefined;
  onOpen?: (n: Notification) => void;
}

export function NotificationList({ items, onOpen }: NotificationListProps) {
  const { t } = useTranslation("common");
  const locale = useLocale();
  if (!items) return <SkeletonRows rows={4} />;
  if (items.length === 0) return <EmptyState title={t("notif.emptyTitle")}>{t("notif.emptyBody")}</EmptyState>;
  return (
    <ul>
      {items.map((n) => (
        <li key={n.id}>
          <Link to={n.link ?? "#"} className="notif" data-unread={n.read_at === null} onClick={() => onOpen?.(n)}>
            <span className="min-w-0">
              <span className="notif-title block">
                {n.read_at === null && <span className="sr-only">{t("notif.unread")}</span>}
                {n.title}
              </span>
              {n.body && <span className="line-clamp-2 block text-sm text-fg-2">{n.body}</span>}
              <time className="block text-sm text-fg-3" dateTime={n.created_at}>
                {formatRelative(n.created_at, locale)}
              </time>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function NotificationBell({ items, unread, onOpenItem, onReadAll, allHref, className }: NotificationListProps & { unread: number; onOpenItem?: (n: Notification) => void; onReadAll?: () => void; allHref: string; className?: string }) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label={t("notif.title")}
      className="flex max-h-[min(34rem,80dvh)] w-96 flex-col p-0"
      trigger={
        <button type="button" className={`icon-btn ${className ?? ""}`} aria-label={unread > 0 ? t("notif.bellUnread", { count: unread }) : t("notif.title")}>
          <IconBell size={22} aria-hidden />
          <span className="bell-count">
            <CountBadge count={unread} />
          </span>
        </button>
      }
    >
      <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-2.5">
        <h2 className="font-bold">{t("notif.title")}</h2>
        {unread > 0 && onReadAll && (
          <button type="button" className="link inline-flex items-center gap-1 text-sm" onClick={onReadAll}>
            <IconChecks size={18} aria-hidden />
            {t("notif.readAll")}
          </button>
        )}
      </div>
      <div className="scroll-y min-h-0 flex-1">
        <NotificationList
          items={items}
          onOpen={(n) => {
            setOpen(false);
            onOpenItem?.(n);
          }}
        />
      </div>
      <Link to={allHref} className="link border-t border-rule px-4 py-2.5 text-center text-sm" onClick={() => setOpen(false)}>
        {t("notif.all")}
      </Link>
    </Popover>
  );
}
