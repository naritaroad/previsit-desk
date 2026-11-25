import { IconHeartHandshake, IconPhoneCall } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "./cn";
import { Sheet } from "./overlay";

export interface EmergencyPanelProps {
  /** Medical puts 119 first, crisis puts 1925 (安心專線) first. Both numbers are always there. */
  kind?: "medical" | "crisis";
  title?: ReactNode;
  /** Fixed text from the red-flag rules. Without it the general text is used. */
  children?: ReactNode;
  className?: string;
}

/** The only red surface in the product. */
export function EmergencyPanel({ kind = "medical", title, children, className }: EmergencyPanelProps) {
  const { t } = useTranslation("common");
  const call119 = (
    <a key="119" className="emergency-call" href="tel:119" data-first={kind === "medical"}>
      <IconPhoneCall aria-hidden />
      <span className="emergency-number">119</span>
      <span>{t("emergency.call119")}</span>
    </a>
  );
  const call1925 = (
    <a key="1925" className="emergency-call" href="tel:1925" data-first={kind === "crisis"}>
      <IconHeartHandshake aria-hidden />
      <span className="emergency-number">1925</span>
      <span>{t("emergency.call1925")}</span>
    </a>
  );
  return (
    <section className={cn("emergency", className)} role="alert" aria-label={t("emergency.label")}>
      <h2 className="emergency-title">{title ?? t(kind === "crisis" ? "emergency.crisisTitle" : "emergency.title")}</h2>
      <div className="emergency-body">{children ?? <p>{t(kind === "crisis" ? "emergency.crisisBody" : "emergency.body")}</p>}</div>
      <div className="emergency-calls">{kind === "crisis" ? [call1925, call119] : [call119, call1925]}</div>
    </section>
  );
}

/** Always reachable from the patient shell and the public header. */
export function EmergencyButton({ compact, className }: { compact?: boolean; className?: string }) {
  const { t } = useTranslation("common");
  return (
    <Sheet
      title={t("emergency.sheetTitle")}
      trigger={
        <button type="button" className={cn("emergency-btn", className)} data-compact={compact}>
          <IconPhoneCall size={19} aria-hidden />
          <span>{t("emergency.button")}</span>
        </button>
      }
    >
      <EmergencyPanel />
      <p className="mt-4 text-fg-2">{t("emergency.sheetNote")}</p>
    </Sheet>
  );
}
