import { useTranslation } from "react-i18next";

import type { IntakeView, PrevisitSummary, Visit } from "@/api/types";
import { EMPTY_INTAKE, intakeRows, isCoreField, type IntakeRow } from "@/lib/intake";
import { isSent } from "@/lib/composer";
import { Callout, Progress, TextLink } from "@/ui";

import { useFmt } from "../shared";
import { IntakeFields, SummaryFields } from "./SummaryFields";

export interface SectionState {
  id: "complaint" | "illness" | "background" | "confirm";
  done: number;
  total: number;
  state: "done" | "current" | "todo";
}

/** The conversation in four parts. Counts come from what is recorded, not from how many messages there are. */
export function sectionsOf(view: IntakeView | null, summary: PrevisitSummary | null, sent: boolean): SectionState[] {
  const rows = intakeRows((view ?? EMPTY_INTAKE).state);
  const part = (id: SectionState["id"], match: (r: IntakeRow) => boolean) => {
    const mine = rows.filter(match);
    const core = mine.filter((r) => isCoreField(r.key));
    return { id, done: mine.filter((r) => r.status !== "missing").length, total: mine.length, complete: core.every((r) => r.status !== "missing") };
  };
  const parts = [
    part("complaint", (r) => r.key === "chief_complaint"),
    part("illness", (r) => r.key.startsWith("hpi.")),
    part("background", (r) => r.key === "past_history" || r.key === "medications" || r.key === "allergies"),
    { id: "confirm" as const, done: sent ? 1 : 0, total: 1, complete: sent },
  ];
  const current = sent ? -1 : summary && parts[2].complete ? 3 : parts.findIndex((p) => !p.complete);
  return parts.map((p, i) => ({ id: p.id, done: p.done, total: p.total, state: p.complete ? "done" : i === current ? "current" : "todo" }));
}

export function SectionsBar({ sections }: { sections: SectionState[] }) {
  const { t } = useTranslation(["patient", "common"]);
  return (
    <ol className="sections-bar" aria-label={t("patient:visit.progress")}>
      {sections.map((s) => (
        <li key={s.id} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>
          <span>{t(`patient:section.${s.id}`)}</span>
          <span className="n">
            {s.id === "confirm" ? t(s.done ? "patient:section.sent" : "patient:section.notSent") : t("patient:section.count", { done: s.done, total: s.total })}
            <span className="sr-only">{t(`common:step.${s.state}`)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The header's one-line version for narrow screens. */
export function SectionsLine({ sections }: { sections: SectionState[] }) {
  const { t } = useTranslation("patient");
  const i = sections.findIndex((s) => s.state === "current");
  const done = sections.reduce((n, s) => n + s.done, 0);
  const total = sections.reduce((n, s) => n + s.total, 0);
  return (
    <div>
      <p>{i < 0 ? t("section.allDone") : t("section.now", { n: i + 1, total: sections.length, name: t(`section.${sections[i].id}`) })}</p>
      <Progress className="mt-1" value={done} max={total} label={t("visit.progress")} />
    </div>
  );
}

export function SidePanel({ visit, intake, summary, onJump, onCorrect, heading = true }: { visit: Visit; intake: IntakeView | null; summary: PrevisitSummary | null; onJump: (messageId: string) => void; onCorrect: (label: string) => void; heading?: boolean }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const sent = isSent(visit);
  return (
    <>
      {heading && <h2 className="mb-3 text-lg font-bold">{t("sum.title")}</h2>}
      <SectionsBar sections={sectionsOf(intake, summary, sent)} />
      <p className="mt-3 text-sm text-fg-2">
        {sent
          ? t("sum.sentNote", { date: f.dateTime(visit.submitted_at) })
          : summary
            ? t(summary.edited_by_patient ? "sum.editedNote" : "sum.readyNote")
            : t("sum.liveNote")}
      </p>
      <div className="mt-2">
        {summary ? (
          <SummaryFields visitId={visit.id} summary={summary} editable={!sent && visit.mode === "ai"} onJump={onJump} />
        ) : (
          <IntakeFields state={(intake ?? EMPTY_INTAKE).state} onCorrect={sent ? undefined : onCorrect} />
        )}
      </div>
      {summary && summary.not_collected.length > 0 && !sent && <p className="mt-3 text-sm text-fg-2">{t("sum.notCollected", { count: summary.not_collected.length })}</p>}
      {summary?.red_flag_screen.triggered.length ? (
        <Callout tone="danger" className="mt-4" title={t("sum.redFlag")}>
          {f.list(summary.red_flag_screen.triggered.map((x) => x.label))}
        </Callout>
      ) : null}
      {summary && (
        <p className="mt-4">
          <TextLink to={`/app/visits/${visit.id}/summary`}>{t("sum.openPrint")}</TextLink>
        </p>
      )}
    </>
  );
}
