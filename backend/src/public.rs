//! Public endpoints (contract §7): health, meta and the live facts the trust centre quotes.

use std::path::Path as FsPath;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use crate::clock::format_date;
use crate::limits;
use crate::state::AppState;

pub async fn health(State(state): State<AppState>) -> Response {
    // Never touches the model: the database answer is what the deployment health check needs.
    match sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.db).await {
        Ok(_) => Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION"), "model_ready": state.config.model_ready(&state.settings.get().ai.primary) })).into_response(),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "ok": false }))).into_response(),
    }
}

/// `data/eval/results/summary.json` with one `{id, category, passed}` row per case; `null` when there is none.
pub fn eval_latest(data_dir: &FsPath) -> Value {
    let path = data_dir.join("eval").join("results").join("summary.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Value::Null;
    };
    match serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) {
        Ok(value @ Value::Object(_)) => value,
        _ => Value::Null,
    }
}

/// The same without the per-case rows.
pub fn eval_summary(data_dir: &FsPath) -> Value {
    let mut value = eval_latest(data_dir);
    if let Some(map) = value.as_object_mut() {
        map.remove("cases");
    }
    value
}

pub async fn meta(State(state): State<AppState>) -> Json<Value> {
    let settings = state.settings.get();
    let calls = limits::calls_today(&state.db, &state.clock)
        .await
        .unwrap_or(0);
    Json(json!({
        "app": "PreVisit Desk",
        "version": env!("CARGO_PKG_VERSION"),
        "models": { "primary": settings.ai.primary, "fallback": settings.ai.fallback },
        "retention_days": settings.retention_days,
        "max_message_chars": state.config.max_message_chars,
        "daily_limit_reached": calls >= settings.ai.daily_call_limit,
        "server_today": format_date(state.clock.today()),
        "eval": eval_summary(&state.config.data_dir),
        "oversight_phase": settings.rx.oversight_phase,
        "protocol_version": state.rx.protocol_version(),
        "formulary_counts": state.rx.formulary_counts(),
        "ai_enabled": settings.ai.enabled,
    }))
}

/// How many cases the eval file holds (it is part of the deployed data).
fn eval_case_count(data_dir: &FsPath) -> usize {
    std::fs::read_to_string(data_dir.join("eval").join("cases.jsonl"))
        .map(|text| {
            text.lines()
                .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with("//"))
                .count()
        })
        .unwrap_or(0)
}

pub async fn trust_facts(State(state): State<AppState>) -> Json<Value> {
    let settings = state.settings.get();
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "models": { "primary": settings.ai.primary, "fallback": settings.ai.fallback },
        "ai_enabled": settings.ai.enabled,
        "red_flag_rules": state.rules.red_flags.len(),
        "red_flag_categories": crate::types::RedFlagCategory::ALL.len(),
        "scope_rules": state.rules.scope.len(),
        "refill_rules": state.rules.refill.list(crate::error::request_locale()),
        "handbook_sections": state.handbook.section_count(),
        "eval_cases": eval_case_count(&state.config.data_dir),
        "eval": eval_summary(&state.config.data_dir),
        "protocol_version": state.rx.protocol_version(),
        "formulary_counts": state.rx.formulary_counts(),
        "retention_days": settings.retention_days,
        "oversight_phase": settings.rx.oversight_phase,
        "sla_hours": { "routine": settings.rx.sla_hours_routine, "soon": settings.rx.sla_hours_soon },
        "limits": { "daily_call_limit": settings.ai.daily_call_limit, "max_message_chars": state.config.max_message_chars },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn eval_summary_reads_the_file_and_drops_per_case_rows() {
        let dir = std::env::temp_dir().join(format!("previsit-meta-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("eval").join("results")).expect("dirs");
        assert_eq!(eval_summary(&dir), Value::Null);
        std::fs::write(dir.join("eval").join("results").join("summary.json"), r#"{"ran_at":"x","model":"m","total":2,"passed":1,"categories":[],"cases":[{"id":"A"}]}"#).expect("write");
        let value = eval_summary(&dir);
        assert_eq!(value["total"], 2);
        assert!(value.get("cases").is_none());
        assert_eq!(eval_latest(&dir)["cases"][0]["id"], "A");
        std::fs::write(
            dir.join("eval").join("results").join("summary.json"),
            "not json",
        )
        .expect("write");
        assert_eq!(eval_summary(&dir), Value::Null);
        let _ = std::fs::remove_dir_all(dir);
    }
}
