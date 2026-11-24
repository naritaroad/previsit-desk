// Refill check tab: a structured form (the server computes the answer, no model involved) and the
// result card for the four outcomes. A demo-only switch can change what "today" means.

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client.ts";
import type { RefillResult, SpecialStatus } from "../api/types.ts";
import { describeApiError } from "../lib/errors.ts";
import {
  SPECIAL_STATUSES,
  defaultRefillForm,
  hasErrors,
  serverFieldErrors,
  toRefillInput,
  validateRefillForm,
  type RefillErrors,
  type RefillFieldKey,
  type RefillFormValues,
} from "../lib/refillForm.ts";
import type { VisitController } from "../hooks/useVisit.ts";
import { latestRefill } from "../state/visitReducer.ts";
import { Icon } from "./Icon.tsx";
import { RefillResultCard } from "./RefillResultCard.tsx";

interface Props {
  visit: VisitController;
  serverToday: string;
}

export function RefillPanel({ visit, serverToday }: Props) {
  const { t } = useTranslation();
  const uid = useId();
  const [values, setValues] = useState<RefillFormValues>(() => defaultRefillForm(serverToday));
  const [errors, setErrors] = useState<RefillErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof describeApiError> | null>(null);
  const [fresh, setFresh] = useState<RefillResult | null>(null);
  const resultRef = useRef<HTMLElement>(null);
  const todayRef = useRef(serverToday);

  // The server's date arrives after the first render; move the untouched example dates with it.
  useEffect(() => {
    if (todayRef.current !== serverToday) {
      todayRef.current = serverToday;
      setValues((v) => (v.use_today_override ? v : defaultRefillForm(serverToday)));
    }
  }, [serverToday]);

  const stored = latestRefill(visit.state)?.result ?? null;
  const result = fresh ?? stored;

  const set = <K extends keyof RefillFormValues>(key: K, value: RefillFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const id = (name: string) => `${uid}-${name}`;
  const err = (key: RefillFieldKey) => errors[key];

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const found = validateRefillForm(values, serverToday);
    setErrors(found);
    setError(null);
    if (hasErrors(found)) {
      const first = (Object.keys(found) as RefillFieldKey[])[0];
      document.getElementById(id(first))?.focus();
      return;
    }
    setBusy(true);
    try {
      const r = await visit.refill(toRefillInput(values));
      setFresh(r);
      // Move focus to the result so a screen reader reads it.
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (ex) {
      if (ex instanceof ApiError && ex.code === "invalid_request" && Object.keys(ex.fields).length) {
        setErrors(serverFieldErrors(ex.fields));
      }
      setError(describeApiError(ex));
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (key: RefillFieldKey) =>
    err(key) ? (
      <span className="form-err" id={id(`${key}-err`)}>
        <Icon name="alert" size="sm" />
        {t(`refill.errors.${err(key)}`)}
      </span>
    ) : null;
  const invalid = (key: RefillFieldKey) => (err(key) ? { "aria-invalid": true as const, "aria-describedby": id(`${key}-err`) } : {});

  return (
    <div className="stack">
      <form className="stack" onSubmit={onSubmit} noValidate aria-describedby={id("intro")}>
        <p id={id("intro")} className="text-sm text-muted">
          {t("refill.intro")}
        </p>
        <p className="form-hint">{t("refill.exampleNote")}</p>
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor={id("prescription_date")}>{t("refill.prescriptionDate")}</label>
            <input className="field" id={id("prescription_date")} type="date" value={values.prescription_date} onChange={(e) => set("prescription_date", e.target.value)} {...invalid("prescription_date")} />
            {fieldError("prescription_date")}
          </div>
          <div className="form-field">
            <label htmlFor={id("total_days")}>{t("refill.totalDays")}</label>
            <input className="field num" id={id("total_days")} inputMode="numeric" autoComplete="off" value={values.total_days} onChange={(e) => set("total_days", e.target.value)} {...invalid("total_days")} />
            {fieldError("total_days") ?? <span className="form-hint">{t("refill.totalDaysHint")}</span>}
          </div>
          <div className="form-field">
            <label htmlFor={id("days_per_fill")}>{t("refill.daysPerFill")}</label>
            <input className="field num" id={id("days_per_fill")} inputMode="numeric" autoComplete="off" value={values.days_per_fill} onChange={(e) => set("days_per_fill", e.target.value)} {...invalid("days_per_fill")} />
            {fieldError("days_per_fill") ?? <span className="form-hint">{t("refill.daysPerFillHint")}</span>}
          </div>
          <div className="form-field">
            <label htmlFor={id("last_fill_date")}>{t("refill.lastFillDate")}</label>
            <input className="field" id={id("last_fill_date")} type="date" value={values.last_fill_date} onChange={(e) => set("last_fill_date", e.target.value)} {...invalid("last_fill_date")} />
            {fieldError("last_fill_date")}
          </div>
        </div>

        <fieldset className="form-field">
          <legend className="form-legend">{t("refill.fillsDone")}</legend>
          <div className="seg">
            {["1", "2", "3"].map((n) => (
              <label key={n}>
                <input type="radio" name={id("fills")} value={n} checked={values.fills_done === n} onChange={() => set("fills_done", n)} />
                <span>{t("refill.fillsOption", { count: Number(n) })}</span>
              </label>
            ))}
          </div>
          <span className="form-hint">{t("refill.fillsHint")}</span>
          {fieldError("fills_done")}
        </fieldset>

        <fieldset className="form-field">
          <legend className="form-legend">{t("refill.controlled")}</legend>
          <div className="seg">
            {(["no", "yes", "unsure"] as const).map((c) => (
              <label key={c}>
                <input type="radio" name={id("controlled")} value={c} checked={values.controlled === c} onChange={() => set("controlled", c)} />
                <span>{t(`refill.controlledOption.${c}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="form-field">
          <label htmlFor={id("special")}>{t("refill.special")}</label>
          <select className="field" id={id("special")} value={values.special_status} onChange={(e) => set("special_status", e.target.value as SpecialStatus)}>
            {SPECIAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`refill.specialOption.${s}`)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="check">
            <input type="checkbox" checked={values.symptom_changed} onChange={(e) => set("symptom_changed", e.target.checked)} />
            {t("refill.symptomChanged")}
          </label>
          <label className="check">
            <input type="checkbox" checked={values.side_effects} onChange={(e) => set("side_effects", e.target.checked)} />
            {t("refill.sideEffects")}
          </label>
        </div>

        <details className="demo-box" open={values.use_today_override}>
          <summary>
            {t("refill.demoTitle")} <span className="chip">{t("refill.demoBadge")}</span>
          </summary>
          <div className="stack-sm">
            <label className="check">
              <input type="checkbox" checked={values.use_today_override} onChange={(e) => set("use_today_override", e.target.checked)} />
              {t("refill.demoToggle")}
            </label>
            <div className="form-field">
              <label htmlFor={id("today_override")}>{t("refill.today")}</label>
              <input
                className="field"
                id={id("today_override")}
                type="date"
                disabled={!values.use_today_override}
                value={values.today_override}
                onChange={(e) => set("today_override", e.target.value)}
                {...invalid("today_override")}
              />
              {fieldError("today_override") ?? <span className="form-hint">{t("refill.todayHint", { date: serverToday })}</span>}
            </div>
          </div>
        </details>

        {error ? (
          <div className="notice" role="alert">
            <Icon name={error.key === "errors.offline" ? "wifi" : "alert"} />
            <p>{t(error.key, error.params)}</p>
          </div>
        ) : null}

        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? t("refill.checking") : t("refill.submit")}
        </button>
      </form>

      <div aria-live="polite">{result ? <RefillResultCard ref={resultRef} result={result} headingLevel={2} /> : null}</div>
    </div>
  );
}
