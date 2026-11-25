import { IconAlertTriangle, IconCheck, IconChevronDown, IconEye, IconEyeOff, IconMinus, IconPlus, IconSearch, IconX } from "@tabler/icons-react";
import { Checkbox as RCheckbox, RadioGroup as RRadio, Select as RSelect, Switch as RSwitch, ToggleGroup } from "radix-ui";
import { createContext, useContext, useId, useState, type ComponentProps, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "./cn";
import { usePortalWs } from "./hooks";

/* ----- Field: label, hint and error wiring. Any kit control inside picks the ids up from context. ----- */

interface FieldCtx {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required: boolean;
  disabled: boolean;
}
const FieldContext = createContext<FieldCtx | null>(null);

function useFieldProps() {
  const f = useContext(FieldContext);
  return f
    ? {
        id: f.id,
        "aria-describedby": f.describedBy,
        "aria-invalid": f.invalid || undefined,
        "aria-required": f.required || undefined,
        disabled: f.disabled || undefined,
      }
    : {};
}

export interface FieldProps {
  label: ReactNode;
  /** Shown under the label, before the control: format, where to find the number, why we ask. */
  hint?: ReactNode;
  /** What is wrong and how to fix it. */
  error?: ReactNode;
  /** Optional fields are marked; required is the default on patient forms, so say which way the form leans. */
  optional?: boolean;
  required?: boolean;
  disabled?: boolean;
  hideLabel?: boolean;
  className?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, optional, required = false, disabled = false, hideLabel, className, children }: FieldProps) {
  const { t } = useTranslation("common");
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <FieldContext value={{ id, describedBy: [hintId, errorId].filter(Boolean).join(" ") || undefined, invalid: Boolean(error), required, disabled }}>
      <div className={cn("field", className)}>
        <label className={cn("field-label", hideLabel && "sr-only")} htmlFor={id}>
          {label}
          {optional && <span className="req">{t("field.optional")}</span>}
          {required && <span className="req">{t("field.required")}</span>}
        </label>
        {hint && (
          <p className="field-hint" id={hintId}>
            {hint}
          </p>
        )}
        {children}
        {error && (
          <p className="field-error" id={errorId}>
            <IconAlertTriangle aria-hidden />
            <span>{error}</span>
          </p>
        )}
      </div>
    </FieldContext>
  );
}

/** A group of controls under one question (radio rows, checkboxes, blood pressure pair). */
export function FieldGroup({ label, hint, error, optional, required, className, children }: Omit<FieldProps, "hideLabel" | "disabled">) {
  const { t } = useTranslation("common");
  const id = useId();
  return (
    <fieldset className={cn("field m-0 border-0 p-0", className)} aria-describedby={error ? `${id}-e` : hint ? `${id}-h` : undefined} aria-invalid={error ? true : undefined}>
      <legend className="field-label mb-1.5 p-0">
        {label}
        {optional && <span className="req">{t("field.optional")}</span>}
        {required && <span className="req">{t("field.required")}</span>}
      </legend>
      {hint && (
        <p className="field-hint" id={`${id}-h`}>
          {hint}
        </p>
      )}
      {children}
      {error && (
        <p className="field-error" id={`${id}-e`}>
          <IconAlertTriangle aria-hidden />
          <span>{error}</span>
        </p>
      )}
    </fieldset>
  );
}

export function Input({ className, ...rest }: ComponentProps<"input">) {
  return <input {...useFieldProps()} className={cn("control", className)} {...rest} />;
}

/** Grows with its text. `rows` is the smallest height. */
export function Textarea({ className, rows = 3, style, ...rest }: ComponentProps<"textarea">) {
  return <textarea {...useFieldProps()} className={cn("control", className)} rows={rows} style={{ minHeight: `calc(${rows} * 1.7em + 1.3rem)`, ...style }} {...rest} />;
}

export function PasswordInput({ className, ...rest }: Omit<ComponentProps<"input">, "type">) {
  const { t } = useTranslation("common");
  const [show, setShow] = useState(false);
  return (
    <span className={cn("control control-wrap pe-1", className)} data-invalid={useContext(FieldContext)?.invalid}>
      <input {...useFieldProps()} {...rest} type={show ? "text" : "password"} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      <button type="button" className="icon-btn" data-size="sm" aria-pressed={show} aria-label={show ? t("field.hidePassword") : t("field.showPassword")} onClick={() => setShow(!show)}>
        {show ? <IconEyeOff size={20} aria-hidden /> : <IconEye size={20} aria-hidden />}
      </button>
    </span>
  );
}

export function SearchInput({ value, onValueChange, className, placeholder, ...rest }: Omit<ComponentProps<"input">, "value" | "onChange" | "type"> & { value: string; onValueChange: (v: string) => void }) {
  const { t } = useTranslation("common");
  return (
    <span className={cn("control control-wrap", value && "pe-1", className)}>
      <IconSearch aria-hidden />
      <input {...useFieldProps()} type="text" inputMode="search" enterKeyHint="search" role="searchbox" value={value} onChange={(e) => onValueChange(e.target.value)} placeholder={placeholder ?? t("action.search")} {...rest} aria-label={rest["aria-label"] ?? placeholder ?? t("action.search")} />
      {value && (
        <button type="button" className="icon-btn" data-size="sm" aria-label={t("action.clear")} onClick={() => onValueChange("")}>
          <IconX size={18} aria-hidden />
        </button>
      )}
    </span>
  );
}

/** Native <select>: right for long lists and for phones, where the system picker is best. */
export function NativeSelect({ className, children, ...rest }: ComponentProps<"select">) {
  return (
    <span className="relative block">
      <select {...useFieldProps()} className={cn("control appearance-none pe-9", className)} {...rest}>
        {children}
      </select>
      <IconChevronDown size={18} className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-fg-2" aria-hidden />
    </span>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export function Select({ value, onValueChange, options, placeholder, className, label, size, disabled }: { value: string | undefined; onValueChange: (v: string) => void; options: SelectOption[]; placeholder?: string; className?: string; label?: string; size?: "sm"; disabled?: boolean }) {
  const { t } = useTranslation("common");
  const f = useFieldProps();
  const ws = usePortalWs();
  return (
    <RSelect.Root value={value} onValueChange={onValueChange} disabled={disabled ?? f.disabled}>
      <RSelect.Trigger {...f} aria-label={label} className={cn("control flex items-center justify-between gap-2 text-start data-[placeholder]:text-fg-3", size === "sm" && "min-h-ctl-sm w-auto py-0", className)}>
        <span className="truncate">
          <RSelect.Value placeholder={placeholder ?? t("field.choose")} />
        </span>
        <RSelect.Icon asChild>
          <IconChevronDown size={18} className="flex-none text-fg-2" aria-hidden />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content className="popup menu" position="popper" sideOffset={4} collisionPadding={12} style={{ minWidth: "var(--radix-select-trigger-width)", maxHeight: "var(--radix-select-content-available-height)" }} {...ws}>
          <RSelect.Viewport>
            {options.map((o) => (
              <RSelect.Item key={o.value} value={o.value} disabled={o.disabled} className="menu-item">
                <span className="grid place-items-center">
                  <RSelect.ItemIndicator>
                    <IconCheck size={18} aria-hidden />
                  </RSelect.ItemIndicator>
                </span>
                <span className="min-w-0">
                  <RSelect.ItemText>{o.label}</RSelect.ItemText>
                  {o.hint && <span className="block text-sm text-fg-2">{o.hint}</span>}
                </span>
                <span aria-hidden="true" />
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

export function Checkbox({ label, hint, className, ...rest }: Omit<ComponentProps<typeof RCheckbox.Root>, "children"> & { label: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className={cn("check", className)}>
      <RCheckbox.Root id={id} className="check-box" aria-describedby={hint ? `${id}-h` : undefined} {...rest}>
        <RCheckbox.Indicator>{rest.checked === "indeterminate" ? <IconMinus aria-hidden /> : <IconCheck stroke={3} aria-hidden />}</RCheckbox.Indicator>
      </RCheckbox.Root>
      <label htmlFor={id} className="cursor-pointer">
        <span className="block">{label}</span>
        {hint && (
          <span className="block text-sm text-fg-2" id={`${id}-h`}>
            {hint}
          </span>
        )}
      </label>
    </div>
  );
}

export interface RadioOption {
  value: string;
  label: ReactNode;
  hint?: ReactNode;
  /** Right edge: a StatusTag, a date, a distance. */
  end?: ReactNode;
  disabled?: boolean;
}

/** Choices as ruled rows in one box. `columns={2}` suits yes/no. */
export function RadioRows({ value, onValueChange, options, label, columns = 1, className, disabled }: { value: string | undefined; onValueChange: (v: string) => void; options: RadioOption[]; label?: string; columns?: 1 | 2; className?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <RRadio.Root value={value ?? ""} onValueChange={onValueChange} disabled={disabled} aria-label={label} className={cn("radio-rows", className)} data-columns={columns}>
      {options.map((o) => (
        <label key={o.value} data-checked={o.value === value} data-disabled={o.disabled || disabled} htmlFor={`${id}-${o.value}`}>
          <RRadio.Item value={o.value} id={`${id}-${o.value}`} disabled={o.disabled} className="check-box radio-dot" />
          <span className="min-w-0">
            <span className={cn("block", o.hint && "font-semibold")}>{o.label}</span>
            {o.hint && <span className="block text-sm text-fg-2">{o.hint}</span>}
          </span>
          {o.end && <span className="self-center">{o.end}</span>}
        </label>
      ))}
    </RRadio.Root>
  );
}

export function Segmented({ value, onValueChange, options, label, className }: { value: string; onValueChange: (v: string) => void; options: { value: string; label: ReactNode; count?: number }[]; label: string; className?: string }) {
  return (
    <ToggleGroup.Root type="single" value={value} onValueChange={(v) => v && onValueChange(v)} aria-label={label} className={cn("segmented", className)}>
      {options.map((o) => (
        <ToggleGroup.Item key={o.value} value={o.value}>
          {o.label}
          {o.count !== undefined && <span className="count">{o.count}</span>}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

export function Switch({ label, hint, className, ...rest }: Omit<ComponentProps<typeof RSwitch.Root>, "children"> & { label: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className={cn("flex min-h-ctl items-start justify-between gap-4 py-1.5", className)}>
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block font-medium">{label}</span>
        {hint && (
          <span className="block text-sm text-fg-2" id={`${id}-h`}>
            {hint}
          </span>
        )}
      </label>
      <RSwitch.Root id={id} className="switch" aria-describedby={hint ? `${id}-h` : undefined} {...rest}>
        <RSwitch.Thumb />
      </RSwitch.Root>
    </div>
  );
}

export interface NumberFieldProps {
  value: number | null;
  onValueChange: (v: number | null) => void;
  unit?: ReactNode;
  min?: number;
  max?: number;
  step?: number;
  /** Plus and minus buttons, for values people nudge. Off for measurements people copy from a device. */
  steppers?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
}

export function NumberField({ value, onValueChange, unit, min, max, step = 1, steppers, placeholder, className, ...rest }: NumberFieldProps) {
  const { t } = useTranslation("common");
  const f = useFieldProps();
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  const nudge = (d: number) => onValueChange(clamp(Number(((value ?? min ?? 0) + d).toFixed(4))));
  return (
    <span className={cn("control number-field", className)} data-invalid={f["aria-invalid"]} data-disabled={f.disabled}>
      <input
        {...f}
        {...rest}
        type="text"
        inputMode={Number.isInteger(step) ? "numeric" : "decimal"}
        autoComplete="off"
        placeholder={placeholder}
        value={draft ?? (value === null ? "" : String(value))}
        onChange={(e) => {
          // Full-width digits arrive from Chinese keyboards.
          const text = e.target.value.replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
          if (!/^-?\d*\.?\d*$/.test(text)) return;
          setDraft(text);
          const n = Number.parseFloat(text);
          onValueChange(Number.isFinite(n) ? n : null);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          setDraft(null);
          nudge(e.key === "ArrowUp" ? step : -step);
        }}
      />
      {unit && <span className="unit">{unit}</span>}
      {steppers && (
        <>
          <button type="button" className="stepper-btn" tabIndex={-1} aria-label={t("field.decrease")} disabled={f.disabled || (min !== undefined && value !== null && value <= min)} onClick={() => nudge(-step)}>
            <IconMinus size={18} aria-hidden />
          </button>
          <button type="button" className="stepper-btn" tabIndex={-1} aria-label={t("field.increase")} disabled={f.disabled || (max !== undefined && value !== null && value >= max)} onClick={() => nudge(step)}>
            <IconPlus size={18} aria-hidden />
          </button>
        </>
      )}
    </span>
  );
}

/** Native date input: every platform already ships a calendar people know. Value is YYYY-MM-DD. */
export function DateField({ value, onValueChange, className, ...rest }: Omit<ComponentProps<"input">, "value" | "onChange" | "type"> & { value: string | null; onValueChange: (v: string | null) => void }) {
  return <input {...useFieldProps()} type="date" className={cn("control num min-w-44", className)} value={value ?? ""} onChange={(e) => onValueChange(e.target.value || null)} {...rest} />;
}
