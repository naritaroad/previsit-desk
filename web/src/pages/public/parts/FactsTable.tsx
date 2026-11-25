import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useTrustFacts } from "@/data";
import { formatDate, formatTime } from "@/lib/format";
import { EvidenceTable, Skeleton, TextLink, useLocale } from "@/ui";

import { useResumed } from "../lib/live";

/** The numbers the server states about itself, each with where to check it and what it does not show. */
export function FactsTable() {
  const { t } = useTranslation("public");
  const locale = useLocale();
  const q = useResumed(useTrustFacts());
  const f = q.data;
  const row = (no: string, slug: string, key: "eval" | "redFlags" | "formulary" | "oversight" | "retention", claim: string | null): { no: string; claim: ReactNode; evidence: ReactNode; limits: ReactNode } => ({
    no,
    claim: claim ?? (q.isPending ? <Skeleton className="w-4/5" /> : <span className="text-fg-3">{t("home.trust.unavailable")}</span>),
    evidence: <TextLink to={`/trust/${slug}#${no}`}>{t(`home.trust.rows.${key}.evidence`)}</TextLink>,
    limits: t(`home.trust.rows.${key}.limits`),
  });
  return (
    <div className="facts">
      <EvidenceTable
        caption={t("home.trust.caption")}
        rows={[
          row("C-33", "evaluation", "eval", f?.eval ? t("home.trust.rows.eval.claim", { total: f.eval.total, passed: f.eval.passed, date: formatDate(f.eval.ran_at, locale, "long"), model: f.eval.model }) : null),
          row("C-10", "clinical-safety", "redFlags", f ? t("home.trust.rows.redFlags.claim", { n: f.red_flag_rules }) : null),
          row("C-21", "medication-renewal", "formulary", f ? t("home.trust.rows.formulary.claim", { a: f.formulary_counts.in_scope, b: f.formulary_counts.physician_only, c: f.formulary_counts.excluded }) : null),
          row("C-16", "human-oversight", "oversight", f ? t("home.trust.rows.oversight.claim", { phase: f.oversight_phase }) : null),
          row("C-27", "privacy-and-data", "retention", f ? t("home.trust.rows.retention.claim", { n: f.retention_days }) : null),
        ]}
      />
      <p className="facts-note" role="status">
        {f ? t("home.trust.readAt", { time: formatTime(q.dataUpdatedAt, locale) }) : q.isError ? t("home.trust.failed") : t("home.trust.loading")}
      </p>
    </div>
  );
}
