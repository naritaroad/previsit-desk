//! Visits: storage, the API shapes (`Visit`, `VisitDetail`) for patient and staff readers, summaries on read, and the
//! retention sweep. Plain SQL with static strings; everything a patient can reach is scoped by `patient_id`.

use std::collections::HashSet;

use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::appts::{self, Appointment};
use crate::auth::CurrentUser;
use crate::events::{self, NewMessage};
use crate::intake::{IntakeState, IntakeView};
use crate::notes::{self, ClinicalNote};
use crate::notify;
use crate::people::{self, PersonRef};
use crate::perm::Permission;
use crate::precheck::RedFlagRules;
use crate::state::{AppState, Rules};
use crate::summary::{self, PrevisitSummary, SummaryInput, TriggeredFlag};
use crate::texts::{self, T, t};
use crate::tickets;
use crate::types::{
    Locale, Message, RedFlagCategory, RedFlagHit, Run, RunRow, Stage, Ticket, ToolCallRecord,
    Urgency, Visit, VisitMode, VisitStatus, message_kind,
};

macro_rules! visit_cols {
    () => {
        "v.id, v.locale, v.status, v.stage, v.urgency, v.mode, v.patient_id, v.appointment_id, v.title, v.pinned, v.archived, v.assigned_to, v.reviewed_by_id, v.chief_complaint, v.last_seq, v.summary_revision, v.edited_by_patient, v.evidence, v.created_at, v.updated_at, v.last_activity_at, v.submitted_at, v.reviewed_at"
    };
}

/// `visits` with the highest open-ticket urgency as `urgency` and the chief complaint pulled out of the intake.
macro_rules! visits_with_urgency {
    () => {
        "(SELECT x.*, x.intake->>'chief_complaint' AS chief_complaint, COALESCE((SELECT CASE max(CASE t.urgency WHEN 'urgent' THEN 3 WHEN 'soon' THEN 2 ELSE 1 END) WHEN 3 THEN 'urgent' WHEN 2 THEN 'soon' ELSE 'routine' END FROM clinician_tickets t WHERE t.visit_id = x.id AND t.status = 'open'), 'routine') AS urgency FROM visits x)"
    };
}

pub(crate) use {visit_cols, visits_with_urgency};

// ---------------------------------------------------------------------------
// Create, load, update
// ---------------------------------------------------------------------------

pub struct NewVisit {
    pub locale: Locale,
    pub patient_id: Option<Uuid>,
    pub appointment_id: Option<Uuid>,
}

/// A new visit plus its fixed opening message (no model call).
pub async fn create(state: &AppState, new: NewVisit) -> sqlx::Result<Visit> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO visits (locale, patient_id, appointment_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(new.locale.as_str())
    .bind(new.patient_id)
    .bind(new.appointment_id)
    .fetch_one(&state.db)
    .await?;
    assistant_message(
        state,
        id,
        new.locale,
        message_kind::OPENING,
        t(T::Opening, new.locale),
        None,
    )
    .await?;
    fetch(&state.db, id, OffsetDateTime::UNIX_EPOCH)
        .await?
        .ok_or(sqlx::Error::RowNotFound)
}

/// The visit, unless it does not exist or its last activity is older than `cutoff` (past retention).
pub async fn fetch(db: &PgPool, id: Uuid, cutoff: OffsetDateTime) -> sqlx::Result<Option<Visit>> {
    sqlx::query_as(concat!(
        "SELECT ",
        visit_cols!(),
        " FROM ",
        visits_with_urgency!(),
        " v WHERE v.id = $1 AND (v.last_activity_at >= $2 OR v.is_demo)"
    ))
    .bind(id)
    .bind(cutoff)
    .fetch_optional(db)
    .await
}

pub fn retention_cutoff(state: &AppState) -> OffsetDateTime {
    state
        .clock
        .retention_cutoff(state.settings.get().retention_days)
}

pub async fn load_intake(db: &PgPool, id: Uuid) -> sqlx::Result<IntakeState> {
    let raw: Option<Value> = sqlx::query_scalar("SELECT intake FROM visits WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    Ok(raw
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default())
}

/// A short title for lists, from the chief complaint: its first clause, at most 24 characters.
pub fn title_from(chief_complaint: &str) -> Option<String> {
    let first = chief_complaint
        .split(['，', '。', '；', ',', ';', '.', '\n'])
        .map(str::trim)
        .find(|part| !part.is_empty())?;
    let mut title: String = first.chars().take(24).collect();
    if first.chars().count() > 24 {
        title.push('…');
    }
    Some(title)
}

/// Saves the intake, the stage, the generated title and the evidence for the fields that changed.
pub async fn save_intake(
    db: &PgPool,
    id: Uuid,
    intake: &IntakeState,
    stage: Stage,
    evidence: &Value,
    edited_by_patient: bool,
) -> sqlx::Result<()> {
    let value = serde_json::to_value(intake).unwrap_or(Value::Null);
    sqlx::query(
        "UPDATE visits SET intake = $2, stage = $3, confirm_offered_at = NULL, summary_revision = summary_revision + 1, evidence = $4,
             edited_by_patient = edited_by_patient OR $5, title = CASE WHEN title_custom THEN title ELSE COALESCE($6, title) END,
             updated_at = now(), last_activity_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(value)
    .bind(stage.as_str())
    .bind(evidence)
    .bind(edited_by_patient)
    .bind(intake.chief_complaint.as_deref().and_then(title_from))
    .execute(db)
    .await?;
    Ok(())
}

/// The read-back was given: an assistant reply was produced while the stage was `confirm`.
pub async fn mark_confirm_offered(db: &PgPool, id: Uuid) -> sqlx::Result<()> {
    sqlx::query("UPDATE visits SET confirm_offered_at = now() WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn confirm_offered(db: &PgPool, id: Uuid) -> sqlx::Result<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT confirm_offered_at IS NOT NULL FROM visits WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .unwrap_or(false))
}

pub async fn set_status(db: &PgPool, id: Uuid, status: VisitStatus) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE visits SET status = $2, updated_at = now(), last_activity_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(status.as_str())
    .execute(db)
    .await?;
    Ok(())
}

pub async fn touch(db: &PgPool, id: Uuid) -> sqlx::Result<()> {
    sqlx::query("UPDATE visits SET updated_at = now(), last_activity_at = now() WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Ends the history taking: stage `done`, `submitted_at` set once. `active` becomes `submitted`;
/// `red_flag` stays `red_flag` (v1 contract §7.1); `submitted` and `reviewed` keep their status.
/// Staff hear about it the first time.
pub async fn finalize_submit(state: &AppState, id: Uuid) -> sqlx::Result<()> {
    let first: Option<Option<Uuid>> = sqlx::query_scalar(
        "UPDATE visits v SET stage = 'done', submitted_at = COALESCE(v.submitted_at, now()),
             status = CASE WHEN v.status = 'active' THEN 'submitted' ELSE v.status END, updated_at = now(), last_activity_at = now()
         FROM (SELECT id, submitted_at FROM visits WHERE id = $1 FOR UPDATE) old
         WHERE v.id = old.id AND old.submitted_at IS NULL RETURNING v.patient_id",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    // Visits without a patient account (v1 rows, the eval runner) do not call anyone.
    if let Some(Some(patient_id)) = first {
        notify::notify_staff(
            state,
            Permission::VisitReview,
            notify::Kind::VisitSubmitted,
            json!({ "patient_id": patient_id }),
            &format!("/clinic/visits/{id}"),
            None,
        )
        .await;
        changed(state, id, Some(patient_id), true);
    }
    Ok(())
}

/// Signals to other tabs and staff screens that a visit changed.
pub fn changed(state: &AppState, id: Uuid, patient_id: Option<Uuid>, queue: bool) {
    if let Some(patient) = patient_id {
        state
            .hub
            .to_account(patient, "visit.changed", json!({ "id": id }));
    }
    state
        .hub
        .to_permission(Permission::VisitRead, "visit.changed", json!({ "id": id }));
    if queue {
        state.hub.to_permission(
            Permission::VisitRead,
            "queue.changed",
            json!({ "name": "visits" }),
        );
    }
}

/// Deletes visits idle since before `cutoff` (demo data is rebuilt instead); every child table cascades.
pub async fn cleanup(db: &PgPool, cutoff: OffsetDateTime) -> sqlx::Result<u64> {
    Ok(
        sqlx::query("DELETE FROM visits WHERE last_activity_at < $1 AND NOT is_demo")
            .bind(cutoff)
            .execute(db)
            .await?
            .rows_affected(),
    )
}

// ---------------------------------------------------------------------------
// Messages, runs, tool calls, audit rows
// ---------------------------------------------------------------------------

/// A message from the program or the model, with its event.
pub async fn assistant_message(
    state: &AppState,
    visit_id: Uuid,
    locale: Locale,
    kind: &str,
    content: &str,
    run_id: Option<Uuid>,
) -> sqlx::Result<Message> {
    events::insert_message(
        state,
        visit_id,
        locale,
        NewMessage {
            role: "assistant",
            kind,
            content,
            run_id,
            author: None,
            client_id: None,
        },
    )
    .await
}

macro_rules! message_cols {
    () => {
        "id, client_id, seq, role, kind, author_id, content, created_at, run_id, status"
    };
}

pub async fn messages(db: &PgPool, visit_id: Uuid, locale: Locale) -> sqlx::Result<Vec<Message>> {
    let mut rows: Vec<Message> = sqlx::query_as(concat!(
        "SELECT ",
        message_cols!(),
        " FROM messages WHERE visit_id = $1 ORDER BY created_at, id"
    ))
    .bind(visit_id)
    .fetch_all(db)
    .await?;
    fill_authors(db, &mut rows, locale).await?;
    Ok(rows)
}

async fn fill_authors(db: &PgPool, rows: &mut [Message], locale: Locale) -> sqlx::Result<()> {
    let people = people::load(db, rows.iter().filter_map(|m| m.author_id), locale).await?;
    for row in rows {
        row.author = people.get(row.author_id);
    }
    Ok(())
}

pub async fn message_by_client_id(
    db: &PgPool,
    visit_id: Uuid,
    client_id: &str,
    locale: Locale,
) -> sqlx::Result<Option<Message>> {
    let mut rows: Vec<Message> = sqlx::query_as(concat!(
        "SELECT ",
        message_cols!(),
        " FROM messages WHERE visit_id = $1 AND client_id = $2"
    ))
    .bind(visit_id)
    .bind(client_id)
    .fetch_all(db)
    .await?;
    fill_authors(db, &mut rows, locale).await?;
    Ok(rows.pop())
}

pub async fn last_patient_message(
    db: &PgPool,
    visit_id: Uuid,
    locale: Locale,
) -> sqlx::Result<Option<Message>> {
    let mut rows: Vec<Message> = sqlx::query_as(concat!(
        "SELECT ",
        message_cols!(),
        " FROM messages WHERE visit_id = $1 AND role = 'patient' ORDER BY created_at DESC, id DESC LIMIT 1"
    ))
    .bind(visit_id)
    .fetch_all(db)
    .await?;
    fill_authors(db, &mut rows, locale).await?;
    Ok(rows.pop())
}

pub async fn set_message_status(db: &PgPool, id: Uuid, status: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE messages SET status = $2 WHERE id = $1")
        .bind(id)
        .bind(status)
        .execute(db)
        .await?;
    Ok(())
}

/// What the patient said in this visit, newest last, the most recent 200 messages (for the output guard's
/// "restating is fine" rule).
pub async fn patient_text(db: &PgPool, visit_id: Uuid) -> sqlx::Result<String> {
    let mut rows: Vec<String> = sqlx::query_scalar("SELECT content FROM messages WHERE visit_id = $1 AND role = 'patient' ORDER BY created_at DESC, id DESC LIMIT 200").bind(visit_id).fetch_all(db).await?;
    rows.reverse();
    Ok(rows.join("\n"))
}

/// How many messages the patient has sent in this visit (for the per-visit cap).
pub async fn patient_message_count(db: &PgPool, visit_id: Uuid) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT count(*) FROM messages WHERE visit_id = $1 AND role = 'patient'")
        .bind(visit_id)
        .fetch_one(db)
        .await
}

pub struct NewToolCall<'a> {
    pub id: Option<Uuid>,
    pub visit_id: Uuid,
    pub run_id: Option<Uuid>,
    pub step: i32,
    pub name: &'a str,
    pub source: &'a str,
    pub status: &'a str,
    pub arguments: &'a Value,
    pub result: &'a Value,
    pub duration_ms: i32,
}

pub async fn record_tool_call(db: &PgPool, call: NewToolCall<'_>) -> sqlx::Result<ToolCallRecord> {
    sqlx::query_as(
        "INSERT INTO tool_calls (id, visit_id, run_id, step, name, source, status, arguments, result, duration_ms) VALUES (COALESCE($1, uuidv7()), $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, run_id, step, name, source, status, arguments, result, duration_ms, created_at",
    )
    .bind(call.id)
    .bind(call.visit_id)
    .bind(call.run_id)
    .bind(call.step)
    .bind(call.name)
    .bind(call.source)
    .bind(call.status)
    .bind(call.arguments)
    .bind(call.result)
    .bind(call.duration_ms)
    .fetch_one(db)
    .await
}

pub async fn insert_run(
    db: &PgPool,
    visit_id: Uuid,
    model: &str,
    message_id: Option<Uuid>,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar(
        "INSERT INTO runs (visit_id, model, status, message_id) VALUES ($1, $2, 'running', $3) RETURNING id",
    )
    .bind(visit_id)
    .bind(model)
    .bind(message_id)
    .fetch_one(db)
    .await
}

#[derive(Default)]
pub struct RunFinish<'a> {
    pub status: &'a str,
    pub steps: i32,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
    pub error_code: Option<&'a str>,
    pub duration_ms: i64,
    pub fallback_used: bool,
    pub model: &'a str,
}

/// Closes a run. Only a `running` run can be closed, so a late finisher never overwrites `interrupted`.
pub async fn finish_run(db: &PgPool, run_id: Uuid, f: RunFinish<'_>) -> sqlx::Result<()> {
    sqlx::query("UPDATE runs SET status = $2, steps = $3, input_tokens = $4, output_tokens = $5, error_code = $6, duration_ms = $7, fallback_used = $8, model = $9, cost_usd = $10 WHERE id = $1 AND status = 'running'")
        .bind(run_id)
        .bind(f.status)
        .bind(f.steps)
        .bind(f.input_tokens.min(i64::from(i32::MAX)) as i32)
        .bind(f.output_tokens.min(i64::from(i32::MAX)) as i32)
        .bind(f.error_code)
        .bind(f.duration_ms.min(i64::from(i32::MAX)) as i32)
        .bind(f.fallback_used)
        .bind(f.model)
        .bind(f.cost_usd)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn insert_red_flag_event(
    db: &PgPool,
    visit_id: Uuid,
    message_id: Uuid,
    category: RedFlagCategory,
    rule_id: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO red_flag_events (visit_id, message_id, category, rule_id)
         SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM red_flag_events WHERE visit_id = $1 AND message_id = $2 AND rule_id = $4)",
    )
    .bind(visit_id)
    .bind(message_id)
    .bind(category.as_str())
    .bind(rule_id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn insert_guard_event(
    db: &PgPool,
    visit_id: Uuid,
    run_id: Uuid,
    kind: &str,
    action: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO guard_events (visit_id, run_id, kind, action) VALUES ($1, $2, $3, $4)",
    )
    .bind(visit_id)
    .bind(run_id)
    .bind(kind)
    .bind(action)
    .execute(db)
    .await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct FlagRow {
    message_id: Uuid,
    category: String,
    rule_id: String,
    created_at: OffsetDateTime,
}

fn flag_label(rules: &RedFlagRules, row: &FlagRow, locale: Locale) -> String {
    rules
        .label_for(&row.rule_id, locale)
        .map(str::to_string)
        .or_else(|| {
            RedFlagCategory::parse(&row.category)
                .map(|c| texts::category_label(c, locale).to_string())
        })
        .unwrap_or_default()
}

/// The most recent red-flag hit of the visit (the emergency card follows this, not the status).
pub async fn latest_red_flag(
    db: &PgPool,
    rules: &RedFlagRules,
    visit_id: Uuid,
    locale: Locale,
) -> sqlx::Result<Option<RedFlagHit>> {
    let row: Option<FlagRow> = sqlx::query_as("SELECT message_id, category, rule_id, created_at FROM red_flag_events WHERE visit_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1").bind(visit_id).fetch_optional(db).await?;
    Ok(row.and_then(|r| {
        let category = RedFlagCategory::parse(&r.category)?;
        Some(RedFlagHit {
            category,
            label: flag_label(rules, &r, locale),
            matched_at: rfc3339(r.created_at),
            message_id: r.message_id,
        })
    }))
}

/// One entry per category that ever matched in this visit.
pub async fn triggered_flags(
    db: &PgPool,
    rules: &RedFlagRules,
    visit_id: Uuid,
    locale: Locale,
) -> sqlx::Result<Vec<TriggeredFlag>> {
    let rows: Vec<FlagRow> = sqlx::query_as("SELECT message_id, category, rule_id, created_at FROM red_flag_events WHERE visit_id = $1 ORDER BY created_at, id").bind(visit_id).fetch_all(db).await?;
    let mut out: Vec<TriggeredFlag> = Vec::new();
    for row in rows {
        if !out.iter().any(|f| f.category == row.category) {
            out.push(TriggeredFlag {
                label: flag_label(rules, &row, locale),
                category: row.category,
            });
        }
    }
    Ok(out)
}

pub fn rfc3339(at: OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Visit in the API
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct VisitView {
    pub id: Uuid,
    pub title: String,
    pub locale: Locale,
    pub status: VisitStatus,
    pub stage: Stage,
    pub urgency: Urgency,
    pub mode: VisitMode,
    pub pinned: bool,
    pub archived: bool,
    pub patient: PersonRef,
    pub appointment: Option<Appointment>,
    pub assigned_to: Option<PersonRef>,
    pub chief_complaint: Option<String>,
    pub last_seq: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub last_activity_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub submitted_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub reviewed_at: Option<OffsetDateTime>,
    pub reviewed_by: Option<PersonRef>,
    pub has_unread: bool,
}

pub fn display_title(visit: &Visit, locale: Locale) -> String {
    visit
        .title
        .clone()
        .unwrap_or_else(|| t(T::DefaultVisitTitle, locale).to_string())
}

/// Which of `ids` hold a message the reader has not seen. For a patient that is anything the other side wrote (the
/// opening does not count); for staff, anything the patient wrote.
async fn unread(db: &PgPool, ids: &[Uuid], viewer: &CurrentUser) -> sqlx::Result<HashSet<Uuid>> {
    let rows: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT m.visit_id FROM messages m LEFT JOIN visit_reads r ON r.visit_id = m.visit_id AND r.account_id = $2
         WHERE m.visit_id = ANY($1) AND m.seq > COALESCE(r.seq, 0) AND m.kind <> 'opening' AND (m.role = 'patient') <> $3",
    )
    .bind(ids)
    .bind(viewer.id)
    .bind(viewer.is_patient())
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().collect())
}

/// API shapes of `rows`. Without a viewer (stream events) nothing is unread.
pub async fn views(
    db: &PgPool,
    rows: Vec<Visit>,
    viewer: Option<&CurrentUser>,
    locale: Locale,
) -> sqlx::Result<Vec<VisitView>> {
    let people = people::load(
        db,
        rows.iter().flat_map(|v| {
            [v.patient_id, v.assigned_to, v.reviewed_by_id]
                .into_iter()
                .flatten()
        }),
        locale,
    )
    .await?;
    let appointment_ids: Vec<Uuid> = rows.iter().filter_map(|v| v.appointment_id).collect();
    let appointments = appts::by_ids(db, &appointment_ids).await?;
    let appointment_views = appts::views(db, &appointments, locale).await?;
    let ids: Vec<Uuid> = rows.iter().map(|v| v.id).collect();
    let unread = match viewer {
        Some(viewer) if !ids.is_empty() => unread(db, &ids, viewer).await?,
        _ => HashSet::new(),
    };
    Ok(rows
        .into_iter()
        .map(|v| VisitView {
            title: display_title(&v, locale),
            patient: people.get_or_unknown(v.patient_id, locale),
            appointment: v
                .appointment_id
                .and_then(|id| appointment_views.iter().find(|a| a.id == id).cloned()),
            assigned_to: people.get(v.assigned_to),
            reviewed_by: people.get(v.reviewed_by_id),
            has_unread: unread.contains(&v.id),
            id: v.id,
            locale: v.locale,
            status: v.status,
            stage: v.stage,
            urgency: v.urgency,
            mode: v.mode,
            pinned: v.pinned,
            archived: v.archived,
            chief_complaint: v.chief_complaint,
            last_seq: v.last_seq,
            created_at: v.created_at,
            updated_at: v.updated_at,
            last_activity_at: v.last_activity_at,
            submitted_at: v.submitted_at,
            reviewed_at: v.reviewed_at,
        })
        .collect())
}

pub async fn view_one(
    db: &PgPool,
    visit: Visit,
    viewer: Option<&CurrentUser>,
    locale: Locale,
) -> sqlx::Result<VisitView> {
    views(db, vec![visit], viewer, locale)
        .await?
        .pop()
        .ok_or(sqlx::Error::RowNotFound)
}

/// Sends `visit.updated` with the visit as it is now.
pub async fn emit_updated(state: &AppState, visit_id: Uuid) -> sqlx::Result<()> {
    let Some(visit) = fetch(&state.db, visit_id, OffsetDateTime::UNIX_EPOCH).await? else {
        return Ok(());
    };
    let (locale, patient_id) = (visit.locale, visit.patient_id);
    let view = view_one(&state.db, visit, None, locale).await?;
    events::append(
        state,
        visit_id,
        "visit.updated",
        serde_json::to_value(view).unwrap_or(Value::Null),
    )
    .await?;
    changed(state, visit_id, patient_id, false);
    Ok(())
}

// ---------------------------------------------------------------------------
// VisitDetail
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct RefillCheckOut {
    pub id: Uuid,
    pub input: Value,
    pub result: Value,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Serialize)]
pub struct VisitDetail {
    pub visit: VisitView,
    pub messages: Vec<Message>,
    pub intake: IntakeView,
    pub summary: Option<PrevisitSummary>,
    pub red_flag: Option<RedFlagHit>,
    pub tickets: Vec<Ticket>,
    pub tool_calls: Vec<ToolCallRecord>,
    pub runs: Vec<Run>,
    pub refill_checks: Vec<RefillCheckOut>,
    /// Staff: the note or its draft if one was saved. Patient: only after signing, only the message to them.
    pub note: Option<ClinicalNote>,
}

pub async fn latest_refill(db: &PgPool, visit_id: Uuid) -> sqlx::Result<Option<Value>> {
    sqlx::query_scalar("SELECT result FROM refill_checks WHERE visit_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1").bind(visit_id).fetch_optional(db).await
}

/// The stored summary, or (before submission, once there is a chief complaint) a preview built from the intake.
/// Either way with the current revision, evidence, red flags and refill result.
pub async fn current_summary(
    db: &PgPool,
    rules: &Rules,
    visit: &Visit,
    now: OffsetDateTime,
) -> sqlx::Result<Option<PrevisitSummary>> {
    let flags = triggered_flags(db, &rules.red_flags, visit.id, visit.locale).await?;
    let refill = latest_refill(db, visit.id).await?;
    let mut summary = match summary::load(db, visit.id).await? {
        Some(summary) => summary,
        None => {
            let intake = load_intake(db, visit.id).await?;
            if intake.chief_complaint.is_none() {
                return Ok(None);
            }
            summary::build(SummaryInput {
                visit_id: visit.id,
                intake: &intake,
                locale: visit.locale,
                flags: Vec::new(),
                refill: None,
                narrative: None,
                model: None,
                follow_up: Vec::new(),
                now,
            })
        }
    };
    summary.refill = refill;
    summary.revision = visit.summary_revision;
    summary.edited_by_patient = visit.edited_by_patient;
    summary.evidence = summary::parse_evidence(&visit.evidence);
    // A red flag after the summary was saved must still show to the clinician.
    summary::refresh_screen(&mut summary, flags, visit.locale);
    Ok(Some(summary))
}

/// `viewer = None` is the eval runner: everything, as staff would see it.
pub async fn build_detail(
    state: &AppState,
    visit: Visit,
    viewer: Option<&CurrentUser>,
) -> sqlx::Result<VisitDetail> {
    let db = &state.db;
    let id = visit.id;
    let locale = viewer.map_or(visit.locale, |v| v.locale);
    let is_patient = viewer.is_some_and(CurrentUser::is_patient);
    let intake = load_intake(db, id).await?;
    let messages = messages(db, id, locale).await?;
    let mut tickets = tickets::for_visit(db, id).await?;
    tickets::fill_patients(db, &mut tickets, locale).await?;
    let tool_calls: Vec<ToolCallRecord> =
        sqlx::query_as("SELECT id, run_id, step, name, source, status, arguments, result, duration_ms, created_at FROM tool_calls WHERE visit_id = $1 ORDER BY created_at, id").bind(id).fetch_all(db).await?;
    let runs: Vec<RunRow> = sqlx::query_as("SELECT id, model, fallback_used, status, steps, input_tokens, output_tokens, error_code, duration_ms, created_at FROM runs WHERE visit_id = $1 ORDER BY created_at, id").bind(id).fetch_all(db).await?;
    let refill_checks: Vec<RefillCheckOut> = sqlx::query_as("SELECT id, input, result, created_at FROM refill_checks WHERE visit_id = $1 ORDER BY created_at, id").bind(id).fetch_all(db).await?;
    let summary = current_summary(db, &state.rules, &visit, state.clock.now()).await?;
    let red_flag = latest_red_flag(db, &state.rules.red_flags, id, visit.locale).await?;
    let note = notes::load(db, id, locale).await?;
    let note = if is_patient {
        for ticket in &mut tickets {
            ticket.resolved_by = None;
            ticket.resolution_note = None;
        }
        note.and_then(ClinicalNote::for_patient)
    } else {
        note
    };
    let stage = visit.stage;
    Ok(VisitDetail {
        visit: view_one(db, visit, viewer, locale).await?,
        messages,
        intake: intake.view(stage),
        summary,
        red_flag,
        tickets,
        tool_calls,
        runs: runs.into_iter().map(Run::from).collect(),
        refill_checks,
        note,
    })
}

// ---------------------------------------------------------------------------
// Server restarts
// ---------------------------------------------------------------------------

/// At start: runs that were still going when the process ended become `interrupted`, the message that started each
/// one is marked so the patient can retry, and the visit's stream says so. Returns the affected messages.
pub async fn mark_interrupted(state: &AppState) -> sqlx::Result<Vec<(Uuid, Uuid)>> {
    let rows: Vec<(Uuid, Uuid, Option<Uuid>)> = sqlx::query_as(
        "UPDATE runs SET status = 'interrupted', error_code = 'interrupted' WHERE status = 'running' RETURNING id, visit_id, message_id",
    )
    .fetch_all(&state.db)
    .await?;
    let mut affected = Vec::new();
    for (run_id, visit_id, message_id) in rows {
        if let Some(message_id) = message_id {
            set_message_status(&state.db, message_id, "interrupted").await?;
            affected.push((visit_id, message_id));
        }
        events::append(
            state,
            visit_id,
            "run.interrupted",
            json!({ "run_id": run_id, "message_id": message_id }),
        )
        .await?;
    }
    Ok(affected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_iso_8601_utc() {
        assert_eq!(
            rfc3339(time::macros::datetime!(2026-11-25 08:00 UTC)),
            "2026-11-25T08:00:00Z"
        );
    }

    #[test]
    fn titles_are_the_first_clause_of_the_chief_complaint() {
        assert_eq!(
            title_from("咳嗽三天，晚上比較嚴重").as_deref(),
            Some("咳嗽三天")
        );
        assert_eq!(title_from("  。頭痛 ").as_deref(), Some("頭痛"));
        assert_eq!(title_from("   "), None);
        let long = title_from(&"長".repeat(40)).expect("title");
        assert_eq!(long.chars().count(), 25);
        assert!(long.ends_with('…'));
    }
}
