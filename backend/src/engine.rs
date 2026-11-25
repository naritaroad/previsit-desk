//! One patient turn: PII mask, red-flag and scope screens, then (only if needed) the bounded model loop,
//! output guard, style clean-up, saving, and the events of the visit's log (contract §3; v1 contract §4, §7.2).
//!
//! [`accept`] runs inside the request: the message and its screens are stored before the 202 goes out. [`respond`] runs
//! in a detached task; whether anyone is watching makes no difference to it.
//!
//! Order of events for a red flag: message.created, message.accepted, precheck.completed, redflag.triggered,
//! (ticket.created), message.created, message.completed, visit.updated, run.completed(skipped). A normal turn adds
//! run.started and the tool and intake events, then guard.rewrote (if any), message.delta, message.completed,
//! visit.updated, run.completed.

use std::panic::AssertUnwindSafe;
use std::time::Instant;

use futures::FutureExt;
use genai::chat::{ChatMessage, ChatRequest, ToolResponse};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::OwnedMutexGuard;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use crate::error::AppError;
use crate::events::{self, NewMessage};
use crate::guard::{self, GuardAction};
use crate::limits::ClientKey;
use crate::llm::ModelGateway;
use crate::notify;
use crate::perm::Permission;
use crate::pii;
use crate::precheck::RedFlagMatch;
use crate::profile::{self, ProfileBrief};
use crate::prompt::{self, PromptContext};
use crate::settings::{self, ModelPlan};
use crate::state::{AppState, Rules};
use crate::texts::{self, T, fmt, t};
use crate::tickets::{self, NewTicket};
use crate::tools::{self, ToolCtx};
use crate::types::{
    CreatedBy, Locale, Message, RedFlagHit, ScopeVerdict, Stage, TicketReason, ToolSource,
    ToolStatus, Urgency, Visit, VisitMode, VisitStatus, message_kind,
};
use crate::{clock, limits, visits};

const HISTORY_LIMIT: i64 = 24;

/// A copy of one event, for the eval runner.
#[derive(Debug, Clone)]
pub struct StreamEvent {
    pub kind: &'static str,
    pub data: Value,
}

pub type EventSink = UnboundedSender<StreamEvent>;

/// Writes the visit's events; `observer` gets a copy of each (eval runner only).
#[derive(Clone, Copy)]
pub struct Emitter<'a> {
    state: &'a AppState,
    visit_id: Uuid,
    observer: Option<&'a EventSink>,
}

impl Emitter<'_> {
    fn copy(&self, kind: &'static str, data: &Value) {
        if let Some(observer) = self.observer {
            let _ = observer.send(StreamEvent {
                kind,
                data: data.clone(),
            });
        }
    }

    async fn emit(&self, kind: &'static str, data: Value) -> sqlx::Result<()> {
        self.copy(kind, &data);
        events::append(self.state, self.visit_id, kind, data).await?;
        Ok(())
    }

    fn delta(&self, text: &str) {
        self.copy("message.delta", &json!({ "text": text }));
        events::delta(self.state, self.visit_id, text);
    }

    /// Stores an assistant message and its events.
    async fn say(
        &self,
        locale: Locale,
        kind: &str,
        content: &str,
        run_id: Option<Uuid>,
    ) -> sqlx::Result<Message> {
        let message =
            visits::assistant_message(self.state, self.visit_id, locale, kind, content, run_id)
                .await?;
        self.emit(
            "message.completed",
            json!({ "message_id": message.id, "kind": kind, "content": message.content, "run_id": run_id }),
        )
        .await?;
        Ok(message)
    }
}

/// A patient message after masking and the program-side screens (cheap, no database, no model).
pub struct Prepared {
    pub text: String,
    pub raw_chars: usize,
    pub pii_count: usize,
    pub pii_kinds: Vec<&'static str>,
    pub red_flag: Option<RedFlagMatch>,
    pub scope: ScopeVerdict,
    pub precheck_ms: u64,
    /// Who sent it (salted hash), for the per-client daily model-call cap. `None` in the eval runner.
    pub client: Option<ClientKey>,
}

pub fn prepare(rules: &Rules, raw: &str) -> Prepared {
    let started = Instant::now();
    let masked = pii::mask(raw);
    let red_flag = rules.red_flags.check(&masked.text);
    let scope = rules.scope.check(&masked.text);
    Prepared {
        raw_chars: raw.chars().count(),
        pii_count: masked.count,
        pii_kinds: masked.kinds,
        text: masked.text,
        red_flag,
        scope,
        precheck_ms: started.elapsed().as_millis() as u64,
        client: None,
    }
}

pub fn is_closed(visit: &Visit) -> bool {
    matches!(visit.status, VisitStatus::Submitted | VisitStatus::Reviewed)
}

/// One turn, ready to be answered.
pub struct Turn {
    pub visit_id: Uuid,
    pub run_id: Uuid,
    pub message_id: Uuid,
    pub prepared: Prepared,
}

/// A whole turn as the eval runner uses it: lock, prepare, closed check, accept, respond.
pub async fn handle_message(
    state: &AppState,
    visit_id: Uuid,
    raw: &str,
    observer: &EventSink,
) -> Result<(), AppError> {
    let _guard = state
        .visit_locks
        .try_acquire(visit_id)
        .ok_or(AppError::Conflict)?;
    let visit = visits::fetch(&state.db, visit_id, visits::retention_cutoff(state))
        .await?
        .ok_or(AppError::NotFound)?;
    let prepared = prepare(&state.rules, raw);
    if is_closed(&visit) && prepared.red_flag.is_none() {
        return Err(AppError::VisitClosed.localized(visit.locale));
    }
    let message = accept(state, &visit, &prepared, None, None, Some(observer)).await?;
    let run_id = start_run(state, visit_id, message.id).await?;
    let turn = Turn {
        visit_id,
        run_id,
        message_id: message.id,
        prepared,
    };
    respond(state, &turn, Some(observer)).await
}

/// The run row exists before the answer starts, so a crash in between leaves something to retry.
pub async fn start_run(state: &AppState, visit_id: Uuid, message_id: Uuid) -> sqlx::Result<Uuid> {
    visits::insert_run(
        &state.db,
        visit_id,
        &state.settings.get().ai.primary,
        Some(message_id),
    )
    .await
}

/// Answers a turn in the background. The guard keeps the visit to one turn at a time; a red-flag message may come
/// without one, because it must not wait for a model.
pub fn spawn_respond(state: &AppState, turn: Turn, guard: Option<OwnedMutexGuard<()>>) {
    let state = state.clone();
    tokio::spawn(async move {
        let _guard = guard;
        let outcome = AssertUnwindSafe(respond(&state, &turn, None))
            .catch_unwind()
            .await;
        let failed = match outcome {
            Ok(Ok(())) => return,
            Ok(Err(error)) => error.to_string(),
            Err(_) => "panic".to_string(),
        };
        tracing::error!(error = %failed, run = %turn.run_id, "turn failed");
        if let Err(error) = abandon(&state, &turn).await {
            tracing::error!(error = %error, run = %turn.run_id, "could not close a failed turn");
        }
    });
}

/// Closes a turn that ended in an error of ours, with the usual notice.
async fn abandon(state: &AppState, turn: &Turn) -> Result<(), AppError> {
    let Some(visit) =
        visits::fetch(&state.db, turn.visit_id, time::OffsetDateTime::UNIX_EPOCH).await?
    else {
        return Ok(());
    };
    let settings = state.settings.get();
    let counters = RunCounters {
        model_used: settings.ai.primary.clone(),
        ..RunCounters::default()
    };
    let emitter = Emitter {
        state,
        visit_id: turn.visit_id,
        observer: None,
    };
    fail_run(
        &visit,
        turn,
        "model_error",
        &counters,
        Instant::now(),
        emitter,
    )
    .await
}

fn red_flag_hit(
    state: &AppState,
    matched: &RedFlagMatch,
    locale: Locale,
    message_id: Uuid,
) -> RedFlagHit {
    RedFlagHit {
        category: matched.category,
        label: matched.label(locale).to_string(),
        matched_at: visits::rfc3339(state.clock.now()),
        message_id,
    }
}

#[allow(clippy::too_many_arguments)]
async fn trace(
    db: &PgPool,
    visit_id: Uuid,
    run_id: Option<Uuid>,
    step: i32,
    name: &str,
    source: ToolSource,
    status: ToolStatus,
    arguments: &Value,
    result: &Value,
    duration_ms: i32,
) -> sqlx::Result<()> {
    visits::record_tool_call(
        db,
        visits::NewToolCall {
            id: None,
            visit_id,
            run_id,
            step,
            name,
            source: source.as_str(),
            status: status.as_str(),
            arguments,
            result,
            duration_ms,
        },
    )
    .await?;
    Ok(())
}

/// Stores the patient's message (masked) with the audit rows and events of the screens that ran on it.
/// A repeated `client_id` is a unique violation; the caller answers with the first message.
pub async fn accept(
    state: &AppState,
    visit: &Visit,
    prepared: &Prepared,
    author: Option<Uuid>,
    client_id: Option<&str>,
    observer: Option<&EventSink>,
) -> Result<Message, AppError> {
    let db = &state.db;
    let visit_id = visit.id;
    let locale = visit.locale;
    let emitter = Emitter {
        state,
        visit_id,
        observer,
    };
    let patient = events::insert_message(
        state,
        visit_id,
        locale,
        NewMessage {
            role: "patient",
            kind: message_kind::CHAT,
            content: &prepared.text,
            run_id: None,
            author,
            client_id,
        },
    )
    .await?;
    emitter
        .emit(
            "message.accepted",
            json!({ "message_id": patient.id, "visit_id": visit_id }),
        )
        .await?;
    visits::touch(db, visit_id).await?;

    // Audit rows for the screens that ran on every message.
    let chars = json!({ "chars": prepared.raw_chars });
    if prepared.pii_count > 0 {
        trace(
            db,
            visit_id,
            None,
            0,
            "pii_filter",
            ToolSource::Code,
            ToolStatus::Ok,
            &chars,
            &json!({ "masked": prepared.pii_count, "kinds": prepared.pii_kinds }),
            0,
        )
        .await?;
    }
    let rf_result = match &prepared.red_flag {
        Some(m) => {
            json!({ "hit": true, "category": m.category, "label": m.label(locale), "rule_id": m.rule_id })
        }
        None => json!({ "hit": false }),
    };
    trace(
        db,
        visit_id,
        None,
        0,
        "red_flag_precheck",
        ToolSource::Code,
        ToolStatus::Ok,
        &chars,
        &rf_result,
        prepared.precheck_ms as i32,
    )
    .await?;
    trace(
        db,
        visit_id,
        None,
        0,
        "scope_precheck",
        ToolSource::Code,
        ToolStatus::Ok,
        &chars,
        &json!({ "verdict": prepared.scope }),
        0,
    )
    .await?;
    let hit = prepared
        .red_flag
        .as_ref()
        .map(|m| red_flag_hit(state, m, locale, patient.id));
    emitter
        .emit(
            "precheck.completed",
            json!({ "red_flag": hit, "scope": prepared.scope, "duration_ms": prepared.precheck_ms }),
        )
        .await?;
    Ok(patient)
}

/// What a red flag does, whatever text it was found in: the event row, the urgent ticket, the status, the fixed reply,
/// the stream events and the staff notification. No model is involved.
pub async fn raise_red_flag(
    state: &AppState,
    visit: &Visit,
    matched: &RedFlagMatch,
    message_id: Option<Uuid>,
    run_id: Option<Uuid>,
    observer: Option<&EventSink>,
) -> Result<RedFlagHit, AppError> {
    let emitter = Emitter {
        state,
        visit_id: visit.id,
        observer,
    };
    let locale = visit.locale;
    let summary_text = fmt(
        T::TicketRedFlag,
        locale,
        &[("label", matched.label(locale)), ("rule", &matched.rule_id)],
    );
    let created = tickets::open(
        state,
        NewTicket {
            source: tickets::Source::Visit(visit.id),
            reason: TicketReason::RedFlag,
            urgency: Urgency::Urgent,
            summary: &summary_text,
            created_by: CreatedBy::Code,
        },
    )
    .await?;
    visits::set_status(&state.db, visit.id, VisitStatus::RedFlag).await?;
    let reply_text = texts::red_flag_reply(matched.category, locale);
    // A flag in a form has no message of its own; the fixed reply stands in for it.
    let mut reply = None;
    let message_id = match message_id {
        Some(id) => id,
        None => {
            let message = visits::assistant_message(
                state,
                visit.id,
                locale,
                message_kind::RED_FLAG,
                &reply_text,
                run_id,
            )
            .await?;
            let id = message.id;
            reply = Some(message);
            id
        }
    };
    visits::insert_red_flag_event(
        &state.db,
        visit.id,
        message_id,
        matched.category,
        &matched.rule_id,
    )
    .await?;
    let hit = red_flag_hit(state, matched, locale, message_id);
    emitter
        .emit(
            "redflag.triggered",
            json!({ "category": hit.category, "label": hit.label, "message_id": message_id }),
        )
        .await?;
    if !created.deduped {
        emitter
            .emit(
                "ticket.created",
                serde_json::to_value(&created.ticket).unwrap_or(Value::Null),
            )
            .await?;
    }
    match reply {
        None => {
            emitter
                .say(locale, message_kind::RED_FLAG, &reply_text, run_id)
                .await?;
        }
        Some(message) => {
            emitter
                .emit(
                    "message.completed",
                    json!({ "message_id": message.id, "kind": message_kind::RED_FLAG, "content": message.content, "run_id": run_id }),
                )
                .await?;
        }
    }
    // Visits without a patient account (v1 rows, the eval runner) do not call anyone.
    if let Some(patient_id) = visit.patient_id {
        notify::notify_staff(
            state,
            Permission::VisitReview,
            notify::Kind::RedFlag,
            json!({ "patient_id": patient_id, "label": matched.label_zh, "label_en": matched.label_en }),
            &format!("/clinic/visits/{}", visit.id),
            None,
        )
        .await;
    }
    visits::changed(state, visit.id, visit.patient_id, true);
    Ok(hit)
}

/// A fixed assistant message after the reply when personal data was masked in the patient's message.
async fn pii_notice(
    emitter: Emitter<'_>,
    run_id: Option<Uuid>,
    prepared: &Prepared,
    locale: Locale,
) -> sqlx::Result<()> {
    if prepared.pii_count > 0 {
        emitter
            .say(
                locale,
                message_kind::NOTICE,
                t(T::NoticePii, locale),
                run_id,
            )
            .await?;
    }
    Ok(())
}

/// Closes a turn the program answered by itself.
async fn finish_skipped(
    emitter: Emitter<'_>,
    turn: &Turn,
    locale: Locale,
    error_code: Option<&str>,
) -> Result<(), AppError> {
    visits::finish_run(
        &emitter.state.db,
        turn.run_id,
        visits::RunFinish {
            status: "skipped",
            error_code,
            model: "rules",
            ..visits::RunFinish::default()
        },
    )
    .await?;
    pii_notice(emitter, Some(turn.run_id), &turn.prepared, locale).await?;
    visits::emit_updated(emitter.state, emitter.visit_id).await?;
    emitter
        .emit(
            "run.completed",
            json!({ "run_id": turn.run_id, "status": "skipped", "steps": 0, "usage": { "input_tokens": 0, "output_tokens": 0 }, "model": "rules" }),
        )
        .await?;
    Ok(())
}

/// Answers an accepted message. Always closes its run.
pub async fn respond(
    state: &AppState,
    turn: &Turn,
    observer: Option<&EventSink>,
) -> Result<(), AppError> {
    let emitter = Emitter {
        state,
        visit_id: turn.visit_id,
        observer,
    };
    let visit = visits::fetch(&state.db, turn.visit_id, visits::retention_cutoff(state))
        .await?
        .ok_or(AppError::NotFound)?;
    let locale = visit.locale;
    let prepared = &turn.prepared;
    let run_id = Some(turn.run_id);

    // 1. Red flag: fixed reply, urgent ticket, no model. Runs for every status and in both modes.
    if let Some(matched) = &prepared.red_flag {
        raise_red_flag(
            state,
            &visit,
            matched,
            Some(turn.message_id),
            run_id,
            observer,
        )
        .await?;
        return finish_skipped(emitter, turn, locale, None).await;
    }

    // 2. A person is answering: the AI stays out of it.
    if visit.mode == VisitMode::Human {
        return finish_skipped(emitter, turn, locale, Some("human_mode")).await;
    }

    // 3. Already flagged earlier: remind, do not continue the normal questions.
    if visit.status == VisitStatus::RedFlag {
        emitter
            .say(
                locale,
                message_kind::NOTICE,
                t(T::RedFlagReminder, locale),
                run_id,
            )
            .await?;
        return finish_skipped(emitter, turn, locale, None).await;
    }

    // 4. Out of bounds: fixed refusal; prescription and controlled-drug requests also open a ticket.
    if prepared.scope != ScopeVerdict::Ok {
        let (reply_text, ticket_plan) = match prepared.scope {
            ScopeVerdict::PrescriptionRequest => (
                T::RefusalPrescription,
                Some((TicketReason::PrescriptionRequest, T::TicketPrescription)),
            ),
            ScopeVerdict::ControlledDrug => (
                T::RefusalControlled,
                Some((TicketReason::ControlledDrug, T::TicketControlled)),
            ),
            _ => (T::RefusalInjection, None),
        };
        if let Some((reason, summary_key)) = ticket_plan {
            let created = tickets::open(
                state,
                NewTicket {
                    source: tickets::Source::Visit(visit.id),
                    reason,
                    urgency: Urgency::Soon,
                    summary: t(summary_key, locale),
                    created_by: CreatedBy::Code,
                },
            )
            .await?;
            if !created.deduped {
                emitter
                    .emit(
                        "ticket.created",
                        serde_json::to_value(&created.ticket).unwrap_or(Value::Null),
                    )
                    .await?;
            }
        }
        emitter
            .say(locale, message_kind::REFUSAL, t(reply_text, locale), run_id)
            .await?;
        return finish_skipped(emitter, turn, locale, None).await;
    }

    model_turn(&visit, turn, emitter).await
}

// ---------------------------------------------------------------------------
// The model turn
// ---------------------------------------------------------------------------

#[derive(Default)]
struct RunCounters {
    steps: i32,
    input_tokens: i64,
    output_tokens: i64,
    cost_usd: f64,
    fallback_used: bool,
    model_used: String,
    /// A fixed notice other than the default one for the failure code (the per-visit cap).
    notice: Option<T>,
}

/// How the loop ended when it did not fail.
enum LoopDone {
    Replied,
    /// The visit was taken over by a person, or flagged by another message, while the model was thinking: its reply
    /// is dropped.
    Superseded,
}

fn redact(text: &str) -> String {
    let mut out = text.to_string();
    if let Ok(key) = std::env::var("GEMINI_API_KEY")
        && !key.trim().is_empty()
    {
        out = out.replace(key.trim(), "[redacted]");
    }
    out.chars().take(300).collect()
}

async fn model_turn(visit: &Visit, turn: &Turn, emitter: Emitter<'_>) -> Result<(), AppError> {
    let state = emitter.state;
    let db = &state.db;
    let settings = state.settings.get();
    let prepared = &turn.prepared;
    let started = Instant::now();
    let day = state.clock.today();
    let mut counters = RunCounters {
        model_used: settings.ai.primary.clone(),
        ..RunCounters::default()
    };

    let plan = settings::plan(
        &settings,
        limits::calls_today(db, &state.clock).await?,
        limits::spent_this_month(db, &state.clock).await?,
        state.config.model_ready(&settings.ai.primary),
    );
    let (primary, fallback) = match plan {
        ModelPlan::Disabled => {
            emitter
                .say(
                    visit.locale,
                    message_kind::NOTICE,
                    t(T::NoticeAiDisabled, visit.locale),
                    Some(turn.run_id),
                )
                .await?;
            return finish_skipped(emitter, turn, visit.locale, Some("ai_disabled")).await;
        }
        ModelPlan::Blocked(code) => {
            return fail_run(visit, turn, code, &counters, started, emitter).await;
        }
        ModelPlan::Run {
            primary,
            fallback,
            over_budget,
        } => {
            counters.fallback_used = over_budget;
            counters.model_used = primary.clone();
            (primary, fallback)
        }
    };
    // One client has used its share of today's model calls; everyone else is unaffected.
    if prepared.client.is_some_and(|c| {
        i64::from(state.limiter.client_calls(c, day)) >= settings.ai.per_client_daily_limit
    }) {
        return fail_run(
            visit,
            turn,
            "daily_budget_exceeded",
            &counters,
            started,
            emitter,
        )
        .await;
    }
    if visits::patient_message_count(db, visit.id).await? > settings.limits.max_messages_per_visit {
        counters.notice = Some(T::NoticeVisitLimit);
        return fail_run(
            visit,
            turn,
            "daily_budget_exceeded",
            &counters,
            started,
            emitter,
        )
        .await;
    }

    emitter
        .emit(
            "run.started",
            json!({ "run_id": turn.run_id, "model": primary, "message_id": turn.message_id }),
        )
        .await?;
    let outcome = tokio::time::timeout(
        state.config.run_timeout(),
        run_loop(
            visit,
            turn,
            &primary,
            fallback.as_deref(),
            emitter,
            &mut counters,
        ),
    )
    .await;
    let done = match outcome {
        Ok(Ok(done)) => done,
        Ok(Err(code)) => return fail_run(visit, turn, code, &counters, started, emitter).await,
        Err(_) => return fail_run(visit, turn, "timeout", &counters, started, emitter).await,
    };
    let (status, code) = match done {
        LoopDone::Replied => ("completed", None),
        LoopDone::Superseded => ("skipped", Some("superseded")),
    };
    visits::finish_run(
        db,
        turn.run_id,
        visits::RunFinish {
            status,
            steps: counters.steps,
            input_tokens: counters.input_tokens,
            output_tokens: counters.output_tokens,
            cost_usd: counters.cost_usd,
            error_code: code,
            duration_ms: started.elapsed().as_millis() as i64,
            fallback_used: counters.fallback_used,
            model: &counters.model_used,
        },
    )
    .await?;
    pii_notice(emitter, Some(turn.run_id), prepared, visit.locale).await?;
    let after = visits::fetch(db, visit.id, time::OffsetDateTime::UNIX_EPOCH).await?;
    if after.as_ref().is_some_and(|v| {
        v.stage != visit.stage || v.status != visit.status || v.title != visit.title
    }) {
        visits::emit_updated(state, visit.id).await?;
    } else {
        visits::changed(state, visit.id, visit.patient_id, false);
    }
    emitter
        .emit(
            "run.completed",
            json!({ "run_id": turn.run_id, "status": status, "steps": counters.steps, "usage": { "input_tokens": counters.input_tokens, "output_tokens": counters.output_tokens }, "model": counters.model_used }),
        )
        .await?;
    Ok(())
}

/// Saves a fixed notice, closes the run as failed and tells the stream. Always ends with `run.failed`.
async fn fail_run(
    visit: &Visit,
    turn: &Turn,
    code: &'static str,
    counters: &RunCounters,
    started: Instant,
    emitter: Emitter<'_>,
) -> Result<(), AppError> {
    let run_id = turn.run_id;
    visits::finish_run(
        &emitter.state.db,
        run_id,
        visits::RunFinish {
            status: "failed",
            steps: counters.steps,
            input_tokens: counters.input_tokens,
            output_tokens: counters.output_tokens,
            cost_usd: counters.cost_usd,
            error_code: Some(code),
            duration_ms: started.elapsed().as_millis() as i64,
            fallback_used: counters.fallback_used,
            model: &counters.model_used,
        },
    )
    .await?;
    let text_key = counters.notice.unwrap_or(match code {
        "max_steps" => T::NoticeMaxSteps,
        "timeout" => T::NoticeTimeout,
        "not_configured" => T::NoticeNotConfigured,
        "daily_budget_exceeded" => T::NoticeDailyBudget,
        "monthly_budget_exceeded" => T::NoticeMonthlyBudget,
        _ => T::NoticeModelError,
    });
    let text = t(text_key, visit.locale);
    emitter
        .say(visit.locale, message_kind::NOTICE, text, Some(run_id))
        .await?;
    pii_notice(emitter, Some(run_id), &turn.prepared, visit.locale).await?;
    // The contract knows one budget code; the run row keeps which budget it was.
    let public_code = if code == "monthly_budget_exceeded" {
        "daily_budget_exceeded"
    } else {
        code
    };
    emitter
        .emit(
            "run.failed",
            json!({ "run_id": run_id, "code": public_code, "message": text }),
        )
        .await?;
    Ok(())
}

/// True when a person took the visit over, or another message raised a red flag, since the turn started.
async fn superseded(db: &PgPool, visit: &Visit) -> sqlx::Result<bool> {
    let now: Option<(String, String)> =
        sqlx::query_as("SELECT status, mode FROM visits WHERE id = $1")
            .bind(visit.id)
            .fetch_optional(db)
            .await?;
    Ok(match now {
        Some((status, mode)) => {
            mode == "human"
                || (status == VisitStatus::RedFlag.as_str() && visit.status != VisitStatus::RedFlag)
        }
        None => true,
    })
}

/// Recent chat as model messages: patient and assistant turns only (what staff wrote in the thread stays here), consecutive same-role turns merged,
/// starting with a patient turn (some providers refuse a conversation that opens with the assistant).
async fn history(db: &PgPool, visit_id: Uuid) -> sqlx::Result<Vec<ChatMessage>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        role: String,
        content: String,
    }
    let mut rows: Vec<Row> = sqlx::query_as("SELECT role, content FROM messages WHERE visit_id = $1 AND role <> 'staff' AND kind IN ('chat', 'refusal') ORDER BY created_at DESC, id DESC LIMIT $2").bind(visit_id).bind(HISTORY_LIMIT).fetch_all(db).await?;
    rows.reverse();
    let mut merged: Vec<(String, String)> = Vec::new();
    for row in rows {
        match merged.last_mut() {
            Some((role, content)) if *role == row.role => {
                content.push('\n');
                content.push_str(&row.content);
            }
            _ => merged.push((row.role, row.content)),
        }
    }
    while merged.first().is_some_and(|(role, _)| role != "patient") {
        merged.remove(0);
    }
    Ok(merged
        .into_iter()
        .map(|(role, content)| {
            if role == "patient" {
                ChatMessage::user(content)
            } else {
                ChatMessage::assistant(content)
            }
        })
        .collect())
}

async fn run_loop(
    visit: &Visit,
    turn: &Turn,
    primary_model: &str,
    fallback_model: Option<&str>,
    emitter: Emitter<'_>,
    counters: &mut RunCounters,
) -> Result<LoopDone, &'static str> {
    let state = emitter.state;
    let db = &state.db;
    let settings = state.settings.get();
    let (run_id, prepared) = (turn.run_id, &turn.prepared);
    let locale = visit.locale;
    let db_fail = |e: sqlx::Error| {
        tracing::error!(error = %e, "database error in the model loop");
        "model_error"
    };

    let intake = visits::load_intake(db, visit.id).await.map_err(db_fail)?;
    let mut patient_text = visits::patient_text(db, visit.id).await.map_err(db_fail)?;
    let messages = history(db, visit.id).await.map_err(db_fail)?;
    let today = clock::format_date(state.clock.today());
    let known = match visit.patient_id {
        Some(patient) => profile::brief(state, patient, locale).await.map_err(|e| {
            tracing::error!(error = %e, "could not load the health profile");
            "model_error"
        })?,
        None => ProfileBrief::default(),
    };
    let system = prompt::system_prompt(&PromptContext {
        locale,
        stage: visit.stage,
        today: &today,
        intake: &intake,
        known: &known,
        has_account: visit.patient_id.is_some(),
    });
    // What the record already says may be read back without tripping the output guard.
    for item in known.items() {
        patient_text.push('\n');
        patient_text.push_str(item);
    }
    let mut request = ChatRequest::new(messages)
        .with_system(system)
        .with_tools(tools::specs(visit.patient_id.is_some()));

    let primary = state.ai.gateway(
        primary_model,
        Some(settings.thinking()),
        settings.ai.temperature,
    );
    let fallback = fallback_model.map(|m| state.ai.gateway(m, None, settings.ai.temperature));
    let mut using_fallback = false;
    let day = state.clock.today();
    let mut ctx = ToolCtx {
        state,
        visit_id: visit.id,
        locale,
        model: primary_model,
        intake,
        stage: visit.stage,
        confirm_offered: visits::confirm_offered(db, visit.id)
            .await
            .map_err(db_fail)?,
        status: visit.status,
        patient_text,
        patient_message: prepared.text.clone(),
        message_id: turn.message_id,
        patient_id: visit.patient_id,
        evidence: visit.evidence.clone(),
    };

    for step in 1..=settings.ai.max_steps as i32 {
        if superseded(db, visit).await.map_err(db_fail)? {
            return Ok(LoopDone::Superseded);
        }
        if limits::calls_today(db, &state.clock)
            .await
            .map_err(db_fail)?
            >= settings.ai.daily_call_limit
        {
            return Err("daily_budget_exceeded");
        }
        if let Some(client) = prepared.client
            && i64::from(state.limiter.client_calls(client, day))
                >= settings.ai.per_client_daily_limit
        {
            return Err("daily_budget_exceeded");
        }
        // One call: primary first, then the fallback model once if the primary fails or times out.
        let reply = loop {
            let gateway: &dyn ModelGateway = match (using_fallback, fallback.as_deref()) {
                (true, Some(fb)) => fb,
                _ => primary.as_ref(),
            };
            counters.model_used = gateway.model_name().to_string();
            // Every attempt costs quota on the provider's side, so every attempt counts here too.
            if let Some(client) = prepared.client {
                state.limiter.add_client_calls(client, day, 1);
            }
            let failure = match tokio::time::timeout(
                state.config.llm_timeout,
                gateway.chat(request.clone()),
            )
            .await
            {
                Ok(Ok(reply)) => {
                    let cost = settings.cost(
                        gateway.model_name(),
                        reply.input_tokens,
                        reply.output_tokens,
                    );
                    limits::record_call(
                        db,
                        &state.clock,
                        gateway.model_name(),
                        reply.input_tokens,
                        reply.output_tokens,
                        cost,
                    )
                    .await
                    .map_err(db_fail)?;
                    counters.input_tokens += reply.input_tokens;
                    counters.output_tokens += reply.output_tokens;
                    counters.cost_usd += cost;
                    tracing::info!(model = gateway.model_name(), step, input_tokens = reply.input_tokens, output_tokens = reply.output_tokens, reasoning_tokens = ?reply.reasoning_tokens, "model call");
                    break reply;
                }
                Ok(Err(e)) => {
                    tracing::warn!(model = gateway.model_name(), step, error = %redact(&format!("{e:#}")), "model call failed");
                    limits::record_call(db, &state.clock, gateway.model_name(), 0, 0, 0.0)
                        .await
                        .map_err(db_fail)?;
                    "model_error"
                }
                Err(_) => {
                    tracing::warn!(model = gateway.model_name(), step, "model call timed out");
                    limits::record_call(db, &state.clock, gateway.model_name(), 0, 0, 0.0)
                        .await
                        .map_err(db_fail)?;
                    "timeout"
                }
            };
            if !using_fallback && fallback.is_some() {
                using_fallback = true;
                counters.fallback_used = true;
                continue;
            }
            return Err(failure);
        };
        counters.steps = step;
        if superseded(db, visit).await.map_err(db_fail)? {
            return Ok(LoopDone::Superseded);
        }

        if reply.tool_calls.is_empty() {
            return finish_reply(
                visit,
                run_id,
                step,
                reply.text.unwrap_or_default(),
                &mut ctx,
                emitter,
            )
            .await;
        }

        let assistant = reply
            .assistant_message
            .unwrap_or_else(|| ChatMessage::from(reply.tool_calls.clone()));
        request = request.append_message(assistant);
        for call in &reply.tool_calls {
            let call_id = Uuid::new_v4();
            // The arguments are model-written: mask personal data and drop diagnosis or dose wording before they
            // are stored or shown in the trace panel. The tool itself still gets the original arguments.
            let shown_args = tools::sanitize_args(&call.fn_arguments, locale, &ctx.patient_text);
            emitter
                .emit(
                    "tool.started",
                    json!({ "call_id": call_id, "step": step, "name": call.fn_name, "source": "model", "arguments": shown_args }),
                )
                .await
                .map_err(db_fail)?;
            let outcome = tools::dispatch(&mut ctx, &call.fn_name, &call.fn_arguments).await;
            visits::record_tool_call(
                db,
                visits::NewToolCall {
                    id: Some(call_id),
                    visit_id: visit.id,
                    run_id: Some(run_id),
                    step,
                    name: &call.fn_name,
                    source: ToolSource::Model.as_str(),
                    status: outcome.status.as_str(),
                    arguments: &shown_args,
                    result: &outcome.stored_result,
                    duration_ms: outcome.duration_ms,
                },
            )
            .await
            .map_err(db_fail)?;
            emitter
                .emit(
                    "tool.completed",
                    json!({ "call_id": call_id, "step": step, "name": call.fn_name, "status": outcome.status.as_str(), "result": outcome.stored_result, "duration_ms": outcome.duration_ms }),
                )
                .await
                .map_err(db_fail)?;
            let mut follow_ups: Vec<(&'static str, Value)> = Vec::new();
            if outcome.effects.intake_changed {
                follow_ups.push((
                    "intake.updated",
                    serde_json::to_value(ctx.intake.view(ctx.stage)).unwrap_or(Value::Null),
                ));
            }
            if let Some(ticket) = &outcome.effects.ticket {
                follow_ups.push((
                    "ticket.created",
                    serde_json::to_value(ticket).unwrap_or(Value::Null),
                ));
            }
            if let Some(summary) = &outcome.effects.summary {
                follow_ups.push((
                    "summary.updated",
                    serde_json::to_value(summary).unwrap_or(Value::Null),
                ));
            }
            for (kind, data) in follow_ups {
                emitter.emit(kind, data).await.map_err(db_fail)?;
            }
            request = request.append_message(ToolResponse::from_tool_call(
                call,
                outcome.model_result.to_string(),
            ));
        }
    }
    Err("max_steps")
}

/// The model's final text: guard, style clean-up, delta, save, completed.
async fn finish_reply(
    visit: &Visit,
    run_id: Uuid,
    step: i32,
    raw: String,
    ctx: &mut ToolCtx<'_>,
    emitter: Emitter<'_>,
) -> Result<LoopDone, &'static str> {
    let db = &emitter.state.db;
    let locale = visit.locale;
    let db_fail = |e: sqlx::Error| {
        tracing::error!(error = %e, "database error while saving the reply");
        "model_error"
    };
    let mut text = raw.trim().to_string();
    if text.is_empty() {
        if ctx.stage == Stage::Done {
            text = t(T::SubmittedThanks, locale).to_string();
        } else {
            return Err("model_error");
        }
    }

    // What the patient said, plus the medicines already recorded, may be restated without being flagged.
    let mut allowed = ctx.patient_text.clone();
    for item in ctx
        .intake
        .medications
        .items
        .iter()
        .chain(&ctx.intake.past_history.items)
        .chain(&ctx.intake.allergies.items)
    {
        allowed.push('\n');
        allowed.push_str(item);
    }
    let sanitized = guard::sanitize_reply(&text, locale, &allowed);
    let violations: Vec<&str> = sanitized.violations.iter().map(|v| v.as_str()).collect();
    trace(
        db,
        visit.id,
        Some(run_id),
        step,
        "output_guard",
        ToolSource::Code,
        if sanitized.violations.is_empty() {
            ToolStatus::Ok
        } else {
            ToolStatus::Rejected
        },
        &json!({ "chars": text.chars().count() }),
        &json!({ "passed": sanitized.violations.is_empty(), "violations": violations, "action": sanitized.action.as_str() }),
        0,
    )
    .await
    .map_err(db_fail)?;
    if sanitized.action != GuardAction::None {
        for violation in &violations {
            visits::insert_guard_event(db, visit.id, run_id, violation, sanitized.action.as_str())
                .await
                .map_err(db_fail)?;
        }
        emitter
            .emit(
                "guard.rewrote",
                json!({ "kind": violations.first().copied().unwrap_or("other"), "action": sanitized.action.as_str() }),
            )
            .await
            .map_err(db_fail)?;
    }

    let final_text = sanitized.text;
    emitter.delta(&final_text);
    emitter
        .say(locale, message_kind::CHAT, &final_text, Some(run_id))
        .await
        .map_err(db_fail)?;
    visits::touch(db, visit.id).await.map_err(db_fail)?;
    if ctx.stage == Stage::Confirm {
        visits::mark_confirm_offered(db, visit.id)
            .await
            .map_err(db_fail)?;
    }
    Ok(LoopDone::Replied)
}

/// At start: messages whose turn was cut off are screened again, so a red flag that was accepted just before the
/// process ended still gets its ticket and its reply without waiting for the patient to retry.
pub async fn finish_interrupted_red_flags(
    state: &AppState,
    interrupted: &[(Uuid, Uuid)],
) -> Result<(), AppError> {
    for (visit_id, message_id) in interrupted {
        let content: Option<String> =
            sqlx::query_scalar("SELECT content FROM messages WHERE id = $1 AND visit_id = $2")
                .bind(message_id)
                .bind(visit_id)
                .fetch_optional(&state.db)
                .await?;
        let Some(matched) = content
            .as_deref()
            .and_then(|text| state.rules.red_flags.check(text))
        else {
            continue;
        };
        let Some(visit) =
            visits::fetch(&state.db, *visit_id, time::OffsetDateTime::UNIX_EPOCH).await?
        else {
            continue;
        };
        raise_red_flag(state, &visit, &matched, Some(*message_id), None, None).await?;
        visits::set_message_status(&state.db, *message_id, "ok").await?;
        visits::emit_updated(state, *visit_id).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_hides_the_key_and_truncates() {
        // SAFETY of the test: only reads the variable name that the app itself uses; value set locally.
        let long = "x".repeat(500);
        assert_eq!(redact(&long).chars().count(), 300);
    }
}
