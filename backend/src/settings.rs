//! Settings an administrator changes on the management site. They live in `app_settings`, are cached in memory and
//! take effect on the next request. Until someone saves them, the environment supplies the values.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::{Config, Thinking};
use crate::error::{AppError, AppResult};

const KEY: &str = "platform";

/// USD per million tokens.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Price {
    #[serde(rename = "in")]
    pub input: f64,
    #[serde(rename = "out")]
    pub output: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OnBudget {
    /// Over budget: answer with the fallback model.
    Fallback,
    /// Over budget: no model calls until the month ends or the budget changes.
    Stop,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AiSettings {
    /// The kill switch. Off means rules only: red flags, scope rules and the refill check still run.
    pub enabled: bool,
    pub primary: String,
    pub fallback: Option<String>,
    pub thinking: String,
    pub temperature: f64,
    pub max_steps: i64,
    pub daily_call_limit: i64,
    pub per_client_daily_limit: i64,
    /// `null` = no monthly limit.
    pub monthly_budget_usd: Option<f64>,
    pub on_budget: OnBudget,
    #[serde(default)]
    pub prices: BTreeMap<String, Price>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LimitSettings {
    pub messages_per_10min: i64,
    pub visits_per_10min: i64,
    pub max_messages_per_visit: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RxSettings {
    pub sla_hours_routine: i64,
    pub sla_hours_soon: i64,
    /// Read only: phase 1 means a physician reviews every request. Nothing in this system can raise it.
    #[serde(default = "phase_one")]
    pub oversight_phase: i64,
}

fn phase_one() -> i64 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    #[serde(default)]
    pub revision: i32,
    pub ai: AiSettings,
    pub limits: LimitSettings,
    pub rx: RxSettings,
    pub retention_days: i64,
}

fn thinking_name(thinking: Thinking) -> &'static str {
    match thinking {
        Thinking::Default => "default",
        Thinking::Minimal => "minimal",
        Thinking::Low => "low",
        Thinking::Medium => "medium",
        Thinking::High => "high",
    }
}

impl Settings {
    pub fn defaults(config: &Config) -> Self {
        Self {
            revision: 0,
            ai: AiSettings {
                enabled: true,
                primary: config.model.clone(),
                fallback: config.model_fallback.clone(),
                thinking: thinking_name(config.thinking).to_string(),
                temperature: 0.3,
                max_steps: config.max_steps as i64,
                daily_call_limit: config.daily_model_call_limit,
                per_client_daily_limit: config.per_ip_daily_call_limit,
                monthly_budget_usd: None,
                on_budget: OnBudget::Fallback,
                prices: config
                    .prices
                    .iter()
                    .map(|(model, input, output)| {
                        (
                            model.clone(),
                            Price {
                                input: *input,
                                output: *output,
                            },
                        )
                    })
                    .collect(),
            },
            limits: LimitSettings {
                messages_per_10min: i64::from(config.rate_messages_per_10min),
                visits_per_10min: i64::from(config.rate_visits_per_10min),
                max_messages_per_visit: config.max_messages_per_visit,
            },
            rx: RxSettings {
                sla_hours_routine: 48,
                sla_hours_soon: 24,
                oversight_phase: 1,
            },
            retention_days: config.retention_days,
        }
    }

    pub fn thinking(&self) -> Thinking {
        Thinking::parse(&self.ai.thinking).unwrap_or(Thinking::Default)
    }

    pub fn cost(&self, model: &str, input_tokens: i64, output_tokens: i64) -> f64 {
        self.ai.prices.get(model).map_or(0.0, |p| {
            (input_tokens as f64 * p.input + output_tokens as f64 * p.output) / 1_000_000.0
        })
    }

    /// Every bad field with the reason, keyed like `ai.max_steps`.
    pub fn validate(&self, choices: &[String]) -> BTreeMap<String, String> {
        let mut errors = BTreeMap::new();
        let mut bad = |field: &str, reason: String| {
            errors.insert(field.to_string(), reason);
        };
        if !choices.contains(&self.ai.primary) {
            bad("ai.primary", choices.join(" | "));
        }
        if let Some(fallback) = &self.ai.fallback {
            if !choices.contains(fallback) {
                bad("ai.fallback", choices.join(" | "));
            } else if *fallback == self.ai.primary {
                bad("ai.fallback", "≠ ai.primary".into());
            }
        }
        if Thinking::parse(&self.ai.thinking).is_none() || self.ai.thinking.is_empty() {
            bad(
                "ai.thinking",
                "minimal | low | medium | high | default".into(),
            );
        }
        if !(0.0..=2.0).contains(&self.ai.temperature) {
            bad("ai.temperature", "0–2".into());
        }
        for (field, value, min, max) in [
            ("ai.max_steps", self.ai.max_steps, 1, 12),
            ("ai.daily_call_limit", self.ai.daily_call_limit, 0, 100_000),
            (
                "ai.per_client_daily_limit",
                self.ai.per_client_daily_limit,
                0,
                100_000,
            ),
            (
                "limits.messages_per_10min",
                self.limits.messages_per_10min,
                1,
                1_000,
            ),
            (
                "limits.visits_per_10min",
                self.limits.visits_per_10min,
                1,
                1_000,
            ),
            (
                "limits.max_messages_per_visit",
                self.limits.max_messages_per_visit,
                1,
                500,
            ),
            ("rx.sla_hours_routine", self.rx.sla_hours_routine, 1, 720),
            ("rx.sla_hours_soon", self.rx.sla_hours_soon, 1, 720),
            ("retention_days", self.retention_days, 1, 365),
        ] {
            if !(min..=max).contains(&value) {
                bad(field, format!("{min}–{max}"));
            }
        }
        if self
            .ai
            .monthly_budget_usd
            .is_some_and(|b| !(0.0..=100_000.0).contains(&b))
        {
            bad("ai.monthly_budget_usd", "0–100000".into());
        }
        if self.ai.prices.len() > 50
            || self.ai.prices.iter().any(|(name, p)| {
                name.is_empty()
                    || name.len() > 100
                    || !(0.0..=1000.0).contains(&p.input)
                    || !(0.0..=1000.0).contains(&p.output)
            })
        {
            bad("ai.prices", "0–1000 USD / 1M tokens".into());
        }
        errors
    }
}

/// Which models one turn may use, decided before the first call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelPlan {
    Run {
        primary: String,
        fallback: Option<String>,
        /// True when the budget pushed the turn onto the fallback model.
        over_budget: bool,
    },
    /// The kill switch is off: rules only.
    Disabled,
    /// No model call; the code goes into `run.failed`.
    Blocked(&'static str),
}

pub fn plan(settings: &Settings, calls_today: i64, spent_usd: f64, ready: bool) -> ModelPlan {
    let ai = &settings.ai;
    if !ai.enabled {
        return ModelPlan::Disabled;
    }
    if !ready {
        return ModelPlan::Blocked("not_configured");
    }
    if calls_today >= ai.daily_call_limit {
        return ModelPlan::Blocked("daily_budget_exceeded");
    }
    if ai.monthly_budget_usd.is_some_and(|b| spent_usd >= b) {
        return match (ai.on_budget, &ai.fallback) {
            (OnBudget::Fallback, Some(fallback)) => ModelPlan::Run {
                primary: fallback.clone(),
                fallback: None,
                over_budget: true,
            },
            _ => ModelPlan::Blocked("monthly_budget_exceeded"),
        };
    }
    ModelPlan::Run {
        primary: ai.primary.clone(),
        fallback: ai.fallback.clone(),
        over_budget: false,
    }
}

pub struct SettingsStore {
    current: RwLock<Arc<Settings>>,
}

impl SettingsStore {
    pub fn fixed(settings: Settings) -> Self {
        Self {
            current: RwLock::new(Arc::new(settings)),
        }
    }

    /// Reads the saved settings, or the environment's when nothing was saved. A saved model that left the whitelist
    /// falls back to the environment's with a warning.
    pub async fn load(db: &PgPool, config: &Config) -> sqlx::Result<Self> {
        let row: Option<(Value, i32)> =
            sqlx::query_as("SELECT value, revision FROM app_settings WHERE key = $1")
                .bind(KEY)
                .fetch_optional(db)
                .await?;
        let mut settings = Settings::defaults(config);
        if let Some((value, revision)) = row {
            match serde_json::from_value::<Settings>(value) {
                Ok(mut saved) => {
                    let problems = saved.validate(&config.model_choices);
                    if problems.contains_key("ai.primary") || problems.contains_key("ai.fallback") {
                        tracing::warn!(
                            "a saved model is not in LLM_MODEL_CHOICES; using the models from the environment"
                        );
                        saved.ai.primary = settings.ai.primary.clone();
                        saved.ai.fallback = settings.ai.fallback.clone();
                    }
                    saved.revision = revision;
                    settings = saved;
                }
                Err(e) => {
                    tracing::warn!(error = %e, "saved settings do not parse; using the environment");
                    settings.revision = revision;
                }
            }
        }
        settings.rx.oversight_phase = 1;
        Ok(Self::fixed(settings))
    }

    pub fn get(&self) -> Arc<Settings> {
        self.current
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Saves and publishes `next` when its revision is the current one.
    pub async fn save(
        &self,
        db: &PgPool,
        config: &Config,
        mut next: Settings,
        by: Uuid,
    ) -> AppResult<Arc<Settings>> {
        let errors = next.validate(&config.model_choices);
        if !errors.is_empty() {
            return Err(AppError::Unprocessable(errors));
        }
        let current = self.get();
        if next.revision != current.revision {
            return Err(AppError::stale(&*current));
        }
        next.rx.oversight_phase = 1;
        next.revision = current.revision + 1;
        let value = serde_json::to_value(&next).map_err(anyhow::Error::from)?;
        let saved = sqlx::query(
            "INSERT INTO app_settings (key, value, revision, updated_by) VALUES ($1, $2, $3, $4)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, revision = EXCLUDED.revision, updated_by = EXCLUDED.updated_by, updated_at = now()
             WHERE app_settings.revision = EXCLUDED.revision - 1",
        )
        .bind(KEY)
        .bind(value)
        .bind(next.revision)
        .bind(by)
        .execute(db)
        .await?
        .rows_affected();
        if saved == 0 {
            return Err(AppError::stale(&*self.get()));
        }
        let next = Arc::new(next);
        *self
            .current
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = next.clone();
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings {
        let mut s = Settings::defaults(&Config::for_tests());
        s.ai.primary = "a".into();
        s.ai.fallback = Some("b".into());
        s
    }

    fn choices() -> Vec<String> {
        vec!["a".into(), "b".into()]
    }

    #[test]
    fn defaults_validate_and_round_trip_with_the_contract_names() {
        let s = settings();
        assert!(s.validate(&choices()).is_empty());
        let mut value = serde_json::to_value(&s).expect("json");
        value["ai"]["prices"] = serde_json::json!({ "a": { "in": 1.5, "out": 9.0 } });
        let back: Settings = serde_json::from_value(value).expect("settings");
        assert!((back.cost("a", 1_000_000, 100_000) - 2.4).abs() < 1e-9);
        assert_eq!(back.cost("unknown", 1_000_000, 0), 0.0);
    }

    #[test]
    fn every_bad_field_is_reported() {
        let mut s = settings();
        s.ai.primary = "not-listed".into();
        s.ai.fallback = Some("not-listed".into());
        s.ai.thinking = "extreme".into();
        s.ai.temperature = 3.0;
        s.ai.max_steps = 0;
        s.ai.monthly_budget_usd = Some(-1.0);
        s.retention_days = 0;
        let errors = s.validate(&choices());
        for key in [
            "ai.primary",
            "ai.fallback",
            "ai.thinking",
            "ai.temperature",
            "ai.max_steps",
            "ai.monthly_budget_usd",
            "retention_days",
        ] {
            assert!(errors.contains_key(key), "{key}");
        }
    }

    #[test]
    fn the_kill_switch_wins_over_everything() {
        let mut s = settings();
        s.ai.enabled = false;
        assert_eq!(plan(&s, 0, 0.0, true), ModelPlan::Disabled);
        assert_eq!(plan(&s, 9_999_999, 9e9, false), ModelPlan::Disabled);
    }

    #[test]
    fn the_monthly_budget_falls_back_or_stops() {
        let mut s = settings();
        s.ai.monthly_budget_usd = Some(10.0);
        assert!(matches!(
            plan(&s, 0, 9.99, true),
            ModelPlan::Run {
                over_budget: false,
                ..
            }
        ));
        assert_eq!(
            plan(&s, 0, 10.0, true),
            ModelPlan::Run {
                primary: "b".into(),
                fallback: None,
                over_budget: true
            }
        );
        s.ai.on_budget = OnBudget::Stop;
        assert_eq!(
            plan(&s, 0, 10.0, true),
            ModelPlan::Blocked("monthly_budget_exceeded")
        );
        s.ai.on_budget = OnBudget::Fallback;
        s.ai.fallback = None;
        assert_eq!(
            plan(&s, 0, 10.0, true),
            ModelPlan::Blocked("monthly_budget_exceeded"),
            "nothing to fall back to"
        );
        s.ai.monthly_budget_usd = None;
        assert!(matches!(plan(&s, 0, 1e9, true), ModelPlan::Run { .. }));
    }

    #[test]
    fn the_daily_cap_and_a_missing_key_block() {
        let s = settings();
        assert_eq!(
            plan(&s, s.ai.daily_call_limit, 0.0, true),
            ModelPlan::Blocked("daily_budget_exceeded")
        );
        assert_eq!(
            plan(&s, 0, 0.0, false),
            ModelPlan::Blocked("not_configured")
        );
    }
}
