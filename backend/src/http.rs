//! Request extractors shared by the routes: JSON bodies with the contract's error codes, and the client key.

use std::net::{IpAddr, SocketAddr};

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
        // An empty body is fine without a content type, but a form post (urlencoded, text/plain) is not:
        // that is the shape a cross-site HTML form produces.
        if allow_empty && json == Some(false) {
            return Err(AppError::UnsupportedMediaType);
        }
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

/// The address as the limiter should see it: an IPv6 address stands for its whole /64 (one subscriber can
/// rotate through billions of addresses inside it), an IPv4-mapped IPv6 address is the IPv4 address.
pub fn client_address(raw: &str) -> String {
    match raw.trim().parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.to_string(),
        Ok(IpAddr::V6(v6)) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let s = v6.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
            }
        },
        Err(_) => raw.trim().to_string(),
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
        Ok(Self(state.limiter.key(&client_address(&address))))
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

    #[test]
    fn ipv6_clients_are_keyed_by_their_slash_64() {
        assert_eq!(client_address("203.0.113.9"), "203.0.113.9");
        assert_eq!(
            client_address("2001:db8:1:2:aaaa:bbbb:cccc:dddd"),
            "2001:db8:1:2::/64"
        );
        assert_eq!(
            client_address("2001:db8:1:2:1111:2222:3333:4444"),
            client_address("2001:db8:1:2:aaaa:bbbb:cccc:dddd")
        );
        assert_ne!(
            client_address("2001:db8:1:3::1"),
            client_address("2001:db8:1:2::1")
        );
        assert_eq!(client_address("::ffff:203.0.113.9"), "203.0.113.9");
        assert_eq!(client_address(" not an ip "), "not an ip");
    }

    #[tokio::test]
    async fn an_empty_form_post_is_refused_but_a_bare_empty_post_is_fine() {
        use axum::body::Body;
        #[derive(serde::Deserialize, Default)]
        struct Probe {}
        let post = |ct: Option<&str>| {
            let mut builder = Request::builder().method("POST").uri("/x");
            if let Some(ct) = ct {
                builder = builder.header(CONTENT_TYPE, ct);
            }
            builder.body(Body::empty()).expect("request")
        };
        assert!(
            OptionalJson::<Probe>::from_request(post(None), &())
                .await
                .is_ok()
        );
        assert!(
            OptionalJson::<Probe>::from_request(post(Some("application/json")), &())
                .await
                .is_ok()
        );
        for ct in [
            "application/x-www-form-urlencoded",
            "text/plain",
            "multipart/form-data; boundary=x",
        ] {
            assert!(
                matches!(
                    OptionalJson::<Probe>::from_request(post(Some(ct)), &()).await,
                    Err(AppError::UnsupportedMediaType)
                ),
                "{ct}"
            );
        }
    }
}
