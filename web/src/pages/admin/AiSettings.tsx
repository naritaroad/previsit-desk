import { IconPlayerPlay, IconPlayerStop, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { AdminSettings } from "@/api/types";
import { useAdminOverview, useAudit, useModels } from "@/data";
import { formatDateTime, formatUsd } from "@/lib/format";
import { Banner, Button, Callout, Checkbox, Dialog, Field, FieldGroup, IconButton, LoadMore, NativeSelect, NumberField, PageBody, PageHeader, Panel, RadioRows, SkeletonRows, StatusTag, Timeline, toast, useLocale } from "@/ui";

import { LoadProblem, Problem } from "../pharmacy/shared/problem";
import { personName } from "../pharmacy/shared/names";
import { useAuditText } from "./lib/audit";
import { THINKING, unpriced } from "./lib/settings";
import { SaveBar, useSettingsForm, type SettingsForm } from "./lib/useSettingsForm";

export default function AiSettings() {
  const { t } = useTranslation("admin");
  const models = useModels();
  const form = useSettingsForm(models.data);
  const s = form.value;
  return (
    <PageBody>
      <PageHeader title={t("ai.title")} lede={t("ai.lede")} meta={s ? <span className="num">{t("ai.revision", { n: form.query.data?.revision ?? s.revision })}</span> : undefined} />
      {form.query.isError && !s ? (
        <LoadProblem error={form.query.error} onRetry={() => void form.query.refetch()} />
      ) : !s ? (
        <SkeletonRows rows={10} />
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(18rem,1fr)]">
          <div className="min-w-0">
            <div className="grid gap-5">
              <Switch form={form} on={(form.query.data ?? s).ai.enabled} />
              <Models form={form} s={s} choices={models.data} />
              <Budget form={form} s={s} />
              <Prices form={form} s={s} choices={models.data} />
              <Limits form={form} s={s} />
              <Deadlines form={form} s={s} />
            </div>
            <SaveBar form={form} />
          </div>
          <History />
        </div>
      )}
    </PageBody>
  );
}

/* ----- The emergency stop ----- */

function Switch({ form, on }: { form: SettingsForm; on: boolean }) {
  const { t } = useTranslation("admin");
  const [ask, setAsk] = useState(false);
  const [sure, setSure] = useState(false);
  const close = () => {
    setAsk(false);
    setSure(false);
  };
  const flip = () =>
    form.saveNow("ai.enabled", !on, () => {
      close();
      toast.ok(t(on ? "switch.stopped" : "switch.started"));
    });
  return (
    <Panel title={<span id="switch">{t("switch.title")}</span>} meta={<StatusTag family="account" status={on ? "active" : "disabled"} />} actions={<Button icon={on ? <IconPlayerStop aria-hidden /> : <IconPlayerPlay aria-hidden />} onClick={() => setAsk(true)}>{t(on ? "switch.stop" : "switch.start")}</Button>}>
      <p>{t(on ? "switch.onBody" : "switch.offBody")}</p>
      <Dialog
        open={ask}
        onOpenChange={(o) => !o && close()}
        title={t(on ? "switch.stopTitle" : "switch.startTitle")}
        description={t(on ? "switch.stopLede" : "switch.startLede")}
        width="36rem"
        footer={
          <>
            <Button onClick={close}>{t("switch.cancel")}</Button>
            <Button variant={on ? "destructive" : "primary"} disabled={on && !sure} loading={form.saving} onClick={flip}>
              {t(on ? "switch.stop" : "switch.start")}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {on ? (
            <>
              <div>
                <p className="font-bold">{t("switch.stopsTitle")}</p>
                <ul className="mt-1 list-disc ps-5">
                  <li>{t("switch.stops1")}</li>
                  <li>{t("switch.stops2")}</li>
                  <li>{t("switch.stops3")}</li>
                </ul>
              </div>
              <div>
                <p className="font-bold">{t("switch.keepsTitle")}</p>
                <ul className="mt-1 list-disc ps-5">
                  <li>{t("switch.keeps1")}</li>
                  <li>{t("switch.keeps2")}</li>
                  <li>{t("switch.keeps3")}</li>
                </ul>
              </div>
              <Checkbox label={t("switch.sure")} checked={sure} onCheckedChange={(v) => setSure(v === true)} />
            </>
          ) : (
            <p>{t("switch.startBody")}</p>
          )}
          {form.dirty.length > 0 && <Callout tone="info">{t("switch.separate")}</Callout>}
          {form.error ? <Problem error={form.error} /> : null}
        </div>
      </Dialog>
    </Panel>
  );
}

/* ----- Models ----- */

const NONE = "none";

function Models({ form, s, choices }: { form: SettingsForm; s: AdminSettings; choices: string[] | undefined }) {
  const { t } = useTranslation("admin");
  // A model saved earlier that left the list stays visible, so it can be replaced knowingly.
  const options = (current: string | null) => [...new Set([...(choices ?? []), ...(current ? [current] : [])])];
  return (
    <Panel title={t("models.title")}>
      <div className="grid gap-5">
        <div className="grid gap-5 md:grid-cols-2">
          <Field label={t("setting.ai_primary")} hint={t("models.primaryHint")} error={form.errorOf("ai.primary")}>
            <NativeSelect value={s.ai.primary} onChange={(e) => form.set("ai.primary", e.target.value)}>
              {options(s.ai.primary).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t("setting.ai_fallback")} hint={t("models.fallbackHint")} error={form.errorOf("ai.fallback")}>
            <NativeSelect value={s.ai.fallback ?? NONE} onChange={(e) => form.set("ai.fallback", e.target.value === NONE ? null : e.target.value)}>
              <option value={NONE}>{t("models.noFallback")}</option>
              {options(s.ai.fallback).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <FieldGroup label={t("setting.ai_thinking")} hint={t("models.thinkingHint")} error={form.errorOf("ai.thinking")}>
          <RadioRows label={t("setting.ai_thinking")} value={s.ai.thinking} onValueChange={(v) => form.set("ai.thinking", v)} options={THINKING.map((v) => ({ value: v, label: t(`thinking.${v}`), hint: t(`thinkingHint.${v}`) }))} />
        </FieldGroup>
        <div className="grid gap-5 md:grid-cols-2">
          <Field label={t("setting.ai_temperature")} hint={t("models.temperatureHint")} error={form.errorOf("ai.temperature")}>
            <NumberField value={s.ai.temperature} onValueChange={(v) => form.set("ai.temperature", v)} min={0} max={2} step={0.1} steppers />
          </Field>
          <Field label={t("setting.ai_max_steps")} hint={t("models.stepsHint")} error={form.errorOf("ai.max_steps")}>
            <NumberField value={s.ai.max_steps} onValueChange={(v) => form.set("ai.max_steps", v)} min={1} max={12} steppers unit={t("unit.steps")} />
          </Field>
        </div>
        <p className="text-sm text-fg-2">{t("models.choices")}</p>
      </div>
    </Panel>
  );
}

/* ----- Budget and prices ----- */

function Budget({ form, s }: { form: SettingsForm; s: AdminSettings }) {
  const { t } = useTranslation("admin");
  const locale = useLocale();
  const overview = useAdminOverview();
  const spent = overview.data?.totals.month_cost_usd;
  const none = unpriced(s);
  const b = s.ai.monthly_budget_usd;
  return (
    <Panel title={t("budget.title")} meta={spent === undefined ? undefined : <span className="num">{t("budget.spent", { value: formatUsd(spent, locale) })}</span>}>
      <div className="grid gap-5">
        <div className="grid gap-5 md:grid-cols-2">
          <Field label={t("setting.ai_monthly_budget_usd")} hint={t("budget.hint")} error={form.errorOf("ai.monthly_budget_usd")}>
            <NumberField value={b} onValueChange={(v) => form.set("ai.monthly_budget_usd", v)} min={0} max={100000} step={0.01} unit={t("unit.usd")} placeholder={t("settings.noLimit")} />
          </Field>
          <div className="grid content-end gap-5">
            <Field label={t("setting.ai_daily_call_limit")} hint={t("budget.callsHint")} error={form.errorOf("ai.daily_call_limit")}>
              <NumberField value={s.ai.daily_call_limit} onValueChange={(v) => form.set("ai.daily_call_limit", v)} min={0} max={100000} unit={t("unit.calls")} />
            </Field>
          </div>
          <Field label={t("setting.ai_per_client_daily_limit")} hint={t("budget.clientHint")} error={form.errorOf("ai.per_client_daily_limit")}>
            <NumberField value={s.ai.per_client_daily_limit} onValueChange={(v) => form.set("ai.per_client_daily_limit", v)} min={0} max={100000} unit={t("unit.calls")} />
          </Field>
        </div>
        <FieldGroup label={t("setting.ai_on_budget")} error={form.errorOf("ai.on_budget")}>
          <RadioRows
            label={t("setting.ai_on_budget")}
            value={s.ai.on_budget}
            onValueChange={(v) => form.set("ai.on_budget", v)}
            options={(["fallback", "stop"] as const).map((v) => ({ value: v, label: t(`onBudget.${v}`), hint: t(`onBudgetHint.${v}`) }))}
          />
        </FieldGroup>
        {b !== null && none.length > 0 && (
          <Banner tone="warn" role="note" title={t("budget.unpricedTitle")}>
            {t("budget.unpriced", { list: none.join(t("pharmacy:listSep")) })}
          </Banner>
        )}
        {b !== null && s.ai.on_budget === "fallback" && s.ai.fallback === null && (
          <Banner tone="warn" role="note">
            {t("budget.noFallback")}
          </Banner>
        )}
        {b === 0 && (
          <Banner tone="warn" role="note">
            {t("budget.zero")}
          </Banner>
        )}
      </div>
    </Panel>
  );
}

function Prices({ form, s, choices }: { form: SettingsForm; s: AdminSettings; choices: string[] | undefined }) {
  const { t } = useTranslation("admin");
  const names = Object.keys(s.ai.prices).sort();
  const missing = (choices ?? []).filter((m) => !(m in s.ai.prices));
  const [add, setAdd] = useState("");
  return (
    <Panel title={<span id="prices">{t("prices.title")}</span>} meta={<span>{t("prices.unit")}</span>}>
      <p className="mb-3 max-w-[46em] text-fg-2">{t("prices.lede")}</p>
      {names.length === 0 ? (
        <p className="py-2">{t("prices.empty")}</p>
      ) : (
        <table className="ruled-table">
          <caption className="sr-only">{t("prices.title")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("prices.model")}</th>
              <th scope="col">{t("prices.in")}</th>
              <th scope="col">{t("prices.out")}</th>
              <th scope="col">
                <span className="sr-only">{t("prices.remove")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {names.map((m) => {
              const p = s.ai.prices[m];
              const path = `ai.prices.${m}`;
              const error = form.errorOf(path) ?? form.errorOf("ai.prices");
              return (
                <tr key={m}>
                  <th scope="row">
                    <code className="text-sm break-all">{m}</code>
                    {error && <span className="block text-sm text-warn">{error}</span>}
                  </th>
                  <td>
                    <NumberField className="max-w-40" aria-label={t("prices.inOf", { model: m })} value={p.in} onValueChange={(v) => form.set(path, { ...p, in: v })} min={0} max={1000} step={0.01} unit={t("unit.usd")} />
                  </td>
                  <td>
                    <NumberField className="max-w-40" aria-label={t("prices.outOf", { model: m })} value={p.out} onValueChange={(v) => form.set(path, { ...p, out: v })} min={0} max={1000} step={0.01} unit={t("unit.usd")} />
                  </td>
                  <td>
                    <IconButton label={t("prices.removeOf", { model: m })} onClick={() => form.set(path, null)}>
                      <IconTrash size={20} aria-hidden />
                    </IconButton>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {missing.length > 0 && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field label={t("prices.add")} className="min-w-56">
            <NativeSelect value={add} onChange={(e) => setAdd(e.target.value)}>
              <option value="">{t("prices.choose")}</option>
              {missing.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Button
            disabled={!add}
            onClick={() => {
              form.set(`ai.prices.${add}`, { in: 0, out: 0 });
              setAdd("");
            }}
          >
            {t("prices.addButton")}
          </Button>
        </div>
      )}
    </Panel>
  );
}

/* ----- Limits ----- */

function Limits({ form, s }: { form: SettingsForm; s: AdminSettings }) {
  const { t } = useTranslation("admin");
  return (
    <Panel title={t("limits.title")}>
      <p className="mb-4 max-w-[46em] text-fg-2">{t("limits.lede")}</p>
      <div className="grid gap-5 md:grid-cols-2">
        <Field label={t("setting.limits_messages_per_10min")} hint={t("limits.messagesHint")} error={form.errorOf("limits.messages_per_10min")}>
          <NumberField value={s.limits.messages_per_10min} onValueChange={(v) => form.set("limits.messages_per_10min", v)} min={1} max={1000} unit={t("unit.messages")} />
        </Field>
        <Field label={t("setting.limits_visits_per_10min")} hint={t("limits.visitsHint")} error={form.errorOf("limits.visits_per_10min")}>
          <NumberField value={s.limits.visits_per_10min} onValueChange={(v) => form.set("limits.visits_per_10min", v)} min={1} max={1000} unit={t("unit.visits")} />
        </Field>
        <Field label={t("setting.limits_max_messages_per_visit")} hint={t("limits.maxHint")} error={form.errorOf("limits.max_messages_per_visit")}>
          <NumberField value={s.limits.max_messages_per_visit} onValueChange={(v) => form.set("limits.max_messages_per_visit", v)} min={1} max={500} unit={t("unit.messages")} />
        </Field>
      </div>
    </Panel>
  );
}

function Deadlines({ form, s }: { form: SettingsForm; s: AdminSettings }) {
  const { t } = useTranslation("admin");
  return (
    <Panel title={t("sla.title")}>
      <p className="mb-4 max-w-[46em] text-fg-2">{t("sla.lede")}</p>
      <div className="grid gap-5 md:grid-cols-2">
        <Field label={t("setting.rx_sla_hours_routine")} error={form.errorOf("rx.sla_hours_routine")}>
          <NumberField value={s.rx.sla_hours_routine} onValueChange={(v) => form.set("rx.sla_hours_routine", v)} min={1} max={720} unit={t("unit.hours")} />
        </Field>
        <Field label={t("setting.rx_sla_hours_soon")} error={form.errorOf("rx.sla_hours_soon")}>
          <NumberField value={s.rx.sla_hours_soon} onValueChange={(v) => form.set("rx.sla_hours_soon", v)} min={1} max={720} unit={t("unit.hours")} />
        </Field>
      </div>
      <p className="mt-4 text-sm text-fg-2">{t("sla.phase", { n: s.rx.oversight_phase })}</p>
    </Panel>
  );
}

/* ----- Who changed what ----- */

function History() {
  const { t } = useTranslation("admin");
  const locale = useLocale();
  const words = useAuditText();
  const audit = useAudit({ action: "settings.update" });
  return (
    <Panel title={t("ai.history")} meta={<span>{t("ai.historyNote")}</span>}>
      {audit.isError && !audit.data ? (
        <LoadProblem error={audit.error} onRetry={() => void audit.refetch()} />
      ) : !audit.data ? (
        <SkeletonRows rows={4} />
      ) : audit.items.length === 0 ? (
        <p className="text-fg-2">{t("ai.noHistory")}</p>
      ) : (
        <Timeline label={t("ai.history")} items={audit.items.map((a, i) => ({ id: `${a.at}:${i}`, time: formatDateTime(a.at, locale), dateTime: a.at, what: words.detail(a) || words.action(a.action), who: personName(a.actor) }))} />
      )}
      {audit.hasNextPage && <LoadMore onLoad={() => void audit.fetchNextPage()} loading={audit.isFetchingNextPage} />}
    </Panel>
  );
}
