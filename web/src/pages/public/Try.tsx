import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useSearchParams } from "react-router";

import { useSession } from "@/app/session-context";
import { useGuest, useMeta, usePersonas } from "@/data";
import { describeError } from "@/lib/errors";
import { homePath } from "@/lib/permissions";
import { Banner, Button, ButtonLink, Checkbox, ErrorState, SkeletonRows, TextLink, useLocale } from "@/ui";

import { useResumed } from "./lib/live";
import { usePageSeo } from "./lib/seo";
import { PhotoNote, useList } from "./parts/common";

/** Personas with words of their own in public.json; anyone else gets the general ones. */
const KNOWN = new Set(["lin", "chang", "wu"]);

export default function Try() {
  const { t } = useTranslation("public");
  const ts = useList();
  const { t: tx } = useTranslation(["errors", "shell"]);
  const locale = useLocale();
  const { me, signOut } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const personas = useResumed(usePersonas());
  const meta = useResumed(useMeta());
  const guest = useGuest();
  usePageSeo("try");

  const [picked, setPicked] = useState<string>(params.get("persona") ?? "");
  const [adult, setAdult] = useState(false);
  const [missing, setMissing] = useState(false);
  const [starting, setStarting] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const items = personas.data ?? [];
  const persona = items.find((p) => p.id === (picked || items[0]?.id));
  const days = meta.data?.retention_days;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (starting || !persona) return;
    if (!adult) {
      setMissing(true);
      form.current?.querySelector<HTMLElement>("[data-check=adult]")?.focus();
      return;
    }
    setStarting(true);
    try {
      if (me) await signOut();
      // The server refuses a sandbox without `adult`.
      const input: Parameters<typeof guest.mutateAsync>[0] & { adult: true } = { locale, persona: persona.id, adult: true };
      const account = await guest.mutateAsync(input);
      void navigate(homePath(account), { replace: true });
    } catch {
      setStarting(false);
    }
  };

  if (guest.isSuccess && me) return <Navigate to={homePath(me)} replace />;
  const told = guest.error ? describeError(guest.error) : null;
  const summary = (p: { summary_zh: string; summary_en: string }) => (locale === "en" ? p.summary_en : p.summary_zh);
  const copy = (id: string) => `try.persona.${KNOWN.has(id) ? id : "other"}`;
  const isolation = ts<string[]>("try.isolation");
  return (
    <div className="site-wrap">
      <div className="entry try-entry">
        <div>
          <h1 className="pub-h1" tabIndex={-1}>
            {t("try.title")}
          </h1>
          <p className="pub-lede">{t("try.lede")}</p>
          {me && !starting && (
            <Banner
              className="mt-6 max-w-2xl"
              tone="info"
              role="note"
              title={me.is_guest ? t("try.already", { name: me.display_name }) : t("try.alreadyAccount", { name: me.display_name, role: tx(`shell:role.${me.role}`) })}
              actions={
                <ButtonLink to={homePath(me)} size="sm">
                  {me.is_guest ? t("try.continue") : t("login.enter")}
                </ButtonLink>
              }
            >
              {me.is_guest && (
                <>
                  {t("try.replace")} {t("try.claimHint")}
                </>
              )}
            </Banner>
          )}
          <form ref={form} className="mt-8" onSubmit={(e) => void submit(e)} noValidate>
            {personas.isPending ? (
              <SkeletonRows rows={6} />
            ) : personas.isError ? (
              <ErrorState title={t("try.personasFailed")} onRetry={() => void personas.refetch()} retrying={personas.isFetching} />
            ) : (
              <fieldset className="personas">
                <legend className="sr-only">{t("try.choose")}</legend>
                {items.map((p) => (
                  <label key={p.id} className="persona">
                    <input type="radio" name="persona" value={p.id} checked={persona?.id === p.id} onChange={() => setPicked(p.id)} />
                    <span className="min-w-0">
                      <span className="persona-name">
                        <b>{p.display_name}</b>
                        <span className="num text-fg-2">{t("try.age", { band: p.age_band })}</span>
                      </span>
                      <span className="mt-1 block max-w-[40em] leading-relaxed">{summary(p)}</span>
                      <span className="persona-detail">
                        <span>
                          <span className="dt">{t("try.takes")}</span>
                          <span className="dd">{t(`${copy(p.id)}.takes`)}</span>
                        </span>
                        <span>
                          <span className="dt">{t("try.canTry")}</span>
                          {ts<string[]>(`${copy(p.id)}.things`).map((x) => (
                            <span key={x} className="dd item">
                              {x}
                            </span>
                          ))}
                        </span>
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            <div className="try-go">
              <p className="text-fg-2">
                {t("try.agree")} <TextLink to="/trust/privacy-and-data">{t("try.privacy")}</TextLink>
              </p>
              <div>
                <Checkbox
                  data-check="adult"
                  label={t("try.adult")}
                  hint={t("try.adultHint")}
                  checked={adult}
                  aria-invalid={missing && !adult ? true : undefined}
                  onCheckedChange={(v) => {
                    setAdult(v === true);
                    setMissing(false);
                  }}
                />
                {missing && !adult && (
                  <p className="field-error" role="alert">
                    {t("try.adultError")}
                  </p>
                )}
              </div>
              {told && (
                <Banner tone="warn" role="alert">
                  {tx(told.key, told.params)}
                </Banner>
              )}
              <div>
                <Button type="submit" variant="primary" size="lg" loading={starting} disabled={!persona}>
                  {persona ? t("try.submit", { name: persona.display_name }) : t("try.submitNone")}
                </Button>
              </div>
            </div>
          </form>
        </div>
        <aside className="entry-side">
          <PhotoNote slot="hero" ratio="4 / 3" sizes="(min-width: 64rem) 30vw, 100vw" className="max-lg:hidden" />
          <div className="entry-aside mt-8">
            <h2>{t("try.isolationTitle")}</h2>
            <ul className="pub-list mt-3">
              {isolation.map((line, i) => (
                <li key={i}>{line.includes("{{days}}") ? (days ? t(`try.isolation.${i}`, { days }) : t("try.isolationNoDays")) : line}</li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
