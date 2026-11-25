// What the patient answered and measured, next to what the protocol asks for.

import { IconAlertTriangle, IconClockX } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Measurement, ProtocolQuestion, RxRequest } from "@/api/types";
import { useToday } from "@/data";
import { askedQuestions, identityKey, monitoringAge, monitoringQuestions } from "@/lib/rx";
import { Badge, Button, EmptyState } from "@/ui";

import { useFmt } from "../lib";
import { Readings } from "../patient/blocks";

/** An answer as words, in the question's own terms. */
export function useAnswerText() {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  return (q: ProtocolQuestion | undefined, a: unknown): string => {
    if (a === null || a === undefined || a === "") return t("rx.unanswered");
    if (typeof a === "boolean") return t(a ? "rx.yes" : "rx.no");
    if (q?.kind === "choice") return q.options.find((o) => o.value === a)?.label ?? String(a);
    if (q?.kind === "date" && typeof a === "string") return fmt.date(a, "short");
    if (typeof a === "number") return [a, q?.unit].filter(Boolean).join(" ");
    return String(a);
  };
}

/** The answers that fired a rule come first; the rest opens on request. */
export function Answers({ rx }: { rx: RxRequest }) {
  const { t } = useTranslation("clinic");
  const answerText = useAnswerText();
  const [all, setAll] = useState(false);
  const fired = new Set(rx.items.flatMap((i) => i.engine?.fired.map((f) => f.question_id) ?? []));
  const identity = rx.items.filter((i) => typeof rx.answers[identityKey(i.id)] === "boolean").map((i) => ({ id: identityKey(i.id), label: t("rx.sameAsRecord", { drug: i.drug.name_zh || i.drug.name_en }), text: t(rx.answers[identityKey(i.id)] ? "rx.yes" : "rx.no"), fired: rx.answers[identityKey(i.id)] === false, group: "identity" }));
  const rows = [...identity, ...askedQuestions(rx).map((q) => ({ id: q.id, label: q.label, text: answerText(q, rx.answers[q.id]), fired: fired.has(q.id), group: q.scope as string }))];
  if (rows.length === 0) return <p className="text-fg-2">{t("rx.noAnswers")}</p>;
  const first = rows.filter((r) => r.fired);
  const shown = all ? rows : first;
  return (
    <>
      {!all && first.length === 0 && <p className="text-fg-2">{t("rx.noFired")}</p>}
      <dl className="ledger">
        {shown.map((r) => (
          <div key={r.id} data-fired={r.fired}>
            <dt className={r.fired ? "text-fg" : undefined}>{r.label}</dt>
            <dd className="max-w-72 font-medium wrap-any">
              {r.fired && <IconAlertTriangle size={16} className="me-1 inline align-[-2px] text-warn" aria-label={t("rx.firedLabel")} />}
              {r.text}
            </dd>
          </div>
        ))}
      </dl>
      <Button size="sm" variant="quiet" className="mt-2" aria-expanded={all} onClick={() => setAll(!all)}>
        {t(all ? "rx.onlyFired" : "rx.allAnswers", { count: rows.length })}
      </Button>
    </>
  );
}

/** Readings and tests the protocol wants, how old they are, and the trend when there is one. */
export function Monitoring({ rx, readings }: { rx: RxRequest; readings: Measurement[] | undefined }) {
  const { t } = useTranslation(["clinic", "common"]);
  const fmt = useFmt();
  const today = useToday();
  const questions = monitoringQuestions(rx);
  const kinds = (["bp", "glucose", "weight", "pulse"] as const).filter((k) => readings?.some((m) => m.kind === k));
  return (
    <>
      {questions.length === 0 ? (
        <EmptyState title={t("rx.noMonitoring")} className="px-0 py-2" />
      ) : (
        <table className="plain-table">
          <caption className="sr-only">{t("rx.monitoring")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("rx.col.item")}</th>
              <th scope="col">{t("rx.col.value")}</th>
              <th scope="col">{t("rx.col.date")}</th>
              <th scope="col">{t("rx.col.age")}</th>
            </tr>
          </thead>
          <tbody>
            {questions.map((q) => {
              const v = rx.monitoring[q.id];
              const age = monitoringAge(q, v, today);
              return (
                <tr key={q.id}>
                  <th scope="row">{q.label}</th>
                  <td className="num">{v?.value === undefined ? <span className="text-fg-3">{t("rx.noValue")}</span> : [v.value, q.unit].filter(Boolean).join(" ")}</td>
                  <td className="num">{v?.date ? fmt.date(v.date, "short") : <span className="text-fg-3">{t("rx.noDate")}</span>}</td>
                  <td>
                    <span className="num">{age ? t("rx.days", { count: age.days }) : ""}</span>
                    {age?.stale && (
                      <Badge tone="warn" icon={<IconClockX aria-hidden />} className="ms-2">
                        {t("rx.stale", { count: q.max_age_days ?? 0 })}
                      </Badge>
                    )}
                    {!age && q.max_age_days !== null && <Badge tone="warn">{t("rx.missing")}</Badge>}
                    {v && <span className="ms-2 text-sm text-fg-2">{t(`common:status.source.${v.source}`)}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {readings && kinds.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 font-semibold">{t("rx.trend")}</h3>
          <Readings items={readings} height={190} />
        </div>
      )}
    </>
  );
}
