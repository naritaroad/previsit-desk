import { IconPlus, IconTrash } from "@tabler/icons-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "@/api/errors";
import { measurementSchemas } from "@/api/schemas";
import type { Measurement, MeasurementInput, MeasurementKind, MeasurementValues } from "@/api/types";
import { useAddMeasurement, useDeleteMeasurement, useMeasurements, useSavedFilter } from "@/data";
import { fieldMessage } from "@/lib/errors";
import { fromLocalInput, toLocalInput } from "@/lib/format";
import { Button, DataTable, EmptyState, Field, FieldGroup, IconButton, Input, NumberField, PageBody, PageHeader, Panel, RadioRows, Segmented, Sheet, Skeleton, StatusTag, TextLink, toast } from "@/ui";

import { ActionError, LoadError, StaleNote, useErrorText, useFmt } from "./shared";

// recharts is large: only this page loads it.
const Chart = lazy(() => import("@/ui/measurement-chart").then((m) => ({ default: m.MeasurementChart })));

const KINDS: readonly MeasurementKind[] = ["bp", "glucose", "weight", "pulse", "lab"];
const RANGES = ["30", "90", "all"] as const;

export default function Measurements() {
  const { t } = useTranslation(["patient", "common"]);
  const f = useFmt();
  const [saved, setSaved] = useSavedFilter("patient_measure", { kind: "bp", range: "90" });
  const kind = KINDS.find((k) => k === saved.kind) ?? "bp";
  const range = RANGES.find((r) => r === saved.range) ?? "90";
  const [adding, setAdding] = useState(false);
  const list = useMeasurements(kind);
  const since = range === "all" ? "" : new Date(Date.now() - Number(range) * 86_400_000).toISOString();
  const rows = list.items.filter((m) => m.taken_at >= since);
  const showValue = (m: Measurement) => valueText(m, (k) => t(`common:measure.unit.${k}`));
  return (
    <PageBody>
      <PageHeader
        title={t("patient:measure.title")}
        lede={t("patient:measure.lede")}
        back={{ to: "/app/profile", label: t("patient:profile.title") }}
        actions={
          <Button variant="primary" icon={<IconPlus aria-hidden />} onClick={() => setAdding(true)}>
            {t("patient:measure.add")}
          </Button>
        }
      />
      <div className="mb-stack flex flex-wrap items-center gap-3">
        <div className="max-w-full overflow-x-auto">
          <Segmented label={t("patient:measure.kind")} value={kind} onValueChange={(k) => setSaved({ kind: k })} options={KINDS.map((k) => ({ value: k, label: t(`common:measure.kind.${k}`) }))} />
        </div>
        <Segmented className="ms-auto" label={t("patient:measure.range")} value={range} onValueChange={(r) => setSaved({ range: r })} options={RANGES.map((r) => ({ value: r, label: t(`patient:measure.range_${r}`) }))} />
      </div>
      <StaleNote query={list} />
      {list.error && !list.data ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : (
        <>
          {kind !== "lab" && rows.length > 1 && (
            <Panel className="mb-stack">
              <Suspense fallback={<Skeleton className="h-60" />}>
                <Chart kind={kind} items={rows} height={260} />
              </Suspense>
              <p className="mt-2 text-sm text-fg-2">{t("patient:measure.chartNote")}</p>
            </Panel>
          )}
          <Panel flush title={t("patient:measure.tableTitle")}>
            <DataTable
              caption={t("patient:measure.tableTitle")}
              rows={list.data ? rows : undefined}
              loading={!list.data}
              rowKey={(m) => m.id}
              empty={
                <EmptyState title={t("patient:measure.none", { kind: t(`common:measure.kind.${kind}`) })} action={list.items.length > 0 ? <Button onClick={() => setSaved({ range: "all" })}>{t("patient:measure.showAll")}</Button> : <Button onClick={() => setAdding(true)}>{t("patient:measure.add")}</Button>}>
                  {list.items.length > 0 ? t("patient:measure.noneInRange") : t("patient:measure.noneBody")}
                </EmptyState>
              }
              columns={[
                { id: "at", header: t("common:measure.when"), cell: (m) => <span className="num">{f.dateTime(m.taken_at)}</span>, card: "title" },
                { id: "value", header: t("patient:measure.value"), cell: (m) => <span className="num font-semibold">{showValue(m)}</span>, align: "end", nowrap: true },
                { id: "source", header: t("patient:measure.source"), cell: (m) => <StatusTag family="source" status={m.source} />, card: "end", width: "9rem" },
                { id: "del", header: <span className="sr-only">{t("patient:measure.remove")}</span>, cell: (m) => (m.source === "patient" && !m.id.startsWith("new:") ? <Remove item={m} text={showValue(m)} /> : null), width: "4rem", align: "end" },
              ]}
            />
          </Panel>
          {list.hasNextPage && (
            <div className="mt-4">
              <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
                {t("patient:common.more")}
              </Button>
            </div>
          )}
        </>
      )}
      <Add open={adding} onOpenChange={setAdding} kind={kind} onKind={(k) => setSaved({ kind: k })} />
    </PageBody>
  );
}

function valueText(m: { kind: MeasurementKind; values: MeasurementValues }, unit: (k: MeasurementKind) => string): string {
  if (m.kind === "bp") return `${m.values.systolic ?? ""}/${m.values.diastolic ?? ""} ${unit("bp")}`;
  if (m.kind === "lab") return [m.values.name, m.values.value, m.values.unit].filter((x) => x !== undefined && x !== "").join(" ");
  return `${m.values.value ?? ""} ${unit(m.kind)}`;
}

/** Gone at once, back with one press: a reading is easy to type again but easier to restore. */
function Remove({ item, text }: { item: Measurement; text: string }) {
  const { t } = useTranslation("patient");
  const remove = useDeleteMeasurement();
  const add = useAddMeasurement();
  const errorText = useErrorText();
  return (
    <IconButton
      size="sm"
      label={t("measure.removeOne", { value: text })}
      onClick={() =>
        remove.mutate(item.id, {
          onError: (e) => toast.warn(errorText(e)),
          onSuccess: () => toast.ok(t("measure.removed"), { action: { label: t("common.undo"), onClick: () => add.mutate({ kind: item.kind, values: item.values, taken_at: item.taken_at }, { onError: (e) => toast.warn(errorText(e)) }) } }),
        })
      }
    >
      <IconTrash size={18} aria-hidden />
    </IconButton>
  );
}

interface FormState {
  systolic: number | null;
  diastolic: number | null;
  value: number | null;
  name: string;
  unit: string;
  at: string;
}
const emptyForm = (): FormState => ({ systolic: null, diastolic: null, value: null, name: "", unit: "", at: toLocalInput() });

function Add({ open, onOpenChange, kind, onKind }: { open: boolean; onOpenChange: (o: boolean) => void; kind: MeasurementKind; onKind: (k: MeasurementKind) => void }) {
  const { t } = useTranslation(["patient", "common", "errors"]);
  const add = useAddMeasurement();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const set = (part: Partial<FormState>) => {
    setForm({ ...form, ...part });
    setErrors({});
  };
  const save = () => {
    const taken_at = form.at ? fromLocalInput(form.at) : "";
    const raw = kind === "bp" ? { systolic: form.systolic ?? undefined, diastolic: form.diastolic ?? undefined, taken_at } : kind === "lab" ? { name: form.name, value: form.value ?? undefined, unit: form.unit, taken_at } : { value: form.value ?? undefined, taken_at };
    const parsed = measurementSchemas[kind].safeParse(raw);
    const found: Record<string, string> = parsed.success ? {} : Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]));
    if (taken_at && Date.parse(taken_at) > Date.now() + 60_000) found.taken_at = "field.futureTime";
    if (Object.keys(found).length > 0 || !parsed.success) {
      setErrors(found);
      return;
    }
    const { taken_at: _t, ...values } = parsed.data as { taken_at: string } & MeasurementValues;
    const input: MeasurementInput = { kind, values, taken_at };
    add.mutate(input, {
      onSuccess: (m) => {
        // A newer server may explain a reading that needs attention; shown as it is, never worked out here.
        const note = (m as Measurement & { notice?: unknown }).notice;
        toast.ok(t("patient:measure.added"));
        setForm(emptyForm());
        if (typeof note === "string" && note) setNotice(note);
        else onOpenChange(false);
      },
      onError: (e) => {
        if (e instanceof ApiError && e.hasFields) setErrors(Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k.replace(/^values\./, ""), v])));
      },
    });
  };
  const errorOf = (k: string) => (errors[k] === "field.futureTime" ? t("patient:measure.future") : fieldMessage(t, errors[k]));
  const known = new Set(["systolic", "diastolic", "value", "name", "unit", "taken_at"]);
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (o) {
          setForm(emptyForm());
          setErrors({});
          setNotice(null);
          add.reset();
        }
      }}
      title={t("patient:measure.add")}
      footer={
        notice ? (
          <Button block onClick={() => onOpenChange(false)}>
            {t("patient:common.close")}
          </Button>
        ) : (
          <Button variant="primary" block loading={add.isPending} onClick={save}>
            {t("patient:measure.save")}
          </Button>
        )
      }
    >
      {notice ? (
        <div role="alert" className="text-md whitespace-pre-wrap">
          {notice}
        </div>
      ) : (
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <FieldGroup label={t("patient:measure.kind")}>
            <RadioRows
              label={t("patient:measure.kind")}
              columns={2}
              value={kind}
              onValueChange={(k) => {
                onKind(k as MeasurementKind);
                setErrors({});
              }}
              options={KINDS.map((k) => ({ value: k, label: t(`common:measure.kind.${k}`) }))}
            />
          </FieldGroup>
          {kind === "bp" ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("common:measure.systolic")} hint={t("patient:measure.top")} error={errorOf("systolic")}>
                <NumberField value={form.systolic} unit={t("common:measure.unit.bp")} onValueChange={(n) => set({ systolic: n })} />
              </Field>
              <Field label={t("common:measure.diastolic")} hint={t("patient:measure.bottom")} error={errorOf("diastolic")}>
                <NumberField value={form.diastolic} unit={t("common:measure.unit.bp")} onValueChange={(n) => set({ diastolic: n })} />
              </Field>
            </div>
          ) : kind === "lab" ? (
            <>
              <Field label={t("patient:measure.labName")} hint={t("patient:measure.labNameHint")} error={errorOf("name")}>
                <Input value={form.name} onChange={(e) => set({ name: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("patient:measure.value")} error={errorOf("value")}>
                  <NumberField value={form.value} step={0.1} onValueChange={(n) => set({ value: n })} />
                </Field>
                <Field label={t("patient:measure.unit")} optional error={errorOf("unit")}>
                  <Input value={form.unit} onChange={(e) => set({ unit: e.target.value })} />
                </Field>
              </div>
            </>
          ) : (
            <Field label={t(`common:measure.kind.${kind}`)} hint={kind === "glucose" ? t("patient:measure.glucoseHint") : undefined} error={errorOf("value")}>
              <NumberField value={form.value} step={kind === "weight" ? 0.1 : 1} unit={t(`common:measure.unit.${kind}`)} onValueChange={(n) => set({ value: n })} />
            </Field>
          )}
          <Field label={t("patient:measure.when")} error={errorOf("taken_at")}>
            <Input type="datetime-local" className="num" value={form.at} max={toLocalInput()} onChange={(e) => set({ at: e.target.value })} />
          </Field>
          <ActionError error={add.error instanceof ApiError && Object.keys(add.error.fields).some((k) => known.has(k.replace(/^values\./, ""))) ? null : add.error} title={t("patient:measure.failed")} onRetry={save} />
          <p className="text-sm text-fg-2">
            {t("patient:measure.notJudged")} <TextLink to="/emergency">{t("patient:measure.emergencyLink")}</TextLink>
          </p>
          <button type="submit" hidden />
        </form>
      )}
    </Sheet>
  );
}
