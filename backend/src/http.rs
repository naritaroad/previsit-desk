//! Request extractors shared by the routes: JSON bodies with the contract's error codes, and the client key.

use std::net::SocketAddr;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, FromRequest, FromRequestParts, Request};
use axum::http::header::CONTENT_TYPE;
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode};
use serde::de::DeserializeOwned;

use crate::error::AppError;
use crate::limits::ClientKey;
use crate::state::AppState;

fn is_json(headers: &HeaderMap) -> Option<bool> {
    headers.get(CONTENT_TYPE).map(|v| {
        let value = v.to_str().unwrap_or("").to_ascii_lowercase();
        let essence = value.split(';').next().unwrap_or("").trim().to_string();
        essence == "application/json" || essence.ends_with("+json")
    })
}

async fn read_json<T: DeserializeOwned, S: Send + Sync>(
    req: Request,
    state: &S,
    allow_empty: bool,
) -> Result<Option<T>, AppError> {
    let json = is_json(req.headers());
    let bytes = Bytes::from_request(req, state).await.map_err(|rejection| {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            AppError::PayloadTooLarge
        } else {
            AppError::BadRequest("could not read the request body".into())
        }
    })?;
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return if allow_empty {
            Ok(None)
        } else {
            Err(AppError::BadRequest("a JSON body is required".into()))
        };
    }
    if json != Some(true) {
        return Err(AppError::UnsupportedMediaType);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| AppError::BadRequest(format!("invalid JSON: {e}")))
}

/// A required JSON body. Wrong content type is 415 `unsupported_media_type`; malformed JSON is 400 `invalid_request`.
pub struct ApiJson<T>(pub T);

impl<T: DeserializeOwned, S: Send + Sync> FromRequest<S> for ApiJson<T> {
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        Ok(Self(read_json(req, state, false).await?.ok_or_else(
            || AppError::BadRequest("a JSON body is required".into()),
        )?))
    }
}

/// A JSON body that may be left out entirely (then `T::default()`).
pub struct OptionalJson<T>(pub T);

impl<T: DeserializeOwned + Default, S: Send + Sync> FromRequest<S> for OptionalJson<T> {
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        Ok(Self(read_json(req, state, true).await?.unwrap_or_default()))
    }
}

/// Salted hash of the client address, from `CLIENT_IP_HEADER` when set, else the socket address.
pub struct ClientId(pub ClientKey);

impl FromRequestParts<AppState> for ClientId {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let from_header = state
            .config
            .client_ip_header
            .as_deref()
            .and_then(|name| parts.headers.get(name))
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string);
        let address = from_header
            .or_else(|| {
                parts
                    .extensions
                    .get::<ConnectInfo<SocketAddr>>()
                    .map(|c| c.0.ip().to_string())
            })
            .unwrap_or_default();
        Ok(Self(state.limiter.key(&address)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn json_content_types_are_recognised() {
        let mut headers = HeaderMap::new();
        assert_eq!(is_json(&headers), None);
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        assert_eq!(is_json(&headers), Some(true));
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("Application/JSON; charset=utf-8"),
        );
        assert_eq!(is_json(&headers), Some(true));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        assert_eq!(is_json(&headers), Some(false));
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/x-www-form-urlencoded"),
        );
        assert_eq!(is_json(&headers), Some(false));
    }

    #[tokio::test]
    async fn bodies_are_checked_for_type_and_syntax() {
        use axum::body::Body;
        #[derive(serde::Deserialize, Default)]
        struct Probe {
            a: Option<i32>,
        }
        let make = |ct: Option<&str>, body: &str| {
            let mut builder = Request::builder().method("POST").uri("/x");
            if let Some(ct) = ct {
                builder = builder.header(CONTENT_TYPE, ct);
            }
            builder.body(Body::from(body.to_string())).expect("request")
        };
        let ok: ApiJson<Probe> =
            ApiJson::from_request(make(Some("application/json"), r#"{"a":1}"#), &())
                .await
                .expect("ok");
        assert_eq!(ok.0.a, Some(1));
        assert!(matches!(
            ApiJson::<Probe>::from_request(make(Some("text/plain"), r#"{"a":1}"#), &()).await,
            Err(AppError::UnsupportedMediaType)
        ));
        assert!(matches!(
            ApiJson::<Probe>::from_request(make(None, r#"{"a":1}"#), &()).await,
            Err(AppError::UnsupportedMediaType)
        ));
        assert!(matches!(
            ApiJson::<Probe>::from_request(make(Some("application/json"), "{nope"), &()).await,
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            ApiJson::<Probe>::from_request(make(Some("application/json"), ""), &()).await,
            Err(AppError::BadRequest(_))
        ));
        let empty = OptionalJson::<Probe>::from_request(make(None, ""), &())
            .await
            .expect("optional empty");
        assert_eq!(empty.0.a, None);
        assert!(matches!(
            OptionalJson::<Probe>::from_request(make(Some("text/plain"), r#"{"a":1}"#), &()).await,
            Err(AppError::UnsupportedMediaType)
        ));
    }
}
