//! Visit endpoints (contract §3, §5): the patient's own visits, the event stream, and what staff do in the thread.
//!
//! Access rule used by every handler here: a patient reaches only their own visits (others are 404, so ids cannot be
//! probed); staff need the named permission, and each read of a patient's visit goes into `access_log`.

use std::collections::BTreeMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::audit::{self, AuditKind};
use crate::auth::CurrentUser;
use crate::engine::{self, Turn};
use crate::error::{AppError, AppResult};
use crate::events::{self, Follower, NewMessage};
use crate::http::{ApiJson, ClientId, OptionalJson};
use crate::idem::{self, IdempotencyKey};
use crate::intake::{IntakeState, SetError};
use crate::limits::{Bucket, ClientKey};
use crate::notify;
use crate::page::{self, Cursor, Page, Params};
use crate::perm::{Permission, Role};
use crate::refill::RefillInput;
use crate::sse;
use crate::state::AppState;
use crate::summary::{self, SummaryInput};
use crate::texts::{self, T, fmt, t};
use crate::tickets::{self, NewTicket};
use crate::types::{
    CreatedBy, Locale, Message, Stage, TicketReason, ToolSource, ToolStatus, Urgency, Visit,
    VisitMode, VisitStatus, message_kind,
};
use crate::visits::{self, NewVisit, VisitDetail, VisitView, visit_cols, visits_with_urgency};
use crate::{people, pii, tools};

const STAFF_MESSAGE_MAX_CHARS: usize = 1000;

fn rate_limited(retry_after: u64) -> AppError {
    AppError::RateLimited { retry_after }
}

fn check_rate(state: &AppState, bucket: Bucket, client: ClientKey) -> AppResult<()> {
    let limits = &state.settings.get().limits;
    let max = match bucket {
        Bucket::Visits => limits.visits_per_10min,
        _ => limits.messages_per_10min,
    };
    state
        .limiter
        .check(bucket, client, max.max(1) as u32)
        .map_err(rate_limited)
}

pub fn parse_id(text: &str) -> AppResult<Uuid> {
    Uuid::parse_str(text).map_err(|_| AppError::NotFound)
}

async fn fetch(state: &AppState, id: &str) -> AppResult<Visit> {
    visits::fetch(&state.db, parse_id(id)?, visits::retention_cutoff(state))
        .await?
        .ok_or(AppError::NotFound)
}

/// The patient's own visit.
async fn own_visit(state: &AppState, user: &CurrentUser, id: &str) -> AppResult<Visit> {
    user.require(Permission::VisitOwn)?;
    let visit = fetch(state, id).await?;
    if visit.patient_id != Some(user.id) {
        return Err(AppError::NotFound);
    }
    Ok(visit)
}

/// A visit for staff who hold `permission`; the read is logged under `resource`.
pub async fn staff_visit(
    state: &AppState,
    user: &CurrentUser,
    id: &str,
    permission: Permission,
    resource: &str,
) -> AppResult<Visit> {
    user.require(permission)?;
    // Pharmacists hold thread.reply for rx threads; a visit needs visit.read as well.
    user.require(Permission::VisitRead)?;
    let visit = fetch(state, id).await?;
    audit::log_access(
        &state.db,
        user,
        visit.patient_id,
        "read",
        resource,
        &visit.id.to_string(),
    )
    .await?;
    Ok(visit)
}

/// Owner or staff reader.
async fn readable_visit(state: &AppState, user: &CurrentUser, id: &str) -> AppResult<Visit> {
    if user.is_patient() {
        own_visit(state, user, id).await
    } else {
        staff_visit(state, user, id, Permission::VisitRead, "visit").await
    }
}

async fn view(state: &AppState, user: &CurrentUser, id: Uuid) -> AppResult<VisitView> {
    let visit = visits::fetch(&state.db, id, time::OffsetDateTime::UNIX_EPOCH)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(visits::view_one(&state.db, visit, Some(user), user.locale).await?)
}

// ---------------------------------------------------------------------------
// List, create, read, change, delete
// ---------------------------------------------------------------------------

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Params>,
) -> AppResult<Json<Page<VisitView>>> {
    let own = if user.is_patient() {
        user.require(Permission::VisitOwn)?;
        Some(user.id)
    } else {
        user.require(Permission::VisitRead)?;
        None
    };
    let patient = match (own, page::param(&params, "patient_id")) {
        (Some(id), _) => Some(id),
        (None, Some(text)) => Some(parse_id(text)?),
        (None, None) => None,
    };
    if let (None, Some(patient)) = (own, patient) {
        audit::log_access(
            &state.db,
            &user,
            Some(patient),
            "list",
            "visits",
            &patient.to_string(),
        )
        .await?;
    }
    let status = page::param(&params, "status").filter(|s| *s != "all");
    if status.is_some_and(|s| VisitStatus::parse(s).is_none()) {
        return Err(AppError::field("status", t(T::FieldErrChoice, user.locale)));
    }
    let archived = match page::param(&params, "archived") {
        None | Some("false") => Some(false),
        Some("true") => Some(true),
        Some("all") => None,
        Some(_) => {
            return Err(AppError::field(
                "archived",
                t(T::FieldErrChoice, user.locale),
            ));
        }
    };
    // Archiving is the patient's own tidying; staff see every visit unless they filter.
    let archived = if own.is_none() && page::param(&params, "archived").is_none() {
        None
    } else {
        archived
    };
    let limit = page::limit(&params)?;
    let cursor = page::cursor(&params)?;
    // Pinned visits come first, on the first page only; the cursor then walks the rest by activity.
    let rows: Vec<Visit> = sqlx::query_as(concat!(
        "SELECT ",
        visit_cols!(),
        " FROM ",
        visits_with_urgency!(),
        " v WHERE ($1::uuid IS NULL OR v.patient_id = $1) AND ($2::text IS NULL OR v.status = $2) AND ($3::boolean IS NULL OR v.archived = $3)
           AND ($4::text IS NULL OR v.title ILIKE $4 ESCAPE '\\' OR v.chief_complaint ILIKE $4 ESCAPE '\\')
           AND (v.last_activity_at >= $5 OR v.is_demo)
           AND ($6::timestamptz IS NULL OR (v.last_activity_at, v.id) < ($6, $7))
         ORDER BY v.last_activity_at DESC, v.id DESC LIMIT $8"
    ))
    .bind(patient)
    .bind(status)
    .bind(archived)
    .bind(page::like(&params))
    .bind(visits::retention_cutoff(&state))
    .bind(cursor.map(|c| c.at))
    .bind(cursor.map(|c| c.id))
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let cut = page::cut(rows, limit, |v| Cursor {
        at: v.last_activity_at,
        id: v.id,
    });
    let mut items = visits::views(&state.db, cut.items, Some(&user), user.locale).await?;
    items.sort_by_key(|v| !v.pinned);
    Ok(Json(Page {
        items,
        next_cursor: cut.next_cursor,
        total: None,
    }))
}

#[derive(Deserialize, Default)]
pub struct CreateVisit {
    locale: Option<String>,
    appointment_id: Option<Uuid>,
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(client): ClientId,
    key: IdempotencyKey,
    OptionalJson(body): OptionalJson<CreateVisit>,
) -> AppResult<Response> {
    user.require(Permission::VisitOwn)?;
    idem::run(&state, user.id, key, "POST /visits", || async {
        check_rate(&state, Bucket::Visits, client)?;
        let locale = match body.locale.as_deref() {
            None => user.locale,
            Some(text) => Locale::parse(text)
                .ok_or_else(|| AppError::field("locale", t(T::FieldErrChoice, user.locale)))?,
        };
        if let Some(appointment) = body.appointment_id {
            let own: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM appointments WHERE id = $1 AND patient_id = $2 AND status IN ('booked', 'checked_in'))")
                .bind(appointment)
                .bind(user.id)
                .fetch_one(&state.db)
                .await?;
            if !own {
                return Err(AppError::field(
                    "appointment_id",
                    t(T::FieldErrChoice, user.locale),
                ));
            }
            // One pre-visit per appointment: asking again opens the one that exists.
            let existing: Option<Uuid> =
                sqlx::query_scalar("SELECT id FROM visits WHERE appointment_id = $1")
                    .bind(appointment)
                    .fetch_optional(&state.db)
                    .await?;
            if let Some(id) = existing
                && let Some(visit) =
                    visits::fetch(&state.db, id, visits::retention_cutoff(&state)).await?
            {
                return Ok((StatusCode::OK, detail_json(&state, &user, visit).await?));
            }
        }
        let visit = visits::create(
            &state,
            NewVisit {
                locale,
                patient_id: Some(user.id),
                appointment_id: body.appointment_id,
            },
        )
        .await?;
        visits::changed(&state, visit.id, Some(user.id), false);
        Ok((StatusCode::CREATED, detail_json(&state, &user, visit).await?))
    })
    .await
}

async fn detail_json(state: &AppState, user: &CurrentUser, visit: Visit) -> AppResult<Value> {
    let detail = visits::build_detail(state, visit, Some(user)).await?;
    Ok(serde_json::to_value(detail).map_err(anyhow::Error::from)?)
}

pub async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<VisitDetail>> {
    let visit = readable_visit(&state, &user, &id).await?;
    // Opening it is reading it.
    events::mark_read(&state.db, visit.id, user.id, visit.last_seq).await?;
    Ok(Json(
        visits::build_detail(&state, visit, Some(&user)).await?,
    ))
}

#[derive(Deserialize)]
pub struct PatchVisit {
    title: Option<String>,
    pinned: Option<bool>,
    archived: Option<bool>,
}

pub async fn patch(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<PatchVisit>,
) -> AppResult<Json<VisitView>> {
    let visit = own_visit(&state, &user, &id).await?;
    let title = body.title.map(|title| {
        pii::mask(
            title
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .as_str(),
        )
        .text
    });
    if title
        .as_deref()
        .is_some_and(|title| !(1..=60).contains(&title.chars().count()))
    {
        return Err(AppError::field(
            "title",
            fmt(
                T::FieldErrLength,
                user.locale,
                &[("min", "1"), ("max", "60")],
            ),
        ));
    }
    sqlx::query(
        "UPDATE visits SET title = COALESCE($2, title), title_custom = title_custom OR $2 IS NOT NULL, pinned = COALESCE($3, pinned), archived = COALESCE($4, archived), updated_at = now() WHERE id = $1",
    )
    .bind(visit.id)
    .bind(title)
    .bind(body.pinned)
    .bind(body.archived)
    .execute(&state.db)
    .await?;
    visits::emit_updated(&state, visit.id).await?;
    Ok(Json(view(&state, &user, visit.id).await?))
}

/// A patient may delete their visit unless it is part of the clinical record (a signed note) or someone is being
/// asked to act on it urgently.
pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let visit = own_visit(&state, &user, &id).await?;
    let locked: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM clinical_notes WHERE visit_id = $1 AND status = 'signed')
             OR EXISTS (SELECT 1 FROM clinician_tickets WHERE visit_id = $1 AND status = 'open' AND urgency = 'urgent')",
    )
    .bind(visit.id)
    .fetch_one(&state.db)
    .await?;
    if locked {
        return Err(AppError::InvalidState(
            "a signed note or an open urgent ticket keeps the visit",
        ));
    }
    sqlx::query("DELETE FROM visits WHERE id = $1")
        .bind(visit.id)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM drafts WHERE account_id = $1 AND scope LIKE $2")
        .bind(user.id)
        .bind(format!("visit:{}:%", visit.id))
        .execute(&state.db)
        .await?;
    visits::changed(&state, visit.id, visit.patient_id, true);
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Messages and the stream
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct PostMessage {
    content: String,
    client_id: String,
}

fn clean_client_id(text: &str, locale: Locale) -> AppResult<String> {
    let id = text.trim();
    let ok = (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_:.".contains(&b));
    if ok {
        Ok(id.to_string())
    } else {
        Err(AppError::field("client_id", t(T::FieldErrChoice, locale)))
    }
}

fn is_unique_violation(error: &AppError) -> bool {
    matches!(error, AppError::Database(sqlx::Error::Database(e)) if e.is_unique_violation())
}

/// The answer to a message that was already accepted under this `client_id`.
async fn repeated(
    state: &AppState,
    visit_id: Uuid,
    client_id: &str,
    locale: Locale,
) -> AppResult<Option<Response>> {
    let Some(message) =
        visits::message_by_client_id(&state.db, visit_id, client_id, locale).await?
    else {
        return Ok(None);
    };
    let run_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM runs WHERE message_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(message.id)
    .fetch_optional(&state.db)
    .await?;
    Ok(Some(
        Json(json!({ "message": message, "run_id": run_id })).into_response(),
    ))
}

fn accepted(message: &Message, run_id: Option<Uuid>) -> Response {
    (
        StatusCode::ACCEPTED,
        Json(json!({ "message": message, "run_id": run_id })),
    )
        .into_response()
}

/// Stores the message and answers 202; the reply arrives on the stream. The red-flag rules run here, on every message,
/// in every status and mode, and a red flag never waits for a running turn.
pub async fn post_message(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(client): ClientId,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<PostMessage>,
) -> AppResult<Response> {
    let visit = own_visit(&state, &user, &id).await?;
    let locale = user.locale;
    let client_id = clean_client_id(&body.client_id, locale)?;
    if let Some(response) = repeated(&state, visit.id, &client_id, locale).await? {
        return Ok(response);
    }
    check_rate(&state, Bucket::Messages, client)?;
    let content = body.content.trim();
    let length = content.chars().count();
    if length == 0 || length > state.config.max_message_chars {
        return Err(AppError::field(
            "content",
            fmt(
                T::FieldErrLength,
                locale,
                &[
                    ("min", "1"),
                    ("max", &state.config.max_message_chars.to_string()),
                ],
            ),
        ));
    }
    let mut prepared = engine::prepare(&state.rules, content);
    prepared.client = Some(client);
    let flagged = prepared.red_flag.is_some();
    let guard = state.visit_locks.try_acquire(visit.id);
    if guard.is_none() && !flagged {
        return Err(AppError::Conflict);
    }
    // Read again under the lock: a turn may have just submitted the visit.
    let visit = own_visit(&state, &user, &id).await?;
    let human = visit.mode == VisitMode::Human;
    if engine::is_closed(&visit) && !flagged && !human {
        return Err(AppError::VisitClosed);
    }
    let message = match engine::accept(
        &state,
        &visit,
        &prepared,
        Some(user.id),
        Some(&client_id),
        None,
    )
    .await
    {
        Ok(message) => message,
        Err(error) if is_unique_violation(&error) => {
            return repeated(&state, visit.id, &client_id, locale)
                .await?
                .ok_or(AppError::Conflict);
        }
        Err(error) => return Err(error),
    };
    events::mark_read(&state.db, visit.id, user.id, message.seq).await?;
    visits::changed(&state, visit.id, visit.patient_id, human);
    if human && !flagged {
        if prepared.pii_count > 0 {
            visits::assistant_message(
                &state,
                visit.id,
                visit.locale,
                message_kind::NOTICE,
                t(T::NoticePii, visit.locale),
                None,
            )
            .await?;
        }
        return Ok(accepted(&message, None));
    }
    let run_id = engine::start_run(&state, visit.id, message.id).await?;
    engine::spawn_respond(
        &state,
        Turn {
            visit_id: visit.id,
            run_id,
            message_id: message.id,
            prepared,
        },
        guard,
    );
    Ok(accepted(&message, Some(run_id)))
}

/// Runs the last patient message again when its turn failed or was cut off.
pub async fn retry(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(client): ClientId,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let visit = own_visit(&state, &user, &id).await?;
    check_rate(&state, Bucket::Messages, client)?;
    let guard = state
        .visit_locks
        .try_acquire(visit.id)
        .ok_or(AppError::Conflict)?;
    let nothing = AppError::InvalidState("no failed or interrupted turn to retry");
    let Some(mut message) = visits::last_patient_message(&state.db, visit.id, user.locale).await?
    else {
        return Err(nothing);
    };
    let last: Option<String> = sqlx::query_scalar(
        "SELECT status FROM runs WHERE message_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(message.id)
    .fetch_optional(&state.db)
    .await?;
    let retryable = message.status == "interrupted"
        || matches!(last.as_deref(), Some("failed" | "interrupted"));
    if !retryable || visit.mode == VisitMode::Human || engine::is_closed(&visit) {
        return Err(nothing);
    }
    visits::set_message_status(&state.db, message.id, "ok").await?;
    message.status = "ok".into();
    // The stored text is already masked, so nothing is masked (or announced) twice.
    let mut prepared = engine::prepare(&state.rules, &message.content);
    prepared.client = Some(client);
    prepared.pii_count = 0;
    let run_id = engine::start_run(&state, visit.id, message.id).await?;
    engine::spawn_respond(
        &state,
        Turn {
            visit_id: visit.id,
            run_id,
            message_id: message.id,
            prepared,
        },
        Some(guard),
    );
    Ok(accepted(&message, Some(run_id)))
}

/// Replays events after `after` (or `Last-Event-ID`, whichever is later), then follows.
pub async fn stream(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let visit = readable_visit(&state, &user, &id).await?;
    let number = |text: Option<&str>| text.and_then(|v| v.trim().parse::<i64>().ok());
    let after = number(page::param(&params, "after"))
        .unwrap_or(0)
        .max(number(headers.get("last-event-id").and_then(|v| v.to_str().ok())).unwrap_or(0))
        .clamp(0, visit.last_seq);
    let slot = state
        .streams
        .acquire(user.id)
        .ok_or(AppError::RateLimited { retry_after: 30 })?;
    // Subscribe before replaying, so nothing falls between the log and the live events.
    let receiver = state.hub.subscribe_visit(visit.id);
    let (tx, rx) = mpsc::channel(64);
    let follower = Follower {
        visit_id: visit.id,
        account_id: user.id,
        session_id: user.session_id,
        is_patient: user.is_patient(),
        last: after,
    };
    let task_state = state.clone();
    tokio::spawn(async move {
        let _slot = slot;
        follower.run(task_state, receiver, tx).await;
    });
    Ok(sse::response(rx))
}

// ---------------------------------------------------------------------------
// Summary, submit, handoff, refill check
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct PatchSummary {
    revision: i32,
    changes: Map<String, Value>,
}

fn set_error(error: SetError, locale: Locale) -> String {
    match error {
        SetError::Unknown => t(T::FieldErrUnknown, locale).into(),
        SetError::Type => t(T::ErrFieldRequired, locale).into(),
        SetError::TooLong(max) => fmt(
            T::FieldErrLength,
            locale,
            &[("min", "0"), ("max", &max.to_string())],
        ),
        SetError::Personal => t(T::FieldErrPersonal, locale).into(),
    }
}

/// Everything the patient typed, for the red-flag rules.
fn typed_text(changes: &Map<String, Value>) -> String {
    fn walk(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(s) => out.push(s.clone()),
            Value::Array(items) => items.iter().for_each(|v| walk(v, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    changes.values().for_each(|v| walk(v, &mut out));
    out.join("\n")
}

/// The patient corrects the summary before sending it. The text goes through the red-flag rules like a message.
pub async fn patch_summary(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<PatchSummary>,
) -> AppResult<Json<Value>> {
    let visit = own_visit(&state, &user, &id).await?;
    let locale = user.locale;
    let _guard = state
        .visit_locks
        .try_acquire(visit.id)
        .ok_or(AppError::Conflict)?;
    let visit = own_visit(&state, &user, &visit.id.to_string()).await?;
    if visit.submitted_at.is_some() || engine::is_closed(&visit) {
        return Err(AppError::InvalidState("the summary has been submitted"));
    }
    if visit.summary_revision != body.revision {
        return Err(AppError::stale(
            visits::current_summary(&state.db, &state.rules, &visit, state.clock.now()).await?,
        ));
    }
    let mut intake: IntakeState = visits::load_intake(&state.db, visit.id).await?;
    let mut errors = BTreeMap::new();
    let mut changed: Vec<String> = Vec::new();
    for (key, value) in &body.changes {
        match intake.set_field(key, value) {
            Ok(true) => changed.push(key.clone()),
            Ok(false) => {}
            Err(error) => {
                errors.insert(format!("changes.{key}"), set_error(error, locale));
            }
        }
    }
    if !errors.is_empty() {
        return Err(AppError::Unprocessable(errors));
    }
    if !changed.is_empty() {
        // The value no longer comes from a message.
        let mut evidence = visit.evidence.clone();
        if let Some(map) = evidence.as_object_mut() {
            changed.iter().for_each(|key| {
                map.remove(key);
            });
        }
        let stage = if visit.stage == Stage::Done {
            Stage::Done
        } else {
            intake.stage()
        };
        visits::save_intake(&state.db, visit.id, &intake, stage, &evidence, true).await?;
        events::append(
            &state,
            visit.id,
            "intake.updated",
            serde_json::to_value(intake.view(stage)).unwrap_or(Value::Null),
        )
        .await?;
        if let Some(matched) = state.rules.red_flags.check(&typed_text(&body.changes)) {
            engine::raise_red_flag(&state, &visit, &matched, None, None, None).await?;
        }
        visits::emit_updated(&state, visit.id).await?;
    }
    let visit = own_visit(&state, &user, &visit.id.to_string()).await?;
    let summary =
        visits::current_summary(&state.db, &state.rules, &visit, state.clock.now()).await?;
    if let Some(summary) = &summary {
        events::append(
            &state,
            visit.id,
            "summary.updated",
            serde_json::to_value(summary).unwrap_or(Value::Null),
        )
        .await?;
    }
    Ok(Json(json!({ "summary": summary })))
}

pub async fn submit(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(client): ClientId,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let visit = own_visit(&state, &user, &id).await?;
    check_rate(&state, Bucket::Actions, client)?;
    // Idempotent: a closed visit, or one that already has its summary, returns what is there.
    if summary::load(&state.db, visit.id).await?.is_none() {
        let intake = visits::load_intake(&state.db, visit.id).await?;
        let flags =
            visits::triggered_flags(&state.db, &state.rules.red_flags, visit.id, visit.locale)
                .await?;
        let built = summary::build(SummaryInput {
            visit_id: visit.id,
            intake: &intake,
            locale: visit.locale,
            flags,
            refill: visits::latest_refill(&state.db, visit.id).await?,
            narrative: None,
            model: None,
            follow_up: Vec::new(),
            now: state.clock.now(),
        });
        summary::save(&state.db, &built).await?;
    }
    if visit.submitted_at.is_none() {
        visits::finalize_submit(&state, visit.id).await?;
        visits::emit_updated(&state, visit.id).await?;
    }
    let visit = own_visit(&state, &user, &id).await?;
    let summary =
        visits::current_summary(&state.db, &state.rules, &visit, state.clock.now()).await?;
    if let Some(summary) = &summary {
        events::append(
            &state,
            visit.id,
            "summary.updated",
            serde_json::to_value(summary).unwrap_or(Value::Null),
        )
        .await?;
    }
    let id = visit.id;
    Ok(Json(
        json!({ "visit": view(&state, &user, id).await?, "summary": summary }),
    ))
}

#[derive(Deserialize, Default)]
pub struct HandoffBody {
    reason: Option<String>,
    note: Option<String>,
}

pub async fn handoff(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(client): ClientId,
    key: IdempotencyKey,
    Path(id): Path<String>,
    OptionalJson(body): OptionalJson<HandoffBody>,
) -> AppResult<Response> {
    let visit = own_visit(&state, &user, &id).await?;
    idem::run(&state, user.id, key, "POST /visits/handoff", || async {
        check_rate(&state, Bucket::Actions, client)?;
        let locale = visit.locale;
        let note = body
            .note
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty());
        if note.is_some_and(|n| n.chars().count() > 300) {
            return Err(AppError::field(
                "note",
                fmt(
                    T::FieldErrLength,
                    user.locale,
                    &[("min", "0"), ("max", "300")],
                ),
            ));
        }
        // The note gets the same screens as a chat message: mask personal data, then the red-flag rules.
        let note_text = note.map(|n| pii::mask(n).text);
        let mut red_flag = None;
        if let Some(matched) = note_text
            .as_deref()
            .and_then(|text| state.rules.red_flags.check(text))
        {
            red_flag =
                Some(engine::raise_red_flag(&state, &visit, &matched, None, None, None).await?);
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
        let mut created = tickets::open(
            &state,
            NewTicket {
                source: tickets::Source::Visit(visit.id),
                reason,
                urgency: Urgency::Routine,
                summary: &summary_text,
                created_by: CreatedBy::Form,
            },
        )
        .await?;
        tickets::fill_patients(
            &state.db,
            std::slice::from_mut(&mut created.ticket),
            user.locale,
        )
        .await?;
        if !created.deduped {
            events::append(
                &state,
                visit.id,
                "ticket.created",
                serde_json::to_value(&created.ticket).unwrap_or(Value::Null),
            )
            .await?;
        }
        visits::touch(&state.db, visit.id).await?;
        visits::emit_updated(&state, visit.id).await?;
        Ok((
            StatusCode::CREATED,
            json!({ "ticket": created.ticket, "deduped": created.deduped, "red_flag": red_flag }),
        ))
    })
    .await
}

pub async fn refill_check(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(client): ClientId,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Value>,
) -> AppResult<Json<Value>> {
    let visit = own_visit(&state, &user, &id).await?;
    check_rate(&state, Bucket::Actions, client)?;
    let locale = visit.locale;
    let input = RefillInput::from_json(&body, true, locale).map_err(AppError::Unprocessable)?;
    let started = std::time::Instant::now();
    let run = tools::perform_refill_check(&state, visit.id, locale, &input, CreatedBy::Form)
        .await?
        .map_err(AppError::Unprocessable)?;
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
    if let Some(ticket) = &run.ticket {
        events::append(
            &state,
            visit.id,
            "ticket.created",
            serde_json::to_value(ticket).unwrap_or(Value::Null),
        )
        .await?;
        visits::emit_updated(&state, visit.id).await?;
    }
    Ok(Json(json!({ "result": run.result })))
}

// ---------------------------------------------------------------------------
// Staff in the thread
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct AssignBody {
    account_id: Option<Uuid>,
}

/// Roles that can own a visit.
const VISIT_STAFF: [Role; 2] = [Role::Physician, Role::Coordinator];

pub async fn assign(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<AssignBody>,
) -> AppResult<Json<VisitView>> {
    let visit = staff_visit(&state, &user, &id, Permission::VisitReview, "visit").await?;
    if let Some(account) = body.account_id {
        let ok = people::by_roles(&state.db, &VISIT_STAFF, user.locale)
            .await?
            .iter()
            .any(|p| p.id == account);
        if !ok {
            return Err(AppError::field(
                "account_id",
                t(T::FieldErrChoice, user.locale),
            ));
        }
    } else if visit.mode == VisitMode::Human {
        return Err(AppError::InvalidState(
            "release the conversation before clearing its owner",
        ));
    }
    sqlx::query("UPDATE visits SET assigned_to = $2, updated_at = now() WHERE id = $1")
        .bind(visit.id)
        .bind(body.account_id)
        .execute(&state.db)
        .await?;
    audit::audit(
        &state.db,
        Some(&user),
        AuditKind::Clinic,
        "visit.assign",
        &format!("visit:{}", visit.id),
        json!({ "to": body.account_id }),
    )
    .await;
    visits::emit_updated(&state, visit.id).await?;
    visits::changed(&state, visit.id, visit.patient_id, true);
    Ok(Json(view(&state, &user, visit.id).await?))
}

async fn set_mode(
    state: &AppState,
    user: &CurrentUser,
    visit: &Visit,
    mode: VisitMode,
) -> AppResult<()> {
    let who = user.person(visit.locale);
    let name = match &who.title {
        Some(title) if visit.locale.is_en() => format!("{}, {title}", who.display_name),
        Some(title) => format!("{} {title}", who.display_name),
        None => who.display_name.clone(),
    };
    let text = fmt(
        match mode {
            VisitMode::Human => T::HandoffTaken,
            VisitMode::Ai => T::HandoffReleased,
        },
        visit.locale,
        &[("name", &name)],
    );
    events::insert_message(
        state,
        visit.id,
        visit.locale,
        NewMessage {
            role: "staff",
            kind: message_kind::HANDOFF,
            content: &text,
            run_id: None,
            author: Some(user.id),
            client_id: None,
        },
    )
    .await?;
    events::append(
        state,
        visit.id,
        "mode.changed",
        json!({ "mode": mode, "by": who }),
    )
    .await?;
    audit::audit(
        &state.db,
        Some(user),
        AuditKind::Clinic,
        match mode {
            VisitMode::Human => "visit.takeover",
            VisitMode::Ai => "visit.release",
        },
        &format!("visit:{}", visit.id),
        Value::Null,
    )
    .await;
    visits::touch(&state.db, visit.id).await?;
    visits::emit_updated(state, visit.id).await?;
    visits::changed(state, visit.id, visit.patient_id, true);
    Ok(())
}

/// Switches the conversation to a person. Whoever already has it keeps it until they release it.
pub async fn takeover(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<VisitView>> {
    let visit = staff_visit(&state, &user, &id, Permission::ThreadReply, "visit").await?;
    let taken = sqlx::query("UPDATE visits SET mode = 'human', assigned_to = $2, updated_at = now() WHERE id = $1 AND mode = 'ai'")
        .bind(visit.id)
        .bind(user.id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if taken == 0 {
        let current = view(&state, &user, visit.id).await?;
        if current
            .assigned_to
            .as_ref()
            .is_some_and(|p| p.id == user.id)
        {
            return Ok(Json(current));
        }
        return Err(AppError::stale(current));
    }
    set_mode(&state, &user, &visit, VisitMode::Human).await?;
    Ok(Json(view(&state, &user, visit.id).await?))
}

/// Hands the conversation back to the assistant. The person who has it can, and so can any physician.
pub async fn release(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<VisitView>> {
    let visit = staff_visit(&state, &user, &id, Permission::ThreadReply, "visit").await?;
    if visit.mode != VisitMode::Human {
        return Err(AppError::InvalidState(
            "the conversation is already with the AI",
        ));
    }
    if visit.assigned_to != Some(user.id) && !user.can(Permission::NoteSign) {
        return Err(AppError::Forbidden);
    }
    sqlx::query("UPDATE visits SET mode = 'ai', updated_at = now() WHERE id = $1")
        .bind(visit.id)
        .execute(&state.db)
        .await?;
    set_mode(&state, &user, &visit, VisitMode::Ai).await?;
    Ok(Json(view(&state, &user, visit.id).await?))
}

#[derive(Deserialize)]
pub struct StaffMessage {
    content: String,
    client_id: String,
}

/// A reply from the person who took the conversation over.
pub async fn staff_message(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<StaffMessage>,
) -> AppResult<Response> {
    let visit = staff_visit(&state, &user, &id, Permission::ThreadReply, "visit").await?;
    let client_id = clean_client_id(&body.client_id, user.locale)?;
    if let Some(message) =
        visits::message_by_client_id(&state.db, visit.id, &client_id, user.locale).await?
    {
        return Ok(Json(json!({ "message": message })).into_response());
    }
    let content = body.content.trim();
    let n = content.chars().count();
    if !(1..=STAFF_MESSAGE_MAX_CHARS).contains(&n) {
        return Err(AppError::field(
            "content",
            fmt(
                T::FieldErrLength,
                user.locale,
                &[("min", "1"), ("max", &STAFF_MESSAGE_MAX_CHARS.to_string())],
            ),
        ));
    }
    if visit.mode != VisitMode::Human {
        return Err(AppError::InvalidState(
            "take the conversation over before replying",
        ));
    }
    if visit.assigned_to != Some(user.id) {
        return Err(AppError::Forbidden);
    }
    let message = send_staff_message(&state, &user, &visit, content, Some(&client_id)).await?;
    Ok((StatusCode::CREATED, Json(json!({ "message": message }))).into_response())
}

/// Stores a staff message in a thread and tells the patient.
pub async fn send_staff_message(
    state: &AppState,
    user: &CurrentUser,
    visit: &Visit,
    content: &str,
    client_id: Option<&str>,
) -> AppResult<Message> {
    let message = events::insert_message(
        state,
        visit.id,
        visit.locale,
        NewMessage {
            role: "staff",
            kind: message_kind::CHAT,
            content,
            run_id: None,
            author: Some(user.id),
            client_id,
        },
    )
    .await?;
    visits::touch(&state.db, visit.id).await?;
    events::mark_read(&state.db, visit.id, user.id, message.seq).await?;
    if let Some(patient) = visit.patient_id {
        sqlx::query("UPDATE patient_care SET last_contact_at = now() WHERE account_id = $1")
            .bind(patient)
            .execute(&state.db)
            .await?;
        notify::notify(
            state,
            patient,
            notify::Kind::VisitStaffMessage,
            json!({ "actor_id": user.id, "title": visits::display_title(visit, Locale::ZhTw), "title_en": visits::display_title(visit, Locale::En) }),
            &format!("/app/visits/{}", visit.id),
        )
        .await;
    }
    visits::changed(state, visit.id, visit.patient_id, false);
    Ok(message)
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
    fn client_ids_are_short_plain_keys() {
        assert!(clean_client_id(" 0193-abc_1:x.y ", Locale::ZhTw).is_ok());
        for bad in ["", "有字", "a b", &"x".repeat(65)] {
            assert!(clean_client_id(bad, Locale::ZhTw).is_err(), "{bad}");
        }
    }

    #[test]
    fn every_typed_string_reaches_the_red_flag_rules() {
        let changes = serde_json::from_value(json!({
            "chief_complaint": "頭暈",
            "patient_questions": ["我胸口悶痛怎麼辦"],
            "hpi.severity": 5,
            "allergies": null
        }))
        .expect("map");
        let text = typed_text(&changes);
        assert!(text.contains("頭暈") && text.contains("胸口悶痛"));
    }
}
