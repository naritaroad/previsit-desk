import { IconDeviceDesktop, IconDownload, IconEye } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Consent, ConsentDoc } from "@/api/types";
import { useAccessLog, useConsents, useDeleteAccount, useExport, useMe, useMeta, useRevokeSession, useSessions, useSetConsent } from "@/data";
import { Badge, Banner, Button, ButtonLink, Checkbox, ConfirmDialog, DataTable, EmptyState, PageBody, PageHeader, Panel, Section, SkeletonRows, TextLink, toast } from "@/ui";

import { resourceKey } from "./access-log";
import { CONSENT_VERSION } from "./consent";
import { ActionError, Gate, LoadError, useErrorText, useFmt } from "./shared";

export default function Privacy() {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const me = useMe();
  return (
    <PageBody>
      <PageHeader title={t("privacy.title")} lede={t("privacy.lede")} />
      {me?.is_guest && (
        <Banner tone="info" className="mb-stack" title={me.expires_at ? t("privacy.guestUntil", { date: f.dateTime(me.expires_at) }) : t("privacy.guestTitle")} actions={<ButtonLink to="/app/settings#claim">{t("privacy.claim")}</ButtonLink>}>
          {t("privacy.guestBody")}
        </Banner>
      )}
      <Consents />
      <AccessLog />
      <Devices />
      <OwnData />
    </PageBody>
  );
}

const DOCS: readonly ConsentDoc[] = ["terms", "ai_disclosure", "rx_review"];

function Consents() {
  const { t } = useTranslation("patient");
  const query = useConsents();
  return (
    <Section title={t("privacy.consents")}>
      <p className="mb-3 text-fg-2">{t("privacy.consentsBody")}</p>
      <Gate query={query} rows={3}>
        {(items) => (
          <ul className="row-list">
            {DOCS.map((doc) => (
              <ConsentRow
                key={doc}
                doc={doc}
                consent={items
                  .filter((c) => c.doc === doc)
                  .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0]}
              />
            ))}
          </ul>
        )}
      </Gate>
    </Section>
  );
}

function ConsentRow({ doc, consent }: { doc: ConsentDoc; consent: Consent | undefined }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const set = useSetConsent();
  const [asking, setAsking] = useState(false);
  const granted = consent?.granted ?? false;
  const version = granted ? consent!.version : CONSENT_VERSION;
  const change = (value: boolean) => set.mutate({ doc, version: CONSENT_VERSION, granted: value }, { onSuccess: () => toast.ok(t(value ? "privacy.granted" : "privacy.withdrawn")) });
  return (
    <li className="row-item">
      <div className="row-link flex-wrap">
        <span className="row-main basis-72">
          <span className="row-title">{t(`privacy.doc_${doc}`)}</span>
          <span className="row-sub">{t(`privacy.docBody_${doc}`)}</span>
          <span className="row-sub num">
            {t("privacy.version", { version })}
            {consent?.created_at ? ` ${t(granted ? "privacy.grantedAt" : "privacy.withdrawnAt", { date: f.dateTime(consent.created_at) })}` : ""}
          </span>
          <ActionError error={set.error} className="mt-2" />
        </span>
        <span className="row-end">
          <Badge tone={granted ? "ok" : "mute"} icon={<IconEye aria-hidden />}>
            {t(granted ? "privacy.on" : "privacy.off")}
          </Badge>
          {granted ? (
            <ConfirmDialog
              open={asking}
              onOpenChange={setAsking}
              trigger={<Button size="sm">{t("privacy.withdraw")}</Button>}
              title={t("privacy.withdrawTitle", { name: t(`privacy.doc_${doc}`) })}
              description={t(`privacy.withdrawBody_${doc}`)}
              confirmLabel={t("privacy.withdraw")}
              destructive
              onConfirm={() => change(false)}
            />
          ) : (
            <Button size="sm" variant="soft" loading={set.isPending} onClick={() => change(true)} aria-label={t("privacy.grantOne", { name: t(`privacy.doc_${doc}`) })}>
              {t("privacy.grant")}
            </Button>
          )}
        </span>
      </div>
    </li>
  );
}

/** Every read by clinic staff. The patient's own reading is not listed. */
function AccessLog() {
  const { t } = useTranslation(["patient", "shell"]);
  const f = useFmt();
  const list = useAccessLog();
  return (
    <Section title={t("patient:privacy.access")}>
      <p className="mb-3 text-fg-2">{t("patient:privacy.accessBody")}</p>
      {list.error && !list.data ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : (
        <Panel flush>
          <DataTable
            caption={t("patient:privacy.access")}
            rows={list.data ? list.items : undefined}
            loading={!list.data}
            rowKey={(r) => `${r.at}-${r.actor.id}-${r.resource}`}
            empty={<EmptyState icon={<IconEye aria-hidden />} title={t("patient:privacy.accessNone")} />}
            columns={[
              { id: "at", header: t("patient:privacy.colWhen"), cell: (r) => <time className="num" dateTime={r.at}>{f.dateTime(r.at)}</time>, width: "12rem" },
              {
                id: "who",
                header: t("patient:privacy.colWho"),
                card: "title",
                cell: (r) => (
                  <>
                    <span className="font-medium">{r.actor.display_name}</span> <span className="text-sm text-fg-2">{r.actor.title ?? t(`shell:role.${r.actor.role}`)}</span>
                  </>
                ),
              },
              { id: "what", header: t("patient:privacy.colWhat"), cell: (r) => t(`patient:privacy.resource.${resourceKey(r.action, r.resource)}`) },
            ]}
            footer={
              list.hasNextPage ? (
                <Button size="sm" onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
                  {t("patient:common.more")}
                </Button>
              ) : undefined
            }
          />
        </Panel>
      )}
    </Section>
  );
}

function Devices() {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const query = useSessions();
  const revoke = useRevokeSession();
  const errorText = useErrorText();
  return (
    <Section title={t("privacy.devices")}>
      <p className="mb-3 text-fg-2">{t("privacy.devicesBody")}</p>
      {query.data === undefined && !query.error ? (
        <SkeletonRows rows={2} />
      ) : (
        <Gate query={query} rows={2}>
          {(items) => (
            <ul className="row-list">
              {items.map((s) => (
                <li key={s.id} className="row-item">
                  <div className="row-link">
                    <IconDeviceDesktop size={24} className="flex-none text-ink-text" aria-hidden />
                    <span className="row-main">
                      <span className="row-title">{s.device}</span>
                      <span className="row-sub num">{t("privacy.deviceTimes", { since: f.dateTime(s.created_at), last: f.relative(s.last_seen_at) })}</span>
                    </span>
                    <span className="row-end">
                      {s.current ? (
                        <Badge tone="info">{t("privacy.thisDevice")}</Badge>
                      ) : (
                        <Button size="sm" onClick={() => revoke.mutate(s.id, { onSuccess: () => toast.ok(t("privacy.signedOut")), onError: (e) => toast.warn(errorText(e)) })} aria-label={t("privacy.signOutOne", { device: s.device })}>
                          {t("privacy.signOut")}
                        </Button>
                      )}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Gate>
      )}
    </Section>
  );
}

function OwnData() {
  const { t } = useTranslation("patient");
  const meta = useMeta();
  const me = useMe();
  const exporting = useExport();
  const remove = useDeleteAccount();
  const [open, setOpen] = useState(false);
  const [sure, setSure] = useState(false);
  return (
    <Section title={t("privacy.own")}>
      <dl className="dl">
        <div>
          <dt>{t("privacy.keep")}</dt>
          <dd>
            {t("privacy.keepBody", { days: meta.data?.retention_days ?? "" })} <TextLink to="/trust/privacy">{t("privacy.more")}</TextLink>
          </dd>
        </div>
        <div>
          <dt>{t("privacy.export")}</dt>
          <dd>
            <p>{t("privacy.exportBody")}</p>
            <div className="mt-2">
              <Button icon={<IconDownload aria-hidden />} loading={exporting.isPending} onClick={() => exporting.mutate()}>
                {t("privacy.exportDo")}
              </Button>
            </div>
            <ActionError error={exporting.error} className="mt-3" onRetry={() => exporting.mutate()} />
          </dd>
        </div>
        <div>
          <dt>{t("privacy.delete")}</dt>
          <dd>
            <p>{t("privacy.deleteBody")}</p>
            <div className="mt-2">
              <ConfirmDialog
                open={open}
                onOpenChange={(o) => {
                  setOpen(o);
                  setSure(false);
                }}
                trigger={<Button variant="destructive">{t("privacy.deleteDo")}</Button>}
                title={t("privacy.deleteTitle", { name: me?.display_name ?? "" })}
                description={t("privacy.deleteWarn")}
                confirmLabel={t("privacy.deleteConfirm")}
                destructive
                busy={remove.isPending}
                onConfirm={() => {
                  if (sure) remove.mutate(undefined, { onSuccess: () => location.assign("/") });
                  else toast.warn(t("privacy.deleteTick"));
                }}
              >
                <Checkbox label={t("privacy.deleteSure")} checked={sure} onCheckedChange={(c) => setSure(c === true)} />
              </ConfirmDialog>
            </div>
            <ActionError error={remove.error} className="mt-3" title={t("privacy.deleteFailed")} />
          </dd>
        </div>
      </dl>
    </Section>
  );
}
