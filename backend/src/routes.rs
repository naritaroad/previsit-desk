//! Route assembly (docs/v2/contract.md), the static site and the security headers. Handlers live next to what they
//! do: `auth`, `me`, `visit_routes`, `patient`, `clinic`, `notes`, `admin`, `public`, `rx`.

use std::path::Path as FsPath;

use axum::Router;
use axum::http::HeaderValue;
use axum::http::header::HeaderName;
use axum::middleware;
use axum::routing::{any, delete, get, patch, post, put};
use sha2::Digest;
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::error::AppError;
use crate::state::AppState;
use crate::{
    admin, appts, auth, clinic, me, measure, notes, patient, profile, public, rx, visit_routes,
};

/// Bodies up to 64 KB: a clinical note is the largest thing anyone sends.
const MAX_BODY_BYTES: usize = 64 * 1024;

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

async fn not_found() -> AppError {
    AppError::NotFound
}

/// Standard base64 (with padding) of `bytes`, for CSP script hashes.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// `'sha256-…'` sources for every inline `<script>` (one without `src`) in the page.
fn inline_script_hashes(html: &str) -> Vec<String> {
    static SCRIPT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?is)<script([^>]*)>(.*?)</script>").expect("regex")
    });
    SCRIPT
        .captures_iter(html)
        .filter(|c| !c[1].to_ascii_lowercase().contains("src="))
        .map(|c| {
            format!(
                "'sha256-{}'",
                base64(&sha2::Sha256::digest(c[2].as_bytes()))
            )
        })
        .collect()
}

/// The Content-Security-Policy header. The page's one inline script (the theme bootstrap in `index.html`) is
/// allowed by its hash, computed from the file at start, so a rebuilt page keeps working and no other inline
/// script can run. Styles may be inline (React sets style attributes); nothing may load from another origin.
pub fn content_security_policy(web_dir: Option<&FsPath>) -> String {
    let mut script_src = vec!["'self'".to_string()];
    if let Some(html) = web_dir.and_then(|d| std::fs::read_to_string(d.join("index.html")).ok()) {
        script_src.extend(inline_script_hashes(&html));
    }
    format!(
        "default-src 'self'; script-src {}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
        script_src.join(" ")
    )
}

/// Everything under `/api/v2`.
fn api_router() -> Router<AppState> {
    Router::new()
        .route("/health", get(public::health))
        .route("/meta", get(public::meta))
        .route("/auth/guest", post(auth::guest))
        .route("/auth/personas", get(auth::personas))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        .route("/auth/claim", post(auth::claim))
        .route("/auth/register", post(auth::register))
        .route("/auth/password", post(auth::change_password))
        .route("/trust/facts", get(public::trust_facts))
        .route("/handbook", get(patient::handbook))
        .route("/handbook/search", get(patient::handbook_search))
        .route("/pharmacies", get(patient::pharmacies))
        .route("/me", patch(me::patch_me).delete(patient::delete_me))
        .route("/me/export", get(patient::export))
        .route("/me/sessions", get(auth::sessions))
        .route("/me/sessions/{id}", delete(auth::delete_session))
        .route("/me/preferences", put(me::put_preferences))
        .route("/me/notifications", get(me::notifications))
        .route("/me/notifications/read", post(me::read_notifications))
        .route(
            "/me/drafts/{scope}",
            get(me::get_draft)
                .put(me::put_draft)
                .delete(me::delete_draft),
        )
        .route("/me/stream", get(me::stream))
        .route(
            "/visits",
            get(visit_routes::list).post(visit_routes::create),
        )
        .route(
            "/visits/{id}",
            get(visit_routes::get)
                .patch(visit_routes::patch)
                .delete(visit_routes::delete),
        )
        .route("/visits/{id}/messages", post(visit_routes::post_message))
        .route("/visits/{id}/stream", get(visit_routes::stream))
        .route("/visits/{id}/runs/retry", post(visit_routes::retry))
        .route("/visits/{id}/summary", patch(visit_routes::patch_summary))
        .route("/visits/{id}/submit", post(visit_routes::submit))
        .route("/visits/{id}/handoff", post(visit_routes::handoff))
        .route(
            "/visits/{id}/refill-check",
            post(visit_routes::refill_check),
        )
        .route("/visits/{id}/assign", post(visit_routes::assign))
        .route("/visits/{id}/takeover", post(visit_routes::takeover))
        .route("/visits/{id}/release", post(visit_routes::release))
        .route(
            "/visits/{id}/staff-messages",
            post(visit_routes::staff_message),
        )
        .route("/visits/{id}/note", get(notes::get).put(notes::put))
        .route("/visits/{id}/note/sign", post(notes::sign))
        .route("/visits/{id}/note/addendum", post(notes::addendum))
        .route("/app/home", get(patient::home))
        .route("/app/access-log", get(patient::access_log))
        .route(
            "/app/consents",
            get(patient::consents).post(patient::add_consent),
        )
        .route("/app/profile", get(profile::get).put(profile::put))
        .route(
            "/app/measurements",
            get(measure::list).post(measure::create),
        )
        .route("/app/measurements/{id}", delete(measure::delete))
        .route("/appointments", get(appts::list).post(appts::book))
        .route("/appointments/slots", get(appts::slots))
        .route("/appointments/{id}/cancel", post(appts::cancel))
        .route("/clinic/overview", get(clinic::overview))
        .route("/clinic/worklist", get(clinic::worklist))
        .route("/clinic/patients", get(clinic::patients))
        .route(
            "/clinic/patients/{id}",
            get(clinic::patient).patch(clinic::patch_patient),
        )
        .route("/clinic/patients/{id}/notes", post(clinic::add_note))
        .route("/clinic/patients/{id}/contact", post(clinic::contact))
        .route(
            "/clinic/notes/{id}",
            patch(clinic::patch_note).delete(clinic::delete_note),
        )
        .route("/clinic/schedule", get(clinic::schedule))
        .route("/clinic/tickets", get(clinic::ticket_list))
        .route("/clinic/tickets/{id}/resolve", post(clinic::resolve_ticket))
        .route("/staff", get(clinic::staff))
        .route("/admin/overview", get(admin::overview))
        .route(
            "/admin/accounts",
            get(admin::accounts).post(admin::create_account),
        )
        .route(
            "/admin/accounts/{id}",
            get(admin::get_account).patch(admin::patch_account),
        )
        .route(
            "/admin/accounts/{id}/reset-password",
            post(admin::reset_password),
        )
        .route(
            "/admin/accounts/{id}/revoke-sessions",
            post(admin::revoke_sessions),
        )
        .route("/admin/permissions", get(admin::permissions))
        .route(
            "/admin/settings",
            get(admin::get_settings).put(admin::put_settings),
        )
        .route("/admin/models", get(admin::models))
        .route("/admin/oversight", get(admin::oversight))
        .route("/admin/runs", get(admin::runs))
        .route("/admin/runs/{id}", get(admin::run))
        .route("/admin/audit", get(admin::audit_list))
        .route("/admin/rules", get(admin::rules))
        .route("/admin/eval", get(admin::eval))
        .route("/admin/demo/reset", post(admin::demo_reset))
        .merge(rx::routes())
        .fallback(any(not_found))
}

pub fn app(state: AppState) -> Router {
    let csp = HeaderValue::from_str(&content_security_policy(state.config.web_dir.as_deref()))
        .unwrap_or_else(|_| HeaderValue::from_static("default-src 'self'"));
    let session = middleware::from_fn_with_state(state.clone(), auth::session_layer);
    let mut router = Router::new()
        .nest("/api/v2", api_router())
        // Kept for the deployed health checks.
        .route("/api/v1/health", get(public::health))
        .route("/api/{*rest}", any(not_found))
        .layer(session);
    if let Some(dir) = state.config.web_dir.clone() {
        // Single-page app: unknown paths get index.html so client routes survive a reload.
        router = router
            .fallback_service(ServeDir::new(&dir).fallback(ServeFile::new(dir.join("index.html"))));
    }
    router
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("x-frame-options"),
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("content-security-policy"),
            csp,
        ))
        .layer(CompressionLayer::new())
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn base64_matches_the_rfc_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(input.as_bytes()), expected);
        }
        // sha256 of the empty string, the well-known CSP example value.
        assert_eq!(
            base64(&sha2::Sha256::digest(b"")),
            "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="
        );
    }

    #[test]
    fn csp_allows_only_the_inline_script_that_is_in_the_page() {
        let dir = std::env::temp_dir().join(format!("previsit-csp-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let inline =
            "\n      try { document.documentElement.dataset.theme = 'dark'; } catch (e) {}\n    ";
        let html = format!(
            "<!doctype html><html><head><script>{inline}</script><script type=\"module\" crossorigin src=\"/assets/app.js\"></script></head><body></body></html>"
        );
        std::fs::write(dir.join("index.html"), &html).expect("write");
        let csp = content_security_policy(Some(&dir));
        let expected = format!(
            "'sha256-{}'",
            base64(&sha2::Sha256::digest(inline.as_bytes()))
        );
        assert!(
            csp.contains(&format!("script-src 'self' {expected};")),
            "{csp}"
        );
        assert_eq!(
            csp.matches("sha256-").count(),
            1,
            "the external module script gets no hash: {csp}"
        );
        for directive in [
            "default-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "connect-src 'self'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ] {
            assert!(csp.contains(directive), "{directive}");
        }
        // No page, no hash: scripts from this origin only.
        assert!(content_security_policy(None).contains("script-src 'self';"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_built_page_in_the_repo_has_only_hashable_inline_scripts() {
        let dist = FsPath::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("web")
            .join("dist");
        let Ok(html) = std::fs::read_to_string(dist.join("index.html")) else {
            return;
        };
        let csp = content_security_policy(Some(&dist));
        assert_eq!(
            csp.matches("sha256-").count(),
            inline_script_hashes(&html).len()
        );
        assert!(html.matches("<script").count() >= 1);
    }
}
