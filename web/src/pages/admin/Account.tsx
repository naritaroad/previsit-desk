import { IconDeviceLaptop, IconKey, IconUserOff, IconUserCheck } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";

import { ApiError } from "@/api/errors";
import type { AccountPatch, AccountRow, OneTimePassword, Role } from "@/api/types";
import { useAccount, useAccounts, useAudit, useLeaveGuard, useMe, useResetPassword, useRevokeAccountSessions, useUpdateAccount } from "@/data";
import { formatDateTime } from "@/lib/format";
import { Badge, Banner, Button, ConfirmDialog, DataTable, DescriptionList, EmptyState, Field, FieldGroup, Input, LoadMore, PageBody, PageHeader, Panel, RadioRows, SkeletonRows, StatusTag, toast, useLocale } from "@/ui";

import { LoadProblem, Problem, useProblemText } from "../pharmacy/shared/problem";
import { useAuditText } from "./lib/audit";
import { OneTimeDialog } from "./lib/OneTime";

const STAFF: readonly Role[] = ["physician", "coordinator", "pharmacist", "admin"];

export default function Account() {
  const { t } = useTranslation("admin");
  const { id = "" } = useParams();
  const account = useAccount(id);
  const back = { to: "/admin/accounts", label: t("accounts.title") };
  if (account.isError && !account.data)
    return (
      <PageBody>
        <PageHeader back={back} title={t("account.title")} />
        <LoadProblem error={account.error} onRetry={() => void account.refetch()} />
      </PageBody>
    );
  if (!account.data)
    return (
      <PageBody>
        <PageHeader back={back} title={t("account.title")} />
        <SkeletonRows rows={6} />
      </PageBody>
    );
  return <Loaded key={id} a={account.data} back={back} />;
}

function Loaded({ a, back }: { a: AccountRow; back: { to: string; label: string } }) {
  const { t } = useTranslation("admin");
  const { t: ts } = useTranslation("shell");
  const locale = useLocale();
  const me = useMe();
  const admins = useAccounts({ role: "admin", status: "active", limit: 100 });
  const self = a.id === me?.id;
  // The server refuses these too; saying why beforehand beats a refusal afterwards.
  const lastAdmin = a.role === "admin" && a.status === "active" && admins.data !== undefined && admins.items.length <= 1;
  const locked = self ? t("account.lockSelf") : lastAdmin ? t("account.lockLast") : null;
  return (
    <PageBody>
      <PageHeader
        back={back}
        title={a.display_name}
        meta={
          <>
            <StatusTag family="account" status={a.status} />
            <span>{ts(`role.${a.role}`)}</span>
            {self && <Badge tone="ink">{t("accounts.you")}</Badge>}
            {a.is_guest && <Badge>{t("accounts.guest")}</Badge>}
            {a.is_demo && !a.is_guest && <Badge>{t("accounts.demo")}</Badge>}
          </>
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
        <div className="grid min-w-0 gap-5">
          <Edit a={a} locked={locked} />
          <ActivityLog a={a} />
        </div>
        <div className="grid min-w-0 gap-5">
          <Panel title={t("account.facts")}>
            <DescriptionList
              items={[
                { label: t("accounts.username"), value: a.username ? <span className="num">{a.username}</span> : t("accounts.noUsername") },
                { label: t("accounts.created"), value: formatDateTime(a.created_at, locale) },
                { label: t("accounts.last"), value: a.last_login_at ? formatDateTime(a.last_login_at, locale) : t("accounts.never") },
                { label: t("accounts.sessions"), value: <span className="num">{a.sessions}</span> },
                { label: t("account.id"), value: <code className="text-sm">{a.id}</code> },
              ]}
            />
          </Panel>
          <Security a={a} locked={locked} />
          {a.role === "patient" && (
            <Banner tone="info" role="note" title={t("account.patientTitle")}>
              {t("account.patientBody")}
            </Banner>
          )}
        </div>
      </div>
    </PageBody>
  );
}

function Edit({ a, locked }: { a: AccountRow; locked: string | null }) {
  const { t } = useTranslation("admin");
  const { t: ts } = useTranslation("shell");
  const { t: te } = useTranslation("errors");
  const update = useUpdateAccount();
  const [draft, setDraft] = useState<{ display_name?: string; title?: string; role?: Role }>({});
  const [confirm, setConfirm] = useState(false);
  const name = draft.display_name ?? a.display_name;
  const title = draft.title ?? a.title ?? "";
  const role = draft.role ?? a.role;
  const patch: AccountPatch = {
    ...(name.trim() !== a.display_name ? { display_name: name.trim() } : {}),
    ...(title.trim() !== (a.title ?? "") ? { title: title.trim() || null } : {}),
    ...(role !== a.role ? { role } : {}),
  };
  const dirty = Object.keys(patch).length > 0;
  useLeaveGuard(`account:${a.id}`, dirty);
  const fields = update.error instanceof ApiError ? update.error.fields : {};
  const save = () =>
    update.mutate(
      { id: a.id, ...patch },
      {
        onSuccess: () => {
          setDraft({});
          toast.ok(t("account.saved"));
        },
      },
    );
  return (
    <Panel
      title={t("account.edit")}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={!dirty || !name.trim()} loading={update.isPending} onClick={() => (patch.role ? setConfirm(true) : save())}>
            {t("account.save")}
          </Button>
          {dirty && <Button onClick={() => setDraft({})}>{t("account.discard")}</Button>}
        </div>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("create.name")} error={(!name.trim() && te("field.required")) || fields.display_name}>
            <Input value={name} maxLength={40} onChange={(e) => setDraft({ ...draft, display_name: e.target.value })} />
          </Field>
          <Field label={t("create.titleField")} hint={t("create.titleHint")} error={fields.title} optional>
            <Input value={title} maxLength={40} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </Field>
        </div>
        <FieldGroup label={t("create.role")} hint={a.role === "patient" ? t("account.patientRole") : (locked ?? t("account.roleHint"))} error={fields.role}>
          {a.role === "patient" ? (
            <p className="font-medium">{ts("role.patient")}</p>
          ) : (
            <RadioRows label={t("create.role")} value={role} disabled={locked !== null} onValueChange={(v) => setDraft({ ...draft, role: v as Role })} options={STAFF.map((r) => ({ value: r, label: ts(`role.${r}`), hint: t(`roleHint.${r}`) }))} />
          )}
        </FieldGroup>
        {update.error && Object.keys(fields).length === 0 ? <Problem error={update.error} /> : null}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("account.roleTitle", { name: a.display_name, role: ts(`role.${role}`) })}
        description={t("account.roleBody", { from: ts(`role.${a.role}`), to: ts(`role.${role}`) })}
        confirmLabel={t("account.roleConfirm")}
        onConfirm={save}
      />
    </Panel>
  );
}

function Security({ a, locked }: { a: AccountRow; locked: string | null }) {
  const { t } = useTranslation("admin");
  const problem = useProblemText();
  const reset = useResetPassword();
  const revoke = useRevokeAccountSessions();
  const update = useUpdateAccount();
  const [ask, setAsk] = useState<"reset" | "revoke" | "status" | null>(null);
  const [once, setOnce] = useState<OneTimePassword | null>(null);
  const off = a.status === "disabled";
  const fail = (e: unknown) => toast.warn(problem(e));
  const act = {
    reset: () => reset.mutate(a.id, { onSuccess: setOnce, onError: fail }),
    revoke: () => revoke.mutate(a.id, { onSuccess: () => toast.ok(t("account.revoked")), onError: fail }),
    status: () => update.mutate({ id: a.id, status: off ? "active" : "disabled" }, { onSuccess: () => toast.ok(t(off ? "account.enabled" : "account.disabled")), onError: fail }),
  };
  return (
    <Panel title={t("account.security")}>
      <ul className="divide-y divide-rule">
        <Action icon={<IconKey aria-hidden />} text={a.username ? t("account.resetHint") : t("account.resetNoUsername")} label={t("account.reset")} disabled={!a.username} busy={reset.isPending} onClick={() => setAsk("reset")} />
        <Action icon={<IconDeviceLaptop aria-hidden />} text={t("account.revokeHint", { count: a.sessions })} label={t("account.revoke")} disabled={a.sessions === 0} busy={revoke.isPending} onClick={() => setAsk("revoke")} />
        <Action
          icon={off ? <IconUserCheck aria-hidden /> : <IconUserOff aria-hidden />}
          text={off ? t("account.enableHint") : (locked ?? t("account.disableHint"))}
          label={t(off ? "account.enable" : "account.disable")}
          disabled={!off && locked !== null}
          busy={update.isPending}
          onClick={() => setAsk("status")}
        />
      </ul>
      <ConfirmDialog
        open={ask !== null}
        onOpenChange={(o) => !o && setAsk(null)}
        title={ask ? t(`account.ask.${ask === "status" ? (off ? "enable" : "disable") : ask}.title`, { name: a.display_name }) : ""}
        description={ask ? t(`account.ask.${ask === "status" ? (off ? "enable" : "disable") : ask}.body`) : ""}
        confirmLabel={ask ? t(ask === "reset" ? "account.reset" : ask === "revoke" ? "account.revoke" : off ? "account.enable" : "account.disable") : ""}
        destructive={ask === "status" && !off}
        onConfirm={() => {
          if (ask) act[ask]();
          setAsk(null);
        }}
      />
      <OneTimeDialog
        result={once}
        onClose={() => {
          setOnce(null);
          reset.reset();
        }}
      />
    </Panel>
  );
}

function Action({ icon, text, label, disabled, busy, onClick }: { icon: React.ReactNode; text: string; label: string; disabled?: boolean; busy?: boolean; onClick: () => void }) {
  return (
    <li className="grid gap-2 py-3 first:pt-0 last:pb-0">
      <p className="text-sm text-fg-2">{text}</p>
      <Button className="justify-self-start" icon={icon} disabled={disabled} loading={busy} onClick={onClick}>
        {label}
      </Button>
    </li>
  );
}

function ActivityLog({ a }: { a: AccountRow }) {
  const { t } = useTranslation("admin");
  const locale = useLocale();
  const words = useAuditText();
  const audit = useAudit({ actor: a.id });
  return (
    <Panel title={t("account.activity")} meta={<span>{t("account.activityNote")}</span>} flush>
      {audit.isError && !audit.data ? (
        <LoadProblem error={audit.error} onRetry={() => void audit.refetch()} />
      ) : (
        <DataTable
          caption={t("account.activity")}
          rows={audit.data ? audit.items.map((x, i) => ({ ...x, key: `${x.at}:${i}` })) : undefined}
          loading={!audit.data}
          rowKey={(x) => x.key}
          maxHeight="30rem"
          empty={<EmptyState title={t("account.noActivity")} />}
          columns={[
            { id: "t", header: t("audit.time"), cell: (x) => formatDateTime(x.at, locale), nowrap: true, width: "12rem" },
            { id: "a", header: t("audit.action"), cell: (x) => <span className="font-medium">{words.action(x.action)}</span>, card: "title" },
            { id: "o", header: t("audit.target"), cell: (x) => <span className="num">{words.target(x)}</span> },
            { id: "k", header: t("audit.kind"), cell: (x) => t(`auditKind.${x.kind}`), width: "7rem", hideBelow: "md" },
          ]}
        />
      )}
      {audit.hasNextPage && <LoadMore onLoad={() => void audit.fetchNextPage()} loading={audit.isFetchingNextPage} />}
    </Panel>
  );
}
