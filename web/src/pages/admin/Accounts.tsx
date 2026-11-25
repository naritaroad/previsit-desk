import { IconPlus } from "@tabler/icons-react";
import { useDeferredValue, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "@/api/errors";
import type { AccountRow, OneTimePassword, Role } from "@/api/types";
import { useAccounts, useCreateAccount, useMe, useSavedFilter } from "@/data";
import { formatDateTime, formatRelative } from "@/lib/format";
import { paths } from "@/lib/links";
import { Badge, Button, DataTable, Dialog, EmptyState, Field, FieldGroup, FilterBar, Input, LoadMore, PageBody, PageHeader, Panel, RadioRows, SearchInput, Segmented, Select, StatusTag, useLocale } from "@/ui";

import { LoadProblem, Problem } from "../pharmacy/shared/problem";
import { OneTimeDialog } from "./lib/OneTime";

const ROLES: readonly Role[] = ["physician", "coordinator", "pharmacist", "admin", "patient"];
type Group = "all" | "staff" | "patients" | "guests";
const GROUPS: readonly Group[] = ["all", "staff", "patients", "guests"];
const inGroup: Record<Group, (a: AccountRow) => boolean> = {
  all: () => true,
  staff: (a) => a.role !== "patient",
  patients: (a) => a.role === "patient" && !a.is_guest,
  guests: (a) => a.is_guest,
};

export default function Accounts() {
  const { t } = useTranslation("admin");
  const { t: ts } = useTranslation("shell");
  const locale = useLocale();
  const me = useMe();
  const [filter, setFilter, resetFilter] = useSavedFilter<{ group: string; role: string; status: string }>("admin-accounts", { group: "staff", role: "all", status: "all" });
  const [typed, setTyped] = useState("");
  const q = useDeferredValue(typed.trim());
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<OneTimePassword | null>(null);

  const group = GROUPS.find((g) => g === filter.group) ?? "all";
  // The API filters by role; "guests" and "staff" are told apart on the rows that are loaded.
  const role = ROLES.find((r) => r === filter.role) ?? (group === "patients" || group === "guests" ? "patient" : undefined);
  const list = useAccounts({ limit: 100, ...(role ? { role } : {}), ...(filter.status === "active" || filter.status === "disabled" ? { status: filter.status } : {}), ...(q ? { q } : {}) });
  const rows = list.items.filter(inGroup[group]);
  const filtered = filter.role !== "all" || filter.status !== "all" || q !== "";

  return (
    <PageBody>
      <PageHeader
        title={t("accounts.title")}
        lede={t("accounts.lede")}
        actions={
          <Button variant="primary" icon={<IconPlus aria-hidden />} onClick={() => setCreating(true)}>
            {t("accounts.add")}
          </Button>
        }
      />
      <Segmented
        className="mb-4"
        label={t("accounts.group")}
        value={group}
        onValueChange={(v) => setFilter({ group: v, role: "all" })}
        options={GROUPS.map((g) => ({ value: g, label: t(`accounts.groups.${g}`) }))}
      />
      {group === "guests" && <p className="mb-3 max-w-[46em] text-fg-2">{t("accounts.guestNote")}</p>}
      <Panel flush>
        <FilterBar
          search={<SearchInput value={typed} onValueChange={setTyped} placeholder={t("accounts.search")} />}
          chips={[
            ...(filter.role === "all" ? [] : [{ key: "r", label: ts(`role.${filter.role}`), onRemove: () => setFilter({ role: "all" }) }]),
            ...(filter.status === "all" ? [] : [{ key: "s", label: t(`accounts.status.${filter.status}`), onRemove: () => setFilter({ status: "all" }) }]),
          ]}
          onClearAll={() => {
            setTyped("");
            resetFilter();
          }}
        >
          {(group === "all" || group === "staff") && (
            <Select
              size="sm"
              label={t("accounts.role")}
              value={filter.role}
              onValueChange={(v) => setFilter({ role: v })}
              options={[{ value: "all", label: t("accounts.allRoles") }, ...ROLES.filter((r) => group === "all" || r !== "patient").map((r) => ({ value: r as string, label: ts(`role.${r}`) }))]}
            />
          )}
          <Select size="sm" label={t("accounts.statusLabel")} value={filter.status} onValueChange={(v) => setFilter({ status: v })} options={["all", "active", "disabled"].map((v) => ({ value: v, label: t(`accounts.status.${v}`) }))} />
        </FilterBar>
        {list.isError && !list.data ? (
          <LoadProblem error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <DataTable
            caption={t("accounts.title")}
            rows={list.data ? rows : undefined}
            loading={!list.data}
            rowKey={(a) => a.id}
            rowLink={(a) => paths.admin.account(a.id)}
            footer={list.hasNextPage ? t("accounts.loaded", { shown: rows.length, loaded: list.items.length }) : t("accounts.count", { count: rows.length })}
            empty={<EmptyState title={filtered ? t("accounts.noMatch") : t(`accounts.empty.${group}`)}>{filtered ? t("accounts.noMatchBody") : undefined}</EmptyState>}
            columns={[
              {
                id: "n",
                header: t("accounts.name"),
                cell: (a) => (
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold">{a.display_name}</span>
                    {a.id === me?.id && <Badge tone="ink">{t("accounts.you")}</Badge>}
                    {a.is_guest && <Badge>{t("accounts.guest")}</Badge>}
                    {a.is_demo && !a.is_guest && <Badge>{t("accounts.demo")}</Badge>}
                  </span>
                ),
                sortValue: (a) => a.display_name,
                card: "title",
              },
              { id: "u", header: t("accounts.username"), cell: (a) => a.username ?? <span className="text-fg-3">{t("accounts.noUsername")}</span>, sortValue: (a) => a.username, width: "11rem" },
              { id: "r", header: t("accounts.role"), cell: (a) => [ts(`role.${a.role}`), a.title].filter(Boolean).join(" / "), sortValue: (a) => a.role, width: "13rem" },
              { id: "s", header: t("accounts.statusLabel"), cell: (a) => <StatusTag family="account" status={a.status} />, sortValue: (a) => a.status, card: "end", width: "7.5rem" },
              { id: "l", header: t("accounts.last"), cell: (a) => (a.last_login_at ? <time dateTime={a.last_login_at} title={formatDateTime(a.last_login_at, locale)}>{formatRelative(a.last_login_at, locale)}</time> : <span className="text-fg-3">{t("accounts.never")}</span>), sortValue: (a) => a.last_login_at, nowrap: true, width: "9rem" },
              { id: "c", header: t("accounts.sessions"), cell: (a) => a.sessions, sortValue: (a) => a.sessions, align: "end", width: "6.5rem", hideBelow: "md" },
              { id: "d", header: t("accounts.created"), cell: (a) => formatDateTime(a.created_at, locale), sortValue: (a) => a.created_at, nowrap: true, width: "12.5rem", hideBelow: "xl", align: "end" },
            ]}
          />
        )}
        {list.hasNextPage && <LoadMore onLoad={() => void list.fetchNextPage()} loading={list.isFetchingNextPage} />}
      </Panel>
      <p className="mt-3 max-w-[46em] text-sm text-fg-2">{t("accounts.privacy")}</p>
      <CreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(r) => {
          setCreating(false);
          setMade(r);
        }}
      />
      <OneTimeDialog created result={made} onClose={() => setMade(null)} />
    </PageBody>
  );
}

function CreateDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (r: OneTimePassword) => void }) {
  const { t } = useTranslation("admin");
  const { t: ts } = useTranslation("shell");
  const { t: te } = useTranslation("errors");
  const create = useCreateAccount();
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>();
  const [title, setTitle] = useState("");
  const [tried, setTried] = useState(false);
  const fields = create.error instanceof ApiError ? create.error.fields : {};
  const u = username.trim().toLowerCase();
  const usernameError = u.length < 3 ? te("field.usernameShort") : u.length > 32 ? te("field.usernameLong") : !/^[a-z0-9][a-z0-9_.-]*$/.test(u) ? te("field.usernameChars") : undefined;
  const reset = () => {
    setUsername("");
    setName("");
    setRole(undefined);
    setTitle("");
    setTried(false);
    create.reset();
  };
  const submit = () => {
    setTried(true);
    if (usernameError || !name.trim() || !role) return;
    create.mutate(
      { username: u, display_name: name.trim(), role, ...(title.trim() ? { title: title.trim() } : {}) },
      {
        onSuccess: (r) => {
          reset();
          onCreated(r);
        },
      },
    );
  };
  const shown = fields.username || fields.display_name || fields.role || fields.title;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title={t("create.title")}
      description={t("create.body")}
      width="34rem"
      footer={
        <>
          <Button
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            {t("create.cancel")}
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>
            {t("create.submit")}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={t("create.username")} hint={t("create.usernameHint")} error={(tried && usernameError) || fields.username} required>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={32} />
        </Field>
        <Field label={t("create.name")} hint={t("create.nameHint")} error={(tried && !name.trim() && te("field.required")) || fields.display_name} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={40} />
        </Field>
        <FieldGroup label={t("create.role")} error={(tried && !role && t("create.roleMissing")) || fields.role} required>
          <RadioRows label={t("create.role")} value={role} onValueChange={(v) => setRole(v as Role)} options={ROLES.map((r) => ({ value: r, label: ts(`role.${r}`), hint: t(`roleHint.${r}`) }))} />
        </FieldGroup>
        <Field label={t("create.titleField")} hint={t("create.titleHint")} error={fields.title} optional>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" maxLength={40} />
        </Field>
        {create.error && !shown ? <Problem error={create.error} /> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
