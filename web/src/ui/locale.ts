import { useTranslation } from "react-i18next";

import type { Locale } from "@/api/types";

/** The interface language as the API spells it. */
export function useLocale(): Locale {
  const { i18n } = useTranslation();
  return (i18n.resolvedLanguage ?? i18n.language ?? "zh-TW").toLowerCase().startsWith("zh") ? "zh-TW" : "en";
}
