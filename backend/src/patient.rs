//! The patient's own pages: home, who read my data, consents, pharmacies, handbook, export and account deletion.

use axum::Json;
use axum::extract::{Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_DISPOSITION};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::appts;
use crate::audit::{self, AuditKind};
use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult, request_locale};
use crate::health_edu::Section;
use crate::http::ApiJson;
use crate::measure;
use crate::page::{self, Cursor, Page, Params};
use crate::people::{self, PersonRef};
use crate::perm::{Permission, Role};
use crate::profile;
use crate::state::AppState;
use crate::texts::{T, fmt, t};
use crate::types::{Visit, VisitStatus};
use crate::visits::{self, visit_cols, visits_with_urgency};

/// Current versions of the consent documents.
pub const CONSENT_VERSIONS: [(&str, &str); 3] = [
    ("terms", "2026-11"),
    ("ai_disclosure", "2026-11"),
    ("rx_review", "2026-11"),
];

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct Task {
    kind: &'static str,
    title: String,
    link: String,
    due_at: Option<String>,
}

pub async fn home(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require(Permission::VisitOwn)?;
    let db = &state.db;
    let locale = user.locale;
    let now = state.clock.now();
    let next = appts::next_for_patient(db, user.id, now).await?;
    let next_view = match &next {
        Some(row) => appts::views(db, std::slice::from_ref(row), locale)
            .await?
            .into_iter()
            .next(),
        None => None,
    };
    let rows: Vec<Visit> = sqlx::query_as(concat!(
        "SELECT ",
        visit_cols!(),
        " FROM ",
        visits_with_urgency!(),
        " v WHERE v.patient_id = $1 AND NOT v.archived AND (v.last_activity_at >= $2 OR v.is_demo) ORDER BY v.last_activity_at DESC, v.id DESC LIMIT 50"
    ))
    .bind(user.id)
    .bind(visits::retention_cutoff(&state))
    .fetch_all(db)
    .await?;
    let views = visits::views(db, rows, Some(&user), locale).await?;
    let medications = crate::rx::medications_for(&state, user.id, locale).await?;
    let requests = crate::rx::briefs_for(&state, user.id, &user, true).await?;
    let unread = views.iter().filter(|v| v.has_unread).count()
        + requests.iter().filter(|r| r["unread"] == true).count();

    let mut tasks: Vec<Task> = Vec::new();
    for visit in &views {
        if visit.status == VisitStatus::RedFlag && visit.reviewed_at.is_none() {
            tasks.push(Task {
                kind: "red_flag",
                title: t(T::TaskRedFlag, locale).to_string(),
                link: format!("/app/visits/{}", visit.id),
                due_at: None,
            });
            break;
        }
    }
    if let Some(next) = &next {
        let previsit = views
            .iter()
            .find(|v| v.appointment.as_ref().is_some_and(|a| a.id == next.id));
        if previsit.is_none_or(|v| v.submitted_at.is_none() && v.status == VisitStatus::Active) {
            tasks.push(Task {
                kind: "previsit",
                title: t(T::TaskPrevisit, locale).to_string(),
                link: previsit
                    .map(|v| format!("/app/visits/{}", v.id))
                    .unwrap_or_else(|| "/app/appointments".into()),
                due_at: Some(visits::rfc3339(next.starts_at)),
            });
        }
    }
    for request in &requests {
        let kind = match request["status"].as_str() {
            Some("more_info") => ("rx_more_info", T::TaskRxMoreInfo),
            Some("ready") => ("rx_ready", T::TaskRxReady),
            Some("draft") => ("rx_draft", T::TaskRxDraft),
            _ => continue,
        };
        let drugs: Vec<&str> = request["drug_names"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        tasks.push(Task {
            kind: kind.0,
            title: fmt(
                kind.1,
                locale,
                &[
                    ("no", request["no"].as_str().unwrap_or("")),
                    (
                        "drugs",
                        &drugs.join(if locale.is_en() { ", " } else { "、" }),
                    ),
                ],
            ),
            link: format!("/app/rx/{}", request["id"].as_str().unwrap_or("")),
            due_at: None,
        });
    }
    for card in &medications {
        if !card["open_request_id"].is_null() {
            continue;
        }
        let name = card["drug"][if locale.is_en() { "name_en" } else { "name_zh" }]
            .as_str()
            .unwrap_or("");
        let (kind, text, due) = match card["state"].as_str() {
            Some("window_open" | "late") => {
                ("refill", T::TaskRefill, card["next_window"]["to"].as_str())
            }
            Some("finished" | "expired") if card["renewal_scope"] == "in_scope" => {
                ("renewal", T::TaskRenewal, None)
            }
            _ => continue,
        };
        tasks.push(Task {
            kind,
            title: fmt(text, locale, &[("drug", name)]),
            link: "/app/medications".into(),
            due_at: due.map(str::to_string),
        });
    }
    let consented: bool = sqlx::query_scalar(
        "SELECT COALESCE((SELECT granted FROM consents WHERE account_id = $1 AND doc = 'ai_disclosure' ORDER BY created_at DESC LIMIT 1), false)",
    )
    .bind(user.id)
    .fetch_one(db)
    .await?;
    if !consented {
        tasks.push(Task {
            kind: "consent",
            title: t(T::TaskConsent, locale).to_string(),
            link: "/app/privacy".into(),
            due_at: None,
        });
    }
    let active: Vec<_> = views
        .into_iter()
        .filter(|v| matches!(v.status, VisitStatus::Active | VisitStatus::RedFlag))
        .collect();
    Ok(Json(json!({
        "next_appointment": next_view,
        "active_visits": active,
        "medications": medications,
        "active_requests": requests,
        "unread": unread,
        "tasks": tasks,
    })))
}

// ---------------------------------------------------------------------------
// Who read my data
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct AccessRow {
    id: Uuid,
    at: OffsetDateTime,
    actor_id: Option<Uuid>,
    actor_name: String,
    actor_role: String,
    action: String,
    resource: String,
}

#[derive(Debug, Serialize)]
pub struct AccessEntry {
    #[serde(with = "time::serde::rfc3339")]
    at: OffsetDateTime,
    actor: PersonRef,
    action: String,
    resource: String,
}

pub async fn access_log(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Params>,
) -> AppResult<Json<Page<AccessEntry>>> {
    user.require(Permission::ProfileOwn)?;
    let limit = page::limit(&params)?;
    let cursor = page::cursor(&params)?;
    let rows: Vec<AccessRow> = sqlx::query_as(
        "SELECT id, at, actor_id, actor_name, actor_role, action, resource FROM access_log
         WHERE patient_id = $1 AND ($2::timestamptz IS NULL OR (at, id) < ($2, $3)) ORDER BY at DESC, id DESC LIMIT $4",
    )
    .bind(user.id)
    .bind(cursor.map(|c| c.at))
    .bind(cursor.map(|c| c.id))
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let cut = page::cut(rows, limit, |r| Cursor { at: r.at, id: r.id });
    let people = people::load(
        &state.db,
        cut.items.iter().filter_map(|r| r.actor_id),
        user.locale,
    )
    .await?;
    Ok(Json(Page {
        items: cut
            .items
            .into_iter()
            .map(|r| AccessEntry {
                at: r.at,
                actor: people
                    .get(r.actor_id)
                    .unwrap_or_else(|| past_person(r.actor_id, &r.actor_name, &r.actor_role)),
                action: r.action,
                resource: r.resource,
            })
            .collect(),
        next_cursor: cut.next_cursor,
        total: None,
    }))
}

/// Someone whose account is gone: the name and role written down at the time.
pub fn past_person(id: Option<Uuid>, name: &str, role: &str) -> PersonRef {
    PersonRef {
        id: id.unwrap_or_default(),
        display_name: name.to_string(),
        role: Role::parse(role).unwrap_or(Role::Admin),
        title: None,
        avatar: None,
    }
}

// ---------------------------------------------------------------------------
// Consents
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Consent {
    doc: String,
    version: String,
    granted: bool,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

/// The whole history, newest first; the first entry of each document is the one that counts.
pub async fn consents(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require(Permission::ProfileOwn)?;
    let rows: Vec<Consent> = sqlx::query_as("SELECT doc, version, granted, created_at FROM consents WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200")
        .bind(user.id)
        .fetch_all(&state.db)
        .await?;
    let current: serde_json::Map<String, Value> = CONSENT_VERSIONS
        .iter()
        .map(|(doc, version)| (doc.to_string(), json!(version)))
        .collect();
    Ok(Json(
        json!({ "items": rows, "next_cursor": null, "current_versions": current }),
    ))
}

#[derive(Deserialize)]
pub struct ConsentBody {
    doc: String,
    version: String,
    granted: bool,
}

pub async fn add_consent(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiJson(body): ApiJson<ConsentBody>,
) -> AppResult<(StatusCode, Json<Consent>)> {
    user.require(Permission::ProfileOwn)?;
    if !CONSENT_VERSIONS.iter().any(|(doc, _)| *doc == body.doc) {
        return Err(AppError::field("doc", t(T::FieldErrChoice, user.locale)));
    }
    if body.version.is_empty() || body.version.len() > 20 || !body.version.is_ascii() {
        return Err(AppError::field(
            "version",
            t(T::FieldErrChoice, user.locale),
        ));
    }
    let row: Consent = sqlx::query_as("INSERT INTO consents (account_id, doc, version, granted) VALUES ($1, $2, $3, $4) RETURNING doc, version, granted, created_at")
        .bind(user.id)
        .bind(&body.doc)
        .bind(&body.version)
        .bind(body.granted)
        .fetch_one(&state.db)
        .await?;
    Ok((StatusCode::CREATED, Json(row)))
}

// ---------------------------------------------------------------------------
// Pharmacies and the handbook
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct Pharmacy {
    pub id: String,
    pub name: String,
    pub district: String,
    pub address: String,
    pub hours: String,
    pub services: Value,
}

#[derive(sqlx::FromRow)]
struct PharmacyRow {
    id: String,
    name: String,
    name_en: String,
    district: String,
    district_en: String,
    address: String,
    address_en: String,
    hours: String,
    hours_en: String,
    services: Value,
    services_en: Value,
}

pub async fn pharmacies(
    State(state): State<AppState>,
    _user: CurrentUser,
) -> AppResult<Json<Page<Pharmacy>>> {
    let rows: Vec<PharmacyRow> = sqlx::query_as("SELECT id, name, name_en, district, district_en, address, address_en, hours, hours_en, services, services_en FROM pharmacies ORDER BY position, id")
        .fetch_all(&state.db)
        .await?;
    let en = request_locale().is_en();
    let items = rows
        .into_iter()
        .map(|p| {
            if en {
                Pharmacy {
                    id: p.id,
                    name: p.name_en,
                    district: p.district_en,
                    address: p.address_en,
                    hours: p.hours_en,
                    services: p.services_en,
                }
            } else {
                Pharmacy {
                    id: p.id,
                    name: p.name,
                    district: p.district,
                    address: p.address,
                    hours: p.hours,
                    services: p.services,
                }
            }
        })
        .collect();
    Ok(Json(Page::all(items)))
}

/// The whole handbook. It is written in Traditional Chinese; there is no English edition.
pub async fn handbook(State(state): State<AppState>) -> Json<Page<Section>> {
    Json(Page::all(state.handbook.sections()))
}

pub async fn handbook_search(
    State(state): State<AppState>,
    Query(params): Query<Params>,
) -> AppResult<Json<Page<Value>>> {
    let Some(q) = page::param(&params, "q").filter(|q| q.chars().count() <= 100) else {
        return Err(AppError::field(
            "q",
            fmt(
                T::FieldErrLength,
                request_locale(),
                &[("min", "1"), ("max", "100")],
            ),
        ));
    };
    let items = state
        .handbook
        .search(q, 3)
        .into_iter()
        .map(|h| {
            json!({ "section": h.section, "title": h.title, "snippet": h.text, "source_type": h.source_type, "source_name": h.source_name, "source_url": h.source_url, "verified_on": h.verified_on, "score": h.score })
        })
        .collect();
    Ok(Json(Page::all(items)))
}

// ---------------------------------------------------------------------------
// Export and deletion
// ---------------------------------------------------------------------------

/// Rows as JSON objects, straight from the database, for one patient.
async fn rows_json(state: &AppState, sql: &'static str, account: Uuid) -> sqlx::Result<Value> {
    sqlx::query_scalar(sql)
        .bind(account)
        .fetch_one(&state.db)
        .await
}

/// Everything the service keeps about the patient, staff-only fields left out.
pub async fn export(State(state): State<AppState>, user: CurrentUser) -> AppResult<Response> {
    user.require(Permission::ProfileOwn)?;
    let locale = user.locale;
    let profile = profile::load(&state.db, user.id, locale).await?;
    let measurements = measure::for_patient(&state.db, user.id, None, None, 5000).await?;
    let appointments = appts::views(
        &state.db,
        &appts::for_patient(&state.db, user.id).await?,
        locale,
    )
    .await?;
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM visits WHERE patient_id = $1 ORDER BY created_at, id LIMIT 500",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;
    let mut visit_list = Vec::new();
    for id in ids {
        if let Some(visit) = visits::fetch(&state.db, id, OffsetDateTime::UNIX_EPOCH).await? {
            let detail = visits::build_detail(&state, visit, Some(&user)).await?;
            let mut value = serde_json::to_value(detail).map_err(anyhow::Error::from)?;
            // The trace of program steps is not personal data worth a file.
            if let Some(map) = value.as_object_mut() {
                map.remove("tool_calls");
                map.remove("runs");
            }
            visit_list.push(value);
        }
    }
    let prescriptions = rows_json(
        &state,
        "SELECT COALESCE(jsonb_agg(to_jsonb(p) - 'patient_id' - 'is_demo' || jsonb_build_object('fills', (SELECT COALESCE(jsonb_agg(jsonb_build_object('n', f.n, 'filled_on', f.filled_on, 'pharmacy_name', f.pharmacy_name) ORDER BY f.n), '[]'::jsonb) FROM fills f WHERE f.prescription_id = p.id)) ORDER BY p.created_at), '[]'::jsonb) FROM prescriptions p WHERE p.patient_id = $1",
        user.id,
    )
    .await?;
    let requests = rows_json(
        &state,
        "SELECT COALESCE(jsonb_agg(jsonb_build_object('no', r.no, 'kind', r.kind, 'status', r.status, 'answers', r.answers, 'monitoring', r.monitoring, 'pickup_window', r.pickup_window,
                    'patient_message', r.patient_message, 'created_at', r.created_at, 'submitted_at', r.submitted_at, 'decided_at', r.decided_at,
                    'items', (SELECT COALESCE(jsonb_agg(jsonb_build_object('prescription_id', i.prescription_id, 'outcome', i.outcome) ORDER BY i.position), '[]'::jsonb) FROM rx_request_items i WHERE i.request_id = r.id),
                    'messages', (SELECT COALESCE(jsonb_agg(jsonb_build_object('mine', m.author_id = r.patient_id, 'body', m.body, 'created_at', m.created_at) ORDER BY m.created_at), '[]'::jsonb) FROM rx_messages m WHERE m.request_id = r.id AND m.visibility = 'all')
                ) ORDER BY r.created_at), '[]'::jsonb) FROM rx_requests r WHERE r.patient_id = $1",
        user.id,
    )
    .await?;
    let consents = rows_json(
        &state,
        "SELECT COALESCE(jsonb_agg(jsonb_build_object('doc', doc, 'version', version, 'granted', granted, 'created_at', created_at) ORDER BY created_at), '[]'::jsonb) FROM consents WHERE account_id = $1",
        user.id,
    )
    .await?;
    let access = rows_json(
        &state,
        "SELECT COALESCE(jsonb_agg(jsonb_build_object('at', at, 'actor', actor_name, 'role', actor_role, 'action', action, 'resource', resource) ORDER BY at), '[]'::jsonb) FROM access_log WHERE patient_id = $1",
        user.id,
    )
    .await?;
    let body = json!({
        "exported_at": visits::rfc3339(state.clock.now()),
        "account": { "display_name": user.display_name, "username": user.username, "locale": user.locale, "preferences": user.preferences },
        "profile": profile,
        "measurements": measurements,
        "appointments": appointments,
        "visits": visit_list,
        "prescriptions": prescriptions,
        "rx_requests": requests,
        "consents": consents,
        "access_log": access,
    });
    let mut response = Json(body).into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"previsit-export.json\""),
    );
    Ok(response)
}

#[derive(Deserialize)]
pub struct DeleteBody {
    confirm: String,
}

/// Deletes the patient's account and everything it owns. The shared demo patient is rebuilt instead, never deleted.
pub async fn delete_me(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiJson(body): ApiJson<DeleteBody>,
) -> AppResult<Json<Value>> {
    user.require(Permission::ProfileOwn)?;
    if user.is_demo {
        return Err(AppError::InvalidState(
            "the shared demo patient cannot be deleted",
        ));
    }
    if body.confirm != "DELETE" {
        return Err(AppError::field(
            "confirm",
            fmt(T::FieldErrConfirm, user.locale, &[("word", "DELETE")]),
        ));
    }
    sqlx::query("DELETE FROM accounts WHERE id = $1 AND role = 'patient' AND NOT is_demo")
        .bind(user.id)
        .execute(&state.db)
        .await?;
    audit::audit(
        &state.db,
        None,
        AuditKind::Auth,
        "account.delete_self",
        "",
        Value::Null,
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}
