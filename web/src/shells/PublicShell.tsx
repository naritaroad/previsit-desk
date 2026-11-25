import "@fontsource-variable/noto-serif-tc/wght.css";

import { IconMenu2 } from "@tabler/icons-react";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, Outlet, useLocation } from "react-router";

import { useSession } from "@/app/session-context";
import { homePath } from "@/lib/permissions";
import { ButtonLink, EmergencyButton, IconButton, Sheet, WorkspaceContext } from "@/ui";

import { Brand, DisplayMenu, OfflineStrip, SkipLink, PageLoading } from "./parts";

const NAV = ["service", "trust", "handbook"] as const;

/** Version line in the footer. The trust centre reads the live facts; this names the document set. */
const DOC_VERSION = "2.0";
const DOC_DATE = "2026-11-25";

export function PublicShell({ children }: { children?: ReactNode }) {
  const { t } = useTranslation("shell");
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);

  const account = me ? (
    <ButtonLink to={homePath(me)} variant="primary" size="sm">
      {t("public.toWorkspace")}
    </ButtonLink>
  ) : (
    <>
      <ButtonLink to="/login" variant="quiet" size="sm" data-wide>
        {t("public.login")}
      </ButtonLink>
      <ButtonLink to="/try" variant="primary" size="sm" data-wide>
        {t("public.try")}
      </ButtonLink>
    </>
  );

  return (
    <WorkspaceContext value={{ ws: "public", density: "comfortable" }}>
      <div className="shell site" data-ws="public" data-density="comfortable">
        <SkipLink />
        <header className="site-header">
          <div className="site-wrap site-header-row">
            <Brand to="/" sub={t("brand.sub")} />
            <nav className="site-nav" aria-label={t("nav.main")}>
              {NAV.map((k) => (
                <NavLink key={k} to={`/${k}`}>
                  {t(`public.nav.${k}`)}
                </NavLink>
              ))}
            </nav>
            <div className="site-header-actions">
              <EmergencyButton compact />
              <span data-wide>
                <DisplayMenu />
              </span>
              {account}
              <span data-narrow>
                <IconButton label={t("nav.open")} tooltip={false} onClick={() => setOpen(true)} aria-haspopup="dialog">
                  <IconMenu2 size={24} aria-hidden />
                </IconButton>
              </span>
            </div>
          </div>
        </header>
        <OfflineStrip />
        <main id="main" className="site-main" tabIndex={-1}>
          <Suspense fallback={<PageLoading />}>{children ?? <Outlet />}</Suspense>
        </main>
        <Footer />
        <Sheet open={open} onOpenChange={setOpen} title={t("nav.main")} bottomOnPhone={false}>
          <nav aria-label={t("nav.main")}>
            <ul>
              {NAV.map((k) => (
                <li key={k} className="border-b border-rule">
                  <NavLink to={`/${k}`} className="flex min-h-14 items-center text-lg font-semibold no-underline aria-[current=page]:text-ink-text">
                    {t(`public.nav.${k}`)}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <div className="mt-6 grid gap-3">
            {me ? (
              <ButtonLink to={homePath(me)} variant="primary" block>
                {t("public.toWorkspace")}
              </ButtonLink>
            ) : (
              <>
                <ButtonLink to="/try" variant="primary" block>
                  {t("public.try")}
                </ButtonLink>
                <ButtonLink to="/login" block>
                  {t("public.login")}
                </ButtonLink>
              </>
            )}
            <div className="flex items-center justify-between border-t border-rule pt-3">
              <span>{t("menu.display")}</span>
              <DisplayMenu />
            </div>
          </div>
        </Sheet>
      </div>
    </WorkspaceContext>
  );
}

function Footer() {
  const { t } = useTranslation("shell");
  const groups: { title: string; links: { to: string; label: string }[] }[] = [
    {
      title: t("footer.service"),
      links: [
        { to: "/service", label: t("public.nav.service") },
        { to: "/try", label: t("public.try") },
        { to: "/login", label: t("public.login") },
        { to: "/handbook", label: t("public.nav.handbook") },
      ],
    },
    {
      title: t("footer.trust"),
      links: [
        { to: "/trust/intended-use", label: t("trust.intended-use") },
        { to: "/trust/clinical-safety", label: t("trust.clinical-safety") },
        { to: "/trust/privacy", label: t("trust.privacy") },
        { to: "/trust/evidence", label: t("trust.evidence") },
      ],
    },
    {
      title: t("footer.help"),
      links: [
        { to: "/emergency", label: t("footer.emergency") },
        { to: "/trust/incidents", label: t("trust.incidents") },
        { to: "/trust/changelog", label: t("trust.changelog") },
        { to: "/credits", label: t("footer.credits") },
      ],
    },
  ];
  return (
    <footer className="site-footer">
      <div className="site-wrap">
        <div className="site-footer-grid">
          <div>
            <Brand to="/" />
            <p className="statement mt-4">{t("footer.intendedUse")}</p>
            <p className="statement mt-3 text-rail-fg-2">{t("footer.demo")}</p>
          </div>
          {groups.map((g) => (
            <nav key={g.title} aria-label={g.title}>
              <h2>{g.title}</h2>
              <ul>
                {g.links.map((l) => (
                  <li key={l.to}>
                    <Link to={l.to}>{l.label}</Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="site-docline num">
          <span>{t("footer.docVersion", { version: DOC_VERSION })}</span>
          <span>{t("footer.docDate", { date: DOC_DATE })}</span>
          <span>{t("footer.notDevice")}</span>
        </div>
      </div>
    </footer>
  );
}

export default PublicShell;
