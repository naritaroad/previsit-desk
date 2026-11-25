//! Placeholder for the rx module (docs/v2/contract.md §4). The rx engineer replaces this file; the rest of the crate
//! calls exactly the items below, so their names and signatures are the boundary.

use std::path::Path;

use anyhow::Result;
use axum::Router;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::AppResult;
use crate::state::AppState;
use crate::types::Locale;

/// The drug list and the question protocols. Loaded once at start into `AppState::rx`; bad data refuses to start.
pub struct RxRules;

impl RxRules {
    pub fn load(_data_dir: &Path) -> Result<Self> {
        Ok(Self)
    }

    pub fn protocol_version(&self) -> Option<String> {
        None
    }

    /// `{in_scope, physician_only, excluded}` drug counts for `/meta` and `/trust/facts`.
    pub fn formulary_counts(&self) -> Value {
        json!({})
    }

    /// `{protocols, formulary}` for the read-only rules page (`GET /admin/rules`).
    pub fn rules_view(&self, _locale: Locale) -> Value {
        json!({ "protocols": null, "formulary": [] })
    }
}

/// `check-data` hook: one line per file.
pub fn check_data(_data_dir: &Path) -> Result<Vec<String>> {
    Ok(Vec::new())
}

/// Every route of contract §4, with full paths such as `/rx/{id}`, `/queue/rx`, `/app/medications`. Mounted at `/api/v2`.
pub fn routes() -> Router<AppState> {
    Router::new()
}

/// `MedicationCard[]` of one patient, already localised. The caller has checked who may see them.
pub async fn medications_for(
    _state: &AppState,
    _patient_id: Uuid,
    _locale: Locale,
) -> AppResult<Vec<Value>> {
    Ok(Vec::new())
}

/// Called after the demo patients and their prescriptions were (re)built: adds their rx requests.
/// Demo accounts are the ones with `accounts.is_demo`; look patients up by `accounts.demo_key`.
pub async fn seed_demo_requests(_state: &AppState) -> Result<()> {
    Ok(())
}

/// Called after a guest sandbox was filled from a persona (`lin`, `chang`, `wu`).
pub async fn seed_guest_requests(
    _state: &AppState,
    _patient_id: Uuid,
    _persona: &str,
) -> Result<()> {
    Ok(())
}
