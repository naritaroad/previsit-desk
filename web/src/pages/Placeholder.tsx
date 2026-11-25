import { IconTools } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import { EmptyState, PageBody, PageHeader, Panel } from "@/ui";

/** Stands in until the page exists. Delete together with the last page that uses it. */
export function Placeholder({ page }: { page: string }) {
  const { t } = useTranslation("shell");
  return (
    <PageBody>
      <PageHeader title={t(`page.${page}`)} />
      <Panel flush>
        <EmptyState icon={<IconTools aria-hidden />} title={t("placeholder.title")}>
          {t("placeholder.body")}
        </EmptyState>
      </Panel>
    </PageBody>
  );
}
