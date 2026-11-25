import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Pharmacy } from "@/api/types";
import { usePharmacies, useProfile } from "@/data";
import { Badge, EmptyState, FieldGroup, NativeSelect, RadioRows, SearchInput } from "@/ui";

import { Gate } from "../shared";

/** A list instead of a map: district, address, hours and what the place offers. The usual one comes first. */
export function PharmacyPicker({ value, onChange, error }: { value: Pharmacy | null; onChange: (p: Pharmacy) => void; error?: string }) {
  const { t } = useTranslation("patient");
  const query = usePharmacies();
  const profile = useProfile();
  const preferred = profile.data?.preferred_pharmacy_id ?? null;
  const [district, setDistrict] = useState("");
  const [q, setQ] = useState("");
  const districts = useMemo(() => [...new Set((query.data ?? []).map((p) => p.district))].sort(), [query.data]);
  return (
    <Gate query={query} rows={4}>
      {(all) => {
        const text = q.trim().toLowerCase();
        const shown = all
          .filter((p) => (!district || p.district === district) && (!text || `${p.name} ${p.address} ${p.district}`.toLowerCase().includes(text)))
          .sort((a, b) => Number(b.id === value?.id) - Number(a.id === value?.id) || Number(b.id === preferred) - Number(a.id === preferred));
        return (
          <FieldGroup label={t("pharm.label")} hint={t("pharm.hint")} error={error}>
            <div className="mb-3 flex flex-wrap gap-3">
              <SearchInput value={q} onValueChange={setQ} placeholder={t("pharm.search")} className="max-w-sm flex-1 basis-56" />
              <div className="w-44">
                <NativeSelect aria-label={t("pharm.district")} value={district} onChange={(e) => setDistrict(e.target.value)}>
                  <option value="">{t("pharm.allDistricts")}</option>
                  {districts.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
            {shown.length === 0 ? (
              <EmptyState title={t("pharm.noMatch")}>{t("pharm.noMatchBody")}</EmptyState>
            ) : (
              <RadioRows
                label={t("pharm.label")}
                value={value?.id}
                onValueChange={(id) => {
                  const p = all.find((x) => x.id === id);
                  if (p) onChange(p);
                }}
                options={shown.map((p) => ({
                  value: p.id,
                  label: (
                    <>
                      {p.name} {p.id === preferred && <Badge tone="info">{t("pharm.usual")}</Badge>}
                    </>
                  ),
                  hint: (
                    <>
                      <span className="block">
                        {p.district} {p.address}
                      </span>
                      <span className="block">{t("pharm.hours", { hours: p.hours })}</span>
                      {p.services.length > 0 && <span className="block">{p.services.join(t("common.listSep"))}</span>}
                    </>
                  ),
                }))}
              />
            )}
          </FieldGroup>
        );
      }}
    </Gate>
  );
}
