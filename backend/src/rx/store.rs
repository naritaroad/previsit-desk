//! Reads and writes of medicines and requests, and the contract's `RxRequest` / `RxRequestBrief` as one person sees
//! them. Every write goes through a transaction that holds the request row; who may do what is decided by
//! [`super::machine`] before anything here is called.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Value, json};
use sqlx::{PgConnection, PgPool};
use time::{Date, Duration, OffsetDateTime, UtcOffset};
use uuid::Uuid;

use super::engine::{
    self, EngineInput, EngineOutput, EngineResultOut, ItemInput, ItemResult, UrgentNotice,
};
use super::formulary::DrugRef;
use super::machine::{self, Step, Viewer};
use super::medications::{self, FillRecord, MedicationCard, Prescription};
use super::protocol::{self, ItemKey, MonitoringEntry, MonitoringSet, QuestionOut, Source};
use super::texts::{R, rf, rt};
use super::{LText, RenewalScope, RxKind, RxStatus};
use crate::auth::CurrentUser;
use crate::clock::format_date;
use crate::error::{AppError, AppResult};
use crate::people::{self, PersonRef};
use crate::perm::Permission;
use crate::refill::{self, RefillInput, RefillResult};
use crate::state::AppState;
use crate::types::{Locale, RedFlagCategory, Urgency};

/// Most medicines one renewal may carry.
pub const MAX_ITEMS: usize = 10;
/// An urgent request is due this soon, whatever the settings say about the ordinary queue.
const SLA_HOURS_URGENT: i64 = 1;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Request {
    pub id: Uuid,
    pub no: String,
    #[sqlx(try_from = "String")]
    pub kind: RxKind,
    #[sqlx(try_from = "String")]
    pub status: RxStatus,
    pub revision: i32,
    pub patient_id: Uuid,
    pub step: String,
    pub answers: Value,
    pub monitoring: Value,
    pub engine: Option<Value>,
    pub pharmacy_id: Option<String>,
    pub pickup_window: Option<Value>,
    pub assigned_to: Option<Uuid>,
    #[sqlx(try_from = "String")]
    pub priority: Urgency,
    pub sla_due_at: Option<OffsetDateTime>,
    pub decision_note: Option<String>,
    pub patient_message: Option<String>,
    pub decided_by: Option<Uuid>,
    pub extra: Value,
    pub created_at: OffsetDateTime,
    pub submitted_at: Option<OffsetDateTime>,
    pub updated_at: OffsetDateTime,
}

macro_rules! request_cols {
    () => {
        "r.id, r.no, r.kind, r.status, r.revision, r.patient_id, r.step, r.answers, r.monitoring, r.engine, r.pharmacy_id, r.pickup_window, r.assigned_to, r.priority, r.sla_due_at, r.decision_note, r.patient_message, r.decided_by, r.extra, r.created_at, r.submitted_at, r.updated_at"
    };
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Item {
    pub id: Uuid,
    pub prescription_id: Uuid,
    #[sqlx(try_from = "String")]
    pub scope: RenewalScope,
    pub engine: Option<Value>,
    pub refill: Option<Value>,
    pub outcome: Option<String>,
    pub outcome_note: Option<String>,
    pub decided_by: Option<Uuid>,
    pub decided_at: Option<OffsetDateTime>,
    pub drug_id: Option<String>,
    pub name_zh: String,
    pub name_en: String,
    pub class_id: String,
    pub class_zh: String,
    pub class_en: String,
    pub controlled_level: i16,
    pub dose_text: String,
    pub dose_text_en: String,
}

macro_rules! item_select {
    () => {
        "SELECT i.id, i.prescription_id, i.scope, i.engine, i.refill, i.outcome, i.outcome_note, i.decided_by, i.decided_at,
                p.drug_id, p.name_zh, p.name_en, p.class_id, p.class_zh, p.class_en, p.controlled_level, p.dose_text, p.dose_text_en
         FROM rx_request_items i JOIN prescriptions p ON p.id = i.prescription_id WHERE i.request_id = $1 ORDER BY i.position, i.id"
    };
}

impl Item {
    pub fn drug(&self) -> DrugRef {
        DrugRef {
            drug_id: self.drug_id.clone().unwrap_or_default(),
            name_zh: self.name_zh.clone(),
            name_en: if self.name_en.is_empty() {
                self.name_zh.clone()
            } else {
                self.name_en.clone()
            },
            class_id: self.class_id.clone(),
            class_zh: self.class_zh.clone(),
            class_en: self.class_en.clone(),
            controlled_level: self.controlled_level.clamp(0, 4) as u8,
        }
    }

    pub fn name(&self) -> LText {
        let drug = self.drug();
        LText::new(drug.name_zh, drug.name_en)
    }

    fn key(&self) -> ItemKey {
        ItemKey {
            item_id: self.id.to_string(),
            drug_name: self.name(),
            class_id: self.class_id.clone(),
            scope: self.scope,
        }
    }

    pub fn engine_result(&self) -> Option<ItemResult> {
        self.engine
            .as_ref()
            .and_then(|v| serde_json::from_value(v.clone()).ok())
    }
}

impl Request {
    pub fn answers_map(&self) -> Map<String, Value> {
        self.answers.as_object().cloned().unwrap_or_default()
    }

    pub fn monitoring_set(&self) -> MonitoringSet {
        serde_json::from_value(self.monitoring.clone()).unwrap_or_default()
    }

    /// The care team has been told about something urgent in this request.
    pub fn alerted(&self) -> bool {
        self.extra["alerted"] == json!(true)
    }

    pub fn engine_snapshot(&self) -> Option<(EngineOutput, String)> {
        let stored = self.engine.as_ref()?;
        let output = serde_json::from_value(stored["output"].clone()).ok()?;
        Some((output, stored["evaluated_at"].as_str()?.to_string()))
    }

    pub fn overdue(&self, now: OffsetDateTime) -> bool {
        self.status.waits_for_physician() && self.sla_due_at.is_some_and(|due| due < now)
    }
}

pub fn viewer_of(user: &CurrentUser, request: &Request) -> Viewer {
    Viewer {
        owner: request.patient_id == user.id && user.can(Permission::RxOwn),
        read: user.can(Permission::RxRead),
        decide: user.can(Permission::RxDecide),
        dispense: user.can(Permission::RxDispense),
    }
}

pub fn rfc3339(at: OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

pub fn taipei_date(at: OffsetDateTime) -> Date {
    at.to_offset(UtcOffset::from_hms(8, 0, 0).unwrap_or(UtcOffset::UTC))
        .date()
}

// ---------------------------------------------------------------------------
// Prescriptions and medication cards
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct PrescriptionRow {
    id: Uuid,
    source: String,
    drug_id: Option<String>,
    name_zh: String,
    name_en: String,
    class_id: String,
    class_zh: String,
    class_en: String,
    controlled_level: i16,
    dose_text: String,
    dose_text_en: String,
    issued_on: Option<Date>,
    total_days: Option<i32>,
    days_per_fill: Option<i32>,
    renewed_from: Option<Uuid>,
    created_at: OffsetDateTime,
}

macro_rules! prescription_cols {
    () => {
        "p.id, p.source, p.drug_id, p.name_zh, p.name_en, p.class_id, p.class_zh, p.class_en, p.controlled_level, p.dose_text, p.dose_text_en, p.issued_on, p.total_days, p.days_per_fill, p.renewed_from, p.created_at"
    };
}

#[derive(sqlx::FromRow)]
struct FillRow {
    prescription_id: Uuid,
    n: i32,
    filled_on: Date,
    pharmacy_name: String,
}

async fn with_fills(
    db: &mut PgConnection,
    rows: Vec<PrescriptionRow>,
) -> sqlx::Result<Vec<Prescription>> {
    let ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
    let fills: Vec<FillRow> = sqlx::query_as(
        "SELECT prescription_id, n, filled_on, pharmacy_name FROM fills WHERE prescription_id = ANY($1) ORDER BY n",
    )
    .bind(&ids)
    .fetch_all(&mut *db)
    .await?;
    let mut by_prescription: BTreeMap<Uuid, Vec<FillRecord>> = BTreeMap::new();
    for f in fills {
        by_prescription
            .entry(f.prescription_id)
            .or_default()
            .push(FillRecord {
                n: i64::from(f.n),
                filled_on: f.filled_on,
                pharmacy_name: f.pharmacy_name,
            });
    }
    Ok(rows
        .into_iter()
        .map(|r| Prescription {
            fills: by_prescription.remove(&r.id).unwrap_or_default(),
            id: r.id.to_string(),
            drug: DrugRef {
                drug_id: r.drug_id.unwrap_or_default(),
                name_en: if r.name_en.is_empty() {
                    r.name_zh.clone()
                } else {
                    r.name_en
                },
                name_zh: r.name_zh,
                class_id: r.class_id,
                class_zh: r.class_zh,
                class_en: r.class_en,
                controlled_level: r.controlled_level.clamp(0, 4) as u8,
            },
            dose: LText::new(r.dose_text, r.dose_text_en),
            self_reported: r.source == "self_reported",
            is_demo: r.renewed_from.is_some(),
            issued_on: r.issued_on.unwrap_or_else(|| taipei_date(r.created_at)),
            total_days: i64::from(r.total_days.unwrap_or(0)),
            days_per_fill: i64::from(r.days_per_fill.unwrap_or(0)),
        })
        .collect())
}

/// Active medicines of a patient, newest first.
pub async fn active_prescriptions(
    db: &mut PgConnection,
    patient: Uuid,
) -> sqlx::Result<Vec<Prescription>> {
    let rows = sqlx::query_as(concat!(
        "SELECT ",
        prescription_cols!(),
        " FROM prescriptions p WHERE p.patient_id = $1 AND p.active ORDER BY p.source, p.issued_on DESC NULLS LAST, p.created_at DESC, p.id"
    ))
    .bind(patient)
    .fetch_all(&mut *db)
    .await?;
    with_fills(db, rows).await
}

async fn prescriptions_by_id(
    db: &mut PgConnection,
    ids: &[Uuid],
) -> sqlx::Result<Vec<Prescription>> {
    let rows = sqlx::query_as(concat!(
        "SELECT ",
        prescription_cols!(),
        " FROM prescriptions p WHERE p.id = ANY($1)"
    ))
    .bind(ids)
    .fetch_all(&mut *db)
    .await?;
    with_fills(db, rows).await
}

/// `prescription id → unfinished request` of a patient.
async fn open_requests(
    db: &mut PgConnection,
    patient: Uuid,
) -> sqlx::Result<BTreeMap<String, Uuid>> {
    let rows: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT i.prescription_id, r.id FROM rx_request_items i JOIN rx_requests r ON r.id = i.request_id
         WHERE r.patient_id = $1 AND r.status NOT IN ('declined', 'visit_required', 'dispensed', 'cancelled') ORDER BY r.created_at",
    )
    .bind(patient)
    .fetch_all(&mut *db)
    .await?;
    Ok(rows.into_iter().map(|(p, r)| (p.to_string(), r)).collect())
}

pub async fn cards(
    state: &AppState,
    patient: Uuid,
    locale: Locale,
) -> AppResult<Vec<MedicationCard>> {
    let mut conn = state.db.acquire().await?;
    let prescriptions = active_prescriptions(&mut conn, patient).await?;
    let open = open_requests(&mut conn, patient).await?;
    let today = state.clock.today();
    Ok(prescriptions
        .iter()
        .map(|p| {
            let (scope, _) = scope_of(state, p);
            medications::card(
                p,
                scope,
                &state.rules.refill,
                today,
                open.get(&p.id).map(Uuid::to_string),
                locale,
            )
        })
        .collect())
}

/// `MedicationCard[]` of one patient for other modules, already localised. The caller has checked who may see them.
pub async fn medications_for(
    state: &AppState,
    patient: Uuid,
    locale: Locale,
) -> AppResult<Vec<Value>> {
    Ok(cards(state, patient, locale)
        .await?
        .iter()
        .map(|c| serde_json::to_value(c).unwrap_or(Value::Null))
        .collect())
}

pub fn scope_of(state: &AppState, p: &Prescription) -> (RenewalScope, LText) {
    engine::scope_for(
        &state.rx.formulary,
        &p.drug.drug_id,
        p.drug.controlled_level,
    )
}

// ---------------------------------------------------------------------------
// Loading a request
// ---------------------------------------------------------------------------

pub async fn find(db: &PgPool, id: Uuid) -> sqlx::Result<Option<Request>> {
    sqlx::query_as(concat!(
        "SELECT ",
        request_cols!(),
        " FROM rx_requests r WHERE r.id = $1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await
}

pub async fn lock(db: &mut PgConnection, id: Uuid) -> sqlx::Result<Option<Request>> {
    sqlx::query_as(concat!(
        "SELECT ",
        request_cols!(),
        " FROM rx_requests r WHERE r.id = $1 FOR NO KEY UPDATE"
    ))
    .bind(id)
    .fetch_optional(db)
    .await
}

pub async fn items(db: &mut PgConnection, request: Uuid) -> sqlx::Result<Vec<Item>> {
    sqlx::query_as(item_select!())
        .bind(request)
        .fetch_all(db)
        .await
}

/// The prescriptions behind the items, by id.
pub async fn item_prescriptions(
    db: &mut PgConnection,
    items: &[Item],
) -> sqlx::Result<BTreeMap<String, Prescription>> {
    let ids: Vec<Uuid> = items.iter().map(|i| i.prescription_id).collect();
    Ok(prescriptions_by_id(db, &ids)
        .await?
        .into_iter()
        .map(|p| (p.id.clone(), p))
        .collect())
}

pub fn questions(
    state: &AppState,
    kind: RxKind,
    items: &[Item],
    locale: Locale,
) -> Vec<QuestionOut> {
    let keys: Vec<ItemKey> = items.iter().map(Item::key).collect();
    protocol::questions_for(&state.rx.protocols, kind, &keys, locale)
}

// ---------------------------------------------------------------------------
// Engine runs
// ---------------------------------------------------------------------------

/// Runs the engine over a renewal with the given answers. Nothing is written.
pub fn run_engine(
    state: &AppState,
    items: &[Item],
    prescriptions: &BTreeMap<String, Prescription>,
    answers: &Map<String, Value>,
    monitoring: &MonitoringSet,
) -> EngineOutput {
    let today = state.clock.today();
    let inputs: Vec<ItemInput> = items
        .iter()
        .map(|i| ItemInput {
            item_id: i.id.to_string(),
            drug_id: i.drug_id.clone().unwrap_or_default(),
            controlled_level: i.controlled_level.clamp(0, 4) as u8,
            fills_left: prescriptions
                .get(&i.prescription_id.to_string())
                .map_or(0, |p| p.fills_left(&state.rules.refill, today)),
        })
        .collect();
    engine::evaluate(
        &state.rx.formulary,
        &state.rx.protocols,
        &state.rules.red_flags,
        &EngineInput {
            today,
            items: &inputs,
            answers,
            monitoring,
        },
    )
}

/// Stores an engine result on the request and its items (the latest one wins).
pub async fn save_engine(
    db: &mut PgConnection,
    request: Uuid,
    output: &EngineOutput,
    at: OffsetDateTime,
) -> AppResult<()> {
    let stored = json!({ "evaluated_at": rfc3339(at), "output": output });
    sqlx::query(
        "UPDATE rx_requests SET engine = $2, disposition = $3, protocol_version = $4 WHERE id = $1",
    )
    .bind(request)
    .bind(&stored)
    .bind(output.disposition.as_str())
    .bind(&output.protocol_version)
    .execute(&mut *db)
    .await?;
    for item in &output.items {
        let Ok(id) = Uuid::parse_str(&item.item_id) else {
            continue;
        };
        sqlx::query("UPDATE rx_request_items SET engine = $2, disposition = $3, scope = $4, scope_reason = $5 WHERE id = $1 AND request_id = $6")
            .bind(id)
            .bind(serde_json::to_value(item).unwrap_or(Value::Null))
            .bind(item.disposition.as_str())
            .bind(item.scope.as_str())
            .bind(&item.scope_reason.zh)
            .bind(request)
            .execute(&mut *db)
            .await?;
    }
    Ok(())
}

pub fn min_days_left(prescriptions: &BTreeMap<String, Prescription>, today: Date) -> Option<i64> {
    prescriptions.values().map(|p| p.days_left(today)).min()
}

pub fn sla_due(state: &AppState, priority: Urgency, from: OffsetDateTime) -> OffsetDateTime {
    let rx = state.settings.get().rx.clone();
    let hours = match priority {
        Urgency::Urgent => SLA_HOURS_URGENT,
        Urgency::Soon => rx.sla_hours_soon,
        Urgency::Routine => rx.sla_hours_routine,
    };
    from + Duration::hours(hours)
}

pub fn more_urgent(a: Urgency, b: Urgency) -> Urgency {
    let rank = |u| match u {
        Urgency::Routine => 0,
        Urgency::Soon => 1,
        Urgency::Urgent => 2,
    };
    if rank(a) >= rank(b) { a } else { b }
}

/// A refill check kept as its input, so every reader gets the result in their own language.
pub fn refill_stored(input: &RefillInput, today: Date) -> Value {
    let mut stored = serde_json::to_value(input).unwrap_or(Value::Null);
    stored["today"] = json!(format_date(today));
    stored
}

fn refill_result(state: &AppState, stored: &Value, locale: Locale) -> Option<RefillResult> {
    let input = RefillInput::from_json(stored, true, locale).ok()?;
    let rules = &state.rules.refill;
    let checked = refill::validate(&input, rules, state.clock.today(), locale).ok()?;
    Some(refill::check(&checked, rules, locale).result)
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Timeline event types. The text is rendered when read, in the reader's language.
pub mod ev {
    pub const CREATED: &str = "created";
    pub const SUBMITTED: &str = "submitted";
    pub const ITEMS_LEFT_OUT: &str = "items_left_out";
    pub const URGENT: &str = "urgent";
    pub const ASSIGNED: &str = "assigned";
    pub const UNASSIGNED: &str = "unassigned";
    pub const REVIEW_STARTED: &str = "review_started";
    pub const APPROVED: &str = "approved";
    pub const PARTIALLY_APPROVED: &str = "partially_approved";
    pub const DECLINED: &str = "declined";
    pub const VISIT_REQUIRED: &str = "visit_required";
    pub const MORE_INFO: &str = "more_info";
    pub const REPLIED: &str = "replied";
    pub const SENT_TO_PHARMACY: &str = "sent_to_pharmacy";
    pub const ACCEPTED: &str = "accepted";
    pub const READY: &str = "ready";
    pub const DISPENSED: &str = "dispensed";
    pub const FILL_RECORDED: &str = "fill_recorded";
    pub const NEXT_PRESCRIPTION: &str = "next_prescription";
    pub const RETURNED: &str = "returned";
    pub const ASKED_PHYSICIAN: &str = "asked_physician";
    pub const CANCELLED: &str = "cancelled";
    pub const OVERDUE: &str = "overdue";
}

pub struct NewEvent<'a> {
    pub kind: &'a str,
    pub actor: Option<Uuid>,
    pub from: Option<RxStatus>,
    pub to: Option<RxStatus>,
    pub data: Value,
    pub staff_only: bool,
}

impl<'a> NewEvent<'a> {
    pub fn new(kind: &'a str, actor: Option<Uuid>) -> Self {
        Self {
            kind,
            actor,
            from: None,
            to: None,
            data: json!({}),
            staff_only: false,
        }
    }

    pub fn data(mut self, data: Value) -> Self {
        self.data = data;
        self
    }

    pub fn staff(mut self) -> Self {
        self.staff_only = true;
        self
    }
}

pub async fn add_event(
    db: &mut PgConnection,
    request: Uuid,
    at: OffsetDateTime,
    event: NewEvent<'_>,
) -> sqlx::Result<()> {
    // Events of one change share its time; clock_timestamp() order inside the id keeps them in sequence.
    sqlx::query("INSERT INTO rx_events (request_id, at, type, actor_id, from_status, to_status, data, visibility) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)")
        .bind(request)
        .bind(at)
        .bind(event.kind)
        .bind(event.actor)
        .bind(event.from.map(RxStatus::as_str))
        .bind(event.to.map(RxStatus::as_str))
        .bind(&event.data)
        .bind(if event.staff_only { "staff" } else { "all" })
        .execute(db)
        .await?;
    Ok(())
}

/// Takes one step of the state machine: new status, new revision and its event, all in the caller's transaction.
pub async fn advance(
    db: &mut PgConnection,
    request: &mut Request,
    step: Step,
    at: OffsetDateTime,
    mut event: NewEvent<'_>,
) -> AppResult<()> {
    let from = request.status;
    let to = machine::next(request.kind, from, step).ok_or(AppError::InvalidState(
        "the request cannot take this step now",
    ))?;
    sqlx::query("UPDATE rx_requests SET status = $2, revision = revision + 1, updated_at = $3, closed_at = CASE WHEN $4 THEN $3 ELSE NULL END WHERE id = $1")
        .bind(request.id)
        .bind(to.as_str())
        .bind(at)
        .bind(to.is_terminal())
        .execute(&mut *db)
        .await?;
    request.status = to;
    request.revision += 1;
    event.from = Some(from);
    event.to = Some(to);
    add_event(db, request.id, at, event).await?;
    Ok(())
}

/// Bumps the revision without a status change (autosave).
pub async fn touch(
    db: &mut PgConnection,
    request: &mut Request,
    at: OffsetDateTime,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE rx_requests SET revision = revision + 1, updated_at = $2 WHERE id = $1")
        .bind(request.id)
        .bind(at)
        .execute(db)
        .await?;
    request.revision += 1;
    Ok(())
}

pub async fn add_message(
    db: &mut PgConnection,
    request: Uuid,
    author: Uuid,
    body: &str,
    staff_only: bool,
    at: OffsetDateTime,
) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO rx_messages (request_id, author_id, body, visibility, created_at) VALUES ($1, $2, $3, $4, $5)")
        .bind(request)
        .bind(author)
        .bind(body)
        .bind(if staff_only { "staff" } else { "all" })
        .bind(at)
        .execute(db)
        .await?;
    Ok(())
}

/// `RX-YYYYMMDD-NNNN`, from one atomic counter per Taipei day.
pub fn format_no(day: Date, n: i32) -> String {
    format!(
        "RX-{:04}{:02}{:02}-{:04}",
        day.year(),
        u8::from(day.month()),
        day.day(),
        n
    )
}

async fn next_no(db: &mut PgConnection, day: Date) -> sqlx::Result<String> {
    let n: i32 = sqlx::query_scalar("INSERT INTO rx_counters (day, n) VALUES ($1, 1) ON CONFLICT (day) DO UPDATE SET n = rx_counters.n + 1 RETURNING n")
        .bind(day)
        .fetch_one(db)
        .await?;
    Ok(format_no(day, n))
}

#[derive(sqlx::FromRow)]
struct MeasurementRow {
    kind: String,
    values: Value,
    taken_at: OffsetDateTime,
    source: String,
}

/// Fills monitoring answers from the health profile, newest measurement first. The patient sees and can change them.
fn prefill(questions: &[QuestionOut], rows: &[MeasurementRow]) -> MonitoringSet {
    /// Words in a lab name that answer a monitoring id containing the key.
    const LABS: [(&str, &[&str]); 8] = [
        ("a1c", &["a1c", "糖化"]),
        ("egfr", &["egfr", "腎絲球"]),
        ("uacr", &["uacr", "白蛋白"]),
        ("lipid", &["lipid", "ldl", "cholesterol", "血脂", "膽固醇"]),
        ("tsh", &["tsh", "甲狀腺"]),
        ("urate", &["urate", "uric", "尿酸"]),
        ("eye", &["eye", "retina", "眼底"]),
        ("foot", &["foot", "足部"]),
    ];
    let mut out = MonitoringSet::new();
    for q in questions.iter().filter(|q| q.scope == "monitoring") {
        let id = q.id.as_str();
        let found = rows.iter().find_map(|m| {
            let number = |key: &str| m.values[key].as_f64();
            let value = match m.kind.as_str() {
                "bp" if id.contains("bp") && id.contains("diastolic") => number("diastolic"),
                "bp" if id.contains("bp") => number("systolic"),
                "lab" => {
                    let name = m.values["name"].as_str().unwrap_or("").to_lowercase();
                    let hit = LABS.iter().any(|(key, words)| {
                        id.contains(key) && words.iter().any(|w| name.contains(w))
                    });
                    if !hit {
                        return None;
                    }
                    number("value")
                }
                _ => return None,
            };
            if q.kind == "number" && value.is_none() {
                return None;
            }
            Some(MonitoringEntry {
                value: value.filter(|_| q.kind == "number"),
                date: Some(format_date(taipei_date(m.taken_at))),
                source: if m.source == "clinic" {
                    Source::Clinic
                } else {
                    Source::Patient
                },
            })
        });
        if let Some(entry) = found {
            out.insert(q.id.clone(), entry);
        }
    }
    out
}

pub struct NewRequest<'a> {
    pub patient: Uuid,
    pub kind: RxKind,
    pub locale: Locale,
    pub pharmacy_id: Option<&'a str>,
    pub at: OffsetDateTime,
    /// The Taipei day in the request number.
    pub day: Date,
    pub is_demo: bool,
}

pub async fn insert_request(db: &mut PgConnection, new: &NewRequest<'_>) -> sqlx::Result<Uuid> {
    let no = next_no(db, new.day).await?;
    sqlx::query_scalar("INSERT INTO rx_requests (no, kind, patient_id, locale, pharmacy_id, is_demo, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id")
        .bind(&no)
        .bind(new.kind.as_str())
        .bind(new.patient)
        .bind(new.locale.as_str())
        .bind(new.pharmacy_id)
        .bind(new.is_demo)
        .bind(new.at)
        .fetch_one(db)
        .await
}

pub async fn insert_item(
    db: &mut PgConnection,
    request: Uuid,
    prescription: Uuid,
    position: i32,
    class_id: &str,
    scope: RenewalScope,
    scope_reason: &str,
) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO rx_request_items (request_id, prescription_id, position, class_id, scope, scope_reason) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(request)
        .bind(prescription)
        .bind(position)
        .bind(class_id)
        .bind(scope.as_str())
        .bind(scope_reason)
        .execute(db)
        .await?;
    Ok(())
}

/// Creates a draft for `patient`. Items that are not accepted online may be added; they are marked and left out when
/// the request is submitted.
pub async fn create_draft(
    state: &AppState,
    patient: Uuid,
    locale: Locale,
    kind: RxKind,
    prescription_ids: &[Uuid],
) -> AppResult<Uuid> {
    let field = |key: R, args: &[(&str, &str)]| {
        AppError::field("prescription_ids", rf(key, locale, args)).localized(locale)
    };
    let mut ids = prescription_ids.to_vec();
    ids.dedup();
    if ids.is_empty() {
        return Err(field(R::ErrNoItems, &[]));
    }
    if kind == RxKind::Refill && ids.len() != 1 {
        return Err(field(R::ErrRefillOneItem, &[]));
    }
    if ids.len() > MAX_ITEMS {
        return Err(field(
            R::ErrTooManyItems,
            &[("max", &MAX_ITEMS.to_string())],
        ));
    }
    let now = state.clock.now();
    let mut tx = state.db.begin().await?;
    // One draft at a time per patient, so two clicks cannot open two requests for one medicine.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("rx:{patient}"))
        .execute(&mut *tx)
        .await?;
    let mine = active_prescriptions(&mut tx, patient).await?;
    let mut chosen: Vec<&Prescription> = Vec::new();
    for id in &ids {
        // Someone else's prescription and one that does not exist look the same.
        let p = mine
            .iter()
            .find(|p| p.id == id.to_string())
            .ok_or(AppError::NotFound)?;
        if p.self_reported {
            return Err(field(R::ErrNotPrescribedHere, &[]));
        }
        if chosen.iter().any(|c| c.id == p.id) {
            continue;
        }
        chosen.push(p);
    }
    if kind == RxKind::Refill && chosen.iter().any(|p| p.fills.is_empty()) {
        return Err(field(R::ErrRefillNeedsFill, &[]));
    }
    let open = open_requests(&mut tx, patient).await?;
    if let Some(existing) = chosen.iter().find_map(|p| open.get(&p.id)) {
        return Err(AppError::UnprocessableWith(
            BTreeMap::from([(
                "prescription_ids".to_string(),
                rt(R::ErrOpenRequest, locale).to_string(),
            )]),
            json!({ "open_request_id": existing }),
        ));
    }
    let pharmacy: Option<String> = sqlx::query_scalar(
        "SELECT preferred_pharmacy_id FROM patient_profiles WHERE account_id = $1",
    )
    .bind(patient)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
    let id = insert_request(
        &mut tx,
        &NewRequest {
            patient,
            kind,
            locale,
            pharmacy_id: pharmacy.as_deref(),
            at: now,
            day: state.clock.today(),
            is_demo: false,
        },
    )
    .await?;
    for (position, p) in chosen.iter().enumerate() {
        let (scope, reason) = scope_of(state, p);
        let prescription = Uuid::parse_str(&p.id).map_err(anyhow::Error::from)?;
        insert_item(
            &mut tx,
            id,
            prescription,
            position as i32,
            &p.drug.class_id,
            scope,
            &reason.zh,
        )
        .await?;
    }
    if kind == RxKind::Renewal {
        let rows: Vec<MeasurementRow> = sqlx::query_as("SELECT kind, \"values\", taken_at, source FROM measurements WHERE patient_id = $1 AND kind IN ('bp', 'lab') ORDER BY taken_at DESC LIMIT 300")
            .bind(patient)
            .fetch_all(&mut *tx)
            .await?;
        let list = items(&mut tx, id).await?;
        let filled = prefill(&questions(state, kind, &list, locale), &rows);
        if !filled.is_empty() {
            sqlx::query("UPDATE rx_requests SET monitoring = $2 WHERE id = $1")
                .bind(id)
                .bind(serde_json::to_value(&filled).unwrap_or(json!({})))
                .execute(&mut *tx)
                .await?;
        }
    }
    add_event(&mut tx, id, now, NewEvent::new(ev::CREATED, Some(patient))).await?;
    tx.commit().await?;
    Ok(id)
}

/// Records one collected fill of a prescription.
pub async fn add_fill(
    db: &mut PgConnection,
    prescription: Uuid,
    n: i64,
    on: Date,
    pharmacy: Option<&PharmacyRow>,
    by: Option<Uuid>,
    request: Uuid,
) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO fills (prescription_id, n, filled_on, pharmacy_id, pharmacy_name, dispensed_by, rx_request_id) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(prescription)
        .bind(n as i32)
        .bind(on)
        .bind(pharmacy.map(|p| p.id.as_str()))
        .bind(pharmacy.map_or("", |p| p.name.as_str()))
        .bind(by)
        .bind(request)
        .execute(db)
        .await?;
    Ok(())
}

/// The demonstration record a handed-over renewal leaves behind: the same medicine, text and days as before, dated
/// today. Nothing about the drug or how to take it can change on the way.
pub async fn next_prescription(
    db: &mut PgConnection,
    old: Uuid,
    request: &Request,
    on: Date,
) -> sqlx::Result<Uuid> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO prescriptions (patient_id, source, drug_id, name_zh, name_en, class_id, class_zh, class_en, controlled_level, dose_text, dose_text_en,
                                    issued_on, total_days, days_per_fill, fills_allowed, valid_until, prescriber_id, renewed_from, rx_request_id, is_demo)
         SELECT patient_id, source, drug_id, name_zh, name_en, class_id, class_zh, class_en, controlled_level, dose_text, dose_text_en,
                $2, total_days, days_per_fill, fills_allowed, $2 + total_days, $3, id, $4, true
         FROM prescriptions WHERE id = $1 RETURNING id",
    )
    .bind(old)
    .bind(on)
    .bind(request.decided_by)
    .bind(request.id)
    .fetch_one(&mut *db)
    .await?;
    sqlx::query("UPDATE prescriptions SET active = false WHERE id = $1")
        .bind(old)
        .execute(db)
        .await?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// Pharmacies
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PharmacyRow {
    pub id: String,
    pub name: String,
    pub name_en: String,
    pub district: String,
    pub district_en: String,
    pub address: String,
    pub address_en: String,
    pub hours: String,
    pub hours_en: String,
    pub services: Value,
    pub services_en: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct PharmacyOut {
    pub id: String,
    pub name: String,
    pub district: String,
    pub address: String,
    pub hours: String,
    pub services: Value,
}

impl PharmacyRow {
    pub fn to_out(&self, locale: Locale) -> PharmacyOut {
        let pick = |zh: &str, en: &str| {
            if locale.is_en() && !en.is_empty() {
                en.to_string()
            } else {
                zh.to_string()
            }
        };
        PharmacyOut {
            id: self.id.clone(),
            name: pick(&self.name, &self.name_en),
            district: pick(&self.district, &self.district_en),
            address: pick(&self.address, &self.address_en),
            hours: pick(&self.hours, &self.hours_en),
            services: if locale.is_en() {
                self.services_en.clone()
            } else {
                self.services.clone()
            },
        }
    }
}

pub async fn pharmacy(
    db: &mut PgConnection,
    id: Option<&str>,
) -> sqlx::Result<Option<PharmacyRow>> {
    let Some(id) = id else { return Ok(None) };
    sqlx::query_as("SELECT id, name, name_en, district, district_en, address, address_en, hours, hours_en, services, services_en FROM pharmacies WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await
}

// ---------------------------------------------------------------------------
// Contract objects
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct DecisionOut {
    outcome: String,
    note: Option<String>,
    by: Option<PersonRef>,
    at: Option<String>,
}

#[derive(Serialize)]
struct ItemEngineOut {
    disposition: super::Disposition,
    fired: Vec<engine::FiredOut>,
}

#[derive(Serialize)]
struct ItemOut {
    id: Uuid,
    prescription_id: Uuid,
    drug: DrugRef,
    dose_text: String,
    scope: RenewalScope,
    scope_reason: String,
    engine: Option<ItemEngineOut>,
    refill: Option<RefillResult>,
    decision: Option<DecisionOut>,
}

#[derive(Serialize)]
struct EventOut {
    at: String,
    #[serde(rename = "type")]
    kind: String,
    actor: Option<PersonRef>,
    text: String,
    visibility: String,
}

#[derive(Serialize)]
struct MessageOut {
    id: Uuid,
    author: Option<PersonRef>,
    body: String,
    created_at: String,
    visibility: String,
}

#[derive(Serialize)]
struct RequestOut {
    id: Uuid,
    no: String,
    kind: RxKind,
    status: RxStatus,
    revision: i32,
    patient: Option<PersonRef>,
    items: Vec<ItemOut>,
    step: String,
    answers: Value,
    monitoring: Value,
    questions: Vec<QuestionOut>,
    engine: Option<EngineResultOut>,
    pharmacy: Option<PharmacyOut>,
    pickup_window: Option<Value>,
    assigned_to: Option<PersonRef>,
    priority: Urgency,
    sla_due_at: Option<String>,
    overdue: bool,
    decision_note: Option<String>,
    created_at: String,
    submitted_at: Option<String>,
    updated_at: String,
    timeline: Vec<EventOut>,
    messages: Vec<MessageOut>,
    allowed_actions: Vec<&'static str>,
}

#[derive(sqlx::FromRow)]
struct EventRow {
    at: OffsetDateTime,
    #[sqlx(rename = "type")]
    kind: String,
    actor_id: Option<Uuid>,
    data: Value,
    visibility: String,
}

#[derive(sqlx::FromRow)]
struct MessageRow {
    id: Uuid,
    author_id: Option<Uuid>,
    body: String,
    visibility: String,
    created_at: OffsetDateTime,
}

/// A timeline line in the reader's language. Patients read the full emergency text; staff read what was done.
fn event_text(kind: &str, data: &Value, name: &str, staff: bool, locale: Locale) -> String {
    let text = |key: &str| {
        let en = data[format!("{key}_en")].as_str().unwrap_or("");
        if locale.is_en() && !en.is_empty() {
            en.to_string()
        } else {
            data[key].as_str().unwrap_or("").to_string()
        }
    };
    match kind {
        ev::CREATED => rt(R::EvCreated, locale).into(),
        ev::SUBMITTED => rt(R::EvSubmitted, locale).into(),
        ev::ITEMS_LEFT_OUT => rf(R::EvItemsLeftOut, locale, &[("drugs", &text("drugs"))]),
        ev::URGENT if staff => rt(R::EvUrgentStaff, locale).into(),
        ev::URGENT => UrgentNotice {
            category: data["category"].as_str().and_then(RedFlagCategory::parse),
            from_text: data["from_text"] == json!(true),
            label: LText::new(
                data["label"].as_str().unwrap_or(""),
                data["label_en"].as_str().unwrap_or(""),
            ),
        }
        .text(true, locale),
        ev::ASSIGNED => rf(R::EvAssigned, locale, &[("name", name)]),
        ev::UNASSIGNED => rt(R::EvUnassigned, locale).into(),
        ev::REVIEW_STARTED => rt(R::EvReviewStarted, locale).into(),
        ev::APPROVED => rt(R::EvApproved, locale).into(),
        ev::PARTIALLY_APPROVED => rt(R::EvPartiallyApproved, locale).into(),
        ev::DECLINED => rt(R::EvDeclined, locale).into(),
        ev::VISIT_REQUIRED => rt(R::EvVisitRequired, locale).into(),
        ev::MORE_INFO => rt(R::EvMoreInfo, locale).into(),
        ev::REPLIED => rt(R::EvReplied, locale).into(),
        ev::SENT_TO_PHARMACY => rf(
            R::EvSentToPharmacy,
            locale,
            &[("pharmacy", &text("pharmacy"))],
        ),
        ev::ACCEPTED => rt(R::EvAccepted, locale).into(),
        ev::READY => rt(R::EvReady, locale).into(),
        ev::DISPENSED => rt(R::EvDispensed, locale).into(),
        ev::FILL_RECORDED => rf(
            R::EvFillRecorded,
            locale,
            &[("n", &data["n"].as_i64().unwrap_or(0).to_string())],
        ),
        ev::NEXT_PRESCRIPTION => rt(R::EvNextPrescription, locale).into(),
        ev::RETURNED => rf(R::EvReturned, locale, &[("note", &text("note"))]),
        ev::ASKED_PHYSICIAN => rt(R::EvAskedPhysician, locale).into(),
        ev::CANCELLED => rt(R::EvCancelled, locale).into(),
        ev::OVERDUE => rt(R::EvOverdue, locale).into(),
        _ => rt(R::EvOther, locale).into(),
    }
}

/// The whole `RxRequest` as `user` may see it. The caller has checked [`machine::can_see`].
pub async fn view(state: &AppState, request: &Request, user: &CurrentUser) -> AppResult<Value> {
    let locale = user.locale;
    let viewer = viewer_of(user, request);
    let staff = !viewer.owner;
    let mut conn = state.db.acquire().await?;
    let list = items(&mut conn, request.id).await?;
    let events: Vec<EventRow> = sqlx::query_as("SELECT at, type, actor_id, data, visibility FROM rx_events WHERE request_id = $1 AND ($2 OR visibility = 'all') ORDER BY at, id")
        .bind(request.id)
        .bind(staff)
        .fetch_all(&mut *conn)
        .await?;
    let messages: Vec<MessageRow> = sqlx::query_as("SELECT id, author_id, body, visibility, created_at FROM rx_messages WHERE request_id = $1 AND ($2 OR visibility = 'all') ORDER BY created_at, id")
        .bind(request.id)
        .bind(staff)
        .fetch_all(&mut *conn)
        .await?;
    let shop = pharmacy(&mut conn, request.pharmacy_id.as_deref()).await?;
    drop(conn);

    let assignee = |e: &EventRow| {
        e.data["assignee_id"]
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok())
    };
    // Collected first: a lazy iterator held across an await would not be Send.
    let mut ids: Vec<Uuid> = vec![request.patient_id];
    ids.extend(request.assigned_to);
    ids.extend(list.iter().filter_map(|i| i.decided_by));
    for e in &events {
        ids.extend(e.actor_id);
        ids.extend(assignee(e));
    }
    ids.extend(messages.iter().filter_map(|m| m.author_id));
    let people = people::load(&state.db, ids, locale).await?;

    let out_items = list
        .iter()
        .map(|i| {
            let (scope, reason) = engine::scope_for(
                &state.rx.formulary,
                i.drug_id.as_deref().unwrap_or(""),
                i.controlled_level.clamp(0, 4) as u8,
            );
            ItemOut {
                id: i.id,
                prescription_id: i.prescription_id,
                drug: i.drug(),
                dose_text: if locale.is_en() && !i.dose_text_en.is_empty() {
                    i.dose_text_en.clone()
                } else {
                    i.dose_text.clone()
                },
                scope,
                scope_reason: reason.get(locale).to_string(),
                engine: i.engine_result().map(|r| ItemEngineOut {
                    disposition: r.disposition,
                    fired: r.fired.iter().map(|f| f.to_out(locale)).collect(),
                }),
                refill: i
                    .refill
                    .as_ref()
                    .and_then(|stored| refill_result(state, stored, locale)),
                decision: i.outcome.clone().map(|outcome| DecisionOut {
                    // A physician's reason for approving against the checks is for staff.
                    note: i
                        .outcome_note
                        .clone()
                        .filter(|_| staff || outcome != "approve"),
                    outcome,
                    by: people.get(i.decided_by),
                    at: i.decided_at.map(rfc3339),
                }),
            }
        })
        .collect();
    let out = RequestOut {
        id: request.id,
        no: request.no.clone(),
        kind: request.kind,
        status: request.status,
        revision: request.revision,
        patient: people.get(Some(request.patient_id)),
        items: out_items,
        step: request.step.clone(),
        answers: request.answers.clone(),
        monitoring: request.monitoring.clone(),
        questions: questions(state, request.kind, &list, locale),
        engine: request
            .engine_snapshot()
            .map(|(o, at)| o.to_out(locale, staff, request.alerted(), at)),
        pharmacy: shop.map(|p| p.to_out(locale)),
        pickup_window: request.pickup_window.clone(),
        assigned_to: people.get(request.assigned_to),
        priority: request.priority,
        sla_due_at: request.sla_due_at.map(rfc3339),
        overdue: request.overdue(state.clock.now()),
        decision_note: if staff {
            request.decision_note.clone()
        } else {
            request.patient_message.clone()
        },
        created_at: rfc3339(request.created_at),
        submitted_at: request.submitted_at.map(rfc3339),
        updated_at: rfc3339(request.updated_at),
        timeline: events
            .iter()
            .map(|e| EventOut {
                at: rfc3339(e.at),
                kind: e.kind.clone(),
                actor: people.get(e.actor_id),
                text: event_text(
                    &e.kind,
                    &e.data,
                    people
                        .get(assignee(e))
                        .map(|p| p.display_name)
                        .unwrap_or_default()
                        .as_str(),
                    staff,
                    locale,
                ),
                visibility: e.visibility.clone(),
            })
            .collect(),
        messages: messages
            .into_iter()
            .map(|m| MessageOut {
                id: m.id,
                author: people.get(m.author_id),
                body: m.body,
                created_at: rfc3339(m.created_at),
                visibility: m.visibility,
            })
            .collect(),
        allowed_actions: machine::allowed_actions(request.kind, request.status, viewer),
    };
    serde_json::to_value(out)
        .map_err(anyhow::Error::from)
        .map_err(AppError::from)
}

/// Like [`view`], from the database as it is now.
pub async fn view_fresh(state: &AppState, id: Uuid, user: &CurrentUser) -> AppResult<Value> {
    let request = find(&state.db, id).await?.ok_or(AppError::NotFound)?;
    view(state, &request, user).await
}

/// Marks a request as read by this person (for `unread`).
pub async fn mark_read(db: &PgPool, request: Uuid, account: Uuid) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO rx_reads (request_id, account_id) VALUES ($1, $2) ON CONFLICT (request_id, account_id) DO UPDATE SET read_at = clock_timestamp()")
        .bind(request)
        .bind(account)
        .execute(db)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct BriefRow {
    pub id: Uuid,
    no: String,
    kind: String,
    #[sqlx(try_from = "String")]
    status: RxStatus,
    priority: String,
    patient_id: Uuid,
    drugs_zh: Vec<String>,
    drugs_en: Vec<String>,
    disposition: Option<String>,
    assigned_to: Option<Uuid>,
    submitted_at: Option<OffsetDateTime>,
    sla_due_at: Option<OffsetDateTime>,
    pub updated_at: OffsetDateTime,
    unread: bool,
}

/// `$1` is the reader, `$2` whether staff-only lines count for them.
macro_rules! brief_select {
    () => {
        "SELECT r.id, r.no, r.kind, r.status, r.priority, r.patient_id, r.disposition, r.assigned_to, r.submitted_at, r.sla_due_at, r.updated_at,
                ARRAY(SELECT p.name_zh FROM rx_request_items i JOIN prescriptions p ON p.id = i.prescription_id WHERE i.request_id = r.id ORDER BY i.position) AS drugs_zh,
                ARRAY(SELECT CASE WHEN p.name_en = '' THEN p.name_zh ELSE p.name_en END FROM rx_request_items i JOIN prescriptions p ON p.id = i.prescription_id WHERE i.request_id = r.id ORDER BY i.position) AS drugs_en,
                (r.status <> 'draft' AND (
                    EXISTS (SELECT 1 FROM rx_events e WHERE e.request_id = r.id AND e.actor_id IS DISTINCT FROM $1 AND ($2 OR e.visibility = 'all')
                              AND e.at > COALESCE((SELECT x.read_at FROM rx_reads x WHERE x.request_id = r.id AND x.account_id = $1), '-infinity'))
                 OR EXISTS (SELECT 1 FROM rx_messages m WHERE m.request_id = r.id AND m.author_id IS DISTINCT FROM $1 AND ($2 OR m.visibility = 'all')
                              AND m.created_at > COALESCE((SELECT x.read_at FROM rx_reads x WHERE x.request_id = r.id AND x.account_id = $1), '-infinity')))) AS unread
         FROM rx_requests r JOIN accounts pa ON pa.id = r.patient_id "
    };
}

/// Whether the search text (`$n`) matches the number, the patient or a medicine.
macro_rules! brief_search {
    ($n:literal) => {
        concat!(
            "($", $n, "::text IS NULL OR r.no ILIKE $", $n, " OR pa.display_name ILIKE $", $n, " OR pa.display_name_en ILIKE $", $n,
            " OR EXISTS (SELECT 1 FROM rx_request_items i JOIN prescriptions p ON p.id = i.prescription_id WHERE i.request_id = r.id AND (p.name_zh ILIKE $", $n, " OR p.name_en ILIKE $", $n, ")))"
        )
    };
}

pub async fn briefs(state: &AppState, rows: &[BriefRow], locale: Locale) -> AppResult<Vec<Value>> {
    let mut ids: Vec<Uuid> = rows.iter().map(|r| r.patient_id).collect();
    ids.extend(rows.iter().filter_map(|r| r.assigned_to));
    let people = people::load(&state.db, ids, locale).await?;
    let now = state.clock.now();
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "no": r.no,
                "kind": r.kind,
                "status": r.status,
                "priority": r.priority,
                "patient": people.get(Some(r.patient_id)),
                "drug_names": if locale.is_en() { &r.drugs_en } else { &r.drugs_zh },
                "disposition": r.disposition,
                "assigned_to": people.get(r.assigned_to),
                "submitted_at": r.submitted_at.map(rfc3339),
                "sla_due_at": r.sla_due_at.map(rfc3339),
                "overdue": r.status.waits_for_physician() && r.sla_due_at.is_some_and(|d| d < now),
                "updated_at": rfc3339(r.updated_at),
                "unread": r.unread,
            })
        })
        .collect())
}

/// `RxRequestBrief[]` of one patient as `reader` sees them (home page, patient page). Staff never get drafts.
/// The caller has checked that the reader may see this patient.
#[allow(dead_code)]
pub async fn briefs_for(
    state: &AppState,
    patient: Uuid,
    reader: &CurrentUser,
    open_only: bool,
) -> AppResult<Vec<Value>> {
    let own = reader.id == patient;
    let rows: Vec<BriefRow> = sqlx::query_as(concat!(
        brief_select!(),
        "WHERE r.patient_id = $3 AND ($4 OR r.status <> 'draft') AND (NOT $5 OR r.status NOT IN ('declined', 'visit_required', 'dispensed', 'cancelled')) ORDER BY r.updated_at DESC, r.id DESC LIMIT 100"
    ))
    .bind(reader.id)
    .bind(!own)
    .bind(patient)
    .bind(own)
    .bind(open_only)
    .fetch_all(&state.db)
    .await?;
    briefs(state, &rows, reader.locale).await
}

pub struct ListFilter<'a> {
    pub statuses: Option<Vec<String>>,
    pub kind: Option<&'a str>,
    pub q: Option<String>,
    pub before: Option<crate::page::Cursor>,
    pub limit: i64,
}

/// A page of requests: a patient's own, or everything but drafts for staff. One row more than `limit` is fetched.
pub async fn list(
    db: &PgPool,
    user: &CurrentUser,
    filter: &ListFilter<'_>,
) -> sqlx::Result<Vec<BriefRow>> {
    let staff = user.can(Permission::RxRead);
    sqlx::query_as(concat!(
        brief_select!(),
        "WHERE (($2 AND r.status <> 'draft') OR (NOT $2 AND r.patient_id = $1)) AND ($3::text[] IS NULL OR r.status = ANY($3)) AND ($4::text IS NULL OR r.kind = $4)
           AND ($5::timestamptz IS NULL OR (r.updated_at, r.id) < ($5, $6)) AND ",
        brief_search!(8),
        " ORDER BY r.updated_at DESC, r.id DESC LIMIT $7"
    ))
    .bind(user.id)
    .bind(staff)
    .bind(&filter.statuses)
    .bind(filter.kind)
    .bind(filter.before.map(|c| c.at))
    .bind(filter.before.map(|c| c.id))
    .bind(filter.limit + 1)
    .bind(&filter.q)
    .fetch_all(db)
    .await
}

pub const BUCKETS: [&str; 7] = [
    "mine",
    "unassigned",
    "urgent",
    "overdue",
    "more_info",
    "pharmacy",
    "done",
];

/// The bucket conditions, shared by the list and the counts. `$1` the reader, `$3` now.
macro_rules! in_bucket {
    ("mine") => {
        "(r.assigned_to = $1 AND r.status NOT IN ('declined', 'visit_required', 'dispensed', 'cancelled'))"
    };
    ("unassigned") => {
        "(r.assigned_to IS NULL AND r.status IN ('submitted', 'in_review', 'returned'))"
    };
    ("urgent") => {
        "(r.priority = 'urgent' AND r.status NOT IN ('declined', 'visit_required', 'dispensed', 'cancelled'))"
    };
    ("overdue") => {
        "(r.status IN ('submitted', 'in_review') AND r.sla_due_at < $3)"
    };
    ("more_info") => {
        "(r.status = 'more_info')"
    };
    ("pharmacy") => {
        "(r.status IN ('at_pharmacy', 'ready') OR (r.kind = 'refill' AND r.status IN ('submitted', 'returned')))"
    };
    ("done") => {
        "(r.status IN ('declined', 'visit_required', 'dispensed', 'cancelled') AND r.submitted_at IS NOT NULL)"
    };
}

/// One bucket of the staff queue: urgent first, then whatever is due first. `bucket = None` is everything still open.
pub async fn queue(
    state: &AppState,
    user: &CurrentUser,
    bucket: Option<&str>,
    q: Option<String>,
    offset: i64,
    limit: i64,
) -> sqlx::Result<Vec<BriefRow>> {
    sqlx::query_as(concat!(
        brief_select!(),
        "WHERE $2 AND r.status <> 'draft' AND CASE $4::text WHEN 'mine' THEN ", in_bucket!("mine"),
        " WHEN 'unassigned' THEN ", in_bucket!("unassigned"),
        " WHEN 'urgent' THEN ", in_bucket!("urgent"),
        " WHEN 'overdue' THEN ", in_bucket!("overdue"),
        " WHEN 'more_info' THEN ", in_bucket!("more_info"),
        " WHEN 'pharmacy' THEN ", in_bucket!("pharmacy"),
        " WHEN 'done' THEN ", in_bucket!("done"),
        " ELSE r.status NOT IN ('declined', 'visit_required', 'dispensed', 'cancelled') END AND ",
        brief_search!(7),
        " ORDER BY CASE WHEN $4 = 'done' THEN NULL WHEN r.priority = 'urgent' THEN 0 ELSE 1 END, CASE WHEN $4 = 'done' THEN NULL ELSE r.sla_due_at END NULLS LAST, r.updated_at DESC, r.id OFFSET $5 LIMIT $6"
    ))
    .bind(user.id)
    .bind(true)
    .bind(state.clock.now())
    .bind(bucket)
    .bind(offset)
    .bind(limit + 1)
    .bind(q)
    .fetch_all(&state.db)
    .await
}

pub async fn queue_counts(state: &AppState, user: &CurrentUser) -> sqlx::Result<Value> {
    type Counts = (i64, i64, i64, i64, i64, i64, i64);
    let c: Counts = sqlx::query_as(concat!(
        "SELECT COUNT(*) FILTER (WHERE ",
        in_bucket!("mine"),
        "), COUNT(*) FILTER (WHERE ",
        in_bucket!("unassigned"),
        "), COUNT(*) FILTER (WHERE ",
        in_bucket!("urgent"),
        "), COUNT(*) FILTER (WHERE ",
        in_bucket!("overdue"),
        "), COUNT(*) FILTER (WHERE ",
        in_bucket!("more_info"),
        "), COUNT(*) FILTER (WHERE ",
        in_bucket!("pharmacy"),
        "), COUNT(*) FILTER (WHERE ",
        in_bucket!("done"),
        ") FROM rx_requests r WHERE $2 AND r.status <> 'draft'"
    ))
    .bind(user.id)
    .bind(true)
    .bind(state.clock.now())
    .fetch_one(&state.db)
    .await?;
    let values = [c.0, c.1, c.2, c.3, c.4, c.5, c.6];
    Ok(BUCKETS
        .iter()
        .zip(values)
        .map(|(b, n)| (b.to_string(), json!(n)))
        .collect::<Map<_, _>>()
        .into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::{date, datetime};

    #[test]
    fn numbers_are_dated_and_padded() {
        assert_eq!(format_no(date!(2026 - 11 - 25), 1), "RX-20261125-0001");
    }

    #[test]
    fn urgency_only_goes_up() {
        assert_eq!(more_urgent(Urgency::Routine, Urgency::Soon), Urgency::Soon);
        assert_eq!(
            more_urgent(Urgency::Urgent, Urgency::Routine),
            Urgency::Urgent
        );
    }

    fn question(id: &str, kind: &'static str) -> QuestionOut {
        QuestionOut {
            id: id.into(),
            scope: "monitoring",
            class_id: None,
            kind,
            label: String::new(),
            help: None,
            options: Vec::new(),
            unit: None,
            min: None,
            max: None,
            required: false,
            max_age_days: Some(90),
        }
    }

    #[test]
    fn monitoring_is_prefilled_from_the_newest_matching_measurement() {
        let row = |kind: &str, values: Value, day: u8, source: &str| MeasurementRow {
            kind: kind.into(),
            values,
            taken_at: datetime!(2026-11-01 02:00 UTC) + Duration::days(i64::from(day)),
            source: source.into(),
        };
        let rows = [
            row(
                "bp",
                json!({"systolic": 132, "diastolic": 80}),
                20,
                "patient",
            ),
            row(
                "lab",
                json!({"name": "HbA1c", "value": 6.8, "unit": "%"}),
                10,
                "clinic",
            ),
            row(
                "lab",
                json!({"name": "糖化血色素 HbA1c", "value": 7.4}),
                2,
                "clinic",
            ),
            row("lab", json!({"name": "eGFR", "value": 72}), 1, "clinic"),
        ];
        let questions = [
            question("bp_check", "date"),
            question("a1c", "number"),
            question("egfr_annual", "date"),
            question("egfr_metformin", "number"),
            question("tsh_test", "date"),
        ];
        let out = prefill(&questions, &rows);
        assert_eq!(out["bp_check"].date.as_deref(), Some("2026-11-21"));
        assert_eq!(out["bp_check"].value, None);
        assert_eq!(out["a1c"].value, Some(6.8));
        assert_eq!(out["a1c"].source, Source::Clinic);
        assert_eq!(out["egfr_annual"].value, None);
        assert_eq!(out["egfr_metformin"].value, Some(72.0));
        assert!(!out.contains_key("tsh_test"));
    }

    #[test]
    fn every_event_has_a_text_for_both_readers() {
        for kind in [
            ev::CREATED,
            ev::SUBMITTED,
            ev::ITEMS_LEFT_OUT,
            ev::URGENT,
            ev::ASSIGNED,
            ev::UNASSIGNED,
            ev::REVIEW_STARTED,
            ev::APPROVED,
            ev::PARTIALLY_APPROVED,
            ev::DECLINED,
            ev::VISIT_REQUIRED,
            ev::MORE_INFO,
            ev::REPLIED,
            ev::SENT_TO_PHARMACY,
            ev::ACCEPTED,
            ev::READY,
            ev::DISPENSED,
            ev::FILL_RECORDED,
            ev::NEXT_PRESCRIPTION,
            ev::RETURNED,
            ev::ASKED_PHYSICIAN,
            ev::CANCELLED,
            ev::OVERDUE,
        ] {
            let data = json!({"category": "chest_pain", "from_text": true, "label": "胸痛", "label_en": "Chest pain", "n": 2, "note": "缺貨", "pharmacy": "甲藥局", "pharmacy_en": "A Pharmacy", "drugs": "某藥", "drugs_en": "Drug"});
            for staff in [true, false] {
                for locale in [Locale::ZhTw, Locale::En] {
                    let text = event_text(kind, &data, "陳醫師", staff, locale);
                    assert!(!text.contains('{'), "{kind}: {text}");
                    assert_ne!(text, rt(R::EvOther, locale), "{kind}");
                }
            }
        }
        let patient = event_text(
            ev::URGENT,
            &json!({"category": "suicide", "label": "x"}),
            "",
            false,
            Locale::ZhTw,
        );
        assert!(patient.contains("1925"));
    }
}
