import { useTranslation } from "react-i18next";

import type { MedicationCard, RxRequestBrief } from "@/api/types";
import { ButtonLink, StatusTag, TextLink, cn } from "@/ui";

import { medAdvice } from "./med-actions";
import { useFmt } from "./shared";

/** One sentence about what can be done today and why, and the button for it. Never a disabled button without a reason. */
export function MedActions({ med, request, className }: { med: MedicationCard; request?: RxRequestBrief | null; className?: string }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const advice = medAdvice(med, request);
  const w = med.next_window;
  const text = t(`advice.${advice.reason}`, {
    from: w ? f.date(w.from, "medium") : "",
    to: w ? f.date(w.to, "medium") : "",
    supply: f.date(med.supply_ends_on, "medium"),
    valid: f.date(med.valid_until, "long"),
  });
  const step = advice.step;
  const query = `&item=${encodeURIComponent(med.prescription_id)}`;
  // Renewing early is allowed (the doctor sees how many fills are left), so it stays reachable as a link.
  const early = med.source === "clinic" && step.do === "none" && med.renewal_scope !== "excluded" && med.fills.length >= med.fills_allowed - 1;
  return (
    <div className={cn("med-actions", className)}>
      <div className="min-w-0">
        <p>{advice.detail ?? text}</p>
        {request && step.do === "open" && (
          <p className="mt-1">
            <StatusTag family="rx" status={request.status} />
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {step.do === "open" && (
          <ButtonLink variant="soft" to={request?.status === "draft" ? `/app/rx/${step.requestId}/edit` : `/app/rx/${step.requestId}`}>
            {t(request?.status === "draft" ? "advice.continueDraft" : "advice.seeRequest")}
          </ButtonLink>
        )}
        {step.do === "refill" && (
          <ButtonLink variant="soft" to={`/app/rx/new?kind=refill${query}`}>
            {t("advice.bookRefill")}
          </ButtonLink>
        )}
        {step.do === "renewal" && (
          <ButtonLink variant="soft" to={`/app/rx/new?kind=renewal${query}`}>
            {t("advice.askRenewal")}
          </ButtonLink>
        )}
        {step.do === "visit" && (
          <ButtonLink variant="soft" to="/app/appointments/book">
            {t("advice.bookVisit")}
          </ButtonLink>
        )}
        {early && <TextLink to={`/app/rx/new?kind=renewal${query}`}>{t("advice.askRenewal")}</TextLink>}
      </div>
    </div>
  );
}
