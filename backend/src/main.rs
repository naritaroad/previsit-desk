//! PreVisit Desk API.
//!
//!   previsit-api               serve the API (and the built web site when WEB_DIR is set)
//!   previsit-api check-data    validate every data file and exit
//!   previsit-api eval [...]    run data/eval/cases.jsonl against the configured model
//!   previsit-api healthcheck   GET /api/v1/health on the local port; exit 0 on 200, else 1 (for container health checks)

mod auth;
mod clock;
mod config;
mod engine;
mod error;
mod eval;
mod guard;
mod health_edu;
mod http;
mod intake;
mod limits;
mod llm;
mod pii;
mod precheck;
mod prompt;
mod refill;
mod routes;
#[allow(dead_code)]
mod rx;
mod state;
mod style;
mod summary;
mod texts;
mod tickets;
mod tools;
mod types;
mod visits;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::EnvFilter;

use crate::clock::Clock;
use crate::config::Config;
use crate::health_edu::Handbook;
use crate::limits::Limiter;
use crate::state::{AppState, Rules, VisitLocks};

const HANDBOOK_FILE: &str = "health_education.zh-TW.md";

/// Finds the project folder (the first ancestor of the working directory, then of the executable, that holds
/// `data/seed/red_flags.csv`), loads its `.env` without overriding variables that are already set, and moves
/// into it so relative paths such as `data` and `web/dist` resolve.
fn enter_project_root() {
    let cwd = std::env::current_dir().ok();
    let exe = std::env::current_exe().ok();
    let candidates = cwd
        .iter()
        .flat_map(|d| d.ancestors().map(Path::to_path_buf))
        .chain(
            exe.iter()
                .flat_map(|e| e.ancestors().skip(1).map(Path::to_path_buf)),
        );
    let root: Option<PathBuf> = candidates.into_iter().find(|dir| {
        dir.join("data")
            .join("seed")
            .join("red_flags.csv")
            .is_file()
    });
    match root {
        Some(root) => {
            let env_file = root.join(".env");
            if env_file.is_file() {
                let _ = dotenvy::from_path(&env_file);
            }
            let _ = std::env::set_current_dir(&root);
        }
        None => {
            let _ = dotenvy::dotenv();
        }
    }
}

fn load_handbook(data_dir: &Path) -> Result<Option<Handbook>> {
    let path = data_dir.join("rag").join(HANDBOOK_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some(Handbook::load(
        &path,
        &data_dir.join("seed").join("synonyms.csv"),
    )?))
}

fn check_data(data_dir: &Path) -> Result<()> {
    let rules = Rules::load(data_dir)?;
    println!("red_flags.csv     {} rules", rules.red_flags.len());
    println!("scope_rules.csv   {} rules", rules.scope.len());
    println!(
        "refill_rules.csv  {} rules (max {} days, {} per fill, window {} days, {} fills)",
        rules.refill.len(),
        rules.refill.max_total_days,
        rules.refill.max_days_per_fill,
        rules.refill.early_window_days,
        rules.refill.max_fills
    );
    let Some(handbook) = load_handbook(data_dir)? else {
        bail!(
            "{} is missing from {}",
            HANDBOOK_FILE,
            data_dir.join("rag").display()
        )
    };
    println!(
        "{HANDBOOK_FILE}  {} sections, {} chunks, {} synonyms",
        handbook.section_count(),
        handbook.chunk_count(),
        handbook.synonym_count()
    );
    let cases = data_dir.join("eval").join("cases.jsonl");
    if cases.is_file() {
        let parsed = eval::parse_cases(
            &std::fs::read_to_string(&cases)
                .with_context(|| format!("read {}", cases.display()))?,
        )
        .with_context(|| format!("check {}", cases.display()))?;
        println!("cases.jsonl       {} cases", parsed.len());
    }
    println!("data ok");
    Ok(())
}

/// `GET /api/v1/health` on the local port with a plain TCP request (the runtime image has no curl).
async fn healthcheck() -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let bind = std::env::var("BIND_ADDR")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1:8088".to_string());
    let port = bind
        .rsplit(':')
        .next()
        .and_then(|p| p.parse::<u16>().ok())
        .context("BIND_ADDR must end with :port")?;
    let attempt = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
        stream
            .write_all(
                b"GET /api/v1/health HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .await?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await?;
        Ok::<_, std::io::Error>(
            String::from_utf8_lossy(&response)
                .lines()
                .next()
                .unwrap_or("")
                .to_string(),
        )
    };
    match tokio::time::timeout(Duration::from_secs(4), attempt).await {
        Ok(Ok(status_line)) if status_line.split_whitespace().nth(1) == Some("200") => Ok(()),
        Ok(Ok(status_line)) => bail!("health check answered: {status_line}"),
        Ok(Err(e)) => bail!("health check could not connect: {e}"),
        Err(_) => bail!("health check timed out"),
    }
}

async fn connect(config: &Config) -> Result<sqlx::PgPool> {
    let mut last_error = None;
    for attempt in 1..=15 {
        match PgPoolOptions::new()
            .max_connections(10)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&config.database_url)
            .await
        {
            Ok(pool) => {
                sqlx::migrate!("./migrations")
                    .run(&pool)
                    .await
                    .context("run migrations")?;
                return Ok(pool);
            }
            Err(e) => {
                tracing::warn!(attempt, "database not ready yet");
                last_error = Some(e);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    Err(last_error
        .map(anyhow::Error::from)
        .unwrap_or_else(|| anyhow::anyhow!("no connection attempt was made")))
    .context("connect to PostgreSQL")
}

async fn build_state(mut config: Config, offline: bool) -> Result<AppState> {
    if offline {
        config.model = "mock".to_string();
        config.model_fallback = None;
    }
    let config = Arc::new(config);
    let rules = Arc::new(Rules::load(&config.data_dir)?);
    let handbook = match load_handbook(&config.data_dir)? {
        Some(handbook) => handbook,
        None => {
            tracing::warn!(
                "the health education handbook is missing; handbook searches will find nothing"
            );
            Handbook::empty()
        }
    };
    let db = connect(&config).await?;
    auth::ensure_account(&db, &config).await?;
    let clock = Clock::system();
    match visits::cleanup(&db, clock.retention_cutoff(config.retention_days)).await {
        Ok(n) if n > 0 => tracing::info!(deleted = n, "removed visits past the retention period"),
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "retention sweep failed"),
    }
    Ok(AppState {
        db,
        config,
        ai: Arc::new(llm::Ai::new()?),
        limiter: Arc::new(Limiter::new()),
        handbook: Arc::new(handbook),
        rules,
        clock,
        visit_locks: Arc::new(VisitLocks::default()),
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("serve");
    enter_project_root();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn")),
        )
        .with_writer(std::io::stderr)
        .init();

    match command {
        "healthcheck" => {
            if let Err(e) = healthcheck().await {
                eprintln!("{e:#}");
                std::process::exit(1);
            }
            Ok(())
        }
        "check-data" => check_data(&Config::data_dir_from_env()),
        "eval" => {
            let config = Config::from_env()?;
            let eval_args = eval::parse_args(&args[1..], &config.data_dir)?;
            let state = build_state(config, eval_args.offline).await?;
            tracing::info!(model = %state.config.model, "eval");
            eval::run(&state, eval_args).await
        }
        "serve" => serve().await,
        other => bail!("unknown command {other}; use serve, check-data, eval or healthcheck"),
    }
}

async fn serve() -> Result<()> {
    let config = Config::from_env()?;
    let state = build_state(config, false).await?;
    let config = state.config.clone();
    tracing::info!(addr = %config.bind, model = %config.model, fallback = ?config.model_fallback, thinking = ?config.thinking, model_ready = config.model_ready(), handbook_sections = state.handbook.section_count(), "listening");

    // Daily retention sweep.
    let sweep = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(6 * 3600));
        tick.tick().await;
        loop {
            tick.tick().await;
            match visits::cleanup(
                &sweep.db,
                sweep.clock.retention_cutoff(sweep.config.retention_days),
            )
            .await
            {
                Ok(n) if n > 0 => {
                    tracing::info!(deleted = n, "removed visits past the retention period")
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "retention sweep failed"),
            }
        }
    });

    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .with_context(|| format!("bind {}", config.bind))?;
    axum::serve(
        listener,
        routes::app(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}
