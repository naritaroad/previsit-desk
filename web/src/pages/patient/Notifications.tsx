import { IconBell, IconCalendar, IconChecks, IconMessageCircle, IconPill } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { Notification } from "@/api/types";
import { useMarkRead, useNotifications, useSavedFilter, useUnreadCount } from "@/data";
import { isInternalLink, notificationGroup } from "@/lib/links";
import { Button, EmptyState, PageBody, PageHeader, Segmented, SkeletonRows, toast } from "@/ui";

import { LoadError, StaleNote, useErrorText, useFmt } from "./shared";

const ICONS = { visit: IconMessageCircle, rx: IconPill, appointment: IconCalendar, ticket: IconBell, emergency: IconBell, other: IconBell };

export default function Notifications() {
  const { t } = useTranslation("patient");
  const [saved, setSaved] = useSavedFilter("patient_notifications", { box: "all" });
  const unreadOnly = saved.box === "unread";
  const list = useNotifications(unreadOnly ? { unread: true } : {});
  const unread = useUnreadCount();
  const mark = useMarkRead();
  const errorText = useErrorText();
  return (
    <PageBody width="read">
      <PageHeader
        title={t("notif.title")}
        actions={
          unread > 0 ? (
            <Button icon={<IconChecks aria-hidden />} loading={mark.isPending} onClick={() => mark.mutate(undefined, { onError: (e) => toast.warn(errorText(e)) })}>
              {t("notif.readAll")}
            </Button>
          ) : undefined
        }
      />
      <Segmented
        className="mb-stack"
        label={t("notif.filter")}
        value={unreadOnly ? "unread" : "all"}
        onValueChange={(box) => setSaved({ box })}
        options={[
          { value: "all", label: t("notif.all") },
          { value: "unread", label: t("notif.unread"), count: unread },
        ]}
      />
      <StaleNote query={list} />
      {list.error && !list.data ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : !list.data ? (
        <SkeletonRows rows={5} />
      ) : list.items.length === 0 ? (
        <EmptyState icon={<IconBell aria-hidden />} title={t(unreadOnly ? "notif.noneUnread" : "notif.none")}>
          {t("notif.noneBody")}
        </EmptyState>
      ) : (
        <>
          <ul className="row-list">
            {list.items.map((n) => (
              <Row key={n.id} item={n} onOpen={() => n.read_at === null && mark.mutate([n.id])} />
            ))}
          </ul>
          {list.hasNextPage && (
            <div className="mt-4">
              <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
                {t("common.more")}
              </Button>
            </div>
          )}
        </>
      )}
    </PageBody>
  );
}

function Row({ item: n, onOpen }: { item: Notification; onOpen: () => void }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const Icon = ICONS[notificationGroup(n.kind)];
  const body = (
    <>
      <Icon size={24} className="mt-0.5 flex-none self-start text-ink-text" aria-hidden />
      <span className="row-main">
        <span className="row-title">
          {n.read_at === null && <span className="sr-only">{t("visits.unread")}</span>}
          {n.title}
        </span>
        {n.body && <span className="row-sub">{n.body}</span>}
        <time className="row-sub num" dateTime={n.created_at}>
          {f.relative(n.created_at)}
        </time>
      </span>
      {n.read_at === null && <span className="unread-mark" aria-hidden="true" />}
    </>
  );
  return (
    <li className="row-item">
      {isInternalLink(n.link) ? (
        <Link to={n.link} className="row-link" data-unread={n.read_at === null} onClick={onOpen}>
          {body}
        </Link>
      ) : (
        <div className="row-link" data-unread={n.read_at === null}>
          {body}
        </div>
      )}
    </li>
  );
}
