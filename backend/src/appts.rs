//! Appointments and slots. Slots are computed from `schedule_templates` (Taipei time); a booking is one row, and a
//! unique index keeps two patients out of the same slot.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime, Time, UtcOffset};
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::clock::parse_date;
use crate::error::{AppError, AppResult};
use crate::http::ApiJson;
use crate::idem::{self, IdempotencyKey};
use crate::page::{self, Page, Params};
use crate::people::{self, People, PersonRef};
use crate::perm::Permission;
use crate::pii;
use crate::state::AppState;
use crate::texts::{T, fmt, t};
use crate::types::Locale;

/// Booking opens this far ahead and closes this long before a slot starts.
const MAX_DAYS_AHEAD: i64 = 28;
const MIN_LEAD: Duration = Duration::minutes(30);
const MAX_ACTIVE_BOOKINGS: i64 = 5;

pub fn taipei() -> UtcOffset {
    UtcOffset::from_hms(8, 0, 0).unwrap_or(UtcOffset::UTC)
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ApptRow {
    pub id: Uuid,
    pub patient_id: Uuid,
    pub physician_id: Uuid,
    pub department: String,
    pub department_en: String,
    pub starts_at: OffsetDateTime,
    pub minutes: i32,
    pub mode: String,
    pub status: String,
    pub reason: Option<String>,
    pub room: Option<String>,
    pub visit_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Appointment {
    pub id: Uuid,
    pub physician: PersonRef,
    pub department: String,
    #[serde(with = "time::serde::rfc3339")]
    pub starts_at: OffsetDateTime,
    pub minutes: i32,
    pub mode: String,
    pub status: String,
    pub reason: Option<String>,
    pub visit_id: Option<Uuid>,
    pub room: Option<String>,
}

macro_rules! appt_cols {
    () => {
        "a.id, a.patient_id, a.physician_id, a.department, a.department_en, a.starts_at, a.minutes, a.mode, a.status, a.reason, a.room, (SELECT v.id FROM visits v WHERE v.appointment_id = a.id) AS visit_id"
    };
}

impl ApptRow {
    pub fn view(&self, people: &People, locale: Locale) -> Appointment {
        Appointment {
            id: self.id,
            physician: people.get_or_unknown(Some(self.physician_id), locale),
            department: pick(&self.department, &self.department_en, locale),
            starts_at: self.starts_at,
            minutes: self.minutes,
            mode: self.mode.clone(),
            status: self.status.clone(),
            reason: self.reason.clone(),
            visit_id: self.visit_id,
            room: self.room.clone(),
        }
    }
}

fn pick(zh: &str, en: &str, locale: Locale) -> String {
    if locale.is_en() && !en.is_empty() {
        en.to_string()
    } else {
        zh.to_string()
    }
}

pub async fn views(
    db: &PgPool,
    rows: &[ApptRow],
    locale: Locale,
) -> sqlx::Result<Vec<Appointment>> {
    let people = people::load(db, rows.iter().map(|r| r.physician_id), locale).await?;
    Ok(rows.iter().map(|r| r.view(&people, locale)).collect())
}

pub async fn by_ids(db: &PgPool, ids: &[Uuid]) -> sqlx::Result<Vec<ApptRow>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    sqlx::query_as(concat!(
        "SELECT ",
        appt_cols!(),
        " FROM appointments a WHERE a.id = ANY($1)"
    ))
    .bind(ids)
    .fetch_all(db)
    .await
}

pub async fn for_patient(db: &PgPool, patient_id: Uuid) -> sqlx::Result<Vec<ApptRow>> {
    sqlx::query_as(concat!(
        "SELECT ",
        appt_cols!(),
        " FROM appointments a WHERE a.patient_id = $1 ORDER BY a.starts_at DESC, a.id LIMIT 200"
    ))
    .bind(patient_id)
    .fetch_all(db)
    .await
}

/// The patient's next live appointment that has not ended.
pub async fn next_for_patient(
    db: &PgPool,
    patient_id: Uuid,
    now: OffsetDateTime,
) -> sqlx::Result<Option<ApptRow>> {
    sqlx::query_as(concat!(
        "SELECT ",
        appt_cols!(),
        " FROM appointments a WHERE a.patient_id = $1 AND a.status IN ('booked', 'checked_in') AND a.starts_at + make_interval(mins => a.minutes) > $2 ORDER BY a.starts_at LIMIT 1"
    ))
    .bind(patient_id)
    .bind(now)
    .fetch_optional(db)
    .await
}

/// Every live appointment of one Taipei day.
pub async fn on_day(db: &PgPool, day: Date) -> sqlx::Result<Vec<ApptRow>> {
    let start = day.with_time(Time::MIDNIGHT).assume_offset(taipei());
    sqlx::query_as(concat!(
        "SELECT ",
        appt_cols!(),
        " FROM appointments a WHERE a.status <> 'cancelled' AND a.starts_at >= $1 AND a.starts_at < $2 ORDER BY a.starts_at, a.id LIMIT 500"
    ))
    .bind(start)
    .bind(start + Duration::days(1))
    .fetch_all(db)
    .await
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Template {
    pub physician_id: Uuid,
    pub weekday: i16,
    pub starts: Time,
    pub ends: Time,
    pub minutes: i32,
    pub department: String,
    pub department_en: String,
    pub mode: String,
    pub room: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Slot {
    pub physician_id: Uuid,
    pub starts_at: OffsetDateTime,
    pub minutes: i32,
    pub department: String,
    pub department_en: String,
    pub mode: String,
    pub room: Option<String>,
}

impl Slot {
    /// `<physician>_<unix seconds>`: stable, and unique because a physician has one slot per start time.
    pub fn id(&self) -> String {
        slot_id(self.physician_id, self.starts_at)
    }
}

pub fn slot_id(physician: Uuid, starts_at: OffsetDateTime) -> String {
    format!("{}_{}", physician.simple(), starts_at.unix_timestamp())
}

fn parse_slot_id(text: &str) -> Option<(Uuid, OffsetDateTime)> {
    let (physician, at) = text.split_once('_')?;
    Some((
        Uuid::parse_str(physician).ok()?,
        OffsetDateTime::from_unix_timestamp(at.parse().ok()?).ok()?,
    ))
}

/// Every slot of the templates on `day`, earliest first.
pub fn slots_on(templates: &[Template], day: Date) -> Vec<Slot> {
    let weekday = i16::from(day.weekday().number_from_monday());
    let mut out: Vec<Slot> = Vec::new();
    for template in templates.iter().filter(|t| t.weekday == weekday) {
        let end = day.with_time(template.ends).assume_offset(taipei());
        let mut at = day.with_time(template.starts).assume_offset(taipei());
        let step = Duration::minutes(i64::from(template.minutes.max(5)));
        while at + step <= end {
            if !out
                .iter()
                .any(|s| s.physician_id == template.physician_id && s.starts_at == at)
            {
                out.push(Slot {
                    physician_id: template.physician_id,
                    starts_at: at.to_offset(UtcOffset::UTC),
                    minutes: template.minutes,
                    department: template.department.clone(),
                    department_en: template.department_en.clone(),
                    mode: template.mode.clone(),
                    room: template.room.clone(),
                });
            }
            at += step;
        }
    }
    out.sort_by_key(|s| (s.starts_at, s.physician_id));
    out
}

pub async fn templates(db: &PgPool) -> sqlx::Result<Vec<Template>> {
    sqlx::query_as("SELECT s.physician_id, s.weekday, s.starts, s.ends, s.minutes, s.department, s.department_en, s.mode, s.room FROM schedule_templates s JOIN accounts a ON a.id = s.physician_id WHERE a.status = 'active' ORDER BY s.weekday, s.starts, s.id")
        .fetch_all(db)
        .await
}

pub async fn slots(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Params>,
) -> AppResult<Json<Page<Value>>> {
    if !user.can(Permission::ApptOwn) {
        user.require(Permission::ApptManage)?;
    }
    let today = state.clock.today();
    let bad_date = |field: &str| AppError::field(field, t(T::FieldErrDate, user.locale));
    let from = match page::param(&params, "from") {
        None => today,
        Some(text) => parse_date(text).ok_or_else(|| bad_date("from"))?,
    }
    .max(today);
    let to = match page::param(&params, "to") {
        None => from.checked_add(Duration::days(7)).unwrap_or(from),
        Some(text) => parse_date(text).ok_or_else(|| bad_date("to"))?,
    }
    .min(
        today
            .checked_add(Duration::days(MAX_DAYS_AHEAD))
            .unwrap_or(today),
    );
    let physician = match page::param(&params, "physician_id") {
        None => None,
        Some(text) => Some(
            Uuid::parse_str(text)
                .map_err(|_| AppError::field("physician_id", t(T::FieldErrChoice, user.locale)))?,
        ),
    };
    let department = page::param(&params, "department");
    let templates = templates(&state.db).await?;
    let mut all: Vec<Slot> = Vec::new();
    let mut day = from;
    while day <= to {
        all.extend(slots_on(&templates, day));
        let Some(next) = day.next_day() else { break };
        day = next;
    }
    let earliest = state.clock.now() + MIN_LEAD;
    all.retain(|s| {
        s.starts_at >= earliest
            && physician.is_none_or(|p| p == s.physician_id)
            && department.is_none_or(|d| d == s.department || d == s.department_en)
    });
    let taken: Vec<(Uuid, OffsetDateTime)> = sqlx::query_as(
        "SELECT physician_id, starts_at FROM appointments WHERE status <> 'cancelled' AND starts_at >= $1",
    )
    .bind(earliest)
    .fetch_all(&state.db)
    .await?;
    all.retain(|s| !taken.contains(&(s.physician_id, s.starts_at)));
    let people = people::load(&state.db, all.iter().map(|s| s.physician_id), user.locale).await?;
    let items = all
        .iter()
        .map(|s| {
            json!({
                "slot_id": s.id(),
                "physician": people.get_or_unknown(Some(s.physician_id), user.locale),
                "department": pick(&s.department, &s.department_en, user.locale),
                "starts_at": crate::visits::rfc3339(s.starts_at),
                "minutes": s.minutes,
                "mode": s.mode,
                "room": s.room,
                "available": true,
            })
        })
        .collect();
    Ok(Json(Page::all(items)))
}

// ---------------------------------------------------------------------------
// Patient handlers
// ---------------------------------------------------------------------------

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Page<Appointment>>> {
    user.require(Permission::ApptOwn)?;
    let rows = for_patient(&state.db, user.id).await?;
    Ok(Json(Page::all(views(&state.db, &rows, user.locale).await?)))
}

#[derive(Deserialize)]
pub struct BookBody {
    slot_id: String,
    reason: Option<String>,
}

pub async fn book(
    State(state): State<AppState>,
    user: CurrentUser,
    key: IdempotencyKey,
    ApiJson(body): ApiJson<BookBody>,
) -> AppResult<Response> {
    user.require(Permission::ApptOwn)?;
    idem::run(&state, user.id, key, "POST /appointments", || async {
        let appointment = book_slot(&state, &user, body).await?;
        let value = serde_json::to_value(appointment).map_err(anyhow::Error::from)?;
        Ok((StatusCode::CREATED, value))
    })
    .await
}

async fn book_slot(state: &AppState, user: &CurrentUser, body: BookBody) -> AppResult<Appointment> {
    let locale = user.locale;
    let bad_slot = || AppError::field("slot_id", t(T::FieldErrSlot, locale));
    let reason = body
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(|r| pii::mask(r).text);
    if reason.as_deref().is_some_and(|r| r.chars().count() > 200) {
        return Err(AppError::field(
            "reason",
            fmt(T::FieldErrLength, locale, &[("min", "0"), ("max", "200")]),
        ));
    }
    let (physician, starts_at) = parse_slot_id(&body.slot_id).ok_or_else(bad_slot)?;
    let now = state.clock.now();
    if starts_at < now + MIN_LEAD || starts_at > now + Duration::days(MAX_DAYS_AHEAD + 1) {
        return Err(bad_slot());
    }
    let day = starts_at.to_offset(taipei()).date();
    let slot = slots_on(&templates(&state.db).await?, day)
        .into_iter()
        .find(|s| s.physician_id == physician && s.starts_at == starts_at)
        .ok_or_else(bad_slot)?;
    let active: i64 = sqlx::query_scalar("SELECT count(*) FROM appointments WHERE patient_id = $1 AND status = 'booked' AND starts_at > now()")
        .bind(user.id)
        .fetch_one(&state.db)
        .await?;
    if active >= MAX_ACTIVE_BOOKINGS {
        return Err(AppError::InvalidState("too many open appointments"));
    }
    let inserted: Result<Uuid, sqlx::Error> = sqlx::query_scalar(
        "INSERT INTO appointments (patient_id, physician_id, department, department_en, starts_at, minutes, mode, reason, room) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
    )
    .bind(user.id)
    .bind(slot.physician_id)
    .bind(&slot.department)
    .bind(&slot.department_en)
    .bind(slot.starts_at)
    .bind(slot.minutes)
    .bind(&slot.mode)
    .bind(reason)
    .bind(&slot.room)
    .fetch_one(&state.db)
    .await;
    let id = match inserted {
        Ok(id) => id,
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => return Err(bad_slot()),
        Err(e) => return Err(e.into()),
    };
    state.hub.to_permission(
        Permission::ApptManage,
        "queue.changed",
        json!({ "name": "schedule" }),
    );
    let rows = by_ids(&state.db, &[id]).await?;
    views(&state.db, &rows, locale)
        .await?
        .into_iter()
        .next()
        .ok_or(AppError::NotFound)
}

/// The patient cancels their own booking; anything that started or ended cannot be cancelled.
pub async fn cancel(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Appointment>> {
    user.require(Permission::ApptOwn)?;
    let id = Uuid::parse_str(&id).map_err(|_| AppError::NotFound)?;
    let own: Option<String> =
        sqlx::query_scalar("SELECT status FROM appointments WHERE id = $1 AND patient_id = $2")
            .bind(id)
            .bind(user.id)
            .fetch_optional(&state.db)
            .await?;
    if own.is_none() {
        return Err(AppError::NotFound);
    }
    let done = sqlx::query("UPDATE appointments SET status = 'cancelled', updated_at = now() WHERE id = $1 AND patient_id = $2 AND status = 'booked' AND starts_at > $3")
        .bind(id)
        .bind(user.id)
        .bind(state.clock.now())
        .execute(&state.db)
        .await?
        .rows_affected();
    if done == 0 {
        return Err(AppError::InvalidState(
            "only a booked appointment that has not started can be cancelled",
        ));
    }
    // The pre-visit stays with the patient; it is just no longer tied to a slot.
    sqlx::query("UPDATE visits SET appointment_id = NULL WHERE appointment_id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    state.hub.to_permission(
        Permission::ApptManage,
        "queue.changed",
        json!({ "name": "schedule" }),
    );
    let rows = by_ids(&state.db, &[id]).await?;
    views(&state.db, &rows, user.locale)
        .await?
        .into_iter()
        .next()
        .map(Json)
        .ok_or(AppError::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::{date, datetime, time};

    fn template(weekday: i16, starts: Time, ends: Time) -> Template {
        Template {
            physician_id: Uuid::nil(),
            weekday,
            starts,
            ends,
            minutes: 15,
            department: "家庭醫學科".into(),
            department_en: "Family medicine".into(),
            mode: "in_person".into(),
            room: None,
        }
    }

    #[test]
    fn slots_follow_the_template_in_taipei_time() {
        // 2026-11-25 is a Wednesday.
        let templates = [
            template(3, time!(09:00), time!(09:40)),
            template(4, time!(14:00), time!(15:00)),
        ];
        let slots = slots_on(&templates, date!(2026 - 11 - 25));
        assert_eq!(slots.len(), 2, "the last 10 minutes do not fit a slot");
        assert_eq!(slots[0].starts_at, datetime!(2026-11-25 01:00 UTC));
        assert_eq!(slots[1].starts_at, datetime!(2026-11-25 01:15 UTC));
        assert_eq!(slots_on(&templates, date!(2026 - 11 - 26)).len(), 4);
        assert!(slots_on(&templates, date!(2026 - 11 - 28)).is_empty());
    }

    #[test]
    fn overlapping_templates_give_one_slot_per_start() {
        let templates = [
            template(3, time!(09:00), time!(09:30)),
            template(3, time!(09:15), time!(09:45)),
        ];
        let slots = slots_on(&templates, date!(2026 - 11 - 25));
        assert_eq!(slots.len(), 3);
    }

    #[test]
    fn slot_ids_round_trip() {
        let physician = Uuid::new_v4();
        let at = datetime!(2026-11-25 01:00 UTC);
        assert_eq!(
            parse_slot_id(&slot_id(physician, at)),
            Some((physician, at))
        );
        assert!(parse_slot_id("nope").is_none());
    }
}
