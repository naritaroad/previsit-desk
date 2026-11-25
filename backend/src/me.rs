//! Account-level endpoints: `PATCH /me`, preferences, notifications, drafts and `GET /me/stream` (contract §2).

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::auth::{self, CurrentUser, me_of};
use crate::error::{AppError, AppResult};
use crate::http::{ApiJson, OptionalJson};
use crate::notify::{self, Notification, NotificationRow};
use crate::page::{self, Cursor, Page, Params};
use crate::sse;
use crate::state::AppState;
use crate::texts::{T, fmt, t};
use crate::types::Locale;

const MAX_PREFERENCES_BYTES: usize = 8 * 1024;
const MAX_DRAFT_BYTES: usize = 16 * 1024;
const MAX_DRAFTS: i64 = 200;

#[derive(Deserialize)]
pub struct PatchMe {
    display_name: Option<String>,
    locale: Option<String>,
    avatar: Option<Option<String>>,
}

pub async fn patch_me(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiJson(body): ApiJson<Value>,
) -> AppResult<Json<Value>> {
    // `avatar: null` clears the picture; a missing key leaves it.
    let has_avatar = body.get("avatar").is_some();
    let patch: PatchMe =
        serde_json::from_value(body).map_err(|e| AppError::BadRequest(e.to_string()))?;
    let display_name = patch
        .display_name
        .map(|n| auth::clean_display_name(&n, user.locale))
        .transpose()?;
    let locale = patch
        .locale
        .map(|l| {
            Locale::parse(&l)
                .ok_or_else(|| AppError::field("locale", t(T::FieldErrChoice, user.locale)))
        })
        .transpose()?;
    let avatar = patch.avatar.flatten().filter(|a| !a.is_empty());
    if avatar.as_deref().is_some_and(|a| {
        a.len() > 60
            || !a
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
    }) {
        return Err(AppError::field("avatar", t(T::FieldErrChoice, user.locale)));
    }
    sqlx::query(
        "UPDATE accounts SET display_name = COALESCE($2, display_name),
             display_name_en = CASE WHEN $2::text IS NULL THEN display_name_en END,
             locale = COALESCE($3, locale), avatar = CASE WHEN $4 THEN $5 ELSE avatar END WHERE id = $1",
    )
    .bind(user.id)
    .bind(display_name)
    .bind(locale.map(Locale::as_str))
    .bind(has_avatar)
    .bind(avatar)
    .execute(&state.db)
    .await?;
    let user = auth::reload(&state.db, user.session_id).await?;
    Ok(Json(json!({ "me": me_of(&state.db, &user).await? })))
}

#[derive(Deserialize)]
pub struct PreferencesBody {
    patch: Map<String, Value>,
}

/// Merges `patch` into the account's preferences; `null` removes a key.
pub async fn put_preferences(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiJson(body): ApiJson<PreferencesBody>,
) -> AppResult<Json<Value>> {
    let mut tx = state.db.begin().await?;
    let current: Value =
        sqlx::query_scalar("SELECT preferences FROM accounts WHERE id = $1 FOR UPDATE")
            .bind(user.id)
            .fetch_one(&mut *tx)
            .await?;
    let merged = merge_preferences(current, body.patch);
    if merged.to_string().len() > MAX_PREFERENCES_BYTES {
        return Err(AppError::PayloadTooLarge);
    }
    sqlx::query("UPDATE accounts SET preferences = $2 WHERE id = $1")
        .bind(user.id)
        .bind(&merged)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let user = auth::reload(&state.db, user.session_id).await?;
    Ok(Json(json!({ "me": me_of(&state.db, &user).await? })))
}

fn merge_preferences(current: Value, patch: Map<String, Value>) -> Value {
    let mut merged = match current {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    for (key, value) in patch {
        if value.is_null() {
            merged.remove(&key);
        } else {
            merged.insert(key, value);
        }
    }
    Value::Object(merged)
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

pub async fn notifications(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Params>,
) -> AppResult<Json<Page<Notification>>> {
    let limit = page::limit(&params)?;
    let cursor = page::cursor(&params)?;
    let unread_only = page::param(&params, "unread") == Some("true");
    let rows: Vec<NotificationRow> = sqlx::query_as(
        "SELECT id, kind, params, link, read_at, created_at FROM notifications
         WHERE account_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3)) AND (NOT $5 OR read_at IS NULL)
         ORDER BY created_at DESC, id DESC LIMIT $4",
    )
    .bind(user.id)
    .bind(cursor.map(|c| c.at))
    .bind(cursor.map(|c| c.id))
    .bind(limit + 1)
    .bind(unread_only)
    .fetch_all(&state.db)
    .await?;
    let cut = page::cut(rows, limit, |r| Cursor {
        at: r.created_at,
        id: r.id,
    });
    Ok(Json(Page {
        items: notify::render(&state.db, cut.items, user.locale).await?,
        next_cursor: cut.next_cursor,
        total: None,
    }))
}

#[derive(Deserialize, Default)]
pub struct ReadBody {
    ids: Option<Vec<Uuid>>,
}

pub async fn read_notifications(
    State(state): State<AppState>,
    user: CurrentUser,
    OptionalJson(body): OptionalJson<ReadBody>,
) -> AppResult<Json<Value>> {
    if body.ids.as_ref().is_some_and(|ids| ids.len() > 200) {
        return Err(AppError::field("ids", "≤ 200"));
    }
    sqlx::query(
        "UPDATE notifications SET read_at = now() WHERE account_id = $1 AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2))",
    )
    .bind(user.id)
    .bind(body.ids)
    .execute(&state.db)
    .await?;
    let unread: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM notifications WHERE account_id = $1 AND read_at IS NULL",
    )
    .bind(user.id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(json!({ "unread": unread })))
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Draft {
    scope: String,
    payload: Value,
    revision: i32,
    #[serde(with = "time::serde::rfc3339")]
    updated_at: OffsetDateTime,
}

fn check_scope(scope: &str, locale: Locale) -> AppResult<()> {
    let ok = (1..=120).contains(&scope.len())
        && scope
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b":_-.".contains(&b));
    if ok {
        Ok(())
    } else {
        Err(AppError::field("scope", t(T::FieldErrChoice, locale)))
    }
}

async fn load_draft(state: &AppState, account: Uuid, scope: &str) -> sqlx::Result<Option<Draft>> {
    sqlx::query_as(
        "SELECT scope, payload, revision, updated_at FROM drafts WHERE account_id = $1 AND scope = $2",
    )
    .bind(account)
    .bind(scope)
    .fetch_optional(&state.db)
    .await
}

pub async fn get_draft(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(scope): Path<String>,
) -> AppResult<Json<Draft>> {
    load_draft(&state, user.id, &scope)
        .await?
        .map(Json)
        .ok_or(AppError::NotFound)
}

#[derive(Deserialize)]
pub struct DraftBody {
    payload: Value,
    /// The revision this edit started from; 0 for a new draft.
    revision: i32,
}

pub async fn put_draft(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(scope): Path<String>,
    ApiJson(body): ApiJson<DraftBody>,
) -> AppResult<Json<Draft>> {
    check_scope(&scope, user.locale)?;
    if body.payload.to_string().len() > MAX_DRAFT_BYTES {
        return Err(AppError::field(
            "payload",
            fmt(
                T::FieldErrLength,
                user.locale,
                &[("min", "0"), ("max", "16384")],
            ),
        ));
    }
    let saved: Option<Draft> = if body.revision == 0 {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM drafts WHERE account_id = $1")
            .bind(user.id)
            .fetch_one(&state.db)
            .await?;
        if count >= MAX_DRAFTS {
            return Err(AppError::RateLimited { retry_after: 60 });
        }
        sqlx::query_as("INSERT INTO drafts (account_id, scope, payload) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING scope, payload, revision, updated_at")
            .bind(user.id)
            .bind(&scope)
            .bind(&body.payload)
            .fetch_optional(&state.db)
            .await?
    } else {
        sqlx::query_as("UPDATE drafts SET payload = $3, revision = revision + 1, updated_at = now() WHERE account_id = $1 AND scope = $2 AND revision = $4 RETURNING scope, payload, revision, updated_at")
            .bind(user.id)
            .bind(&scope)
            .bind(&body.payload)
            .bind(body.revision)
            .fetch_optional(&state.db)
            .await?
    };
    match saved {
        Some(draft) => Ok(Json(draft)),
        // Gone (deleted on another device): the client starts again from revision 0.
        None => Err(AppError::stale(load_draft(&state, user.id, &scope).await?)),
    }
}

pub async fn delete_draft(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(scope): Path<String>,
) -> AppResult<Json<Value>> {
    sqlx::query("DELETE FROM drafts WHERE account_id = $1 AND scope = $2")
        .bind(user.id)
        .bind(&scope)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// The account stream
// ---------------------------------------------------------------------------

pub async fn stream(State(state): State<AppState>, user: CurrentUser) -> AppResult<Response> {
    let slot = state
        .streams
        .acquire(user.id)
        .ok_or(AppError::RateLimited { retry_after: 30 })?;
    let mut signals = state.hub.subscribe_signals();
    let (tx, rx) = mpsc::channel(64);
    let mut shutdown = state.shutdown.clone();
    tokio::spawn(async move {
        let _slot = slot;
        let mut recheck = tokio::time::interval(sse::RECHECK_SESSION);
        recheck.tick().await;
        loop {
            let next = tokio::select! {
                received = signals.recv() => received,
                _ = tx.closed() => break,
                _ = shutdown.changed() => break,
                _ = recheck.tick() => {
                    if auth::session_alive(&state.db, user.session_id).await.unwrap_or(false) {
                        continue;
                    }
                    break;
                }
            };
            let event = match next {
                Ok(signal) if signal.is_for(user.id, user.role) => {
                    sse::event(None, signal.kind, &signal.data)
                }
                Ok(_) => continue,
                // Too many signals at once: the client reloads what it shows.
                Err(RecvError::Lagged(_)) => {
                    sse::event(None, "queue.changed", &json!({ "name": "all" }))
                }
                Err(RecvError::Closed) => break,
            };
            if tx.send(event).await.is_err() {
                break;
            }
        }
    });
    Ok(sse::response(rx))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_merge_and_null_removes() {
        let merged = merge_preferences(
            json!({ "theme": "dark", "size": 1 }),
            serde_json::from_value(json!({ "theme": null, "lang": "en" })).expect("map"),
        );
        assert_eq!(merged, json!({ "size": 1, "lang": "en" }));
    }

    #[test]
    fn draft_scopes_are_plain_keys() {
        assert!(check_scope("visit:9b2f:composer", Locale::ZhTw).is_ok());
        assert!(check_scope("", Locale::ZhTw).is_err());
        assert!(check_scope("a/b", Locale::ZhTw).is_err());
        assert!(check_scope(&"x".repeat(121), Locale::ZhTw).is_err());
    }
}
