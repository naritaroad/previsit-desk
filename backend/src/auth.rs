//! Accounts, cookie sessions and the request extractors (docs/v2/contract.md §2).
//!
//! `session_layer` runs around every API request: it resolves the cookie once, checks `Origin` on mutations, sets the
//! request's language and slides the session's expiry. Handlers take [`CurrentUser`] and call [`CurrentUser::require`]
//! with the permission they need.

use std::sync::LazyLock;

use anyhow::Result;
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use axum::Json;
use axum::extract::{FromRequestParts, Path, Request, State};
use axum::http::header::{ACCEPT_LANGUAGE, HOST, ORIGIN, SET_COOKIE, USER_AGENT};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum_extra::extract::CookieJar;
use axum_extra::extract::cookie::{Cookie, SameSite};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::audit::{self, AuditKind};
use crate::demo;
use crate::error::{AppError, AppResult, REQUEST_LOCALE};
use crate::http::{ApiJson, ClientId};
use crate::limits::Bucket;
use crate::people::PersonRef;
use crate::perm::{Permission, Role};
use crate::state::AppState;
use crate::texts::{T, fmt, t};
use crate::types::Locale;
use crate::{config, pii};

pub const SESSION_COOKIE: &str = "pv_session";
const LOGIN_ATTEMPTS_PER_WINDOW: u32 = 10;
/// Attempts per account name from anywhere, so rotating addresses does not help a guesser.
const LOGIN_ATTEMPTS_PER_NAME: u32 = 20;
const GUESTS_PER_WINDOW: u32 = 10;
/// Changes one account may make in ten minutes, autosaves included.
const WRITES_PER_WINDOW: u32 = 600;
/// The session row is touched (and its expiry moved) at most this often.
const TOUCH_EVERY: Duration = Duration::minutes(5);

// ---------------------------------------------------------------------------
// Passwords and tokens
// ---------------------------------------------------------------------------

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

async fn hash_off_thread(password: String) -> AppResult<String> {
    Ok(
        tokio::task::spawn_blocking(move || hash_password(&password))
            .await
            .map_err(anyhow::Error::from)??,
    )
}

async fn verify_off_thread(password: String, hash: String) -> AppResult<bool> {
    Ok(
        tokio::task::spawn_blocking(move || verify_password(&password, &hash))
            .await
            .map_err(anyhow::Error::from)?,
    )
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

/// A one-time password for accounts an administrator creates or resets: 16 characters without look-alikes.
pub fn one_time_password() -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghjkmnpqrstuvwxyz23456789A";
    let mut bytes = [0u8; 16];
    rand::fill(&mut bytes[..]);
    bytes
        .iter()
        .map(|b| ALPHABET[usize::from(*b) % ALPHABET.len()] as char)
        .collect()
}

// ---------------------------------------------------------------------------
// The signed-in account
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct CurrentUser {
    pub id: Uuid,
    pub session_id: Uuid,
    pub username: Option<String>,
    pub display_name: String,
    pub display_name_en: Option<String>,
    #[sqlx(try_from = "String")]
    pub role: Role,
    pub title: Option<String>,
    pub title_en: Option<String>,
    pub avatar: Option<String>,
    #[sqlx(try_from = "String")]
    pub locale: Locale,
    pub preferences: Value,
    pub is_guest: bool,
    pub is_demo: bool,
    pub must_change_password: bool,
    /// Guest sandboxes: when the whole account is deleted.
    pub expires_at: Option<OffsetDateTime>,
    last_seen_at: OffsetDateTime,
}

impl CurrentUser {
    pub fn can(&self, permission: Permission) -> bool {
        self.role.can(permission)
    }

    /// 403 unless the account's role holds `permission`.
    pub fn require(&self, permission: Permission) -> AppResult<()> {
        if self.can(permission) {
            Ok(())
        } else {
            Err(AppError::Forbidden)
        }
    }

    pub fn is_patient(&self) -> bool {
        self.role == Role::Patient
    }

    pub fn person(&self, locale: Locale) -> PersonRef {
        crate::people::PersonRow {
            id: self.id,
            display_name: self.display_name.clone(),
            display_name_en: self.display_name_en.clone(),
            role: self.role,
            title: self.title.clone(),
            title_en: self.title_en.clone(),
            avatar: self.avatar.clone(),
        }
        .to_ref(locale)
    }
}

impl<S: Send + Sync> FromRequestParts<S> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<CurrentUser>()
            .cloned()
            .ok_or(AppError::Unauthorized)
    }
}

macro_rules! user_select {
    () => {
        "SELECT a.id, s.id AS session_id, a.username, a.display_name, a.display_name_en, a.role, a.title, a.title_en, a.avatar, a.locale, a.preferences, a.is_guest, a.is_demo, a.must_change_password, a.expires_at, s.last_seen_at
         FROM sessions s JOIN accounts a ON a.id = s.account_id
         WHERE s.expires_at > now() AND a.status = 'active' AND (a.expires_at IS NULL OR a.expires_at > now()) AND "
    };
}

async fn user_for_token(db: &PgPool, token: &str) -> sqlx::Result<Option<CurrentUser>> {
    sqlx::query_as(concat!(user_select!(), "s.token_hash = $1"))
        .bind(token_hash(token))
        .fetch_optional(db)
        .await
}

/// Whether the session still exists and its account is active (long-lived streams re-check this).
pub async fn session_alive(db: &PgPool, session_id: Uuid) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id = $1 AND s.expires_at > now() AND a.status = 'active' AND (a.expires_at IS NULL OR a.expires_at > now()))",
    )
    .bind(session_id)
    .fetch_one(db)
    .await
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

fn host_only(authority: &str) -> &str {
    let authority = authority.trim();
    if let Some(end) = authority.strip_prefix('[').and_then(|rest| rest.find(']')) {
        return &authority[..end + 2];
    }
    authority.split(':').next().unwrap_or(authority)
}

/// Same site = same host name; ports do not count, and the loopback names are one site (the development server).
pub fn same_site(origin: &str, host: &str) -> bool {
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    if scheme != "http" && scheme != "https" {
        return false;
    }
    let canonical = |h: &str| {
        let h = host_only(h).to_ascii_lowercase();
        match h.as_str() {
            "localhost" | "127.0.0.1" | "[::1]" => "loopback".to_string(),
            _ => h,
        }
    };
    let (a, b) = (
        canonical(rest.split('/').next().unwrap_or("")),
        canonical(host),
    );
    !a.is_empty() && a == b
}

fn origin_allowed(method: &Method, headers: &HeaderMap) -> bool {
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return true;
    }
    let text = |name| {
        headers
            .get(name)
            .and_then(|v: &HeaderValue| v.to_str().ok())
    };
    if text(axum::http::HeaderName::from_static("sec-fetch-site")) == Some("cross-site") {
        return false;
    }
    match headers.get(ORIGIN) {
        None => true,
        Some(_) => match (text(ORIGIN), text(HOST)) {
            (Some(origin), Some(host)) => same_site(origin, host),
            _ => false,
        },
    }
}

fn header_locale(headers: &HeaderMap) -> Locale {
    headers
        .get(ACCEPT_LANGUAGE)
        .and_then(|v| v.to_str().ok())
        .map(Locale::from_accept_language)
        .unwrap_or(Locale::ZhTw)
}

/// Runs around every API request; see the module comment.
pub async fn session_layer(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Response {
    let fallback_locale = header_locale(req.headers());
    if !origin_allowed(req.method(), req.headers()) {
        return REQUEST_LOCALE
            .scope(fallback_locale, async {
                AppError::Forbidden.into_response()
            })
            .await;
    }
    let token = CookieJar::from_headers(req.headers())
        .get(SESSION_COOKIE)
        .map(|c| c.value().to_string());
    let user = match &token {
        None => None,
        Some(token) => match user_for_token(&state.db, token).await {
            Ok(user) => user,
            Err(e) => {
                return REQUEST_LOCALE
                    .scope(fallback_locale, async {
                        AppError::Database(e).into_response()
                    })
                    .await;
            }
        },
    };
    let locale = user.as_ref().map_or(fallback_locale, |u| u.locale);
    if let Some(user) = &user
        && !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS)
        && let Err(retry_after) = state.limiter.check(
            Bucket::Writes,
            state.limiter.key(&user.id.to_string()),
            WRITES_PER_WINDOW,
        )
    {
        return REQUEST_LOCALE
            .scope(locale, async {
                AppError::RateLimited { retry_after }.into_response()
            })
            .await;
    }
    let mut refresh = None;
    if let Some(user) = user {
        if OffsetDateTime::now_utc() - user.last_seen_at > TOUCH_EVERY {
            let expires = session_expiry(&state, user.expires_at);
            let touched = sqlx::query(
                "UPDATE sessions SET last_seen_at = now(), expires_at = $2 WHERE id = $1",
            )
            .bind(user.session_id)
            .bind(expires)
            .execute(&state.db)
            .await;
            if touched.is_ok() {
                refresh = token
                    .map(|t| session_cookie(&state, t, expires).to_string())
                    .and_then(|c| HeaderValue::from_str(&c).ok());
            }
        }
        req.extensions_mut().insert(user);
    }
    let mut response = REQUEST_LOCALE.scope(locale, next.run(req)).await;
    // A handler that sets or clears the cookie itself (login, logout) wins.
    if let Some(cookie) = refresh
        && !response.headers().contains_key(SET_COOKIE)
    {
        response.headers_mut().append(SET_COOKIE, cookie);
    }
    response
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

fn session_expiry(state: &AppState, account_expires: Option<OffsetDateTime>) -> OffsetDateTime {
    let sliding = OffsetDateTime::now_utc() + Duration::days(state.config.session_days);
    account_expires.map_or(sliding, |e| e.min(sliding))
}

fn session_cookie(state: &AppState, token: String, expires: OffsetDateTime) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(state.config.cookie_secure)
        .max_age(expires - OffsetDateTime::now_utc())
        .build()
}

/// "Chrome · Windows": enough to recognise a device in the list, nothing more is kept from the User-Agent.
pub fn device_label(user_agent: &str) -> String {
    let has = |needle: &str| user_agent.contains(needle);
    let browser = if has("Edg/") {
        "Edge"
    } else if has("OPR/") {
        "Opera"
    } else if has("Firefox/") || has("FxiOS/") {
        "Firefox"
    } else if has("Chrome/") || has("CriOS/") {
        "Chrome"
    } else if has("Safari/") {
        "Safari"
    } else if has("curl/") {
        "curl"
    } else {
        ""
    };
    let system = if has("Windows") {
        "Windows"
    } else if has("iPhone") || has("iPad") {
        "iOS"
    } else if has("Android") {
        "Android"
    } else if has("Mac OS X") {
        "macOS"
    } else if has("Linux") {
        "Linux"
    } else {
        ""
    };
    [browser, system]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

/// Opens a session for the account and returns the cookie.
async fn open_session(
    state: &AppState,
    account_id: Uuid,
    account_expires: Option<OffsetDateTime>,
    headers: &HeaderMap,
) -> AppResult<(Cookie<'static>, CurrentUser)> {
    let token = new_token();
    let expires = session_expiry(state, account_expires);
    let device = headers
        .get(USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(device_label)
        .unwrap_or_default();
    sqlx::query(
        "INSERT INTO sessions (token_hash, account_id, expires_at, device) VALUES ($1, $2, $3, $4)",
    )
    .bind(token_hash(&token))
    .bind(account_id)
    .bind(expires)
    .bind(device)
    .execute(&state.db)
    .await?;
    sqlx::query("UPDATE accounts SET last_login_at = now() WHERE id = $1")
        .bind(account_id)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE expires_at < now()")
        .execute(&state.db)
        .await?;
    let user = user_for_token(&state.db, &token)
        .await?
        .ok_or(AppError::Unauthorized)?;
    Ok((session_cookie(state, token, expires), user))
}

// ---------------------------------------------------------------------------
// Me
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct Me {
    id: Uuid,
    username: Option<String>,
    display_name: String,
    role: Role,
    title: Option<String>,
    avatar: Option<String>,
    is_guest: bool,
    is_demo: bool,
    locale: Locale,
    preferences: Value,
    permissions: Vec<Permission>,
    unread_notifications: i64,
    must_change_password: bool,
    #[serde(with = "time::serde::rfc3339::option")]
    expires_at: Option<OffsetDateTime>,
}

pub async fn me_of(db: &PgPool, user: &CurrentUser) -> sqlx::Result<Me> {
    let unread: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM notifications WHERE account_id = $1 AND read_at IS NULL",
    )
    .bind(user.id)
    .fetch_one(db)
    .await?;
    let person = user.person(user.locale);
    Ok(Me {
        id: user.id,
        username: user.username.clone(),
        display_name: person.display_name,
        role: user.role,
        title: person.title,
        avatar: user.avatar.clone(),
        is_guest: user.is_guest,
        is_demo: user.is_demo,
        locale: user.locale,
        preferences: user.preferences.clone(),
        permissions: user.role.permissions().to_vec(),
        unread_notifications: unread,
        must_change_password: user.must_change_password,
        expires_at: user.expires_at,
    })
}

/// The account as it is now (after a change in this request).
pub async fn reload(db: &PgPool, session_id: Uuid) -> AppResult<CurrentUser> {
    sqlx::query_as(concat!(user_select!(), "s.id = $1"))
        .bind(session_id)
        .fetch_optional(db)
        .await?
        .ok_or(AppError::Unauthorized)
}

pub async fn me(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    Ok(Json(json!({ "me": me_of(&state.db, &user).await? })))
}

// ---------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------

pub fn clean_username(text: &str, locale: Locale) -> AppResult<String> {
    let name = text.trim().to_ascii_lowercase();
    let ok = (3..=32).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.-".contains(&b))
        && name.as_bytes()[0].is_ascii_alphanumeric();
    if ok {
        Ok(name)
    } else {
        Err(AppError::field("username", t(T::FieldErrUsername, locale)))
    }
}

pub fn clean_password(text: &str, field: &str, locale: Locale) -> AppResult<String> {
    let n = text.chars().count();
    if (8..=128).contains(&n) {
        Ok(text.to_string())
    } else {
        Err(AppError::field(field, t(T::FieldErrPassword, locale)))
    }
}

pub fn clean_display_name(text: &str, locale: Locale) -> AppResult<String> {
    let name = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let n = name.chars().count();
    if !(1..=40).contains(&n) || name.chars().any(char::is_control) {
        return Err(AppError::field(
            "display_name",
            fmt(T::FieldErrLength, locale, &[("min", "1"), ("max", "40")]),
        ));
    }
    if pii::looks_personal(&name) {
        return Err(AppError::field(
            "display_name",
            t(T::FieldErrPersonal, locale),
        ));
    }
    Ok(name)
}

/// A unique-violation on the username becomes a field error.
pub fn username_taken(error: sqlx::Error, locale: Locale) -> AppError {
    match &error {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            AppError::field("username", t(T::FieldErrTaken, locale))
        }
        _ => error.into(),
    }
}

fn check_guest_rate(state: &AppState, client: crate::limits::ClientKey) -> AppResult<()> {
    state
        .limiter
        .check(Bucket::Guest, client, GUESTS_PER_WINDOW)
        .map_err(|retry_after| AppError::RateLimited { retry_after })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

pub async fn login(
    State(state): State<AppState>,
    ClientId(client): ClientId,
    jar: CookieJar,
    headers: HeaderMap,
    ApiJson(req): ApiJson<LoginRequest>,
) -> AppResult<(CookieJar, Json<Value>)> {
    let limited = |retry_after| AppError::RateLimited { retry_after };
    state
        .limiter
        .check(Bucket::Login, client, LOGIN_ATTEMPTS_PER_WINDOW)
        .map_err(limited)?;
    let username = req.username.trim().to_lowercase();
    state
        .limiter
        .check(
            Bucket::Login,
            state.limiter.key(&format!("name:{username}")),
            LOGIN_ATTEMPTS_PER_NAME,
        )
        .map_err(limited)?;
    let row: Option<(Uuid, Option<String>, String, Option<OffsetDateTime>)> = sqlx::query_as(
        "SELECT id, password_hash, status, expires_at FROM accounts WHERE lower(username) = $1",
    )
    .bind(&username)
    .fetch_optional(&state.db)
    .await?;
    // Same answer and same work for an unknown user, a disabled account and a wrong password.
    let hash = row
        .as_ref()
        .and_then(|r| r.1.clone())
        .unwrap_or_else(|| DUMMY_HASH.clone());
    let verified = verify_off_thread(req.password, hash).await?
        && row
            .as_ref()
            .is_some_and(|r| r.1.is_some() && r.2 == "active");
    let Some((account_id, _, _, expires)) = row.filter(|_| verified) else {
        audit::audit(
            &state.db,
            None,
            AuditKind::Auth,
            "login.failed",
            "",
            Value::Null,
        )
        .await;
        return Err(AppError::InvalidCredentials);
    };
    // Signing in on a device that still holds a session replaces that session.
    if let Some(old) = jar.get(SESSION_COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
            .bind(token_hash(old.value()))
            .execute(&state.db)
            .await?;
    }
    let (cookie, user) = open_session(&state, account_id, expires, &headers).await?;
    if user.role.is_staff() {
        audit::audit(
            &state.db,
            Some(&user),
            AuditKind::Auth,
            "login",
            &format!("account:{}", user.id),
            Value::Null,
        )
        .await;
    }
    let me = me_of(&state.db, &user).await?;
    Ok((jar.add(cookie), Json(json!({ "me": me }))))
}

pub async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<(CookieJar, Json<Value>)> {
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

#[derive(Deserialize)]
pub struct GuestRequest {
    locale: Option<String>,
    persona: Option<String>,
}

fn parse_locale(text: Option<&str>) -> AppResult<Option<Locale>> {
    match text {
        None => Ok(None),
        Some(text) => Locale::parse(text).map(Some).ok_or_else(|| {
            AppError::field(
                "locale",
                t(T::FieldErrChoice, crate::error::request_locale()),
            )
        }),
    }
}

pub async fn guest(
    State(state): State<AppState>,
    ClientId(client): ClientId,
    jar: CookieJar,
    headers: HeaderMap,
    ApiJson(req): ApiJson<GuestRequest>,
) -> AppResult<(StatusCode, CookieJar, Json<Value>)> {
    check_guest_rate(&state, client)?;
    let locale = parse_locale(req.locale.as_deref())?.unwrap_or_else(crate::error::request_locale);
    let persona = req.persona.as_deref().unwrap_or(demo::DEFAULT_PERSONA);
    if state.demo.persona(persona).is_none() {
        return Err(AppError::field("persona", t(T::FieldErrChoice, locale)));
    }
    let (account_id, expires) = demo::create_guest(&state, persona, locale).await?;
    let (cookie, user) = open_session(&state, account_id, Some(expires), &headers).await?;
    let me = me_of(&state.db, &user).await?;
    Ok((
        StatusCode::CREATED,
        jar.add(cookie),
        Json(json!({ "me": me })),
    ))
}

pub async fn personas(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "items": state.demo.persona_cards() }))
}

#[derive(Deserialize)]
pub struct ClaimRequest {
    username: String,
    password: String,
    display_name: String,
}

pub async fn claim(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(client): ClientId,
    ApiJson(req): ApiJson<ClaimRequest>,
) -> AppResult<Json<Value>> {
    check_guest_rate(&state, client)?;
    if !user.is_guest {
        return Err(AppError::InvalidState(
            "only a guest sandbox can be claimed",
        ));
    }
    let username = clean_username(&req.username, user.locale)?;
    let password = clean_password(&req.password, "password", user.locale)?;
    let display_name = clean_display_name(&req.display_name, user.locale)?;
    let hash = hash_off_thread(password).await?;
    sqlx::query(
        "UPDATE accounts SET username = $2, password_hash = $3, display_name = $4, display_name_en = NULL, is_guest = false, expires_at = NULL WHERE id = $1 AND is_guest",
    )
    .bind(user.id)
    .bind(&username)
    .bind(hash)
    .bind(display_name)
    .execute(&state.db)
    .await
    .map_err(|e| username_taken(e, user.locale))?;
    let user = reload(&state.db, user.session_id).await?;
    audit::audit(
        &state.db,
        Some(&user),
        AuditKind::Auth,
        "account.claim",
        &format!("account:{}", user.id),
        Value::Null,
    )
    .await;
    Ok(Json(json!({ "me": me_of(&state.db, &user).await? })))
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    username: String,
    password: String,
    display_name: String,
    locale: Option<String>,
}

pub async fn register(
    State(state): State<AppState>,
    ClientId(client): ClientId,
    jar: CookieJar,
    headers: HeaderMap,
    ApiJson(req): ApiJson<RegisterRequest>,
) -> AppResult<(StatusCode, CookieJar, Json<Value>)> {
    check_guest_rate(&state, client)?;
    let locale = parse_locale(req.locale.as_deref())?.unwrap_or_else(crate::error::request_locale);
    let username = clean_username(&req.username, locale)?;
    let password = clean_password(&req.password, "password", locale)?;
    let display_name = clean_display_name(&req.display_name, locale)?;
    let hash = hash_off_thread(password).await?;
    let mut tx = state.db.begin().await?;
    let id: Uuid = sqlx::query_scalar("INSERT INTO accounts (username, password_hash, display_name, role, locale) VALUES ($1, $2, $3, 'patient', $4) RETURNING id")
        .bind(&username)
        .bind(hash)
        .bind(display_name)
        .bind(locale.as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| username_taken(e, locale))?;
    sqlx::query("INSERT INTO patient_profiles (account_id) VALUES ($1)")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO patient_care (account_id) VALUES ($1)")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let (cookie, user) = open_session(&state, id, None, &headers).await?;
    let me = me_of(&state.db, &user).await?;
    Ok((
        StatusCode::CREATED,
        jar.add(cookie),
        Json(json!({ "me": me })),
    ))
}

#[derive(Deserialize)]
pub struct PasswordRequest {
    current: String,
    next: String,
}

/// Changes the password and ends every other session of the account.
pub async fn change_password(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(client): ClientId,
    ApiJson(req): ApiJson<PasswordRequest>,
) -> AppResult<Json<Value>> {
    state
        .limiter
        .check(Bucket::Login, client, LOGIN_ATTEMPTS_PER_WINDOW)
        .map_err(|retry_after| AppError::RateLimited { retry_after })?;
    let hash: Option<String> =
        sqlx::query_scalar("SELECT password_hash FROM accounts WHERE id = $1")
            .bind(user.id)
            .fetch_one(&state.db)
            .await?;
    let Some(hash) = hash else {
        return Err(AppError::InvalidState("a guest sandbox has no password"));
    };
    if !verify_off_thread(req.current, hash).await? {
        return Err(AppError::field(
            "current",
            t(T::ErrInvalidCredentials, user.locale),
        ));
    }
    let next = clean_password(&req.next, "next", user.locale)?;
    let hash = hash_off_thread(next).await?;
    sqlx::query(
        "UPDATE accounts SET password_hash = $2, must_change_password = false WHERE id = $1",
    )
    .bind(user.id)
    .bind(hash)
    .execute(&state.db)
    .await?;
    sqlx::query("DELETE FROM sessions WHERE account_id = $1 AND id <> $2")
        .bind(user.id)
        .bind(user.session_id)
        .execute(&state.db)
        .await?;
    audit::audit(
        &state.db,
        Some(&user),
        AuditKind::Auth,
        "password.change",
        &format!("account:{}", user.id),
        Value::Null,
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Serialize, sqlx::FromRow)]
struct SessionRow {
    id: Uuid,
    device: String,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    last_seen_at: OffsetDateTime,
    current: bool,
}

pub async fn sessions(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<crate::page::Page<impl Serialize>>> {
    let rows: Vec<SessionRow> = sqlx::query_as(
        "SELECT id, device, created_at, last_seen_at, id = $2 AS current FROM sessions WHERE account_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC, id LIMIT 50",
    )
    .bind(user.id)
    .bind(user.session_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(crate::page::Page::all(rows)))
}

pub async fn delete_session(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let id = Uuid::parse_str(&id).map_err(|_| AppError::NotFound)?;
    let done = sqlx::query("DELETE FROM sessions WHERE id = $1 AND account_id = $2")
        .bind(id)
        .bind(user.id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if done == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// The five default accounts
// ---------------------------------------------------------------------------

/// Creates or updates the default accounts whose password is in the environment. The environment wins: a changed
/// password there replaces the stored one and ends the sessions opened with it. Nothing is logged about passwords.
pub async fn ensure_accounts(
    db: &PgPool,
    logins: &[config::DefaultLogin],
    demo: &demo::DemoData,
) -> Result<()> {
    if logins.is_empty() {
        tracing::warn!("no default account password is set; nobody can sign in with a password");
    }
    for login in logins {
        let Some(seed) = demo.accounts.iter().find(|a| a.key == login.key) else {
            anyhow::bail!("data/seed/demo/accounts.json has no account {}", login.key);
        };
        let username = login
            .username
            .clone()
            .unwrap_or_else(|| seed.username.clone())
            .to_lowercase();
        let display_name = login
            .display_name
            .clone()
            .unwrap_or_else(|| seed.display_name.clone());
        let existing: Option<(Uuid, Option<String>)> =
            sqlx::query_as("SELECT id, password_hash FROM accounts WHERE lower(username) = $1")
                .bind(&username)
                .fetch_optional(db)
                .await?;
        let id = match existing {
            Some((id, hash)) => {
                if !hash.is_some_and(|h| verify_password(&login.password, &h)) {
                    sqlx::query("UPDATE accounts SET password_hash = $2 WHERE id = $1")
                        .bind(id)
                        .bind(hash_password(&login.password)?)
                        .execute(db)
                        .await?;
                    sqlx::query("DELETE FROM sessions WHERE account_id = $1")
                        .bind(id)
                        .execute(db)
                        .await?;
                }
                id
            }
            None => {
                sqlx::query_scalar("INSERT INTO accounts (username, display_name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id")
                    .bind(&username)
                    .bind(&display_name)
                    .bind(hash_password(&login.password)?)
                    .bind(seed.role.as_str())
                    .fetch_one(db)
                    .await?
            }
        };
        sqlx::query(
            "UPDATE accounts SET display_name = $2, display_name_en = $3, title = $4, title_en = $5, avatar = $6, role = $7, is_demo = $8, demo_key = $9, status = 'active', is_guest = false, expires_at = NULL, must_change_password = false WHERE id = $1",
        )
        .bind(id)
        .bind(&display_name)
        .bind(&seed.display_name_en)
        .bind(&seed.title)
        .bind(&seed.title_en)
        .bind(&seed.avatar)
        .bind(seed.role.as_str())
        .bind(seed.role != Role::Admin)
        .bind(login.key)
        .execute(db)
        .await?;
        if seed.role == Role::Patient {
            for statement in [
                "INSERT INTO patient_profiles (account_id) VALUES ($1) ON CONFLICT DO NOTHING",
                "INSERT INTO patient_care (account_id) VALUES ($1) ON CONFLICT DO NOTHING",
            ] {
                sqlx::query(statement).bind(id).execute(db).await?;
            }
        }
        tracing::info!(username = %username, role = seed.role.as_str(), "default account ready");
    }
    Ok(())
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
        assert_eq!(one_time_password().len(), 16);
        assert_ne!(one_time_password(), one_time_password());
    }

    #[test]
    fn the_dummy_hash_is_a_real_hash() {
        assert!(DUMMY_HASH.starts_with("$argon2"));
    }

    #[test]
    fn mutations_need_a_same_site_origin() {
        assert!(same_site("https://desk.example", "desk.example"));
        assert!(same_site("http://localhost:5173", "127.0.0.1:8088"));
        assert!(same_site("http://[::1]:5173", "localhost:8088"));
        assert!(!same_site("https://evil.example", "desk.example"));
        assert!(!same_site(
            "https://desk.example.evil.example",
            "desk.example"
        ));
        assert!(!same_site("null", "desk.example"));
        assert!(!same_site("file://", "desk.example"));

        let headers = |pairs: &[(&'static str, &'static str)]| {
            let mut map = HeaderMap::new();
            for (k, v) in pairs {
                map.insert(*k, HeaderValue::from_static(v));
            }
            map
        };
        let cross = headers(&[("origin", "https://evil.example"), ("host", "desk.example")]);
        assert!(!origin_allowed(&Method::POST, &cross));
        assert!(!origin_allowed(&Method::DELETE, &cross));
        assert!(origin_allowed(&Method::GET, &cross));
        assert!(origin_allowed(
            &Method::POST,
            &headers(&[("host", "desk.example")])
        ));
        assert!(!origin_allowed(
            &Method::POST,
            &headers(&[("host", "desk.example"), ("sec-fetch-site", "cross-site")])
        ));
        assert!(!origin_allowed(
            &Method::POST,
            &headers(&[("host", "desk.example"), ("origin", "null")])
        ));
    }

    #[test]
    fn device_labels_are_short() {
        assert_eq!(
            device_label(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
            ),
            "Chrome · Windows"
        );
        assert_eq!(
            device_label(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"
            ),
            "Safari · iOS"
        );
        assert_eq!(device_label("curl/8.5"), "curl");
        assert_eq!(device_label("weird"), "");
    }

    #[test]
    fn usernames_passwords_and_names_are_checked() {
        let zh = Locale::ZhTw;
        assert_eq!(clean_username(" Lin_01 ", zh).expect("ok"), "lin_01");
        for bad in ["ab", "有中文", "a b c", "_abc", &"x".repeat(33)] {
            assert!(clean_username(bad, zh).is_err(), "{bad}");
        }
        assert!(clean_password("1234567", "password", zh).is_err());
        assert!(clean_password("12345678", "password", zh).is_ok());
        assert_eq!(clean_display_name("  小  林 ", zh).expect("ok"), "小 林");
        assert!(clean_display_name("0912345678", zh).is_err());
        assert!(clean_display_name("", zh).is_err());
    }
}
