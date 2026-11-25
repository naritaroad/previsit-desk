//! PreVisit Desk API.
//!
//!   previsit-api               serve the API (and the built web site when WEB_DIR is set)
//!   previsit-api check-data    validate every data file and exit
//!   previsit-api eval [...]    run data/eval/cases.jsonl against the configured model
//!   previsit-api healthcheck   GET /api/v1/health on the local port; exit 0 on 200, else 1 (for container health checks)

mod admin;
mod appts;
mod audit;
mod auth;
mod clinic;
mod clock;
mod config;
mod demo;
mod engine;
mod error;
mod eval;
mod events;
mod guard;
mod health_edu;
mod http;
mod hub;
mod idem;
mod intake;
#[cfg(test)]
mod itest;
mod jobs;
mod limits;
mod llm;
mod me;
mod measure;
mod notes;
mod notify;
mod page;
mod patient;
mod people;
mod perm;
mod pii;
mod precheck;
mod profile;
mod prompt;
mod public;
mod refill;
mod routes;
mod rx;
mod rxq;
mod settings;
mod sse;
mod state;
mod style;
mod summary;
mod texts;
mod tickets;
mod tools;
mod types;
mod visit_routes;
mod visits;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use sqlx::postgres::PgPoolOptions;
use tokio::sync::watch;
use tracing_subscriber::EnvFilter;

use crate::clock::Clock;
use crate::config::Config;
use crate::demo::DemoData;
use crate::health_edu::Handbook;
use crate::hub::Hub;
use crate::limits::Limiter;
use crate::settings::{Settings, SettingsStore};
use crate::sse::StreamSlots;
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
                // A line that does not parse (a value with spaces and no quotes) drops everything after it.
                if let Err(dotenvy::Error::LineParse(_, at)) = dotenvy::from_path(&env_file) {
                    eprintln!(
                        ".env: a line could not be read (column {at}); later lines are ignored"
                    );
                }
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
    let demo = DemoData::load(data_dir)?;
    println!(
        "demo              {} accounts, {} personas, {} panel patients",
        demo.accounts.len(),
        demo.personas.len(),
        demo.panel_len()
    );
    for line in rx::check_data(data_dir)? {
        println!("{line}");
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

/// What the process is for: the API reads settings from the database, the eval command runs the environment's models
/// so that a result says which configuration produced it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Serve,
    Eval { offline: bool },
}

async fn build_state(
    mut config: Config,
    mode: Mode,
    shutdown: watch::Receiver<bool>,
) -> Result<AppState> {
    if mode == (Mode::Eval { offline: true }) {
        config.model = "mock".to_string();
        config.model_fallback = None;
        config.model_choices = vec!["mock".to_string()];
    }
    let config = Arc::new(config);
    let rules = Arc::new(Rules::load(&config.data_dir)?);
    let rx_rules = Arc::new(rx::RxRules::load(&config.data_dir)?);
    let demo = Arc::new(DemoData::load(&config.data_dir)?);
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
    let settings = match mode {
        Mode::Serve => {
            auth::ensure_accounts(&db, &config.logins, &demo).await?;
            SettingsStore::load(&db, &config).await?
        }
        Mode::Eval { .. } => SettingsStore::fixed(Settings::defaults(&config)),
    };
    let clock = Clock::system();
    Ok(AppState {
        db,
        config,
        ai: Arc::new(llm::Ai::new()?),
        limiter: Arc::new(Limiter::new()),
        handbook: Arc::new(handbook),
        rules,
        clock,
        visit_locks: Arc::new(VisitLocks::default()),
        settings: Arc::new(settings),
        hub: Arc::new(Hub::default()),
        streams: Arc::new(StreamSlots::default()),
        shutdown,
        demo,
        rx: rx_rules,
        started: Instant::now(),
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
            let (_stop, stopping) = watch::channel(false);
            let mode = Mode::Eval {
                offline: eval_args.offline,
            };
            let state = build_state(config, mode, stopping).await?;
            tracing::info!(model = %state.config.model, "eval");
            eval::run(&state, eval_args).await
        }
        "serve" => serve().await,
        other => bail!("unknown command {other}; use serve, check-data, eval or healthcheck"),
    }
}

/// Ctrl-C, or SIGTERM (what `docker stop` sends).
async fn stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

async fn serve() -> Result<()> {
    let config = Config::from_env()?;
    let (stop, stopping) = watch::channel(false);
    let state = build_state(config, Mode::Serve, stopping).await?;
    let interrupted = visits::mark_interrupted(&state).await?;
    if !interrupted.is_empty() {
        tracing::warn!(
            turns = interrupted.len(),
            "turns were cut off by the last stop; patients can retry them"
        );
        engine::finish_interrupted_red_flags(&state, &interrupted)
            .await
            .map_err(|e| anyhow::anyhow!("screen interrupted turns: {e}"))?;
    }
    // Guests refer to the pharmacies, so the data is there before the first request.
    if let Err(e) = demo::ensure(&state).await {
        tracing::warn!(error = %e, "could not load the demo data");
    }
    let config = state.config.clone();
    tracing::info!(addr = %config.bind, model = %config.model, fallback = ?config.model_fallback, thinking = ?config.thinking, model_ready = config.model_ready(&config.model), handbook_sections = state.handbook.section_count(), "listening");

    // Retention, guests, reminders and the demo data; the first round runs right away.
    jobs::spawn(state.clone());

    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .with_context(|| format!("bind {}", config.bind))?;
    axum::serve(
        listener,
        routes::app(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        stop_signal().await;
        // Open event streams would otherwise keep the server alive.
        let _ = stop.send(true);
    })
    .await?;
    Ok(())
}
