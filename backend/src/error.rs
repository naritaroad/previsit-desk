//! One error type for HTTP handlers: `{"error": {"code": "...", "message": "..."}}` (contract §5, §7.4).
//! The message is localised from the visit's locale when a handler knows it, else from `Accept-Language`.

use std::collections::BTreeMap;

use axum::Json;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::texts;
use crate::types::Locale;

tokio::task_local! {
    /// Locale from the request's `Accept-Language`, set by a middleware around every API request.
    pub static REQUEST_LOCALE: Locale;
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not signed in")]
    Unauthorized,
    #[error("wrong username or password")]
    InvalidCredentials,
    #[error("not found")]
    NotFound,
    #[error("visit closed")]
    VisitClosed,
    #[error("rate limited")]
    RateLimited { retry_after: u64 },
    #[error("payload too large")]
    PayloadTooLarge,
    #[error("another message is being processed")]
    Conflict,
    #[error("{0}")]
    InvalidState(&'static str),
    #[error("only application/json is accepted")]
    UnsupportedMediaType,
    /// Malformed request (bad JSON, bad id): 400.
    #[error("{0}")]
    BadRequest(String),
    /// Well-formed but invalid fields: 422 with `error.fields`.
    #[error("invalid fields")]
    Unprocessable(BTreeMap<String, String>),
    /// Same error, but worded in the visit's language.
    #[error("{0}")]
    Localized(Box<AppError>, Locale),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn localized(self, locale: Locale) -> Self {
        Self::Localized(Box::new(self), locale)
    }

    pub fn field(name: &str, message: impl Into<String>) -> Self {
        Self::Unprocessable(BTreeMap::from([(name.to_string(), message.into())]))
    }

    fn parts(&self) -> (StatusCode, &'static str) {
        match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::InvalidCredentials => (StatusCode::UNAUTHORIZED, "invalid_credentials"),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::VisitClosed => (StatusCode::CONFLICT, "visit_closed"),
            Self::RateLimited { .. } => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            Self::PayloadTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
            Self::Conflict => (StatusCode::CONFLICT, "conflict"),
            Self::InvalidState(_) => (StatusCode::CONFLICT, "invalid_state"),
            Self::UnsupportedMediaType => {
                (StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type")
            }
            Self::BadRequest(_) => (StatusCode::BAD_REQUEST, "invalid_request"),
            Self::Unprocessable(_) => (StatusCode::UNPROCESSABLE_ENTITY, "invalid_request"),
            Self::Localized(inner, _) => inner.parts(),
            Self::Database(_) | Self::Internal(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal")
            }
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let mut locale = REQUEST_LOCALE.try_with(|l| *l).unwrap_or(Locale::ZhTw);
        let mut error = self;
        while let Self::Localized(inner, l) = error {
            locale = l;
            error = *inner;
        }
        let (status, code) = error.parts();
        // Internal details go to the log, never to the client.
        match &error {
            AppError::Database(e) => tracing::error!(error = %e, "database error"),
            AppError::Internal(e) => tracing::error!(error = ?e, "internal error"),
            _ => {}
        }
        let mut body =
            json!({ "error": { "code": code, "message": texts::error_message(code, locale) } });
        if let AppError::Unprocessable(fields) = &error {
            body["error"]["fields"] = json!(fields);
        }
        let mut response = (status, Json(body)).into_response();
        if let AppError::RateLimited { retry_after } = &error
            && let Ok(value) = HeaderValue::from_str(&retry_after.to_string())
        {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    async fn body_of(error: AppError) -> (StatusCode, serde_json::Value, Option<String>) {
        let response = error.into_response();
        let status = response.status();
        let retry = response
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let bytes = to_bytes(response.into_body(), 1 << 20).await.expect("body");
        (status, serde_json::from_slice(&bytes).expect("json"), retry)
    }

    #[tokio::test]
    async fn error_shape_and_codes() {
        let (status, body, _) = body_of(AppError::NotFound).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "not_found");
        assert!(
            body["error"]["message"]
                .as_str()
                .expect("message")
                .contains("找不到")
        );

        let (status, body, retry) = body_of(AppError::RateLimited { retry_after: 42 }).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(body["error"]["code"], "rate_limited");
        assert_eq!(retry.as_deref(), Some("42"));

        let (status, body, _) = body_of(AppError::Conflict).await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (StatusCode::CONFLICT, Some("conflict"))
        );
        let (status, body, _) = body_of(AppError::InvalidState("x")).await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (StatusCode::CONFLICT, Some("invalid_state"))
        );
        let (status, body, _) = body_of(AppError::UnsupportedMediaType).await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                Some("unsupported_media_type")
            )
        );
    }

    #[tokio::test]
    async fn fields_are_an_object_and_locale_follows_the_visit() {
        let (status, body, _) =
            body_of(AppError::field("last_fill_date", "bad").localized(Locale::En)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"]["code"], "invalid_request");
        assert_eq!(body["error"]["fields"]["last_fill_date"], "bad");
        assert_eq!(
            body["error"]["message"],
            "The request is not valid. Check it and send it again."
        );
    }

    #[tokio::test]
    async fn visit_closed_is_localised() {
        let (_, body, _) = body_of(AppError::VisitClosed.localized(Locale::En)).await;
        assert!(
            body["error"]["message"]
                .as_str()
                .expect("message")
                .contains("submitted")
        );
    }
}
