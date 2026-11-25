// After navigation: set the document title, scroll to the top, move focus to the page heading and say its name.
// Pages only need an <h1 tabIndex={-1}> (PageHeader and StepForm have one).

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useMatches, useNavigationType } from "react-router";

/** Route `handle`. `title` is a key of shell.json, e.g. "page.patient.home". */
export interface RouteHandle {
  title?: string;
}

export function RouteFocus() {
  const { t, i18n } = useTranslation("shell");
  const { pathname, hash } = useLocation();
  const type = useNavigationType();
  const matches = useMatches();
  const [announce, setAnnounce] = useState("");
  const first = useRef(true);

  const key = matches.map((m) => (m.handle as RouteHandle | undefined)?.title).findLast(Boolean);
  const title = key ? t(key) : "";
  useEffect(() => {
    document.title = title ? t("title", { page: title }) : t("brand.name");
  }, [title, t, i18n.resolvedLanguage]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (type !== "POP" && !hash) document.querySelector(".shell-scroll")?.scrollTo(0, 0);
    if (hash) return;
    // Pages are lazy: wait for the heading, but not for long, and never take focus from a field the page focused itself.
    let tries = 0;
    let frame = 0;
    const start = document.activeElement;
    const look = () => {
      const h1 = document.querySelector<HTMLElement>("main h1");
      const busy = document.activeElement !== start && document.activeElement !== document.body && document.querySelector("main")?.contains(document.activeElement);
      if (busy) return;
      if (h1) {
        if (!h1.hasAttribute("tabindex")) h1.tabIndex = -1;
        h1.focus({ preventScroll: true });
        setAnnounce(h1.textContent ?? "");
      } else if (tries++ < 90) frame = requestAnimationFrame(look);
      else document.getElementById("main")?.focus({ preventScroll: true });
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [pathname, hash, type]);

  return (
    <p className="sr-only" aria-live="polite" role="status">
      {announce}
    </p>
  );
}
