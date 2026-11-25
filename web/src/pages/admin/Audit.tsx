import { IconDownload } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { adminApi } from "@/api/endpoints";
import type { AuditEntry, AuditParams } from "@/api/types";
import { useAccounts, useAudit, useToday } from "@/data";
import { addDays, formatDateTime } from "@/lib/format";
import { Button, Combobox, DataTable, DateField, EmptyState, Field, FilterBar, LoadMore, NativeSelect, PageBody, PageHeader, Panel, Segmented, Sheet, TextLink, DescriptionList, toast, useLocale } from "@/ui";

import { LoadProblem, useProblemText } from "../pharmacy/shared/problem";
import { personName } from "../pharmacy/shared/names";
import { AUDIT_ACTIONS, AUDIT_KINDS, splitTarget, useAuditText } from "./lib/audit";
import { downloadText, toCsv } from "./lib/csv";

const DEFAULT_DAYS = 90;
const EXPORT_MAX = 2000;
type Row = AuditEntry & { key: string };

export default function Audit() {
  const { t } = useTranslation("admin");
  const locale = useLocale();
  const today = useToday();
  const words = useAuditText();
  const [kind, setKind] = useState<AuditEntry["kind"] | "all">("all");
  const [action, setAction] = useState("all");
  const [actor, setActor] = useState<string | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [who, setWho] = useState("");
  const [open, setOpen] = useState<Row | null>(null);
  const reversed = Boolean(from && to && from > to);
  const params: Omit<AuditParams, "cursor"> = {
    ...(kind === "all" ? {} : { kind }),
    ...(action === "all" ? {} : { action }),
    ...(actor ? { actor } : {}),
    ...(from && !reversed ? { from } : {}),
    ...(to && !reversed ? { to } : {}),
  };
  const audit = useAudit(params);
  const people = useAccounts({ limit: 50, ...(who.trim() ? { q: who.trim() } : {}) });
  const person = people.items.find((a) => a.id === actor);
  const rows: Row[] = audit.items.map((a, i) => ({ ...a, key: `${a.at}:${i}` }));
  const actions = kind === "all" ? AUDIT_KINDS.flatMap((k) => AUDIT_ACTIONS[k]) : AUDIT_ACTIONS[kind];
  const filtered = Object.keys(params).length > 0;
  const clear = () => {
    setKind("all");
    setAction("all");
    setActor(null);
    setFrom(null);
    setTo(null);
  };

  return (
    <PageBody>
      <PageHeader title={t("audit.title")} lede={t("audit.lede")} actions={<Export params={params} disabled={rows.length === 0} />} />
      <Segmented
        className="mb-4"
        label={t("audit.kind")}
        value={kind}
        onValueChange={(v) => {
          setKind(v as typeof kind);
          setAction("all");
        }}
        options={[{ value: "all", label: t("audit.all") }, ...AUDIT_KINDS.map((k) => ({ value: k as string, label: t(`auditKind.${k}`) }))]}
      />
      <Panel flush>
        <FilterBar onClearAll={filtered ? clear : undefined} chips={actor ? [{ key: "a", label: person?.display_name ?? t("audit.actor"), onRemove: () => setActor(null) }] : []} className="items-end">
          <Field label={t("audit.actor")} className="min-w-52">
            <Combobox label={t("audit.actor")} value={actor} onValueChange={setActor} onSearch={setWho} loading={people.isFetching} placeholder={t("audit.anyone")} options={people.items.map((a) => ({ value: a.id, label: a.display_name, hint: [a.username, a.title].filter(Boolean).join(" ") || undefined }))} />
          </Field>
          <Field label={t("audit.action")} className="min-w-48">
            <NativeSelect value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="all">{t("audit.anyAction")}</option>
              {actions.map((a) => (
                <option key={a} value={a}>
                  {words.action(a)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t("oversight.from")} error={reversed ? t("oversight.reversed") : undefined}>
            <DateField value={from} max={to ?? today} onValueChange={setFrom} />
          </Field>
          <Field label={t("oversight.to")}>
            <DateField value={to} max={today} onValueChange={setTo} />
          </Field>
          {filtered && !actor && <Button onClick={clear}>{t("audit.clear")}</Button>}
        </FilterBar>
        {audit.isError && !audit.data ? (
          <LoadProblem error={audit.error} onRetry={() => void audit.refetch()} />
        ) : (
          <DataTable
            caption={t("audit.title")}
            rows={audit.data ? rows : undefined}
            loading={!audit.data}
            rowKey={(r) => r.key}
            onRowOpen={setOpen}
            selectedKey={open?.key ?? null}
            empty={<EmptyState title={t(filtered ? "audit.noMatch" : "audit.empty")}>{filtered ? t("audit.noMatchBody") : undefined}</EmptyState>}
            footer={t(audit.hasNextPage ? "audit.loaded" : "audit.count", { count: rows.length })}
            columns={[
              { id: "t", header: t("audit.time"), cell: (r) => formatDateTime(r.at, locale), nowrap: true, width: "12rem" },
              { id: "w", header: t("audit.actor"), cell: (r) => personName(r.actor), width: "13rem" },
              { id: "a", header: t("audit.action"), cell: (r) => <span className="font-medium">{words.action(r.action)}</span>, card: "title", width: "15rem" },
              { id: "o", header: t("audit.target"), cell: (r) => <span className="num">{words.target(r)}</span>, width: "12rem" },
              { id: "k", header: t("audit.kind"), cell: (r) => t(`auditKind.${r.kind}`, { defaultValue: r.kind }), width: "6.5rem", card: "end" },
              { id: "d", header: t("audit.detail"), cell: (r) => <span className="text-sm">{words.detail(r)}</span>, hideBelow: "lg" },
            ]}
          />
        )}
        {audit.hasNextPage && <LoadMore onLoad={() => void audit.fetchNextPage()} loading={audit.isFetchingNextPage} />}
      </Panel>
      <div className="mt-3 grid max-w-[50em] gap-2 text-sm text-fg-2">
        {!from && !to && <p>{t("audit.window", { date: formatDateTime(`${addDays(today, 1 - DEFAULT_DAYS)}T00:00:00+08:00`, locale) })}</p>}
        <p>{t("audit.privacy")}</p>
      </div>
      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpen(null)} title={open ? words.action(open.action) : ""} description={open ? formatDateTime(open.at, locale) : undefined}>
        {open && <Entry row={open} />}
      </Sheet>
    </PageBody>
  );
}

function Entry({ row }: { row: Row }) {
  const { t } = useTranslation("admin");
  const words = useAuditText();
  const { kind, id } = splitTarget(row.target);
  const raw = row.detail !== null && typeof row.detail === "object" && Object.keys(row.detail).length > 0 ? JSON.stringify(row.detail, null, 2) : null;
  return (
    <div className="grid gap-4">
      <DescriptionList
        items={[
          { label: t("audit.actor"), value: <TextLink to={`/admin/accounts/${encodeURIComponent(row.actor.id)}`}>{personName(row.actor)}</TextLink> },
          { label: t("audit.kind"), value: t(`auditKind.${row.kind}`, { defaultValue: row.kind }) },
          { label: t("audit.code"), value: <code className="text-sm">{row.action}</code> },
          { label: t("audit.target"), value: kind === "account" && id ? <TextLink to={`/admin/accounts/${encodeURIComponent(id)}`}>{words.target(row)}</TextLink> : words.target(row) },
          { label: t("audit.targetId"), value: id ? <code className="text-sm break-all">{row.target}</code> : null },
          { label: t("audit.detail"), value: words.detail(row) || null },
        ]}
      />
      {raw && <pre className="overflow-auto rounded-control bg-sunken p-3 text-sm">{raw}</pre>}
      {(kind === "patient" || kind === "rx" || kind === "visit" || row.kind === "access") && <p className="text-sm text-fg-2">{t("audit.cannotOpen")}</p>}
    </div>
  );
}

/** Reads every matching page (up to a limit that is stated) and saves them as CSV in the browser; nothing is stored on the server. */
function Export({ params, disabled }: { params: Omit<AuditParams, "cursor">; disabled: boolean }) {
  const { t } = useTranslation("admin");
  const words = useAuditText();
  const problem = useProblemText();
  const today = useToday();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const rows: AuditEntry[] = [];
      let cursor: string | undefined;
      do {
        const page = await adminApi.audit({ ...params, limit: 100, cursor });
        rows.push(...page.items);
        cursor = page.next_cursor ?? undefined;
      } while (cursor && rows.length < EXPORT_MAX);
      const head = ["at", "actor_id", "actor", "role", "kind", "action", "action_text", "target", "detail"];
      downloadText(
        `audit-${today}.csv`,
        toCsv(
          head,
          rows.map((r) => [r.at, r.actor.id, personName(r.actor), r.actor.role, r.kind, r.action, words.action(r.action), r.target, r.detail === null || r.detail === undefined ? null : typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail)]),
        ),
      );
      toast.ok(cursor ? t("audit.exportedPart", { count: rows.length }) : t("audit.exported", { count: rows.length }));
    } catch (e) {
      toast.warn(problem(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button icon={<IconDownload aria-hidden />} loading={busy} disabled={disabled} onClick={() => void run()}>
      {t("audit.export")}
    </Button>
  );
}
