import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";

import { useAppointments, useConsents, useCreateVisit, useMeta, useSetConsent, useVisits } from "@/data";
import { Banner, Button, ButtonLink, Checkbox, PageBody, PageHeader, RadioRows, Section, SkeletonRows, TextLink } from "@/ui";

import { CONSENT_VERSION } from "./consent";
import { ActionError, useFmt } from "./shared";

const NONE = "none";

export default function VisitNew() {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const meta = useMeta();
  const appointments = useAppointments();
  const visits = useVisits({ archived: false });
  const consents = useConsents();
  const setConsent = useSetConsent();
  const create = useCreateVisit();
  const [picked, setPicked] = useState<string | null>(params.get("appointment"));
  const [agreed, setAgreed] = useState(false);
  const [needAgree, setNeedAgree] = useState(false);

  const now = new Date().toISOString();
  const upcoming = appointments.items.filter((a) => a.status === "booked" && a.starts_at > now).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const value = picked ?? (upcoming.length > 0 ? upcoming[0].id : NONE);
  const existing = visits.items.find((v) => v.appointment?.id === value);
  const unfinished = value === NONE ? visits.items.find((v) => v.status === "active" && !v.appointment) : undefined;
  const granted = consents.data?.some((c) => c.doc === "ai_disclosure" && c.granted) ?? false;
  const aiOff = meta.data && (!meta.data.ai_enabled || meta.data.daily_limit_reached);

  const start = async () => {
    if (!granted && !agreed) {
      setNeedAgree(true);
      return;
    }
    try {
      if (!granted) await setConsent.mutateAsync({ doc: "ai_disclosure", version: CONSENT_VERSION, granted: true });
      const detail = await create.mutateAsync(value === NONE ? {} : { appointment_id: value });
      await navigate(`/app/visits/${detail.visit.id}`, { replace: true });
    } catch {
      /* shown below */
    }
  };

  return (
    <PageBody width="read">
      <PageHeader title={t("visitNew.title")} lede={t("visitNew.lede")} back={{ to: "/app/visits", label: t("visits.title") }} />
      {aiOff && (
        <Banner tone="warn" className="mb-stack" title={t(meta.data?.ai_enabled ? "visit.budgetTitle" : "visit.aiOffTitle")}>
          {t("visit.aiOffBody")}
        </Banner>
      )}
      <Section title={t("visitNew.whichTitle")}>
        {!appointments.data && !appointments.error ? (
          <SkeletonRows rows={2} />
        ) : (
          <>
            <RadioRows
              label={t("visitNew.whichTitle")}
              value={value}
              onValueChange={setPicked}
              options={[
                ...upcoming.map((a) => ({ value: a.id, label: t("visitNew.forAppt", { date: f.dateTime(a.starts_at), department: a.department }), hint: f.person(a.physician) })),
                { value: NONE, label: t("visitNew.noAppt"), hint: t("visitNew.noApptHint") },
              ]}
            />
            {Boolean(appointments.error) && <p className="mt-2 text-sm text-fg-2">{t("visitNew.apptsFailed")}</p>}
          </>
        )}
      </Section>
      <Section title={t("visitNew.whatTitle")}>
        <dl className="dl">
          {(["time", "asks", "result", "after"] as const).map((k) => (
            <div key={k}>
              <dt>{t(`visitNew.${k}Label`)}</dt>
              <dd>{t(`visitNew.${k}`)}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section title={t("visitNew.discTitle")}>
        <ul className="grid gap-2">
          {(["disc1", "disc2", "disc3", "disc4"] as const).map((k) => (
            <li key={k}>{t(`visitNew.${k}`)}</li>
          ))}
        </ul>
        <p className="mt-2">
          <TextLink to="/trust/how-it-works">{t("visitNew.discMore")}</TextLink>
        </p>
        {consents.data && !granted && (
          <div className="mt-4">
            <Checkbox
              label={t("visitNew.agree")}
              checked={agreed}
              aria-invalid={needAgree && !agreed ? true : undefined}
              onCheckedChange={(c) => {
                setAgreed(c === true);
                setNeedAgree(false);
              }}
            />
            {needAgree && !agreed && (
              <p className="field-error mt-1" role="alert">
                {t("visitNew.agreeNeeded")}
              </p>
            )}
          </div>
        )}
      </Section>
      <div className="mt-8 grid gap-4">
        <ActionError error={create.error ?? setConsent.error} title={t("visitNew.failed")} onRetry={() => void start()} />
        {existing ? (
          <Banner
            tone="info"
            title={t("visitNew.existsTitle")}
            actions={
              <ButtonLink variant="primary" to={existing.submitted_at ? `/app/visits/${existing.id}/summary` : `/app/visits/${existing.id}`}>
                {t(existing.submitted_at ? "visit.seeSummary" : "home.resume")}
              </ButtonLink>
            }
          >
            {t(existing.submitted_at ? "visitNew.existsSent" : "visitNew.existsOpen")}
          </Banner>
        ) : (
          <div className="flex flex-wrap items-center gap-4">
            <Button variant="primary" size="lg" onClick={() => void start()} loading={create.isPending || setConsent.isPending}>
              {t("visitNew.start")}
            </Button>
            {unfinished && <TextLink to={`/app/visits/${unfinished.id}`}>{t("visitNew.orResume", { title: unfinished.title })}</TextLink>}
          </div>
        )}
        <p className="text-sm text-fg-2">{t("visit.fictional")}</p>
      </div>
    </PageBody>
  );
}
