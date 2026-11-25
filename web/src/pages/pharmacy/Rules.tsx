import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useRules } from "@/data";
import { PageBody, PageHeader, SkeletonRows, Tabs, useLocale } from "@/ui";

import { LoadProblem } from "./shared/problem";
import { protocolView } from "./shared/rules";
import { ProtocolRules, RedFlagRules, RefillRules } from "./shared/RuleViews";

/** The rules behind what arrives at the counter: refill windows first, then the renewal checks and the red flags. */
export default function Rules() {
  const { t } = useTranslation("pharmacy");
  const locale = useLocale();
  const rules = useRules();
  const view = useMemo(() => (rules.data ? protocolView(rules.data.protocols, locale) : null), [rules.data, locale]);
  return (
    <PageBody>
      <PageHeader title={t("rules.title")} lede={t("rules.lede")} />
      {rules.isError && !rules.data ? (
        <LoadProblem error={rules.error} onRetry={() => void rules.refetch()} />
      ) : !rules.data || !view ? (
        <SkeletonRows rows={8} />
      ) : (
        <Tabs
          label={t("rules.title")}
          items={[
            { value: "refill", label: t("rules.refill"), count: rules.data.refill.length, content: <RefillRules rows={rules.data.refill} /> },
            { value: "protocols", label: t("rules.protocols"), count: view.classes.length, content: <ProtocolRules view={view} /> },
            { value: "red", label: t("rules.redFlags"), count: rules.data.red_flags.length, content: <RedFlagRules rows={rules.data.red_flags} /> },
          ]}
        />
      )}
    </PageBody>
  );
}
