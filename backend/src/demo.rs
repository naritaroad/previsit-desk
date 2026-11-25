//! Demo data from `data/seed/demo/*.json`: the five default accounts, the guest personas and the panel of fictional
//! patients. Dates in the files are relative to the day they are loaded.

use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::error::AppResult;
use crate::perm::Role;
use crate::state::AppState;
use crate::types::Locale;

pub const DEFAULT_PERSONA: &str = "lin";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeedAccount {
    pub key: String,
    pub username: String,
    pub role: Role,
    pub display_name: String,
    pub display_name_en: Option<String>,
    pub title: Option<String>,
    pub title_en: Option<String>,
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Persona {
    pub id: String,
    pub display_name: String,
    pub display_name_en: String,
    pub age_band: String,
    pub summary_zh: String,
    pub summary_en: String,
}

pub struct DemoData {
    pub accounts: Vec<SeedAccount>,
    pub personas: Vec<Persona>,
}

fn read<T: DeserializeOwned>(dir: &Path, name: &str) -> Result<T> {
    let path = dir.join(name);
    let text =
        std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .with_context(|| format!("check {}", path.display()))
}

impl DemoData {
    pub fn load(data_dir: &Path) -> Result<Self> {
        let dir = data_dir.join("seed").join("demo");
        let data = Self {
            accounts: read(&dir, "accounts.json")?,
            personas: read(&dir, "personas.json")?,
        };
        data.check()?;
        Ok(data)
    }

    fn check(&self) -> Result<()> {
        for key in ["admin", "physician", "pharmacist", "coordinator", "patient"] {
            let Some(account) = self.accounts.iter().find(|a| a.key == key) else {
                bail!("accounts.json: {key} is missing");
            };
            if account.role.as_str() != key {
                bail!("accounts.json: {key} has role {}", account.role.as_str());
            }
        }
        for id in ["lin", "chang", "wu"] {
            if self.persona(id).is_none() {
                bail!("personas.json: {id} is missing");
            }
        }
        Ok(())
    }

    pub fn persona(&self, id: &str) -> Option<&Persona> {
        self.personas.iter().find(|p| p.id == id)
    }

    pub fn persona_cards(&self) -> Vec<Value> {
        self.personas
            .iter()
            .map(|p| {
                json!({ "id": p.id, "display_name": p.display_name, "display_name_en": p.display_name_en, "age_band": p.age_band, "summary_zh": p.summary_zh, "summary_en": p.summary_en })
            })
            .collect()
    }
}

/// A new guest sandbox: an isolated copy of one persona, deleted after the retention period.
pub async fn create_guest(
    state: &AppState,
    persona: &str,
    locale: Locale,
) -> AppResult<(Uuid, OffsetDateTime)> {
    let Some(p) = state.demo.persona(persona) else {
        return Err(crate::error::AppError::NotFound);
    };
    let expires = state.clock.now() + Duration::days(state.settings.get().retention_days);
    let mut tx = state.db.begin().await?;
    let id: Uuid = sqlx::query_scalar("INSERT INTO accounts (display_name, display_name_en, role, locale, is_guest, demo_key, expires_at) VALUES ($1, $2, 'patient', $3, true, $4, $5) RETURNING id")
        .bind(&p.display_name)
        .bind(&p.display_name_en)
        .bind(locale.as_str())
        .bind(persona)
        .bind(expires)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO patient_profiles (account_id) VALUES ($1)")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO patient_care (account_id) VALUES ($1)")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    crate::rx::seed_guest_requests(state, id, persona).await?;
    Ok((id, expires))
}
