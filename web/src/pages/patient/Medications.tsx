import { IconCalendar, IconChevronRight, IconListSearch, IconPill, IconPlus } from "@tabler/icons-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { selfReportedMedicationSchema } from "@/api/schemas";
import type { MedicationCard, RenewalScope } from "@/api/types";
import { useAddMedication, useFormulary, useMedications, useRxList, useToday } from "@/data";
import { fieldMessage } from "@/lib/errors";
import { Button, ButtonLink, DescriptionList, EmptyState, Field, Input, PageBody, PageHeader, Panel, RefillStrip, SearchInput, Section, Segmented, Sheet, SkeletonRows, StatusTag, TextLink, toast } from "@/ui";

import { MedActions } from "./MedActions";
import { sortMeds } from "./med-actions";
import { ActionError, DrugName, Gate, LoadError, useDebounced, useFmt } from "./shared";
import { SupplyCalendar } from "./SupplyCalendar";

export default function Medications() {
  const { t } = useTranslation("patient");
  const meds = useMedications();
  const rx = useRxList();
  const today = useToday();
  return (
    <PageBody>
      <PageHeader
        title={t("meds.title")}
        lede={t("meds.lede")}
        actions={
          <>
            <ScopeSheet />
            <ButtonLink to="/app/rx">{t("meds.requests")}</ButtonLink>
          </>
        }
      />
      <Gate query={meds} rows={6}>
        {(items) => {
          const clinic = sortMeds(items.filter((m) => m.source === "clinic"));
          const own = items.filter((m) => m.source === "self_reported");
          return (
            <>
              {clinic.length === 0 ? (
                <EmptyState icon={<IconPill aria-hidden />} title={t("meds.none")}>
                  {t("meds.noneBody")}
                </EmptyState>
              ) : (
                <div className="grid gap-5">
                  {clinic.map((m) => (
                    <MedPanel key={m.prescription_id} med={m} today={today} requestStatus={rx.items.find((r) => r.id === m.open_request_id)} />
                  ))}
                </div>
              )}
              <OwnMedicines items={own} />
            </>
          );
        }}
      </Gate>
    </PageBody>
  );
}

function MedPanel({ med: m, today, requestStatus }: { med: MedicationCard; today: string; requestStatus?: Parameters<typeof MedActions>[0]["request"] }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const anchor = `m-${m.prescription_id}`;
  // Coming from the home page with #m-…: the list is loaded after the browser looked for the anchor.
  useEffect(() => {
    if (location.hash === `#${anchor}`) document.getElementById(anchor)?.scrollIntoView({ block: "start" });
  }, [anchor]);
  return (
    <div id={anchor} className="scroll-mt-4">
      <Panel title={<DrugName drug={m.drug} />} meta={<StatusTag family="med" status={m.state} />}>
        <p className="mb-4 text-md">
          <span className="text-fg-2">{t("meds.doseLabel")}</span> {m.dose_text || t("meds.noDose")}
        </p>
        <RefillStrip med={m} today={today} />
        <MedActions med={m} request={requestStatus} className="mt-4" />
        <div className="mt-2 grid gap-1">
          <Disclosure icon={<IconCalendar size={20} aria-hidden />} title={t("meds.calendar")}>
            <SupplyCalendar med={m} today={today} />
          </Disclosure>
          <Disclosure title={t("meds.details")}>
            <DescriptionList
              items={[
                { label: t("meds.class"), value: f.drugClass(m.drug) },
                { label: t("meds.fills"), value: t("meds.fillsValue", { done: m.fills.length, total: m.fills_allowed }) },
                ...m.fills.map((x) => ({ label: t("meds.fillN", { n: x.n }), value: `${f.date(x.filled_on, "long")} ${x.pharmacy_name}` })),
                { label: t("meds.perFill"), value: t("meds.days", { count: m.days_per_fill }) },
                { label: t("meds.scope"), value: <StatusTag family="scope" status={m.renewal_scope} /> },
                ...(m.refill_preview ? [{ label: t("meds.check"), value: m.refill_preview.message }] : []),
              ]}
            />
          </Disclosure>
        </div>
      </Panel>
    </div>
  );
}

function Disclosure({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="turn" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="text-base">
        <IconChevronRight className="chev" aria-hidden />
        {icon}
        {title}
      </summary>
      {open && <div className="pt-2 pb-3 text-base">{children}</div>}
    </details>
  );
}

/** What the patient takes besides the clinic's prescriptions: shown to staff, never refilled or renewed here. */
function OwnMedicines({ items }: { items: MedicationCard[] }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const [open, setOpen] = useState(false);
  return (
    <Section
      title={t("meds.ownTitle")}
      actions={
        <Button size="sm" icon={<IconPlus aria-hidden />} onClick={() => setOpen(true)}>
          {t("meds.ownAdd")}
        </Button>
      }
    >
      <p className="mb-3 text-fg-2">{t("meds.ownBody")}</p>
      {items.length === 0 ? (
        <p className="text-fg-3">{t("meds.ownNone")}</p>
      ) : (
        <ul className="row-list">
          {items.map((m) => (
            <li key={m.prescription_id} className="row-item">
              <div className="row-link">
                <span className="row-main">
                  <span className="row-title">{f.drug(m.drug)}</span>
                  <span className="row-sub">{m.dose_text || t("meds.noDose")}</span>
                </span>
                <StatusTag family="source" status="self_reported" />
              </div>
            </li>
          ))}
        </ul>
      )}
      <AddOwn open={open} onOpenChange={setOpen} />
    </Section>
  );
}

function AddOwn({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation(["patient", "errors"]);
  const add = useAddMedication();
  const [form, setForm] = useState({ name: "", dose_text: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = () => {
    const parsed = selfReportedMedicationSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    add.mutate(parsed.data, {
      onSuccess: () => {
        toast.ok(t("patient:meds.ownAdded", { name: parsed.data.name }));
        setForm({ name: "", dose_text: "" });
        onOpenChange(false);
      },
    });
  };
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("patient:meds.ownAdd")}
      footer={
        <Button variant="primary" block loading={add.isPending} onClick={save}>
          {t("patient:meds.ownSave")}
        </Button>
      }
    >
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label={t("patient:meds.ownName")} hint={t("patient:meds.ownNameHint")} error={fieldMessage(t, errors.name)}>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        </Field>
        <Field label={t("patient:meds.ownDose")} hint={t("patient:meds.ownDoseHint")} optional error={fieldMessage(t, errors.dose_text)}>
          <Input value={form.dose_text} onChange={(e) => setForm({ ...form, dose_text: e.target.value })} />
        </Field>
        <ActionError error={add.error} title={t("patient:meds.ownFailed")} />
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

const SCOPES: readonly RenewalScope[] = ["in_scope", "physician_only", "excluded"];

/** Which medicines can be requested online, and why not the others. */
function ScopeSheet() {
  const { t } = useTranslation(["patient", "rx"]);
  const [open, setOpen] = useState(false);
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      title={t("patient:scope.title")}
      width="34rem"
      trigger={<Button icon={<IconListSearch aria-hidden />}>{t("patient:scope.open")}</Button>}
    >
      <p>{t("patient:scope.lede")}</p>
      <dl className="dl mt-3">
        {SCOPES.map((s) => (
          <div key={s}>
            <dt>
              <StatusTag family="scope" status={s} />
            </dt>
            <dd>{t(`patient:scope.${s}`)}</dd>
          </div>
        ))}
      </dl>
      {open && <FormularySearch />}
      <p className="mt-4">
        <TextLink to="/trust/renewal-safety">{t("patient:scope.more")}</TextLink>
      </p>
    </Sheet>
  );
}

function FormularySearch() {
  const { t } = useTranslation(["patient", "rx"]);
  const f = useFmt();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("all");
  const query = useDebounced(q.trim());
  const list = useFormulary({ ...(query ? { q: query } : {}), ...(scope !== "all" ? { scope: scope as RenewalScope } : {}) });
  return (
    <div className="mt-5 grid gap-3">
      <SearchInput value={q} onValueChange={setQ} placeholder={t("patient:scope.search")} />
      <Segmented label={t("patient:scope.filter")} value={scope} onValueChange={setScope} options={[{ value: "all", label: t("patient:scope.all") }, ...SCOPES.map((s) => ({ value: s, label: t(`patient:scope.short_${s}`) }))]} />
      {list.error && !list.data ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : !list.data ? (
        <SkeletonRows rows={5} />
      ) : list.items.length === 0 ? (
        <p className="py-3 text-fg-2">{t("patient:scope.noMatch")}</p>
      ) : (
        <>
          <ul className="row-list">
            {list.items.map((d) => (
              <li key={d.drug_id} className="row-item">
                <div className="row-link">
                  <span className="row-main">
                    <span className="row-title">{f.drug(d)}</span>
                    <span className="row-sub">{[f.drugAlt(d), f.drugClass(d)].filter(Boolean).join(t("patient:common.sep"))}</span>
                    {d.scope !== "in_scope" && <span className="row-sub">{d.scope_reason}</span>}
                  </span>
                  <span className="row-end">
                    <StatusTag family="scope" status={d.scope} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {list.hasNextPage && (
            <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
              {t("patient:common.more")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
