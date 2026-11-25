import { IconCheck, IconMinus } from "@tabler/icons-react";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Permission, Role } from "@/api/types";
import { usePermissionMatrix } from "@/data";
import { Callout, EmptyState, PageBody, PageHeader, Panel, SearchInput, SkeletonRows, useMediaQuery } from "@/ui";
import { FilterBar, NativeSelect } from "@/ui";

import { LoadProblem } from "../pharmacy/shared/problem";

/** Groups follow who the permission is about, in the order a clinic works. */
const GROUPS: { id: string; permissions: readonly Permission[] }[] = [
  { id: "own", permissions: ["visit.own", "rx.own", "profile.own", "appt.own"] },
  { id: "clinic", permissions: ["visit.read", "visit.review", "note.sign", "thread.reply", "ticket.handle", "patient.read", "patient.manage", "appt.manage"] },
  { id: "rx", permissions: ["rx.read", "rx.decide", "rx.dispense"] },
  { id: "admin", permissions: ["account.manage", "settings.manage", "audit.read", "oversight.read", "rules.read", "demo.reset"] },
];

export default function Permissions() {
  const { t } = useTranslation("admin");
  const { t: ts } = useTranslation("shell");
  const m = usePermissionMatrix();
  const [q, setQ] = useState("");
  const narrow = useMediaQuery("(max-width: 48rem)");
  const [role, setRole] = useState<Role>("admin");
  const needle = q.trim().toLowerCase();

  const known = new Set(GROUPS.flatMap((g) => g.permissions));
  const list = m.data?.permissions ?? [];
  const rest = list.filter((p) => !known.has(p.id)).map((p) => p.id);
  const groups = [...GROUPS, ...(rest.length > 0 ? [{ id: "other", permissions: rest }] : [])]
    .map((g) => ({ id: g.id, rows: list.filter((p) => g.permissions.includes(p.id) && (!needle || `${p.id} ${p.label} ${p.description}`.toLowerCase().includes(needle))) }))
    .filter((g) => g.rows.length > 0);
  const has = (r: Role, p: Permission) => m.data?.matrix[r]?.includes(p) ?? false;
  const cell = (r: Role, p: Permission) =>
    has(r, p) ? (
      <>
        <IconCheck size={20} stroke={2.5} aria-hidden />
        <span className="sr-only">{t("permissions.yes")}</span>
      </>
    ) : (
      <>
        <IconMinus size={16} className="text-fg-3" aria-hidden />
        <span className="sr-only">{t("permissions.no")}</span>
      </>
    );

  return (
    <PageBody>
      <PageHeader title={t("permissions.title")} lede={t("permissions.lede")} />
      <Callout tone="info" className="mb-5" title={t("permissions.adminTitle")}>
        {t("permissions.adminBody")}
      </Callout>
      {m.isError && !m.data ? (
        <LoadProblem error={m.error} onRetry={() => void m.refetch()} />
      ) : !m.data ? (
        <SkeletonRows rows={12} />
      ) : (
        <>
          <Panel flush className="mb-4">
            <FilterBar search={<SearchInput value={q} onValueChange={setQ} placeholder={t("permissions.search")} />}>
              {narrow && (
                <NativeSelect aria-label={t("accounts.role")} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {m.data.roles.map((r) => (
                    <option key={r} value={r}>
                      {ts(`role.${r}`)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FilterBar>
          </Panel>
          {groups.length === 0 ? (
            <EmptyState title={t("permissions.none")} />
          ) : narrow ? (
            groups.map((g) => (
              <section key={g.id} className="mb-5">
                <h2 className="section-title mb-2">{t(`permissions.group.${g.id}`)}</h2>
                <ul className="panel divide-y divide-rule">
                  {g.rows.map((p) => (
                    <li key={p.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 px-pane py-3">
                      <span className="pt-0.5">{cell(role, p.id)}</span>
                      <span>
                        <span className="block font-medium">{p.label}</span>
                        <span className="block text-sm text-fg-2">{p.description}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          ) : (
            <div className="matrix-wrap" tabIndex={0} role="region" aria-label={t("permissions.title")}>
              <table className="matrix">
                <caption className="sr-only">{t("permissions.caption")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("permissions.permission")}</th>
                    {m.data.roles.map((r) => (
                      <th key={r} scope="col">
                        {ts(`role.${r}`)}
                        <span className="num block text-sm font-normal">{t("permissions.count", { count: m.data.matrix[r]?.length ?? 0 })}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <Fragment key={g.id}>
                      <tr className="group">
                        <th scope="rowgroup" colSpan={m.data.roles.length + 1}>
                          {t(`permissions.group.${g.id}`)}
                        </th>
                      </tr>
                      {g.rows.map((p) => (
                        <tr key={p.id}>
                          <th scope="row">
                            <span className="block font-medium">{p.label}</span>
                            <span className="block text-sm text-fg-2">{p.description}</span>
                            <code className="text-sm text-fg-3">{p.id}</code>
                          </th>
                          {m.data.roles.map((r) => (
                            <td key={r}>{cell(r, p.id)}</td>
                          ))}
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 max-w-[46em] text-sm text-fg-2">{t("permissions.fixed")}</p>
        </>
      )}
    </PageBody>
  );
}
