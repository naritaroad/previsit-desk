//! Visits: creation, loading, state changes, the `VisitDetail` the API returns (patient and clinician projections),
//! the clinician list, and the retention sweep. Everything here is plain SQL with static strings.

use serde::Serialize;
use serde_json::Value;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::intake::{IntakeState, IntakeView};
use crate::precheck::RedFlagRules;
use crate::state::Rules;
use crate::summary::{PrevisitSummary, TriggeredFlag};
use crate::texts::{self, T, t};
use crate::tickets;
use crate::types::{
    Locale, Message, RedFlagCategory, RedFlagHit, Run, RunRow, Stage, Ticket, ToolCallRecord,
    Visit, VisitStatus, message_kind,
};

macro_rules! visit_cols {
    () => {
        "v.id, v.locale, v.status, v.stage, v.urgency, v.created_at, v.updated_at, v.submitted_at, v.reviewed_at, v.reviewed_by, v.review_note"
    };
}

/// `visits` with the highest open-ticket urgency computed as `urgency`.
macro_rules! visits_with_urgency {
    () => {
        "(SELECT x.*, COALESCE((SELECT CASE max(CASE t.urgency WHEN 'urgent' THEN 3 WHEN 'soon' THEN 2 ELSE 1 END) WHEN 3 THEN 'urgent' WHEN 2 THEN 'soon' ELSE 'routine' END FROM clinician_tickets t WHERE t.visit_id = x.id AND t.status = 'open'), 'routine') AS urgency FROM visits x)"
    };
}

// ---------------------------------------------------------------------------
// Create, load, update
// ---------------------------------------------------------------------------

/// A new visit plus its fixed opening message (no model call).
pub async fn create(db: &PgPool, locale: Locale) -> sqlx::Result<(Visit, Message)> {
    let id: Uuid = sqlx::query_scalar("INSERT INTO visits (locale) VALUES ($1) RETURNING id")
        .bind(locale.as_str())
        .fetch_one(db)
        .await?;
    let opening = insert_message(
        db,
        id,
        "assistant",
        message_kind::OPENING,
        t(T::Opening, locale),
        None,
    )
    .await?;
    let visit = fetch(db, id, OffsetDateTime::UNIX_EPOCH)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;
    Ok((visit, opening))
}

/// The visit, unless it does not exist or its last activity is older than `cutoff` (past retention).
pub async fn fetch(db: &PgPool, id: Uuid, cutoff: OffsetDateTime) -> sqlx::Result<Option<Visit>> {
    sqlx::query_as(concat!(
        "SELECT ",
        visit_cols!(),
        " FROM ",
        visits_with_urgency!(),
        " v WHERE v.id = $1 AND v.last_activity_at >= $2"
    ))
    .bind(id)
    .bind(cutoff)
    .fetch_optional(db)
    .await
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

pub async fn save_intake(
    db: &PgPool,
    id: Uuid,
    intake: &IntakeState,
    stage: Stage,
) -> sqlx::Result<()> {
    let value = serde_json::to_value(intake).unwrap_or(Value::Null);
    sqlx::query("UPDATE visits SET intake = $2, stage = $3, confirm_offered_at = NULL, updated_at = now(), last_activity_at = now() WHERE id = $1").bind(id).bind(value).bind(stage.as_str()).execute(db).await?;
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
/// `red_flag` stays `red_flag` (contract §7.1); `submitted` and `reviewed` keep their status.
pub async fn finalize_submit(db: &PgPool, id: Uuid) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE visits SET stage = 'done', submitted_at = COALESCE(submitted_at, now()),
             status = CASE WHEN status = 'active' THEN 'submitted' ELSE status END, updated_at = now(), last_activity_at = now() WHERE id = $1",
    )
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

pub enum ReviewError {
    NotFound,
    InvalidState,
    Db(sqlx::Error),
}

impl From<sqlx::Error> for ReviewError {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e)
    }
}

/// `submitted` or `red_flag` becomes `reviewed`.
pub async fn review(
    db: &PgPool,
    id: Uuid,
    by: &str,
    note: Option<&str>,
) -> Result<(), ReviewError> {
    let done = sqlx::query("UPDATE visits SET status = 'reviewed', reviewed_at = now(), reviewed_by = $2, review_note = $3, updated_at = now() WHERE id = $1 AND status IN ('submitted', 'red_flag')")
        .bind(id)
        .bind(by)
        .bind(note)
        .execute(db)
        .await?;
    if done.rows_affected() > 0 {
        return Ok(());
    }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM visits WHERE id = $1)")
        .bind(id)
        .fetch_one(db)
        .await?;
    Err(if exists {
        ReviewError::InvalidState
    } else {
        ReviewError::NotFound
    })
}

/// Deletes visits idle since before `cutoff`; every child table cascades.
pub async fn cleanup(db: &PgPool, cutoff: OffsetDateTime) -> sqlx::Result<u64> {
    Ok(
        sqlx::query("DELETE FROM visits WHERE last_activity_at < $1")
            .bind(cutoff)
            .execute(db)
            .await?
            .rows_affected(),
    )
}

// ---------------------------------------------------------------------------
// Messages, runs, tool calls, audit rows
// ---------------------------------------------------------------------------

pub async fn insert_message(
    db: &PgPool,
    visit_id: Uuid,
    role: &str,
    kind: &str,
    content: &str,
    run_id: Option<Uuid>,
) -> sqlx::Result<Message> {
    sqlx::query_as("INSERT INTO messages (visit_id, role, kind, content, run_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, role, kind, content, created_at, run_id")
        .bind(visit_id)
        .bind(role)
        .bind(kind)
        .bind(content)
        .bind(run_id)
        .fetch_one(db)
        .await
}

pub async fn messages(db: &PgPool, visit_id: Uuid) -> sqlx::Result<Vec<Message>> {
    sqlx::query_as("SELECT id, role, kind, content, created_at, run_id FROM messages WHERE visit_id = $1 ORDER BY created_at, id").bind(visit_id).fetch_all(db).await
}

/// What the patient said in this visit, newest last (for the output guard's "restating is fine" rule).
pub async fn patient_text(db: &PgPool, visit_id: Uuid) -> sqlx::Result<String> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT content FROM messages WHERE visit_id = $1 AND role = 'patient' ORDER BY created_at, id LIMIT 200").bind(visit_id).fetch_all(db).await?;
    Ok(rows.join("\n"))
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
    status: &str,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar(
        "INSERT INTO runs (visit_id, model, status) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(visit_id)
    .bind(model)
    .bind(status)
    .fetch_one(db)
    .await
}

pub struct RunFinish<'a> {
    pub status: &'a str,
    pub steps: i32,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub error_code: Option<&'a str>,
    pub duration_ms: i64,
    pub fallback_used: bool,
    pub model: &'a str,
}

pub async fn finish_run(db: &PgPool, run_id: Uuid, f: RunFinish<'_>) -> sqlx::Result<()> {
    sqlx::query("UPDATE runs SET status = $2, steps = $3, input_tokens = $4, output_tokens = $5, error_code = $6, duration_ms = $7, fallback_used = $8, model = $9 WHERE id = $1")
        .bind(run_id)
        .bind(f.status)
        .bind(f.steps)
        .bind(f.input_tokens.min(i64::from(i32::MAX)) as i32)
        .bind(f.output_tokens.min(i64::from(i32::MAX)) as i32)
        .bind(f.error_code)
        .bind(f.duration_ms.min(i64::from(i32::MAX)) as i32)
        .bind(f.fallback_used)
        .bind(f.model)
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
    sqlx::query("INSERT INTO red_flag_events (visit_id, message_id, category, rule_id) VALUES ($1, $2, $3, $4)").bind(visit_id).bind(message_id).bind(category.as_str()).bind(rule_id).execute(db).await?;
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
// VisitDetail
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Projection {
    /// The patient holding the visit id: clinician-private fields are null.
    Patient,
    Clinician,
}

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
    pub visit: Visit,
    pub messages: Vec<Message>,
    pub intake: IntakeView,
    pub summary: Option<PrevisitSummary>,
    pub red_flag: Option<RedFlagHit>,
    pub tickets: Vec<Ticket>,
    pub tool_calls: Vec<ToolCallRecord>,
    pub runs: Vec<Run>,
    pub refill_checks: Vec<RefillCheckOut>,
}

pub async fn latest_refill(db: &PgPool, visit_id: Uuid) -> sqlx::Result<Option<Value>> {
    sqlx::query_scalar("SELECT result FROM refill_checks WHERE visit_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1").bind(visit_id).fetch_optional(db).await
}

pub async fn build_detail(
    db: &PgPool,
    rules: &Rules,
    visit: Visit,
    projection: Projection,
) -> sqlx::Result<VisitDetail> {
    let id = visit.id;
    let intake = load_intake(db, id).await?;
    let messages = messages(db, id).await?;
    let mut tickets = tickets::for_visit(db, id).await?;
    let tool_calls: Vec<ToolCallRecord> =
        sqlx::query_as("SELECT id, run_id, step, name, source, status, arguments, result, duration_ms, created_at FROM tool_calls WHERE visit_id = $1 ORDER BY created_at, id").bind(id).fetch_all(db).await?;
    let runs: Vec<RunRow> = sqlx::query_as("SELECT id, model, fallback_used, status, steps, input_tokens, output_tokens, error_code, duration_ms, created_at FROM runs WHERE visit_id = $1 ORDER BY created_at, id").bind(id).fetch_all(db).await?;
    let refill_checks: Vec<RefillCheckOut> = sqlx::query_as("SELECT id, input, result, created_at FROM refill_checks WHERE visit_id = $1 ORDER BY created_at, id").bind(id).fetch_all(db).await?;
    let mut summary = crate::summary::load(db, id).await?;
    if let Some(s) = summary.as_mut() {
        s.refill = refill_checks.last().map(|c| c.result.clone());
    }
    let red_flag = latest_red_flag(db, &rules.red_flags, id, visit.locale).await?;
    let mut visit = visit;
    if projection == Projection::Patient {
        visit.review_note = None;
        visit.reviewed_by = None;
        for ticket in &mut tickets {
            ticket.resolved_by = None;
            ticket.resolution_note = None;
        }
    }
    let view = intake.view(visit.stage);
    Ok(VisitDetail {
        visit,
        messages,
        intake: view,
        summary,
        red_flag,
        tickets,
        tool_calls,
        runs: runs.into_iter().map(Run::from).collect(),
        refill_checks,
    })
}

// ---------------------------------------------------------------------------
// Clinician list
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct ItemRow {
    #[sqlx(flatten)]
    visit: Visit,
    chief_complaint: Option<String>,
    open_tickets: i64,
    has_summary: bool,
    message_count: i64,
    last_activity_at: OffsetDateTime,
    rf_category: Option<String>,
    rf_rule: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FlagBrief {
    pub category: String,
    pub label: String,
}

#[derive(Debug, Serialize)]
pub struct ClinicianVisitItem {
    pub visit: Visit,
    pub chief_complaint: Option<String>,
    pub red_flag: Option<FlagBrief>,
    pub open_tickets: i64,
    pub has_summary: bool,
    pub message_count: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub last_activity_at: OffsetDateTime,
}

fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// `status`: `pending` (submitted or red_flag), `submitted`, `red_flag`, `reviewed`, `active` or `all`.
/// Urgent visits first, then the most recent activity.
pub async fn list_for_clinician(
    db: &PgPool,
    rules: &RedFlagRules,
    status: &str,
    query: Option<&str>,
    limit: i64,
) -> sqlx::Result<Vec<ClinicianVisitItem>> {
    let pattern = query
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(|q| format!("%{}%", escape_like(q)));
    let rows: Vec<ItemRow> = sqlx::query_as(concat!(
        "SELECT ",
        visit_cols!(),
        ", v.intake->>'chief_complaint' AS chief_complaint,
           (SELECT count(*) FROM clinician_tickets t WHERE t.visit_id = v.id AND t.status = 'open') AS open_tickets,
           EXISTS (SELECT 1 FROM previsit_summaries s WHERE s.visit_id = v.id) AS has_summary,
           (SELECT count(*) FROM messages m WHERE m.visit_id = v.id) AS message_count,
           v.last_activity_at,
           (SELECT e.category FROM red_flag_events e WHERE e.visit_id = v.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS rf_category,
           (SELECT e.rule_id FROM red_flag_events e WHERE e.visit_id = v.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS rf_rule
         FROM ",
        visits_with_urgency!(),
        " v
         WHERE ($1 = 'all' OR ($1 = 'pending' AND v.status IN ('submitted', 'red_flag')) OR v.status = $1)
           AND ($2::text IS NULL OR v.intake->>'chief_complaint' ILIKE $2 ESCAPE '\\' OR v.id::text ILIKE $2 ESCAPE '\\')
         ORDER BY CASE WHEN v.urgency = 'urgent' THEN 0 ELSE 1 END, v.last_activity_at DESC, v.id
         LIMIT $3"
    ))
    .bind(status)
    .bind(pattern)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let locale = r.visit.locale;
            let red_flag = r
                .rf_category
                .as_deref()
                .and_then(RedFlagCategory::parse)
                .map(|category| FlagBrief {
                    category: category.as_str().to_string(),
                    label: r
                        .rf_rule
                        .as_deref()
                        .and_then(|id| rules.label_for(id, locale))
                        .map(str::to_string)
                        .unwrap_or_else(|| texts::category_label(category, locale).to_string()),
                });
            ClinicianVisitItem {
                visit: r.visit,
                chief_complaint: r.chief_complaint,
                red_flag,
                open_tickets: r.open_tickets,
                has_summary: r.has_summary,
                message_count: r.message_count,
                last_activity_at: r.last_activity_at,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_patterns_are_escaped() {
        assert_eq!(escape_like("50%_off\\"), "50\\%\\_off\\\\");
    }

    #[test]
    fn timestamps_are_iso_8601_utc() {
        assert_eq!(
            rfc3339(time::macros::datetime!(2026-11-25 08:00 UTC)),
            "2026-11-25T08:00:00Z"
        );
    }
}
