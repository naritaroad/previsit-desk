import { IconListCheck } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { MedicationCard, ProtocolQuestion, RxItem, RxRequest } from "@/api/types";
import { useToday } from "@/data";
import { Badge, Banner, Button, Checkbox, Dialog, Field, RadioRows, RefillStrip, StatusTag, Textarea, cn } from "@/ui";

import { personLabel, useFmt } from "../lib";
import { SourceLink } from "../parts";
import { useAnswerText } from "./answers";
import { OUTCOMES, noteNeed, questionText, type ItemDraft, type ItemProblem } from "./decision";

export interface ItemCardProps {
  rx: RxRequest;
  item: RxItem;
  med: MedicationCard | undefined;
  n: number;
  /** Null when this person cannot decide (no permission, or the request is past it). */
  draft: ItemDraft | null;
  onDraft?: (d: ItemDraft) => void;
  problem: ItemProblem | null;
  showProblem: boolean;
  serverError?: string;
}

/** One medicine: what the record says, what the check found and why, and the physician's own decision. */
export function ItemCard({ rx, item, med, n, draft, onDraft, problem, showProblem, serverError }: ItemCardProps) {
  const { t } = useTranslation(["clinic", "rx", "common"]);
  const fmt = useFmt();
  const today = useToday();
  const answerText = useAnswerText();
  const name = fmt.locale === "en" ? item.drug.name_en : item.drug.name_zh;
  const other = fmt.locale === "en" ? item.drug.name_zh : item.drug.name_en;
  const questionOf = (id: string): ProtocolQuestion | undefined => rx.questions.find((q) => q.id === id);
  return (
    <section className="panel rx-item" aria-labelledby={`item-${item.id}`} id={`rx-item-${item.id}`}>
      <div className="panel-head">
        <h2 className="panel-title" id={`item-${item.id}`}>
          <span className="num me-2 text-fg-3">{n}</span>
          {name || other}
          {other && other !== name && <span className="ms-2 font-medium text-fg-2">{other}</span>}
        </h2>
        <span className="ms-auto flex flex-wrap items-center gap-2">
          {item.drug.controlled_level > 0 && <Badge tone="warn">{t("rx.controlled", { n: item.drug.controlled_level })}</Badge>}
          {item.engine && <StatusTag family="disposition" status={item.engine.disposition} />}
        </span>
      </div>
      <div className="rx-item-body">
        <div className="min-w-0">
          <dl className="dl">
            <div>
              <dt>{t("rx.dose")}</dt>
              <dd>
                {item.dose_text}
                <span className="block text-sm text-fg-2">{t("rx.doseNote")}</span>
              </dd>
            </div>
            <div>
              <dt>{t("rx.scope")}</dt>
              <dd>
                <StatusTag family="scope" status={item.scope} plain />
                {item.scope_reason && <span className="block text-sm text-fg-2">{item.scope_reason}</span>}
              </dd>
            </div>
            {item.refill && (
              <div>
                <dt>{t("rx.refillCheck")}</dt>
                <dd>
                  <span className="font-semibold">{item.refill.title}</span>
                  <span className="block text-sm text-fg-2">{item.refill.message}</span>
                  <span className="flex flex-wrap gap-x-3">
                    {[...new Set(item.refill.rules.map((r) => r.source_url))].slice(0, 3).map((u) => (
                      <SourceLink key={u} url={u} />
                    ))}
                  </span>
                </dd>
              </div>
            )}
          </dl>
          {item.engine && (
            <div className="mt-4">
              <h3 className="mb-1 font-semibold">{t("rx.fired", { count: item.engine.fired.length })}</h3>
              {item.engine.fired.length === 0 ? (
                <p className="text-fg-2">{t("rx.firedNone")}</p>
              ) : (
                <ul className="fired-list">
                  {item.engine.fired.map((f, i) => (
                    <li key={`${f.question_id}-${i}`}>
                      <StatusTag family="disposition" status={f.disposition} />
                      <span className="min-w-0">
                        <span className="block font-medium">{f.reason}</span>
                        <span className="block text-sm text-fg-2">
                          {f.label}
                          {f.answer !== null && f.answer !== undefined && <span className="ms-1 text-fg">{t("rx.answerIs", { answer: answerText(questionOf(f.question_id), f.answer) })}</span>}
                        </span>
                        <SourceLink url={f.source_url} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {med && med.source === "clinic" && (
            <div className="mt-5">
              <h3 className="mb-1 font-semibold">{t("rx.dispensing")}</h3>
              <RefillStrip med={med} today={today} />
              {med.fills.length > 0 && (
                <ul className="mt-2 text-sm text-fg-2">
                  {med.fills.map((f) => (
                    <li key={f.n} className="num">
                      {t("rx.fill", { n: f.n, date: fmt.date(f.filled_on, "short"), pharmacy: f.pharmacy_name })}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <div className="min-w-0">
          {draft && onDraft ? (
            <Decision rx={rx} item={item} draft={draft} onDraft={onDraft} problem={problem} showProblem={showProblem} serverError={serverError} />
          ) : item.decision ? (
            <div className="rounded-control border border-rule p-3">
              <h3 className="mb-1 font-semibold">{t("rx.decision")}</h3>
              <StatusTag family="outcome" status={item.decision.outcome} />
              {item.decision.note && <p className="mt-2 whitespace-pre-wrap">{item.decision.note}</p>}
              <p className="mt-2 text-sm text-fg-2">
                {personLabel(item.decision.by)} {fmt.stamp(item.decision.at)}
              </p>
            </div>
          ) : (
            <p className="text-fg-2">{t("rx.undecided")}</p>
          )}
        </div>
      </div>
    </section>
  );
}

/** Four outcomes of equal weight. Nothing is chosen beforehand, and nothing here repeats what the check said. */
function Decision({ rx, item, draft, onDraft, problem, showProblem, serverError }: { rx: RxRequest; item: RxItem; draft: ItemDraft; onDraft: (d: ItemDraft) => void; problem: ItemProblem | null; showProblem: boolean; serverError?: string }) {
  const { t } = useTranslation(["clinic", "rx"]);
  const [build, setBuild] = useState(false);
  const need = noteNeed(item, draft.outcome);
  const excluded = item.scope === "excluded";
  const error = serverError ?? (showProblem && problem ? t(`rx.problem.${problem}`) : undefined);
  return (
    <fieldset className="field m-0 border-0 p-0" aria-describedby={error ? `err-${item.id}` : undefined}>
      <legend className="mb-1.5 p-0 font-semibold">{t("rx.decide")}</legend>
      <RadioRows
        label={t("rx.decide")}
        value={draft.outcome ?? undefined}
        onValueChange={(v) => onDraft({ ...draft, outcome: v as ItemDraft["outcome"] })}
        options={OUTCOMES.map((o) => ({
          value: o,
          label: t(`rx:outcome.${o}`),
          hint: o === "approve" && !rx.pharmacy ? t("rx.approveNoPharmacy") : o === "approve" && excluded ? t("rx.approveExcluded") : t(`rx:outcomeHint.${o}`),
          disabled: o === "approve" && (!rx.pharmacy || excluded),
        }))}
      />
      {draft.outcome && (
        <Field className="mt-3" label={t(`rx.note.${need ?? "optional"}`)} hint={t(`rx.noteHint.${need ?? "optional"}`)} optional={need === null} required={need === "override" || need === "question"}>
          <Textarea rows={need === "question" ? 4 : 2} value={draft.note} aria-invalid={Boolean(error) || undefined} onChange={(e) => onDraft({ ...draft, note: e.target.value })} />
        </Field>
      )}
      {draft.outcome === "more_info" && (
        <Button size="sm" className="mt-2 justify-self-start" icon={<IconListCheck aria-hidden />} onClick={() => setBuild(true)}>
          {t("rx.builder")}
        </Button>
      )}
      {error && (
        <Banner tone="warn" role="alert" className="mt-3">
          <span id={`err-${item.id}`}>{error}</span>
        </Banner>
      )}
      <QuestionBuilder open={build} onOpenChange={setBuild} rx={rx} item={item} onInsert={(text) => onDraft({ ...draft, note: draft.note.trim() ? `${draft.note.trimEnd()}\n${text}` : text })} />
    </fieldset>
  );
}

const READY = ["reading", "photo", "timing", "other"] as const;
/** Puts together the questions for the patient from what is unclear or out of date; the text stays editable. */
function QuestionBuilder({ open, onOpenChange, rx, item, onInsert }: { open: boolean; onOpenChange: (o: boolean) => void; rx: RxRequest; item: RxItem; onInsert: (text: string) => void }) {
  const { t } = useTranslation(["clinic", "common"]);
  const [picked, setPicked] = useState<string[]>([]);
  const stale = rx.engine?.stale_monitoring ?? [];
  const suggestions = [
    ...(item.engine?.fired ?? []).map((f) => t("rx.build.about", { label: f.label })),
    ...stale.map((id) => t("rx.build.fresh", { label: rx.questions.find((q) => q.id === id)?.label ?? id })),
    ...READY.map((k) => t(`rx.build.ready.${k}`)),
  ];
  const unique = [...new Set(suggestions)];
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setPicked([]);
      }}
      title={t("rx.build.title")}
      description={t("rx.build.body")}
      width="36rem"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common:action.cancel")}</Button>
          <Button
            variant="primary"
            disabled={picked.length === 0}
            onClick={() => {
              onInsert(questionText(picked));
              setPicked([]);
              onOpenChange(false);
            }}
          >
            {t("rx.build.insert", { count: picked.length })}
          </Button>
        </>
      }
    >
      <div className={cn("grid gap-1")}>
        {unique.map((s) => (
          <Checkbox key={s} label={s} checked={picked.includes(s)} onCheckedChange={(v) => setPicked(v === true ? [...picked, s] : picked.filter((x) => x !== s))} />
        ))}
      </div>
    </Dialog>
  );
}
