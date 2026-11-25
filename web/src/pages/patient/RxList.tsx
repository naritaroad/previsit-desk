import { IconFileText } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import type { RxKind } from "@/api/types";
import { useRxList, useSavedFilter } from "@/data";
import { isOpenRx } from "@/lib/rx";
import { Button, ButtonLink, DataTable, EmptyState, PageBody, PageHeader, Segmented, StatusTag } from "@/ui";

import { LoadError, StaleNote, useFmt } from "./shared";

export default function RxList() {
  const { t } = useTranslation(["patient", "rx"]);
  const f = useFmt();
  const [saved, setSaved] = useSavedFilter("patient_rx", { kind: "all" });
  const kind = saved.kind === "refill" || saved.kind === "renewal" ? (saved.kind as RxKind) : undefined;
  const list = useRxList(kind ? { kind } : {});
  const rows = [...list.items].sort((a, b) => Number(isOpenRx(b.status)) - Number(isOpenRx(a.status)));
  return (
    <PageBody>
      <PageHeader
        title={t("patient:rx.title")}
        lede={t("patient:rx.lede")}
        back={{ to: "/app/medications", label: t("patient:meds.title") }}
        actions={
          <ButtonLink to="/app/rx/new" variant="primary">
            {t("patient:rx.new")}
          </ButtonLink>
        }
      />
      <Segmented
        className="mb-stack"
        label={t("patient:rx.filter")}
        value={kind ?? "all"}
        onValueChange={(v) => setSaved({ kind: v })}
        options={[
          { value: "all", label: t("patient:rx.all") },
          { value: "refill", label: t("rx:kind.refill") },
          { value: "renewal", label: t("rx:kind.renewal") },
        ]}
      />
      <StaleNote query={list} />
      {list.error && !list.data ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : (
        <>
          <DataTable
            caption={t("patient:rx.title")}
            rows={list.data ? rows : undefined}
            loading={!list.data}
            rowKey={(r) => r.id}
            rowLink={(r) => (r.status === "draft" ? `/app/rx/${r.id}/edit` : `/app/rx/${r.id}`)}
            isUrgent={(r) => r.priority === "urgent" && isOpenRx(r.status)}
            empty={
              <EmptyState icon={<IconFileText aria-hidden />} title={t("patient:rx.none")} action={<ButtonLink to="/app/medications">{t("patient:meds.title")}</ButtonLink>}>
                {t("patient:rx.noneBody")}
              </EmptyState>
            }
            columns={[
              {
                id: "what",
                header: t("patient:rx.colWhat"),
                card: "title",
                cell: (r) => (
                  <>
                    <span className={r.unread ? "block font-bold" : "block font-semibold"}>
                      {r.unread && <span className="sr-only">{t("patient:rx.unread")}</span>}
                      {t(`rx:kind.${r.kind}`)}
                    </span>
                    <span className="block text-sm text-fg-2">{f.list(r.drug_names)}</span>
                  </>
                ),
              },
              { id: "status", header: t("patient:rx.colStatus"), card: "end", cell: (r) => <StatusTag family="rx" status={r.status} />, width: "9rem" },
              { id: "next", header: t("patient:rx.colNext"), cell: (r) => <span className="text-fg-2">{t(`rx:statusHint.${r.status}`)}</span>, hideBelow: "md" },
              { id: "no", header: t("patient:rx.colNo"), cell: (r) => <span className="num text-sm">{r.no}</span>, width: "12rem", hideBelow: "lg" },
              { id: "at", header: t("patient:rx.colUpdated"), cell: (r) => <span className="num">{f.relative(r.updated_at)}</span>, width: "8rem" },
            ]}
          />
          {list.hasNextPage && (
            <div className="mt-4">
              <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
                {t("patient:common.more")}
              </Button>
            </div>
          )}
        </>
      )}
    </PageBody>
  );
}
