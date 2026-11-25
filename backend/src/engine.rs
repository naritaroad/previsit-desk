//! One patient turn: PII mask, red-flag and scope screens, then (only if needed) the bounded model loop,
//! output guard, style clean-up, saving, and the stream events (contract §4, §7.2).
//!
//! Order of events for a red flag: message.accepted, precheck.completed, redflag.triggered, (ticket.created),
//! message.completed, visit.updated, run.completed(skipped). A normal turn adds run.started and the tool and
//! intake events, then guard.rewrote (if any), message.delta, message.completed, visit.updated, run.completed.

use std::time::Instant;

use genai::chat::{ChatMessage, ChatRequest, ToolResponse};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use crate::error::AppError;
use crate::guard::{self, GuardAction};
use crate::limits::ClientKey;
use crate::llm::ModelGateway;
use crate::pii;
use crate::precheck::RedFlagMatch;
use crate::prompt::{self, PromptContext};
use crate::state::{AppState, Rules};
use crate::texts::{self, T, fmt, t};
use crate::tickets::{self, NewTicket};
use crate::tools::{self, ToolCtx};
use crate::types::{
    CreatedBy, Locale, RedFlagHit, ScopeVerdict, Stage, TicketReason, ToolSource, ToolStatus,
    Urgency, Visit, VisitStatus, message_kind,
};
use crate::{clock, limits, visits};

const HISTORY_LIMIT: i64 = 24;

/// One event for the SSE stream. The route numbers them (`seq`) and wraps them.
#[derive(Debug, Clone)]
pub struct StreamEvent {
    pub kind: &'static str,
    pub data: Value,
}

pub type EventSink = UnboundedSender<StreamEvent>;

fn emit(sink: &EventSink, kind: &'static str, data: Value) {
    // The client may have gone away; the run still finishes and is saved.
    let _ = sink.send(StreamEvent { kind, data });
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

/// Whole turn as the eval runner and tests use it: lock, prepare, closed check, run.
pub async fn handle_message(
    state: &AppState,
    visit_id: Uuid,
    raw: &str,
    sink: &EventSink,
) -> Result<(), AppError> {
    let _guard = state
        .visit_locks
        .try_acquire(visit_id)
        .ok_or(AppError::Conflict)?;
    let cutoff = state.clock.retention_cutoff(state.config.retention_days);
    let visit = visits::fetch(&state.db, visit_id, cutoff)
        .await?
        .ok_or(AppError::NotFound)?;
    let prepared = prepare(&state.rules, raw);
    if is_closed(&visit) && prepared.red_flag.is_none() {
        return Err(AppError::VisitClosed.localized(visit.locale));
    }
    run_turn(state, visit_id, prepared, sink).await
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

async fn emit_visit(state: &AppState, visit_id: Uuid, sink: &EventSink) -> Result<(), AppError> {
    let cutoff = state.clock.retention_cutoff(state.config.retention_days);
    if let Some(visit) = visits::fetch(&state.db, visit_id, cutoff).await? {
        emit(
            sink,
            "visit.updated",
            serde_json::to_value(&visit).unwrap_or(Value::Null),
        );
    }
    Ok(())
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
) -> Result<(), AppError> {
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

/// A fixed assistant message after the reply when personal data was masked in the patient's message.
async fn pii_notice(
    state: &AppState,
    visit_id: Uuid,
    run_id: Option<Uuid>,
    prepared: &Prepared,
    locale: Locale,
    sink: &EventSink,
) -> Result<(), AppError> {
    if prepared.pii_count == 0 {
        return Ok(());
    }
    let message = visits::insert_message(
        &state.db,
        visit_id,
        "assistant",
        message_kind::NOTICE,
        t(T::NoticePii, locale),
        run_id,
    )
    .await?;
    emit(
        sink,
        "message.completed",
        json!({ "message_id": message.id, "kind": message_kind::NOTICE, "content": message.content, "run_id": run_id }),
    );
    Ok(())
}

fn skipped_usage() -> Value {
    json!({ "input_tokens": 0, "output_tokens": 0 })
}

pub async fn run_turn(
    state: &AppState,
    visit_id: Uuid,
    prepared: Prepared,
    sink: &EventSink,
) -> Result<(), AppError> {
    let db = &state.db;
    let cutoff = state.clock.retention_cutoff(state.config.retention_days);
    let visit = visits::fetch(db, visit_id, cutoff)
        .await?
        .ok_or(AppError::NotFound)?;
    let locale = visit.locale;
    if is_closed(&visit) && prepared.red_flag.is_none() {
        return Err(AppError::VisitClosed.localized(locale));
    }

    let patient = visits::insert_message(
        db,
        visit_id,
        "patient",
        message_kind::CHAT,
        &prepared.text,
        None,
    )
    .await?;
    emit(
        sink,
        "message.accepted",
        json!({ "message_id": patient.id, "visit_id": visit_id }),
    );
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
    emit(
        sink,
        "precheck.completed",
        json!({ "red_flag": hit, "scope": prepared.scope, "duration_ms": prepared.precheck_ms }),
    );

    // 1. Red flag: fixed reply, urgent ticket, no model. Runs for every visit status.
    if let (Some(matched), Some(hit)) = (&prepared.red_flag, &hit) {
        let run_id = visits::insert_run(db, visit_id, "rules", "skipped").await?;
        visits::insert_red_flag_event(db, visit_id, patient.id, matched.category, &matched.rule_id)
            .await?;
        let summary_text = fmt(
            T::TicketRedFlag,
            locale,
            &[("label", matched.label(locale)), ("rule", &matched.rule_id)],
        );
        let created = tickets::open(
            state,
            NewTicket {
                source: tickets::Source::Visit(visit_id),
                reason: TicketReason::RedFlag,
                urgency: Urgency::Urgent,
                summary: &summary_text,
                created_by: CreatedBy::Code,
            },
        )
        .await?;
        visits::set_status(db, visit_id, VisitStatus::RedFlag).await?;
        let reply = visits::insert_message(
            db,
            visit_id,
            "assistant",
            message_kind::RED_FLAG,
            &texts::red_flag_reply(matched.category, locale),
            Some(run_id),
        )
        .await?;
        emit(
            sink,
            "redflag.triggered",
            json!({ "category": hit.category, "label": hit.label, "message_id": patient.id }),
        );
        if !created.deduped {
            emit(
                sink,
                "ticket.created",
                serde_json::to_value(&created.ticket).unwrap_or(Value::Null),
            );
        }
        emit(
            sink,
            "message.completed",
            json!({ "message_id": reply.id, "kind": message_kind::RED_FLAG, "content": reply.content, "run_id": run_id }),
        );
        pii_notice(state, visit_id, Some(run_id), &prepared, locale, sink).await?;
        emit_visit(state, visit_id, sink).await?;
        emit(
            sink,
            "run.completed",
            json!({ "run_id": run_id, "status": "skipped", "steps": 0, "usage": skipped_usage(), "model": "rules" }),
        );
        return Ok(());
    }

    // 2. Already flagged earlier: remind, do not continue the normal questions.
    if visit.status == VisitStatus::RedFlag {
        let run_id = visits::insert_run(db, visit_id, "rules", "skipped").await?;
        let reply = visits::insert_message(
            db,
            visit_id,
            "assistant",
            message_kind::NOTICE,
            t(T::RedFlagReminder, locale),
            Some(run_id),
        )
        .await?;
        emit(
            sink,
            "message.completed",
            json!({ "message_id": reply.id, "kind": message_kind::NOTICE, "content": reply.content, "run_id": run_id }),
        );
        pii_notice(state, visit_id, Some(run_id), &prepared, locale, sink).await?;
        emit(
            sink,
            "run.completed",
            json!({ "run_id": run_id, "status": "skipped", "steps": 0, "usage": skipped_usage(), "model": "rules" }),
        );
        return Ok(());
    }

    // 3. Out of bounds: fixed refusal; prescription and controlled-drug requests also open a ticket.
    if prepared.scope != ScopeVerdict::Ok {
        let run_id = visits::insert_run(db, visit_id, "rules", "skipped").await?;
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
        let created = match ticket_plan {
            Some((reason, summary_key)) => Some(
                tickets::open(
                    state,
                    NewTicket {
                        source: tickets::Source::Visit(visit_id),
                        reason,
                        urgency: Urgency::Soon,
                        summary: t(summary_key, locale),
                        created_by: CreatedBy::Code,
                    },
                )
                .await?,
            ),
            None => None,
        };
        let reply = visits::insert_message(
            db,
            visit_id,
            "assistant",
            message_kind::REFUSAL,
            t(reply_text, locale),
            Some(run_id),
        )
        .await?;
        if let Some(created) = created.filter(|c| !c.deduped) {
            emit(
                sink,
                "ticket.created",
                serde_json::to_value(&created.ticket).unwrap_or(Value::Null),
            );
        }
        emit(
            sink,
            "message.completed",
            json!({ "message_id": reply.id, "kind": message_kind::REFUSAL, "content": reply.content, "run_id": run_id }),
        );
        pii_notice(state, visit_id, Some(run_id), &prepared, locale, sink).await?;
        emit(
            sink,
            "run.completed",
            json!({ "run_id": run_id, "status": "skipped", "steps": 0, "usage": skipped_usage(), "model": "rules" }),
        );
        return Ok(());
    }

    model_turn(state, &visit, &prepared, sink).await
}

// ---------------------------------------------------------------------------
// The model turn
// ---------------------------------------------------------------------------

#[derive(Default)]
struct RunCounters {
    steps: i32,
    input_tokens: i64,
    output_tokens: i64,
    fallback_used: bool,
    model_used: String,
    /// A fixed notice other than the default one for the failure code (the per-visit cap).
    notice: Option<T>,
}

struct LoopDone;

fn redact(text: &str) -> String {
    let mut out = text.to_string();
    if let Ok(key) = std::env::var("GEMINI_API_KEY")
        && !key.trim().is_empty()
    {
        out = out.replace(key.trim(), "[redacted]");
    }
    out.chars().take(300).collect()
}

async fn model_turn(
    state: &AppState,
    visit: &Visit,
    prepared: &Prepared,
    sink: &EventSink,
) -> Result<(), AppError> {
    let db = &state.db;
    let cfg = &state.config;
    let started = Instant::now();
    let mut counters = RunCounters {
        model_used: cfg.model.clone(),
        ..RunCounters::default()
    };

    let day = state.clock.today();
    let preflight = if !cfg.model_ready() {
        Some("not_configured")
    } else if limits::calls_today(db, &state.clock).await? >= cfg.daily_model_call_limit {
        Some("daily_budget_exceeded")
    } else if prepared.client.is_some_and(|c| {
        i64::from(state.limiter.client_calls(c, day)) >= cfg.per_ip_daily_call_limit
    }) {
        // One client has used its share of today's model calls; everyone else is unaffected.
        Some("daily_budget_exceeded")
    } else if visits::patient_message_count(db, visit.id).await? > cfg.max_messages_per_visit {
        counters.notice = Some(T::NoticeVisitLimit);
        Some("daily_budget_exceeded")
    } else {
        None
    };
    if let Some(code) = preflight {
        let run_id = visits::insert_run(db, visit.id, &cfg.model, "failed").await?;
        return fail_run(
            state, visit, run_id, code, &counters, started, prepared, sink,
        )
        .await;
    }

    let run_id = visits::insert_run(db, visit.id, &cfg.model, "running").await?;
    emit(
        sink,
        "run.started",
        json!({ "run_id": run_id, "model": cfg.model }),
    );
    let outcome = tokio::time::timeout(
        cfg.run_timeout(),
        run_loop(state, visit, run_id, prepared, sink, &mut counters),
    )
    .await;
    match outcome {
        Ok(Ok(LoopDone)) => {
            visits::finish_run(
                db,
                run_id,
                visits::RunFinish {
                    status: "completed",
                    steps: counters.steps,
                    input_tokens: counters.input_tokens,
                    output_tokens: counters.output_tokens,
                    error_code: None,
                    duration_ms: started.elapsed().as_millis() as i64,
                    fallback_used: counters.fallback_used,
                    model: &counters.model_used,
                },
            )
            .await?;
            pii_notice(state, visit.id, Some(run_id), prepared, visit.locale, sink).await?;
            let after = visits::fetch(db, visit.id, clock_floor()).await?;
            if after
                .as_ref()
                .is_some_and(|v| v.stage != visit.stage || v.status != visit.status)
            {
                emit_visit(state, visit.id, sink).await?;
            }
            emit(
                sink,
                "run.completed",
                json!({ "run_id": run_id, "status": "completed", "steps": counters.steps, "usage": { "input_tokens": counters.input_tokens, "output_tokens": counters.output_tokens }, "model": counters.model_used }),
            );
            Ok(())
        }
        Ok(Err(code)) => {
            fail_run(
                state, visit, run_id, code, &counters, started, prepared, sink,
            )
            .await
        }
        Err(_) => {
            fail_run(
                state, visit, run_id, "timeout", &counters, started, prepared, sink,
            )
            .await
        }
    }
}

fn clock_floor() -> time::OffsetDateTime {
    time::OffsetDateTime::UNIX_EPOCH
}

/// Saves a fixed notice, closes the run as failed and tells the stream. Always ends with `run.failed`.
#[allow(clippy::too_many_arguments)]
async fn fail_run(
    state: &AppState,
    visit: &Visit,
    run_id: Uuid,
    code: &'static str,
    counters: &RunCounters,
    started: Instant,
    prepared: &Prepared,
    sink: &EventSink,
) -> Result<(), AppError> {
    let db = &state.db;
    visits::finish_run(
        db,
        run_id,
        visits::RunFinish {
            status: "failed",
            steps: counters.steps,
            input_tokens: counters.input_tokens,
            output_tokens: counters.output_tokens,
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
        _ => T::NoticeModelError,
    });
    let text = t(text_key, visit.locale);
    let notice = visits::insert_message(
        db,
        visit.id,
        "assistant",
        message_kind::NOTICE,
        text,
        Some(run_id),
    )
    .await?;
    emit(
        sink,
        "message.completed",
        json!({ "message_id": notice.id, "kind": message_kind::NOTICE, "content": notice.content, "run_id": run_id }),
    );
    pii_notice(state, visit.id, Some(run_id), prepared, visit.locale, sink).await?;
    emit(
        sink,
        "run.failed",
        json!({ "run_id": run_id, "code": code, "message": text }),
    );
    Ok(())
}

/// Recent chat as model messages: patient and assistant turns only, consecutive same-role turns merged,
/// starting with a patient turn (some providers refuse a conversation that opens with the assistant).
async fn history(db: &PgPool, visit_id: Uuid) -> sqlx::Result<Vec<ChatMessage>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        role: String,
        content: String,
    }
    let mut rows: Vec<Row> = sqlx::query_as("SELECT role, content FROM messages WHERE visit_id = $1 AND kind IN ('chat', 'refusal') ORDER BY created_at DESC, id DESC LIMIT $2").bind(visit_id).bind(HISTORY_LIMIT).fetch_all(db).await?;
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
    state: &AppState,
    visit: &Visit,
    run_id: Uuid,
    prepared: &Prepared,
    sink: &EventSink,
    counters: &mut RunCounters,
) -> Result<LoopDone, &'static str> {
    let db = &state.db;
    let cfg = &state.config;
    let locale = visit.locale;
    let db_fail = |e: sqlx::Error| {
        tracing::error!(error = %e, "database error in the model loop");
        "model_error"
    };

    let intake = visits::load_intake(db, visit.id).await.map_err(db_fail)?;
    let patient_text = visits::patient_text(db, visit.id).await.map_err(db_fail)?;
    let messages = history(db, visit.id).await.map_err(db_fail)?;
    let today = clock::format_date(state.clock.today());
    let system = prompt::system_prompt(&PromptContext {
        locale,
        stage: visit.stage,
        today: &today,
        intake: &intake,
    });
    let mut request = ChatRequest::new(messages)
        .with_system(system)
        .with_tools(tools::specs());

    let primary = state.ai.gateway(&cfg.model, Some(cfg.thinking));
    let fallback = cfg
        .model_fallback
        .as_deref()
        .map(|m| state.ai.gateway(m, None));
    let mut using_fallback = false;
    let day = state.clock.today();
    let mut ctx = ToolCtx {
        state,
        visit_id: visit.id,
        locale,
        model: &cfg.model,
        intake,
        stage: visit.stage,
        confirm_offered: visits::confirm_offered(db, visit.id)
            .await
            .map_err(db_fail)?,
        status: visit.status,
        patient_text,
        patient_message: prepared.text.clone(),
    };

    for step in 1..=cfg.max_steps as i32 {
        if limits::calls_today(db, &state.clock)
            .await
            .map_err(db_fail)?
            >= cfg.daily_model_call_limit
        {
            return Err("daily_budget_exceeded");
        }
        if let Some(client) = prepared.client
            && i64::from(state.limiter.client_calls(client, day)) >= cfg.per_ip_daily_call_limit
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
            let failure = match tokio::time::timeout(cfg.llm_timeout, gateway.chat(request.clone()))
                .await
            {
                Ok(Ok(reply)) => {
                    limits::record_call(
                        db,
                        &state.clock,
                        gateway.model_name(),
                        reply.input_tokens,
                        reply.output_tokens,
                        0.0,
                    )
                    .await
                    .map_err(db_fail)?;
                    counters.input_tokens += reply.input_tokens;
                    counters.output_tokens += reply.output_tokens;
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

        if reply.tool_calls.is_empty() {
            return finish_reply(
                state,
                visit,
                run_id,
                step,
                reply.text.unwrap_or_default(),
                &mut ctx,
                sink,
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
            emit(
                sink,
                "tool.started",
                json!({ "call_id": call_id, "step": step, "name": call.fn_name, "source": "model", "arguments": shown_args }),
            );
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
            emit(
                sink,
                "tool.completed",
                json!({ "call_id": call_id, "step": step, "name": call.fn_name, "status": outcome.status.as_str(), "result": outcome.stored_result, "duration_ms": outcome.duration_ms }),
            );
            if outcome.effects.intake_changed {
                emit(
                    sink,
                    "intake.updated",
                    serde_json::to_value(ctx.intake.view(ctx.stage)).unwrap_or(Value::Null),
                );
            }
            if let Some(ticket) = &outcome.effects.ticket {
                emit(
                    sink,
                    "ticket.created",
                    serde_json::to_value(ticket).unwrap_or(Value::Null),
                );
            }
            if let Some(summary) = &outcome.effects.summary {
                emit(
                    sink,
                    "summary.updated",
                    serde_json::to_value(summary).unwrap_or(Value::Null),
                );
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
    state: &AppState,
    visit: &Visit,
    run_id: Uuid,
    step: i32,
    raw: String,
    ctx: &mut ToolCtx<'_>,
    sink: &EventSink,
) -> Result<LoopDone, &'static str> {
    let db = &state.db;
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
    visits::record_tool_call(
        db,
        visits::NewToolCall {
            id: None,
            visit_id: visit.id,
            run_id: Some(run_id),
            step,
            name: "output_guard",
            source: ToolSource::Code.as_str(),
            status: if sanitized.violations.is_empty() {
                ToolStatus::Ok.as_str()
            } else {
                ToolStatus::Rejected.as_str()
            },
            arguments: &json!({ "chars": text.chars().count() }),
            result: &json!({ "passed": sanitized.violations.is_empty(), "violations": violations, "action": sanitized.action.as_str() }),
            duration_ms: 0,
        },
    )
    .await
    .map_err(db_fail)?;
    if sanitized.action != GuardAction::None {
        for violation in &violations {
            visits::insert_guard_event(db, visit.id, run_id, violation, sanitized.action.as_str())
                .await
                .map_err(db_fail)?;
        }
        emit(
            sink,
            "guard.rewrote",
            json!({ "kind": violations.first().copied().unwrap_or("other"), "action": sanitized.action.as_str() }),
        );
    }

    let final_text = sanitized.text;
    emit(sink, "message.delta", json!({ "text": final_text }));
    let message = visits::insert_message(
        db,
        visit.id,
        "assistant",
        message_kind::CHAT,
        &final_text,
        Some(run_id),
    )
    .await
    .map_err(db_fail)?;
    visits::touch(db, visit.id).await.map_err(db_fail)?;
    if ctx.stage == Stage::Confirm {
        visits::mark_confirm_offered(db, visit.id)
            .await
            .map_err(db_fail)?;
    }
    emit(
        sink,
        "message.completed",
        json!({ "message_id": message.id, "kind": message_kind::CHAT, "content": message.content, "run_id": run_id }),
    );
    Ok(LoopDone)
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
