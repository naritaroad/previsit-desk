import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useFormulary } from "@/data";
import { PageBody, PageHeader } from "@/ui";

import { FormularyBrowser } from "./shared/FormularyBrowser";
import { formularyRow } from "./shared/rules";

export default function Formulary() {
  const { t } = useTranslation("pharmacy");
  const list = useFormulary();
  useEffect(() => {
    if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
  }, [list]);
  const rows = useMemo(() => (list.data ? list.items.map(formularyRow) : undefined), [list.data, list.items]);
  return (
    <PageBody>
      <PageHeader title={t("formulary.title")} lede={t("formulary.lede")} />
      <FormularyBrowser rows={rows} error={list.isError} onRetry={() => void list.refetch()} />
    </PageBody>
  );
}
