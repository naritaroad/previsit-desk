import { IconArrowLeft, IconChevronDown, IconChevronUp, IconPhoneCall, IconQuote, IconShieldExclamation } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Measurement, Message } from "@/api/types";
import { usePatient, type VisitStreamHandle } from "@/data";
import { formatDuration, prettyJson } from "@/lib/format";
import { groupTrace, traceBrief } from "@/lib/trace";
import { Badge, Banner, Button, EmptyState, IconButton, SearchInput, Section, StatusTag, TextLink, cn } from "@/ui";

import { useFmt } from "../lib";
import { SourceLink, useKey } from "../parts";
import { MessageList, ModeBar, StaffComposer, messageDomId } from "../thread";
import { latestReadings } from "../patient/blocks";
import { evidenceMessages, lineGroups, ruleHits, type RuleHit } from "./model";

export type SourceTab = "summary" | "talk" | "log";
export interface Trail {
  /** What is being checked, e.g. "Onset: two weeks ago". */
  line: string;
  ids: string[];
  at: number;
}

/** Middle pane: what the patient said, organised; every line leads to the words it came from. */
export function SourcePane({ v, tab, onTab, trail, onTrail, canReply, onAsk }: { v: VisitStreamHandle; tab: SourceTab; onTab: (t: SourceTab) => void; trail: Trail | null; onTrail: (t: Trail | null) => void; canReply: boolean; onAsk: (questions: string[]) => void }) {
  const { t } = useTranslation("clinic");
  useKey("1", () => onTab("summary"));
  useKey("2", () => onTab("talk"));
  useKey("3", () => onTab("log"));
  useKey("escape", () => {
    onTrail(null);
    onTab("summary");
  }, trail !== null);
  const jump = (line: string, ids: string[]) => {
    onTrail({ line, ids, at: 0 });
    onTab("talk");
  };
  const tabs: { value: SourceTab; label: string; count?: number }[] = [
    { value: "summary", label: t("desk.tab.summary") },
    { value: "talk", label: t("desk.tab.talk"), count: v.messages.length },
    { value: "log", label: t("desk.tab.log"), count: v.runs.length },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label={t("desk.paneSource")} className="tabs-list flex-none bg-surface px-pane">
        {tabs.map((x) => (
          <button key={x.value} type="button" role="tab" id={`src-tab-${x.value}`} aria-controls={`src-${x.value}`} aria-selected={tab === x.value} tabIndex={tab === x.value ? 0 : -1} data-state={tab === x.value ? "active" : "inactive"} className="tab" onClick={() => onTab(x.value)} onKeyDown={(e) => {
            const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            const next = tabs[(tabs.findIndex((y) => y.value === tab) + d + tabs.length) % tabs.length].value;
            onTab(next);
            document.getElementById(`src-tab-${next}`)?.focus();
          }}>
            {x.label}
            {x.count !== undefined && <span className="count num">{x.count}</span>}
          </button>
        ))}
      </div>
      <div id={`src-${tab}`} role="tabpanel" aria-labelledby={`src-tab-${tab}`} className="min-h-0 flex-1" tabIndex={-1}>
        {tab === "summary" ? <Summary v={v} onJump={jump} onAsk={onAsk} canReply={canReply} /> : tab === "talk" ? <Talk v={v} trail={trail} onTrail={onTrail} onBack={() => { onTrail(null); onTab("summary"); }} canReply={canReply} /> : <Log v={v} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ summary

function Evidence({ ids, messages, line, onJump }: { ids: string[]; messages: Message[]; line: string; onJump: (line: string, ids: string[]) => void }) {
  const { t } = useTranslation("clinic");
  const fmt = useFmt();
  const found = evidenceMessages(ids, messages);
  if (found.length === 0) return <span className="text-sm text-fg-3">{t("desk.noEvidence")}</span>;
  return (
    <button type="button" className="link num" aria-label={t("desk.showSource", { line })} onClick={() => onJump(line, found.map((m) => m.id))}>
      <IconQuote size={15} aria-hidden /> {fmt.time(found[0].created_at)}
      {found.length > 1 && ` +${found.length - 1}`}
    </button>
  );
}

function Summary({ v, onJump, onAsk, canReply }: { v: VisitStreamHandle; onJump: (line: string, ids: string[]) => void; onAsk: (q: string[]) => void; canReply: boolean }) {
  const { t } = useTranslation(["clinic", "common", "rx"]);
  const fmt = useFmt();
  const hits = useMemo(() => ruleHits({ redFlag: v.redFlag, trace: v.trace, messages: v.messages, refillChecks: v.refillChecks }), [v.redFlag, v.trace, v.messages, v.refillChecks]);
  const s = v.summary;
  const groups = useMemo(() => (s ? lineGroups(s, t("common:list.sep")) : []), [s, t]);
  return (
    <div className="scroll-y h-full p-pane">
      {hits.length > 0 && <Hits hits={hits} onJump={onJump} />}
      {!s ? (
        <EmptyState title={t("desk.noSummary")}>{t("desk.noSummaryBody")}</EmptyState>
      ) : (
        <>
          <Section title={t("desk.s")}>
            <p className="mb-2 text-sm text-fg-2">
              {t("desk.aiNote")}
              {s.edited_by_patient && ` ${t("desk.patientEdited")}`}
            </p>
            {groups.map((g) => (
              <div key={g.id} className="mb-3">
                <h3 className="line-group">{t(`desk.group.${g.id}`)}</h3>
                <ul className="evidence-list">
                  {g.rows.map((r) => {
                    const value = r.status === "none" ? t("field.none") : r.value;
                    const label = t(`field.${r.key}`);
                    return (
                      <li key={r.key}>
                        <span className="min-w-0">
                          {g.rows.length > 1 && <span className="me-2 text-fg-2">{label}</span>}
                          <span className={cn("wrap-any", g.id === "complaint" && "text-md font-semibold")}>{value}</span>
                        </span>
                        <Evidence ids={r.evidence} messages={v.messages} line={t("desk.lineOf", { label, value })} onJump={onJump} />
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {s.not_collected.length > 0 && (
              <p className="text-sm text-fg-2">
                <span className="font-semibold">{t("field.not_collected")}</span> {fmt.list(s.not_collected.map((k) => t(`field.${k}`)))}
              </p>
            )}
          </Section>
          {s.patient_questions.length > 0 && (
            <Section title={t("field.patient_questions")}>
              <ul className="dash-list">
                {s.patient_questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </Section>
          )}
          <Section title={t("desk.o")}>
            {v.visit && <Objective patientId={v.visit.patient.id} />}
          </Section>
          {s.follow_up.length > 0 && <FollowUp items={s.follow_up} onAsk={onAsk} canReply={canReply} />}
          <p className="mt-6 border-t border-rule pt-3 text-sm text-fg-3">
            {t(s.generated_by.kind === "model" ? "desk.madeByModel" : "desk.madeByCode", { model: s.generated_by.model ?? "", time: fmt.dateTime(s.generated_by.at) })} {s.disclaimer}
          </p>
        </>
      )}
    </div>
  );
}

function Hits({ hits, onJump }: { hits: RuleHit[]; onJump: (line: string, ids: string[]) => void }) {
  const { t } = useTranslation(["clinic", "rx"]);
  const fmt = useFmt();
  const red = hits.some((h) => h.kind === "red_flag");
  return (
    <Banner tone={red ? "danger" : "warn"} role="note" icon={red ? <IconPhoneCall aria-hidden /> : <IconShieldExclamation aria-hidden />} title={t(red ? "flags.titleRed" : "flags.title")} className="mb-5">
      <ul className="evidence-list">
        {hits.map((h) => {
          const text = h.text ?? t(h.key ?? "", h.params ?? {});
          return (
            <li key={h.id}>
              <span className="min-w-0">
                <span className="me-2 text-fg-2">{t(`flags.kind.${h.kind}`)}</span>
                <span className="font-medium">{text}</span>
                <span className="ms-2 inline-flex flex-wrap gap-x-3 align-baseline">
                  {h.sources.slice(0, 3).map((u) => (
                    <SourceLink key={u} url={u} />
                  ))}
                  {(h.kind === "red_flag" || h.kind === "scope") && (
                    <TextLink to={`/clinic/rules?tab=${h.kind === "red_flag" ? "red_flags" : "scope"}${h.params?.label ? `&q=${encodeURIComponent(String(h.params.label))}` : ""}`} className="text-sm">
                      {t("flags.rule")}
                    </TextLink>
                  )}
                </span>
              </span>
              {h.messageId ? (
                <button type="button" className="link num" aria-label={t("desk.showSource", { line: text })} onClick={() => onJump(text, [h.messageId!])}>
                  <IconQuote size={15} aria-hidden /> {fmt.time(h.at)}
                </button>
              ) : (
                <span className="num text-sm text-fg-2">{fmt.time(h.at)}</span>
              )}
            </li>
          );
        })}
      </ul>
    </Banner>
  );
}

/** Nothing is examined before the visit: O holds recorded readings only, and says so. */
function Objective({ patientId }: { patientId: string }) {
  const { t } = useTranslation(["clinic", "common"]);
  const fmt = useFmt();
  const query = usePatient(patientId);
  const items = latestReadings(query.data);
  if (!query.data) return <p className="text-fg-2">{t("common:state.loading")}</p>;
  if (items.length === 0) return <p className="text-fg-2">{t("desk.noObjective")}</p>;
  return (
    <>
      <dl className="ledger">
        {items.map((m) => (
          <div key={m.id}>
            <dt>
              {m.kind === "lab" ? m.values.name : t(`common:measure.kind.${m.kind}`)}
              <span className="ms-2 text-sm text-fg-3">
                {fmt.date(m.taken_at, "short")} {t(`common:status.source.${m.source}`)}
              </span>
            </dt>
            <dd>
              {valueOf(m)}
              <small>{m.kind === "lab" ? m.values.unit : t(`common:measure.unit.${m.kind}`)}</small>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-sm text-fg-2">{t("desk.objectiveNote")}</p>
    </>
  );
}
export const valueOf = (m: Measurement): string => (m.kind === "bp" ? `${m.values.systolic}/${m.values.diastolic}` : String(m.values.value ?? ""));

function FollowUp({ items, onAsk, canReply }: { items: string[]; onAsk: (q: string[]) => void; canReply: boolean }) {
  const { t } = useTranslation("clinic");
  return (
    <Section
      title={t("desk.followUp")}
      actions={
        canReply && items.length > 1 ? (
          <button type="button" className="link text-sm" onClick={() => onAsk(items)}>
            {t("desk.askAll")}
          </button>
        ) : undefined
      }
    >
      <p className="mb-1 text-sm text-fg-2">{t("desk.followUpNote")}</p>
      <ul className="evidence-list">
        {items.map((q) => (
          <li key={q}>
            <span className="wrap-any">{q}</span>
            {canReply && (
              <button type="button" className="link" aria-label={t("desk.askThis", { question: q })} onClick={() => onAsk([q])}>
                {t("desk.ask")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ conversation

function Talk({ v, trail, onTrail, onBack, canReply }: { v: VisitStreamHandle; trail: Trail | null; onTrail: (t: Trail | null) => void; onBack: () => void; canReply: boolean }) {
  const { t } = useTranslation("clinic");
  const box = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [hit, setHit] = useState(0);
  const needle = q.trim();
  const found = useMemo(() => (needle ? v.messages.filter((m) => m.content.toLowerCase().includes(needle.toLowerCase())).map((m) => m.id) : []), [v.messages, needle]);
  const target = trail ? trail.ids[trail.at] : (found[hit % Math.max(1, found.length)] ?? null);

  // Bring the source into view and give it focus, so the keyboard and a screen reader arrive there too.
  useEffect(() => {
    if (!target) return;
    const el = document.getElementById(messageDomId(target));
    el?.scrollIntoView({ block: "center" });
    if (trail) el?.focus({ preventScroll: true });
  }, [target, trail]);
  // Opened without a target: start at the latest message.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || trail || v.messages.length === 0) return;
    opened.current = true;
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [trail, v.messages.length]);

  if (!v.visit) return null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {trail ? (
        <div className="trail-bar">
          <Button size="sm" variant="soft" icon={<IconArrowLeft aria-hidden />} onClick={onBack}>
            {t("desk.backToSummary")}
          </Button>
          <span className="min-w-0 flex-1 truncate" title={trail.line}>
            {trail.line}
          </span>
          {trail.ids.length > 1 && (
            <span className="num inline-flex items-center text-sm">
              {t("desk.sourceOf", { n: trail.at + 1, total: trail.ids.length })}
              <IconButton label={t("desk.prevSource")} size="sm" onClick={() => onTrail({ ...trail, at: (trail.at - 1 + trail.ids.length) % trail.ids.length })}>
                <IconChevronUp size={18} aria-hidden />
              </IconButton>
              <IconButton label={t("desk.nextSource")} size="sm" onClick={() => onTrail({ ...trail, at: (trail.at + 1) % trail.ids.length })}>
                <IconChevronDown size={18} aria-hidden />
              </IconButton>
            </span>
          )}
        </div>
      ) : (
        <div className="trail-bar" data-plain="true" role="search">
          <SearchInput className="max-w-72" value={q} onValueChange={(x) => { setQ(x); setHit(0); }} placeholder={t("desk.searchTalk")} onKeyDown={(e) => e.key === "Enter" && found.length > 0 && setHit((hit + (e.shiftKey ? found.length - 1 : 1)) % found.length)} />
          {needle && (
            <span className="num text-sm text-fg-2" role="status">
              {t("desk.found", { count: found.length })}
            </span>
          )}
        </div>
      )}
      <ModeBar visit={v.visit} canReply={canReply} />
      <div ref={box} className="scroll-y min-h-0 flex-1" tabIndex={0} role="region" aria-label={t("desk.tab.talk")}>
        <div className="transcript-col">
          <MessageList messages={v.messages} patientName={v.visit.patient.display_name} highlight={target} q={needle} live={v.live?.text} focusable />
          {v.messages.length === 0 && <p className="text-fg-2">{t("desk.noMessages")}</p>}
        </div>
      </div>
      {v.visit.mode === "human" && <StaffComposer visit={v.visit} canReply={canReply} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ processing record

function Log({ v }: { v: VisitStreamHandle }) {
  const { t } = useTranslation(["clinic", "rx", "common"]);
  const fmt = useFmt();
  const groups = useMemo(() => groupTrace(v.trace, v.runs), [v.trace, v.runs]);
  return (
    <div className="scroll-y h-full p-pane">
      <p className="mb-4 text-sm text-fg-2">{t("log.lede")}</p>
      {groups.length === 0 && <EmptyState title={t("log.empty")}>{t("log.emptyBody")}</EmptyState>}
      <ol className="grid gap-4">
        {groups.map((g) => (
          <li key={g.key} className="panel">
            <div className="panel-head">
              <span className="num font-semibold">{g.run ? fmt.stamp(g.run.created_at) : t("log.form")}</span>
              {g.run && <StatusTag family="run" status={g.run.status} />}
              {g.run?.fallback_used && <Badge tone="warn">{t("log.fallback")}</Badge>}
              {g.run && (
                <span className="num ms-auto text-sm text-fg-2">
                  {[g.run.model, g.run.duration_ms === null ? null : formatDuration(g.run.duration_ms), t("log.tokens", { in: g.run.usage.input_tokens, out: g.run.usage.output_tokens })].filter(Boolean).join(t("patient.dot"))}
                </span>
              )}
            </div>
            {g.rows.length > 0 && (
              <ul className="divide-y divide-rule">
                {g.rows.map((r) => {
                  const brief = traceBrief(r.name, r.result);
                  return (
                    <li key={r.id} className="px-pane py-2">
                      <details>
                        <summary className="log-row">
                          <span className="font-medium">{t(`log.tool.${r.name}`, { defaultValue: r.name })}</span>
                          <span className="min-w-0 flex-1 text-fg-2">{brief ? t(brief.key, brief.params ?? {}) : t(`log.status.${r.status}`)}</span>
                          <Badge plain>{t(`log.source.${r.source}`)}</Badge>
                          <span className="num text-sm text-fg-3">{formatDuration(r.duration_ms)}</span>
                        </summary>
                        <div className="mt-2 grid gap-2">
                          <Json title={t("log.input")} value={r.arguments} />
                          <Json title={t("log.output")} value={r.result} />
                        </div>
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
function Json({ title, value }: { title: string; value: unknown }) {
  const text = prettyJson(value);
  if (!text) return null;
  return (
    <div>
      <p className="text-sm text-fg-2">{title}</p>
      <pre className="json-block" tabIndex={0}>
        {text}
      </pre>
    </div>
  );
}
