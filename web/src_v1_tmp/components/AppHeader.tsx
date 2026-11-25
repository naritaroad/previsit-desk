// Header shared by every page: brand, navigation, language and theme switches.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, useLocation } from "react-router";

import i18n, { LOCALES, currentLocale } from "../i18n/index.ts";
import { applyTheme, effectiveTheme, loadTheme, type ThemeChoice } from "../theme.ts";
import { Icon, Logo } from "./Icon.tsx";

function ThemeToggle() {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<ThemeChoice>(() => loadTheme());
  const dark = effectiveTheme(choice) === "dark";
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={dark ? t("theme.toLight") : t("theme.toDark")}
      onClick={() => {
        const next: ThemeChoice = dark ? "light" : "dark";
        setChoice(next);
        applyTheme(next);
      }}
    >
      <Icon name={dark ? "sun" : "moon"} />
    </button>
  );
}

function LanguageSwitch() {
  const { t } = useTranslation();
  const current = currentLocale();
  const other = LOCALES.find((l) => l.code !== current) ?? LOCALES[0];
  return (
    <button
      type="button"
      className="lang-switch"
      lang={other.htmlLang}
      aria-label={t("lang.switchTo", { language: other.label })}
      onClick={() => void i18n.changeLanguage(other.code)}
    >
      {other.label}
    </button>
  );
}

/** Narrow screens: the links collapse into a menu button. */
function NavMenu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const location = useLocation();

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div className="nav-menu" ref={wrap}>
      <button type="button" className="icon-btn" aria-expanded={open} aria-controls="nav-menu-list" aria-label={t("nav.menu")} onClick={() => setOpen((v) => !v)}>
        <Icon name="menu" />
      </button>
      {open ? (
        <ul id="nav-menu-list" className="nav-menu__list" role="list">
          <li>
            <NavLink to="/" end>
              {t("nav.patient")}
            </NavLink>
          </li>
          <li>
            <NavLink to="/safety">{t("nav.safety")}</NavLink>
          </li>
          <li>
            <NavLink to="/clinician">{t("nav.clinician")}</NavLink>
          </li>
        </ul>
      ) : null}
    </div>
  );
}

export function AppHeader({ sub, children }: { sub: string; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <header className="app-header">
      <Link className="brand" to="/">
        <Logo />
        <span className="brand__name">{t("app.name")}</span>
        <span className="brand__sub">{sub}</span>
      </Link>
      <nav className="app-nav" aria-label={t("nav.label")}>
        <NavLink to="/" end>
          {t("nav.patient")}
        </NavLink>
        <NavLink to="/safety">{t("nav.safety")}</NavLink>
        <NavLink to="/clinician">{t("nav.clinician")}</NavLink>
      </nav>
      <div className="app-header__actions">
        {children}
        <LanguageSwitch />
        <ThemeToggle />
        <NavMenu />
      </div>
    </header>
  );
}
