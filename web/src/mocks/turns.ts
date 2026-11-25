// Scripted assistant turns. A turn is a list of stored steps, run one by one by whichever tab's timer fires first,
// so it goes on after a reload and independently of any stream, like the real server.
//
// Typing one of these sends a special turn: /fail (model error), /interrupt (server stopped mid-turn), /slow
// (long reply), /summary (asks for confirmation and stores the summary), /budget (daily AI limit used up).

import type { IntakeFieldKey, RunFailureCode, ToolName } from "../api/types.ts";
import { charCount } from "../lib/composer.ts";
import { uuid } from "../lib/ids.ts";
import type { MockServer } from "./core.ts";
import type { Db, MessageRec, TurnRec, VisitRec } from "./db.ts";
import { L, redFlag, scopeOf, searchHandbook } from "./rules.ts";
import { buildSummary, missingFields, RED_FLAG_EN, RED_FLAG_ZH, REFUSAL_EN, REFUSAL_ZH, setField, stageOf } from "./seed/visits.ts";
import { addMessage, emitVisit, intakeView, notifyStaff, openTicket, visitChanged, visitView } from "./views.ts";

const ASK: Record<string, [string, string]> = {
  chief_complaint: ["今天哪裡不舒服？", "What brings you in today?"],
  "hpi.onset": ["這個情形是什麼時候開始的？", "When did it start?"],
  "hpi.course": ["從開始到現在，有比較好、比較糟，還是差不多？", "Since then, is it better, worse or about the same?"],
  "hpi.location": ["是哪個部位最明顯？", "Where do you feel it most?"],
  "hpi.character": ["是什麼樣的感覺？例如刺痛、悶、脹。", "What does it feel like? For example sharp, dull or tight."],
  "hpi.severity": ["0 分是完全沒有，10 分是受不了，您大概幾分？", "From 0 (none) to 10 (unbearable), how bad is it?"],
  "hpi.modifiers": ["有沒有什麼會讓它變嚴重或比較舒服？", "Does anything make it worse or better?"],
  "hpi.associated": ["還有其他不舒服嗎？例如發燒、噁心、頭暈。", "Anything else, such as fever, nausea or dizziness?"],
  past_history: ["以前有什麼慢性病或開過刀嗎？沒有的話回答「沒有」。", "Any long-term conditions or operations? Say “none” if not."],
  medications: ["最近固定在吃哪些藥或保健食品？", "Which medicines or supplements do you take regularly?"],
  allergies: ["對藥物或食物會過敏嗎？", "Any allergies to medicines or food?"],
};
/** Core fields first, the suggested ones are skipped once the core is complete. */
const ORDER: readonly IntakeFieldKey[] = ["chief_complaint", "hpi.onset", "hpi.course", "hpi.severity", "hpi.associated", "past_history", "medications", "allergies"];
const PII = /(09\d{2}[- ]?\d{3}[- ]?\d{3}|[A-Z][12]\d{8}|\d{2,4}-\d{6,8})/g;
const NONE = /^(沒有|無|沒|none|no|nope)[。.]?$/i;

interface Step {
  delay: number;
  type: string;
  data: unknown;
}

function chunks(text: string): string[] {
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += 4) out.push(chars.slice(i, i + 4).join(""));
  return out;
}

/** The patient's message is stored; decide what the assistant does. Returns the run id, or null for human mode. */
export function startTurn(server: MockServer, db: Db, v: VisitRec, message: MessageRec): string | null {
  const en = v.locale === "en";
  const text = message.content;
  const at = () => new Date().toISOString();
  const call = (runId: string | null, name: ToolName, args: unknown, result: unknown, ms = 1) =>
    v.tool_calls.push({ id: uuid(), run_id: runId, step: 0, name, source: "code", status: "ok", arguments: args, result, duration_ms: ms, created_at: at() });
  const chars = charCount(text);
  const flag = redFlag(text);
  const verdict = scopeOf(text);

  emitVisit(server, v, "message.accepted", { message_id: message.id, visit_id: v.id });
  const hit = flag ? { category: flag.category, label: L(v.locale, flag.zh, flag.en), matched_at: at(), message_id: message.id } : null;
  call(null, "red_flag_precheck", { chars }, hit ? { hit: true, category: hit.category, label: hit.label, rule_id: flag!.id } : { hit: false });
  call(null, "scope_precheck", { chars }, { verdict });
  emitVisit(server, v, "precheck.completed", { red_flag: hit, scope: verdict, duration_ms: 2 });
  const runId = uuid();

  if (hit) {
    v.red_flag = hit;
    v.status = "red_flag";
    v.urgency = "urgent";
    emitVisit(server, v, "redflag.triggered", { category: hit.category, label: hit.label, message_id: message.id });
    if (!db.tickets.some((t) => t.visit_id === v.id && t.reason === "red_flag" && t.status === "open")) {
      const t = openTicket(server, db, { patient_id: v.patient_id, visit_id: v.id, rx_id: null, reason: "red_flag", urgency: "urgent", summary: L(v.locale, `紅旗：${hit.label}`, `Red flag: ${hit.label}`), created_by: "code" });
      emitVisit(server, v, "ticket.created", t);
    }
    fixedReply(server, db, v, runId, "red_flag", en ? RED_FLAG_EN : RED_FLAG_ZH);
    visitChanged(server, v);
    return runId;
  }
  if (v.mode === "human") return null;
  if (v.status === "red_flag") {
    fixedReply(server, db, v, runId, "notice", L(v.locale, "這次預問診已經暫停。請先撥打 119 或 1925，或到最近的急診。之後要重新開始，請按「開始新的預問診」。", "This previsit is paused. Call 119 or 1925, or go to the nearest emergency department. Start a new previsit afterwards."));
    return runId;
  }
  if (verdict !== "ok") {
    if (verdict !== "injection") {
      const t = openTicket(server, db, { patient_id: v.patient_id, visit_id: v.id, rx_id: null, reason: verdict, urgency: verdict === "controlled_drug" ? "soon" : "routine", summary: L(v.locale, "病人要求開藥或調整劑量，AI 已拒絕並轉交。", "The patient asked for a prescription or dose change; the AI declined and handed it over."), created_by: "code" });
      emitVisit(server, v, "ticket.created", t);
    }
    fixedReply(server, db, v, runId, "refusal", en ? REFUSAL_EN : REFUSAL_ZH);
    visitChanged(server, v);
    return runId;
  }
  if (!db.settings.ai.enabled || text.trim() === "/budget") {
    const code: RunFailureCode = "daily_budget_exceeded";
    queue(server, db, v, message, runId, [
      { delay: 60, type: "run.started", data: { run_id: runId, model: db.settings.ai.primary } },
      { delay: 120, type: "notice", data: L(v.locale, "AI 暫時無法回覆。紅旗檢查與慢箋檢核仍可使用，您也可以按「結束並送出」。", "The AI can't answer right now. Red-flag checks and the refill check still work, and you can send your answers.") },
      { delay: 20, type: "run.failed", data: { run_id: runId, code, message: code } },
    ]);
    return runId;
  }
  queue(server, db, v, message, runId, modelSteps(v, text, runId, db.settings.ai.primary));
  return runId;
}

function modelSteps(v: VisitRec, text: string, runId: string, model: string): Step[] {
  const steps: Step[] = [{ delay: 250, type: "run.started", data: { run_id: runId, model } }];
  const command = text.trim().toLowerCase();
  let n = 0;
  const tool = (name: ToolName, source: "code" | "model", args: unknown, result: unknown, ms: number) => {
    n += 1;
    const call_id = uuid();
    steps.push({ delay: 180, type: "tool.started", data: { call_id, step: n, name, source, arguments: args } });
    steps.push({ delay: ms, type: "tool.completed", data: { call_id, step: n, name, status: "ok", result, duration_ms: ms } });
  };
  if (command === "/fail") {
    steps.push({ delay: 900, type: "notice", data: L(v.locale, "這則訊息沒有處理成功，請再試一次。", "That message wasn't processed. Please try again.") });
    steps.push({ delay: 20, type: "run.failed", data: { run_id: runId, code: "model_error", message: "model_error" } });
    return steps;
  }
  if (command === "/interrupt") {
    steps.push({ delay: 900, type: "run.interrupted", data: { run_id: runId } });
    return steps;
  }

  const masked = text.match(PII)?.length ?? 0;
  if (masked) tool("pii_filter", "code", { chars: charCount(text) }, { masked, kinds: [L(v.locale, "電話或證號", "phone or ID")] }, 2);

  const missing = missingFields(v.intake).filter((k) => (ORDER as readonly string[]).includes(k));
  const asked = ORDER.find((k) => missing.includes(k));
  let next: string | undefined;
  if (asked && !command.startsWith("/")) {
    const value = fieldValue(asked, text);
    tool("record_intake", "model", { [asked]: value }, { applied: [asked], rejected: [] }, 8);
    steps.push({ delay: 20, type: "apply.field", data: { key: asked, value } });
    next = ORDER.find((k) => missing.includes(k) && k !== asked);
  }
  const wantsHandbook = /空腹|急診|慢箋|領藥|發燒|fasting|emergency|refill|fever/i.test(text);
  if (wantsHandbook) {
    const term = /空腹|急診|慢箋|領藥|發燒/.exec(text)?.[0] ?? "就醫";
    const hits = searchHandbook(term).slice(0, 3).map(({ entry, score }) => ({ section: entry.section, title: entry.title, source_type: entry.source_type, source_name: entry.source_name, source_url: entry.source_url ?? "", verified_on: entry.verified_on, score }));
    tool("search_health_education", "model", { query: term, top_k: 3 }, { hits }, 42);
  }

  let reply: string;
  if (command === "/slow") reply = L(v.locale, "這是一段比較長的測試回覆，用來看逐字出現的樣子。", "This is a longer test reply that shows how text arrives bit by bit. ").repeat(8);
  else if (command === "/summary" || (!asked && missingFields(v.intake).length < 8) || (asked && !next)) {
    const items = [v.intake.chief_complaint, v.intake.hpi.onset, v.intake.hpi.course].filter(Boolean).join(L(v.locale, "，", ", "));
    reply = L(v.locale, `我把剛才的內容整理好了：${items || "目前的回答"}。請看右邊的摘要，沒問題就按「結束並送出」。`, `I've put together what you told me: ${items || "your answers so far"}. Check the summary, then press Finish and send.`);
    steps.push({ delay: 60, type: "apply.summary", data: null });
  } else {
    const lead = L(v.locale, asked === "hpi.severity" ? "好，我記下了。" : "了解。", asked === "hpi.severity" ? "Noted." : "Thank you.");
    reply = `${lead}${L(v.locale, "", " ")}${ASK[next ?? "chief_complaint"][v.locale === "en" ? 1 : 0]}`;
  }
  if (wantsHandbook) reply = L(v.locale, "衛教手冊裡有相關說明，我放在下面的來源。", "The handbook has a section on this; see the sources below. ") + reply;
  tool("output_guard", "code", { chars: charCount(reply) }, { passed: true, violations: [], action: "none" }, 2);
  for (const c of chunks(reply)) steps.push({ delay: 45, type: "message.delta", data: { text: c } });
  steps.push({ delay: 60, type: "reply", data: reply });
  steps.push({ delay: 20, type: "visit.updated", data: null });
  steps.push({ delay: 20, type: "run.completed", data: { run_id: runId, status: "completed", steps: 2, usage: { input_tokens: 2300 + charCount(text) * 3, output_tokens: charCount(reply) * 2 }, model } });
  return steps;
}

function fieldValue(key: IntakeFieldKey, text: string): string | number | string[] {
  if (key === "hpi.severity") {
    const n = Number(/\d+/.exec(text)?.[0]);
    return Number.isFinite(n) ? Math.min(10, n) : text;
  }
  if (key === "past_history" || key === "medications" || key === "allergies") return NONE.test(text.trim()) ? [] : text.split(/[、,，和\n]/).map((s) => s.trim()).filter(Boolean);
  return text.trim().slice(0, 120);
}

/** Rules answer without a model: red flags, refusals, notices. */
function fixedReply(server: MockServer, db: Db, v: VisitRec, runId: string, kind: "red_flag" | "refusal" | "notice", content: string): void {
  const now = new Date().toISOString();
  v.runs.push({ id: runId, model: "", fallback_used: false, status: "skipped", steps: 0, usage: { input_tokens: 0, output_tokens: 0 }, error_code: null, duration_ms: 3, created_at: now });
  const m = addMessage(server, db, v, { role: "assistant", kind, content, run_id: runId });
  emitVisit(server, v, "message.completed", { message_id: m.id, kind, content, run_id: runId });
  emitVisit(server, v, "visit.updated", visitView({ db, locale: v.locale, account: db.accounts.find((a) => a.id === v.patient_id)! }, v));
  emitVisit(server, v, "run.completed", { run_id: runId, status: "skipped", steps: 0, usage: { input_tokens: 0, output_tokens: 0 }, model: "" });
}

function queue(server: MockServer, db: Db, v: VisitRec, message: MessageRec, runId: string, steps: Step[]): void {
  db.turns.push({ id: uuid(), visit_id: v.id, run_id: runId, message_id: message.id, steps, next: 0, dueAt: Date.now() + steps[0].delay * server.config.pace });
}

export function isRunning(db: Db, visitId: string): boolean {
  return db.turns.some((t) => t.visit_id === visitId);
}

/** Runs due steps and sets a timer for the next one. */
export class TurnRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly server: MockServer;

  constructor(server: MockServer) {
    this.server = server;
    server.onWrite = () => this.tick();
    this.tick();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  tick(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const db = this.server.db; // another tab may have done the due steps already
    let ran = false;
    const now = Date.now();
    for (const turn of [...db.turns]) {
      while (turn.next < turn.steps.length && turn.dueAt <= now) {
        this.run(db, turn, turn.steps[turn.next]);
        turn.next += 1;
        ran = true;
        if (turn.next < turn.steps.length) turn.dueAt += turn.steps[turn.next].delay * this.server.config.pace;
      }
      if (turn.next >= turn.steps.length) db.turns = db.turns.filter((t) => t.id !== turn.id);
    }
    if (ran) this.server.file.save();
    const nextAt = Math.min(...db.turns.map((t) => t.dueAt));
    if (Number.isFinite(nextAt)) this.timer = setTimeout(() => this.tick(), Math.max(0, nextAt - Date.now()));
  }

  private run(db: Db, turn: TurnRec, step: Step): void {
    const { server } = this;
    const v = db.visits.find((x) => x.id === turn.visit_id);
    if (!v) return;
    const now = new Date().toISOString();
    const data = step.data as Record<string, unknown>;
    const finishRun = (part: Partial<VisitRec["runs"][number]>) => {
      const r = v.runs.find((x) => x.id === turn.run_id);
      if (r) Object.assign(r, { duration_ms: Date.parse(now) - Date.parse(r.created_at), ...part });
    };
    switch (step.type) {
      case "message.delta":
        server.live.publish({ to: { visit: v.id }, seq: null, type: "message.delta", data: step.data });
        return;
      case "run.started":
        v.runs.push({ id: turn.run_id, model: String(data.model), fallback_used: false, status: "running", steps: 0, usage: { input_tokens: 0, output_tokens: 0 }, error_code: null, duration_ms: 0, created_at: now });
        break;
      case "tool.completed": {
        const started = v.events.findLast((e) => e.type === "tool.started" && (e.data as { call_id: string }).call_id === data.call_id)?.data as Record<string, unknown> | undefined;
        v.tool_calls.push({
          id: String(data.call_id),
          run_id: turn.run_id,
          step: Number(data.step),
          name: data.name as ToolName,
          source: started?.source === "code" ? "code" : "model",
          status: "ok",
          arguments: started?.arguments ?? {},
          result: data.result,
          duration_ms: Number(data.duration_ms),
          created_at: now,
        });
        break;
      }
      case "apply.field": {
        const key = String(data.key);
        setField(v.intake, key, data.value as string | number | string[]);
        v.evidence[key] = [...(v.evidence[key] ?? []), turn.message_id];
        v.stage = stageOf(v.intake);
        if (key === "chief_complaint" && v.intake.chief_complaint) v.title = v.intake.chief_complaint.slice(0, 20);
        emitVisit(server, v, "intake.updated", intakeView(v));
        return;
      }
      case "apply.summary":
        v.stage = "confirm";
        v.summary = buildSummary(v.id, v.intake, v.evidence, now, { revision: (v.summary?.revision ?? 0) + 1, narrative: v.intake.chief_complaint ?? "", en: v.locale === "en", redFlags: v.red_flag ? [{ category: v.red_flag.category, label: v.red_flag.label }] : [] });
        emitVisit(server, v, "summary.updated", v.summary);
        return;
      case "reply":
      case "notice": {
        const kind = step.type === "reply" ? "chat" : "notice";
        const content = String(step.data);
        // message.completed carries the stored text; message.created repeats it with seq and author.
        const m = addMessage(server, db, v, { role: "assistant", kind, content, run_id: turn.run_id });
        emitVisit(server, v, "message.completed", { message_id: m.id, kind, content, run_id: turn.run_id });
        visitChanged(server, v);
        return;
      }
      case "visit.updated": {
        const account = db.accounts.find((a) => a.id === v.patient_id);
        if (account) emitVisit(server, v, "visit.updated", visitView({ db, locale: v.locale, account }, v));
        return;
      }
      case "run.completed":
        finishRun({ status: "completed", steps: Number(data.steps), usage: data.usage as { input_tokens: number; output_tokens: number } });
        break;
      case "run.failed":
        finishRun({ status: "failed", error_code: String(data.code) });
        break;
      case "run.interrupted":
        finishRun({ status: "interrupted" });
        break;
    }
    emitVisit(server, v, step.type, step.data);
  }

  /** The server "restarts": running turns are dropped and marked interrupted. */
  interrupt(visitId?: string): void {
    const db = this.server.db;
    for (const turn of db.turns.filter((t) => !visitId || t.visit_id === visitId)) {
      const v = db.visits.find((x) => x.id === turn.visit_id);
      const r = v?.runs.find((x) => x.id === turn.run_id);
      if (v && r) {
        r.status = "interrupted";
        emitVisit(this.server, v, "run.interrupted", { run_id: turn.run_id });
      }
    }
    db.turns = visitId ? db.turns.filter((t) => t.visit_id !== visitId) : [];
    this.server.file.save();
  }
}

/** POST /visits/{id}/runs/retry: run the last patient message again. */
export function retryTurn(server: MockServer, db: Db, v: VisitRec): string {
  const message = v.messages.findLast((m) => m.role === "patient")!;
  const runId = uuid();
  const text = message.content.startsWith("/") ? L(v.locale, "重試", "retry") : message.content;
  queue(server, db, v, message, runId, modelSteps(v, text, runId, db.settings.ai.primary));
  return runId;
}

export function submitVisit(server: MockServer, db: Db, v: VisitRec, now: string): void {
  if (v.submitted_at) return;
  v.summary ??= buildSummary(v.id, v.intake, v.evidence, now, { revision: 1, en: v.locale === "en", redFlags: v.red_flag ? [{ category: v.red_flag.category, label: v.red_flag.label }] : [] });
  v.submitted_at = now;
  if (v.status === "active") {
    v.status = "submitted";
    v.stage = "done";
  }
  v.updated_at = now;
  v.last_activity_at = now;
  const name = db.accounts.find((a) => a.id === v.patient_id)?.display_name ?? "";
  notifyStaff(server, db, "visit.review", "visit.submitted", ["預問診已送出", "Previsit sent", `${name}送出預問診。`, `${name} sent a previsit.`], `/clinic/visits/${v.id}`);
}
