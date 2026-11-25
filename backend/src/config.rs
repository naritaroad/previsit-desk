//! Settings from the environment (the project's `.env` during development). Names are fixed by `.env.example`.
//! `Config` deliberately has no `Debug` impl: it holds passwords.

use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};

/// Gemini 3 thinking level, sent as a request option (not as a model-name suffix; see `llm`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Thinking {
    Default,
    Minimal,
    Low,
    Medium,
    High,
}

impl Thinking {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "default" => Some(Self::Default),
            "minimal" => Some(Self::Minimal),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            _ => None,
        }
    }
}

/// Login of one default account (`data/seed/demo/accounts.json` holds its name, role and title).
#[derive(Clone)]
pub struct DefaultLogin {
    /// Key in accounts.json: `admin`, `physician`, `pharmacist`, `coordinator`, `patient`.
    pub key: &'static str,
    /// From the environment when it can be set there, else the one in accounts.json.
    pub username: Option<String>,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub bind: SocketAddr,
    pub web_dir: Option<PathBuf>,
    pub data_dir: PathBuf,
    /// Header that carries the client address behind a proxy (empty = socket address).
    pub client_ip_header: Option<String>,
    /// Clean model name (`mock` = offline). Never carries a thinking suffix.
    pub model: String,
    pub model_fallback: Option<String>,
    pub thinking: Thinking,
    pub max_steps: usize,
    pub llm_timeout: Duration,
    pub eval_delay: Duration,
    pub daily_model_call_limit: i64,
    pub rate_messages_per_10min: u32,
    pub rate_visits_per_10min: u32,
    pub max_message_chars: usize,
    /// Model calls one client (salted address hash) may cost per Taipei day.
    pub per_ip_daily_call_limit: i64,
    /// Patient messages one visit may hold before the model stops answering it.
    pub max_messages_per_visit: i64,
    /// Models an administrator may choose; always includes the configured primary and fallback.
    pub model_choices: Vec<String>,
    /// Starting price table: model, USD per million input tokens, USD per million output tokens.
    pub prices: Vec<(String, f64, f64)>,
    pub logins: Vec<DefaultLogin>,
    pub cookie_secure: bool,
    pub session_days: i64,
    pub retention_days: i64,
    /// True when `GEMINI_API_KEY` is set and non-empty. The key itself is never stored here.
    pub api_key_present: bool,
}

/// `model:in:out,model:in:out`, in USD per million tokens.
fn parse_prices(text: &str) -> Result<Vec<(String, f64, f64)>> {
    text.split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut fields = part.rsplitn(3, ':').map(str::trim);
            let (output, input, model) = (fields.next(), fields.next(), fields.next());
            let number = |v: Option<&str>| v.and_then(|v| v.parse::<f64>().ok());
            match (model, number(input), number(output)) {
                (Some(model), Some(input), Some(output))
                    if !model.is_empty() && input >= 0.0 && output >= 0.0 =>
                {
                    Ok((model.to_string(), input, output))
                }
                _ => bail!("LLM_PRICES must look like model:in:out,model:in:out, not {part}"),
            }
        })
        .collect()
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let get = |key: &str, default: &str| {
            env::var(key)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| default.to_string())
        };
        let number = |key: &str, default: &str| -> Result<i64> {
            get(key, default)
                .trim()
                .parse::<i64>()
                .with_context(|| format!("{key} must be a number"))
        };
        let optional = |key: &str| {
            env::var(key)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };

        let model = get("LLM_MODEL", "mock");
        let thinking = match optional("LLM_THINKING") {
            None => Thinking::Minimal,
            Some(v) => Thinking::parse(&v).with_context(|| {
                format!("LLM_THINKING must be minimal|low|medium|high|default, not {v}")
            })?,
        };
        let mut logins = Vec::new();
        for (key, user_var, password_var, name_var) in [
            ("admin", Some("ADMIN_USERNAME"), "ADMIN_PASSWORD", None),
            (
                "physician",
                Some("CLINICIAN_USERNAME"),
                "CLINICIAN_PASSWORD",
                Some("CLINICIAN_DISPLAY_NAME"),
            ),
            ("pharmacist", None, "PHARMACIST_PASSWORD", None),
            ("coordinator", None, "COORDINATOR_PASSWORD", None),
            ("patient", None, "DEMO_PATIENT_PASSWORD", None),
        ] {
            let Some(password) = optional(password_var) else {
                continue;
            };
            if password.chars().count() < 8 {
                bail!("{password_var} must be at least 8 characters");
            }
            logins.push(DefaultLogin {
                key,
                username: user_var.and_then(optional),
                password,
                // The v1 placeholder is not a name.
                display_name: name_var
                    .and_then(optional)
                    .filter(|n| n != "Demo Clinician"),
            });
        }
        let positive = |key: &str, default: &str| -> Result<i64> {
            let n = number(key, default)?;
            if n < 1 {
                bail!("{key} must be at least 1");
            }
            Ok(n)
        };

        let model_fallback = optional("LLM_MODEL_FALLBACK").filter(|f| *f != model);
        let mut model_choices: Vec<String> = optional("LLM_MODEL_CHOICES")
            .unwrap_or_default()
            .split(',')
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .collect();
        for name in std::iter::once(&model).chain(model_fallback.iter()) {
            if !model_choices.contains(name) {
                model_choices.push(name.clone());
            }
        }

        Ok(Self {
            database_url: env::var("DATABASE_URL").context("DATABASE_URL is required")?,
            bind: get("BIND_ADDR", "127.0.0.1:8088")
                .parse()
                .context("BIND_ADDR")?,
            web_dir: optional("WEB_DIR").map(PathBuf::from),
            data_dir: PathBuf::from(get("DATA_DIR", "data")),
            client_ip_header: optional("CLIENT_IP_HEADER").map(|h| h.to_ascii_lowercase()),
            model_fallback,
            model,
            model_choices,
            prices: parse_prices(&optional("LLM_PRICES").unwrap_or_default())?,
            thinking,
            max_steps: positive("AGENT_MAX_STEPS", "5")? as usize,
            llm_timeout: Duration::from_secs(positive("LLM_TIMEOUT_SECS", "45")? as u64),
            eval_delay: Duration::from_millis(number("EVAL_DELAY_MS", "0")?.max(0) as u64),
            daily_model_call_limit: positive("DAILY_MODEL_CALL_LIMIT", "800")?,
            rate_messages_per_10min: positive("RATE_MESSAGES_PER_10MIN", "20")? as u32,
            rate_visits_per_10min: positive("RATE_VISITS_PER_10MIN", "10")? as u32,
            max_message_chars: positive("MAX_MESSAGE_CHARS", "800")? as usize,
            per_ip_daily_call_limit: positive("PER_IP_DAILY_CALL_LIMIT", "200")?,
            max_messages_per_visit: positive("MAX_MESSAGES_PER_VISIT", "40")?,
            logins,
            cookie_secure: get("COOKIE_SECURE", "false") == "true",
            session_days: positive("SESSION_DAYS", "7")?,
            retention_days: positive("RETENTION_DAYS", "14")?,
            api_key_present: optional("GEMINI_API_KEY").is_some(),
        })
    }

    /// The data directory alone, for `check-data` (no database needed).
    pub fn data_dir_from_env() -> PathBuf {
        PathBuf::from(
            env::var("DATA_DIR")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| "data".to_string()),
        )
    }

    /// Whether `model` can answer: the offline model needs nothing, a real one needs the API key.
    pub fn model_ready(&self, model: &str) -> bool {
        model.starts_with("mock") || self.api_key_present
    }

    /// Run-wide timeout: twice one model call, at most 90 seconds.
    pub fn run_timeout(&self) -> Duration {
        (self.llm_timeout * 2).min(Duration::from_secs(90))
    }

    /// A config for unit tests and the offline eval: no model, no secrets, throwaway paths.
    #[allow(dead_code)]
    pub fn for_tests() -> Self {
        Self {
            database_url: String::new(),
            bind: "127.0.0.1:0".parse().expect("addr"),
            web_dir: None,
            data_dir: PathBuf::from("data"),
            client_ip_header: None,
            model: "mock".into(),
            model_fallback: None,
            thinking: Thinking::Default,
            max_steps: 5,
            llm_timeout: Duration::from_secs(45),
            eval_delay: Duration::ZERO,
            daily_model_call_limit: 800,
            rate_messages_per_10min: 20,
            rate_visits_per_10min: 10,
            max_message_chars: 800,
            per_ip_daily_call_limit: 200,
            max_messages_per_visit: 40,
            model_choices: vec!["mock".into()],
            prices: Vec::new(),
            logins: Vec::new(),
            cookie_secure: false,
            session_days: 7,
            retention_days: 14,
            api_key_present: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_parse_and_bad_ones_are_refused() {
        assert_eq!(
            parse_prices("a-1:1.5:9, b:0.25:1.50,").expect("prices"),
            vec![("a-1".to_string(), 1.5, 9.0), ("b".to_string(), 0.25, 1.5)]
        );
        assert!(parse_prices("").expect("empty").is_empty());
        for bad in ["a", "a:1", "a:x:1", ":1:2", "a:-1:2"] {
            assert!(parse_prices(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn thinking_levels_parse() {
        assert_eq!(Thinking::parse("minimal"), Some(Thinking::Minimal));
        assert_eq!(Thinking::parse(" LOW "), Some(Thinking::Low));
        assert_eq!(Thinking::parse("default"), Some(Thinking::Default));
        assert_eq!(Thinking::parse(""), Some(Thinking::Default));
        assert_eq!(Thinking::parse("extreme"), None);
    }

    #[test]
    fn run_timeout_is_double_the_call_timeout_capped_at_ninety() {
        let mut c = Config::for_tests();
        c.llm_timeout = Duration::from_secs(20);
        assert_eq!(c.run_timeout(), Duration::from_secs(40));
        c.llm_timeout = Duration::from_secs(45);
        assert_eq!(c.run_timeout(), Duration::from_secs(90));
        c.llm_timeout = Duration::from_secs(120);
        assert_eq!(c.run_timeout(), Duration::from_secs(90));
    }
}
