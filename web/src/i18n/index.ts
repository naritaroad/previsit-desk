// UI copy: one JSON file per language and namespace in ./locales/<language>/<namespace>.json, loaded when a
// component first asks for the namespace (useTranslation("patient") suspends until it is there). `common` and
// `errors` are loaded at start. zh-TW is the reference language (npm run i18n:check keeps en in step).

import i18n, { type BackendModule, type ResourceKey } from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import { setApiLanguage } from "../api/client.ts";
import type { Locale } from "../api/types.ts";
import { KEYS } from "../lib/storage.ts";

export const NAMESPACES = ["common", "shell", "public", "patient", "clinic", "pharmacy", "admin", "errors", "rx"] as const;
export type Namespace = (typeof NAMESPACES)[number];

/** Languages offered in the menu. `label` is the language's own name, so it is not translatable copy. */
export const LOCALES: readonly { code: Locale; label: string; htmlLang: string }[] = [
  { code: "zh-TW", label: "繁體中文", htmlLang: "zh-Hant-TW" },
  { code: "en", label: "English", htmlLang: "en" },
];
export const DEFAULT_LOCALE: Locale = "zh-TW";

/** zh-* -> zh-TW, everything else -> en. */
export function toLocale(lang: string | undefined): Locale {
  return (lang ?? "").toLowerCase().startsWith("zh") ? "zh-TW" : "en";
}
export function currentLocale(): Locale {
  return toLocale(i18n.resolvedLanguage ?? i18n.language);
}

const files = import.meta.glob<{ default: ResourceKey }>("./locales/*/*.json");

const lazyFiles: BackendModule = {
  type: "backend",
  init() {},
  read(language, namespace, callback) {
    const load = files[`./locales/${language}/${namespace}.json`];
    if (!load) {
      // Nothing written yet for this namespace: an empty resource, so the page renders keys instead of failing.
      callback(null, {});
      return;
    }
    load().then(
      (m) => callback(null, m.default),
      // A chunk that failed to load (offline, new deploy) is retried by i18next.
      (e: unknown) => callback(e as Error, true),
    );
  },
};

function applyDocumentLanguage(lng: string | undefined): void {
  const locale = toLocale(lng);
  setApiLanguage(locale);
  if (typeof document === "undefined") return;
  document.documentElement.lang = LOCALES.find((l) => l.code === locale)?.htmlLang ?? "zh-Hant-TW";
}

i18n.on("languageChanged", applyDocumentLanguage);

/** Resolves when the first namespaces are there (tests wait for it; the app uses Suspense). */
export const i18nReady = i18n
  .use(lazyFiles)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    supportedLngs: LOCALES.map((l) => l.code),
    fallbackLng: DEFAULT_LOCALE,
    load: "currentOnly",
    ns: ["common", "errors"],
    defaultNS: "common",
    partialBundledLanguages: true,
    // The system language decides only the first visit; a choice the person makes is kept.
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: KEYS.locale,
      caches: ["localStorage"],
      convertDetectedLanguage: toLocale,
    },
    interpolation: { escapeValue: false },
    returnNull: false,
    react: { useSuspense: true },
  })
  .then(() => applyDocumentLanguage(i18n.resolvedLanguage));

/** Route loaders call this so a page and its copy arrive together. */
export function preloadNamespaces(...ns: Namespace[]): Promise<void> {
  return i18n.loadNamespaces(ns);
}

export default i18n;
