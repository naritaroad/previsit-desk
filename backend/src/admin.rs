//! The management site (contract §6). Nothing here returns what a patient wrote: counts, names of tools, usage, account
//! rows and rule files only.

use std::collections::BTreeMap;
use std::path::Path as FsPath;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime, Time};
use uuid::Uuid;

use crate::appts::taipei;
use crate::audit::{self, AuditKind};
use crate::auth::{self, CurrentUser};
use crate::clock::{format_date, parse_date};
use crate::demo;
use crate::error::{AppError, AppResult};
use crate::http::ApiJson;
use crate::limits;
use crate::page::{self, Cursor, Page, Params};
use crate::patient::past_person;
use crate::people::{self, PersonRef};
use crate::perm::{Permission, Role};
use crate::rx::metrics;
use crate::rxq;
use crate::settings::Settings;
use crate::state::AppState;
use crate::texts::{self, T, fmt, t};
use crate::types::Locale;
use crate::visit_routes::parse_id;
use crate::visits::rfc3339;

fn day_start(day: Date) -> OffsetDateTime {
    day.with_time(Time::MIDNIGHT).assume_offset(taipei())
}

/// `[from, to]` as dates (both included), as instants `[start, end)`.
fn date_range(
    params: &Params,
    today: Date,
    default_days: i64,
    locale: Locale,
) -> AppResult<(OffsetDateTime, OffsetDateTime)> {
    let parse = |field: &str| -> AppResult<Option<Date>> {
        page::param(params, field)
            .map(|text| {
                parse_date(text).ok_or_else(|| AppError::field(field, t(T::FieldErrDate, locale)))
            })
            .transpose()
    };
    let to = parse("to")?.unwrap_or(today);
    let from = parse("from")?
        .unwrap_or_else(|| to.checked_sub(Duration::days(default_days)).unwrap_or(to));
    if from > to {
        return Err(AppError::field("from", t(T::FieldErrChoice, locale)));
    }
    Ok((day_start(from), day_start(to) + Duration::days(1)))
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

pub async fn overview(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Params>,
) -> AppResult<Json<Value>> {
    user.require(Permission::OversightRead)?;
    let days = match page::param(&params, "days") {
        None => 14,
        Some(text) => text
            .parse::<i64>()
            .ok()
            .filter(|n| (1..=90).contains(n))
            .ok_or_else(|| {
                AppError::field(
                    "days",
                    fmt(
                        T::FieldErrRange,
                        user.locale,
                        &[("min", "1"), ("max", "90")],
                    ),
                )
            })?,
    };
    let db = &state.db;
    let today = state.clock.today();
    let first = today.checked_sub(Duration::days(days - 1)).unwrap_or(today);
    let start = day_start(first);

    async fn by_day(
        db: &PgPool,
        sql: &'static str,
        start: OffsetDateTime,
    ) -> sqlx::Result<BTreeMap<Date, i64>> {
        Ok(sqlx::query_as::<_, (Date, i64)>(sql)
            .bind(start)
            .fetch_all(db)
            .await?
            .into_iter()
            .collect())
    }
    let visits = by_day(db, "SELECT (created_at AT TIME ZONE 'Asia/Taipei')::date, count(*) FROM visits WHERE created_at >= $1 AND patient_id IS NOT NULL GROUP BY 1", start).await?;
    let red_flags = by_day(db, "SELECT (created_at AT TIME ZONE 'Asia/Taipei')::date, count(*) FROM red_flag_events WHERE created_at >= $1 GROUP BY 1", start).await?;
    let rx = by_day(db, "SELECT (submitted_at AT TIME ZONE 'Asia/Taipei')::date, count(*) FROM rx_requests WHERE submitted_at >= $1 GROUP BY 1", start).await?;
    let usage: BTreeMap<Date, (i64, i64, i64, f64)> =
        sqlx::query_as::<_, (Date, i64, i64, i64, f64)>(
            "SELECT day, SUM(calls)::bigint, SUM(input_tokens)::bigint, SUM(output_tokens)::bigint, SUM(cost_usd)::float8 FROM usage_daily WHERE day >= $1 GROUP BY day",
        )
        .bind(first)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(|(d, c, i, o, usd)| (d, (c, i, o, usd)))
        .collect();
    let mut series = Vec::new();
    let mut day = first;
    while day <= today {
        let (calls, input, output, cost) = usage.get(&day).copied().unwrap_or_default();
        series.push(json!({
            "day": format_date(day),
            "visits": visits.get(&day).copied().unwrap_or(0),
            "model_calls": calls,
            "input_tokens": input,
            "output_tokens": output,
            "cost_usd": cost,
            "red_flags": red_flags.get(&day).copied().unwrap_or(0),
            "rx": rx.get(&day).copied().unwrap_or(0),
        }));
        let Some(next) = day.next_day() else { break };
        day = next;
    }
    let (patients, guests, staff): (i64, i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE role = 'patient' AND NOT is_guest), count(*) FILTER (WHERE is_guest AND expires_at > now()), count(*) FILTER (WHERE role <> 'patient') FROM accounts WHERE status = 'active'",
    )
    .fetch_one(db)
    .await?;
    let (pending, flagged): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE status = 'submitted'), count(*) FILTER (WHERE status = 'red_flag') FROM visits WHERE patient_id IS NOT NULL",
    )
    .fetch_one(db)
    .await?;
    let (review, overdue, more_info, pharmacy): (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE status IN ('submitted', 'in_review')), count(*) FILTER (WHERE status IN ('submitted', 'in_review') AND sla_due_at < now()),
                count(*) FILTER (WHERE status = 'more_info'), count(*) FILTER (WHERE status IN ('at_pharmacy', 'ready')) FROM rx_requests",
    )
    .fetch_one(db)
    .await?;
    let tickets: i64 =
        sqlx::query_scalar("SELECT count(*) FROM clinician_tickets WHERE status = 'open'")
            .fetch_one(db)
            .await?;
    let settings = state.settings.get();
    let sum = |key: &str| -> f64 { series.iter().filter_map(|s| s[key].as_f64()).sum() };
    Ok(Json(json!({
        "totals": {
            "patients": patients,
            "guests": guests,
            "staff": staff,
            "visits": sum("visits") as i64,
            "red_flags": sum("red_flags") as i64,
            "rx": sum("rx") as i64,
            "model_calls": sum("model_calls") as i64,
            "input_tokens": sum("input_tokens") as i64,
            "output_tokens": sum("output_tokens") as i64,
            "cost_usd": sum("cost_usd"),
            "month_cost_usd": limits::spent_this_month(db, &state.clock).await?,
            "month_budget_usd": settings.ai.monthly_budget_usd,
            "calls_today": limits::calls_today(db, &state.clock).await?,
            "daily_call_limit": settings.ai.daily_call_limit,
        },
        "series": series,
        "queues": {
            "visits_pending": pending,
            "red_flag": flagged,
            "rx_review": review,
            "rx_overdue": overdue,
            "rx_more_info": more_info,
            "rx_pharmacy": pharmacy,
            "tickets_open": tickets,
        },
        "system": {
            "version": env!("CARGO_PKG_VERSION"),
            "model_ready": state.config.model_ready(&settings.ai.primary),
            "uptime_s": state.started.elapsed().as_secs(),
            "db_ok": true,
            "ai_enabled": settings.ai.enabled,
        },
    })))
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AccountRow {
    id: Uuid,
    username: Option<String>,
    display_name: String,
    role: String,
    title: Option<String>,
    status: String,
    is_guest: bool,
    is_demo: bool,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    last_login_at: Option<OffsetDateTime>,
    sessions: i64,
}

macro_rules! account_cols {
    () => {
        "SELECT a.id, a.username, a.display_name, a.role, a.title, a.status, a.is_guest, a.is_demo, a.created_at, a.last_login_at, (SELECT count(*) FROM sessions s WHERE s.account_id = a.id AND s.expires_at > now()) AS sessions FROM accounts a "
    };
}

async fn account(db: &PgPool, id: Uuid) -> AppResult<AccountRow> {
    sqlx::query_as(concat!(account_cols!(), "WHERE a.id = $1"))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn accounts(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Params>,
) -> AppResult<Json<Page<AccountRow>>> {
    user.require(Permission::AccountManage)?;
    let role = page::param(&params, "role");
    if role.is_some_and(|r| Role::parse(r).is_none()) {
        return Err(AppError::field("role", t(T::FieldErrChoice, user.locale)));
    }
    let status = page::param(&params, "status");
    if status.is_some_and(|s| !["active", "disabled"].contains(&s)) {
        return Err(AppError::field("status", t(T::FieldErrChoice, user.locale)));
    }
    let limit = page::limit(&params)?;
    let cursor = page::cursor(&params)?;
    let rows: Vec<AccountRow> = sqlx::query_as(concat!(
        account_cols!(),
        "WHERE ($1::text IS NULL OR a.role = $1) AND ($2::text IS NULL OR a.status = $2)
           AND ($3::text IS NULL OR a.username ILIKE $3 ESCAPE '\\' OR a.display_name ILIKE $3 ESCAPE '\\')
           AND ($4::timestamptz IS NULL OR (a.created_at, a.id) < ($4, $5))
         ORDER BY a.created_at DESC, a.id DESC LIMIT $6"
    ))
    .bind(role)
    .bind(status)
    .bind(page::like(&params))
    .bind(cursor.map(|c| c.at))
    .bind(cursor.map(|c| c.id))
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM accounts a WHERE ($1::text IS NULL OR a.role = $1) AND ($2::text IS NULL OR a.status = $2)
           AND ($3::text IS NULL OR a.username ILIKE $3 ESCAPE '\\' OR a.display_name ILIKE $3 ESCAPE '\\')",
    )
    .bind(role)
    .bind(status)
    .bind(page::like(&params))
    .fetch_one(&state.db)
    .await?;
    let mut page = page::cut(rows, limit, |a| Cursor {
        at: a.created_at,
        id: a.id,
    });
    page.total = Some(total);
    Ok(Json(page))
}

#[derive(Deserialize)]
pub struct NewAccount {
    username: String,
    display_name: String,
    role: Role,
    title: Option<String>,
}

fn clean_title(title: Option<&str>, locale: Locale) -> AppResult<Option<String>> {
    match title.map(str::trim) {
        None | Some("") => Ok(None),
        Some(text) if text.chars().count() <= 40 => Ok(Some(text.to_string())),
        Some(_) => Err(AppError::field(
            "title",
            fmt(T::FieldErrLength, locale, &[("min", "0"), ("max", "40")]),
        )),
    }
}

async fn hashed(password: String) -> AppResult<String> {
    Ok(
        tokio::task::spawn_blocking(move || auth::hash_password(&password))
            .await
            .map_err(anyhow::Error::from)??,
    )
}

/// Creates an account with a one-time password, shown once in this response and nowhere else.
pub async fn create_account(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiJson(body): ApiJson<NewAccount>,
) -> AppResult<(StatusCode, Json<Value>)> {
    user.require(Permission::AccountManage)?;
    let username = auth::clean_username(&body.username, user.locale)?;
    let display_name = auth::clean_display_name(&body.display_name, user.locale)?;
    let title = clean_title(body.title.as_deref(), user.locale)?;
    let password = auth::one_time_password();
    let hash = hashed(password.clone()).await?;
    let mut tx = state.db.begin().await?;
    let id: Uuid = sqlx::query_scalar("INSERT INTO accounts (username, display_name, role, title, password_hash, must_change_password, created_by) VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id")
        .bind(&username)
        .bind(display_name)
        .bind(body.role.as_str())
        .bind(title)
        .bind(hash)
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| auth::username_taken(e, user.locale))?;
    if body.role == Role::Patient {
        for sql in [
            "INSERT INTO patient_profiles (account_id) VALUES ($1)",
            "INSERT INTO patient_care (account_id) VALUES ($1)",
        ] {
            sqlx::query(sql).bind(id).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    audit::audit(
        &state.db,
        Some(&user),
        AuditKind::Admin,
        "account.create",
        &format!("account:{id}"),
        json!({ "role": body.role }),
    )
    .await;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "account": account(&state.db, id).await?, "password": password })),
    ))
}

pub async fn get_account(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<AccountRow>> {
    user.require(Permission::AccountManage)?;
    Ok(Json(account(&state.db, parse_id(&id)?).await?))
}

#[derive(Deserialize)]
pub struct PatchAccount {
    display_name: Option<String>,
    role: Option<Role>,
    title: Option<Option<String>>,
    status: Option<String>,
}

/// Whether taking admin rights from this account is allowed: never from yourself, never from the last active admin.
fn may_demote(
    actor: Uuid,
    target: Uuid,
    target_is_active_admin: bool,
    other_active_admins: i64,
) -> bool {
    actor != target && (!target_is_active_admin || other_active_admins > 0)
}

pub async fn patch_account(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Value>,
) -> AppResult<Json<AccountRow>> {
    user.require(Permission::AccountManage)?;
    let id = parse_id(&id)?;
    let locale = user.locale;
    let has_title = body.get("title").is_some();
    let patch: PatchAccount =
        serde_json::from_value(body).map_err(|e| AppError::BadRequest(e.to_string()))?;
    let current = account(&state.db, id).await?;
    let display_name = patch
        .display_name
        .as_deref()
        .map(|n| auth::clean_display_name(n, locale))
        .transpose()?;
    let title = clean_title(patch.title.flatten().as_deref(), locale)?;
    if patch
        .status
        .as_deref()
        .is_some_and(|s| !["active", "disabled"].contains(&s))
    {
        return Err(AppError::field("status", t(T::FieldErrChoice, locale)));
    }
    let role = patch.role.map(Role::as_str).unwrap_or(&current.role);
    let status = patch.status.as_deref().unwrap_or(&current.status);
    if role != current.role && (current.role == "patient" || role == "patient") {
        // Patient data hangs off patient accounts; turning one into staff (or back) would mix the two.
        return Err(AppError::field("role", t(T::FieldErrRolePatient, locale)));
    }
    let loses_access = role != current.role || (status == "disabled" && current.status == "active");
    let mut tx = state.db.begin().await?;
    if loses_access {
        let others: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM (SELECT id FROM accounts WHERE role = 'admin' AND status = 'active' FOR UPDATE) a WHERE id <> $1",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        let is_admin = current.role == "admin" && current.status == "active";
        if !may_demote(user.id, id, is_admin, others) {
            return Err(AppError::InvalidState(
                "you cannot disable or demote yourself or the last administrator",
            ));
        }
    }
    sqlx::query("UPDATE accounts SET display_name = COALESCE($2, display_name), display_name_en = CASE WHEN $2::text IS NULL THEN display_name_en END, role = $3, title = CASE WHEN $4 THEN $5 ELSE title END, title_en = CASE WHEN $4 THEN NULL ELSE title_en END, status = $6 WHERE id = $1")
        .bind(id)
        .bind(&display_name)
        .bind(role)
        .bind(has_title)
        .bind(title)
        .bind(status)
        .execute(&mut *tx)
        .await?;
    if loses_access {
        sqlx::query("DELETE FROM sessions WHERE account_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    audit::audit(
        &state.db,
        Some(&user),
        AuditKind::Admin,
        "account.update",
        &format!("account:{id}"),
        json!({ "role": role, "status": status, "renamed": display_name.is_some(), "title": has_title }),
    )
    .await;
    Ok(Json(account(&state.db, id).await?))
}

pub async fn reset_password(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require(Permission::AccountManage)?;
    let id = parse_id(&id)?;
    let current = account(&state.db, id).await?;
    if current.username.is_none() {
        return Err(AppError::InvalidState(
            "this account cannot sign in with a password",
        ));
    }
    let password = auth::one_time_password();
    let hash = hashed(password.clone()).await?;
    sqlx::query(
        "UPDATE accounts SET password_hash = $2, must_change_password = true WHERE id = $1",
    )
    .bind(id)
    .bind(hash)
    .execute(&state.db)
    .await?;
    sqlx::query("DELETE FROM sessions WHERE account_id = $1 AND id <> $2")
        .bind(id)
        .bind(user.session_id)
        .execute(&state.db)
        .await?;
    audit::audit(
        &state.db,
        Some(&user),
        AuditKind::Admin,
        "account.reset_password",
        &format!("account:{id}"),
        Value::Null,
    )
    .await;
    Ok(Json(
        json!({ "account": account(&state.db, id).await?, "password": password }),
    ))
}

pub async fn revoke_sessions(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require(Permission::AccountManage)?;
    let id = parse_id(&id)?;
    account(&state.db, id).await?;
    let revoked = sqlx::query("DELETE FROM sessions WHERE account_id = $1 AND id <> $2")
        .bind(id)
        .bind(user.session_id)
        .execute(&state.db)
        .await?
        .rows_affected();
    audit::audit(
        &state.db,
        Some(&user),
        AuditKind::Admin,
        "account.revoke_sessions",
        &format!("account:{id}"),
        json!({ "revoked": revoked }),
    )
    .await;
    Ok(Json(
        json!({ "revoked": revoked, "account": account(&state.db, id).await? }),
    ))
}

pub async fn permissions(user: CurrentUser) -> AppResult<Json<Value>> {
    user.require(Permission::AccountManage)?;
    let list: Vec<Value> = Permission::ALL
        .iter()
        .map(|p| {
            let (label, description) = p.describe(user.locale);
            json!({ "id": p, "label": label, "description": description })
        })
        .collect();
    let matrix: BTreeMap<&str, &[Permission]> = Role::ALL
        .iter()
        .map(|r| (r.as_str(), r.permissions()))
        .collect();
    Ok(Json(
        json!({ "roles": Role::ALL, "permissions": list, "matrix": matrix }),
    ))
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

pub async fn get_settings(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Settings>> {
    user.require(Permission::SettingsManage)?;
    Ok(Json((*state.settings.get()).clone()))
}

/// Leaf paths whose value differs, such as `ai.enabled`.
fn changed_paths(before: &Value, after: &Value, prefix: &str, out: &mut Vec<String>) {
    match (before, after) {
        (Value::Object(a), Value::Object(b)) => {
            let keys: std::collections::BTreeSet<&String> = a.keys().chain(b.keys()).collect();
            for key in keys {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                changed_paths(
                    a.get(key).unwrap_or(&Value::Null),
                    b.get(key).unwrap_or(&Value::Null),
                    &path,
                    out,
                );
            }
        }
        (a, b) if a != b && prefix != "revision" => out.push(prefix.to_string()),
        _ => {}
    }
}

pub async fn put_settings(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiJson(body): ApiJson<Settings>,
) -> AppResult<Json<Settings>> {
    user.require(Permission::SettingsManage)?;
    let before = state.settings.get();
    let saved = state
        .settings
        .save(&state.db, &state.config, body, user.id)
        .await?;
    let mut changed = Vec::new();
    changed_paths(
        &serde_json::to_value(&*before).unwrap_or(Value::Null),
        &serde_json::to_value(&*saved).unwrap_or(Value::Null),
        "",
        &mut changed,
    );
    audit::audit(
        &state.db,
        Some(&user),
        AuditKind::Admin,
        "settings.update",
        "settings:platform",
        json!({ "changed": changed, "ai_enabled": saved.ai.enabled }),
    )
    .await;
    Ok(Json((*saved).clone()))
}

pub async fn models(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Page<String>>> {
    user.require(Permission::SettingsManage)?;
    Ok(Json(Page::all(state.config.model_choices.clone())))
}

// ---------------------------------------------------------------------------
// Oversight
// ---------------------------------------------------------------------------

pub async fn oversight(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Params>,
) -> AppResult<Json<Value>> {
    user.require(Permission::OversightRead)?;
    let (from, to) = date_range(&params, state.clock.today(), 89, user.locale)?;
    let db = &state.db;
    let items = rxq::renewal_items(db, from, to).await?;
    let hours = rxq::decision_hours(db, from, to).await?;
    let (returned, reached) = rxq::pharmacy_counts(db, from, to).await?;
    let red_flags: Vec<(String, i64)> = sqlx::query_as("SELECT category, count(*) FROM red_flag_events WHERE created_at >= $1 AND created_at < $2 GROUP BY category ORDER BY 2 DESC, 1")
        .bind(from)
        .bind(to)
        .fetch_all(db)
        .await?;
    let guard: Vec<(String, i64)> = sqlx::query_as("SELECT kind, count(*) FROM guard_events WHERE created_at >= $1 AND created_at < $2 GROUP BY kind ORDER BY 2 DESC, 1")
        .bind(from)
        .bind(to)
        .fetch_all(db)
        .await?;
    Ok(Json(json!({
        "phase": state.settings.get().rx.oversight_phase,
        "by_class": metrics::by_class(&items, user.locale),
        "turnaround": metrics::turnaround(&hours),
        "returned_rate": metrics::returned_rate(returned, reached),
        "red_flags": red_flags
            .into_iter()
            .map(|(category, n)| {
                let label = crate::types::RedFlagCategory::parse(&category)
                    .map(|c| texts::category_label(c, user.locale));
                json!({ "category": category, "label": label, "n": n })
            })
            .collect::<Vec<_>>(),
        "guard": guard
            .into_iter()
            .map(|(kind, n)| json!({ "kind": kind, "n": n }))
            .collect::<Vec<_>>(),
    })))
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

#[derive(Debug, sqlx::FromRow)]
struct RunRow {
    id: Uuid,
    visit_id: Uuid,
    model: String,
    fallback_used: bool,
    status: String,
    steps: i32,
    input_tokens: i32,
    output_tokens: i32,
    cost_usd: f64,
    error_code: Option<String>,
    duration_ms: i32,
    created_at: OffsetDateTime,
    tools: Value,
}

impl RunRow {
    fn view(self) -> Value {
        json!({
            "id": self.id,
            // An id only: the management site has no permission that opens a visit.
            "visit_id": self.visit_id,
            "model": self.model,
            "fallback_used": self.fallback_used,
            "status": self.status,
            "steps": self.steps,
            "usage": { "input_tokens": self.input_tokens, "output_tokens": self.output_tokens },
            "cost_usd": self.cost_usd,
            "error_code": self.error_code,
            "duration_ms": self.duration_ms,
            "created_at": rfc3339(self.created_at),
            "tools": self.tools,
        })
    }
}

/// Tools are listed by name, source, status and time. Arguments and results can quote the patient, so they stay out.
macro_rules! run_cols {
    () => {
        "SELECT r.id, r.visit_id, r.model, r.fallback_used, r.status, r.steps, r.input_tokens, r.output_tokens, r.cost_usd, r.error_code, r.duration_ms, r.created_at,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('name', t.name, 'source', t.source, 'status', t.status, 'step', t.step, 'duration_ms', t.duration_ms) ORDER BY t.created_at, t.id) FROM tool_calls t WHERE t.run_id = r.id), '[]'::jsonb) AS tools FROM runs r "
    };
}

pub async fn runs(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Params>,
) -> AppResult<Json<Page<Value>>> {
    user.require(Permission::AuditRead)?;
    let status = page::param(&params, "status");
    if status
        .is_some_and(|s| !["running", "completed", "failed", "skipped", "interrupted"].contains(&s))
    {
        return Err(AppError::field("status", t(T::FieldErrChoice, user.locale)));
    }
    let limit = page::limit(&params)?;
    let cursor = page::cursor(&params)?;
    let rows: Vec<RunRow> = sqlx::query_as(concat!(
        run_cols!(),
        "WHERE ($1::text IS NULL OR r.status = $1) AND ($2::text IS NULL OR r.model = $2) AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3, $4))
         ORDER BY r.created_at DESC, r.id DESC LIMIT $5"
    ))
    .bind(status)
    .bind(page::param(&params, "model"))
    .bind(cursor.map(|c| c.at))
    .bind(cursor.map(|c| c.id))
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let cut = page::cut(rows, limit, |r| Cursor {
        at: r.created_at,
        id: r.id,
    });
    Ok(Json(Page {
        items: cut.items.into_iter().map(RunRow::view).collect(),
        next_cursor: cut.next_cursor,
        total: None,
    }))
}

pub async fn run(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require(Permission::AuditRead)?;
    let id = parse_id(&id)?;
    let row: RunRow = sqlx::query_as(concat!(run_cols!(), "WHERE r.id = $1"))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    let guard: Vec<(String, String)> = sqlx::query_as(
        "SELECT kind, action FROM guard_events WHERE run_id = $1 ORDER BY created_at, id",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let mut view = row.view();
    view["guard"] = guard
        .into_iter()
        .map(|(kind, action)| json!({ "kind": kind, "action": action }))
        .collect();
    Ok(Json(view))
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct LedgerRow {
    id: Uuid,
    at: OffsetDateTime,
    actor_id: Option<Uuid>,
    actor_name: String,
    actor_role: String,
    kind: String,
    action: String,
    target: String,
    detail: Value,
}

#[derive(Serialize)]
pub struct LedgerEntry {
    #[serde(with = "time::serde::rfc3339")]
    at: OffsetDateTime,
    actor: PersonRef,
    kind: String,
    action: String,
    target: String,
    detail: Value,
}

/// Changes and reads in one list.
pub async fn audit_list(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Params>,
) -> AppResult<Json<Page<LedgerEntry>>> {
    user.require(Permission::AuditRead)?;
    let actor = page::param(&params, "actor").map(parse_id).transpose()?;
    let kind = page::param(&params, "kind");
    if kind.is_some_and(|k| !["admin", "access", "rx", "auth", "clinic"].contains(&k)) {
        return Err(AppError::field("kind", t(T::FieldErrChoice, user.locale)));
    }
    let (from, to) = date_range(&params, state.clock.today(), 89, user.locale)?;
    let limit = page::limit(&params)?;
    let cursor = page::cursor(&params)?;
    let rows: Vec<LedgerRow> = sqlx::query_as(
        "SELECT id, at, actor_id, actor_name, actor_role, kind, action, target, detail FROM (
            SELECT id, at, actor_id, actor_name, actor_role, kind, action, target, detail FROM audit_log
            UNION ALL
            SELECT id, at, actor_id, actor_name, actor_role, 'access', action, resource || ':' || resource_id, '{}'::jsonb FROM access_log
         ) l
         WHERE at >= $1 AND at < $2 AND ($3::uuid IS NULL OR actor_id = $3) AND ($4::text IS NULL OR action = $4) AND ($5::text IS NULL OR kind = $5)
           AND ($6::timestamptz IS NULL OR (at, id) < ($6, $7))
         ORDER BY at DESC, id DESC LIMIT $8",
    )
    .bind(from)
    .bind(to)
    .bind(actor)
    .bind(page::param(&params, "action"))
    .bind(kind)
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
            .map(|r| LedgerEntry {
                actor: people.get(r.actor_id).unwrap_or_else(|| {
                    let name = if r.actor_name.is_empty() {
                        t(T::SystemLabel, user.locale)
                    } else {
                        &r.actor_name
                    };
                    past_person(r.actor_id, name, &r.actor_role)
                }),
                at: r.at,
                kind: r.kind,
                action: r.action,
                target: r.target,
                detail: r.detail,
            })
            .collect(),
        next_cursor: cut.next_cursor,
        total: None,
    }))
}

// ---------------------------------------------------------------------------
// Rules, eval, demo
// ---------------------------------------------------------------------------

pub async fn rules(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require(Permission::RulesRead)?;
    let mut out = Map::new();
    out.insert(
        "red_flags".into(),
        json!(state.rules.red_flags.list(user.locale)),
    );
    out.insert("scope".into(), json!(state.rules.scope.list()));
    out.insert("refill".into(), json!(state.rules.refill.list(user.locale)));
    if let Value::Object(rx) = state.rx.rules_view(user.locale) {
        out.extend(rx);
    }
    Ok(Json(Value::Object(out)))
}

/// Summaries of every full run in `data/eval/results`, newest first; per-case rows are left out.
pub fn eval_history(data_dir: &FsPath) -> Vec<Value> {
    let dir = data_dir.join("eval").join("results");
    let mut out: Vec<Value> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            name.ends_with(".json") && name != "summary.json"
        })
        .filter_map(|e| {
            let raw = std::fs::read_to_string(e.path()).ok()?;
            let value: Value = serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()?;
            let map = value.as_object()?;
            if map.get("offline") == Some(&Value::Bool(true)) {
                return None;
            }
            let keep = ["ran_at", "model", "total", "passed", "categories", "style"];
            Some(Value::Object(
                keep.iter()
                    .filter_map(|k| Some((k.to_string(), map.get(*k)?.clone())))
                    .collect(),
            ))
        })
        .collect();
    out.sort_by(|a, b| b["ran_at"].as_str().cmp(&a["ran_at"].as_str()));
    out.truncate(50);
    out
}

pub async fn eval(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require(Permission::RulesRead)?;
    Ok(Json(json!({
        "latest": crate::public::eval_summary(&state.config.data_dir),
        "history": eval_history(&state.config.data_dir),
    })))
}

#[derive(Deserialize)]
pub struct ResetBody {
    confirm: String,
}

pub async fn demo_reset(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiJson(body): ApiJson<ResetBody>,
) -> AppResult<Json<Value>> {
    user.require(Permission::DemoReset)?;
    if body.confirm != "RESET" {
        return Err(AppError::field(
            "confirm",
            fmt(T::FieldErrConfirm, user.locale, &[("word", "RESET")]),
        ));
    }
    let report = demo::reset(&state).await?;
    audit::audit(
        &state.db,
        Some(&user),
        AuditKind::Admin,
        "demo.reset",
        "demo",
        report.clone(),
    )
    .await;
    Ok(Json(json!({ "ok": true, "loaded": report })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nobody_can_lock_the_admins_out() {
        let (me, other) = (Uuid::new_v4(), Uuid::new_v4());
        assert!(!may_demote(me, me, true, 5), "not yourself");
        assert!(!may_demote(me, other, true, 0), "not the last admin");
        assert!(may_demote(me, other, true, 1));
        assert!(may_demote(me, other, false, 0));
    }

    #[test]
    fn the_audit_row_names_the_settings_that_changed() {
        let before = json!({ "revision": 1, "ai": { "enabled": true, "max_steps": 5, "prices": {} }, "retention_days": 14 });
        let after = json!({ "revision": 2, "ai": { "enabled": false, "max_steps": 5, "prices": { "a": { "in": 1.0 } } }, "retention_days": 14 });
        let mut out = Vec::new();
        changed_paths(&before, &after, "", &mut out);
        assert_eq!(out, ["ai.enabled", "ai.prices.a"]);
    }

    #[test]
    fn date_ranges_include_both_days_and_refuse_reversed_ones() {
        let today = time::macros::date!(2026 - 11 - 25);
        let params = |pairs: &[(&str, &str)]| -> Params {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        let (from, to) = date_range(
            &params(&[("from", "2026-11-25"), ("to", "2026-11-25")]),
            today,
            30,
            Locale::ZhTw,
        )
        .expect("range");
        assert_eq!(to - from, Duration::days(1));
        assert!(
            date_range(
                &params(&[("from", "2026-11-26"), ("to", "2026-11-25")]),
                today,
                30,
                Locale::ZhTw
            )
            .is_err()
        );
        assert!(date_range(&params(&[("from", "x")]), today, 30, Locale::ZhTw).is_err());
    }

    #[test]
    fn eval_history_skips_offline_runs_and_case_rows() {
        let dir = std::env::temp_dir().join(format!("previsit-eval-{}", Uuid::new_v4()));
        let results = dir.join("eval").join("results");
        std::fs::create_dir_all(&results).expect("dir");
        let write =
            |name: &str, text: &str| std::fs::write(results.join(name), text).expect("write");
        write(
            "1-a.json",
            r#"{"ran_at":"2026-11-24T00:00:00Z","model":"a","total":1,"passed":1,"categories":[],"cases":[{}]}"#,
        );
        write(
            "2-b.json",
            r#"{"ran_at":"2026-11-25T00:00:00Z","model":"b","total":1,"passed":0,"categories":[],"cases":[{}]}"#,
        );
        write(
            "3-mock.json",
            r#"{"ran_at":"2026-11-26T00:00:00Z","model":"mock","offline":true,"total":1,"passed":1}"#,
        );
        write("summary.json", r#"{"ran_at":"2026-11-27T00:00:00Z"}"#);
        let list = eval_history(&dir);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["model"], "b");
        assert!(list[0].get("cases").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
