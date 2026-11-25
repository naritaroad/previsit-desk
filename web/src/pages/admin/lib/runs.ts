import { useMemo } from "react";
import { useTranslation } from "react-i18next";

/** Codes of runs and tools in words; a code the interface does not know is shown as it is. */
export function useRunText() {
  const { t } = useTranslation("admin");
  return useMemo(
    () => ({
      tool: (name: string) => t(`tool.${name}`, { defaultValue: name }),
      source: (code: string | undefined) => (code ? t(`toolSource.${code}`, { defaultValue: code }) : t("settings.none")),
      status: (code: string) => t(`toolStatus.${code}`, { defaultValue: code }),
      error: (code: string) => t(`runError.${code}`, { defaultValue: code }),
      guard: (kind: string) => t(`guard.${kind}`, { defaultValue: kind }),
      guardAction: (action: string) => t(`guardAction.${action}`, { defaultValue: action }),
    }),
    [t],
  );
}
