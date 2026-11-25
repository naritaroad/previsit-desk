import { IconArrowLeft, IconArrowRight, IconSend } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";

import type { RxRequest } from "@/api/types";
import { refillRefusal, useIdempotency, useMeasurements, useMedications, useRxWizard, useToday, type RxWizardHandle } from "@/data";
import { addDays } from "@/lib/format";
import { currentStep, identityKey, identityQuestions, isEditableRx, missingForSubmit, monitoringQuestions, type RxStep } from "@/lib/rx";
import { useFullHeight } from "@/shells/PatientShell";
import {
  Banner,
  Button,
  Callout,
  Checkbox,
  DateField,
  DescriptionList,
  DiffMergeDialog,
  EmergencyPanel,
  Field,
  FieldGroup,
  FormSheet,
  PageBody,
  RadioRows,
  SaveState,
  SkeletonRows,
  StatusTag,
  StepForm,
  Stepper,
  Textarea,
  TextLink,
  type DiffField,
  type StepState,
} from "@/ui";

import { CONSENT_VERSION } from "./consent";
import { Monitoring, Question } from "./rx/Question";
import { PharmacyPicker } from "./rx/PharmacyPicker";
import { activeSteps, isUrgentRx, questionProblem, safetyParts, suggestion, urgentLabels } from "./rx/rules";
import { ActionError, DrugName, LoadError, uiSave, useFmt } from "./shared";
import { RefillNote } from "./visit/TurnRecord";

export default function RxWizard() {
  const { id = "" } = useParams();
  return <Wizard key={id} id={id} />;
}

function Wizard({ id }: { id: string }) {
  useFullHeight();
  const w = useRxWizard(id);
  if (w.phase === "error")
    return (
      <PageBody>
        <LoadError error={w.error} onRetry={() => location.reload()} />
      </PageBody>
    );
  if (!w.rx)
    return (
      <PageBody>
        <SkeletonRows rows={6} />
      </PageBody>
    );
  if (!isEditableRx(w.rx.status)) return <Navigate to={`/app/rx/${id}`} replace />;
  return (
    <>
      <Steps w={w} rx={w.rx} />
      <WizardConflict w={w} />
    </>
  );
}

function Steps({ w, rx }: { w: RxWizardHandle; rx: RxRequest }) {
  const { t } = useTranslation(["patient", "rx"]);
  const f = useFmt();
  const today = useToday();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const idem = useIdempotency();
  const { wizard } = w;

  const steps = activeSteps(rx);
  const stored = currentStep(rx);
  const step: RxStep = steps.includes(stored) ? stored : steps[0];
  const at = steps.indexOf(step);
  const parts = useMemo(() => safetyParts(rx), [rx]);
  const part = Math.min(Math.max(0, Number(params.get("part") ?? "1") - 1), Math.max(0, parts.length - 1));

  const [tried, setTried] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [reply, setReply] = useState("");
  const [actionError, setActionError] = useState<unknown>(null);
  // The patient looked at the emergency notice and wants to correct an answer.
  const [correcting, setCorrecting] = useState(false);
  const urgent = isUrgentRx(rx);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!urgent) setCorrecting(false);
  }, [urgent]);

  const missing = missingForSubmit(rx, today);
  const top = () => {
    body.current?.scrollTo(0, 0);
    requestAnimationFrame(() => body.current?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true }));
  };
  const go = (next: RxStep, toPart = 1) => {
    setTried(false);
    setActionError(null);
    wizard.goTo(next);
    setParams(next === "safety" && toPart > 1 ? { part: String(toPart) } : {}, { replace: false });
    top();
  };
  const focusProblem = (ids: string[]) => {
    requestAnimationFrame(() => {
      const el = document.getElementById(`q-${ids[0].replace(/[^\w-]/g, "_")}`) ?? body.current?.querySelector('[aria-invalid="true"]');
      el?.scrollIntoView({ block: "start" });
      el?.querySelector<HTMLElement>("input, textarea, button")?.focus({ preventScroll: true });
    });
  };

  /** Problems that keep this screen from being left. Other screens are checked on the last one. */
  const problems = (): string[] => {
    if (step === "identity") return identityQuestions(rx).filter((q) => questionProblem(q, rx.answers[q.id])).map((q) => q.id);
    if (step === "safety") return (parts[part]?.questions ?? []).filter((q) => questionProblem(q, rx.answers[q.id])).map((q) => q.id);
    if (step === "monitoring") return missing.filter((m) => m.step === "monitoring").map((m) => m.id);
    if (step === "pharmacy" || step === "pickup") return missing.filter((m) => m.step === step).map((m) => m.id);
    return [];
  };
  const next = async () => {
    const bad = problems();
    if (bad.length > 0) {
      setTried(true);
      focusProblem(bad);
      return;
    }
    if (step === "safety" && part < parts.length - 1) {
      go("safety", part + 2);
      return;
    }
    // The program's checks run on what is saved, so an emergency or a refused refill shows before more typing.
    if (step === "safety" || step === "monitoring") {
      const out = await wizard.evaluate().catch(() => null);
      if (out && isUrgentRx(out)) return;
    }
    go(steps[Math.min(at + 1, steps.length - 1)]);
  };
  const back = () => {
    if (step === "safety" && part > 0) go("safety", part);
    else if (at > 0) go(steps[at - 1], steps[at - 1] === "safety" ? parts.length : 1);
    else void navigate("/app/medications");
  };
  const answer = (id: string, value: unknown) => {
    wizard.setAnswer(id, value);
    // "Yes" may be an emergency: ask the program now instead of at the end. Correcting one may clear it.
    if (value === true || urgent) void wizard.evaluate().catch(() => undefined);
  };
  const submit = async () => {
    setActionError(null);
    try {
      const out = rx.status === "more_info" ? await wizard.reply(reply.trim()) : await wizard.submit(CONSENT_VERSION, idem.key([rx.id, rx.revision]));
      if (out) {
        idem.done();
        await navigate(`/app/rx/${rx.id}?sent=1`, { replace: true });
      } else setTried(true);
    } catch (e) {
      setActionError(e);
    }
  };

  const save = uiSave(w.status, w.status === "offline" ? w.error : null);
  const saveState = save && <SaveState state={save} savedAt={w.savedAt ? f.time(w.savedAt) : undefined} onResolve={save === "error" ? () => void wizard.flush() : undefined} />;
  const stepper = (
    <Stepper
      label={t("patient:wizard.steps")}
      steps={steps.map((s, i): { id: string; label: string; state: StepState } => ({
        id: s,
        label: t(`rx:step.${s}`),
        state: i === at ? "current" : i < at ? (missing.some((m) => m.step === s) ? "error" : "done") : "todo",
      }))}
      onStep={(s) => go(s as RxStep)}
    />
  );

  if (urgent && !correcting)
    return (
      <Frame bodyRef={body}>
        <Urgent rx={rx} w={w} onCorrect={() => setCorrecting(true)} onNotify={() => void submit()} error={actionError} />
      </Frame>
    );

  const common = { w, rx, today, tried };
  const last = step === "review";
  const refillBlocked = rx.kind === "refill" && step === "safety" && part === parts.length - 1 ? rx.items.map((i) => i.refill).find((r) => r && r.outcome !== "eligible") : null;
  const content: Record<RxStep, { title: string; lede?: string; node: ReactNode }> = {
    items: { title: t("patient:wizard.itemsTitle"), lede: t(rx.kind === "renewal" ? "patient:wizard.itemsLede" : "patient:wizard.itemsLedeRefill"), node: <ItemsStep rx={rx} /> },
    identity: { title: t("patient:wizard.identityTitle"), lede: t("patient:wizard.identityLede"), node: <IdentityStep {...common} onAnswer={answer} /> },
    safety: {
      title: parts[part]?.scope === "class" ? t("patient:wizard.safetyClass", { name: className(rx, parts[part].classId, f.locale) }) : t(rx.kind === "refill" ? "patient:wizard.safetyRefill" : "patient:wizard.safetyTitle"),
      lede: parts.length > 1 ? t("patient:wizard.partOf", { n: part + 1, total: parts.length }) : undefined,
      node: (
        <>
          <SafetyStep {...common} part={parts[part]} onAnswer={answer} />
          {refillBlocked && <RefillNote result={refillBlocked} />}
        </>
      ),
    },
    monitoring: { title: t("patient:wizard.monTitle"), lede: t("patient:wizard.monLede"), node: <MonitoringStep {...common} /> },
    pharmacy: {
      title: t("patient:wizard.pharmTitle"),
      lede: t("patient:wizard.pharmLede"),
      node: <PharmacyPicker value={rx.pharmacy} onChange={(p) => wizard.setPharmacy(p)} error={tried && !rx.pharmacy ? t("patient:wizard.pharmNeeded") : undefined} />,
    },
    pickup: { title: t("patient:wizard.pickupTitle"), lede: t("patient:wizard.pickupLede"), node: <PickupStep {...common} /> },
    review: {
      title: t(rx.status === "more_info" ? "patient:wizard.replyTitle" : "patient:wizard.reviewTitle"),
      lede: t(rx.status === "more_info" ? "patient:wizard.replyLede" : "patient:wizard.reviewLede"),
      node: <ReviewStep {...common} missing={missing} onGo={go} agreed={agreed} onAgree={setAgreed} reply={reply} onReply={setReply} error={actionError} onRetry={() => void submit()} />,
    },
  };
  const now = content[step];
  const canSubmit = missing.length === 0 && (rx.status === "more_info" ? reply.trim() !== "" : agreed);
  return (
    <Frame bodyRef={body}>
      <StepForm
        stepper={stepper}
        title={now.title}
        lede={now.lede}
        saveState={saveState}
        back={
          <Button icon={<IconArrowLeft aria-hidden />} onClick={back}>
            {at === 0 ? t("patient:wizard.leave") : t("patient:wizard.back")}
          </Button>
        }
        next={
          last ? (
            <Button
              variant="primary"
              icon={<IconSend aria-hidden />}
              loading={w.submitting}
              onClick={() => {
                if (canSubmit) void submit();
                else setTried(true);
              }}
            >
              {t(rx.status === "more_info" ? "patient:wizard.sendReply" : rx.kind === "refill" ? "patient:wizard.sendRefill" : "patient:wizard.sendRenewal")}
            </Button>
          ) : (
            <Button variant="primary" iconEnd={<IconArrowRight aria-hidden />} loading={w.evaluating} onClick={() => void next()}>
              {t("patient:wizard.next")}
            </Button>
          )
        }
        aside={step === "safety" || step === "monitoring" ? <Aside rx={rx} /> : undefined}
      >
        {urgent && correcting && (
          <EmergencyPanel title={t("patient:wizard.urgentStill")}>
            <p>{t("patient:wizard.urgentStillBody")}</p>
          </EmergencyPanel>
        )}
        {rx.status === "more_info" && rx.decision_note && (
          <Callout tone="warn" title={t("patient:rxd.doctorAsks")}>
            {rx.decision_note}
          </Callout>
        )}
        {now.node}
        {w.status === "offline" && w.error && !last && <ActionError error={w.error} title={t("patient:wizard.saveFailed")} onRetry={() => void wizard.flush()} />}
      </StepForm>
    </Frame>
  );
}

function Frame({ children, bodyRef }: { children: ReactNode; bodyRef: React.Ref<HTMLDivElement> }) {
  return (
    <div ref={bodyRef} className="scroll-y min-h-0 flex-1">
      <PageBody className="min-h-full pb-0">{children}</PageBody>
    </div>
  );
}

function className(rx: RxRequest, classId: string | null, locale: string): string {
  const drug = rx.items.find((i) => i.drug.class_id === classId)?.drug;
  return drug ? (locale === "en" ? drug.class_en : drug.class_zh) : "";
}

function Aside({ rx }: { rx: RxRequest }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  return <FormSheet title={t("wizard.asideTitle")} items={rx.items.map((i) => ({ label: f.drug(i.drug), value: i.dose_text || t("meds.noDose") }))} />;
}

interface StepProps {
  w: RxWizardHandle;
  rx: RxRequest;
  today: string;
  tried: boolean;
}

function ItemsStep({ rx }: { rx: RxRequest }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  return (
    <>
      <div className="grid gap-4">
        {rx.items.map((i) => (
          <section key={i.id} className="edit-box">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <DrugName drug={i.drug} />
              {rx.kind === "renewal" && <StatusTag family="scope" status={i.scope} />}
            </div>
            <DescriptionList
              items={[
                { label: t("meds.doseLabel"), value: i.dose_text || t("meds.noDose") },
                { label: t("meds.class"), value: f.drugClass(i.drug) },
                ...(rx.kind === "renewal" ? [{ label: t("wizard.scopeWhy"), value: i.scope_reason || null }] : []),
              ]}
            />
            {i.scope === "excluded" && (
              <Callout tone="hold" title={t("wizard.excludedTitle")} actions={<TextLink to="/app/appointments/book">{t("advice.bookVisit")}</TextLink>}>
                {t("wizard.excludedBody")}
              </Callout>
            )}
            {i.refill && <RefillNote result={i.refill} />}
          </section>
        ))}
      </div>
      <p className="text-fg-2">
        {t("wizard.changeItems")} <TextLink to={`/app/rx/new?kind=${rx.kind}`}>{t("wizard.changeItemsLink")}</TextLink>
      </p>
    </>
  );
}

function IdentityStep({ w, rx, tried, onAnswer }: StepProps & { onAnswer: (id: string, v: unknown) => void }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const meds = useMedications();
  return (
    <>
      <p className="text-fg-2">{t("wizard.patientLine", { name: rx.patient.display_name })}</p>
      {rx.items
        .filter((i) => i.scope !== "excluded")
        .map((i) => {
          const key = identityKey(i.id);
          const q = rx.questions.find((x) => x.id === key);
          const card = meds.data?.find((m) => m.prescription_id === i.prescription_id);
          const lastFill = card?.fills.at(-1);
          const value = rx.answers[key];
          return (
            <div key={i.id} className="grid gap-4" id={`q-${key.replace(/[^\w-]/g, "_")}`}>
              <FormSheet
                title={f.drug(i.drug)}
                note={f.drugAlt(i.drug)}
                items={[
                  { label: t("meds.doseLabel"), value: i.dose_text || t("meds.noDose") },
                  { label: t("wizard.lastFill"), value: lastFill ? `${f.date(lastFill.filled_on, "long")} ${lastFill.pharmacy_name}` : null },
                ]}
              />
              <FieldGroup label={q?.label ?? t("wizard.sameQuestion", { drug: f.drug(i.drug) })} error={w.fields[key] ?? (tried && typeof value !== "boolean" ? t("wizard.answerNeeded") : undefined)}>
                <RadioRows
                  label={q?.label}
                  columns={2}
                  value={typeof value === "boolean" ? String(value) : undefined}
                  onValueChange={(v) => onAnswer(key, v === "true")}
                  options={[
                    { value: "true", label: t("wizard.sameYes") },
                    { value: "false", label: t("wizard.sameNo") },
                  ]}
                />
              </FieldGroup>
              {value === false && <Callout tone="info">{t("wizard.sameNoNote")}</Callout>}
            </div>
          );
        })}
    </>
  );
}

function useProblemText() {
  const { t } = useTranslation("patient");
  return (p: "required" | "range" | null, q: { min: number | null; max: number | null; unit: string | null }) =>
    p === "required" ? t("wizard.answerNeeded") : p === "range" ? t("wizard.rangeError", { min: q.min ?? "", max: q.max ?? "", unit: q.unit ?? "" }) : undefined;
}

function SafetyStep({ w, rx, today, tried, part, onAnswer }: StepProps & { part: ReturnType<typeof safetyParts>[number] | undefined; onAnswer: (id: string, v: unknown) => void }) {
  const problemText = useProblemText();
  const measurements = useMeasurements();
  if (!part) return null;
  return (
    <div className="q-group">
      {part.questions.map((q) => {
        const value = rx.answers[q.id];
        const problem = questionProblem(q, value);
        return (
          <Question
            key={q.id}
            q={q}
            value={value}
            today={today}
            onChange={(v) => onAnswer(q.id, v)}
            error={w.fields[q.id] ?? (tried || problem === "range" ? problemText(problem, q) : undefined)}
            suggestion={q.kind === "number" ? suggestion(q, measurements.items, today) : null}
          />
        );
      })}
    </div>
  );
}

function MonitoringStep({ w, rx, today, tried }: StepProps) {
  const { t } = useTranslation(["patient", "rx"]);
  const measurements = useMeasurements();
  const missing = missingForSubmit(rx, today).filter((m) => m.step === "monitoring");
  return (
    <>
      <div className="q-group">
        {monitoringQuestions(rx).map((q) => {
          const bad = missing.find((m) => m.id === q.id);
          return (
            <Monitoring
              key={q.id}
              q={q}
              value={rx.monitoring[q.id]}
              today={today}
              onChange={(v) => w.wizard.setMonitoring(q.id, v)}
              error={w.fields[q.id] ?? (bad && (tried || bad.reason !== "required") ? t(`rx:incomplete.${bad.reason}`) : undefined)}
              suggestion={suggestion(q, measurements.items, today)}
            />
          );
        })}
      </div>
      <p>
        <TextLink to="/app/profile/measurements">{t("patient:wizard.toMeasurements")}</TextLink>
      </p>
    </>
  );
}

const SLOTS = ["morning", "afternoon", "evening"] as const;

function PickupStep({ w, rx, today, tried }: StepProps) {
  const { t } = useTranslation(["patient", "rx"]);
  const f = useFmt();
  const meds = useMedications();
  const card = meds.data?.find((m) => m.prescription_id === rx.items[0]?.prescription_id);
  const win = card?.next_window ?? null;
  const from = win && win.from > today ? win.from : today;
  const to = win?.to ?? addDays(today, 30);
  const p = rx.pickup_window;
  const late = Boolean(p && (p.date < from || p.date > to));
  return (
    <>
      <PharmacyPicker value={rx.pharmacy} onChange={(x) => w.wizard.setPharmacy(x)} error={w.fields.pharmacy_id ?? (tried && !rx.pharmacy ? t("patient:wizard.pharmNeeded") : undefined)} />
      <Field
        label={t("patient:wizard.pickupDate")}
        hint={win ? t("patient:wizard.pickupWindow", { range: f.range(win.from, win.to) }) : undefined}
        error={w.fields.pickup_window ?? (late ? t("patient:wizard.pickupOutside", { from: f.date(from, "medium"), to: f.date(to, "medium") }) : tried && !p ? t("patient:wizard.pickupNeeded") : undefined)}
      >
        <DateField className="max-w-xs" value={p?.date ?? null} min={from} max={to} onValueChange={(date) => w.wizard.setPickupWindow(date ? { date, slot: p?.slot ?? "morning" } : null)} />
      </Field>
      <FieldGroup label={t("patient:wizard.pickupSlot")} hint={t("patient:wizard.pickupSlotHint")}>
        <RadioRows
          label={t("patient:wizard.pickupSlot")}
          value={p?.slot}
          disabled={!p}
          onValueChange={(slot) => p && w.wizard.setPickupWindow({ date: p.date, slot: slot as (typeof SLOTS)[number] })}
          options={SLOTS.map((s) => ({ value: s, label: t(`rx:pickupSlot.${s}`) }))}
        />
      </FieldGroup>
    </>
  );
}

function ReviewStep({ w, rx, missing, onGo, agreed, onAgree, reply, onReply, error, onRetry, tried }: StepProps & { missing: ReturnType<typeof missingForSubmit>; onGo: (s: RxStep, part?: number) => void; agreed: boolean; onAgree: (v: boolean) => void; reply: string; onReply: (v: string) => void; error: unknown; onRetry: () => void }) {
  const { t } = useTranslation(["patient", "rx"]);
  const f = useFmt();
  const parts = safetyParts(rx);
  const refused = refillRefusal(error);
  const partOf = (id: string) => parts.findIndex((p) => p.questions.some((q) => q.id === id)) + 1;
  const labelOf = (m: (typeof missing)[number]) => rx.questions.find((q) => q.id === m.id)?.label ?? t(`rx:step.${m.step}`);
  const show = (q: RxRequest["questions"][number]): ReactNode => {
    const v = rx.answers[q.id];
    if (typeof v === "boolean") return t(v ? "patient:wizard.yes" : "patient:wizard.no");
    if (q.kind === "choice") return q.options.find((o) => o.value === v)?.label ?? null;
    if (q.kind === "date" && typeof v === "string") return f.date(v, "long");
    return v === undefined || v === null ? null : `${String(v)}${q.unit ? ` ${q.unit}` : ""}`;
  };
  // The program's preview, on what is saved now. A flag never blocks; it tells the doctor where to look.
  const evaluate = w.wizard;
  useEffect(() => {
    if (missing.length === 0) void evaluate.evaluate().catch(() => undefined);
    // Once when the review opens complete.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluate, missing.length === 0]);
  const fired = rx.items.flatMap((i) => (i.engine?.fired ?? []).map((x) => ({ ...x, drug: f.drug(i.drug) })));
  const uniqueFired = fired.filter((x, i) => fired.findIndex((y) => y.question_id === x.question_id && y.reason === x.reason) === i);

  return (
    <>
      {missing.length > 0 && (
        <Banner tone="warn" role={tried ? "alert" : "status"} title={t("patient:wizard.missingTitle", { count: missing.length })}>
          <ul className="mt-1 grid gap-1">
            {missing.map((m) => (
              <li key={`${m.step}-${m.id}`}>
                <button type="button" className="link text-start" onClick={() => onGo(m.step, m.step === "safety" ? Math.max(1, partOf(m.id)) : 1)}>
                  {labelOf(m)}
                </button>{" "}
                <span className="text-fg-2">{t(`rx:incomplete.${m.reason}`)}</span>
              </li>
            ))}
          </ul>
        </Banner>
      )}

      <Block title={t("patient:wizard.rItems")} onEdit={() => onGo("items")}>
        <DescriptionList items={rx.items.map((i) => ({ label: f.drug(i.drug), value: i.scope === "excluded" ? t("patient:wizard.leftOut") : i.dose_text || t("patient:meds.noDose") }))} />
      </Block>
      {rx.kind === "renewal" && (
        <Block title={t("rx:step.identity")} onEdit={() => onGo("identity")}>
          <DescriptionList items={identityQuestions(rx).map((q) => ({ label: q.label, value: show(q) }))} />
        </Block>
      )}
      {parts.length > 0 && (
        <Block title={t("rx:step.safety")} onEdit={() => onGo("safety")}>
          <DescriptionList items={parts.flatMap((p) => p.questions).map((q) => ({ label: q.label, value: show(q) }))} />
        </Block>
      )}
      {monitoringQuestions(rx).length > 0 && (
        <Block title={t("rx:step.monitoring")} onEdit={() => onGo("monitoring")}>
          <DescriptionList
            items={monitoringQuestions(rx).map((q) => {
              const v = rx.monitoring[q.id];
              return { label: q.label, value: v ? [v.value !== undefined ? `${v.value}${q.unit ? ` ${q.unit}` : ""}` : null, v.date ? f.date(v.date, "long") : null].filter(Boolean).join(t("patient:common.sep")) : <span className="text-fg-3">{t("patient:wizard.notProvided")}</span> };
            })}
          />
        </Block>
      )}
      <Block title={t(rx.kind === "refill" ? "rx:step.pickup" : "rx:step.pharmacy")} onEdit={() => onGo(rx.kind === "refill" ? "pickup" : "pharmacy")}>
        <DescriptionList
          items={[
            { label: t("patient:wizard.pharmacy"), value: rx.pharmacy ? `${rx.pharmacy.name} ${rx.pharmacy.district}${rx.pharmacy.address}` : null },
            ...(rx.kind === "refill" ? [{ label: t("patient:wizard.pickupDate"), value: rx.pickup_window ? `${f.date(rx.pickup_window.date, "full")} ${t(`rx:pickupSlot.${rx.pickup_window.slot}`)}` : null }] : []),
            { label: t("patient:wizard.contact"), value: t("patient:wizard.contactInApp") },
          ]}
        />
      </Block>

      {rx.kind === "renewal" && missing.length === 0 && (
        <section className="review-block" aria-label={t("patient:wizard.checkTitle")}>
          <h2>{t("patient:wizard.checkTitle")}</h2>
          <p className="mt-1 text-fg-2">{t("patient:wizard.checkBody")}</p>
          {w.evaluating ? (
            <p className="mt-2 text-fg-3">{t("patient:wizard.checking")}</p>
          ) : uniqueFired.length > 0 ? (
            <ul className="mt-2 grid gap-2">
              {uniqueFired.map((x) => (
                <li key={`${x.question_id}-${x.reason}`} className="flex flex-wrap items-baseline gap-x-3">
                  <StatusTag family="disposition" status={x.disposition} plain />
                  <span className="min-w-0 flex-1 basis-64">{x.reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            rx.engine && <p className="mt-2">{rx.engine.summary}</p>
          )}
        </section>
      )}

      {rx.status === "more_info" ? (
        <Field label={t("patient:rxd.replyLabel")} hint={t("patient:rxd.replyHint")} error={tried && reply.trim() === "" ? t("patient:rxd.replyNeeded") : undefined}>
          <Textarea rows={4} maxLength={2000} value={reply} onChange={(e) => onReply(e.target.value)} />
        </Field>
      ) : (
        <section className="review-block" aria-label={t("patient:wizard.consentTitle")}>
          <h2>{t("patient:wizard.consentTitle")}</h2>
          <ul className="mt-2 grid list-disc gap-1.5 ps-5">
            {(rx.kind === "renewal" ? ["consent1", "consent2", "consent3", "consent4", "consent5"] : ["consentR1", "consentR2", "consentR3"]).map((k) => (
              <li key={k}>{t(`patient:wizard.${k}`)}</li>
            ))}
          </ul>
          <div className="mt-3">
            <Checkbox label={t(rx.kind === "renewal" ? "patient:wizard.agree" : "patient:wizard.agreeRefill")} checked={agreed} aria-invalid={tried && !agreed ? true : undefined} onCheckedChange={(c) => onAgree(c === true)} />
            {(w.fields.consent_version || (tried && !agreed)) && (
              <p className="field-error mt-1" role="alert">
                {w.fields.consent_version ?? t("patient:wizard.agreeNeeded")}
              </p>
            )}
            <p className="mt-1 text-sm text-fg-3">{t("patient:wizard.consentVersion", { version: CONSENT_VERSION })}</p>
          </div>
        </section>
      )}
      {refused ? <RefillNote result={refused} /> : <ActionError error={error} title={t("patient:wizard.sendFailed")} onRetry={onRetry} />}
    </>
  );
}

function Block({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  const { t } = useTranslation("patient");
  return (
    <section className="review-block">
      <header>
        <h2>{title}</h2>
        <button type="button" className="link min-h-11" onClick={onEdit} aria-label={t("wizard.editBlock", { title })}>
          {t("sum.edit")}
        </button>
      </header>
      {children}
    </section>
  );
}

/** Nothing else on the screen: what was noticed, the numbers to call, and what happens with the request. */
function Urgent({ rx, w, onCorrect, onNotify, error }: { rx: RxRequest; w: RxWizardHandle; onCorrect: () => void; onNotify: () => void; error: unknown }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const labels = urgentLabels(rx);
  const text = rx.engine?.disposition === "urgent" ? rx.engine.summary : null;
  const alerted = rx.timeline.some((e) => e.type === "urgent");
  return (
    <div className="mx-auto max-w-2xl py-8">
      <h1 tabIndex={-1} className="sr-only">
        {t("wizard.urgentTitle")}
      </h1>
      <EmergencyPanel title={t("wizard.urgentTitle")}>
        {text ? <p>{text}</p> : <p>{t("wizard.urgentBody")}</p>}
        {labels.length > 0 && !text && <p className="mt-2">{t("wizard.urgentNoticed", { labels: f.list(labels) })}</p>}
      </EmergencyPanel>
      <div className="mt-6 grid gap-4">
        <p>{t(alerted ? "wizard.urgentAlerted" : "wizard.urgentChoice")}</p>
        <ActionError error={error} title={t("wizard.urgentNotSent")} onRetry={onNotify} hideFields />
        <div className="flex flex-wrap gap-3">
          {!alerted && (
            <Button loading={w.submitting} onClick={onNotify}>
              {t("wizard.urgentNotify")}
            </Button>
          )}
          <Button variant="quiet" onClick={onCorrect}>
            {t("wizard.urgentCorrect")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Two devices answered the same questions differently. */
function WizardConflict({ w }: { w: RxWizardHandle }) {
  const { t } = useTranslation(["patient", "rx"]);
  const f = useFmt();
  const c = w.conflict;
  const [later, setLater] = useState(false);
  if (!c) return null;
  const text = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "boolean") return t(v ? "patient:wizard.yes" : "patient:wizard.no");
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      return [o.name, o.value, o.date, typeof o.slot === "string" ? t(`rx:pickupSlot.${o.slot}`) : null].filter((x) => x !== undefined && x !== null).join(" ");
    }
    return String(v);
  };
  const pick = (key: string) => {
    const [group, ...rest] = key.split(".");
    const name = rest.join(".");
    if (group === "answers") return { label: c.theirs.questions.find((q) => q.id === name)?.label ?? name, mine: c.mine.answers?.[name], theirs: c.theirs.answers[name] };
    if (group === "monitoring") return { label: c.theirs.questions.find((q) => q.id === name)?.label ?? name, mine: c.mine.monitoring?.[name], theirs: c.theirs.monitoring[name] };
    if (group === "pharmacy") return { label: t("patient:wizard.pharmacy"), mine: c.mine.pharmacy, theirs: c.theirs.pharmacy };
    return { label: t("patient:wizard.pickupDate"), mine: c.mine.pickup_window, theirs: c.theirs.pickup_window };
  };
  const fields: DiffField[] = c.keys.map((key) => {
    const p = pick(key);
    return { key, label: p.label, mine: text(p.mine), theirs: text(p.theirs) };
  });
  const merge = (choice: Record<string, "mine" | "theirs">) => {
    const keep = c.keys.filter((k) => choice[k] === "mine");
    const mine = c.mine;
    if (keep.length === c.keys.length) {
      w.wizard.resolve("mine");
      return;
    }
    w.wizard.resolve("theirs");
    for (const key of keep) {
      const [group, ...rest] = key.split(".");
      const name = rest.join(".");
      if (group === "answers") w.wizard.setAnswer(name, mine.answers?.[name] ?? undefined);
      else if (group === "monitoring") w.wizard.setMonitoring(name, mine.monitoring?.[name] ?? null);
      else if (group === "pharmacy") w.wizard.setPharmacy(mine.pharmacy ?? null);
      else w.wizard.setPickupWindow(mine.pickup_window ?? null);
    }
  };
  if (later)
    return (
      <div className="fixed inset-x-4 bottom-24 z-20 mx-auto max-w-xl">
        <Banner tone="warn" role="alert" actions={<Button size="sm" onClick={() => setLater(false)}>{t("patient:wizard.conflictOpen")}</Button>}>
          {t("patient:wizard.conflictWaiting")}
        </Banner>
      </div>
    );
  return <DiffMergeDialog open onOpenChange={(o) => !o && setLater(true)} fields={fields} theirsLabel={t("patient:visit.draftOther", { date: f.dateTime(c.theirs.updated_at) })} onMerge={merge} />;
}
