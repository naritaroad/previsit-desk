import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useRules } from "@/data";
import { formatDate } from "@/lib/format";
import { DescriptionList, PageBody, PageHeader, Panel, SkeletonRows, Tabs, useLocale } from "@/ui";

import { FormularyBrowser } from "../pharmacy/shared/FormularyBrowser";
import { LoadProblem } from "../pharmacy/shared/problem";
import { formularyRow, latest, protocolView } from "../pharmacy/shared/rules";
import { ProtocolRules, RedFlagRules, RefillRules, ScopeRules } from "../pharmacy/shared/RuleViews";

/** Every rule file, read only, with its version and how fresh its sources are. */
export default function Rules() {
  const { t } = useTranslation("admin");
  const locale = useLocale();
  const rules = useRules();
  const d = rules.data;
  const view = useMemo(() => (d ? protocolView(d.protocols, locale) : null), [d, locale]);
  const drugs = useMemo(() => d?.formulary.map(formularyRow), [d]);
  const checked = (date: string | null) => (date ? t("rulesPage.checked", { date: formatDate(date, locale, "short") }) : t("rulesPage.notChecked"));
  return (
    <PageBody>
      <PageHeader title={t("rulesPage.title")} lede={t("rulesPage.lede")} />
      {rules.isError && !d ? (
        <LoadProblem error={rules.error} onRetry={() => void rules.refetch()} />
      ) : !d || !view || !drugs ? (
        <SkeletonRows rows={10} />
      ) : (
        <>
          <Panel title={t("rulesPage.files")} className="mb-5">
            <DescriptionList
              items={[
                { label: t("rulesPage.red"), value: <File name="data/seed/red_flags.csv" text={t("rulesPage.rows", { count: d.red_flags.length })} /> },
                { label: t("rulesPage.scope"), value: <File name="data/seed/scope_rules.csv" text={t("rulesPage.rows", { count: d.scope.length })} /> },
                { label: t("rulesPage.refill"), value: <File name="data/seed/refill_rules.csv" text={[t("rulesPage.rows", { count: d.refill.length }), checked(latest(d.refill.map((r) => r.verified_on)))].join(t("pharmacy:sentenceGap"))} /> },
                {
                  label: t("rulesPage.protocols"),
                  value: <File name="data/seed/renewal_protocols.json" text={[t("rulesPage.version", { version: view.version }), t("rulesPage.classes", { count: view.classes.length }), checked(latest(view.classes.flatMap((c) => c.monitoring.map((m) => m.verifiedOn))))].join(t("pharmacy:sentenceGap"))} />,
                },
                { label: t("rulesPage.formulary"), value: <File name="data/seed/formulary.csv" text={[t("rulesPage.drugs", { count: drugs.length }), checked(latest(drugs.map((r) => r.verifiedOn)))].join(t("pharmacy:sentenceGap"))} /> },
              ]}
            />
            <p className="mt-3 text-sm text-fg-2">{t("rulesPage.change")}</p>
          </Panel>
          <Tabs
            label={t("rulesPage.title")}
            items={[
              { value: "red", label: t("rulesPage.red"), count: d.red_flags.length, content: <RedFlagRules rows={d.red_flags} /> },
              { value: "scope", label: t("rulesPage.scope"), count: d.scope.length, content: <ScopeRules rows={d.scope} /> },
              { value: "refill", label: t("rulesPage.refill"), count: d.refill.length, content: <RefillRules rows={d.refill} /> },
              { value: "protocols", label: t("rulesPage.protocols"), count: view.classes.length, content: <ProtocolRules view={view} /> },
              { value: "formulary", label: t("rulesPage.formulary"), count: drugs.length, content: <FormularyBrowser rows={drugs} /> },
            ]}
          />
        </>
      )}
    </PageBody>
  );
}

function File({ name, text }: { name: string; text: string }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-3">
      <span className="num">{text}</span>
      <code className="text-sm text-fg-2">{name}</code>
    </span>
  );
}
