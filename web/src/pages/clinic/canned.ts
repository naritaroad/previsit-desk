import { useTranslation } from "react-i18next";

import { useSavedList } from "./lib";

export interface CannedReply {
  title: string;
  body: string;
}
const DEFAULTS = ["received", "time", "book", "labs", "pharmacy"] as const;

/** Replies to start from. They go into the composer and stay editable; each person keeps their own list. */
export function useCannedReplies(): [readonly CannedReply[], (next: readonly CannedReply[]) => void] {
  const { t } = useTranslation("clinic");
  return useSavedList<CannedReply>(
    "clinic.canned",
    DEFAULTS.map((k) => ({ title: t(`canned.${k}.title`), body: t(`canned.${k}.body`) })),
  );
}
