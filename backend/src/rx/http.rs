//! HTTP routes of contract §4. A handler does, in this order: permission, row lock, visibility (someone else's request
//! is a 404), `revision` (409 with the current object), state (409), then one transaction, then notifications.

use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::{PgConnection, Postgres, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use super::engine::UrgentNotice;
use super::machine::{self, Action, DecidableItem, DispenseChecks, ItemDecision, Step, Viewer};
use super::medications::{self, RefillAnswers};
use super::protocol;
use super::store::{self, Item, ListFilter, NewEvent, Request, ev};
use super::texts::{R, rf, rt};
use super::{DecisionOutcome, Disposition, PickupSlot, RenewalScope, RxKind, RxStatus};
use crate::audit::{AuditKind, audit, log_access};
use crate::auth::CurrentUser;
use crate::clock::{format_date, parse_date};
use crate::error::{AppError, AppResult, request_locale};
use crate::http::{ApiJson, OptionalJson};
use crate::idem::{self, IdempotencyKey};
use crate::notify::{self, Kind};
use crate::page::{self, Cursor, Page, Params};
use crate::perm::{Permission, Role};
use crate::pii;
use crate::precheck::RedFlagMatch;
use crate::state::AppState;
use crate::texts::{T, t};
use crate::tickets::{self, NewTicket};
use crate::types::{CreatedBy, Locale, RedFlagCategory, TicketReason, Urgency};

const MAX_MESSAGE_CHARS: usize = 2000;
const MAX_NOTE_CHARS: usize = 1000;
/// A pickup date may be at most this many days ahead.
const PICKUP_DAYS_AHEAD: i64 = 30;

/// Every route of contract §4, with full paths. Mounted at `/api/v2`.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/app/medications",
            get(list_medications).post(add_medication),
        )
        .route("/rx", get(list_requests).post(create))
        .route("/rx/protocols", get(protocols))
        .route("/rx/formulary", get(formulary))
        .route("/rx/{id}", get(read).patch(edit))
        .route("/rx/{id}/evaluate", post(evaluate))
        .route("/rx/{id}/submit", post(submit))
        .route("/rx/{id}/cancel", post(cancel))
        .route("/rx/{id}/reply", post(reply))
        .route("/rx/{id}/messages", post(message))
        .route("/rx/{id}/assign", post(assign))
        .route("/rx/{id}/decide", post(decide))
        .route("/rx/{id}/pharmacy", post(pharmacy_action))
        .route("/queue/rx", get(queue))
}

// ---------------------------------------------------------------------------
// Opening a request for a change
// ---------------------------------------------------------------------------

struct Open {
    tx: Transaction<'static, Postgres>,
    request: Request,
    now: OffsetDateTime,
}

fn parse_id(id: &str) -> AppResult<Uuid> {
    Uuid::parse_str(id).map_err(|_| AppError::NotFound)
}

/// What the action needs, whatever the status is.
fn holds(action: Action, viewer: Viewer) -> bool {
    let staff = viewer.read && !viewer.owner;
    match action {
        Action::Edit | Action::Evaluate | Action::Submit | Action::Reply | Action::Cancel => {
            viewer.owner
        }
        Action::Message => viewer.owner || staff,
        Action::StaffMessage | Action::Assign => staff,
        Action::Decide => staff && viewer.decide,
        Action::Accept
        | Action::MarkReady
        | Action::Dispense
        | Action::Return
        | Action::AskPhysician => staff && viewer.dispense,
    }
}

fn may_use_rx(user: &CurrentUser) -> AppResult<()> {
    if user.can(Permission::RxOwn) || user.can(Permission::RxRead) {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

async fn open(
    state: &AppState,
    user: &CurrentUser,
    id: &str,
    action: Action,
    revision: Option<i32>,
) -> AppResult<Open> {
    may_use_rx(user)?;
    let id = parse_id(id)?;
    let mut tx = state.db.begin().await?;
    let request = store::lock(&mut tx, id).await?.ok_or(AppError::NotFound)?;
    let viewer = store::viewer_of(user, &request);
    if !machine::can_see(request.status, viewer) {
        return Err(AppError::NotFound);
    }
    if !holds(action, viewer) {
        return Err(AppError::Forbidden);
    }
    if let Some(revision) = revision
        && revision != request.revision
    {
        tx.rollback().await?;
        return Err(AppError::stale(store::view(state, &request, user).await?));
    }
    if !machine::can(request.kind, request.status, viewer, action) {
        return Err(AppError::InvalidState(
            "the request cannot take this step now",
        ));
    }
    Ok(Open {
        tx,
        request,
        now: state.clock.now(),
    })
}

fn revision_of(body: &Map<String, Value>, locale: Locale) -> AppResult<i32> {
    body.get("revision")
        .and_then(Value::as_i64)
        .and_then(|n| i32::try_from(n).ok())
        .ok_or_else(|| AppError::field("revision", rt(R::ErrRevision, locale)))
}

/// Trimmed text within a limit; `None` when there is none.
fn text_of(
    body: &Map<String, Value>,
    key: &str,
    max: usize,
    locale: Locale,
) -> AppResult<Option<String>> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.chars().count() > max {
                return Err(AppError::field(
                    key,
                    rf(R::ErrTextLength, locale, &[("max", &max.to_string())]),
                ));
            }
            Ok((!s.is_empty()).then(|| s.to_string()))
        }
        Some(_) => Err(AppError::field(key, t(T::ErrFieldRequired, locale))),
    }
}

// ---------------------------------------------------------------------------
// Telling people
// ---------------------------------------------------------------------------

fn patient_link(r: &Request) -> String {
    format!("/app/rx/{}", r.id)
}

fn clinic_link(r: &Request) -> String {
    format!("/clinic/rx/{}", r.id)
}

fn pharmacy_link(r: &Request) -> String {
    format!("/pharmacy/rx/{}", r.id)
}

/// Live updates: the patient's tabs and, once submitted, the staff lists.
fn announce(state: &AppState, r: &Request) {
    let data = json!({ "id": r.id });
    state
        .hub
        .to_account(r.patient_id, "rx.changed", data.clone());
    if r.submitted_at.is_some() {
        state
            .hub
            .to_permission(Permission::RxRead, "rx.changed", data);
        state
            .hub
            .to_permission(Permission::RxRead, "queue.changed", json!({ "name": "rx" }));
    }
}

async fn tell_patient_status(state: &AppState, r: &Request) {
    notify::notify(
        state,
        r.patient_id,
        Kind::RxStatus,
        json!({ "no": r.no, "status": r.status.as_str() }),
        &patient_link(r),
    )
    .await;
}

fn new_params(r: &Request) -> Value {
    json!({ "no": r.no, "patient_id": r.patient_id, "rx_kind": r.kind.as_str() })
}

async fn tell_pharmacists_new(state: &AppState, r: &Request) {
    notify::notify_staff(
        state,
        Permission::RxDispense,
        Kind::RxNew,
        new_params(r),
        &pharmacy_link(r),
        None,
    )
    .await;
}

/// The physician who holds the request, or every physician when nobody does.
async fn tell_physicians_status(state: &AppState, r: &Request) {
    let params = json!({ "no": r.no, "status": r.status.as_str() });
    match r.decided_by.or(r.assigned_to) {
        Some(id) => notify::notify(state, id, Kind::RxStatus, params, &clinic_link(r)).await,
        None => {
            notify::notify_staff(
                state,
                Permission::RxDecide,
                Kind::RxStatus,
                params,
                &clinic_link(r),
                None,
            )
            .await
        }
    }
}

/// Which staff look at a request in its present state.
fn desk(r: &Request) -> (Permission, String) {
    let pharmacy = matches!(
        r.status,
        RxStatus::AtPharmacy | RxStatus::Ready | RxStatus::Dispensed
    ) || (r.kind == RxKind::Refill
        && matches!(r.status, RxStatus::Submitted | RxStatus::Returned));
    if pharmacy {
        (Permission::RxDispense, pharmacy_link(r))
    } else {
        // Physicians and coordinators.
        (Permission::VisitReview, clinic_link(r))
    }
}

// ---------------------------------------------------------------------------
// Emergencies
// ---------------------------------------------------------------------------

/// The red flag in a set of patient texts; self-harm wins over the others.
fn red_flag_in(state: &AppState, texts: &[String]) -> Option<RedFlagMatch> {
    let hits: Vec<RedFlagMatch> = texts
        .iter()
        .filter_map(|text| state.rules.red_flags.check(text))
        .collect();
    hits.iter()
        .find(|h| h.category == RedFlagCategory::Suicide)
        .or(hits.first())
        .cloned()
}

/// Opens the urgent ticket and marks the request. The ticket is written before the caller commits, so "the care team
/// has been alerted" is never shown without one.
async fn alert(
    state: &AppState,
    db: &mut PgConnection,
    user: &CurrentUser,
    request: &mut Request,
    notice: &UrgentNotice,
    now: OffsetDateTime,
) -> AppResult<()> {
    let zh = Locale::ZhTw;
    let mut summary = rf(
        R::TicketRxUrgent,
        zh,
        &[("no", &request.no), ("label", &notice.label.zh)],
    );
    if request.status == RxStatus::Draft {
        summary.push_str(rt(R::TicketRxDraft, zh));
    }
    let created = tickets::open(
        state,
        NewTicket {
            source: tickets::Source::Rx {
                request_id: request.id,
                patient_id: request.patient_id,
            },
            reason: TicketReason::RedFlag,
            urgency: Urgency::Urgent,
            summary: &summary,
            created_by: CreatedBy::Code,
        },
    )
    .await?;
    let due = store::sla_due(state, Urgency::Urgent, now);
    sqlx::query("UPDATE rx_requests SET priority = 'urgent', extra = extra || '{\"alerted\": true}'::jsonb, sla_due_at = CASE WHEN status = 'draft' THEN sla_due_at ELSE LEAST(sla_due_at, $2) END WHERE id = $1")
        .bind(request.id)
        .bind(due)
        .execute(&mut *db)
        .await?;
    request.priority = Urgency::Urgent;
    request.extra["alerted"] = json!(true);
    let data = json!({
        "category": notice.category.map(RedFlagCategory::as_str),
        "from_text": notice.from_text,
        "label": notice.label.zh,
        "label_en": notice.label.en,
        "ticket_no": created.ticket.ticket_no,
    });
    store::add_event(
        db,
        request.id,
        now,
        NewEvent::new(ev::URGENT, None).data(data),
    )
    .await?;
    // Staff cannot open a draft; the patient's page is where to start then.
    let link = if request.status == RxStatus::Draft {
        format!("/clinic/patients/{}", request.patient_id)
    } else {
        clinic_link(request)
    };
    notify::notify_staff(
        state,
        Permission::TicketHandle,
        Kind::RedFlag,
        json!({ "patient_id": request.patient_id, "label": notice.label.zh, "label_en": notice.label.en }),
        &link,
        Some(&format!("rx-red-flag:{}", created.ticket.id)),
    )
    .await;
    audit(
        &state.db,
        Some(user),
        AuditKind::Rx,
        "rx.red_flag",
        &format!("rx:{}", request.id),
        json!({ "category": notice.category.map(RedFlagCategory::as_str), "ticket": created.ticket.ticket_no }),
    )
    .await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Medicines
// ---------------------------------------------------------------------------

async fn list_medications(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Value>> {
    user.require(Permission::RxOwn)?;
    let items = store::cards(&state, user.id, user.locale).await?;
    Ok(Json(json!(Page::all(items))))
}

/// A medicine the patient takes but the clinic did not prescribe. It can be shown to staff, never refilled or renewed.
async fn add_medication(
    State(state): State<AppState>,
    user: CurrentUser,
    key: IdempotencyKey,
    ApiJson(body): ApiJson<Map<String, Value>>,
) -> AppResult<Response> {
    user.require(Permission::RxOwn)?;
    let name = text_of(&body, "name", 80, user.locale)?
        .ok_or_else(|| AppError::field("name", rt(R::ErrNameRequired, user.locale)))?;
    let dose = text_of(&body, "dose_text", 200, user.locale)?.unwrap_or_default();
    idem::run(&state, user.id, key, "POST /app/medications", || async {
        let id: Uuid = sqlx::query_scalar("INSERT INTO prescriptions (patient_id, source, name_zh, dose_text) VALUES ($1, 'self_reported', $2, $3) RETURNING id")
            .bind(user.id)
            .bind(pii::mask(&name).text)
            .bind(pii::mask(&dose).text)
            .fetch_one(&state.db)
            .await?;
        let card = store::cards(&state, user.id, user.locale)
            .await?
            .into_iter()
            .find(|c| c.prescription_id == id.to_string());
        Ok((StatusCode::CREATED, json!(card)))
    })
    .await
}

// ---------------------------------------------------------------------------
// Public data
// ---------------------------------------------------------------------------

async fn protocols(State(state): State<AppState>) -> Json<Value> {
    Json(state.rx.protocols.public(request_locale()))
}

async fn formulary(
    State(state): State<AppState>,
    Query(params): Query<Params>,
) -> AppResult<Json<Value>> {
    let locale = request_locale();
    let scope = page::param(&params, "scope")
        .map(|s| {
            RenewalScope::parse(s)
                .ok_or_else(|| AppError::field("scope", t(T::FieldErrChoice, locale)))
        })
        .transpose()?;
    let found = state
        .rx
        .formulary
        .search(page::param(&params, "q").unwrap_or(""), scope);
    let total = found.len();
    let items: Vec<_> = found.into_iter().map(|d| d.to_out(locale)).collect();
    Ok(Json(
        json!({ "items": items, "next_cursor": null, "total": total }),
    ))
}

// ---------------------------------------------------------------------------
// Creating and reading
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct CreateBody {
    kind: String,
    prescription_ids: Vec<String>,
}

async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    key: IdempotencyKey,
    ApiJson(body): ApiJson<CreateBody>,
) -> AppResult<Response> {
    user.require(Permission::RxOwn)?;
    let kind = RxKind::parse(&body.kind)
        .ok_or_else(|| AppError::field("kind", t(T::FieldErrChoice, user.locale)))?;
    let ids = body
        .prescription_ids
        .iter()
        .map(|id| parse_id(id))
        .collect::<AppResult<Vec<Uuid>>>()?;
    idem::run(&state, user.id, key, "POST /rx", || async {
        let id = store::create_draft(&state, user.id, user.locale, kind, &ids).await?;
        audit(
            &state.db,
            Some(&user),
            AuditKind::Rx,
            "rx.create",
            &format!("rx:{id}"),
            json!({ "kind": kind.as_str(), "items": ids.len() }),
        )
        .await;
        state
            .hub
            .to_account(user.id, "rx.changed", json!({ "id": id }));
        Ok((
            StatusCode::CREATED,
            store::view_fresh(&state, id, &user).await?,
        ))
    })
    .await
}

fn list_filter(params: &Params, locale: Locale) -> AppResult<ListFilter<'_>> {
    let choice = |name: &str| AppError::field(name, t(T::FieldErrChoice, locale));
    let statuses = page::param(params, "status")
        .map(|text| {
            text.split(',')
                .map(|s| {
                    RxStatus::parse(s.trim())
                        .map(|s| s.as_str().to_string())
                        .ok_or_else(|| choice("status"))
                })
                .collect::<AppResult<Vec<String>>>()
        })
        .transpose()?;
    let kind = page::param(params, "kind")
        .map(|k| {
            RxKind::parse(k)
                .map(RxKind::as_str)
                .ok_or_else(|| choice("kind"))
        })
        .transpose()?;
    Ok(ListFilter {
        statuses,
        kind,
        q: page::like(params),
        before: page::cursor(params)?,
        limit: page::limit(params)?,
    })
}

async fn list_requests(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Params>,
) -> AppResult<Json<Value>> {
    may_use_rx(&user)?;
    let filter = list_filter(&params, user.locale)?;
    if user.can(Permission::RxRead) {
        log_access(&state.db, &user, None, "list", "rx", "").await?;
    }
    let rows = store::list(&state.db, &user, &filter).await?;
    let page = page::cut(rows, filter.limit, |r| Cursor {
        at: r.updated_at,
        id: r.id,
    });
    let items = store::briefs(&state, &page.items, user.locale).await?;
    Ok(Json(
        json!({ "items": items, "next_cursor": page.next_cursor }),
    ))
}

async fn read(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    may_use_rx(&user)?;
    let request = store::find(&state.db, parse_id(&id)?)
        .await?
        .ok_or(AppError::NotFound)?;
    if !machine::can_see(request.status, store::viewer_of(&user, &request)) {
        return Err(AppError::NotFound);
    }
    // No record, no access. A patient reading their own request is not logged.
    log_access(
        &state.db,
        &user,
        Some(request.patient_id),
        "read",
        "rx",
        &request.id.to_string(),
    )
    .await?;
    let out = store::view(&state, &request, &user).await?;
    store::mark_read(&state.db, request.id, user.id).await?;
    Ok(Json(out))
}

async fn queue(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Params>,
) -> AppResult<Json<Value>> {
    user.require(Permission::RxRead)?;
    let bucket = page::param(&params, "bucket");
    if bucket.is_some_and(|b| !store::BUCKETS.contains(&b)) {
        return Err(AppError::field("bucket", t(T::FieldErrChoice, user.locale)));
    }
    let limit = page::limit(&params)?;
    let offset = match page::param(&params, "cursor") {
        None => 0,
        Some(c) => c
            .strip_prefix('o')
            .and_then(|n| n.parse::<i64>().ok())
            .filter(|n| (0..=100_000).contains(n))
            .ok_or_else(|| AppError::field("cursor", t(T::FieldErrChoice, user.locale)))?,
    };
    log_access(
        &state.db,
        &user,
        None,
        "list",
        "rx_queue",
        bucket.unwrap_or("all"),
    )
    .await?;
    let mut rows = store::queue(&state, &user, bucket, page::like(&params), offset, limit).await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let items = store::briefs(&state, &rows, user.locale).await?;
    let counts = store::queue_counts(&state, &user).await?;
    Ok(Json(json!({
        "items": items,
        "next_cursor": more.then(|| format!("o{}", offset + limit)),
        "counts": counts,
    })))
}

// ---------------------------------------------------------------------------
// The patient's side
// ---------------------------------------------------------------------------

/// Answers as they would be with this patch, and the free text it changed.
struct Patched {
    answers: Map<String, Value>,
    monitoring: protocol::MonitoringSet,
    texts: Vec<String>,
}

fn apply_patch(
    state: &AppState,
    request: &Request,
    list: &[Item],
    body: &Map<String, Value>,
    locale: Locale,
) -> AppResult<Patched> {
    let questions = store::questions(state, request.kind, list, locale);
    let object = |key: &str| -> AppResult<Map<String, Value>> {
        match body.get(key) {
            None | Some(Value::Null) => Ok(Map::new()),
            Some(Value::Object(o)) => Ok(o.clone()),
            Some(_) => Err(AppError::field(key, t(T::ErrFieldRequired, locale))),
        }
    };
    let cleaned = protocol::clean_answers(
        &questions,
        &request.answers_map(),
        &object("answers")?,
        locale,
    )
    .map_err(AppError::Unprocessable)?;
    let monitoring = protocol::clean_monitoring(
        &questions,
        &request.monitoring_set(),
        &object("monitoring")?,
        state.clock.today(),
        locale,
    )
    .map_err(AppError::Unprocessable)?;
    Ok(Patched {
        answers: cleaned.answers,
        monitoring,
        texts: cleaned.texts,
    })
}

async fn save_answers(db: &mut PgConnection, request: &mut Request, p: &Patched) -> AppResult<()> {
    request.answers = Value::Object(p.answers.clone());
    request.monitoring = serde_json::to_value(&p.monitoring).map_err(anyhow::Error::from)?;
    sqlx::query("UPDATE rx_requests SET answers = $2, monitoring = $3 WHERE id = $1")
        .bind(request.id)
        .bind(&request.answers)
        .bind(&request.monitoring)
        .execute(db)
        .await?;
    Ok(())
}

/// Autosave: any of `step`, `answers`, `monitoring`, `pharmacy_id`, `pickup_window`, with the revision it was based on.
async fn edit(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Map<String, Value>>,
) -> AppResult<Json<Value>> {
    let locale = user.locale;
    let revision = revision_of(&body, locale)?;
    let step = text_of(&body, "step", 40, locale)?;
    let mut o = open(&state, &user, &id, Action::Edit, Some(revision)).await?;
    let list = store::items(&mut o.tx, o.request.id).await?;
    let patched = apply_patch(&state, &o.request, &list, &body, locale)?;
    save_answers(&mut o.tx, &mut o.request, &patched).await?;
    if let Some(step) = step {
        sqlx::query("UPDATE rx_requests SET step = $2 WHERE id = $1")
            .bind(o.request.id)
            .bind(&step)
            .execute(&mut *o.tx)
            .await?;
    }
    if let Some(value) = body.get("pharmacy_id") {
        let chosen = match value {
            Value::Null => None,
            Value::String(s) => Some(
                store::pharmacy(&mut o.tx, Some(s))
                    .await?
                    .ok_or_else(|| {
                        AppError::field("pharmacy_id", rt(R::ErrPharmacyUnknown, locale))
                    })?
                    .id,
            ),
            _ => {
                return Err(AppError::field(
                    "pharmacy_id",
                    rt(R::ErrPharmacyUnknown, locale),
                ));
            }
        };
        sqlx::query("UPDATE rx_requests SET pharmacy_id = $2 WHERE id = $1")
            .bind(o.request.id)
            .bind(chosen)
            .execute(&mut *o.tx)
            .await?;
    }
    if let Some(value) = body.get("pickup_window") {
        let window = pickup_window(&state, value, locale)?;
        sqlx::query("UPDATE rx_requests SET pickup_window = $2 WHERE id = $1")
            .bind(o.request.id)
            .bind(window)
            .execute(&mut *o.tx)
            .await?;
    }
    if o.request.kind == RxKind::Renewal {
        // An emergency is shown at once; any other preview waits until the patient asks for it.
        let prescriptions = store::item_prescriptions(&mut o.tx, &list).await?;
        let output = store::run_engine(
            &state,
            &list,
            &prescriptions,
            &patched.answers,
            &patched.monitoring,
        );
        if output.disposition == Disposition::Urgent {
            store::save_engine(&mut o.tx, o.request.id, &output, o.now).await?;
        } else if o
            .request
            .engine_snapshot()
            .is_some_and(|(e, _)| e.disposition == Disposition::Urgent)
        {
            sqlx::query("UPDATE rx_requests SET engine = NULL, disposition = NULL WHERE id = $1")
                .bind(o.request.id)
                .execute(&mut *o.tx)
                .await?;
            sqlx::query("UPDATE rx_request_items SET engine = NULL, disposition = NULL WHERE request_id = $1")
                .bind(o.request.id)
                .execute(&mut *o.tx)
                .await?;
        }
    }
    if let Some(hit) = red_flag_in(&state, &patched.texts) {
        alert(
            &state,
            &mut o.tx,
            &user,
            &mut o.request,
            &UrgentNotice::from_text(&hit),
            o.now,
        )
        .await?;
    }
    store::touch(&mut o.tx, &mut o.request, o.now).await?;
    o.tx.commit().await?;
    state
        .hub
        .to_account(user.id, "rx.changed", json!({ "id": o.request.id }));
    Ok(Json(store::view_fresh(&state, o.request.id, &user).await?))
}

fn pickup_window(state: &AppState, value: &Value, locale: Locale) -> AppResult<Option<Value>> {
    if value.is_null() {
        return Ok(None);
    }
    let required = || AppError::field("pickup_window", rt(R::ErrPickupRequired, locale));
    let date = value["date"]
        .as_str()
        .and_then(parse_date)
        .ok_or_else(required)?;
    let slot = value["slot"]
        .as_str()
        .and_then(PickupSlot::parse)
        .ok_or_else(required)?;
    let today = state.clock.today();
    if date < today {
        return Err(AppError::field(
            "pickup_window",
            rt(R::ErrPickupPast, locale),
        ));
    }
    if date > today + Duration::days(PICKUP_DAYS_AHEAD) {
        return Err(AppError::field(
            "pickup_window",
            rf(
                R::ErrPickupTooFar,
                locale,
                &[("days", &PICKUP_DAYS_AHEAD.to_string())],
            ),
        ));
    }
    Ok(Some(
        json!({ "date": format_date(date), "slot": slot.as_str() }),
    ))
}

/// The refill check of a refill request today. `None` while its three questions are not all answered.
async fn refill_check(
    state: &AppState,
    db: &mut PgConnection,
    request: &Request,
    list: &[Item],
    locale: Locale,
) -> AppResult<Option<crate::refill::Evaluation>> {
    let Some(answers) = RefillAnswers::from_answers(&request.answers_map()) else {
        return Ok(None);
    };
    let prescriptions = store::item_prescriptions(&mut *db, list).await?;
    let Some((item, p)) = list.first().and_then(|i| {
        prescriptions
            .get(&i.prescription_id.to_string())
            .map(|p| (i, p))
    }) else {
        return Ok(None);
    };
    let today = state.clock.today();
    let Some(input) = medications::refill_input(p, answers) else {
        return Ok(None);
    };
    let checked = medications::check_refill(p, answers, &state.rules.refill, today, locale)
        .transpose()
        .map_err(AppError::Unprocessable)?;
    sqlx::query("UPDATE rx_request_items SET refill = $2 WHERE id = $1")
        .bind(item.id)
        .bind(store::refill_stored(&input, today))
        .execute(db)
        .await?;
    Ok(checked)
}

/// Preview only: what the engine (or the refill check) says about the answers so far. Nothing is submitted.
async fn evaluate(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    OptionalJson(_): OptionalJson<Value>,
) -> AppResult<Json<Value>> {
    let mut o = open(&state, &user, &id, Action::Evaluate, None).await?;
    let list = store::items(&mut o.tx, o.request.id).await?;
    if o.request.kind == RxKind::Refill {
        refill_check(&state, &mut o.tx, &o.request, &list, user.locale).await?;
    } else {
        let prescriptions = store::item_prescriptions(&mut o.tx, &list).await?;
        let answers = o.request.answers_map();
        let output = store::run_engine(
            &state,
            &list,
            &prescriptions,
            &answers,
            &o.request.monitoring_set(),
        );
        store::save_engine(&mut o.tx, o.request.id, &output, o.now).await?;
        let texts: Vec<String> = answers
            .values()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        if !o.request.alerted()
            && let Some(hit) = red_flag_in(&state, &texts)
        {
            alert(
                &state,
                &mut o.tx,
                &user,
                &mut o.request,
                &UrgentNotice::from_text(&hit),
                o.now,
            )
            .await?;
        }
    }
    o.tx.commit().await?;
    Ok(Json(store::view_fresh(&state, o.request.id, &user).await?))
}

async fn submit(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    key: IdempotencyKey,
    ApiJson(body): ApiJson<Map<String, Value>>,
) -> AppResult<Response> {
    user.require(Permission::RxOwn)?;
    let route = format!("POST /rx/{id}/submit");
    idem::run(&state, user.id, key, &route, || async {
        Ok((StatusCode::OK, submit_now(&state, &user, &id, &body).await?))
    })
    .await
}

async fn submit_now(
    state: &AppState,
    user: &CurrentUser,
    id: &str,
    body: &Map<String, Value>,
) -> AppResult<Value> {
    let locale = user.locale;
    let revision = revision_of(body, locale)?;
    let consent = text_of(body, "consent_version", 40, locale)?;
    let mut o = open(state, user, id, Action::Submit, Some(revision)).await?;
    let list = store::items(&mut o.tx, o.request.id).await?;
    let prescriptions = store::item_prescriptions(&mut o.tx, &list).await?;
    let days_left = store::min_days_left(&prescriptions, state.clock.today());
    let actor = Some(user.id);

    let mut urgent: Option<UrgentNotice> = None;
    let mut priority = Urgency::Routine;
    if o.request.kind == RxKind::Renewal {
        let answers = o.request.answers_map();
        let monitoring = o.request.monitoring_set();
        let (open_items, left_out): (Vec<Item>, Vec<Item>) = list.iter().cloned().partition(|i| {
            super::engine::scope_for(
                &state.rx.formulary,
                i.drug_id.as_deref().unwrap_or(""),
                i.controlled_level.clamp(0, 4) as u8,
            )
            .0 != RenewalScope::Excluded
        });
        if open_items.is_empty() {
            let output = store::run_engine(state, &list, &prescriptions, &answers, &monitoring);
            store::save_engine(&mut o.tx, o.request.id, &output, o.now).await?;
            o.tx.commit().await?;
            return Err(AppError::UnprocessableWith(
                BTreeMap::from([(
                    "items".to_string(),
                    rt(R::ErrAllExcluded, locale).to_string(),
                )]),
                store::view_fresh(state, o.request.id, user).await?,
            ));
        }
        let output = store::run_engine(state, &open_items, &prescriptions, &answers, &monitoring);
        urgent = output.urgent.clone();
        // An emergency is never held up by a form that is not complete.
        if urgent.is_none() {
            let questions = store::questions(state, o.request.kind, &open_items, locale);
            let mut errors = protocol::missing_required(&questions, &answers, locale);
            if o.request.pharmacy_id.is_none() {
                errors.insert(
                    "pharmacy_id".into(),
                    rt(R::ErrPharmacyRequired, locale).into(),
                );
            }
            if consent.is_none() {
                errors.insert(
                    "consent_version".into(),
                    rt(R::ErrConsentVersion, locale).into(),
                );
            }
            if !errors.is_empty() {
                return Err(AppError::Unprocessable(errors));
            }
        }
        if !left_out.is_empty() {
            let ids: Vec<Uuid> = left_out.iter().map(|i| i.id).collect();
            sqlx::query("DELETE FROM rx_request_items WHERE id = ANY($1)")
                .bind(&ids)
                .execute(&mut *o.tx)
                .await?;
        }
        store::save_engine(&mut o.tx, o.request.id, &output, o.now).await?;
        priority = output.priority(days_left);
        let (step, kind) = if urgent.is_some() {
            (Step::SubmitUrgent, ev::SUBMITTED)
        } else {
            (Step::Submit, ev::SUBMITTED)
        };
        store::advance(
            &mut o.tx,
            &mut o.request,
            step,
            o.now,
            NewEvent::new(kind, actor),
        )
        .await?;
        if !left_out.is_empty() {
            let names = |en: bool| -> String {
                left_out
                    .iter()
                    .map(|i| {
                        let n = i.name();
                        if en { n.en } else { n.zh }
                    })
                    .collect::<Vec<_>>()
                    .join(if en { ", " } else { "、" })
            };
            store::add_event(
                &mut o.tx,
                o.request.id,
                o.now,
                NewEvent::new(ev::ITEMS_LEFT_OUT, None)
                    .data(json!({ "drugs": names(false), "drugs_en": names(true) })),
            )
            .await?;
        }
    } else {
        let questions = store::questions(state, o.request.kind, &list, locale);
        let mut errors = protocol::missing_required(&questions, &o.request.answers_map(), locale);
        if o.request.pharmacy_id.is_none() {
            errors.insert(
                "pharmacy_id".into(),
                rt(R::ErrPharmacyRequired, locale).into(),
            );
        }
        let pickup = o.request.pickup_window.as_ref();
        if pickup.is_none() {
            errors.insert(
                "pickup_window".into(),
                rt(R::ErrPickupRequired, locale).into(),
            );
        }
        if consent.is_none() {
            errors.insert(
                "consent_version".into(),
                rt(R::ErrConsentVersion, locale).into(),
            );
        }
        if !errors.is_empty() {
            return Err(AppError::Unprocessable(errors));
        }
        // The saved date may have passed while the draft waited.
        if let Some(saved) = pickup {
            pickup_window(state, saved, locale)?;
        }
        let checked = refill_check(state, &mut o.tx, &o.request, &list, locale)
            .await?
            .ok_or(AppError::InvalidState("there is nothing to refill"))?;
        if !medications::is_eligible(&checked.result) {
            let mut result = checked.result;
            o.tx.commit().await?;
            if let Some(plan) = checked.ticket {
                let created = tickets::open(
                    state,
                    NewTicket {
                        source: tickets::Source::Rx {
                            request_id: o.request.id,
                            patient_id: o.request.patient_id,
                        },
                        reason: plan.reason,
                        urgency: plan.urgency,
                        summary: &plan.summary,
                        created_by: CreatedBy::Form,
                    },
                )
                .await?;
                result.ticket_no = Some(created.ticket.ticket_no);
            }
            return Err(AppError::UnprocessableWith(
                BTreeMap::from([("items".to_string(), result.message.clone())]),
                json!(result),
            ));
        }
        if days_left.is_some_and(|d| d == 0) {
            priority = Urgency::Soon;
        }
        store::advance(
            &mut o.tx,
            &mut o.request,
            Step::Submit,
            o.now,
            NewEvent::new(ev::SUBMITTED, actor),
        )
        .await?;
    }

    let priority = store::more_urgent(priority, o.request.priority);
    let due = store::sla_due(state, priority, o.now);
    sqlx::query("UPDATE rx_requests SET submitted_at = $2, priority = $3, sla_due_at = $4, consent_version = $5 WHERE id = $1")
        .bind(o.request.id)
        .bind(o.now)
        .bind(priority.as_str())
        .bind(due)
        .bind(&consent)
        .execute(&mut *o.tx)
        .await?;
    o.request.priority = priority;
    o.request.submitted_at = Some(o.now);
    if let Some(version) = &consent {
        sqlx::query("INSERT INTO consents (account_id, doc, version, granted) VALUES ($1, 'rx_review', $2, true)")
            .bind(user.id)
            .bind(version)
            .execute(&mut *o.tx)
            .await?;
    }
    if let Some(notice) = &urgent {
        alert(state, &mut o.tx, user, &mut o.request, notice, o.now).await?;
    }
    o.tx.commit().await?;

    let r = &o.request;
    match (r.kind, urgent.is_some()) {
        // The red-flag notification already went out.
        (_, true) => {}
        (RxKind::Refill, _) => tell_pharmacists_new(state, r).await,
        (RxKind::Renewal, _) => {
            notify::notify_staff(
                state,
                Permission::VisitReview,
                Kind::RxNew,
                new_params(r),
                &clinic_link(r),
                None,
            )
            .await
        }
    }
    record(state, user, r, "rx.submit", json!({ "priority": priority })).await;
    store::view_fresh(state, r.id, user).await
}

/// Audit row and live update after a change.
async fn record(state: &AppState, user: &CurrentUser, r: &Request, action: &str, detail: Value) {
    let mut detail = detail;
    detail["status"] = json!(r.status.as_str());
    audit(
        &state.db,
        Some(user),
        AuditKind::Rx,
        action,
        &format!("rx:{}", r.id),
        detail,
    )
    .await;
    announce(state, r);
}

async fn cancel(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Map<String, Value>>,
) -> AppResult<Json<Value>> {
    let revision = revision_of(&body, user.locale)?;
    let mut o = open(&state, &user, &id, Action::Cancel, Some(revision)).await?;
    store::advance(
        &mut o.tx,
        &mut o.request,
        Step::Cancel,
        o.now,
        NewEvent::new(ev::CANCELLED, Some(user.id)),
    )
    .await?;
    o.tx.commit().await?;
    let r = &o.request;
    if r.submitted_at.is_some()
        && let Some(holder) = r.assigned_to.or(r.decided_by)
    {
        notify::notify(
            &state,
            holder,
            Kind::RxStatus,
            json!({ "no": r.no, "status": r.status.as_str() }),
            &clinic_link(r),
        )
        .await;
    }
    record(&state, &user, r, "rx.cancel", json!({})).await;
    Ok(Json(store::view_fresh(&state, r.id, &user).await?))
}

/// The patient answers the physician's question: back to review, with the new answers checked again.
async fn reply(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Map<String, Value>>,
) -> AppResult<Json<Value>> {
    let locale = user.locale;
    let revision = revision_of(&body, locale)?;
    let text = text_of(&body, "body", MAX_MESSAGE_CHARS, locale)?
        .ok_or_else(|| AppError::field("body", rt(R::ErrMessageEmpty, locale)))?;
    let text = pii::mask(&text).text;
    let mut o = open(&state, &user, &id, Action::Reply, Some(revision)).await?;
    let list = store::items(&mut o.tx, o.request.id).await?;
    let patched = apply_patch(&state, &o.request, &list, &body, locale)?;
    save_answers(&mut o.tx, &mut o.request, &patched).await?;
    let mut urgent: Option<UrgentNotice> = None;
    let mut priority = o.request.priority;
    if o.request.kind == RxKind::Renewal {
        let prescriptions = store::item_prescriptions(&mut o.tx, &list).await?;
        let output = store::run_engine(
            &state,
            &list,
            &prescriptions,
            &patched.answers,
            &patched.monitoring,
        );
        store::save_engine(&mut o.tx, o.request.id, &output, o.now).await?;
        let days_left = store::min_days_left(&prescriptions, state.clock.today());
        priority = store::more_urgent(priority, output.priority(days_left));
        urgent = output.urgent;
    }
    let mut texts = patched.texts;
    texts.push(text.clone());
    if let Some(hit) = red_flag_in(&state, &texts) {
        urgent = Some(UrgentNotice::from_text(&hit));
    }
    store::add_message(&mut o.tx, o.request.id, user.id, &text, false, o.now).await?;
    store::advance(
        &mut o.tx,
        &mut o.request,
        Step::Reply,
        o.now,
        NewEvent::new(ev::REPLIED, Some(user.id)),
    )
    .await?;
    // The question is answered; every item is decided again.
    sqlx::query("UPDATE rx_request_items SET outcome = NULL, outcome_note = NULL, decided_by = NULL, decided_at = NULL WHERE request_id = $1")
        .bind(o.request.id)
        .execute(&mut *o.tx)
        .await?;
    sqlx::query("UPDATE rx_requests SET priority = $2, sla_due_at = $3, overdue_notified_at = NULL WHERE id = $1")
        .bind(o.request.id)
        .bind(priority.as_str())
        .bind(store::sla_due(&state, priority, o.now))
        .execute(&mut *o.tx)
        .await?;
    if let Some(notice) = &urgent {
        alert(&state, &mut o.tx, &user, &mut o.request, notice, o.now).await?;
    }
    o.tx.commit().await?;
    let r = &o.request;
    let params = json!({ "no": r.no, "actor_id": user.id });
    match r.assigned_to.or(r.decided_by) {
        Some(id) => notify::notify(&state, id, Kind::RxMessage, params, &clinic_link(r)).await,
        None => {
            notify::notify_staff(
                &state,
                Permission::RxDecide,
                Kind::RxMessage,
                params,
                &clinic_link(r),
                None,
            )
            .await
        }
    }
    record(&state, &user, r, "rx.reply", json!({})).await;
    Ok(Json(store::view_fresh(&state, r.id, &user).await?))
}

async fn message(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    key: IdempotencyKey,
    ApiJson(body): ApiJson<Map<String, Value>>,
) -> AppResult<Response> {
    may_use_rx(&user)?;
    let route = format!("POST /rx/{id}/messages");
    idem::run(&state, user.id, key, &route, || async {
        Ok((
            StatusCode::CREATED,
            message_now(&state, &user, &id, &body).await?,
        ))
    })
    .await
}

async fn message_now(
    state: &AppState,
    user: &CurrentUser,
    id: &str,
    body: &Map<String, Value>,
) -> AppResult<Value> {
    let locale = user.locale;
    let text = text_of(body, "body", MAX_MESSAGE_CHARS, locale)?
        .ok_or_else(|| AppError::field("body", rt(R::ErrMessageEmpty, locale)))?;
    let staff_only = match body.get("visibility").and_then(Value::as_str) {
        None | Some("all") => false,
        Some("staff") => true,
        Some(_) => {
            return Err(AppError::field("visibility", t(T::FieldErrChoice, locale)));
        }
    };
    let action = if staff_only {
        Action::StaffMessage
    } else {
        Action::Message
    };
    let mut o = open(state, user, id, action, None).await?;
    let mine = o.request.patient_id == user.id;
    let text = if mine { pii::mask(&text).text } else { text };
    store::add_message(&mut o.tx, o.request.id, user.id, &text, staff_only, o.now).await?;
    sqlx::query("UPDATE rx_requests SET updated_at = $2 WHERE id = $1")
        .bind(o.request.id)
        .bind(o.now)
        .execute(&mut *o.tx)
        .await?;
    if mine && let Some(hit) = red_flag_in(state, std::slice::from_ref(&text)) {
        alert(
            state,
            &mut o.tx,
            user,
            &mut o.request,
            &UrgentNotice::from_text(&hit),
            o.now,
        )
        .await?;
    }
    o.tx.commit().await?;
    let r = &o.request;
    let params = json!({ "no": r.no, "actor_id": user.id });
    if !mine && !staff_only {
        notify::notify(
            state,
            r.patient_id,
            Kind::RxMessage,
            params,
            &patient_link(r),
        )
        .await;
    } else {
        let (permission, link) = desk(r);
        match r.assigned_to {
            Some(id) if id != user.id => {
                notify::notify(state, id, Kind::RxMessage, params, &link).await
            }
            Some(_) => {}
            None if mine => {
                notify::notify_staff(state, permission, Kind::RxMessage, params, &link, None).await
            }
            None => {}
        }
    }
    record(
        state,
        user,
        r,
        "rx.message",
        json!({ "visibility": if staff_only { "staff" } else { "all" } }),
    )
    .await;
    store::view_fresh(state, r.id, user).await
}

// ---------------------------------------------------------------------------
// Staff: assigning and deciding
// ---------------------------------------------------------------------------

async fn assign(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Map<String, Value>>,
) -> AppResult<Json<Value>> {
    let locale = user.locale;
    let bad = || AppError::field("account_id", rt(R::ErrAssignee, locale));
    let target: Option<(Uuid, Role)> = match body.get("account_id") {
        Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let id = Uuid::parse_str(s).map_err(|_| bad())?;
            let role: Option<String> =
                sqlx::query_scalar("SELECT role FROM accounts WHERE id = $1 AND status = 'active'")
                    .bind(id)
                    .fetch_optional(&state.db)
                    .await?;
            let role = role
                .as_deref()
                .and_then(Role::parse)
                .filter(|r| r.can(Permission::RxRead))
                .ok_or_else(bad)?;
            Some((id, role))
        }
        _ => return Err(bad()),
    };
    let mut o = open(&state, &user, &id, Action::Assign, None).await?;
    sqlx::query("UPDATE rx_requests SET assigned_to = $2, updated_at = $3 WHERE id = $1")
        .bind(o.request.id)
        .bind(target.map(|t| t.0))
        .bind(o.now)
        .execute(&mut *o.tx)
        .await?;
    o.request.assigned_to = target.map(|t| t.0);
    let event = match target {
        Some((id, _)) => {
            NewEvent::new(ev::ASSIGNED, Some(user.id)).data(json!({ "assignee_id": id }))
        }
        None => NewEvent::new(ev::UNASSIGNED, Some(user.id)),
    };
    store::add_event(&mut o.tx, o.request.id, o.now, event.staff()).await?;
    // Giving it to a physician starts the review.
    let starts = target.is_some_and(|(_, role)| role.can(Permission::RxDecide))
        && o.request.status == RxStatus::Submitted
        && machine::next(o.request.kind, o.request.status, Step::StartReview).is_some();
    if starts {
        store::advance(
            &mut o.tx,
            &mut o.request,
            Step::StartReview,
            o.now,
            NewEvent::new(ev::REVIEW_STARTED, target.map(|t| t.0)),
        )
        .await?;
    }
    o.tx.commit().await?;
    let r = &o.request;
    if let Some((id, role)) = target
        && id != user.id
    {
        let link = if role.can(Permission::RxDispense) {
            pharmacy_link(r)
        } else {
            clinic_link(r)
        };
        notify::notify(&state, id, Kind::RxNew, new_params(r), &link).await;
    }
    record(
        &state,
        &user,
        r,
        "rx.assign",
        json!({ "to": target.map(|t| t.0) }),
    )
    .await;
    Ok(Json(store::view_fresh(&state, r.id, &user).await?))
}

#[derive(Deserialize)]
struct DecideBody {
    revision: i32,
    items: Vec<ItemDecision>,
    note: Option<String>,
    patient_message: Option<String>,
}

fn capped(text: Option<String>, field: &str, locale: Locale) -> AppResult<Option<String>> {
    let text = text.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if text
        .as_deref()
        .is_some_and(|s| s.chars().count() > MAX_NOTE_CHARS)
    {
        return Err(AppError::field(
            field,
            rf(
                R::ErrTextLength,
                locale,
                &[("max", &MAX_NOTE_CHARS.to_string())],
            ),
        ));
    }
    Ok(text)
}

/// The physician's decision on every item. Only an approval sends anything on, and only what was approved.
async fn decide(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<DecideBody>,
) -> AppResult<Json<Value>> {
    let locale = user.locale;
    let note = capped(body.note, "note", locale)?;
    let patient_message = capped(body.patient_message, "patient_message", locale)?;
    let mut decisions = body.items;
    for d in &mut decisions {
        d.note = capped(d.note.take(), &d.item_id, locale)?;
    }
    let mut o = open(&state, &user, &id, Action::Decide, Some(body.revision)).await?;
    let list = store::items(&mut o.tx, o.request.id).await?;
    let decidable: Vec<DecidableItem> = list
        .iter()
        .map(|i| DecidableItem {
            item_id: i.id.to_string(),
            engine: i.engine_result().map(|r| r.disposition),
        })
        .collect();
    let step = machine::check_decision(
        &decidable,
        &decisions,
        &patient_message,
        o.request.pharmacy_id.is_some(),
        locale,
    )
    .map_err(AppError::Unprocessable)?;

    let actor = Some(user.id);
    if o.request.status != RxStatus::InReview {
        store::advance(
            &mut o.tx,
            &mut o.request,
            Step::StartReview,
            o.now,
            NewEvent::new(ev::REVIEW_STARTED, actor),
        )
        .await?;
    }
    for d in &decisions {
        sqlx::query("UPDATE rx_request_items SET outcome = $3, outcome_note = $4, decided_by = $5, decided_at = $6 WHERE request_id = $1 AND id::text = $2")
            .bind(o.request.id)
            .bind(&d.item_id)
            .bind(d.outcome.as_str())
            .bind(&d.note)
            .bind(user.id)
            .bind(o.now)
            .execute(&mut *o.tx)
            .await?;
    }
    let kind = match step {
        Step::Approve => ev::APPROVED,
        Step::PartiallyApprove => ev::PARTIALLY_APPROVED,
        Step::Decline => ev::DECLINED,
        Step::RequireVisit => ev::VISIT_REQUIRED,
        _ => ev::MORE_INFO,
    };
    store::advance(
        &mut o.tx,
        &mut o.request,
        step,
        o.now,
        NewEvent::new(kind, actor),
    )
    .await?;
    // `decided_at` of the request is the first decision (for turnaround); the items keep their latest.
    sqlx::query("UPDATE rx_requests SET decision_note = $2, patient_message = $3, decided_by = $4, decided_at = COALESCE(decided_at, $5), assigned_to = COALESCE(assigned_to, $4) WHERE id = $1")
        .bind(o.request.id)
        .bind(&note)
        .bind(&patient_message)
        .bind(user.id)
        .bind(o.now)
        .execute(&mut *o.tx)
        .await?;
    o.request.decided_by = actor;
    if let Some(text) = &patient_message {
        store::add_message(&mut o.tx, o.request.id, user.id, text, false, o.now).await?;
    }
    let approved = matches!(step, Step::Approve | Step::PartiallyApprove);
    if approved {
        let shop = store::pharmacy(&mut o.tx, o.request.pharmacy_id.as_deref()).await?;
        let data = shop
            .map(|p| json!({ "pharmacy": p.name, "pharmacy_en": p.name_en }))
            .unwrap_or(json!({}));
        store::advance(
            &mut o.tx,
            &mut o.request,
            Step::SendToPharmacy,
            o.now,
            NewEvent::new(ev::SENT_TO_PHARMACY, None).data(data),
        )
        .await?;
        // The pharmacy takes over.
        sqlx::query("UPDATE rx_requests SET assigned_to = NULL WHERE id = $1")
            .bind(o.request.id)
            .execute(&mut *o.tx)
            .await?;
        o.request.assigned_to = None;
    }
    o.tx.commit().await?;

    let r = &o.request;
    if step == Step::AskMore {
        notify::notify(
            &state,
            r.patient_id,
            Kind::RxMoreInfo,
            json!({ "no": r.no }),
            &patient_link(r),
        )
        .await;
    } else {
        tell_patient_status(&state, r).await;
    }
    if approved {
        tell_pharmacists_new(&state, r).await;
    }
    let outcomes: Vec<&str> = decisions.iter().map(|d| d.outcome.as_str()).collect();
    record(
        &state,
        &user,
        r,
        "rx.decide",
        json!({ "outcomes": outcomes }),
    )
    .await;
    Ok(Json(store::view_fresh(&state, r.id, &user).await?))
}

// ---------------------------------------------------------------------------
// The pharmacist's side
// ---------------------------------------------------------------------------

async fn pharmacy_action(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Map<String, Value>>,
) -> AppResult<Json<Value>> {
    let locale = user.locale;
    user.require(Permission::RxDispense)?;
    let revision = revision_of(&body, locale)?;
    let note = text_of(&body, "note", MAX_NOTE_CHARS, locale)?;
    let (action, step) = match body.get("action").and_then(Value::as_str) {
        Some("accept") => (Action::Accept, Step::Accept),
        Some("ready") => (Action::MarkReady, Step::MarkReady),
        Some("dispense") => (Action::Dispense, Step::Dispense),
        Some("return") => (Action::Return, Step::Return),
        Some("ask_physician") => (Action::AskPhysician, Step::AskPhysician),
        _ => return Err(AppError::field("action", t(T::FieldErrChoice, locale))),
    };
    if matches!(step, Step::Return | Step::AskPhysician) && note.is_none() {
        return Err(AppError::field("note", rt(R::ErrReturnNote, locale)));
    }
    let checks: DispenseChecks = body
        .get("checks")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let mut o = open(&state, &user, &id, action, Some(revision)).await?;
    let actor = Some(user.id);
    match step {
        Step::Accept => {
            store::advance(
                &mut o.tx,
                &mut o.request,
                step,
                o.now,
                NewEvent::new(ev::ACCEPTED, actor),
            )
            .await?;
            sqlx::query("UPDATE rx_requests SET assigned_to = $2 WHERE id = $1")
                .bind(o.request.id)
                .bind(user.id)
                .execute(&mut *o.tx)
                .await?;
        }
        Step::MarkReady => {
            store::advance(
                &mut o.tx,
                &mut o.request,
                step,
                o.now,
                NewEvent::new(ev::READY, actor),
            )
            .await?;
            sqlx::query("UPDATE rx_requests SET ready_at = $2, assigned_to = COALESCE(assigned_to, $3) WHERE id = $1")
                .bind(o.request.id)
                .bind(o.now)
                .bind(user.id)
                .execute(&mut *o.tx)
                .await?;
        }
        Step::Dispense => dispense(&state, &user, &mut o, checks).await?,
        Step::Return => {
            let note = note.clone().unwrap_or_default();
            store::advance(
                &mut o.tx,
                &mut o.request,
                step,
                o.now,
                NewEvent::new(ev::RETURNED, actor).data(json!({ "note": note })),
            )
            .await?;
        }
        _ => {
            store::advance(
                &mut o.tx,
                &mut o.request,
                Step::AskPhysician,
                o.now,
                NewEvent::new(ev::ASKED_PHYSICIAN, actor),
            )
            .await?;
            // What the pharmacist asks is between staff.
            store::add_message(
                &mut o.tx,
                o.request.id,
                user.id,
                note.as_deref().unwrap_or(""),
                true,
                o.now,
            )
            .await?;
            let priority = store::more_urgent(o.request.priority, Urgency::Soon);
            sqlx::query("UPDATE rx_requests SET assigned_to = $2, priority = $3, sla_due_at = $4, overdue_notified_at = NULL WHERE id = $1")
                .bind(o.request.id)
                .bind(o.request.decided_by)
                .bind(priority.as_str())
                .bind(store::sla_due(&state, priority, o.now))
                .execute(&mut *o.tx)
                .await?;
        }
    }
    o.tx.commit().await?;

    let r = &o.request;
    if step == Step::MarkReady {
        let mut conn = state.db.acquire().await?;
        let shop = store::pharmacy(&mut conn, r.pharmacy_id.as_deref()).await?;
        drop(conn);
        let (name, name_en) = shop.map(|p| (p.name, p.name_en)).unwrap_or_default();
        notify::notify(
            &state,
            r.patient_id,
            Kind::RxReady,
            json!({ "no": r.no, "pharmacy": name, "pharmacy_en": name_en }),
            &patient_link(r),
        )
        .await;
    } else {
        tell_patient_status(&state, r).await;
    }
    if step == Step::AskPhysician || (step == Step::Return && r.kind == RxKind::Renewal) {
        tell_physicians_status(&state, r).await;
    }
    record(
        &state,
        &user,
        r,
        "rx.pharmacy",
        json!({ "action": action.as_str() }),
    )
    .await;
    Ok(Json(store::view_fresh(&state, r.id, &user).await?))
}

/// Handing over: all four checks, and for a refill the refill check once more for the day it is handed over.
async fn dispense(
    state: &AppState,
    user: &CurrentUser,
    o: &mut Open,
    checks: DispenseChecks,
) -> AppResult<()> {
    let locale = user.locale;
    if !checks.complete() {
        return Err(AppError::field("checks", rt(R::ErrDispenseChecks, locale)));
    }
    let today = state.clock.today();
    let list = store::items(&mut o.tx, o.request.id).await?;
    let shop = store::pharmacy(&mut o.tx, o.request.pharmacy_id.as_deref()).await?;
    let actor = Some(user.id);
    let mut events: Vec<NewEvent<'_>> = Vec::new();
    if o.request.kind == RxKind::Refill {
        let checked = refill_check(state, &mut o.tx, &o.request, &list, locale)
            .await?
            .ok_or(AppError::InvalidState("there is nothing to refill"))?;
        if !medications::is_eligible(&checked.result) {
            return Err(AppError::UnprocessableWith(
                BTreeMap::from([("items".to_string(), checked.result.message.clone())]),
                json!(checked.result),
            ));
        }
        let prescriptions = store::item_prescriptions(&mut o.tx, &list).await?;
        for item in &list {
            let n = prescriptions
                .get(&item.prescription_id.to_string())
                .map_or(0, |p| p.fills_done())
                + 1;
            store::add_fill(
                &mut o.tx,
                item.prescription_id,
                n,
                today,
                shop.as_ref(),
                actor,
                o.request.id,
            )
            .await?;
            events.push(NewEvent::new(ev::FILL_RECORDED, actor).data(json!({ "n": n })));
        }
    } else {
        for item in list
            .iter()
            .filter(|i| i.outcome.as_deref() == Some(DecisionOutcome::Approve.as_str()))
        {
            let id = store::next_prescription(
                &mut o.tx,
                item.prescription_id,
                &o.request,
                today,
                &state.rules.refill,
            )
            .await?;
            store::add_fill(&mut o.tx, id, 1, today, shop.as_ref(), actor, o.request.id).await?;
            events.push(NewEvent::new(ev::NEXT_PRESCRIPTION, None));
        }
    }
    store::advance(
        &mut o.tx,
        &mut o.request,
        Step::Dispense,
        o.now,
        NewEvent::new(ev::DISPENSED, actor),
    )
    .await?;
    sqlx::query("UPDATE rx_requests SET pharmacy_checks = $2 WHERE id = $1")
        .bind(o.request.id)
        .bind(json!(checks))
        .execute(&mut *o.tx)
        .await?;
    for event in events {
        store::add_event(&mut o.tx, o.request.id, o.now, event).await?;
    }
    Ok(())
}
