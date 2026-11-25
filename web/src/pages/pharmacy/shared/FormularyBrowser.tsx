import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatDate } from "@/lib/format";
import { safeExternalUrl } from "@/lib/links";
import { Badge, Callout, DataTable, DescriptionList, EmptyState, ExternalLink, FilterBar, NativeSelect, Panel, SearchInput, Segmented, Sheet, StatusTag, useLocale } from "@/ui";

import { className, drugName } from "./names";
import { countBy, type FormularyRow, latest } from "./rules";

const SCOPES = ["in_scope", "physician_only", "excluded"] as const;

/** Every medicine the system knows, what may be requested online, why, and where that comes from. */
export function FormularyBrowser({ rows, error, onRetry }: { rows: FormularyRow[] | undefined; error?: boolean; onRetry?: () => void }) {
  const { t } = useTranslation("pharmacy");
  const { t: tr } = useTranslation("rx");
  const locale = useLocale();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("all");
  const [cls, setCls] = useState("all");
  const [open, setOpen] = useState<FormularyRow | null>(null);

  const all = useMemo(() => rows ?? [], [rows]);
  const counts = useMemo(() => countBy(all, (r) => r.scope), [all]);
  const classes = useMemo(() => [...new Map(all.map((r) => [r.class_id, className(r, locale)])).entries()].sort((a, b) => a[1].localeCompare(b[1], "zh-Hant")), [all, locale]);
  const needle = q.trim().toLowerCase();
  const shown = all.filter(
    (r) =>
      (scope === "all" || (scope === "controlled" ? r.controlled_level > 0 : r.scope === scope)) &&
      (cls === "all" || r.class_id === cls) &&
      (!needle || `${r.drug_id} ${r.name_zh} ${r.name_en} ${r.class_zh} ${r.class_en} ${r.reason}`.toLowerCase().includes(needle)),
  );
  const verified = latest(all.map((r) => r.verifiedOn));
  const clear = () => {
    setQ("");
    setScope("all");
    setCls("all");
  };

  return (
    <>
      <Segmented
        className="mb-4"
        label={t("formulary.scope")}
        value={scope}
        onValueChange={setScope}
        options={[
          { value: "all", label: t("formulary.all"), count: rows ? all.length : undefined },
          ...SCOPES.map((s) => ({ value: s as string, label: tr(`scope.${s}`), count: rows ? (counts[s] ?? 0) : undefined })),
          { value: "controlled", label: t("formulary.controlled"), count: rows ? all.filter((r) => r.controlled_level > 0).length : undefined },
        ]}
      />
      <Panel flush>
        <FilterBar
          search={<SearchInput value={q} onValueChange={setQ} placeholder={t("formulary.search")} />}
          chips={cls === "all" ? [] : [{ key: "cls", label: classes.find(([id]) => id === cls)?.[1] ?? cls, onRemove: () => setCls("all") }]}
          onClearAll={clear}
        >
          <NativeSelect aria-label={t("formulary.class")} value={cls} onChange={(e) => setCls(e.target.value)} className="max-w-72">
            <option value="all">{t("formulary.allClasses")}</option>
            {classes.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </NativeSelect>
        </FilterBar>
        <DataTable
          caption={t("formulary.caption")}
          rows={rows ? shown : undefined}
          loading={!rows && !error}
          error={error}
          onRetry={onRetry}
          rowKey={(r) => r.drug_id}
          onRowOpen={setOpen}
          selectedKey={open?.drug_id ?? null}
          total={all.length}
          empty={<EmptyState title={t("formulary.none")}>{t("formulary.noneBody")}</EmptyState>}
          columns={[
            { id: "n", header: t("formulary.drug"), cell: (r) => <span className="font-semibold">{drugName(r, locale)}</span>, sortValue: (r) => (locale === "en" ? r.name_en : r.name_zh), card: "title", width: "17rem" },
            { id: "s", header: t("formulary.scope"), cell: (r) => <StatusTag family="scope" status={r.scope} />, sortValue: (r) => SCOPES.indexOf(r.scope), card: "end", width: "11rem" },
            { id: "l", header: t("formulary.level"), cell: (r) => <Level level={r.controlled_level} />, sortValue: (r) => r.controlled_level, width: "8rem" },
            { id: "c", header: t("formulary.class"), cell: (r) => className(r, locale), sortValue: (r) => className(r, locale), hideBelow: "lg", width: "15rem" },
            { id: "r", header: t("formulary.reason"), cell: (r) => r.reason },
          ]}
        />
      </Panel>
      {rows && (
        <p className="mt-3 max-w-[46em] text-sm text-fg-2">
          {verified ? t("formulary.verified", { date: formatDate(verified, locale, "short") }) : t("formulary.noVerified")} {t("formulary.source")}
        </p>
      )}
      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpen(null)} title={open ? drugName(open, locale) : ""} description={open ? className(open, locale) : undefined}>
        {open && <DrugDetail row={open} />}
      </Sheet>
    </>
  );
}

function Level({ level }: { level: number }) {
  const { t } = useTranslation("pharmacy");
  return level > 0 ? <Badge tone="hold">{t("formulary.levelN", { n: level })}</Badge> : <span className="text-fg-3">{t("formulary.levelNone")}</span>;
}

function DrugDetail({ row }: { row: FormularyRow }) {
  const { t } = useTranslation("pharmacy");
  const { t: tr } = useTranslation("rx");
  const locale = useLocale();
  const url = safeExternalUrl(row.sourceUrl);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        <StatusTag family="scope" status={row.scope} />
        {row.controlled_level > 0 && <Level level={row.controlled_level} />}
      </div>
      <p>{row.reason}</p>
      <p className="text-sm text-fg-2">{tr(`scopeHint.${row.scope}`)}</p>
      <DescriptionList
        items={[
          { label: t("formulary.id"), value: <code className="text-sm">{row.drug_id}</code> },
          { label: t("formulary.form"), value: row.form && t(`formulary.forms.${row.form}`, { defaultValue: row.form }) },
          { label: t("formulary.strengths"), value: row.strengths.length > 0 ? <span className="num">{row.strengths.join(t("listSep"))}</span> : null },
          { label: t("formulary.sourceType"), value: row.sourceType && t(`sourceType.${row.sourceType}`, { defaultValue: row.sourceType }) },
          {
            label: t("formulary.sourceLink"),
            value: url && (
              <ExternalLink href={url} className="wrap-any text-sm">
                {new URL(url).hostname}
              </ExternalLink>
            ),
          },
          { label: t("formulary.checked"), value: row.verifiedOn && formatDate(row.verifiedOn, locale, "long") },
        ]}
      />
      <Callout tone="info">{t("formulary.notAdvice")}</Callout>
    </div>
  );
}
