import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";

import { claimSchema, passwordSchema } from "@/api/schemas";
import { ApiError, isApiError } from "@/api/errors";
import { useSession } from "@/app/session-context";
import { useChangePassword, useClaim, useMe } from "@/data";
import { LOCALES } from "@/i18n";
import { fieldMessage } from "@/lib/errors";
import type { Locale } from "@/api/types";
import { Banner, Button, Field, FieldGroup, Input, PageBody, PageHeader, PasswordInput, RadioRows, Section, TextLink, toast, useLocale } from "@/ui";

import { ActionError, useFmt } from "./shared";

export default function Settings() {
  const { t } = useTranslation("patient");
  const me = useMe();
  const { hash } = useLocation();
  useEffect(() => {
    if (hash !== "#claim") return;
    const el = document.getElementById("claim");
    el?.scrollIntoView({ block: "start" });
    el?.querySelector<HTMLElement>("input")?.focus({ preventScroll: true });
  }, [hash, me?.is_guest]);
  return (
    <PageBody width="read">
      <PageHeader title={t("settings.title")} />
      {me?.is_guest && <Claim />}
      <Display />
      <Notify />
      {me && !me.is_guest && <Password forced={me.must_change_password} />}
      <SignOut />
    </PageBody>
  );
}

/** Guest sandbox becomes a regular account; everything in it stays. */
function Claim() {
  const { t } = useTranslation(["patient", "errors"]);
  const f = useFmt();
  const me = useMe();
  const claim = useClaim();
  const [form, setForm] = useState({ username: "", password: "", display_name: me?.display_name ?? "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (part: Partial<typeof form>) => {
    setForm({ ...form, ...part });
    setErrors({});
  };
  const submit = () => {
    const parsed = claimSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    claim.mutate(parsed.data, {
      onSuccess: () => toast.ok(t("patient:settings.claimed")),
      onError: (e) => e instanceof ApiError && setErrors({ ...e.fields }),
    });
  };
  const taken = claim.error instanceof ApiError && claim.error.code === "conflict";
  const errorOf = (k: string) => fieldMessage(t, errors[k]) ?? (k === "username" && taken ? t("patient:settings.usernameTaken") : undefined);
  return (
    <section id="claim" className="edit-box mb-8 scroll-mt-6" aria-labelledby="claim-h">
      <div>
        <h2 id="claim-h" className="section-title">
          {t("patient:settings.claimTitle")}
        </h2>
        <p className="mt-1 text-fg-2">{me?.expires_at ? t("patient:settings.claimBody", { date: f.dateTime(me.expires_at) }) : t("patient:settings.claimBodyPlain")}</p>
      </div>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={t("patient:settings.displayName")} hint={t("patient:profile.nameHint")} error={errorOf("display_name")}>
          <Input value={form.display_name} onChange={(e) => set({ display_name: e.target.value })} autoComplete="nickname" />
        </Field>
        <Field label={t("patient:settings.username")} hint={t("patient:settings.usernameHint")} error={errorOf("username")}>
          <Input value={form.username} onChange={(e) => set({ username: e.target.value })} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        </Field>
        <Field label={t("patient:settings.password")} hint={t("patient:settings.passwordHint")} error={errorOf("password")}>
          <PasswordInput value={form.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
        </Field>
        <ActionError error={taken || Object.keys(errors).length > 0 ? null : claim.error} title={t("patient:settings.claimFailed")} onRetry={submit} />
        <div>
          <Button type="submit" variant="primary" loading={claim.isPending}>
            {t("patient:settings.claimDo")}
          </Button>
        </div>
      </form>
    </section>
  );
}

function Display() {
  const { t } = useTranslation(["patient", "shell"]);
  const { prefs, setPrefs, setLocale } = useSession();
  const locale = useLocale();
  return (
    <Section title={t("patient:settings.display")}>
      <div className="grid gap-6">
        <FieldGroup label={t("shell:menu.language")}>
          <RadioRows label={t("shell:menu.language")} columns={2} value={locale} onValueChange={(v) => setLocale(v as Locale)} options={LOCALES.map((l) => ({ value: l.code, label: <span lang={l.htmlLang}>{l.label}</span> }))} />
        </FieldGroup>
        <FieldGroup label={t("shell:menu.text")} hint={t("patient:settings.textHint")}>
          <RadioRows
            label={t("shell:menu.text")}
            value={prefs.text}
            onValueChange={(v) => setPrefs({ text: v as "100" | "112" | "125" })}
            options={(["100", "112", "125"] as const).map((v) => ({ value: v, label: <span style={{ fontSize: `${Number(v) / Number(prefs.text)}em` }}>{t(`shell:menu.text_${v}`)}</span> }))}
          />
        </FieldGroup>
        <FieldGroup label={t("shell:menu.theme")}>
          <RadioRows label={t("shell:menu.theme")} value={prefs.theme} onValueChange={(v) => setPrefs({ theme: v as "system" | "light" | "dark" })} options={(["system", "light", "dark"] as const).map((v) => ({ value: v, label: t(`shell:menu.theme_${v}`) }))} />
        </FieldGroup>
        <p className="text-sm text-fg-2">{t("patient:settings.follows")}</p>
      </div>
    </Section>
  );
}

function Notify() {
  const { t } = useTranslation("patient");
  return (
    <Section title={t("settings.notify")}>
      <p>{t("settings.notifyBody")}</p>
      <ul className="mt-2 grid list-disc gap-1 ps-5">
        {(["visit", "rx", "refill", "appt"] as const).map((k) => (
          <li key={k}>{t(`settings.notify_${k}`)}</li>
        ))}
      </ul>
      <p className="mt-2 text-fg-2">
        {t("settings.notifyNone")} <TextLink to="/app/notifications">{t("settings.notifyOpen")}</TextLink>
      </p>
    </Section>
  );
}

const EMPTY = { current: "", next: "", confirm: "" };

function Password({ forced }: { forced: boolean }) {
  const { t } = useTranslation(["patient", "errors"]);
  const change = useChangePassword();
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (part: Partial<typeof EMPTY>) => {
    setForm({ ...form, ...part });
    setErrors({});
  };
  const submit = () => {
    const parsed = passwordSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    change.mutate(
      { current: form.current, next: form.next },
      {
        onSuccess: () => {
          setForm(EMPTY);
          toast.ok(t("patient:settings.passwordDone"));
        },
        onError: (e) => {
          if (isApiError(e, "invalid_credentials")) setErrors({ current: t("patient:settings.passwordWrong") });
          else if (e instanceof ApiError) setErrors({ ...e.fields });
        },
      },
    );
  };
  return (
    <Section title={t("patient:settings.changePassword")}>
      {forced && (
        <Banner tone="warn" className="mb-4">
          {t("patient:settings.passwordForced")}
        </Banner>
      )}
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {(["current", "next", "confirm"] as const).map((k) => (
          <Field key={k} label={t(`patient:settings.pw_${k}`)} hint={k === "next" ? t("patient:settings.passwordHint") : undefined} error={fieldMessage(t, errors[k])}>
            <PasswordInput value={form[k]} onChange={(e) => set({ [k]: e.target.value })} autoComplete={k === "current" ? "current-password" : "new-password"} />
          </Field>
        ))}
        <ActionError error={Object.keys(errors).length > 0 ? null : change.error} title={t("patient:settings.passwordFailed")} />
        <div>
          <Button type="submit" loading={change.isPending}>
            {t("patient:settings.changePassword")}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function SignOut() {
  const { t } = useTranslation(["patient", "shell"]);
  const { me, signOut } = useSession();
  const [error, setError] = useState<unknown>(null);
  const out = () => {
    setError(null);
    signOut().then(() => location.assign("/"), setError);
  };
  return (
    <Section title={t("patient:settings.session")}>
      <p className="mb-3 text-fg-2">
        {t(me?.is_guest ? "patient:settings.leaveBody" : "patient:settings.signOutBody")} <TextLink to="/app/privacy">{t("patient:settings.devices")}</TextLink>
      </p>
      <Button onClick={out}>{t(me?.is_guest ? "shell:menu.leaveGuest" : "shell:menu.signOut")}</Button>
      <ActionError error={error} className="mt-3" onRetry={out} />
    </Section>
  );
}
