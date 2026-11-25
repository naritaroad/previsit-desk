//! The staff site (contract §5): overview, worklist, patients, internal notes, contact, schedule and tickets.
//! Every handler names its permission. A read of one patient's record is written to `access_log` under that patient; a
//! list is one entry without a patient.

use std::collections::{BTreeMap, HashSet};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::appts::{self, ApptRow};
use crate::audit::{self, AuditKind};
use crate::auth::CurrentUser;
use crate::clock::{format_date, parse_date};
use crate::error::{AppError, AppResult};
use crate::http::{ApiJson, OptionalJson};
use crate::idem::{self, IdempotencyKey};
use crate::measure;
use crate::page::{self, Cursor, Page, Params};
use crate::people::{self, People, PersonRef};
use crate::perm::{Permission, Role};
use crate::profile::{self, HealthProfile};
use crate::rxq;
use crate::state::AppState;
use crate::texts::{self, T, fmt, t};
use crate::tickets::{self, ResolveError};
use crate::types::{Locale, Ticket, Urgency, Visit, VisitMode, VisitStatus, message_kind};
use crate::visit_routes::{parse_id, send_staff_message};
use crate::visits::{self, NewVisit, VisitView, visit_cols, visits_with_urgency};

/// How far back the "done" bucket and the activity list look.
const DONE_DAYS: i64 = 14;

// ---------------------------------------------------------------------------
// Worklist
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct WorkItem {
    r#type: &'static str,
    id: Uuid,
    patient: PersonRef,
    title: String,
    subtitle: String,
    urgency: Urgency,
    status: String,
    assigned_to: Option<PersonRef>,
    #[serde(with = "time::serde::rfc3339::option")]
    due_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339")]
    updated_at: OffsetDateTime,
    link: String,
    #[serde(skip)]
    buckets: Vec<Bucket>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Bucket {
    Urgent,
    Pending,
    Mine,
    Waiting,
    Done,
}

impl Bucket {
    const ALL: [(&'static str, Bucket); 5] = [
        ("urgent", Bucket::Urgent),
        ("pending", Bucket::Pending),
        ("mine", Bucket::Mine),
        ("waiting", Bucket::Waiting),
        ("done", Bucket::Done),
    ];
}

fn visit_bucket(status: VisitStatus, mode: VisitMode, staff_spoke_last: bool) -> Option<Bucket> {
    match status {
        VisitStatus::RedFlag => Some(Bucket::Urgent),
        VisitStatus::Reviewed => Some(Bucket::Done),
        _ if mode == VisitMode::Human && staff_spoke_last => Some(Bucket::Waiting),
        _ if mode == VisitMode::Human => Some(Bucket::Pending),
        VisitStatus::Submitted => Some(Bucket::Pending),
        VisitStatus::Active => None,
    }
}

fn rx_bucket(status: &str, priority: &str) -> Option<Bucket> {
    match status {
        "submitted" | "in_review" if priority == "urgent" => Some(Bucket::Urgent),
        "submitted" | "in_review" => Some(Bucket::Pending),
        "more_info" => Some(Bucket::Waiting),
        "draft" | "cancelled" => None,
        _ => Some(Bucket::Done),
    }
}

fn ticket_bucket(status: &str, urgency: Urgency) -> Bucket {
    match (status, urgency) {
        ("resolved", _) => Bucket::Done,
        (_, Urgency::Urgent) => Bucket::Urgent,
        _ => Bucket::Pending,
    }
}

fn urgency_rank(u: Urgency) -> u8 {
    match u {
        Urgency::Urgent => 0,
        Urgency::Soon => 1,
        Urgency::Routine => 2,
    }
}

fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().next().unwrap_or("");
    let mut out: String = line.chars().take(max).collect();
    if line.chars().count() > max {
        out.push('…');
    }
    out
}

/// Every open or recently finished thing a clinician may act on, with the buckets it belongs to.
async fn work_items(state: &AppState, user: &CurrentUser) -> AppResult<Vec<WorkItem>> {
    let db = &state.db;
    let locale = user.locale;
    let since = state.clock.now() - Duration::days(DONE_DAYS);
    let mut items = Vec::new();

    let rows: Vec<Visit> = sqlx::query_as(concat!(
        "SELECT ",
        visit_cols!(),
        " FROM ",
        visits_with_urgency!(),
        " v WHERE v.patient_id IS NOT NULL AND (v.status IN ('submitted', 'red_flag') OR v.mode = 'human' OR v.assigned_to = $1 OR (v.status = 'reviewed' AND v.reviewed_at > $2))
         ORDER BY v.last_activity_at DESC LIMIT 500"
    ))
    .bind(user.id)
    .bind(since)
    .fetch_all(db)
    .await?;
    let ids: Vec<Uuid> = rows.iter().map(|v| v.id).collect();
    let staff_last: Vec<Uuid> = sqlx::query_scalar(
        "SELECT visit_id FROM (SELECT DISTINCT ON (visit_id) visit_id, role FROM messages WHERE visit_id = ANY($1) AND kind = 'chat' ORDER BY visit_id, created_at DESC, id DESC) t WHERE role = 'staff'",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let flags: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT DISTINCT ON (visit_id) visit_id, rule_id FROM red_flag_events WHERE visit_id = ANY($1) ORDER BY visit_id, created_at DESC, id DESC",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let mut flagged_visits: HashSet<Uuid> = HashSet::new();
    for view in visits::views(db, rows, Some(user), locale).await? {
        let mut buckets: Vec<Bucket> =
            visit_bucket(view.status, view.mode, staff_last.contains(&view.id))
                .into_iter()
                .collect();
        let open = view.status != VisitStatus::Reviewed;
        if open && view.assigned_to.as_ref().is_some_and(|p| p.id == user.id) {
            buckets.push(Bucket::Mine);
        }
        if view.status == VisitStatus::RedFlag {
            flagged_visits.insert(view.id);
        }
        let subtitle = flags
            .iter()
            .find(|(id, _)| *id == view.id && view.status == VisitStatus::RedFlag)
            .and_then(|(_, rule)| state.rules.red_flags.label_for(rule, locale))
            .map(str::to_string)
            .or_else(|| view.chief_complaint.clone())
            .unwrap_or_default();
        items.push(WorkItem {
            r#type: "visit",
            id: view.id,
            patient: view.patient,
            title: view.title,
            subtitle: first_line(&subtitle, 60),
            urgency: if view.status == VisitStatus::RedFlag {
                Urgency::Urgent
            } else {
                view.urgency
            },
            status: view.status.as_str().into(),
            assigned_to: view.assigned_to,
            due_at: view.appointment.map(|a| a.starts_at),
            updated_at: view.last_activity_at,
            link: format!("/clinic/visits/{}", view.id),
            buckets,
        });
    }

    let briefs = rxq::recent(db, user, DONE_DAYS as i32, state.clock.now()).await?;
    let mut urgent_requests: HashSet<Uuid> = HashSet::new();
    for brief in briefs {
        // Refills are the pharmacy's queue unless someone asked the physician.
        if brief.kind == "refill" && !matches!(brief.status.as_str(), "in_review" | "more_info") {
            continue;
        }
        let mut buckets: Vec<Bucket> = rx_bucket(&brief.status, &brief.priority)
            .into_iter()
            .collect();
        if buckets.contains(&Bucket::Urgent) {
            urgent_requests.insert(brief.id);
        }
        let open = buckets.first().is_some_and(|b| *b != Bucket::Done);
        if open && brief.assigned_to.as_ref().is_some_and(|p| p.id == user.id) {
            buckets.push(Bucket::Mine);
        }
        items.push(WorkItem {
            r#type: "rx",
            id: brief.id,
            title: format!("{} {}", texts::rx_kind_label(&brief.kind, locale), brief.no),
            subtitle: brief
                .drug_names
                .join(if locale.is_en() { ", " } else { "、" }),
            urgency: Urgency::parse(&brief.priority).unwrap_or(Urgency::Routine),
            status: if brief.overdue {
                "overdue".into()
            } else {
                brief.status.clone()
            },
            patient: brief.patient,
            assigned_to: brief.assigned_to,
            due_at: brief.sla_due_at,
            updated_at: brief.updated_at,
            link: format!("/clinic/rx/{}", brief.id),
            buckets,
        });
    }

    for ticket in ticket_rows(db, "all", Some(since), locale).await? {
        // The urgent ticket of a flagged visit or an urgent request is the same job as the visit or request itself.
        if ticket.reason == "red_flag"
            && (ticket
                .visit_id
                .is_some_and(|id| flagged_visits.contains(&id))
                || ticket
                    .rx_request_id
                    .is_some_and(|id| urgent_requests.contains(&id)))
        {
            continue;
        }
        if ticket.patient_id.is_none() {
            continue;
        }
        items.push(WorkItem {
            r#type: "ticket",
            id: ticket.id,
            title: format!(
                "{} {}",
                texts::ticket_reason_label(&ticket.reason, locale),
                ticket.ticket_no
            ),
            subtitle: first_line(&ticket.summary, 60),
            urgency: ticket.urgency,
            status: ticket.status.clone(),
            assigned_to: None,
            due_at: None,
            updated_at: ticket.resolved_at.unwrap_or(ticket.created_at),
            link: tickets::link(&ticket),
            buckets: vec![ticket_bucket(&ticket.status, ticket.urgency)],
            patient: ticket
                .patient
                .unwrap_or_else(|| people::unknown_patient(locale)),
        });
    }
    Ok(items)
}

fn bucket_counts(items: &[WorkItem]) -> BTreeMap<&'static str, usize> {
    Bucket::ALL
        .iter()
        .map(|(name, bucket)| {
            (
                *name,
                items.iter().filter(|i| i.buckets.contains(bucket)).count(),
            )
        })
        .collect()
}

pub async fn worklist(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Params>,
) -> AppResult<Json<Value>> {
    user.require(Permission::VisitRead)?;
    audit::log_access(&state.db, &user, None, "list", "worklist", "").await?;
    let bucket = match page::param(&params, "bucket") {
        None => None,
        Some(name) => Some(
            Bucket::ALL
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, b)| *b)
                .ok_or_else(|| AppError::field("bucket", t(T::FieldErrChoice, user.locale)))?,
        ),
    };
    let items = work_items(&state, &user).await?;
    let counts = bucket_counts(&items);
    let q = page::param(&params, "q").map(str::to_lowercase);
    let mut items: Vec<WorkItem> = items
        .into_iter()
        .filter(|i| match bucket {
            Some(b) => i.buckets.contains(&b),
            // Without a bucket: everything that is not finished.
            None => i.buckets.iter().any(|b| *b != Bucket::Done),
        })
        .filter(|i| {
            q.as_deref().is_none_or(|q| {
                [&i.patient.display_name, &i.title, &i.subtitle]
                    .iter()
                    .any(|text| text.to_lowercase().contains(q))
            })
        })
        .collect();
    let far = OffsetDateTime::UNIX_EPOCH + Duration::days(200 * 365);
    match page::param(&params, "sort").unwrap_or("urgency") {
        "updated" => items.sort_by_key(|i| std::cmp::Reverse(i.updated_at)),
        "due" => items.sort_by_key(|i| (i.due_at.unwrap_or(far), urgency_rank(i.urgency))),
        "urgency" if bucket == Some(Bucket::Done) => {
            items.sort_by_key(|i| std::cmp::Reverse(i.updated_at))
        }
        "urgency" => items.sort_by_key(|i| {
            (
                urgency_rank(i.urgency),
                i.due_at.unwrap_or(far),
                std::cmp::Reverse(i.updated_at),
            )
        }),
        _ => return Err(AppError::field("sort", t(T::FieldErrChoice, user.locale))),
    }
    items.truncate(page::limit_or(&params, 100, 200)? as usize);
    Ok(Json(
        json!({ "items": items, "next_cursor": null, "counts": counts }),
    ))
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/// Pre-visit state of an appointment for the schedule: `none` until the patient starts one.
async fn previsit_states(
    db: &PgPool,
    rows: &[ApptRow],
) -> sqlx::Result<BTreeMap<Uuid, (Uuid, String)>> {
    let ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
    let pairs: Vec<(Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT appointment_id, id, status FROM visits WHERE appointment_id = ANY($1)",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    Ok(pairs
        .into_iter()
        .map(|(appointment, visit, status)| (appointment, (visit, status)))
        .collect())
}

async fn appointment_rows(
    state: &AppState,
    rows: &[ApptRow],
    locale: Locale,
) -> AppResult<Vec<Value>> {
    let previsit = previsit_states(&state.db, rows).await?;
    let people = people::load(
        &state.db,
        rows.iter().flat_map(|r| [r.patient_id, r.physician_id]),
        locale,
    )
    .await?;
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "appointment": r.view(&people, locale),
                "patient": people.get_or_unknown(Some(r.patient_id), locale),
                "previsit": previsit.get(&r.id).map_or("none", |(_, s)| s.as_str()),
            })
        })
        .collect())
}

pub async fn overview(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require(Permission::VisitRead)?;
    audit::log_access(&state.db, &user, None, "list", "overview", "").await?;
    let items = work_items(&state, &user).await?;
    let open = |kind: &str, bucket: Bucket| {
        items
            .iter()
            .filter(|i| i.r#type == kind && i.buckets.contains(&bucket))
            .count()
    };
    let counts = json!({
        "urgent": items.iter().filter(|i| i.buckets.contains(&Bucket::Urgent)).count(),
        "pending": open("visit", Bucket::Pending),
        "rx_review": open("rx", Bucket::Pending) + open("rx", Bucket::Urgent),
        "overdue": items.iter().filter(|i| i.status == "overdue").count(),
        "waiting_patient": items.iter().filter(|i| i.buckets.contains(&Bucket::Waiting)).count(),
        "tickets": open("ticket", Bucket::Pending) + open("ticket", Bucket::Urgent),
    });
    let today = appts::on_day(&state.db, state.clock.today()).await?;
    Ok(Json(json!({
        "counts": counts,
        "today": appointment_rows(&state, &today, user.locale).await?,
        "activity": activity(&state, user.locale).await?,
    })))
}

/// The latest things that happened, newest first: no message text, only who and what.
async fn activity(state: &AppState, locale: Locale) -> AppResult<Vec<Value>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        at: OffsetDateTime,
        kind: String,
        actor_id: Option<Uuid>,
        patient_id: Option<Uuid>,
        ref_id: Option<Uuid>,
        extra: Option<String>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT * FROM (
            (SELECT submitted_at AS at, 'visit.submitted' AS kind, NULL::uuid AS actor_id, patient_id, id AS ref_id, NULL::text AS extra FROM visits WHERE submitted_at IS NOT NULL AND patient_id IS NOT NULL ORDER BY submitted_at DESC LIMIT 15)
            UNION ALL
            (SELECT n.signed_at, 'note.signed', n.signed_by, v.patient_id, v.id, NULL FROM clinical_notes n JOIN visits v ON v.id = n.visit_id WHERE n.signed_at IS NOT NULL ORDER BY n.signed_at DESC LIMIT 15)
            UNION ALL
            (SELECT e.created_at, 'red_flag', NULL, v.patient_id, v.id, e.rule_id FROM red_flag_events e JOIN visits v ON v.id = e.visit_id WHERE v.patient_id IS NOT NULL ORDER BY e.created_at DESC LIMIT 15)
            UNION ALL
            (SELECT e.at, 'rx', e.actor_id, r.patient_id, r.id, e.to_status FROM rx_events e JOIN rx_requests r ON r.id = e.request_id WHERE e.to_status IS NOT NULL AND e.to_status <> 'draft' ORDER BY e.at DESC LIMIT 15)
            UNION ALL
            (SELECT created_at, 'contact', author_id, patient_id, patient_id, channel FROM contact_log ORDER BY created_at DESC LIMIT 15)
         ) a ORDER BY at DESC LIMIT 15",
    )
    .fetch_all(&state.db)
    .await?;
    let people = people::load(
        &state.db,
        rows.iter()
            .flat_map(|r| [r.actor_id, r.patient_id].into_iter().flatten()),
        locale,
    )
    .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let patient = people.get_or_unknown(r.patient_id, locale).display_name;
            let actor = people
                .get(r.actor_id)
                .map(|p| p.display_name)
                .unwrap_or_else(|| patient.clone());
            let extra = r.extra.as_deref().unwrap_or("");
            let text = match r.kind.as_str() {
                "visit.submitted" => fmt(T::ActSubmitted, locale, &[("patient", &patient)]),
                "note.signed" => fmt(
                    T::ActSigned,
                    locale,
                    &[("actor", &actor), ("patient", &patient)],
                ),
                "red_flag" => fmt(
                    T::ActRedFlag,
                    locale,
                    &[
                        ("patient", &patient),
                        (
                            "label",
                            state.rules.red_flags.label_for(extra, locale).unwrap_or(""),
                        ),
                    ],
                ),
                "rx" => fmt(
                    T::ActRx,
                    locale,
                    &[
                        ("patient", &patient),
                        ("status", texts::rx_status_label(extra, locale)),
                    ],
                ),
                _ => fmt(
                    T::ActContact,
                    locale,
                    &[("actor", &actor), ("patient", &patient)],
                ),
            };
            let id = r.ref_id.unwrap_or_default();
            let link = match r.kind.as_str() {
                "rx" => format!("/clinic/rx/{id}"),
                "contact" => format!("/clinic/patients/{id}"),
                _ => format!("/clinic/visits/{id}"),
            };
            json!({ "at": visits::rfc3339(r.at), "text": text, "link": link })
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct PatientRow {
    patient: PersonRef,
    age: Option<i32>,
    sex: Option<String>,
    conditions: Vec<String>,
    tags: Vec<String>,
    care_status: String,
    physician: Option<PersonRef>,
    coordinator: Option<PersonRef>,
    #[serde(with = "time::serde::rfc3339::option")]
    last_contact_at: Option<OffsetDateTime>,
    open_items: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    next_appointment_at: Option<OffsetDateTime>,
    flags: Vec<&'static str>,
}

#[derive(sqlx::FromRow)]
struct PatientDbRow {
    id: Uuid,
    sort_at: OffsetDateTime,
    birth_year: Option<i32>,
    sex: Option<String>,
    conditions: Value,
    tags: Vec<String>,
    care_status: String,
    physician_id: Option<Uuid>,
    coordinator_id: Option<Uuid>,
    last_contact_at: Option<OffsetDateTime>,
    open_items: i64,
    next_appointment_at: Option<OffsetDateTime>,
    has_red_flag: bool,
    rx_overdue: bool,
    has_open_ticket: bool,
}

/// One row per patient. `$1` one patient or NULL; guests appear once they have done something.
macro_rules! patient_rows {
    ($rest:literal) => {
        concat!(
            "SELECT * FROM (SELECT a.id, a.display_name, a.display_name_en, GREATEST(a.created_at, c.last_contact_at, (SELECT max(v.last_activity_at) FROM visits v WHERE v.patient_id = a.id), (SELECT max(r.updated_at) FROM rx_requests r WHERE r.patient_id = a.id)) AS sort_at,
                p.birth_year, p.sex, COALESCE(p.conditions, '[]'::jsonb) AS conditions, COALESCE(c.tags, '{}') AS tags, COALESCE(c.care_status, 'new') AS care_status,
                c.physician_id, c.coordinator_id, c.last_contact_at,
                (SELECT count(*) FROM visits v WHERE v.patient_id = a.id AND v.status IN ('submitted', 'red_flag'))
                  + (SELECT count(*) FROM rx_requests r WHERE r.patient_id = a.id AND r.status IN ('submitted', 'in_review', 'more_info', 'at_pharmacy', 'returned'))
                  + (SELECT count(*) FROM clinician_tickets t WHERE t.patient_id = a.id AND t.status = 'open' AND t.reason <> 'red_flag') AS open_items,
                (SELECT min(x.starts_at) FROM appointments x WHERE x.patient_id = a.id AND x.status IN ('booked', 'checked_in') AND x.starts_at > now() - interval '30 minutes') AS next_appointment_at,
                EXISTS (SELECT 1 FROM visits v WHERE v.patient_id = a.id AND v.status = 'red_flag') AS has_red_flag,
                EXISTS (SELECT 1 FROM rx_requests r WHERE r.patient_id = a.id AND r.status IN ('submitted', 'in_review') AND r.sla_due_at < now()) AS rx_overdue,
                EXISTS (SELECT 1 FROM clinician_tickets t WHERE t.patient_id = a.id AND t.status = 'open') AS has_open_ticket
              FROM accounts a LEFT JOIN patient_profiles p ON p.account_id = a.id LEFT JOIN patient_care c ON c.account_id = a.id
              WHERE a.role = 'patient' AND a.status = 'active' AND (a.expires_at IS NULL OR a.expires_at > now())
                AND ($1::uuid IS NULL OR a.id = $1)
                AND ($1::uuid IS NOT NULL OR NOT a.is_guest OR EXISTS (SELECT 1 FROM visits v WHERE v.patient_id = a.id) OR EXISTS (SELECT 1 FROM rx_requests r WHERE r.patient_id = a.id AND r.status <> 'draft') OR EXISTS (SELECT 1 FROM appointments x WHERE x.patient_id = a.id))
            ) q WHERE ",
            $rest
        )
    };
}

fn row_view(
    row: PatientDbRow,
    people: &People,
    limited: bool,
    today_year: i32,
    locale: Locale,
) -> PatientRow {
    let mut flags = Vec::new();
    if row.has_red_flag {
        flags.push("red_flag");
    }
    if row.rx_overdue {
        flags.push("rx_overdue");
    }
    if row.has_open_ticket {
        flags.push("open_ticket");
    }
    let conditions = row
        .conditions
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|i| i["status"] != "inactive")
                .filter_map(|i| i["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let mut out = PatientRow {
        patient: people.get_or_unknown(Some(row.id), locale),
        age: row.birth_year.map(|y| today_year - y),
        sex: row.sex,
        conditions,
        tags: row.tags,
        care_status: row.care_status,
        physician: people.get(row.physician_id),
        coordinator: people.get(row.coordinator_id),
        last_contact_at: row.last_contact_at,
        open_items: row.open_items,
        next_appointment_at: row.next_appointment_at,
        flags,
    };
    if limited {
        // A pharmacist sees who the patient is, not what the clinic keeps about them.
        out.conditions.clear();
        out.tags.clear();
        out.flags.clear();
        out.care_status = "active".into();
        out.physician = None;
        out.coordinator = None;
        out.last_contact_at = None;
        out.next_appointment_at = None;
        out.open_items = 0;
    }
    out
}

/// Holds patient.read but not visit.read: the medicines-and-allergies view.
fn limited_view(user: &CurrentUser) -> bool {
    !user.can(Permission::VisitRead)
}

async fn patient_people(
    db: &PgPool,
    rows: &[PatientDbRow],
    locale: Locale,
) -> sqlx::Result<People> {
    people::load(
        db,
        rows.iter().flat_map(|r| {
            [Some(r.id), r.physician_id, r.coordinator_id]
                .into_iter()
                .flatten()
        }),
        locale,
    )
    .await
}

const CARE_STATUSES: [&str; 4] = ["new", "active", "watch", "inactive"];

pub async fn patients(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Params>,
) -> AppResult<Json<Page<PatientRow>>> {
    user.require(Permission::PatientRead)?;
    audit::log_access(&state.db, &user, None, "list", "patients", "").await?;
    let limited = limited_view(&user);
    let limit = page::limit(&params)?;
    let cursor = page::cursor(&params)?;
    let status = page::param(&params, "status");
    if status.is_some_and(|s| !CARE_STATUSES.contains(&s)) {
        return Err(AppError::field("status", t(T::FieldErrChoice, user.locale)));
    }
    let assigned = match page::param(&params, "assigned") {
        None => None,
        Some("me") => Some(user.id),
        Some(text) => Some(parse_id(text)?),
    };
    // A pharmacist's list is the people with something to dispense, and has no filters on clinic data.
    let rows: Vec<PatientDbRow> = sqlx::query_as(patient_rows!(
        "($2::text IS NULL OR q.display_name ILIKE $2 ESCAPE '\\' OR q.display_name_en ILIKE $2 ESCAPE '\\')
           AND ($3::text IS NULL OR $3 = ANY(q.tags)) AND ($4::text IS NULL OR q.care_status = $4)
           AND ($5::uuid IS NULL OR q.physician_id = $5 OR q.coordinator_id = $5)
           AND ($6::timestamptz IS NULL OR (q.sort_at, q.id) < ($6, $7))
           AND (NOT $9 OR EXISTS (SELECT 1 FROM rx_requests r WHERE r.patient_id = q.id AND r.status <> 'draft') OR EXISTS (SELECT 1 FROM prescriptions x WHERE x.patient_id = q.id AND x.active))
         ORDER BY q.sort_at DESC, q.id DESC LIMIT $8"
    ))
    .bind(None::<Uuid>)
    .bind(page::like(&params))
    .bind(page::param(&params, "tag").filter(|_| !limited))
    .bind(status.filter(|_| !limited))
    .bind(assigned.filter(|_| !limited))
    .bind(cursor.map(|c| c.at))
    .bind(cursor.map(|c| c.id))
    .bind(limit + 1)
    .bind(limited)
    .fetch_all(&state.db)
    .await?;
    let cut = page::cut(rows, limit, |r| Cursor {
        at: r.sort_at,
        id: r.id,
    });
    let people = patient_people(&state.db, &cut.items, user.locale).await?;
    let year = state.clock.today().year();
    Ok(Json(Page {
        items: cut
            .items
            .into_iter()
            .map(|r| row_view(r, &people, limited, year, user.locale))
            .collect(),
        next_cursor: cut.next_cursor,
        total: None,
    }))
}

async fn patient_row(state: &AppState, user: &CurrentUser, id: Uuid) -> AppResult<PatientRow> {
    let rows: Vec<PatientDbRow> = sqlx::query_as(patient_rows!("true"))
        .bind(Some(id))
        .fetch_all(&state.db)
        .await?;
    let people = patient_people(&state.db, &rows, user.locale).await?;
    let year = state.clock.today().year();
    rows.into_iter()
        .next()
        .map(|r| row_view(r, &people, limited_view(user), year, user.locale))
        .ok_or(AppError::NotFound)
}

#[derive(Debug, Serialize)]
pub struct StaffNote {
    id: Uuid,
    author: PersonRef,
    body: String,
    pinned: bool,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

#[derive(sqlx::FromRow)]
struct StaffNoteRow {
    id: Uuid,
    author_id: Option<Uuid>,
    body: String,
    pinned: bool,
    created_at: OffsetDateTime,
}

async fn note_views(
    db: &PgPool,
    rows: Vec<StaffNoteRow>,
    locale: Locale,
) -> sqlx::Result<Vec<StaffNote>> {
    let people = people::load(db, rows.iter().filter_map(|r| r.author_id), locale).await?;
    Ok(rows
        .into_iter()
        .map(|r| StaffNote {
            author: people.get(r.author_id).unwrap_or_else(|| {
                crate::patient::past_person(
                    r.author_id,
                    t(T::SomeoneLabel, locale),
                    Role::Coordinator.as_str(),
                )
            }),
            id: r.id,
            body: r.body,
            pinned: r.pinned,
            created_at: r.created_at,
        })
        .collect())
}

/// A pharmacist's copy of the record: allergies and medicines, nothing else.
fn pharmacist_profile(profile: HealthProfile) -> HealthProfile {
    HealthProfile {
        conditions: Vec::new(),
        family_history: Vec::new(),
        lifestyle: Default::default(),
        height_cm: None,
        ..profile
    }
}

#[derive(Serialize)]
pub struct PatientDetail {
    row: PatientRow,
    profile: Option<HealthProfile>,
    medications: Vec<Value>,
    measurements: Vec<measure::Measurement>,
    visits: Vec<VisitView>,
    rx: Vec<Value>,
    appointments: Vec<appts::Appointment>,
    tickets: Vec<Ticket>,
    notes: Vec<StaffNote>,
    timeline: Vec<Value>,
}

pub async fn patient(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<PatientDetail>> {
    user.require(Permission::PatientRead)?;
    let id = parse_id(&id)?;
    let locale = user.locale;
    let limited = limited_view(&user);
    let row = patient_row(&state, &user, id).await?;
    audit::log_access(
        &state.db,
        &user,
        Some(id),
        "read",
        if limited { "medications" } else { "patient" },
        &id.to_string(),
    )
    .await?;
    let profile = profile::load(&state.db, id, locale).await?;
    let medications = crate::rx::medications_for(&state, id, locale).await?;
    let rx = crate::rx::briefs_for(&state, id, &user, false).await?;
    if limited {
        return Ok(Json(PatientDetail {
            row,
            profile: profile.map(pharmacist_profile),
            medications,
            measurements: Vec::new(),
            visits: Vec::new(),
            rx,
            appointments: Vec::new(),
            tickets: Vec::new(),
            notes: Vec::new(),
            timeline: Vec::new(),
        }));
    }
    let visit_rows: Vec<Visit> = sqlx::query_as(concat!(
        "SELECT ",
        visit_cols!(),
        " FROM ",
        visits_with_urgency!(),
        " v WHERE v.patient_id = $1 ORDER BY v.last_activity_at DESC, v.id DESC LIMIT 100"
    ))
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let visit_views = visits::views(&state.db, visit_rows, Some(&user), locale).await?;
    let appointment_rows = appts::for_patient(&state.db, id).await?;
    let appointments = appts::views(&state.db, &appointment_rows, locale).await?;
    let mut ticket_list: Vec<Ticket> = tickets::for_patient(&state.db, id).await?;
    tickets::fill_patients(&state.db, &mut ticket_list, locale).await?;
    let note_rows: Vec<StaffNoteRow> = sqlx::query_as("SELECT id, author_id, body, pinned, created_at FROM staff_notes WHERE patient_id = $1 ORDER BY pinned DESC, created_at DESC, id DESC LIMIT 200")
        .bind(id)
        .fetch_all(&state.db)
        .await?;
    let notes = note_views(&state.db, note_rows, locale).await?;
    let timeline = timeline(&state, &user, id, &visit_views, &appointments, &ticket_list).await?;
    Ok(Json(PatientDetail {
        row,
        profile,
        medications,
        measurements: measure::for_patient(&state.db, id, None, None, 200).await?,
        visits: visit_views,
        rx,
        appointments,
        tickets: ticket_list,
        notes,
        timeline,
    }))
}

/// Everything that happened with one patient, newest first.
async fn timeline(
    state: &AppState,
    user: &CurrentUser,
    id: Uuid,
    visit_views: &[VisitView],
    appointments: &[appts::Appointment],
    ticket_list: &[Ticket],
) -> AppResult<Vec<Value>> {
    struct Entry {
        at: OffsetDateTime,
        kind: &'static str,
        title: String,
        link: Option<String>,
        actor: Option<PersonRef>,
    }
    let locale = user.locale;
    let mut entries: Vec<Entry> = Vec::new();
    for v in visit_views {
        let link = Some(format!("/clinic/visits/{}", v.id));
        entries.push(Entry {
            at: v.created_at,
            kind: "visit.created",
            title: fmt(T::TlVisitCreated, locale, &[("title", &v.title)]),
            link: link.clone(),
            actor: Some(v.patient.clone()),
        });
        if let Some(at) = v.submitted_at {
            entries.push(Entry {
                at,
                kind: "visit.submitted",
                title: fmt(T::TlVisitSubmitted, locale, &[("title", &v.title)]),
                link: link.clone(),
                actor: Some(v.patient.clone()),
            });
        }
        if let Some(at) = v.reviewed_at {
            entries.push(Entry {
                at,
                kind: "visit.reviewed",
                title: fmt(T::TlVisitReviewed, locale, &[("title", &v.title)]),
                link,
                actor: v.reviewed_by.clone(),
            });
        }
    }
    for a in appointments {
        entries.push(Entry {
            at: a.starts_at,
            kind: "appointment",
            title: fmt(
                T::TlAppointment,
                locale,
                &[
                    ("department", &a.department),
                    ("status", texts::appt_status_label(&a.status, locale)),
                ],
            ),
            link: None,
            actor: Some(a.physician.clone()),
        });
    }
    for ticket in ticket_list {
        entries.push(Entry {
            at: ticket.created_at,
            kind: "ticket",
            title: fmt(
                T::TlTicket,
                locale,
                &[
                    ("no", &ticket.ticket_no),
                    ("reason", texts::ticket_reason_label(&ticket.reason, locale)),
                ],
            ),
            link: Some(tickets::link(ticket)),
            actor: None,
        });
    }
    type RxEvent = (
        OffsetDateTime,
        Option<Uuid>,
        Uuid,
        String,
        String,
        Option<String>,
    );
    let rx: Vec<RxEvent> = sqlx::query_as(
        "SELECT e.at, e.actor_id, r.id, r.no, r.kind, e.to_status FROM rx_events e JOIN rx_requests r ON r.id = e.request_id
         WHERE r.patient_id = $1 AND e.to_status IS NOT NULL AND e.to_status <> 'draft' ORDER BY e.at DESC LIMIT 100",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let contacts: Vec<(OffsetDateTime, Option<Uuid>, String, String)> = sqlx::query_as(
        "SELECT created_at, author_id, channel, body FROM contact_log WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 100",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let people = people::load(
        &state.db,
        rx.iter()
            .filter_map(|r| r.1)
            .chain(contacts.iter().filter_map(|c| c.1)),
        locale,
    )
    .await?;
    for (at, actor, request, no, kind, status) in rx {
        entries.push(Entry {
            at,
            kind: "rx",
            title: fmt(
                T::TlRx,
                locale,
                &[
                    ("kind", texts::rx_kind_label(&kind, locale)),
                    ("no", &no),
                    (
                        "status",
                        texts::rx_status_label(status.as_deref().unwrap_or(""), locale),
                    ),
                ],
            ),
            link: Some(format!("/clinic/rx/{request}")),
            actor: people.get(actor),
        });
    }
    for (at, author, channel, body) in contacts {
        entries.push(Entry {
            at,
            kind: "contact",
            title: fmt(
                if channel == "phone_note" {
                    T::TlPhone
                } else {
                    T::TlMessage
                },
                locale,
                &[("text", &first_line(&body, 40))],
            ),
            link: None,
            actor: people.get(author),
        });
    }
    entries.sort_by_key(|e| std::cmp::Reverse(e.at));
    entries.truncate(200);
    Ok(entries
        .into_iter()
        .map(|e| {
            json!({ "at": visits::rfc3339(e.at), "kind": e.kind, "title": e.title, "link": e.link, "actor": e.actor })
        })
        .collect())
}

async fn must_be_patient(state: &AppState, id: Uuid) -> AppResult<()> {
    let ok: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM accounts WHERE id = $1 AND role = 'patient' AND (expires_at IS NULL OR expires_at > now()))")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    if ok { Ok(()) } else { Err(AppError::NotFound) }
}

/// `patient.manage`, the patient exists, and the change is on record.
async fn manage(state: &AppState, user: &CurrentUser, id: &str, action: &str) -> AppResult<Uuid> {
    user.require(Permission::PatientManage)?;
    let id = parse_id(id)?;
    must_be_patient(state, id).await?;
    audit::log_access(
        &state.db,
        user,
        Some(id),
        action,
        "patient",
        &id.to_string(),
    )
    .await?;
    Ok(id)
}

pub async fn patch_patient(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Value>,
) -> AppResult<Json<PatientRow>> {
    let locale = user.locale;
    let choice = || t(T::FieldErrChoice, locale);
    let id = manage(&state, &user, &id, "update").await?;
    let Some(map) = body.as_object() else {
        return Err(AppError::BadRequest("an object is required".into()));
    };
    let tags: Option<Vec<String>> = match map.get("tags") {
        None => None,
        Some(value) => {
            let items: Vec<String> = serde_json::from_value(value.clone())
                .map_err(|_| AppError::field("tags", choice()))?;
            let mut tags: Vec<String> = Vec::new();
            for tag in items {
                let tag = tag.trim().to_string();
                let n = tag.chars().count();
                if !(1..=20).contains(&n) {
                    return Err(AppError::field(
                        "tags",
                        fmt(T::FieldErrLength, locale, &[("min", "1"), ("max", "20")]),
                    ));
                }
                if !tags.contains(&tag) {
                    tags.push(tag);
                }
            }
            if tags.len() > 12 {
                return Err(AppError::field("tags", "≤ 12"));
            }
            Some(tags)
        }
    };
    let care_status = match map.get("care_status") {
        None => None,
        Some(value) => Some(
            value
                .as_str()
                .filter(|s| CARE_STATUSES.contains(s))
                .ok_or_else(|| AppError::field("care_status", choice()))?
                .to_string(),
        ),
    };
    // `null` clears, a missing key leaves.
    let mut owners: Vec<(bool, Option<Uuid>)> = Vec::new();
    for (key, role) in [
        ("physician_id", Role::Physician),
        ("coordinator_id", Role::Coordinator),
    ] {
        match map.get(key) {
            None => owners.push((false, None)),
            Some(Value::Null) => owners.push((true, None)),
            Some(value) => {
                let account = value
                    .as_str()
                    .and_then(|s| Uuid::parse_str(s).ok())
                    .ok_or_else(|| AppError::field(key, choice()))?;
                let ok: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM accounts WHERE id = $1 AND role = $2 AND status = 'active')")
                    .bind(account)
                    .bind(role.as_str())
                    .fetch_one(&state.db)
                    .await?;
                if !ok {
                    return Err(AppError::field(key, choice()));
                }
                owners.push((true, Some(account)));
            }
        }
    }
    sqlx::query(
        "INSERT INTO patient_care (account_id, tags, care_status, physician_id, coordinator_id) VALUES ($1, COALESCE($2, '{}'), COALESCE($3, 'new'), $5, $7)
         ON CONFLICT (account_id) DO UPDATE SET tags = COALESCE($2, patient_care.tags), care_status = COALESCE($3, patient_care.care_status),
             physician_id = CASE WHEN $4 THEN $5 ELSE patient_care.physician_id END, coordinator_id = CASE WHEN $6 THEN $7 ELSE patient_care.coordinator_id END, updated_at = now()",
    )
    .bind(id)
    .bind(tags)
    .bind(care_status)
    .bind(owners[0].0)
    .bind(owners[0].1)
    .bind(owners[1].0)
    .bind(owners[1].1)
    .execute(&state.db)
    .await?;
    audit::audit(
        &state.db,
        Some(&user),
        AuditKind::Clinic,
        "patient.update",
        &format!("patient:{id}"),
        json!({ "fields": map.keys().collect::<Vec<_>>() }),
    )
    .await;
    Ok(Json(patient_row(&state, &user, id).await?))
}

#[derive(Deserialize)]
pub struct NewNote {
    body: String,
    #[serde(default)]
    pinned: bool,
}

fn clean_note(text: &str, max: usize, field: &str, locale: Locale) -> AppResult<String> {
    let text = text.trim();
    let n = text.chars().count();
    if (1..=max).contains(&n) {
        Ok(text.to_string())
    } else {
        Err(AppError::field(
            field,
            fmt(
                T::FieldErrLength,
                locale,
                &[("min", "1"), ("max", &max.to_string())],
            ),
        ))
    }
}

pub async fn add_note(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    key: IdempotencyKey,
    ApiJson(body): ApiJson<NewNote>,
) -> AppResult<Response> {
    let id = manage(&state, &user, &id, "note").await?;
    idem::run(&state, user.id, key, "POST /clinic/patients/notes", || async {
        let text = clean_note(&body.body, 2000, "body", user.locale)?;
        let row: StaffNoteRow = sqlx::query_as("INSERT INTO staff_notes (patient_id, author_id, body, pinned) VALUES ($1, $2, $3, $4) RETURNING id, author_id, body, pinned, created_at")
            .bind(id)
            .bind(user.id)
            .bind(text)
            .bind(body.pinned)
            .fetch_one(&state.db)
            .await?;
        let note = note_views(&state.db, vec![row], user.locale).await?.pop();
        Ok((
            StatusCode::CREATED,
            serde_json::to_value(note).map_err(anyhow::Error::from)?,
        ))
    })
    .await
}

#[derive(Deserialize)]
pub struct PatchNote {
    body: Option<String>,
    pinned: Option<bool>,
}

/// Anyone who manages patients may pin; only the author may change the words.
pub async fn patch_note(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(patch): ApiJson<PatchNote>,
) -> AppResult<Json<StaffNote>> {
    user.require(Permission::PatientManage)?;
    let id = parse_id(&id)?;
    let owner: Option<(Option<Uuid>, Uuid)> =
        sqlx::query_as("SELECT author_id, patient_id FROM staff_notes WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    let Some((author, patient)) = owner else {
        return Err(AppError::NotFound);
    };
    audit::log_access(
        &state.db,
        &user,
        Some(patient),
        "note",
        "patient",
        &patient.to_string(),
    )
    .await?;
    let body = match patch.body {
        None => None,
        Some(_) if author != Some(user.id) => return Err(AppError::Forbidden),
        Some(text) => Some(clean_note(&text, 2000, "body", user.locale)?),
    };
    let row: StaffNoteRow = sqlx::query_as("UPDATE staff_notes SET body = COALESCE($2, body), pinned = COALESCE($3, pinned), updated_at = now() WHERE id = $1 RETURNING id, author_id, body, pinned, created_at")
        .bind(id)
        .bind(body)
        .bind(patch.pinned)
        .fetch_one(&state.db)
        .await?;
    note_views(&state.db, vec![row], user.locale)
        .await?
        .pop()
        .map(Json)
        .ok_or(AppError::NotFound)
}

pub async fn delete_note(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require(Permission::PatientManage)?;
    let id = parse_id(&id)?;
    let owner: Option<Option<Uuid>> =
        sqlx::query_scalar("SELECT author_id FROM staff_notes WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    match owner {
        None => Err(AppError::NotFound),
        Some(author) if author != Some(user.id) => Err(AppError::Forbidden),
        Some(_) => {
            sqlx::query("DELETE FROM staff_notes WHERE id = $1")
                .bind(id)
                .execute(&state.db)
                .await?;
            audit::audit(
                &state.db,
                Some(&user),
                AuditKind::Clinic,
                "staff_note.delete",
                &format!("staff_note:{id}"),
                Value::Null,
            )
            .await;
            Ok(Json(json!({ "ok": true })))
        }
    }
}

#[derive(Deserialize)]
pub struct ContactBody {
    channel: String,
    body: String,
}

/// `in_app` sends the patient a message in their latest conversation (a new one if there is none) and takes it over;
/// `phone_note` only records a call.
pub async fn contact(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    key: IdempotencyKey,
    ApiJson(body): ApiJson<ContactBody>,
) -> AppResult<Response> {
    let id = manage(&state, &user, &id, "contact").await?;
    idem::run(&state, user.id, key, "POST /clinic/patients/contact", || async {
        let text = clean_note(&body.body, 1000, "body", user.locale)?;
        let visit_id = match body.channel.as_str() {
            "phone_note" => None,
            "in_app" => {
                user.require(Permission::ThreadReply)?;
                Some(message_patient(&state, &user, id, &text).await?)
            }
            _ => {
                return Err(AppError::field(
                    "channel",
                    t(T::FieldErrChoice, user.locale),
                ));
            }
        };
        let (contact, at): (Uuid, OffsetDateTime) = sqlx::query_as("INSERT INTO contact_log (patient_id, author_id, channel, body, visit_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at")
            .bind(id)
            .bind(user.id)
            .bind(&body.channel)
            .bind(&text)
            .bind(visit_id)
            .fetch_one(&state.db)
            .await?;
        sqlx::query("UPDATE patient_care SET last_contact_at = now() WHERE account_id = $1")
            .bind(id)
            .execute(&state.db)
            .await?;
        Ok((
            StatusCode::CREATED,
            json!({ "id": contact, "channel": body.channel, "body": text, "visit_id": visit_id, "author": user.person(user.locale), "created_at": visits::rfc3339(at) }),
        ))
    })
    .await
}

async fn message_patient(
    state: &AppState,
    user: &CurrentUser,
    patient: Uuid,
    text: &str,
) -> AppResult<Uuid> {
    // The latest conversation that nobody else is holding.
    let latest: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM visits WHERE patient_id = $1 AND NOT archived AND (mode = 'ai' OR assigned_to = $2) ORDER BY last_activity_at DESC LIMIT 1",
    )
    .bind(patient)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?;
    let id = match latest {
        Some(id) => id,
        None => {
            let locale: String = sqlx::query_scalar("SELECT locale FROM accounts WHERE id = $1")
                .bind(patient)
                .fetch_one(&state.db)
                .await?;
            let locale = Locale::parse(&locale).unwrap_or(Locale::ZhTw);
            let visit = visits::create(
                state,
                NewVisit {
                    locale,
                    patient_id: Some(patient),
                    appointment_id: None,
                },
            )
            .await?;
            sqlx::query("UPDATE visits SET title = $2, title_custom = true WHERE id = $1")
                .bind(visit.id)
                .bind(t(T::CareThreadTitle, locale))
                .execute(&state.db)
                .await?;
            visits::assistant_message(
                state,
                visit.id,
                locale,
                message_kind::NOTICE,
                t(T::StaffContactOpening, locale),
                None,
            )
            .await?;
            visit.id
        }
    };
    sqlx::query("UPDATE visits SET mode = 'human', assigned_to = $2 WHERE id = $1")
        .bind(id)
        .bind(user.id)
        .execute(&state.db)
        .await?;
    let visit = visits::fetch(&state.db, id, OffsetDateTime::UNIX_EPOCH)
        .await?
        .ok_or(AppError::NotFound)?;
    send_staff_message(state, user, &visit, text, None).await?;
    crate::events::append(
        state,
        id,
        "mode.changed",
        json!({ "mode": "human", "by": user.person(visit.locale) }),
    )
    .await?;
    visits::emit_updated(state, id).await?;
    visits::changed(state, id, Some(patient), true);
    Ok(id)
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

pub async fn schedule(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Params>,
) -> AppResult<Json<Value>> {
    user.require(Permission::ApptManage)?;
    audit::log_access(&state.db, &user, None, "list", "schedule", "").await?;
    let locale = user.locale;
    let date = match page::param(&params, "date") {
        None => state.clock.today(),
        Some(text) => {
            parse_date(text).ok_or_else(|| AppError::field("date", t(T::FieldErrDate, locale)))?
        }
    };
    let slots = appts::slots_on(&appts::templates(&state.db).await?, date);
    let booked = appts::on_day(&state.db, date).await?;
    let previsit = previsit_states(&state.db, &booked).await?;
    let people = people::load(
        &state.db,
        slots
            .iter()
            .map(|s| s.physician_id)
            .chain(booked.iter().flat_map(|a| [a.patient_id, a.physician_id])),
        locale,
    )
    .await?;
    // Template slots, plus bookings that are outside the current template.
    let mut rows: Vec<(Uuid, OffsetDateTime, Value)> = Vec::new();
    for slot in &slots {
        let appointment = booked
            .iter()
            .find(|a| a.physician_id == slot.physician_id && a.starts_at == slot.starts_at);
        rows.push((
            slot.physician_id,
            slot.starts_at,
            slot_json(
                slot.id(),
                slot.starts_at,
                slot.minutes,
                appointment,
                &previsit,
                &people,
                locale,
            ),
        ));
    }
    for a in &booked {
        if !slots
            .iter()
            .any(|s| s.physician_id == a.physician_id && s.starts_at == a.starts_at)
        {
            rows.push((
                a.physician_id,
                a.starts_at,
                slot_json(
                    appts::slot_id(a.physician_id, a.starts_at),
                    a.starts_at,
                    a.minutes,
                    Some(a),
                    &previsit,
                    &people,
                    locale,
                ),
            ));
        }
    }
    rows.sort_by_key(|(physician, at, _)| (*physician, *at));
    let mut physicians: Vec<Value> = Vec::new();
    for (physician, _, slot) in rows {
        let person = people.get_or_unknown(Some(physician), locale);
        match physicians
            .last_mut()
            .filter(|p| p["physician"]["id"] == json!(physician))
        {
            Some(entry) => {
                if let Some(list) = entry["slots"].as_array_mut() {
                    list.push(slot);
                }
            }
            None => physicians.push(json!({ "physician": person, "slots": [slot] })),
        }
    }
    Ok(Json(
        json!({ "date": format_date(date), "physicians": physicians }),
    ))
}

fn slot_json(
    slot_id: String,
    starts_at: OffsetDateTime,
    minutes: i32,
    appointment: Option<&ApptRow>,
    previsit: &BTreeMap<Uuid, (Uuid, String)>,
    people: &People,
    locale: Locale,
) -> Value {
    json!({
        "slot_id": slot_id,
        "starts_at": visits::rfc3339(starts_at),
        "minutes": minutes,
        "appointment": appointment.map(|a| a.view(people, locale)),
        "patient": appointment.map(|a| people.get_or_unknown(Some(a.patient_id), locale)),
        "previsit": appointment.and_then(|a| previsit.get(&a.id)).map_or("none", |(_, s)| s.as_str()),
    })
}

// ---------------------------------------------------------------------------
// Tickets and staff
// ---------------------------------------------------------------------------

/// `status`: `open`, `resolved` or `all`; with `since`, resolved ones only from then on.
async fn ticket_rows(
    db: &PgPool,
    status: &str,
    since: Option<OffsetDateTime>,
    locale: Locale,
) -> sqlx::Result<Vec<Ticket>> {
    let mut rows = tickets::list(db, status, since).await?;
    tickets::fill_patients(db, &mut rows, locale).await?;
    Ok(rows)
}

pub async fn ticket_list(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Params>,
) -> AppResult<Json<Page<Ticket>>> {
    user.require(Permission::TicketHandle)?;
    audit::log_access(&state.db, &user, None, "list", "tickets", "").await?;
    let status = page::param(&params, "status").unwrap_or("open");
    if !["open", "resolved", "all"].contains(&status) {
        return Err(AppError::field("status", t(T::FieldErrChoice, user.locale)));
    }
    Ok(Json(Page::all(
        ticket_rows(&state.db, status, None, user.locale).await?,
    )))
}

#[derive(Deserialize, Default)]
pub struct ResolveBody {
    note: Option<String>,
}

pub async fn resolve_ticket(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    OptionalJson(body): OptionalJson<ResolveBody>,
) -> AppResult<Json<Value>> {
    user.require(Permission::TicketHandle)?;
    let id = parse_id(&id)?;
    let note = match body.note.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(text) => Some(clean_note(text, 500, "note", user.locale)?),
    };
    let mut ticket = match tickets::resolve(&state.db, id, &user, note.as_deref()).await {
        Ok(ticket) => ticket,
        Err(ResolveError::NotFound) => return Err(AppError::NotFound),
        Err(ResolveError::AlreadyResolved) => {
            return Err(AppError::InvalidState("the ticket is already resolved"));
        }
        Err(ResolveError::Db(e)) => return Err(e.into()),
    };
    audit::log_access(
        &state.db,
        &user,
        ticket.patient_id,
        "resolve",
        "ticket",
        &ticket.id.to_string(),
    )
    .await?;
    audit::audit(
        &state.db,
        Some(&user),
        AuditKind::Clinic,
        "ticket.resolve",
        &format!("ticket:{}", ticket.ticket_no),
        Value::Null,
    )
    .await;
    state.hub.to_permission(
        Permission::TicketHandle,
        "queue.changed",
        json!({ "name": "tickets" }),
    );
    if let Some(visit_id) = ticket.visit_id {
        visits::emit_updated(&state, visit_id).await?;
    }
    tickets::fill_patients(&state.db, std::slice::from_mut(&mut ticket), user.locale).await?;
    Ok(Json(json!({ "ticket": ticket })))
}

/// People work can be assigned to.
pub async fn staff(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Page<PersonRef>>> {
    if !user.can(Permission::RxRead) {
        user.require(Permission::VisitRead)?;
    }
    Ok(Json(Page::all(
        people::by_roles(
            &state.db,
            &[Role::Physician, Role::Coordinator, Role::Pharmacist],
            user.locale,
        )
        .await?,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visits_fall_into_one_bucket_by_status_and_mode() {
        use VisitMode::*;
        use VisitStatus::*;
        assert_eq!(visit_bucket(RedFlag, Ai, false), Some(Bucket::Urgent));
        assert_eq!(
            visit_bucket(RedFlag, Human, true),
            Some(Bucket::Urgent),
            "a red flag stays urgent whoever spoke last"
        );
        assert_eq!(visit_bucket(Submitted, Ai, false), Some(Bucket::Pending));
        assert_eq!(visit_bucket(Submitted, Human, true), Some(Bucket::Waiting));
        assert_eq!(visit_bucket(Active, Human, false), Some(Bucket::Pending));
        assert_eq!(visit_bucket(Active, Ai, false), None);
        assert_eq!(visit_bucket(Reviewed, Ai, false), Some(Bucket::Done));
    }

    #[test]
    fn requests_and_tickets_fall_into_buckets() {
        assert_eq!(rx_bucket("in_review", "urgent"), Some(Bucket::Urgent));
        assert_eq!(rx_bucket("in_review", "soon"), Some(Bucket::Pending));
        assert_eq!(rx_bucket("more_info", "routine"), Some(Bucket::Waiting));
        assert_eq!(rx_bucket("draft", "routine"), None);
        assert_eq!(rx_bucket("at_pharmacy", "routine"), Some(Bucket::Done));
        assert_eq!(ticket_bucket("open", Urgency::Urgent), Bucket::Urgent);
        assert_eq!(ticket_bucket("open", Urgency::Soon), Bucket::Pending);
        assert_eq!(ticket_bucket("resolved", Urgency::Urgent), Bucket::Done);
    }

    #[test]
    fn a_pharmacist_gets_medicines_and_allergies_only() {
        let item = |name: &str| profile::ProfileItem {
            id: "1".into(),
            name: name.into(),
            detail: None,
            since: None,
            source: "clinic".into(),
            status: "active".into(),
        };
        let full = HealthProfile {
            revision: 1,
            display_name: "x".into(),
            birth_year: Some(1960),
            sex: None,
            height_cm: Some(160.0),
            conditions: vec![item("高血壓")],
            medications: vec![item("魚油")],
            allergies: vec![item("青黴素")],
            family_history: vec![item("糖尿病")],
            lifestyle: profile::Lifestyle {
                smoking: Some("戒菸".into()),
                ..Default::default()
            },
            preferred_pharmacy_id: None,
            contact_preference: "in_app".into(),
            updated_at: OffsetDateTime::UNIX_EPOCH,
        };
        let shown = pharmacist_profile(full);
        assert!(shown.conditions.is_empty() && shown.family_history.is_empty());
        assert_eq!(shown.lifestyle, profile::Lifestyle::default());
        assert_eq!(shown.allergies.len(), 1);
        assert_eq!(shown.medications.len(), 1);
    }

    #[test]
    fn long_subtitles_are_cut() {
        assert_eq!(first_line("第一行\n第二行", 10), "第一行");
        assert_eq!(first_line(&"長".repeat(12), 10).chars().count(), 11);
    }
}
