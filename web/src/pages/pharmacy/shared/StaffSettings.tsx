import { IconDeviceDesktop, IconDeviceMobile, IconLogout } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "@/api/errors";
import type { Locale, SessionInfo } from "@/api/types";
import { useSession, type TextSize, type ThemeChoice } from "@/app/session-context";
import { useChangePassword, useMe, useRevokeSession, useSessions, useUpdateMe } from "@/data";
import { formatDateTime, formatRelative } from "@/lib/format";
import { Badge, Banner, Button, ConfirmDialog, DescriptionList, Field, FieldGroup, Input, PageBody, PageHeader, Panel, PasswordInput, RadioRows, SkeletonRows, toast, useLocale } from "@/ui";

import { LoadProblem, Problem, useProblemText } from "./problem";

const MIN_PASSWORD = 8;

/** One's own account: name, display, password, devices. The role and title are set by an administrator. */
export function StaffSettings() {
  const { t } = useTranslation("pharmacy");
  const me = useMe();
  return (
    <PageBody width="read">
      <PageHeader title={t("self.settings")} lede={t("self.settingsLede")} />
      {me?.must_change_password && (
        <Banner tone="warn" className="mb-4" title={t("self.mustChange")}>
          {t("self.mustChangeBody")}
        </Banner>
      )}
      <div className="grid gap-5">
        <Profile />
        <Display />
        <Password />
        <Devices />
      </div>
    </PageBody>
  );
}

function Profile() {
  const { t } = useTranslation("pharmacy");
  const { t: ts } = useTranslation("shell");
  const me = useMe();
  const update = useUpdateMe();
  const [draft, setDraft] = useState<string | null>(null);
  if (!me) return null;
  const name = draft ?? me.display_name;
  const error = update.error instanceof ApiError ? update.error.fields.display_name : undefined;
  return (
    <Panel title={t("self.account")}>
      <DescriptionList
        items={[
          { label: t("self.username"), value: me.username && <span className="num">{me.username}</span> },
          { label: t("self.role"), value: ts(`role.${me.role}`) },
          { label: t("self.title"), value: me.title },
        ]}
      />
      <form
        className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,22rem)_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          const next = name.trim();
          if (!next || next === me.display_name) return;
          update.mutate(
            { display_name: next },
            {
              onSuccess: () => {
                setDraft(null);
                toast.ok(t("self.nameSaved"));
              },
            },
          );
        }}
      >
        <Field label={t("self.name")} hint={t("self.nameHint")} error={error}>
          <Input value={name} maxLength={40} autoComplete="name" onChange={(e) => setDraft(e.target.value)} />
        </Field>
        <Button type="submit" className="justify-self-start" loading={update.isPending} disabled={!name.trim() || name.trim() === me.display_name}>
          {t("self.saveName")}
        </Button>
      </form>
      {update.error && !error ? <Problem error={update.error} className="mt-3" /> : null}
    </Panel>
  );
}

function Display() {
  const { t } = useTranslation("pharmacy");
  const { t: ts } = useTranslation("shell");
  const { prefs, setPrefs, setLocale } = useSession();
  const locale = useLocale();
  return (
    <Panel title={t("self.display")}>
      <div className="grid gap-5">
        <FieldGroup label={ts("menu.language")} hint={t("self.languageHint")}>
          <RadioRows
            label={ts("menu.language")}
            columns={2}
            value={locale}
            onValueChange={(v) => setLocale(v as Locale)}
            options={[
              { value: "zh-TW", label: ts("menu.zh") },
              { value: "en", label: ts("menu.en") },
            ]}
          />
        </FieldGroup>
        <FieldGroup label={ts("menu.theme")}>
          <RadioRows label={ts("menu.theme")} value={prefs.theme} onValueChange={(v) => setPrefs({ theme: v as ThemeChoice })} options={(["system", "light", "dark"] as const).map((v) => ({ value: v, label: ts(`menu.theme_${v}`) }))} />
        </FieldGroup>
        <FieldGroup label={ts("menu.text")} hint={t("self.textHint")}>
          <RadioRows label={ts("menu.text")} value={prefs.text} onValueChange={(v) => setPrefs({ text: v as TextSize })} options={(["100", "112", "125"] as const).map((v) => ({ value: v, label: ts(`menu.text_${v}`) }))} />
        </FieldGroup>
      </div>
    </Panel>
  );
}

function Password() {
  const { t } = useTranslation("pharmacy");
  const { t: te } = useTranslation("errors");
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [tried, setTried] = useState(false);
  const server = change.error instanceof ApiError ? change.error : null;
  const tooShort = next.length < MIN_PASSWORD;
  const same = next !== "" && next === current;
  const differ = again !== next;
  const nextError = tried && tooShort ? te("field.passwordShort") : tried && same ? te("field.passwordSame") : server?.fields.next;
  const currentError = tried && !current ? te("field.required") : server?.code === "invalid_credentials" ? t("self.wrongPassword") : server?.fields.current;
  return (
    <Panel title={t("self.password")}>
      <form
        className="grid max-w-md gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!current || tooShort || same || differ) return;
          change.mutate(
            { current, next },
            {
              onSuccess: () => {
                setCurrent("");
                setNext("");
                setAgain("");
                setTried(false);
                toast.ok(t("self.passwordSaved"));
              },
            },
          );
        }}
      >
        <Field label={t("self.current")} error={currentError}>
          <PasswordInput value={current} autoComplete="current-password" onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label={t("self.next")} hint={t("self.nextHint")} error={nextError}>
          <PasswordInput value={next} autoComplete="new-password" onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label={t("self.again")} error={tried && differ ? te("field.passwordMismatch") : undefined}>
          <PasswordInput value={again} autoComplete="new-password" onChange={(e) => setAgain(e.target.value)} />
        </Field>
        {server && !currentError && !nextError ? <Problem error={server} /> : null}
        <Button type="submit" variant="primary" className="justify-self-start" loading={change.isPending}>
          {t("self.savePassword")}
        </Button>
      </form>
    </Panel>
  );
}

function Devices() {
  const { t } = useTranslation("pharmacy");
  const locale = useLocale();
  const problem = useProblemText();
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const [ask, setAsk] = useState<SessionInfo | null>(null);
  const phone = (s: SessionInfo) => /iphone|android|mobile/i.test(s.device);
  return (
    <Panel title={t("self.devices")} meta={<span>{t("self.devicesNote")}</span>} flush>
      {sessions.isError && !sessions.data ? (
        <LoadProblem error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : !sessions.data ? (
        <SkeletonRows rows={2} />
      ) : (
        <ul className="divide-y divide-rule">
          {sessions.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-pane py-3">
              {phone(s) ? <IconDeviceMobile size={22} className="flex-none text-fg-2" aria-hidden /> : <IconDeviceDesktop size={22} className="flex-none text-fg-2" aria-hidden />}
              <div className="min-w-0 flex-1 basis-56">
                <p className="wrap-any font-medium">{s.device || t("self.deviceUnknown")}</p>
                <p className="text-sm text-fg-2">{t("self.deviceTimes", { seen: formatRelative(s.last_seen_at, locale), since: formatDateTime(s.created_at, locale) })}</p>
              </div>
              {s.current ? (
                <Badge tone="ink">{t("self.deviceCurrent")}</Badge>
              ) : (
                <Button size="sm" icon={<IconLogout aria-hidden />} onClick={() => setAsk(s)}>
                  {t("self.deviceRevoke")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={ask !== null}
        onOpenChange={(o) => !o && setAsk(null)}
        title={t("self.revokeTitle", { device: ask?.device ?? "" })}
        description={t("self.revokeBody")}
        confirmLabel={t("self.deviceRevoke")}
        onConfirm={() => {
          if (ask) revoke.mutate(ask.id, { onSuccess: () => toast.ok(t("self.revoked")), onError: (e) => toast.warn(problem(e)) });
          setAsk(null);
        }}
      />
    </Panel>
  );
}
