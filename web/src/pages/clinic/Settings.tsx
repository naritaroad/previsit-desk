import { IconDeviceDesktop, IconPlus, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { isApiError } from "@/api/errors";
import type { Locale } from "@/api/types";
import { useSession, type TextSize, type ThemeChoice } from "@/app/session-context";
import { useChangePassword, useMe, useRevokeSession, useSessions } from "@/data";
import { Badge, Button, ConfirmDialog, DescriptionList, ErrorState, Field, FieldGroup, Input, PageBody, PageHeader, Panel, PasswordInput, RadioRows, Segmented, SkeletonRows, Textarea, toast, useLocale } from "@/ui";

import { ShortcutTable } from "./Shortcuts";
import { useCannedReplies } from "./canned";
import { useClinicDensity, useErrorText, useFmt, type ClinicDensity } from "./lib";

export default function Settings() {
  const { t } = useTranslation(["clinic", "shell"]);
  const me = useMe();
  return (
    <PageBody width="read">
      <PageHeader title={t("settings.title")} />
      <div className="grid gap-5">
        <Panel title={t("settings.account")}>
          <DescriptionList
            items={[
              { label: t("settings.name"), value: me?.display_name },
              { label: t("settings.username"), value: me?.username },
              { label: t("settings.role"), value: me?.title ?? (me ? t(`shell:role.${me.role}`) : null) },
              { label: t("settings.duties"), value: t(me?.role === "physician" ? "settings.dutiesPhysician" : "settings.dutiesCoordinator") },
            ]}
          />
        </Panel>
        <Display />
        <Canned />
        <Panel title={t("keys.title")}>
          <ShortcutTable />
        </Panel>
        <Devices />
        <Password />
      </div>
    </PageBody>
  );
}

function Display() {
  const { t } = useTranslation(["clinic", "shell"]);
  const locale = useLocale();
  const { prefs, setPrefs, setLocale } = useSession();
  const [density, setDensity] = useClinicDensity();
  return (
    <Panel title={t("settings.display")}>
      <div className="grid gap-5">
        <FieldGroup label={t("settings.density")} hint={t("settings.densityHint")}>
          <RadioRows label={t("settings.density")} columns={2} value={density} onValueChange={(v) => setDensity(v as ClinicDensity)} options={(["compact", "comfortable"] as const).map((value) => ({ value, label: t(`settings.${value}`) }))} />
        </FieldGroup>
        <FieldGroup label={t("shell:menu.language")}>
          <Segmented
            label={t("shell:menu.language")}
            value={locale}
            onValueChange={(v) => setLocale(v as Locale)}
            options={[
              { value: "zh-TW", label: t("shell:menu.zh") },
              { value: "en", label: t("shell:menu.en") },
            ]}
          />
        </FieldGroup>
        <FieldGroup label={t("shell:menu.theme")}>
          <Segmented label={t("shell:menu.theme")} value={prefs.theme} onValueChange={(v) => setPrefs({ theme: v as ThemeChoice })} options={(["system", "light", "dark"] as const).map((value) => ({ value, label: t(`shell:menu.theme_${value}`) }))} />
        </FieldGroup>
        <FieldGroup label={t("shell:menu.text")}>
          <Segmented label={t("shell:menu.text")} value={prefs.text} onValueChange={(v) => setPrefs({ text: v as TextSize })} options={(["100", "112", "125"] as const).map((value) => ({ value, label: t(`shell:menu.text_${value}`) }))} />
        </FieldGroup>
      </div>
    </Panel>
  );
}

function Canned() {
  const { t } = useTranslation("clinic");
  const [items, setItems] = useCannedReplies();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <Panel title={t("settings.canned")}>
      <p className="mb-3 text-fg-2">{t("settings.cannedBody")}</p>
      <ul className="grid gap-3">
        {items.map((c, i) => (
          <li key={`${i}-${c.title}`} className="staff-note">
            <span className="grid min-w-0 flex-1 gap-2">
              <Input aria-label={t("settings.cannedTitle")} defaultValue={c.title} onBlur={(e) => e.target.value.trim() && e.target.value !== c.title && setItems(items.map((x, j) => (j === i ? { ...x, title: e.target.value.trim() } : x)))} />
              <Textarea aria-label={t("settings.cannedText", { title: c.title })} rows={2} defaultValue={c.body} onBlur={(e) => e.target.value.trim() && e.target.value !== c.body && setItems(items.map((x, j) => (j === i ? { ...x, body: e.target.value.trim() } : x)))} />
            </span>
            <Button size="sm" variant="quiet" icon={<IconTrash aria-hidden />} onClick={() => setItems(items.filter((_, j) => j !== i))}>
              {t("settings.remove")}
              <span className="sr-only">{c.title}</span>
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="mt-4 grid gap-3 border-t border-rule pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim() || !body.trim()) return;
          setItems([...items, { title: title.trim(), body: body.trim() }]);
          setTitle("");
          setBody("");
        }}
      >
        <Field label={t("settings.cannedTitle")}>
          <Input value={title} maxLength={24} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label={t("settings.cannedNew")}>
          <Textarea rows={2} value={body} maxLength={500} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Button type="submit" className="justify-self-start" icon={<IconPlus aria-hidden />} disabled={!title.trim() || !body.trim()}>
          {t("settings.cannedAdd")}
        </Button>
      </form>
    </Panel>
  );
}

function Devices() {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const errorText = useErrorText();
  const query = useSessions();
  const revoke = useRevokeSession();
  const [gone, setGone] = useState<string | null>(null);
  return (
    <Panel title={t("settings.devices")}>
      {!query.data ? (
        query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : (
          <SkeletonRows rows={2} />
        )
      ) : (
        <ul className="divide-y divide-rule">
          {query.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <IconDeviceDesktop size={22} className="text-fg-3" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{s.device}</span> {s.current && <Badge tone="ok">{t("settings.thisDevice")}</Badge>}
                <span className="block text-sm text-fg-2">{t("settings.lastSeen", { when: fmt.rel(s.last_seen_at) })}</span>
              </span>
              {!s.current && (
                <Button size="sm" onClick={() => setGone(s.id)}>
                  {t("settings.signOutDevice")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={gone !== null} onOpenChange={(o) => !o && setGone(null)} title={t("settings.signOutTitle")} description={t("settings.signOutBody")} confirmLabel={t("settings.signOutDevice")} busy={revoke.isPending} onConfirm={() => gone && revoke.mutate(gone, { onSettled: () => setGone(null), onError: (e) => toast.warn(errorText(e)) })} />
    </Panel>
  );
}

function Password() {
  const { t } = useTranslation(["clinic", "errors"]);
  const errorText = useErrorText();
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string; again?: string }>({});
  const submit = () => {
    const found: typeof errors = {};
    if (!current) found.current = t("errors:field.required");
    if ([...next].length < 8) found.next = t("errors:field.passwordShort");
    else if (next === current) found.next = t("errors:field.passwordSame");
    if (again !== next) found.again = t("errors:field.passwordMismatch");
    setErrors(found);
    if (Object.keys(found).length) return;
    change.mutate(
      { current, next },
      {
        onSuccess: () => {
          setCurrent("");
          setNext("");
          setAgain("");
          toast.ok(t("settings.passwordDone"));
        },
        onError: (e) => {
          if (isApiError(e, "invalid_credentials")) setErrors({ current: t("settings.passwordWrong") });
          else if (isApiError(e) && e.hasFields) setErrors({ current: e.fields.current, next: e.fields.next });
          else toast.warn(errorText(e));
        },
      },
    );
  };
  return (
    <Panel title={t("settings.password")}>
      <form
        className="grid max-w-md gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={t("settings.passwordCurrent")} error={errors.current}>
          <PasswordInput autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label={t("settings.passwordNext")} hint={t("settings.passwordHint")} error={errors.next}>
          <PasswordInput autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label={t("settings.passwordAgain")} error={errors.again}>
          <PasswordInput autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </Field>
        <Button type="submit" className="justify-self-start" loading={change.isPending}>
          {t("settings.passwordChange")}
        </Button>
      </form>
    </Panel>
  );
}
