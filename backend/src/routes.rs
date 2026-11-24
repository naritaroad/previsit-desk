//! HTTP routes (docs/api/contract.md) and the SSE stream. Handlers stay thin: they validate, rate-limit,
//! and call the engine, visits, tickets and tools modules.

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::Path as FsPath;
use std::time::Duration;

use axum::extract::{Path, Query, Request, State};
use axum::http::header::{ACCEPT_LANGUAGE, CACHE_CONTROL, HeaderName};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_stream::wrappers::UnboundedReceiverStream;
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use uuid::Uuid;

use crate::auth::{self, ClinicianUser};
use crate::clock::format_date;
use crate::engine::{self, StreamEvent};
use crate::error::{AppError, AppResult, REQUEST_LOCALE};
use crate::http::{ApiJson, ClientId, OptionalJson};
use crate::limits::{self, Bucket};
use crate::pii;
use crate::refill::RefillInput;
use crate::state::AppState;
use crate::summary::{self, SummaryInput};
use crate::texts::{self, T, t};
use crate::tickets::{self, NewTicket, ResolveError};
use crate::tools;
use crate::types::{
    CreatedBy, Locale, TicketReason, ToolSource, ToolStatus, Urgency, Visit, VisitStatus,
    message_kind,
};
use crate::visits::{self, Projection, ReviewError};

const MAX_BODY_BYTES: usize = 32 * 1024;
const SSE_KEEP_ALIVE: Duration = Duration::from_secs(15);

fn parse_id(text: &str) -> AppResult<Uuid> {
    Uuid::parse_str(text).map_err(|_| AppError::NotFound)
}

fn rate_limited(retry_after: u64) -> AppError {
    AppError::RateLimited { retry_after }
}

fn check_rate(state: &AppState, bucket: Bucket, client: limits::ClientKey) -> AppResult<()> {
    let max = match bucket {
        Bucket::Visits => state.config.rate_visits_per_10min,
        Bucket::Messages | Bucket::Actions => state.config.rate_messages_per_10min,
        // Reads are cheap but must not allow enumerating ids.
        Bucket::Reads => state.config.rate_messages_per_10min.saturating_mul(10),
        Bucket::Login => 10,
    };
    state
        .limiter
        .check(bucket, client, max)
        .map_err(rate_limited)
}

async fn load_visit(state: &AppState, id: Uuid) -> AppResult<Visit> {
    let cutoff = state.clock.retention_cutoff(state.config.retention_days);
    visits::fetch(&state.db, id, cutoff)
        .await?
        .ok_or(AppError::NotFound)
}

// ---------------------------------------------------------------------------
// Health and meta
// ---------------------------------------------------------------------------

async fn health(State(state): State<AppState>) -> Response {
    // Never touches the model: the database answer is what the deployment health check needs.
    match sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.db).await {
        Ok(_) => Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION"), "model_ready": state.config.model_ready() })).into_response(),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "ok": false }))).into_response(),
    }
}

fn eval_summary(data_dir: &FsPath) -> Value {
    let path = data_dir.join("eval").join("results").join("summary.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Value::Null;
    };
    match serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) {
        Ok(Value::Object(mut map)) => {
            map.remove("cases");
            Value::Object(map)
        }
        _ => Value::Null,
    }
}

async fn meta(State(state): State<AppState>) -> Json<Value> {
    let calls = limits::calls_today(&state.db, &state.clock)
        .await
        .unwrap_or(0);
    Json(json!({
        "app": "PreVisit Desk",
        "version": env!("CARGO_PKG_VERSION"),
        "models": { "primary": state.config.model, "fallback": state.config.model_fallback },
        "retention_days": state.config.retention_days,
        "max_message_chars": state.config.max_message_chars,
        "daily_limit_reached": calls >= state.config.daily_model_call_limit,
        "server_today": format_date(state.clock.today()),
        "eval": eval_summary(&state.config.data_dir),
    }))
}

// ---------------------------------------------------------------------------
// Patient endpoints
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct CreateVisit {
    locale: Option<String>,
}

async fn create_visit(
    State(state): State<AppState>,
    ClientId(client): ClientId,
    OptionalJson(body): OptionalJson<CreateVisit>,
) -> AppResult<(StatusCode, Json<Value>)> {
    check_rate(&state, Bucket::Visits, client)?;
    let locale = match body.locale.as_deref() {
        None => Locale::ZhTw,
        Some(text) => Locale::parse(text)
            .ok_or_else(|| AppError::field("locale", t(T::FieldErrChoice, Locale::ZhTw)))?,
    };
    let (visit, opening) = visits::create(&state.db, locale).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "visit": visit, "messages": [opening] })),
    ))
}

async fn get_visit(
    State(state): State<AppState>,
    ClientId(client): ClientId,
    Path(id): Path<String>,
) -> AppResult<Json<visits::VisitDetail>> {
    check_rate(&state, Bucket::Reads, client)?;
    let visit = load_visit(&state, parse_id(&id)?).await?;
    Ok(Json(
        visits::build_detail(&state.db, &state.rules, visit, Projection::Patient).await?,
    ))
}

#[derive(Deserialize)]
struct PostMessage {
    content: String,
}

fn sse_event(seq: u64, event: StreamEvent) -> Event {
    let payload = json!({ "v": 1, "seq": seq, "type": event.kind, "data": event.data });
    Event::default().event(event.kind).data(payload.to_string())
}

async fn post_message(
    State(state): State<AppState>,
    ClientId(client): ClientId,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<PostMessage>,
) -> AppResult<Response> {
    let id = parse_id(&id)?;
    let visit = load_visit(&state, id).await?;
    let locale = visit.locale;
    check_rate(&state, Bucket::Messages, client)?;

    let content = body.content.trim().to_string();
    let length = content.chars().count();
    if length == 0 || length > state.config.max_message_chars {
        return Err(
            AppError::field("content", format!("1–{}", state.config.max_message_chars))
                .localized(locale),
        );
    }
    // One message at a time per visit; the guard moves into the task and is released when the turn ends.
    let guard = state
        .visit_locks
        .try_acquire(id)
        .ok_or_else(|| AppError::Conflict.localized(locale))?;
    let prepared = engine::prepare(&state.rules, &content);
    if engine::is_closed(&visit) && prepared.red_flag.is_none() {
        return Err(AppError::VisitClosed.localized(locale));
    }

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();
    let task_state = state.clone();
    tokio::spawn(async move {
        let _guard = guard;
        if let Err(error) = engine::run_turn(&task_state, id, prepared, &tx).await {
            tracing::error!(error = %error, "turn failed");
            let _ = tx.send(StreamEvent { kind: "run.failed", data: json!({ "run_id": Value::Null, "code": "model_error", "message": t(T::NoticeModelError, locale) }) });
        }
    });

    let stream = UnboundedReceiverStream::new(rx)
        .enumerate()
        .map(|(i, event)| Ok::<Event, Infallible>(sse_event(i as u64 + 1, event)));
    let mut response = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(SSE_KEEP_ALIVE).text("keep-alive"))
        .into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    Ok(response)
}

async fn refill_check(
    State(state): State<AppState>,
    ClientId(client): ClientId,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Value>,
) -> AppResult<Json<Value>> {
    check_rate(&state, Bucket::Actions, client)?;
    let visit = load_visit(&state, parse_id(&id)?).await?;
    let locale = visit.locale;
    let input = RefillInput::from_json(&body, true, locale)
        .map_err(|fields| AppError::Unprocessable(fields).localized(locale))?;
    let started = std::time::Instant::now();
    let run = tools::perform_refill_check(&state, visit.id, locale, &input, CreatedBy::Form)
        .await?
        .map_err(|fields| AppError::Unprocessable(fields).localized(locale))?;
    let (args, result) = (
        serde_json::to_value(&input).unwrap_or(Value::Null),
        serde_json::to_value(&run.result).unwrap_or(Value::Null),
    );
    visits::record_tool_call(
        &state.db,
        visits::NewToolCall {
            id: None,
            visit_id: visit.id,
            run_id: None,
            step: 0,
            name: "check_chronic_refill",
            source: ToolSource::Form.as_str(),
            status: ToolStatus::Ok.as_str(),
            arguments: &args,
            result: &result,
            duration_ms: started.elapsed().as_millis() as i32,
        },
    )
    .await?;
    Ok(Json(json!({ "result": run.result })))
}

async fn submit(
    State(state): State<AppState>,
    ClientId(client): ClientId,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    check_rate(&state, Bucket::Actions, client)?;
    let visit = load_visit(&state, parse_id(&id)?).await?;
    let locale = visit.locale;
    // Idempotent: a closed visit, or one that already has its summary, returns what is there.
    let existing = summary::load(&state.db, visit.id).await?;
    let mut summary = match existing {
        Some(summary) => summary,
        None => {
            let intake = visits::load_intake(&state.db, visit.id).await?;
            let flags =
                visits::triggered_flags(&state.db, &state.rules.red_flags, visit.id, locale)
                    .await?;
            let refill = visits::latest_refill(&state.db, visit.id).await?;
            let built = summary::build(SummaryInput {
                visit_id: visit.id,
                intake: &intake,
                locale,
                flags,
                refill,
                narrative: None,
                model: None,
                now: state.clock.now(),
            });
            summary::save(&state.db, &built).await?;
            built
        }
    };
    if matches!(visit.status, VisitStatus::Active | VisitStatus::RedFlag)
        && visit.stage != crate::types::Stage::Done
    {
        visits::finalize_submit(&state.db, visit.id).await?;
    }
    summary.refill = visits::latest_refill(&state.db, visit.id).await?;
    let visit = load_visit(&state, visit.id).await?;
    Ok(Json(json!({ "visit": visit, "summary": summary })))
}

#[derive(Deserialize, Default)]
struct HandoffBody {
    reason: Option<String>,
    note: Option<String>,
}

async fn handoff(
    State(state): State<AppState>,
    ClientId(client): ClientId,
    Path(id): Path<String>,
    OptionalJson(body): OptionalJson<HandoffBody>,
) -> AppResult<(StatusCode, Json<Value>)> {
    check_rate(&state, Bucket::Actions, client)?;
    let visit = load_visit(&state, parse_id(&id)?).await?;
    let locale = visit.locale;
    let note = body
        .note
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    if note.is_some_and(|n| n.chars().count() > 300) {
        return Err(AppError::field("note", "≤ 300").localized(locale));
    }
    // The note gets the same screens as a chat message: mask personal data, then the red-flag rules.
    let masked = note.map(pii::mask);
    let note_text = masked.as_ref().map(|m| m.text.clone());
    let mut red_flag = None;
    if let Some(text) = &note_text
        && let Some(matched) = state.rules.red_flags.check(text)
    {
        let reply = visits::insert_message(
            &state.db,
            visit.id,
            "assistant",
            message_kind::RED_FLAG,
            &texts::red_flag_reply(matched.category, locale),
            None,
        )
        .await?;
        visits::insert_red_flag_event(
            &state.db,
            visit.id,
            reply.id,
            matched.category,
            &matched.rule_id,
        )
        .await?;
        let summary_text = texts::fmt(
            T::TicketRedFlag,
            locale,
            &[("label", matched.label(locale)), ("rule", &matched.rule_id)],
        );
        tickets::create_or_get(
            &state.db,
            &state.clock,
            NewTicket {
                visit_id: visit.id,
                reason: TicketReason::RedFlag,
                urgency: Urgency::Urgent,
                summary: &summary_text,
                created_by: CreatedBy::Code,
            },
        )
        .await?;
        visits::set_status(&state.db, visit.id, VisitStatus::RedFlag).await?;
        red_flag =
            visits::latest_red_flag(&state.db, &state.rules.red_flags, visit.id, locale).await?;
    }
    let reason = body
        .reason
        .as_deref()
        .and_then(TicketReason::parse)
        .filter(|r| *r != TicketReason::RedFlag)
        .unwrap_or(TicketReason::PatientRequest);
    let mut summary_text = t(T::TicketPatientRequest, locale).to_string();
    if let Some(note) = &note_text {
        summary_text.push_str(&texts::fmt(T::TicketNote, locale, &[("note", note)]));
    }
    let created = tickets::create_or_get(
        &state.db,
        &state.clock,
        NewTicket {
            visit_id: visit.id,
            reason,
            urgency: Urgency::Routine,
            summary: &summary_text,
            created_by: CreatedBy::Form,
        },
    )
    .await?;
    visits::touch(&state.db, visit.id).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "ticket": created.ticket, "deduped": created.deduped, "red_flag": red_flag })),
    ))
}

// ---------------------------------------------------------------------------
// Clinician endpoints
// ---------------------------------------------------------------------------

async fn clinician_visits(
    State(state): State<AppState>,
    _user: ClinicianUser,
    Query(params): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let status = params
        .get("status")
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("pending");
    if ![
        "pending",
        "submitted",
        "red_flag",
        "reviewed",
        "active",
        "all",
    ]
    .contains(&status)
    {
        return Err(AppError::field(
            "status",
            t(T::FieldErrChoice, Locale::ZhTw),
        ));
    }
    let limit = match params.get("limit").filter(|l| !l.is_empty()) {
        None => 50,
        Some(text) => text
            .parse::<i64>()
            .ok()
            .filter(|n| *n >= 1)
            .ok_or_else(|| AppError::field("limit", t(T::FieldErrPositive, Locale::ZhTw)))?
            .min(200),
    };
    let items = visits::list_for_clinician(
        &state.db,
        &state.rules.red_flags,
        status,
        params.get("q").map(String::as_str),
        limit,
    )
    .await?;
    Ok(Json(json!({ "items": items })))
}

async fn clinician_visit(
    State(state): State<AppState>,
    _user: ClinicianUser,
    Path(id): Path<String>,
) -> AppResult<Json<visits::VisitDetail>> {
    let visit = load_visit(&state, parse_id(&id)?).await?;
    Ok(Json(
        visits::build_detail(&state.db, &state.rules, visit, Projection::Clinician).await?,
    ))
}

#[derive(Deserialize, Default)]
struct NoteBody {
    note: Option<String>,
}

fn clean_note(note: Option<String>) -> AppResult<Option<String>> {
    let note = note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    if note.as_deref().is_some_and(|n| n.chars().count() > 500) {
        return Err(AppError::field("note", "≤ 500"));
    }
    Ok(note)
}

async fn review_visit(
    State(state): State<AppState>,
    user: ClinicianUser,
    Path(id): Path<String>,
    OptionalJson(body): OptionalJson<NoteBody>,
) -> AppResult<Json<Value>> {
    let id = parse_id(&id)?;
    let note = clean_note(body.note)?;
    match visits::review(&state.db, id, &user.display_name, note.as_deref()).await {
        Ok(()) => {}
        Err(ReviewError::NotFound) => return Err(AppError::NotFound),
        Err(ReviewError::InvalidState) => {
            return Err(AppError::InvalidState(
                "only submitted or red-flag visits can be reviewed",
            ));
        }
        Err(ReviewError::Db(e)) => return Err(e.into()),
    }
    let visit = load_visit(&state, id).await?;
    Ok(Json(json!({ "visit": visit })))
}

async fn clinician_tickets(
    State(state): State<AppState>,
    _user: ClinicianUser,
    Query(params): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let status = params
        .get("status")
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("open");
    if !["open", "resolved", "all"].contains(&status) {
        return Err(AppError::field(
            "status",
            t(T::FieldErrChoice, Locale::ZhTw),
        ));
    }
    Ok(Json(
        json!({ "items": tickets::list(&state.db, status).await? }),
    ))
}

async fn resolve_ticket(
    State(state): State<AppState>,
    user: ClinicianUser,
    Path(id): Path<String>,
    OptionalJson(body): OptionalJson<NoteBody>,
) -> AppResult<Json<Value>> {
    let id = parse_id(&id)?;
    let note = clean_note(body.note)?;
    match tickets::resolve(&state.db, id, &user.display_name, note.as_deref()).await {
        Ok(ticket) => Ok(Json(json!({ "ticket": ticket }))),
        Err(ResolveError::NotFound) => Err(AppError::NotFound),
        Err(ResolveError::AlreadyResolved) => {
            Err(AppError::InvalidState("the ticket is already resolved"))
        }
        Err(ResolveError::Db(e)) => Err(e.into()),
    }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

async fn not_found() -> AppError {
    AppError::NotFound
}

/// Puts the request's `Accept-Language` into the task-local that error messages read.
async fn request_locale(req: Request, next: Next) -> Response {
    let locale = req
        .headers()
        .get(ACCEPT_LANGUAGE)
        .and_then(|v| v.to_str().ok())
        .map(Locale::from_accept_language)
        .unwrap_or(Locale::ZhTw);
    REQUEST_LOCALE.scope(locale, next.run(req)).await
}

fn api_router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/meta", get(meta))
        .route("/visits", post(create_visit))
        .route("/visits/{id}", get(get_visit))
        .route("/visits/{id}/messages", post(post_message))
        .route("/visits/{id}/refill-check", post(refill_check))
        .route("/visits/{id}/submit", post(submit))
        .route("/visits/{id}/handoff", post(handoff))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        .route("/clinician/visits", get(clinician_visits))
        .route("/clinician/visits/{id}", get(clinician_visit))
        .route("/clinician/visits/{id}/review", post(review_visit))
        .route("/clinician/tickets", get(clinician_tickets))
        .route("/clinician/tickets/{id}/resolve", post(resolve_ticket))
        .fallback(any(not_found))
        .layer(middleware::from_fn(request_locale))
}

pub fn app(state: AppState) -> Router {
    let mut router = Router::new().nest("/api/v1", api_router()).route(
        "/api/{*rest}",
        any(not_found).layer(middleware::from_fn(request_locale)),
    );
    if let Some(dir) = state.config.web_dir.clone() {
        // Single-page app: unknown paths get index.html so client routes survive a reload.
        router = router
            .fallback_service(ServeDir::new(&dir).fallback(ServeFile::new(dir.join("index.html"))));
    }
    router
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("x-frame-options"),
            HeaderValue::from_static("DENY"),
        ))
        .layer(CompressionLayer::new())
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bad_ids_are_not_found() {
        assert!(matches!(parse_id("nope"), Err(AppError::NotFound)));
        assert!(parse_id("9b2f6a3e-7f1d-4c52-9a34-0d6f1e2b3c4d").is_ok());
    }

    #[test]
    fn notes_are_trimmed_and_capped() {
        assert_eq!(
            clean_note(Some("  ok  ".into())).expect("note"),
            Some("ok".to_string())
        );
        assert_eq!(clean_note(Some("   ".into())).expect("note"), None);
        assert!(clean_note(Some("字".repeat(501))).is_err());
        assert!(clean_note(Some("字".repeat(500))).is_ok());
    }

    #[test]
    fn eval_summary_reads_the_file_and_drops_per_case_rows() {
        let dir = std::env::temp_dir().join(format!("previsit-meta-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("eval").join("results")).expect("dirs");
        assert_eq!(eval_summary(&dir), Value::Null);
        std::fs::write(dir.join("eval").join("results").join("summary.json"), r#"{"ran_at":"x","model":"m","total":2,"passed":1,"categories":[],"cases":[{"id":"A"}]}"#).expect("write");
        let value = eval_summary(&dir);
        assert_eq!(value["total"], 2);
        assert!(value.get("cases").is_none());
        std::fs::write(
            dir.join("eval").join("results").join("summary.json"),
            "not json",
        )
        .expect("write");
        assert_eq!(eval_summary(&dir), Value::Null);
        let _ = std::fs::remove_dir_all(dir);
    }
}
