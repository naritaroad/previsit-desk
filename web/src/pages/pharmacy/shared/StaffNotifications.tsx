import { IconChecks } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useMarkRead, useNotifications, useUnreadCount } from "@/data";
import { Button, EmptyState, LoadMore, NotificationList, PageBody, PageHeader, Panel, Segmented } from "@/ui";

import { LoadProblem } from "./problem";

/** The full list behind the bell. Opening a notification marks it read. */
export function StaffNotifications() {
  const { t } = useTranslation("pharmacy");
  const [view, setView] = useState("all");
  const unread = useUnreadCount();
  const list = useNotifications(view === "unread" ? { unread: true } : {});
  const read = useMarkRead();
  const shown = view === "unread" ? list.items.filter((n) => n.read_at === null) : list.items;
  return (
    <PageBody width="read">
      <PageHeader
        title={t("self.notifications")}
        actions={
          <Button icon={<IconChecks aria-hidden />} disabled={unread === 0} loading={read.isPending} onClick={() => read.mutate(undefined)}>
            {t("self.readAll")}
          </Button>
        }
      />
      <Segmented
        className="mb-4"
        label={t("self.notifFilter")}
        value={view}
        onValueChange={setView}
        options={[
          { value: "all", label: t("self.notifAll") },
          { value: "unread", label: t("self.notifUnread"), count: unread },
        ]}
      />
      <Panel flush>
        {list.isError && !list.data ? (
          <LoadProblem error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data && view === "unread" && shown.length === 0 ? (
          <EmptyState title={t("self.notifNoneUnread")} />
        ) : (
          <NotificationList items={list.data ? shown : undefined} onOpen={(n) => n.read_at === null && read.mutate([n.id])} />
        )}
        {list.hasNextPage && <LoadMore onLoad={() => void list.fetchNextPage()} loading={list.isFetchingNextPage} />}
      </Panel>
    </PageBody>
  );
}
