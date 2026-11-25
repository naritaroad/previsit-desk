import { Suspense, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useSearchParams } from "react-router";

import { PageLoading } from "@/shells/parts";

import "./public.css";

/** Wraps every public page: `?lang=en` (the language alternates search engines see) picks the language once. */
export default function PublicLayout() {
  const { i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  const lang = params.get("lang");

  useEffect(() => {
    if (lang === null) return;
    if (lang === "en" || lang === "zh-TW") void i18n.changeLanguage(lang);
    // The address then follows the language menu, not the other way round.
    const next = new URLSearchParams(params);
    next.delete("lang");
    setParams(next, { replace: true, preventScrollReset: true });
  }, [lang, i18n, params, setParams]);

  // Pages arrive after the address: go to the section the address names once it is there.
  useEffect(() => {
    if (!hash) return;
    const id = decodeURIComponent(hash.slice(1));
    let frame = 0;
    let tries = 0;
    const look = () => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView();
      else if (tries++ < 180) frame = requestAnimationFrame(look);
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [hash]);

  return (
    <Suspense fallback={<PageLoading />}>
      <Outlet />
    </Suspense>
  );
}
