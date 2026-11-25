import { useTranslation } from "react-i18next";

import type { Visit } from "@/api/types";
import { usePatient } from "@/data";
import { paths } from "@/lib/links";
import { Section, SkeletonRows, TextLink } from "@/ui";

import { useFmt } from "../lib";
import { PageError, StaleBar } from "../parts";
import { Allergies, Flags, LabResults, MedicationList, PinnedNotes, ProfileItems, Readings, VisitLinks } from "../patient/blocks";

/** Left pane: what the clinic already knows. Allergies first, then what the patient takes. */
export function ContextPane({ visit }: { visit: Visit }) {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const query = usePatient(visit.patient.id);
  const d = query.data;
  if (!d) return <div className="min-h-full bg-surface p-pane">{query.isError ? <PageError error={query.error} onRetry={() => void query.refetch()} /> : <SkeletonRows rows={8} />}</div>;
  return (
    <div className="min-h-full bg-surface">
      <StaleBar query={query} />
      <div className="p-pane">
        {(d.row.flags.length > 0 || d.row.tags.length > 0) && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            <Flags flags={d.row.flags} />
            {d.row.tags.map((x) => (
              <span key={x} className="tag" data-tone="mute">
                {x}
              </span>
            ))}
          </div>
        )}
        <PinnedNotes notes={d.notes} />
        <Section title={t("desk.allergies")} className={d.notes.some((n) => n.pinned) ? "mt-5" : undefined}>
          <Allergies profile={d.profile} />
        </Section>
        <Section title={t("desk.medicines")}>
          <MedicationList items={d.medications} compact />
        </Section>
        <Section title={t("desk.conditions")}>
          <ProfileItems items={d.profile?.conditions} empty={t("record.noConditions")} />
        </Section>
        <Section title={t("desk.readings")}>
          <Readings items={d.measurements} height={160} />
        </Section>
        <Section title={t("desk.labs")}>
          <LabResults items={d.measurements} />
        </Section>
        <Section title={t("desk.visits")}>
          <VisitLinks visits={d.visits} except={visit.id} limit={5} />
        </Section>
        <p className="mt-5 text-sm">
          <TextLink to={paths.clinic.patient(visit.patient.id)}>{t("desk.fullRecord")}</TextLink>
          {d.row.last_contact_at && <span className="block text-fg-2">{t("record.lastContact", { when: fmt.rel(d.row.last_contact_at) })}</span>}
        </p>
      </div>
    </div>
  );
}
