import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router";

import { ApiError } from "@/api/errors";
import { registerSchema } from "@/api/schemas";
import type { RegisterInput } from "@/api/types";
import { useSession } from "@/app/session-context";
import { useMeta, useRegister } from "@/data";
import { describeError, fieldMessage } from "@/lib/errors";
import { homePath } from "@/lib/permissions";
import { Banner, Button, Checkbox, Field, Input, PasswordInput, TextLink, useLocale } from "@/ui";

import { useResumed } from "./lib/live";
import { usePageSeo } from "./lib/seo";
import { useList } from "./parts/common";

type Name = "display_name" | "username" | "password";
const ORDER: Name[] = ["display_name", "username", "password"];

export default function Register() {
  const { t } = useTranslation("public");
  const ts = useList();
  const { t: tx } = useTranslation("errors");
  const say = (key: string, params?: Record<string, unknown>): string => tx(key, params ?? {});
  const locale = useLocale();
  const { me } = useSession();
  const navigate = useNavigate();
  const register = useRegister();
  const meta = useResumed(useMeta());
  usePageSeo("register", true);

  const [values, setValues] = useState<Record<Name, string>>({ display_name: "", username: "", password: "" });
  const [errors, setErrors] = useState<Partial<Record<Name | "adult" | "fictional", string>>>({});
  const [adult, setAdult] = useState(false);
  const [fictional, setFictional] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  if (me && !register.isPending) return <Navigate to={register.isSuccess ? homePath(me) : "/login"} replace />;

  const focusFirst = (found: Partial<Record<string, string>>) => {
    const name = ORDER.find((n) => found[n]);
    const el = name ? form.current?.querySelector<HTMLElement>(`[name=${name}]`) : form.current?.querySelector<HTMLElement>(`[data-check=${found.adult ? "adult" : "fictional"}]`);
    el?.focus();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (register.isPending) return;
    const parsed = registerSchema.safeParse(values);
    const found: Partial<Record<Name | "adult" | "fictional", string>> = {};
    if (!parsed.success) for (const i of parsed.error.issues) found[String(i.path[0]) as Name] ??= i.message;
    if (!adult) found.adult = t("register.adultError");
    if (!fictional) found.fictional = t("register.fictionalError");
    setErrors(found);
    if (Object.keys(found).length > 0 || !parsed.success) return focusFirst(found);
    try {
      // The server refuses a registration without `adult`.
      const input: RegisterInput & { adult: true } = { ...parsed.data, locale, adult: true };
      const account = await register.mutateAsync(input);
      void navigate(homePath(account), { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.hasFields) {
        setErrors(err.fields);
        focusFirst(err.fields);
      }
    }
  };

  const set = (n: Name) => (e: { target: { value: string } }) => {
    setValues({ ...values, [n]: e.target.value });
    if (errors[n]) setErrors({ ...errors, [n]: undefined });
  };
  const told = register.error ? describeError(register.error) : null;
  const days = meta.data?.retention_days;
  const next = ts<string[]>("register.next");
  return (
    <div className="site-wrap entry">
      <div>
        <h1 className="pub-h1" tabIndex={-1}>
          {t("register.title")}
        </h1>
        <p className="pub-lede">{t("register.lede")}</p>
        <form ref={form} className="entry-form" onSubmit={(e) => void submit(e)} noValidate>
          {told && (
            <Banner tone="warn" role="alert">
              {tx(told.key, told.params)}
            </Banner>
          )}
          <Field label={t("register.displayName")} hint={t("register.displayNameHint")} error={fieldMessage(say, errors.display_name)}>
            <Input name="display_name" autoComplete="nickname" value={values.display_name} onChange={set("display_name")} />
          </Field>
          <Field label={t("register.username")} hint={t("register.usernameHint")} error={fieldMessage(say, errors.username)}>
            <Input name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={values.username} onChange={set("username")} />
          </Field>
          <Field label={t("register.password")} hint={t("register.passwordHint")} error={fieldMessage(say, errors.password)}>
            <PasswordInput name="password" autoComplete="new-password" value={values.password} onChange={set("password")} />
          </Field>
          <div>
            <Checkbox data-check="adult" label={t("register.adult")} hint={t("register.adultHint")} checked={adult} aria-invalid={Boolean(errors.adult) || undefined} onCheckedChange={(v) => setAdult(v === true)} />
            {errors.adult && !adult && <p className="field-error">{errors.adult}</p>}
          </div>
          <div>
            <Checkbox data-check="fictional" label={t("register.fictional")} hint={t("register.fictionalHint")} checked={fictional} aria-invalid={Boolean(errors.fictional) || undefined} onCheckedChange={(v) => setFictional(v === true)} />
            {errors.fictional && !fictional && <p className="field-error">{errors.fictional}</p>}
          </div>
          <div>
            <Button type="submit" variant="primary" size="lg" loading={register.isPending}>
              {t("register.submit")}
            </Button>
          </div>
          <p>
            {t("register.have")} <TextLink to="/login">{t("register.login")}</TextLink>
          </p>
        </form>
      </div>
      <aside className="entry-aside" aria-labelledby="after-h">
        <h2 id="after-h">{t("register.nextTitle")}</h2>
        <ul className="pub-list mt-3">
          {next.map((line, i) => (
            <li key={i}>{line.includes("{{days}}") ? (days ? t(`register.next.${i}`, { days }) : t("register.nextNoDays")) : line}</li>
          ))}
        </ul>
        <p className="mt-4">
          {t("register.guest")} <TextLink to="/try">{t("cta.try")}</TextLink>
        </p>
      </aside>
    </div>
  );
}
