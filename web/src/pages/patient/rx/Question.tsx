import { IconClipboardHeart } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import type { MonitoringValue, ProtocolQuestion } from "@/api/types";
import { monitoringAge } from "@/lib/rx";
import { Badge, Button, DateField, Field, FieldGroup, NumberField, RadioRows, StatusTag, Textarea } from "@/ui";

import { useFmt } from "../shared";
import { ageDays, sameAs, type Suggestion } from "./rules";

export interface QuestionProps {
  q: ProtocolQuestion;
  value: unknown;
  onChange: (v: unknown) => void;
  error?: string;
  suggestion?: Suggestion | null;
  today: string;
}

/** One question of the protocol, drawn from its kind. Labels and help come from the server in the reader's language. */
export function Question({ q, value, onChange, error, suggestion, today }: QuestionProps) {
  const { t } = useTranslation("patient");
  const id = `q-${q.id.replace(/[^\w-]/g, "_")}`;
  if (q.kind === "boolean" || q.kind === "choice")
    return (
      <div id={id} className="scroll-mt-6">
        <FieldGroup label={q.label} hint={q.help || undefined} error={error} optional={!q.required}>
          <RadioRows
            label={q.label}
            columns={q.kind === "boolean" ? 2 : 1}
            value={typeof value === "boolean" ? String(value) : typeof value === "string" ? value : undefined}
            onValueChange={(v) => onChange(q.kind === "boolean" ? v === "true" : v)}
            options={
              q.kind === "boolean"
                ? [
                    { value: "true", label: t("wizard.yes") },
                    { value: "false", label: t("wizard.no") },
                  ]
                : q.options.map((o) => ({ value: o.value, label: o.label }))
            }
          />
        </FieldGroup>
      </div>
    );
  const hint = [q.help, q.kind === "number" && q.min !== null && q.max !== null ? t("wizard.range", { min: q.min, max: q.max, unit: q.unit ?? "" }) : null].filter(Boolean).join(" ");
  return (
    <div id={id} className="scroll-mt-6">
      <Field label={q.label} hint={hint || undefined} error={error} optional={!q.required}>
        {q.kind === "number" ? (
          <NumberField className="max-w-xs" value={typeof value === "number" ? value : null} onValueChange={(n) => onChange(n ?? undefined)} unit={q.unit ?? undefined} step={0.1} />
        ) : q.kind === "date" ? (
          <DateField className="max-w-xs" value={typeof value === "string" ? value : null} max={today} onValueChange={(d) => onChange(d ?? undefined)} />
        ) : (
          <Textarea rows={3} value={typeof value === "string" ? value : ""} maxLength={1000} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />
        )}
      </Field>
      {suggestion && suggestion.value !== undefined && suggestion.value !== value && <SuggestionRow s={suggestion} unit={q.unit} today={today} onUse={() => onChange(suggestion.value)} />}
    </div>
  );
}

/** A value from the health record: how old, how many readings, from whom, and one button. */
function SuggestionRow({ s, unit, today, onUse }: { s: Suggestion; unit: string | null; today: string; onUse: () => void }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const what = s.value !== undefined ? `${s.value}${unit ? ` ${unit}` : ""}` : s.date ? f.date(s.date, "long") : "";
  const when = s.count > 1 ? t("wizard.sugAverage", { count: s.count, range: f.range(s.from, s.to) }) : t("wizard.sugSingle", { date: f.date(s.to, "long"), days: ageDays(s.to, today) });
  return (
    <div className="prefill">
      <IconClipboardHeart size={20} className="flex-none text-ink-text" aria-hidden />
      <span>
        {t("wizard.sugLead")} <b className="num">{what}</b> <span className="text-fg-2">{when}</span> <span className="text-fg-2">{t(`wizard.sugSource_${s.source}`)}</span>
      </span>
      <Button size="sm" onClick={onUse}>
        {t("wizard.sugUse")}
      </Button>
    </div>
  );
}

/** A monitoring item: value and date, where they come from and whether they are still recent enough. */
export function Monitoring({ q, value, onChange, error, suggestion, today }: { q: ProtocolQuestion; value: MonitoringValue | undefined; onChange: (v: MonitoringValue | null) => void; error?: string; suggestion?: Suggestion | null; today: string }) {
  const { t } = useTranslation("patient");
  const age = monitoringAge(q, value, today);
  const patch = (part: Partial<MonitoringValue>) => {
    const next: MonitoringValue = { ...(value ?? {}), ...part, source: "patient" };
    if (next.value === undefined) delete next.value;
    if (next.date === undefined) delete next.date;
    onChange(next.value === undefined && next.date === undefined ? null : next);
  };
  const id = `q-${q.id.replace(/[^\w-]/g, "_")}`;
  return (
    <div id={id} className="scroll-mt-6">
      <FieldGroup label={q.label} hint={q.help || (q.max_age_days !== null ? t("wizard.monHint", { count: q.max_age_days }) : undefined)} error={error} optional={!q.required}>
        <div className="flex flex-wrap gap-3">
          {q.kind === "number" && <NumberField className="max-w-52" aria-label={t("wizard.monValue", { label: q.label })} value={value?.value ?? null} onValueChange={(n) => patch({ value: n ?? undefined })} unit={q.unit ?? undefined} step={0.1} />}
          <DateField className="max-w-52" aria-label={t("wizard.monDate", { label: q.label })} value={value?.date ?? null} max={today} onValueChange={(d) => patch({ date: d ?? undefined })} />
        </div>
      </FieldGroup>
      {value && age && (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-2">
          <StatusTag family="source" status={value.source} plain />
          <span className="num">{t("wizard.monAge", { count: age.days })}</span>
          {age.stale && (
            <Badge tone="warn">
              {t("wizard.monStale", { count: q.max_age_days ?? 0 })}
            </Badge>
          )}
        </p>
      )}
      {suggestion && !sameAs(suggestion, value) && (suggestion.date ?? "") > (value?.date ?? "") && (
        <SuggestionRow s={suggestion} unit={q.unit} today={today} onUse={() => onChange({ ...(q.kind === "number" && suggestion.value !== undefined ? { value: suggestion.value } : {}), date: suggestion.date, source: "patient" })} />
      )}
      {!value && <p className="mt-2 text-sm text-fg-2">{t("wizard.monSkip")}</p>}
    </div>
  );
}
