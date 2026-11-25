import { IconAlertTriangle, IconEye } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import type { PatientDetail, RxItem } from "@/api/types";
import { Callout, DescriptionList, Panel, SkeletonRows, TextLink, useLocale } from "@/ui";

import { drugName } from "../shared/names";
import { LoadProblem } from "../shared/problem";

export interface PatientFacts {
  ageSex: string | null;
  /** null: not loaded. Empty: nothing recorded, which is not the same as no allergy. */
  allergies: { name: string; detail: string | null; source: "patient" | "clinic" }[] | null;
  others: PatientDetail["medications"] | null;
  /** Active medicines of the same class as an item being handed out. A listing, not an interaction check. */
  sameClass: PatientDetail["medications"];
}

export function usePatientFacts(detail: PatientDetail | undefined, items: RxItem[]): PatientFacts {
  const { t } = useTranslation("pharmacy");
  if (!detail) return { ageSex: null, allergies: null, others: null, sameClass: [] };
  const { row, profile, medications } = detail;
  const parts = [row.sex ? t(`patient.sex.${row.sex}`) : null, row.age === null ? null : t("patient.age", { count: row.age })].filter(Boolean);
  const mine = new Set(items.map((i) => i.prescription_id));
  const classes = new Set(items.map((i) => i.drug.class_id));
  const others = medications.filter((m) => !mine.has(m.prescription_id) && m.state !== "expired");
  return {
    ageSex: parts.length > 0 ? parts.join(t("listSep")) : null,
    allergies: (profile?.allergies ?? []).filter((a) => a.status === "active"),
    others,
    sameClass: others.filter((m) => m.drug.class_id !== "" && classes.has(m.drug.class_id)),
  };
}

export function AllergyBlock({ allergies }: { allergies: PatientFacts["allergies"] }) {
  const { t } = useTranslation("pharmacy");
  if (allergies === null) return null;
  if (allergies.length === 0)
    return (
      <Callout tone="warn" title={t("patient.noAllergyTitle")}>
        {t("patient.noAllergyBody")}
      </Callout>
    );
  return (
    <Callout tone="warn" icon={<IconAlertTriangle aria-hidden />} title={t("patient.allergies")}>
      <ul className="grid gap-1">
        {allergies.map((a, i) => (
          <li key={i}>
            <span className="font-bold text-fg">{a.name}</span>
            {a.detail ? t("patient.allergyDetail", { detail: a.detail }) : ""}
            <span className="text-sm"> {t(`patient.source.${a.source}`)}</span>
          </li>
        ))}
      </ul>
    </Callout>
  );
}

export function PatientPanel({ patientId, name, detail, facts, error, onRetry }: { patientId: string; name: string; detail: PatientDetail | undefined; facts: PatientFacts; error: unknown; onRetry: () => void }) {
  const { t } = useTranslation("pharmacy");
  const locale = useLocale();
  return (
    <Panel
      title={name}
      meta={facts.ageSex ? <span className="text-base text-fg">{facts.ageSex}</span> : undefined}
      footer={
        <p className="flex items-start gap-2 text-sm text-fg-2">
          <IconEye size={18} className="mt-0.5 flex-none" aria-hidden />
          <span>{t("patient.logged")}</span>
        </p>
      }
    >
      {error && !detail ? (
        <LoadProblem error={error} onRetry={onRetry} />
      ) : !detail ? (
        <SkeletonRows rows={3} />
      ) : (
        <div className="grid gap-3">
          <AllergyBlock allergies={facts.allergies} />
          <DescriptionList
            items={[
              {
                label: t("patient.others"),
                value:
                  facts.others && facts.others.length > 0 ? (
                    <ul className="grid gap-1">
                      {facts.others.map((m) => (
                        <li key={m.prescription_id}>
                          {drugName(m.drug, locale)}
                          <span className="block text-sm text-fg-2">
                            {m.dose_text}
                            {m.source === "self_reported" ? t("patient.selfReported") : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    t("patient.noOthers")
                  ),
              },
            ]}
          />
          <TextLink to={`/pharmacy/patients/${encodeURIComponent(patientId)}`} className="justify-self-start">
            {t("patient.openRecord")}
          </TextLink>
        </div>
      )}
    </Panel>
  );
}
