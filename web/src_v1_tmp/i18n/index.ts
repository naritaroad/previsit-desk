// UI copy lives in ./locales/<code>.json, one file per language; components only hold keys.
// zh-TW is the reference language (scripts/check-i18n.mjs keeps en in step with it).

import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import type { Locale } from "../api/types.ts";
import { setApiLanguage } from "../api/client.ts";
import { KEYS } from "../lib/storage.ts";
import en from "./locales/en.json";
import zhTW from "./locales/zh-TW.json";

/** Languages offered in the menu. `label` is the language's own name, so it is not translatable copy. */
export const LOCALES: readonly { code: Locale; label: string; htmlLang: string }[] = [
  { code: "zh-TW", label: "繁體中文", htmlLang: "zh-Hant-TW" },
  { code: "en", label: "English", htmlLang: "en" },
];

export const DEFAULT_LOCALE: Locale = "zh-TW";

/** Map a browser language to one of ours: zh-* -> zh-TW, everything else -> en. */
export function toLocale(lang: string | undefined): Locale {
  return (lang ?? "").toLowerCase().startsWith("zh") ? "zh-TW" : "en";
}

function applyDocumentLanguage(lng: string) {
  const locale = toLocale(lng);
  document.documentElement.lang = LOCALES.find((l) => l.code === locale)?.htmlLang ?? "zh-Hant-TW";
  document.title = i18n.t("app.title");
  setApiLanguage(locale);
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { "zh-TW": { translation: zhTW }, en: { translation: en } },
    supportedLngs: LOCALES.map((l) => l.code),
    fallbackLng: DEFAULT_LOCALE,
    load: "currentOnly",
    // The system language decides only the first visit; a choice the user makes is kept in localStorage.
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: KEYS.locale,
      caches: ["localStorage"],
      convertDetectedLanguage: toLocale,
    },
    interpolation: { escapeValue: false },
    returnNull: false,
    react: { useSuspense: false },
  })
  .then(() => applyDocumentLanguage(i18n.resolvedLanguage ?? DEFAULT_LOCALE));

i18n.on("languageChanged", applyDocumentLanguage);

export function currentLocale(): Locale {
  return toLocale(i18n.resolvedLanguage ?? i18n.language);
}

export default i18n;
