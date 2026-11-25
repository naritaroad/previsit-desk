//! Tests against a real PostgreSQL. They are `#[ignore]`d so `cargo test` needs no database; run them with
//! `cargo test itest -- --ignored --test-threads=4` while the development database is up.
//!
//! Each test creates its own throwaway database next to the one `DATABASE_URL` names (from the environment or the
//! project's `.env`) and drops it at the end, so no other database is touched.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use futures::StreamExt;
use serde_json::{Value, json};
use sqlx::postgres::PgPoolOptions;
use sqlx::{AssertSqlSafe, Connection, PgConnection, PgPool};
use time::OffsetDateTime;
use tokio::sync::watch;
use tower::ServiceExt;
use uuid::Uuid;

use crate::clock::Clock;
use crate::config::{Config, DefaultLogin};
use crate::demo::{self, DemoData};
use crate::engine;
use crate::events::{self, Follower};
use crate::health_edu::Handbook;
use crate::hub::Hub;
use crate::limits::Limiter;
use crate::perm::{Permission, Role};
use crate::settings::{Settings, SettingsStore};
use crate::sse::StreamSlots;
use crate::state::{AppState, Rules, VisitLocks};
use crate::visits::{self, NewVisit};
use crate::{auth, jobs, llm, routes, rx};

fn data_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../data")
}

fn base_url() -> String {
    if let Ok(url) = std::env::var("DATABASE_URL") {
        return url;
    }
    let env = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.env"))
        .expect(".env with DATABASE_URL");
    env.lines()
        .find_map(|l| l.strip_prefix("DATABASE_URL="))
        .expect("DATABASE_URL")
        .trim()
        .to_string()
}

struct Db {
    name: String,
    url: String,
    admin_url: String,
}

impl Db {
    async fn create() -> Self {
        let base = base_url();
        let (server, _) = base.rsplit_once('/').expect("database url");
        let name = format!("previsit_t_{}", Uuid::new_v4().simple());
        let db = Self {
            url: format!("{server}/{name}"),
            admin_url: format!("{server}/postgres"),
            name,
        };
        let mut admin = PgConnection::connect(&db.admin_url)
            .await
            .expect("database is up");
        sqlx::query(AssertSqlSafe(format!("CREATE DATABASE {}", db.name)))
            .execute(&mut admin)
            .await
            .expect("create database");
        db
    }

    async fn drop(self) {
        let mut admin = PgConnection::connect(&self.admin_url).await.expect("admin");
        sqlx::query(AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            self.name
        )))
        .execute(&mut admin)
        .await
        .expect("drop database");
    }
}

struct Env {
    db: Db,
    state: AppState,
    _stop: watch::Sender<bool>,
}

impl Env {
    async fn new() -> Self {
        let db = Db::create().await;
        let pool = PgPoolOptions::new()
            .max_connections(12)
            .connect(&db.url)
            .await
            .expect("pool");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migrate");
        let mut config = Config::for_tests();
        config.data_dir = data_dir();
        config.model_choices = vec!["mock".into(), "mock-b".into()];
        config.rate_messages_per_10min = 1000;
        config.rate_visits_per_10min = 1000;
        for (key, password) in [
            ("admin", "admin-password"),
            ("physician", "physician-password"),
            ("pharmacist", "pharmacist-password"),
            ("coordinator", "coordinator-password"),
            ("patient", "patient-password"),
        ] {
            config.logins.push(DefaultLogin {
                key,
                username: None,
                password: password.into(),
                display_name: None,
            });
        }
        let demo = Arc::new(DemoData::load(&config.data_dir).expect("demo data"));
        auth::ensure_accounts(&pool, &config.logins, &demo)
            .await
            .expect("accounts");
        let (stop, shutdown) = watch::channel(false);
        let state = AppState {
            settings: Arc::new(SettingsStore::load(&pool, &config).await.expect("settings")),
            rules: Arc::new(Rules::load(&config.data_dir).expect("rules")),
            rx: Arc::new(rx::RxRules::load(&config.data_dir).expect("rx rules")),
            handbook: Arc::new(Handbook::empty()),
            db: pool,
            config: Arc::new(config),
            ai: Arc::new(llm::Ai::new().expect("ai")),
            limiter: Arc::new(Limiter::new()),
            clock: Clock::system(),
            visit_locks: Arc::new(VisitLocks::default()),
            hub: Arc::new(Hub::default()),
            streams: Arc::new(StreamSlots::default()),
            shutdown,
            demo,
            started: Instant::now(),
        };
        Self {
            db,
            state,
            _stop: stop,
        }
    }

    async fn done(self) {
        self.state.db.close().await;
        self.db.drop().await;
    }

    async fn account(&self, username: &str) -> Uuid {
        sqlx::query_scalar("SELECT id FROM accounts WHERE username = $1")
            .bind(username)
            .fetch_one(&self.state.db)
            .await
            .expect("account")
    }

    /// A client signed in as `account`, without going through the password.
    async fn client(&self, account: Uuid) -> Client<'_> {
        let token = Uuid::new_v4().simple().to_string();
        sqlx::query("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, now() + interval '1 day')")
            .bind(auth::token_hash(&token))
            .bind(account)
            .execute(&self.state.db)
            .await
            .expect("session");
        Client { env: self, token }
    }

    async fn staff(&self, role: Role) -> Client<'_> {
        let username = match role {
            Role::Admin => "naritaroad",
            Role::Physician => "dr_demo",
            Role::Pharmacist => "rph_demo",
            Role::Coordinator => "cm_demo",
            Role::Patient => "patient_demo",
        };
        self.client(self.account(username).await).await
    }

    async fn patient(&self) -> (Uuid, Client<'_>) {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO accounts (display_name, role) VALUES ('測試病人', 'patient') RETURNING id",
        )
        .fetch_one(&self.state.db)
        .await
        .expect("patient");
        for sql in [
            "INSERT INTO patient_profiles (account_id) VALUES ($1)",
            "INSERT INTO patient_care (account_id) VALUES ($1)",
        ] {
            sqlx::query(sql)
                .bind(id)
                .execute(&self.state.db)
                .await
                .expect("row");
        }
        (id, self.client(id).await)
    }

    async fn settle(&self, visit: Uuid) {
        for _ in 0..100 {
            let running: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM runs WHERE visit_id = $1 AND status = 'running'",
            )
            .bind(visit)
            .fetch_one(&self.state.db)
            .await
            .expect("runs");
            if running == 0 && self.state.visit_locks.try_acquire(visit).is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the turn did not finish");
    }
}

struct Client<'a> {
    env: &'a Env,
    token: String,
}

impl Client<'_> {
    async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        headers: &[(&str, &str)],
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(format!("/api/v2{path}"))
            .header("cookie", format!("pv_session={}", self.token));
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let body = match body {
            Some(value) => {
                request = request.header("content-type", "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
        };
        let response = routes::app(self.env.state.clone())
            .oneshot(request.body(body).expect("request"))
            .await
            .expect("response");
        let status = response.status();
        if response
            .headers()
            .get("content-type")
            .is_some_and(|v| v.as_bytes().starts_with(b"text/event-stream"))
        {
            return (status, Value::Null);
        }
        let bytes = to_bytes(response.into_body(), 1 << 22).await.expect("body");
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn get(&self, path: &str) -> (StatusCode, Value) {
        self.send("GET", path, None, &[]).await
    }

    async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.send("POST", path, Some(body), &[]).await
    }

    async fn put(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.send("PUT", path, Some(body), &[]).await
    }

    async fn patch(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.send("PATCH", path, Some(body), &[]).await
    }

    async fn new_visit(&self) -> Uuid {
        let (status, body) = self.post("/visits", json!({})).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        Uuid::parse_str(body["visit"]["id"].as_str().expect("id")).expect("uuid")
    }

    async fn say(&self, visit: Uuid, text: &str) -> (StatusCode, Value) {
        self.post(
            &format!("/visits/{visit}/messages"),
            json!({ "content": text, "client_id": Uuid::new_v4().to_string() }),
        )
        .await
    }
}

async fn count(db: &PgPool, sql: &'static str, id: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_one(db)
        .await
        .expect("count")
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn v1_rows_survive_the_v2_migrations() {
    let db = Db::create().await;
    let pool = PgPool::connect(&db.url).await.expect("pool");
    for (i, file) in [
        "0001_init.sql",
        "0002_platform.sql",
        "0003_adult_consent.sql",
    ]
    .iter()
    .enumerate()
    {
        let sql = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("migrations")
                .join(file),
        )
        .expect("migration");
        sqlx::raw_sql(AssertSqlSafe(sql))
            .execute(&pool)
            .await
            .expect(file);
        if i == 0 {
            sqlx::raw_sql(
                "INSERT INTO accounts (username, display_name, password_hash) VALUES ('dr_demo', 'Demo Clinician', 'x');
                 INSERT INTO visits (locale, status, reviewed_by) VALUES ('zh-TW', 'reviewed', 'Demo Clinician');
                 INSERT INTO messages (visit_id, role, kind, content) SELECT id, 'patient', 'chat', 'x' FROM visits;
                 INSERT INTO runs (visit_id, model) SELECT id, 'm' FROM visits;
                 INSERT INTO clinician_tickets (ticket_no, visit_id, reason, urgency, summary, created_by) SELECT 'T-1', id, 'other', 'soon', 's', 'code' FROM visits;",
            )
            .execute(&pool)
            .await
            .expect("v1 rows");
        }
    }
    let (role, patient, linked): (String, Option<Uuid>, bool) = sqlx::query_as(
        "SELECT a.role, v.patient_id, v.reviewed_by_id = a.id FROM visits v, accounts a",
    )
    .fetch_one(&pool)
    .await
    .expect("row");
    assert_eq!((role.as_str(), patient, linked), ("physician", None, true));
    pool.close().await;
    db.drop().await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn every_route_answers_by_permission() {
    let env = Env::new().await;
    let (patient_id, patient) = env.patient().await;
    let visit = patient.new_visit().await;
    let mut clients = Vec::new();
    for role in Role::ALL {
        clients.push((*role, env.staff(*role).await));
    }
    use Permission::*;
    // (method, path, the permission; patients reach their own routes)
    let routes: Vec<(&str, String, Permission)> = vec![
        ("GET", "/app/home".into(), VisitOwn),
        ("GET", "/app/profile".into(), ProfileOwn),
        ("GET", "/app/measurements".into(), ProfileOwn),
        ("GET", "/app/access-log".into(), ProfileOwn),
        ("GET", "/app/consents".into(), ProfileOwn),
        ("GET", "/app/medications".into(), RxOwn),
        ("GET", "/appointments".into(), ApptOwn),
        ("GET", "/me/export".into(), ProfileOwn),
        ("GET", "/clinic/overview".into(), VisitRead),
        ("GET", "/clinic/worklist".into(), VisitRead),
        ("GET", "/clinic/patients".into(), PatientRead),
        ("GET", format!("/clinic/patients/{patient_id}"), PatientRead),
        (
            "PATCH",
            format!("/clinic/patients/{patient_id}"),
            PatientManage,
        ),
        (
            "POST",
            format!("/clinic/patients/{patient_id}/notes"),
            PatientManage,
        ),
        (
            "POST",
            format!("/clinic/patients/{patient_id}/contact"),
            PatientManage,
        ),
        ("GET", "/clinic/schedule".into(), ApptManage),
        ("GET", "/clinic/tickets".into(), TicketHandle),
        ("GET", format!("/visits/{visit}/note"), VisitRead),
        ("PUT", format!("/visits/{visit}/note"), VisitReview),
        ("POST", format!("/visits/{visit}/assign"), VisitReview),
        ("POST", format!("/visits/{visit}/note/sign"), NoteSign),
        ("POST", format!("/visits/{visit}/note/addendum"), NoteSign),
        ("GET", "/queue/rx".into(), RxRead),
        ("GET", "/admin/overview".into(), OversightRead),
        ("GET", "/admin/oversight".into(), OversightRead),
        ("GET", "/admin/accounts".into(), AccountManage),
        ("GET", "/admin/permissions".into(), AccountManage),
        ("GET", "/admin/settings".into(), SettingsManage),
        ("GET", "/admin/models".into(), SettingsManage),
        ("GET", "/admin/runs".into(), AuditRead),
        ("GET", "/admin/audit".into(), AuditRead),
        ("GET", "/admin/rules".into(), RulesRead),
        ("GET", "/admin/eval".into(), RulesRead),
        ("POST", "/admin/demo/reset".into(), DemoReset),
    ];
    for (method, path, permission) in &routes {
        for (role, client) in &clients {
            // A body that fails validation, so allowed calls change nothing.
            let body = (*method != "GET").then(|| {
                json!({ "confirm": "no", "channel": "?", "body": "", "revision": 999, "sections": {}, "tags": 1, "account_id": patient_id })
            });
            let (status, answer) = client.send(method, path, body, &[]).await;
            if role.can(*permission) {
                assert!(
                    status != StatusCode::FORBIDDEN && status != StatusCode::UNAUTHORIZED,
                    "{} {method} {path}: {status} {answer}",
                    role.as_str()
                );
            } else {
                assert_eq!(
                    status,
                    StatusCode::FORBIDDEN,
                    "{} {method} {path}: {answer}",
                    role.as_str()
                );
            }
        }
    }
    // The conversation itself: owner, physician and coordinator only.
    for (role, client) in &clients {
        let expected = match role {
            Role::Physician | Role::Coordinator => StatusCode::OK,
            // Another patient cannot tell whether the visit exists.
            Role::Patient => StatusCode::NOT_FOUND,
            Role::Pharmacist | Role::Admin => StatusCode::FORBIDDEN,
        };
        for path in [
            format!("/visits/{visit}"),
            format!("/visits/{visit}/stream"),
        ] {
            let (status, _) = client.get(&path).await;
            assert_eq!(status, expected, "{} {path}", role.as_str());
        }
    }
    let anonymous = Client {
        env: &env,
        token: "nobody".into(),
    };
    for (method, path, _) in &routes {
        let (status, _) = anonymous.send(method, path, None, &[]).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
    }
    drop(clients);
    env.done().await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn one_patient_never_reaches_another_patients_things() {
    let env = Env::new().await;
    let (_, a) = env.patient().await;
    let (_, b) = env.patient().await;
    let visit = a.new_visit().await;
    let (_, m) = a
        .post(
            "/app/measurements",
            json!({ "kind": "weight", "values": { "value": 60 } }),
        )
        .await;
    let measurement = m["id"].as_str().expect("id").to_string();
    for (method, path, body) in [
        ("GET", format!("/visits/{visit}"), None),
        ("GET", format!("/visits/{visit}/stream"), None),
        (
            "PATCH",
            format!("/visits/{visit}"),
            Some(json!({ "title": "x" })),
        ),
        ("DELETE", format!("/visits/{visit}"), None),
        (
            "POST",
            format!("/visits/{visit}/messages"),
            Some(json!({ "content": "x", "client_id": "c" })),
        ),
        ("POST", format!("/visits/{visit}/submit"), None),
        ("POST", format!("/visits/{visit}/handoff"), None),
        ("POST", format!("/visits/{visit}/runs/retry"), None),
        (
            "PATCH",
            format!("/visits/{visit}/summary"),
            Some(json!({ "revision": 0, "changes": {} })),
        ),
        ("DELETE", format!("/app/measurements/{measurement}"), None),
    ] {
        let (status, _) = b.send(method, &path, body, &[]).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
    }
    let (_, list) = b.get("/visits").await;
    assert_eq!(list["items"].as_array().expect("items").len(), 0);
    let (_, export) = b.get("/me/export").await;
    assert_eq!(export["visits"].as_array().expect("visits").len(), 0);
    drop((a, b));
    env.done().await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn event_numbers_have_no_gaps_and_replay_continues_into_live_events() {
    let env = Env::new().await;
    let (account, patient) = env.patient().await;
    let visit = patient.new_visit().await;
    let mut tasks = Vec::new();
    for t in 0..8 {
        let state = env.state.clone();
        tasks.push(tokio::spawn(async move {
            for i in 0..12 {
                events::append(&state, visit, "test", json!({ "t": t, "i": i }))
                    .await
                    .expect("append");
            }
        }));
    }
    for task in tasks {
        task.await.expect("task");
    }
    let seqs: Vec<i64> =
        sqlx::query_scalar("SELECT seq FROM visit_events WHERE visit_id = $1 ORDER BY seq")
            .bind(visit)
            .fetch_all(&env.state.db)
            .await
            .expect("seqs");
    assert_eq!(
        seqs,
        (1..=97).collect::<Vec<i64>>(),
        "1 opening + 96 events"
    );

    // Follow from 90 while more events arrive from several writers; every number comes once, in order.
    let session: Uuid = sqlx::query_scalar("SELECT id FROM sessions WHERE account_id = $1")
        .bind(account)
        .fetch_one(&env.state.db)
        .await
        .expect("session");
    let receiver = env.state.hub.subscribe_visit(visit);
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let follower = tokio::spawn(
        Follower {
            visit_id: visit,
            account_id: account,
            session_id: session,
            is_patient: true,
            last: 90,
        }
        .run(env.state.clone(), receiver, tx),
    );
    let writers: Vec<_> = (0..4)
        .map(|_| {
            let state = env.state.clone();
            tokio::spawn(async move {
                for _ in 0..10 {
                    events::append(&state, visit, "late", json!({}))
                        .await
                        .expect("append");
                }
            })
        })
        .collect();
    let mut seen = Vec::new();
    while seen.len() < 47 {
        let event = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("in time")
            .expect("event");
        let text = format!("{event:?}");
        let at = text
            .find("\\\"seq\\\":")
            .map(|i| i + 8)
            .or_else(|| text.find("\"seq\":").map(|i| i + 6));
        let digits: String = text[at.expect("seq")..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        seen.push(digits.parse::<i64>().expect("number"));
    }
    assert_eq!(seen, (91..=137).collect::<Vec<i64>>());
    for writer in writers {
        writer.await.expect("writer");
    }
    drop(rx);
    let _ = follower.await;
    drop(patient);
    env.done().await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn staff_only_events_are_skipped_for_the_patient() {
    let env = Env::new().await;
    let (_, patient) = env.patient().await;
    let visit = patient.new_visit().await;
    events::append_for(
        &env.state,
        visit,
        "staff.note",
        json!({}),
        events::Visibility::Staff,
    )
    .await
    .expect("append");
    events::append(&env.state, visit, "public", json!({}))
        .await
        .expect("append");
    let read = |token: String| {
        let app = routes::app(env.state.clone());
        async move {
            let response = app
                .oneshot(
                    Request::get(format!("/api/v2/visits/{visit}/stream?after=1"))
                        .header("cookie", format!("pv_session={token}"))
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response");
            let mut stream = response.into_body().into_data_stream();
            let mut text = String::new();
            while let Ok(Some(Ok(chunk))) =
                tokio::time::timeout(Duration::from_secs(2), stream.next()).await
            {
                text.push_str(&String::from_utf8_lossy(&chunk));
                if text.contains("event: public") {
                    break;
                }
            }
            text
        }
    };
    let as_patient = read(patient.token.clone()).await;
    assert!(
        as_patient.contains("event: public") && as_patient.contains("id: 3"),
        "{as_patient}"
    );
    assert!(!as_patient.contains("staff.note"));
    let physician = env.staff(Role::Physician).await;
    let as_staff = read(physician.token.clone()).await;
    assert!(as_staff.contains("staff.note") && as_staff.contains("id: 2"));
    drop((patient, physician));
    env.done().await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn a_message_sent_twice_is_one_message_and_one_run() {
    let env = Env::new().await;
    let (_, patient) = env.patient().await;
    let visit = patient.new_visit().await;
    let body = json!({ "content": "咳嗽三天", "client_id": "same" });
    let path = format!("/visits/{visit}/messages");
    let (first, second) = tokio::join!(
        patient.post(&path, body.clone()),
        patient.post(&path, body.clone())
    );
    let statuses = [first.0, second.0];
    assert!(statuses.contains(&StatusCode::ACCEPTED), "{statuses:?}");
    env.settle(visit).await;
    let (status, again) = patient.post(&path, body).await;
    assert_eq!(status, StatusCode::OK);
    assert!(again["run_id"].is_string());
    let db = &env.state.db;
    assert_eq!(
        count(
            db,
            "SELECT count(*) FROM messages WHERE visit_id = $1 AND role = 'patient'",
            visit
        )
        .await,
        1
    );
    assert_eq!(
        count(db, "SELECT count(*) FROM runs WHERE visit_id = $1", visit).await,
        1
    );

    // The same Idempotency-Key gives the same visit, and cannot be reused for something else.
    let key = [("idempotency-key", "k1")];
    let (s1, v1) = patient.send("POST", "/visits", Some(json!({})), &key).await;
    let (s2, v2) = patient.send("POST", "/visits", Some(json!({})), &key).await;
    assert_eq!((s1, s2), (StatusCode::CREATED, StatusCode::CREATED));
    assert_eq!(v1["visit"]["id"], v2["visit"]["id"]);
    let (s3, _) = patient
        .send(
            "POST",
            "/app/measurements",
            Some(json!({ "kind": "weight", "values": { "value": 60 } })),
            &key,
        )
        .await;
    assert_eq!(s3, StatusCode::UNPROCESSABLE_ENTITY);
    drop(patient);
    env.done().await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn only_one_turn_runs_at_a_time_but_a_red_flag_never_waits() {
    let env = Env::new().await;
    let (_, patient) = env.patient().await;
    let visit = patient.new_visit().await;
    let held = env.state.visit_locks.try_acquire(visit).expect("lock");
    let (status, body) = patient.say(visit, "咳嗽三天").await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("conflict"))
    );
    let (status, _) = patient.say(visit, "我胸口悶痛").await;
    assert_eq!(status, StatusCode::ACCEPTED);
    drop(held);
    env.settle(visit).await;
    let (_, detail) = patient.get(&format!("/visits/{visit}")).await;
    assert_eq!(detail["visit"]["status"], "red_flag");
    assert_eq!(detail["red_flag"]["category"], "chest_pain");
    let last = detail["messages"]
        .as_array()
        .expect("messages")
        .last()
        .expect("last")
        .clone();
    assert_eq!(last["kind"], "red_flag");
    assert_eq!(detail["runs"][0]["status"], "skipped");
    drop(patient);
    env.done().await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn runs_cut_off_by_a_restart_are_marked_and_can_be_retried() {
    let env = Env::new().await;
    let (_, patient) = env.patient().await;
    let (ordinary, flagged) = (patient.new_visit().await, patient.new_visit().await);
    // What a crash leaves behind: an accepted message and a running run.
    for (visit, text) in [(ordinary, "咳嗽三天"), (flagged, "我胸口悶痛")] {
        let stored = visits::fetch(&env.state.db, visit, OffsetDateTime::UNIX_EPOCH)
            .await
            .expect("visit")
            .expect("visit");
        let prepared = engine::prepare(&env.state.rules, text);
        let message = engine::accept(&env.state, &stored, &prepared, None, None, None)
            .await
            .expect("accept");
        engine::start_run(&env.state, visit, message.id)
            .await
            .expect("run");
    }
    let interrupted = visits::mark_interrupted(&env.state).await.expect("mark");
    assert_eq!(interrupted.len(), 2);
    engine::finish_interrupted_red_flags(&env.state, &interrupted)
        .await
        .expect("finish");
    assert!(
        visits::mark_interrupted(&env.state)
            .await
            .expect("again")
            .is_empty()
    );

    let (_, detail) = patient.get(&format!("/visits/{ordinary}")).await;
    assert_eq!(detail["runs"][0]["status"], "interrupted");
    assert_eq!(detail["messages"][1]["status"], "interrupted");
    assert_eq!(
        count(
            &env.state.db,
            "SELECT count(*) FROM visit_events WHERE visit_id = $1 AND type = 'run.interrupted'",
            ordinary
        )
        .await,
        1
    );
    let (status, body) = patient
        .post(&format!("/visits/{ordinary}/runs/retry"), json!({}))
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    env.settle(ordinary).await;
    let (_, detail) = patient.get(&format!("/visits/{ordinary}")).await;
    assert_eq!(detail["messages"][1]["status"], "ok");
    assert_eq!(detail["runs"][1]["status"], "completed");
    let (status, _) = patient
        .post(&format!("/visits/{ordinary}/runs/retry"), json!({}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "nothing left to retry");

    // The red flag did not wait for the patient to press retry.
    let (_, detail) = patient.get(&format!("/visits/{flagged}")).await;
    assert_eq!(detail["visit"]["status"], "red_flag");
    assert_eq!(detail["tickets"][0]["urgency"], "urgent");
    assert_eq!(detail["messages"][2]["kind"], "red_flag");
    drop(patient);
    env.done().await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn takeover_pauses_the_ai_and_keeps_the_red_flag_rules() {
    let env = Env::new().await;
    let (_, patient) = env.patient().await;
    let coordinator = env.staff(Role::Coordinator).await;
    let physician = env.staff(Role::Physician).await;
    let visit = patient.new_visit().await;
    let (status, body) = coordinator
        .post(&format!("/visits/{visit}/takeover"), json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["mode"], "human");
    let (status, _) = physician
        .post(&format!("/visits/{visit}/takeover"), json!({}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "someone has it");
    let (status, body) = patient.say(visit, "請問要帶什麼").await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert!(body["run_id"].is_null(), "no AI run");
    let (status, _) = coordinator
        .post(
            &format!("/visits/{visit}/staff-messages"),
            json!({ "content": "帶健保卡", "client_id": "s1" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = physician
        .post(
            &format!("/visits/{visit}/staff-messages"),
            json!({ "content": "x", "client_id": "s2" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, list) = patient.get("/visits").await;
    assert_eq!(list["items"][0]["has_unread"], true);
    let (_, notes) = patient.get("/me/notifications").await;
    assert_eq!(notes["items"][0]["kind"], "visit.staff_message");
    assert!(
        !notes.to_string().contains("健保卡"),
        "notifications carry no message text"
    );

    let (_, body) = patient.say(visit, "我現在喘不過氣").await;
    assert!(body["run_id"].is_string());
    env.settle(visit).await;
    let (_, detail) = patient.get(&format!("/visits/{visit}")).await;
    assert_eq!(detail["visit"]["status"], "red_flag");
    assert_eq!(detail["visit"]["mode"], "human");
    assert_eq!(detail["red_flag"]["category"], "dyspnea");

    let (status, body) = coordinator
        .post(&format!("/visits/{visit}/release"), json!({}))
        .await;
    assert_eq!((status, &body["mode"]), (StatusCode::OK, &json!("ai")));
    let kinds: Vec<String> = detail["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .map(|m| m["kind"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(kinds.contains(&"handoff".to_string()));
    // What staff wrote never goes to the model.
    let logged = count(
        &env.state.db,
        "SELECT count(*) FROM messages WHERE visit_id = $1 AND role = 'staff'",
        visit,
    )
    .await;
    assert_eq!(logged, 3, "taken over, the reply, handed back");
    drop((patient, coordinator, physician));
    env.done().await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn stale_revisions_are_conflicts_that_carry_the_current_object() {
    let env = Env::new().await;
    let (_, patient) = env.patient().await;
    let physician = env.staff(Role::Physician).await;
    let visit = patient.new_visit().await;
    patient.say(visit, "咳嗽三天；昨天開始；沒有部位").await;
    env.settle(visit).await;

    let (_, detail) = patient.get(&format!("/visits/{visit}")).await;
    let revision = detail["summary"]["revision"].as_i64().expect("revision");
    let path = format!("/visits/{visit}/summary");
    let change = |revision: i64| json!({ "revision": revision, "changes": { "hpi.severity": 3 } });
    let (status, body) = patient.patch(&path, change(revision)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["summary"]["edited_by_patient"], true);
    let (status, body) = patient.patch(&path, change(revision)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["current"]["revision"], revision + 1);

    let (_, profile) = patient.get("/app/profile").await;
    let mut edit = profile.clone();
    edit["height_cm"] = json!(160);
    assert_eq!(
        patient.put("/app/profile", edit.clone()).await.0,
        StatusCode::OK
    );
    let (status, body) = patient.put("/app/profile", edit).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["current"]["revision"], 2);

    let note = format!("/visits/{visit}/note");
    let put = |revision: i64| json!({ "revision": revision, "sections": { "assessment": "a", "plan": "p" } });
    let (a, b) = tokio::join!(physician.put(&note, put(0)), physician.put(&note, put(0)));
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort_unstable();
    assert_eq!(statuses, [200, 409], "two first saves: one wins");
    assert_eq!(
        physician
            .post(&format!("{note}/sign"), json!({ "revision": 1 }))
            .await
            .0,
        StatusCode::CONFLICT,
        "not submitted yet"
    );
    patient
        .post(&format!("/visits/{visit}/submit"), json!({}))
        .await;
    let (status, body) = physician
        .post(&format!("{note}/sign"), json!({ "revision": 1 }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        physician.put(&note, put(2)).await.0,
        StatusCode::CONFLICT,
        "a signed note is locked"
    );

    let scope = "/me/drafts/visit:x:composer";
    let draft = |revision: i64| json!({ "payload": { "t": revision }, "revision": revision });
    assert_eq!(patient.put(scope, draft(0)).await.0, StatusCode::OK);
    assert_eq!(patient.put(scope, draft(0)).await.0, StatusCode::CONFLICT);
    assert_eq!(patient.put(scope, draft(1)).await.0, StatusCode::OK);
    drop((patient, physician));
    env.done().await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn reading_a_patient_is_logged_and_the_patient_sees_it() {
    let env = Env::new().await;
    let (id, patient) = env.patient().await;
    let physician = env.staff(Role::Physician).await;
    let pharmacist = env.staff(Role::Pharmacist).await;
    let visit = patient.new_visit().await;
    for _ in 0..3 {
        physician.get(&format!("/visits/{visit}")).await;
    }
    pharmacist.get(&format!("/clinic/patients/{id}")).await;
    let (_, log) = patient.get("/app/access-log").await;
    let entries: Vec<(String, String)> = log["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|e| {
            (
                e["actor"]["role"].as_str().unwrap_or("").to_string(),
                e["resource"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    assert_eq!(
        entries,
        [
            ("pharmacist".to_string(), "medications".to_string()),
            ("physician".to_string(), "visit".to_string())
        ],
        "re-reading within a minute is one entry"
    );
    // The pharmacist's page holds nothing but medicines, allergies and requests.
    let (_, page) = pharmacist.get(&format!("/clinic/patients/{id}")).await;
    for key in [
        "measurements",
        "visits",
        "appointments",
        "tickets",
        "notes",
        "timeline",
    ] {
        assert_eq!(page[key], json!([]), "{key}");
    }
    drop((patient, physician, pharmacist));
    env.done().await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn the_sweep_removes_expired_guests_and_old_visits_only() {
    let env = Env::new().await;
    demo::ensure(&env.state).await.expect("demo");
    let db = &env.state.db;
    let (expired, _) = demo::create_guest(&env.state, "lin", crate::types::Locale::ZhTw)
        .await
        .expect("guest");
    let (fresh, _) = demo::create_guest(&env.state, "wu", crate::types::Locale::En)
        .await
        .expect("guest");
    sqlx::query("UPDATE accounts SET expires_at = now() - interval '1 minute' WHERE id = $1")
        .bind(expired)
        .execute(db)
        .await
        .expect("expire");
    let (_, patient) = env.patient().await;
    let (old, new) = (patient.new_visit().await, patient.new_visit().await);
    sqlx::query("UPDATE visits SET last_activity_at = now() - interval '15 days' WHERE id = $1")
        .bind(old)
        .execute(db)
        .await
        .expect("age");
    assert_eq!(
        patient.get(&format!("/visits/{old}")).await.0,
        StatusCode::NOT_FOUND,
        "past retention is gone even before the sweep"
    );
    sqlx::query("UPDATE visits SET last_activity_at = now() - interval '60 days' WHERE is_demo")
        .execute(db)
        .await
        .expect("age demo");
    let demo_visits: i64 = sqlx::query_scalar("SELECT count(*) FROM visits WHERE is_demo")
        .fetch_one(db)
        .await
        .expect("count");
    assert!(demo_visits >= 7);
    jobs::sweep(&env.state).await.expect("sweep");
    let account = "SELECT count(*) FROM accounts WHERE id = $1";
    assert_eq!(count(db, account, expired).await, 0);
    assert_eq!(count(db, account, fresh).await, 1);
    for sql in [
        "SELECT count(*) FROM measurements WHERE patient_id = $1",
        "SELECT count(*) FROM prescriptions WHERE patient_id = $1",
        "SELECT count(*) FROM visits WHERE patient_id = $1",
        "SELECT count(*) FROM rx_requests WHERE patient_id = $1",
        "SELECT count(*) FROM patient_profiles WHERE account_id = $1",
    ] {
        assert_eq!(count(db, sql, expired).await, 0, "{sql}");
        assert!(count(db, sql, fresh).await > 0, "{sql}");
    }
    let visit = "SELECT count(*) FROM visits WHERE id = $1";
    assert_eq!(count(db, visit, old).await, 0);
    assert_eq!(count(db, visit, new).await, 1);
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM visits WHERE is_demo")
        .fetch_one(db)
        .await
        .expect("count");
    assert_eq!(after, demo_visits);
    drop(patient);
    env.done().await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn deleting_an_account_leaves_nothing_of_it() {
    let env = Env::new().await;
    demo::ensure(&env.state).await.expect("demo");
    let (id, _) = demo::create_guest(&env.state, "lin", crate::types::Locale::ZhTw)
        .await
        .expect("guest");
    let guest = env.client(id).await;
    let visit = guest.new_visit().await;
    guest.say(visit, "我胸口悶痛").await;
    env.settle(visit).await;
    let physician = env.staff(Role::Physician).await;
    physician.get(&format!("/clinic/patients/{id}")).await;
    let (status, _) = guest
        .send("DELETE", "/me", Some(json!({ "confirm": "DELETE" })), &[])
        .await;
    assert_eq!(status, StatusCode::OK);
    let db = &env.state.db;
    for sql in [
        "SELECT count(*) FROM accounts WHERE id = $1",
        "SELECT count(*) FROM sessions WHERE account_id = $1",
        "SELECT count(*) FROM visits WHERE patient_id = $1",
        "SELECT count(*) FROM clinician_tickets WHERE patient_id = $1",
        "SELECT count(*) FROM rx_requests WHERE patient_id = $1",
        "SELECT count(*) FROM prescriptions WHERE patient_id = $1",
        "SELECT count(*) FROM measurements WHERE patient_id = $1",
        "SELECT count(*) FROM appointments WHERE patient_id = $1",
        "SELECT count(*) FROM consents WHERE account_id = $1",
        "SELECT count(*) FROM access_log WHERE patient_id = $1",
        "SELECT count(*) FROM notifications WHERE account_id = $1",
        "SELECT count(*) FROM staff_notes WHERE patient_id = $1",
    ] {
        assert_eq!(count(db, sql, id).await, 0, "{sql}");
    }
    for sql in [
        "SELECT count(*) FROM messages WHERE visit_id = $1",
        "SELECT count(*) FROM visit_events WHERE visit_id = $1",
        "SELECT count(*) FROM tool_calls WHERE visit_id = $1",
        "SELECT count(*) FROM red_flag_events WHERE visit_id = $1",
    ] {
        assert_eq!(count(db, sql, visit).await, 0, "{sql}");
    }
    drop((guest, physician));
    env.done().await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn demo_data_is_rebuilt_without_touching_other_accounts() {
    let env = Env::new().await;
    let first = demo::reset(&env.state).await.expect("reset");
    let db = &env.state.db;
    let counts = || async {
        let (patients, visits, requests, appointments): (i64, i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT count(*) FROM accounts WHERE is_demo AND role = 'patient'), (SELECT count(*) FROM visits WHERE is_demo),
                    (SELECT count(*) FROM rx_requests r JOIN accounts a ON a.id = r.patient_id WHERE a.is_demo), (SELECT count(*) FROM appointments WHERE is_demo)",
        )
        .fetch_one(db)
        .await
        .expect("counts");
        (patients, visits, requests, appointments)
    };
    let before = counts().await;
    assert_eq!(before.0, 9, "8 panel patients and the shared one");
    assert!(before.2 >= 10, "rx requests were seeded: {before:?}");
    let (guest, _) = demo::create_guest(&env.state, "chang", crate::types::Locale::ZhTw)
        .await
        .expect("guest");
    let (person, client) = env.patient().await;
    let visit = client.new_visit().await;
    let second = demo::reset(&env.state).await.expect("again");
    assert_eq!(first, second);
    assert_eq!(counts().await, before);
    let exists = "SELECT count(*) FROM accounts WHERE id = $1";
    assert_eq!(count(db, exists, guest).await, 1);
    assert_eq!(count(db, exists, person).await, 1);
    assert_eq!(
        count(db, "SELECT count(*) FROM visits WHERE id = $1", visit).await,
        1
    );
    // Fresh data is left alone by the periodic check.
    let stamp: OffsetDateTime =
        sqlx::query_scalar("SELECT updated_at FROM app_settings WHERE key = 'demo'")
            .fetch_one(db)
            .await
            .expect("stamp");
    demo::ensure(&env.state).await.expect("ensure");
    let after: OffsetDateTime =
        sqlx::query_scalar("SELECT updated_at FROM app_settings WHERE key = 'demo'")
            .fetch_one(db)
            .await
            .expect("stamp");
    assert_eq!(stamp, after);
    drop(client);
    env.done().await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn settings_survive_a_restart_and_take_effect_at_once() {
    let env = Env::new().await;
    let admin = env.staff(Role::Admin).await;
    let (_, patient) = env.patient().await;
    let (_, mut settings) = admin.get("/admin/settings").await;
    settings["ai"]["enabled"] = json!(false);
    settings["rx"]["oversight_phase"] = json!(3);
    let (status, saved) = admin.put("/admin/settings", settings).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(
        saved["rx"]["oversight_phase"], 1,
        "the phase cannot be raised"
    );
    let visit = patient.new_visit().await;
    patient.say(visit, "頭痛兩天").await;
    env.settle(visit).await;
    let (_, detail) = patient.get(&format!("/visits/{visit}")).await;
    assert_eq!(detail["runs"][0]["status"], "skipped");
    assert_eq!(detail["runs"][0]["error_code"], "ai_disabled");
    let reloaded = SettingsStore::load(&env.state.db, &env.state.config)
        .await
        .expect("load");
    assert!(!reloaded.get().ai.enabled);
    assert_eq!(reloaded.get().revision, 1);
    let unchanged = Settings::defaults(&env.state.config);
    assert!(
        unchanged.ai.enabled,
        "the environment's default is untouched"
    );

    // The month's budget: spent, and the policy says stop.
    let (_, mut settings) = admin.get("/admin/settings").await;
    settings["ai"]["enabled"] = json!(true);
    settings["ai"]["monthly_budget_usd"] = json!(5.0);
    settings["ai"]["on_budget"] = json!("stop");
    assert_eq!(
        admin.put("/admin/settings", settings).await.0,
        StatusCode::OK
    );
    sqlx::query("INSERT INTO usage_daily (day, model, calls, cost_usd) VALUES ($1, 'mock', 1, 6.0) ON CONFLICT (day, model) DO UPDATE SET cost_usd = 6.0")
        .bind(env.state.clock.today())
        .execute(&env.state.db)
        .await
        .expect("usage");
    patient.say(visit, "頭痛三天").await;
    env.settle(visit).await;
    let (_, detail) = patient.get(&format!("/visits/{visit}")).await;
    assert_eq!(detail["runs"][1]["error_code"], "monthly_budget_exceeded");
    let (_, audit) = admin.get("/admin/audit?action=settings.update").await;
    assert_eq!(audit["items"].as_array().expect("items").len(), 2);
    assert!(
        audit["items"][1]["detail"]["changed"]
            .to_string()
            .contains("ai.enabled")
    );
    drop((admin, patient));
    env.done().await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn accounts_stay_safe_when_changed_or_disabled() {
    let env = Env::new().await;
    let admin = env.staff(Role::Admin).await;
    let physician = env.staff(Role::Physician).await;
    let doctor = env.account("dr_demo").await;
    let admin_id = env.account("naritaroad").await;
    let (status, _) = admin
        .patch(
            &format!("/admin/accounts/{admin_id}"),
            json!({ "role": "physician" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "the last admin, and yourself");
    assert_eq!(physician.get("/clinic/overview").await.0, StatusCode::OK);
    let (status, _) = admin
        .patch(
            &format!("/admin/accounts/{doctor}"),
            json!({ "status": "disabled" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        physician.get("/clinic/overview").await.0,
        StatusCode::UNAUTHORIZED,
        "a disabled account is out at once"
    );
    // A session that slipped through (created after) is refused too, because the account is checked every time.
    let again = env.client(doctor).await;
    assert_eq!(
        again.get("/clinic/overview").await.0,
        StatusCode::UNAUTHORIZED
    );
    // Cross-site mutations are refused whatever the session.
    let (status, _) = admin
        .send(
            "POST",
            &format!("/admin/accounts/{doctor}/revoke-sessions"),
            None,
            &[("origin", "https://evil.example"), ("host", "desk.example")],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    drop((admin, physician, again));
    env.done().await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn v1_visits_without_a_patient_are_staff_only() {
    let env = Env::new().await;
    let visit = visits::create(
        &env.state,
        NewVisit {
            locale: crate::types::Locale::ZhTw,
            patient_id: None,
            appointment_id: None,
        },
    )
    .await
    .expect("visit")
    .id;
    let physician = env.staff(Role::Physician).await;
    let (_, patient) = env.patient().await;
    let (status, detail) = physician.get(&format!("/visits/{visit}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["visit"]["patient"]["display_name"], "未具名病人");
    assert_eq!(
        patient.get(&format!("/visits/{visit}")).await.0,
        StatusCode::NOT_FOUND
    );
    drop((physician, patient));
    env.done().await;
}
