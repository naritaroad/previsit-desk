//! The clinician demo account and cookie sessions. One account, seeded from the environment at start.

use std::sync::LazyLock;

use anyhow::Result;
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use axum::Json;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum_extra::extract::CookieJar;
use axum_extra::extract::cookie::{Cookie, SameSite};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::http::{ApiJson, ClientId};
use crate::limits::Bucket;
use crate::state::AppState;

pub const SESSION_COOKIE: &str = "pv_session";
const LOGIN_ATTEMPTS_PER_WINDOW: u32 = 10;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ClinicianUser {
    pub username: String,
    pub display_name: String,
    pub role: String,
}

pub fn hash_password(password: &str) -> Result<String> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("hash password: {e}"))
}

fn verify_password(password: &str, hash: &str) -> bool {
    Argon2::default()
        .verify_password(password.as_bytes(), hash)
        .is_ok()
}

/// A real hash to verify against when the username is unknown, so both failures take the same time.
static DUMMY_HASH: LazyLock<String> =
    LazyLock::new(|| hash_password("not-a-real-password").unwrap_or_default());

fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes[..]);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Creates or updates the clinician account from `CLINICIAN_*`. Nothing is logged about the password.
pub async fn ensure_account(db: &PgPool, config: &Config) -> Result<()> {
    let Some(account) = &config.clinician else {
        tracing::warn!(
            "CLINICIAN_USERNAME or CLINICIAN_PASSWORD is not set; clinician login is disabled"
        );
        return Ok(());
    };
    let existing: Option<(Uuid, String)> =
        sqlx::query_as("SELECT id, password_hash FROM accounts WHERE lower(username) = lower($1)")
            .bind(&account.username)
            .fetch_optional(db)
            .await?;
    match existing {
        Some((id, hash)) => {
            let hash = if verify_password(&account.password, &hash) {
                hash
            } else {
                hash_password(&account.password)?
            };
            sqlx::query("UPDATE accounts SET password_hash = $2, display_name = $3 WHERE id = $1")
                .bind(id)
                .bind(hash)
                .bind(&account.display_name)
                .execute(db)
                .await?;
        }
        None => {
            sqlx::query(
                "INSERT INTO accounts (username, display_name, password_hash) VALUES ($1, $2, $3)",
            )
            .bind(&account.username)
            .bind(&account.display_name)
            .bind(hash_password(&account.password)?)
            .execute(db)
            .await?;
        }
    }
    tracing::info!(username = %account.username, "clinician account ready");
    Ok(())
}

/// Any request with a valid clinician session cookie.
impl FromRequestParts<AppState> for ClinicianUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar
            .get(SESSION_COOKIE)
            .map(|c| c.value().to_string())
            .ok_or(AppError::Unauthorized)?;
        let user: Option<ClinicianUser> = sqlx::query_as("SELECT a.id, a.username, a.display_name, a.role FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = $1 AND s.expires_at > now()")
            .bind(token_hash(&token))
            .fetch_optional(&state.db)
            .await?;
        user.ok_or(AppError::Unauthorized)
    }
}

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

pub async fn login(
    State(state): State<AppState>,
    ClientId(client): ClientId,
    jar: CookieJar,
    ApiJson(req): ApiJson<LoginRequest>,
) -> AppResult<(CookieJar, Json<serde_json::Value>)> {
    state
        .limiter
        .check(Bucket::Login, client, LOGIN_ATTEMPTS_PER_WINDOW)
        .map_err(|retry_after| AppError::RateLimited { retry_after })?;
    let row: Option<(Uuid, String)> =
        sqlx::query_as("SELECT id, password_hash FROM accounts WHERE lower(username) = lower($1)")
            .bind(req.username.trim())
            .fetch_optional(&state.db)
            .await?;
    // Same answer and same work for an unknown user and a wrong password.
    let verified = match &row {
        Some((_, hash)) => verify_password(&req.password, hash),
        None => {
            let _ = verify_password(&req.password, &DUMMY_HASH);
            false
        }
    };
    let (account_id, true) = (row.map(|r| r.0).unwrap_or_default(), verified) else {
        return Err(AppError::InvalidCredentials);
    };

    let token = new_token();
    let expires = OffsetDateTime::now_utc() + Duration::days(state.config.session_days);
    sqlx::query("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)")
        .bind(token_hash(&token))
        .bind(account_id)
        .bind(expires)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE expires_at < now()")
        .execute(&state.db)
        .await?;
    let user: ClinicianUser =
        sqlx::query_as("SELECT id, username, display_name, role FROM accounts WHERE id = $1")
            .bind(account_id)
            .fetch_one(&state.db)
            .await?;

    let cookie = Cookie::build((SESSION_COOKIE, token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(state.config.cookie_secure)
        .max_age(Duration::days(state.config.session_days))
        .build();
    Ok((jar.add(cookie), Json(json!({ "user": user }))))
}

pub async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<(CookieJar, Json<serde_json::Value>)> {
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
            .bind(token_hash(cookie.value()))
            .execute(&state.db)
            .await?;
    }
    Ok((
        jar.remove(Cookie::build(SESSION_COOKIE).path("/").build()),
        Json(json!({ "ok": true })),
    ))
}

pub async fn me(user: ClinicianUser) -> Json<serde_json::Value> {
    Json(json!({ "user": user }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passwords_hash_and_verify() {
        let hash = hash_password("correct horse battery").expect("hash");
        assert!(hash.starts_with("$argon2"));
        assert!(verify_password("correct horse battery", &hash));
        assert!(!verify_password("wrong", &hash));
        assert!(!verify_password("x", "not a hash"));
    }

    #[test]
    fn tokens_are_long_random_hex_and_stored_only_as_a_hash() {
        let (a, b) = (new_token(), new_token());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert_eq!(token_hash(&a).len(), 32);
        assert_ne!(token_hash(&a), token_hash(&b));
    }

    #[test]
    fn the_dummy_hash_is_a_real_hash() {
        assert!(DUMMY_HASH.starts_with("$argon2"));
    }
}
