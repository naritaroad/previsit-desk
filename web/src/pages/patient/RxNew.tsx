import { IconPill } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";

import type { MedicationCard, RxKind } from "@/api/types";
import { useCreateRx, useFormulary, useMedications, useRxList } from "@/data";
import { Button, ButtonLink, Checkbox, EmptyState, FieldGroup, PageBody, PageHeader, RadioRows, StatusTag, TextLink } from "@/ui";

import { medAdvice, sortMeds } from "./med-actions";
import { ActionError, Gate, useFmt } from "./shared";

export default function RxNew() {
  const { t } = useTranslation(["patient", "rx"]);
  const [params, setParams] = useSearchParams();
  const kind: RxKind = params.get("kind") === "renewal" ? "renewal" : "refill";
  const meds = useMedications();
  return (
    <PageBody width="read">
      <PageHeader title={t("patient:rxNew.title")} lede={t("patient:rxNew.lede")} back={{ to: "/app/medications", label: t("patient:meds.title") }} />
      <FieldGroup label={t("patient:rxNew.kind")}>
        <RadioRows
          label={t("patient:rxNew.kind")}
          value={kind}
          onValueChange={(k) => setParams({ kind: k }, { replace: true })}
          options={(["refill", "renewal"] as const).map((k) => ({ value: k, label: t(`rx:kind.${k}`), hint: t(`patient:rxNew.${k}Hint`) }))}
        />
      </FieldGroup>
      <div className="mt-8">
        <Gate query={meds} rows={4}>
          {(items) => {
            const clinic = sortMeds(items.filter((m) => m.source === "clinic"));
            if (clinic.length === 0)
              return (
                <EmptyState icon={<IconPill aria-hidden />} title={t("patient:meds.none")} action={<ButtonLink to="/app/appointments/book">{t("patient:advice.bookVisit")}</ButtonLink>}>
                  {t("patient:meds.noneBody")}
                </EmptyState>
              );
            return <Pick key={kind} kind={kind} items={clinic} initial={params.get("item")} />;
          }}
        </Gate>
      </div>
    </PageBody>
  );
}

function Pick({ kind, items, initial }: { kind: RxKind; items: MedicationCard[]; initial: string | null }) {
  const { t } = useTranslation(["patient", "rx"]);
  const f = useFmt();
  const navigate = useNavigate();
  const create = useCreateRx();
  const rx = useRxList();
  // Reasons per drug come from the formulary, the same text the request will show.
  const formulary = useFormulary();
  const reasonOf = (m: MedicationCard) => formulary.items.find((d) => d.drug_id === m.drug.drug_id)?.scope_reason ?? t(`rx:scopeHint.${m.renewal_scope}`);

  const blocked = (m: MedicationCard): string | null => {
    const request = rx.items.find((r) => r.id === m.open_request_id);
    if (m.open_request_id) return t(request?.status === "draft" ? "patient:advice.openDraft" : "patient:advice.open");
    if (kind === "renewal") return m.renewal_scope === "excluded" ? reasonOf(m) : null;
    const a = medAdvice(m);
    if (a.step.do === "refill") return null;
    return (
      a.detail ??
      t(`patient:advice.${a.reason === "renew" || a.reason === "renewIndividual" || a.reason === "excluded" ? "noFillsLeft" : a.reason}`, {
        from: m.next_window ? f.date(m.next_window.from, "medium") : "",
        to: m.next_window ? f.date(m.next_window.to, "medium") : "",
        supply: f.date(m.supply_ends_on, "medium"),
        valid: f.date(m.valid_until, "long"),
      })
    );
  };
  const open = items.filter((m) => blocked(m) === null);
  const [picked, setPicked] = useState<string[]>(() => items.filter((m) => m.prescription_id === initial && blocked(m) === null).map((m) => m.prescription_id));
  const [error, setError] = useState<string>();

  const start = () => {
    if (picked.length === 0) {
      setError(t("patient:rxNew.pickOne"));
      return;
    }
    create.mutate({ kind, prescription_ids: picked }, { onSuccess: (r) => void navigate(`/app/rx/${r.id}/edit`) });
  };
  const hintOf = (m: MedicationCard) => (
    <>
      <span className="block">{m.dose_text}</span>
      {kind === "renewal" ? <span className="block">{reasonOf(m)}</span> : m.next_window && <span className="block num">{t("patient:rxNew.window", { range: f.range(m.next_window.from, m.next_window.to) })}</span>}
    </>
  );

  return (
    <>
      <FieldGroup label={t(kind === "refill" ? "patient:rxNew.pickRefill" : "patient:rxNew.pickRenewal")} hint={t(kind === "refill" ? "patient:rxNew.pickRefillHint" : "patient:rxNew.pickRenewalHint")} error={error}>
        {open.length === 0 ? (
          <EmptyState title={t(kind === "refill" ? "patient:rxNew.noRefill" : "patient:rxNew.noRenewal")}>{t("patient:rxNew.noneBody")}</EmptyState>
        ) : kind === "refill" ? (
          <RadioRows
            label={t("patient:rxNew.pickRefill")}
            value={picked[0]}
            onValueChange={(v) => {
              setPicked([v]);
              setError(undefined);
            }}
            options={open.map((m) => ({ value: m.prescription_id, label: f.drug(m.drug), hint: hintOf(m), end: <StatusTag family="med" status={m.state} /> }))}
          />
        ) : (
          <div className="grid gap-1">
            {open.map((m) => (
              <Checkbox
                key={m.prescription_id}
                label={
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{f.drug(m.drug)}</span>
                    <StatusTag family="scope" status={m.renewal_scope} />
                  </span>
                }
                hint={hintOf(m)}
                checked={picked.includes(m.prescription_id)}
                onCheckedChange={(c) => {
                  setPicked(c === true ? [...picked, m.prescription_id] : picked.filter((x) => x !== m.prescription_id));
                  setError(undefined);
                }}
              />
            ))}
          </div>
        )}
      </FieldGroup>

      {items.length > open.length && (
        <section className="mt-8" aria-label={t("patient:rxNew.notNow")}>
          <h2 className="mb-2 font-bold">{t("patient:rxNew.notNow")}</h2>
          <ul className="row-list">
            {items
              .filter((m) => !open.includes(m))
              .map((m) => (
                <li key={m.prescription_id} className="row-item">
                  <div className="row-link">
                    <span className="row-main">
                      <span className="row-title">{f.drug(m.drug)}</span>
                      <span className="row-sub">{blocked(m)}</span>
                    </span>
                    <span className="row-end">
                      {m.open_request_id ? (
                        <TextLink to={rx.items.find((r) => r.id === m.open_request_id)?.status === "draft" ? `/app/rx/${m.open_request_id}/edit` : `/app/rx/${m.open_request_id}`}>{t("patient:advice.seeRequest")}</TextLink>
                      ) : kind === "refill" && m.fills.length >= m.fills_allowed && m.renewal_scope !== "excluded" ? (
                        <TextLink to={`/app/rx/new?kind=renewal&item=${m.prescription_id}`}>{t("patient:advice.askRenewal")}</TextLink>
                      ) : m.renewal_scope === "excluded" || m.state === "late" ? (
                        <TextLink to="/app/appointments/book">{t("patient:advice.bookVisit")}</TextLink>
                      ) : null}
                    </span>
                  </div>
                </li>
              ))}
          </ul>
        </section>
      )}

      <div className="mt-8 grid gap-4">
        {kind === "renewal" && <p className="text-fg-2">{t("patient:rxNew.notPrescription")}</p>}
        <ActionError error={create.error} title={t("patient:rxNew.failed")} onRetry={start} />
        {open.length > 0 && (
          <div>
            <Button variant="primary" size="lg" loading={create.isPending} onClick={start}>
              {t("patient:rxNew.start")}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
