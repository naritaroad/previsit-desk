import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useSearchParams } from "react-router";

import { isApiError } from "@/api/errors";
import { loginSchema } from "@/api/schemas";
import { useSession } from "@/app/session-context";
import { useLogin } from "@/data";
import { describeError, fieldMessage } from "@/lib/errors";
import { safeNext } from "@/lib/links";
import { canEnter, homePath } from "@/lib/permissions";
import { Banner, Button, ButtonLink, Field, Input, PasswordInput, TextLink, toast } from "@/ui";

import { usePageSeo } from "./lib/seo";
import { useList } from "./parts/common";

export default function Login() {
  const { t } = useTranslation("public");
  const ts = useList();
  const { t: tx } = useTranslation(["errors", "shell"]);
  const say = (key: string, params?: Record<string, unknown>): string => tx(key, params ?? {});
  const { me, signOut } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const login = useLogin();
  usePageSeo("login", true);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fields, setFields] = useState<{ username?: string; password?: string }>({});
  const [filled, setFilled] = useState<string | null>(null);
  /** This page signed the person in: it goes to their workspace, not to "you are signed in". */
  const [arrived, setArrived] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const next = params.get("next");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (login.isPending) return;
    const parsed = loginSchema.safeParse({ username, password });
    if (!parsed.success) {
      const found: Record<string, string> = {};
      for (const i of parsed.error.issues) found[String(i.path[0])] ??= i.message;
      setFields(found);
      form.current?.querySelector<HTMLInputElement>(found.username ? "[name=username]" : "[name=password]")?.focus();
      return;
    }
    setFields({});
    try {
      const account = await login.mutateAsync(parsed.data);
      const home = homePath(account);
      const wanted = safeNext(next, home);
      const ok = canEnter(account, wanted.split(/[?#]/)[0]);
      if (!ok) toast.info(t("login.wrongWorkspace"));
      const to = ok ? wanted : home;
      setArrived(to);
      void navigate(to, { replace: true });
    } catch {
      setPassword("");
      form.current?.querySelector<HTMLInputElement>("[name=password]")?.focus();
    }
  };

  if (arrived) return <Navigate to={arrived} replace />;
  if (me && !login.isPending)
    return (
      <div className="site-wrap entry">
        <div>
          <h1 className="pub-h1" tabIndex={-1}>
            {t("login.signedInTitle")}
          </h1>
          <p className="pub-lede">{t("login.signedIn", { name: me.display_name, role: tx(`shell:role.${me.is_guest ? "guest" : me.role}`) })}</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <ButtonLink to={homePath(me)} variant="primary">
              {t("login.enter")}
            </ButtonLink>
            <Button onClick={() => void signOut()}>{t("login.signOut")}</Button>
          </div>
        </div>
      </div>
    );

  const error = login.error;
  const told = error ? describeError(error) : null;
  return (
    <div className="site-wrap entry">
      <div>
        <h1 className="pub-h1" tabIndex={-1}>
          {t("login.title")}
        </h1>
        <p className="pub-lede">{t("login.lede")}</p>
        <form ref={form} className="entry-form" onSubmit={(e) => void submit(e)} noValidate>
          {params.get("expired") ? (
            <Banner tone="warn">{t("login.expired")}</Banner>
          ) : (
            next && <Banner tone="info">{t("login.next")}</Banner>
          )}
          {error && (
            <Banner tone="warn" role="alert">
              {isApiError(error, "invalid_credentials") ? t("login.failed") : tx(told!.key, told!.params)}
            </Banner>
          )}
          <Field label={t("login.username")} error={fieldMessage(say, fields.username)}>
            <Input name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field label={t("login.password")} error={fieldMessage(say, fields.password)}>
            <PasswordInput name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <div>
            <Button type="submit" variant="primary" size="lg" loading={login.isPending}>
              {t("login.submit")}
            </Button>
          </div>
          <p>
            {t("login.noAccount")} <TextLink to="/register">{t("login.register")}</TextLink>
          </p>
        </form>
      </div>
      <aside className="entry-aside" aria-labelledby="demo-h">
        <h2 id="demo-h">{t("login.demoTitle")}</h2>
        <p>{t("login.demoBody")}</p>
        <ul className="demo-accounts">
          {ts<{ u: string; name: string; role: string }[]>("login.demo").map((d) => (
            <li key={d.u}>
              <button
                type="button"
                aria-label={t("login.useAccount", d)}
                onClick={() => {
                  setUsername(d.u);
                  setFilled(d.u);
                  form.current?.querySelector<HTMLInputElement>("[name=password]")?.focus();
                }}
              >
                <span>{d.u}</span>
                <span>{d.name}</span>
                <span>{d.role}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="min-h-[1.8em]" role="status">
          {filled && t("login.filled", { u: filled })}
        </p>
        <p>
          {t("login.noPassword")} <TextLink to="/try">{t("cta.try")}</TextLink>
        </p>
      </aside>
    </div>
  );
}
