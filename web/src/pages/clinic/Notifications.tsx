import { IconBellOff, IconChecks } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import { useMarkRead, useNotifications, useUnreadCount } from "@/data";
import { internalLink } from "@/lib/links";
import { Button, EmptyState, LoadMore, NotificationList, PageBody, PageHeader, Panel, Segmented, toast } from "@/ui";

import { useErrorText, useUrlState } from "./lib";
import { PageError, StaleBar } from "./parts";

export default function Notifications() {
  const { t } = useTranslation(["clinic", "common"]);
  const errorText = useErrorText();
  const [url, set] = useUrlState({ show: "all" });
  const unreadOnly = url.show === "unread";
  const query = useNotifications(unreadOnly ? { unread: true } : {});
  const unread = useUnreadCount();
  const read = useMarkRead();
  const onError = (e: unknown) => toast.warn(errorText(e));
  // The server may not filter; what is read stays out of the unread view either way.
  const items = unreadOnly ? query.items.filter((n) => n.read_at === null) : query.items;
  return (
    <>
      <StaleBar query={query} />
      <PageBody width="read">
        <PageHeader
          title={t("common:notif.title")}
          lede={t("notif.lede")}
          actions={
            <>
              <Segmented
                label={t("notif.show")}
                value={url.show}
                onValueChange={(show) => set({ show })}
                options={[
                  { value: "all", label: t("notif.all") },
                  { value: "unread", label: t("notif.unread"), count: unread },
                ]}
              />
              <Button size="sm" icon={<IconChecks aria-hidden />} disabled={unread === 0} loading={read.isPending} onClick={() => read.mutate(undefined, { onError })}>
                {t("common:notif.readAll")}
              </Button>
            </>
          }
        />
        {query.isError && !query.data ? (
          <PageError error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <Panel flush>
            {query.data && items.length === 0 ? (
              <EmptyState icon={<IconBellOff aria-hidden />} title={t(unreadOnly ? "notif.noUnread" : "common:notif.emptyTitle")}>
                {t("notif.emptyBody")}
              </EmptyState>
            ) : (
              <NotificationList items={query.data ? items.map((n) => ({ ...n, link: internalLink(n.link) })) : undefined} onOpen={(n) => n.read_at === null && read.mutate([n.id], { onError })} />
            )}
            {query.hasNextPage && <LoadMore onLoad={() => void query.fetchNextPage()} loading={query.isFetchingNextPage} />}
          </Panel>
        )}
      </PageBody>
    </>
  );
}
