//! `Idempotency-Key` on create requests: the same account repeating the same key within 24 hours gets the first
//! answer back instead of a second object.

use axum::Json;
use axum::extract::FromRequestParts;
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// The `Idempotency-Key` header, if it was sent (1 to 100 characters).
pub struct IdempotencyKey(pub Option<String>);

impl<S: Send + Sync> FromRequestParts<S> for IdempotencyKey {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        let Some(value) = parts.headers.get("idempotency-key") else {
            return Ok(Self(None));
        };
        let key = value.to_str().unwrap_or("").trim();
        if key.is_empty() || key.len() > 100 {
            return Err(AppError::BadRequest(
                "Idempotency-Key must be 1 to 100 characters".into(),
            ));
        }
        Ok(Self(Some(key.to_string())))
    }
}

/// Runs `work` once per (account, key). A repeat returns the stored status and body; a repeat that arrives while the
/// first is still running gets 409 `conflict`; the same key on another route is a 422. Errors are not stored, so a
/// failed request can be retried with the same key.
pub async fn run<F, Fut>(
    state: &AppState,
    account: Uuid,
    key: IdempotencyKey,
    route: &str,
    work: F,
) -> AppResult<Response>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = AppResult<(StatusCode, Value)>>,
{
    let Some(key) = key.0 else {
        let (status, body) = work().await?;
        return Ok((status, Json(body)).into_response());
    };
    sqlx::query("DELETE FROM idempotency_keys WHERE account_id = $1 AND (created_at < now() - interval '24 hours' OR (status IS NULL AND created_at < now() - interval '2 minutes'))")
        .bind(account)
        .execute(&state.db)
        .await?;
    let claimed = sqlx::query(
        "INSERT INTO idempotency_keys (account_id, key, route) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    )
    .bind(account)
    .bind(&key)
    .bind(route)
    .execute(&state.db)
    .await?
    .rows_affected()
        == 1;
    if !claimed {
        let row: Option<(String, Option<i16>, Option<Value>)> = sqlx::query_as(
            "SELECT route, status, response FROM idempotency_keys WHERE account_id = $1 AND key = $2",
        )
        .bind(account)
        .bind(&key)
        .fetch_optional(&state.db)
        .await?;
        return match row {
            Some((stored, _, _)) if stored != route => Err(AppError::field(
                "Idempotency-Key",
                "already used for another request",
            )),
            Some((_, Some(status), Some(body))) => Ok((
                StatusCode::from_u16(status as u16).unwrap_or(StatusCode::OK),
                Json(body),
            )
                .into_response()),
            _ => Err(AppError::Conflict),
        };
    }
    match work().await {
        Ok((status, body)) => {
            sqlx::query("UPDATE idempotency_keys SET status = $3, response = $4 WHERE account_id = $1 AND key = $2")
                .bind(account)
                .bind(&key)
                .bind(status.as_u16() as i16)
                .bind(&body)
                .execute(&state.db)
                .await?;
            Ok((status, Json(body)).into_response())
        }
        Err(error) => {
            let _ = sqlx::query("DELETE FROM idempotency_keys WHERE account_id = $1 AND key = $2")
                .bind(account)
                .bind(&key)
                .execute(&state.db)
                .await;
            Err(error)
        }
    }
}
