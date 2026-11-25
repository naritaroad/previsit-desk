//! Demo data from `data/seed/demo/*.json`: the five default accounts, the guest personas, the panel of fictional
//! patients, pharmacies and the physician's weekly schedule. Days in the files are relative to the day they are loaded.
//!
//! The panel and the shared demo patient are rebuilt by `POST /admin/demo/reset`, when the files change
//! ([`DEMO_VERSION`]) and when they are a week old. Accounts that people made (registered, claimed, guest) are never
//! touched. Every guest gets an isolated copy of one persona.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use time::{Date, Duration, OffsetDateTime, Time};
use uuid::Uuid;

use crate::appts::taipei;
use crate::clock::{format_date, parse_date};
use crate::engine;
use crate::error::{AppError, AppResult};
use crate::intake::{FIELD_KEYS, IntakeState};
use crate::measure;
use crate::notes;
use crate::notify;
use crate::perm::{Permission, Role};
use crate::profile::{Lifestyle, ProfileItem};
use crate::refill::last_valid_day;
use crate::state::AppState;
use crate::summary::{self, SummaryInput};
use crate::texts::{T, t};
use crate::tickets;
use crate::types::{Locale, Stage, VisitStatus, message_kind};
use crate::visits;

pub const DEFAULT_PERSONA: &str = "lin";
/// Bump when the files or the loader change; the next start rebuilds the demo data.
pub const DEMO_VERSION: i64 = 1;
const MAX_AGE_DAYS: i64 = 7;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeedAccount {
    pub key: String,
    pub username: String,
    pub role: Role,
    pub display_name: String,
    pub display_name_en: Option<String>,
    pub title: Option<String>,
    pub title_en: Option<String>,
    pub avatar: Option<String>,
}

/// Text with an optional English variant: `"中文"` or `["中文", "English"]`.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum Text {
    Pair([String; 2]),
    One(String),
}

impl Text {
    fn get(&self, locale: Locale) -> &str {
        match self {
            Text::One(text) => text,
            Text::Pair([zh, en]) => {
                if locale.is_en() {
                    en
                } else {
                    zh
                }
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ItemSpec {
    name: String,
    name_en: Option<String>,
    detail: Option<String>,
    detail_en: Option<String>,
    since: Option<String>,
    source: String,
}

impl ItemSpec {
    fn item(&self, locale: Locale) -> ProfileItem {
        let pick = |zh: &Option<String>, en: &Option<String>| {
            if locale.is_en() {
                en.clone().or_else(|| zh.clone())
            } else {
                zh.clone()
            }
        };
        ProfileItem {
            id: Uuid::new_v4().to_string(),
            name: pick(&Some(self.name.clone()), &self.name_en).unwrap_or_default(),
            detail: pick(&self.detail, &self.detail_en),
            since: self.since.clone(),
            source: self.source.clone(),
            status: "active".into(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct LifestyleSpec {
    smoking: Option<String>,
    smoking_en: Option<String>,
    alcohol: Option<String>,
    alcohol_en: Option<String>,
    exercise: Option<String>,
    exercise_en: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct CareSpec {
    status: String,
    #[serde(default)]
    tags: Vec<String>,
    last_contact: Option<i64>,
}

/// `points`: `[day, value]`, or `[day, systolic, diastolic]` for blood pressure.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct MeasurementSpec {
    kind: String,
    name: Option<String>,
    unit: Option<String>,
    time: String,
    #[serde(default)]
    source: Option<String>,
    points: Vec<Vec<f64>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrescriptionSpec {
    drug_id: String,
    dose: String,
    dose_en: String,
    issued: i64,
    total_days: i64,
    days_per_fill: i64,
    fills_allowed: i64,
    fills: Vec<(i64, String)>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct NoteSpec {
    assessment: String,
    plan: String,
    patient_message: Text,
    #[serde(default)]
    addenda: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct TicketSpec {
    reason: String,
    urgency: String,
    summary: String,
    created_by: String,
    resolved_by: Option<String>,
    resolution: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct VisitSpec {
    key: String,
    #[serde(default)]
    day: i64,
    /// Day for a guest's copy, so it stays inside the retention period.
    guest_day: Option<i64>,
    time: Option<String>,
    /// Instead of day and time: this long before now.
    minutes_ago: Option<i64>,
    status: VisitStatus,
    mode: Option<String>,
    assigned: Option<String>,
    appointment: Option<String>,
    /// `[role, zh]` or `[role, zh, en]`; role is `patient`, `assistant` or `staff:<account key>`.
    messages: Vec<Vec<String>>,
    intake: Map<String, Value>,
    /// Field key -> indexes into `messages`.
    #[serde(default)]
    evidence: BTreeMap<String, Vec<usize>>,
    #[serde(default)]
    follow_up: Vec<String>,
    note: Option<NoteSpec>,
    ticket: Option<TicketSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct AppointmentSpec {
    key: String,
    day: i64,
    time: String,
    department: String,
    department_en: String,
    mode: String,
    room: Option<String>,
    reason: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    age: i32,
    sex: String,
    height_cm: f64,
    conditions: Vec<ItemSpec>,
    medications: Vec<ItemSpec>,
    allergies: Vec<ItemSpec>,
    family_history: Vec<ItemSpec>,
    lifestyle: LifestyleSpec,
    preferred_pharmacy: String,
    care: CareSpec,
    measurements: Vec<MeasurementSpec>,
    prescriptions: Vec<PrescriptionSpec>,
    visits: Vec<VisitSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Persona {
    pub id: String,
    pub display_name: String,
    pub display_name_en: String,
    pub age_band: String,
    pub summary_zh: String,
    pub summary_en: String,
    record: Record,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct StaffNoteSpec {
    by: String,
    day: i64,
    time: String,
    body: String,
    pinned: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ContactSpec {
    by: String,
    day: i64,
    time: String,
    channel: String,
    body: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PanelPatient {
    key: String,
    display_name: String,
    display_name_en: String,
    record: Record,
    notes: Vec<StaffNoteSpec>,
    contacts: Vec<ContactSpec>,
    appointments: Vec<AppointmentSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PharmacySpec {
    id: String,
    name: String,
    name_en: String,
    district: String,
    district_en: String,
    address: String,
    address_en: String,
    hours: String,
    hours_en: String,
    services: Vec<String>,
    services_en: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScheduleSpec {
    weekdays: Vec<i16>,
    starts: String,
    ends: String,
    minutes: i32,
    department: String,
    department_en: String,
    mode: String,
    room: Option<String>,
}

/// The formulary columns a prescription copies.
#[derive(Debug, Clone)]
struct Drug {
    name_zh: String,
    name_en: String,
    class_id: String,
    class_zh: String,
    class_en: String,
    controlled_level: i16,
}

pub struct DemoData {
    pub accounts: Vec<SeedAccount>,
    pub personas: Vec<Persona>,
    panel: Vec<PanelPatient>,
    pharmacies: Vec<PharmacySpec>,
    schedule: Vec<ScheduleSpec>,
    drugs: HashMap<String, Drug>,
}

fn read<T: DeserializeOwned>(dir: &Path, name: &str) -> Result<T> {
    let path = dir.join(name);
    let text =
        std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .with_context(|| format!("check {}", path.display()))
}

fn read_drugs(path: &Path) -> Result<HashMap<String, Drug>> {
    let text = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let mut reader =
        csv::ReaderBuilder::new().from_reader(text.trim_start_matches('\u{feff}').as_bytes());
    let headers = reader.headers()?.clone();
    let col = |name: &str| {
        headers
            .iter()
            .position(|h| h.trim() == name)
            .with_context(|| format!("{}: missing column {name}", path.display()))
    };
    let (id, zh, en, class, class_zh, class_en, level) = (
        col("drug_id")?,
        col("name_zh")?,
        col("name_en")?,
        col("class_id")?,
        col("class_zh")?,
        col("class_en")?,
        col("controlled_level")?,
    );
    let mut out = HashMap::new();
    for row in reader.records() {
        let row = row?;
        let get = |i: usize| row.get(i).unwrap_or("").trim().to_string();
        out.insert(
            get(id),
            Drug {
                name_zh: get(zh),
                name_en: get(en),
                class_id: get(class),
                class_zh: get(class_zh),
                class_en: get(class_en),
                controlled_level: get(level).parse().unwrap_or(0),
            },
        );
    }
    Ok(out)
}

fn parse_time(text: &str) -> Option<Time> {
    Time::parse(text, time::macros::format_description!("[hour]:[minute]")).ok()
}

impl DemoData {
    pub fn load(data_dir: &Path) -> Result<Self> {
        let seed = data_dir.join("seed");
        let dir = seed.join("demo");
        let data = Self {
            accounts: read(&dir, "accounts.json")?,
            personas: read(&dir, "personas.json")?,
            panel: read(&dir, "panel.json")?,
            pharmacies: read(&dir, "pharmacies.json")?,
            schedule: read(&dir, "schedule.json")?,
            drugs: read_drugs(&seed.join("formulary.csv"))?,
        };
        data.check()?;
        Ok(data)
    }

    pub fn panel_len(&self) -> usize {
        self.panel.len()
    }

    fn check(&self) -> Result<()> {
        for key in ["admin", "physician", "pharmacist", "coordinator", "patient"] {
            let Some(account) = self.accounts.iter().find(|a| a.key == key) else {
                bail!("accounts.json: {key} is missing");
            };
            if account.role.as_str() != key {
                bail!("accounts.json: {key} has role {}", account.role.as_str());
            }
        }
        for id in ["lin", "chang", "wu"] {
            if self.persona(id).is_none() {
                bail!("personas.json: {id} is missing");
            }
        }
        for spec in &self.schedule {
            if parse_time(&spec.starts).is_none() || parse_time(&spec.ends).is_none() {
                bail!("schedule.json: bad time {}-{}", spec.starts, spec.ends);
            }
        }
        let records = self
            .personas
            .iter()
            .map(|p| (p.id.as_str(), &p.record))
            .chain(self.panel.iter().map(|p| (p.key.as_str(), &p.record)));
        for (who, record) in records {
            self.check_record(record).with_context(|| who.to_string())?;
        }
        for patient in &self.panel {
            for key in patient
                .record
                .visits
                .iter()
                .filter_map(|v| v.appointment.as_ref())
            {
                if !patient.appointments.iter().any(|a| a.key == *key) {
                    bail!("{}: no appointment {key}", patient.key);
                }
            }
        }
        Ok(())
    }

    fn check_record(&self, record: &Record) -> Result<()> {
        if !self
            .pharmacies
            .iter()
            .any(|p| p.id == record.preferred_pharmacy)
        {
            bail!("unknown pharmacy {}", record.preferred_pharmacy);
        }
        for rx in &record.prescriptions {
            if !self.drugs.contains_key(&rx.drug_id) {
                bail!("drug {} is not in formulary.csv", rx.drug_id);
            }
            if rx.fills.len() as i64 > rx.fills_allowed
                || rx.days_per_fill * rx.fills_allowed < rx.total_days
                || rx.fills.iter().any(|(day, _)| *day > 0)
            {
                bail!("{}: fills do not add up", rx.drug_id);
            }
            if let Some((_, pharmacy)) = rx
                .fills
                .iter()
                .find(|(_, id)| !self.pharmacies.iter().any(|p| p.id == *id))
            {
                bail!("unknown pharmacy {pharmacy}");
            }
        }
        for m in &record.measurements {
            parse_time(&m.time).with_context(|| format!("bad time {}", m.time))?;
            for point in &m.points {
                let values = point_values(m, point)
                    .with_context(|| format!("{}: bad point {point:?}", m.kind))?;
                let map = values.as_object().cloned().unwrap_or_default();
                if let Err(e) = measure::clean_values(&m.kind, &map, Locale::ZhTw) {
                    bail!("{}: {e:?}", m.kind);
                }
            }
        }
        for visit in &record.visits {
            let n = visit.messages.len();
            for message in &visit.messages {
                let role = message.first().map(String::as_str).unwrap_or("");
                if message.len() < 2
                    || !(role == "patient" || role == "assistant" || role.starts_with("staff:"))
                {
                    bail!("{}: bad message", visit.key);
                }
            }
            if visit.evidence.values().flatten().any(|i| *i >= n) {
                bail!("{}: evidence points past the last message", visit.key);
            }
            for locale in [Locale::ZhTw, Locale::En] {
                intake_state(&visit.intake, locale).with_context(|| visit.key.clone())?;
            }
            if visit.minutes_ago.is_none() && visit.time.as_deref().and_then(parse_time).is_none() {
                bail!("{}: needs time or minutes_ago", visit.key);
            }
        }
        Ok(())
    }

    pub fn persona(&self, id: &str) -> Option<&Persona> {
        self.personas.iter().find(|p| p.id == id)
    }

    pub fn persona_cards(&self) -> Vec<Value> {
        self.personas
            .iter()
            .map(|p| {
                json!({ "id": p.id, "display_name": p.display_name, "display_name_en": p.display_name_en, "age_band": p.age_band, "summary_zh": p.summary_zh, "summary_en": p.summary_en })
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

fn point_values(spec: &MeasurementSpec, point: &[f64]) -> Option<Value> {
    match (spec.kind.as_str(), point) {
        ("bp", [_, systolic, diastolic]) => {
            Some(json!({ "systolic": systolic, "diastolic": diastolic, "unit": "mmHg" }))
        }
        ("glucose", [_, v]) => Some(json!({ "value": v, "unit": "mg/dL" })),
        ("weight", [_, v]) => Some(json!({ "value": v, "unit": "kg" })),
        ("pulse", [_, v]) => Some(json!({ "value": v, "unit": "bpm" })),
        ("lab", [_, v]) => Some(json!({ "value": v, "name": spec.name, "unit": spec.unit })),
        _ => None,
    }
}

/// Text fields hold `"zh"` or `["zh", "en"]`; list fields hold a list of those.
fn intake_state(spec: &Map<String, Value>, locale: Locale) -> Result<IntakeState> {
    let mut state = IntakeState::default();
    let text = |value: &Value| -> Result<Value> {
        let text: Text = serde_json::from_value(value.clone())?;
        Ok(json!(text.get(locale)))
    };
    for (key, value) in spec {
        let is_list = matches!(
            key.as_str(),
            "past_history" | "medications" | "allergies" | "patient_questions"
        );
        if !is_list && !FIELD_KEYS.contains(&key.as_str()) {
            bail!("unknown intake field {key}");
        }
        let value = match value {
            Value::Number(_) => value.clone(),
            Value::Array(items) if is_list => {
                Value::Array(items.iter().map(text).collect::<Result<_>>()?)
            }
            other => text(other)?,
        };
        state
            .set_field(key, &value)
            .map_err(|e| anyhow::anyhow!("{key}: {e:?}"))?;
    }
    Ok(state)
}

/// A stable id for a demo row, so links survive a rebuild.
fn demo_uuid(name: &str) -> Uuid {
    let digest = Sha256::digest(format!("previsit-demo:{name}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

/// The default staff accounts, by key; an account without a password in the environment does not exist.
type Staff = HashMap<String, Uuid>;

async fn staff(state: &AppState) -> sqlx::Result<Staff> {
    let rows: Vec<(String, Uuid)> = sqlx::query_as(
        "SELECT demo_key, id FROM accounts WHERE demo_key IN ('admin', 'physician', 'pharmacist', 'coordinator', 'patient') AND username IS NOT NULL AND NOT is_guest",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(rows.into_iter().collect())
}

struct Loader<'a> {
    state: &'a AppState,
    staff: Staff,
    today: Date,
    now: OffsetDateTime,
    locale: Locale,
    guest: bool,
}

/// What has to wait for the commit, because it uses the pool.
#[derive(Default)]
struct After {
    /// Visits whose last patient message must go through the red-flag rules.
    red_flags: Vec<(Uuid, Uuid, OffsetDateTime)>,
    /// Submitted visits and the follow-up questions of their summary.
    summaries: Vec<(Uuid, Vec<String>)>,
    /// `(visit, signed at)` with the note to write.
    notes: Vec<(Uuid, OffsetDateTime, NoteSpec)>,
    /// Patients who submitted today, for the staff's notifications.
    submitted: Vec<(Uuid, Uuid)>,
}

impl Loader<'_> {
    fn at(&self, day: i64, time: &str) -> OffsetDateTime {
        let date = self
            .today
            .checked_add(Duration::days(day))
            .unwrap_or(self.today);
        date.with_time(parse_time(time).unwrap_or(Time::MIDNIGHT))
            .assume_offset(taipei())
    }

    async fn record(
        &self,
        tx: &mut PgConnection,
        patient: Uuid,
        key: &str,
        record: &Record,
        appointments: &HashMap<String, Uuid>,
        after: &mut After,
    ) -> AppResult<()> {
        let locale = self.locale;
        let items = |list: &[ItemSpec]| {
            serde_json::to_value(list.iter().map(|i| i.item(locale)).collect::<Vec<_>>())
                .unwrap_or(json!([]))
        };
        let life = &record.lifestyle;
        let pick = |zh: &Option<String>, en: &Option<String>| {
            if locale.is_en() {
                en.clone().or_else(|| zh.clone())
            } else {
                zh.clone()
            }
        };
        let lifestyle = Lifestyle {
            smoking: pick(&life.smoking, &life.smoking_en),
            alcohol: pick(&life.alcohol, &life.alcohol_en),
            exercise: pick(&life.exercise, &life.exercise_en),
        };
        sqlx::query(
            "INSERT INTO patient_profiles (account_id, birth_year, sex, height_cm, conditions, medications, allergies, family_history, lifestyle, preferred_pharmacy_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (account_id) DO UPDATE SET birth_year = $2, sex = $3, height_cm = $4, conditions = $5, medications = $6, allergies = $7, family_history = $8, lifestyle = $9, preferred_pharmacy_id = $10, revision = patient_profiles.revision + 1, updated_at = now()",
        )
        .bind(patient)
        .bind(self.today.year() - record.age)
        .bind(&record.sex)
        .bind(record.height_cm)
        .bind(items(&record.conditions))
        .bind(items(&record.medications))
        .bind(items(&record.allergies))
        .bind(items(&record.family_history))
        .bind(serde_json::to_value(lifestyle).unwrap_or(json!({})))
        .bind(&record.preferred_pharmacy)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO patient_care (account_id, tags, care_status, physician_id, coordinator_id, last_contact_at) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (account_id) DO UPDATE SET tags = $2, care_status = $3, physician_id = $4, coordinator_id = $5, last_contact_at = $6, updated_at = now()",
        )
        .bind(patient)
        .bind(&record.care.tags)
        .bind(&record.care.status)
        .bind(self.staff.get("physician"))
        .bind(self.staff.get("coordinator"))
        .bind(
            record
                .care
                .last_contact
                .map(|day| self.at(day, "10:00").min(self.now)),
        )
        .execute(&mut *tx)
        .await?;

        for m in &record.measurements {
            for point in &m.points {
                sqlx::query("INSERT INTO measurements (patient_id, kind, \"values\", taken_at, source, recorded_by, is_demo) VALUES ($1, $2, $3, $4, $5, $6, true)")
                    .bind(patient)
                    .bind(&m.kind)
                    .bind(point_values(m, point).unwrap_or(json!({})))
                    .bind(self.at(point[0] as i64, &m.time).min(self.now))
                    .bind(m.source.as_deref().unwrap_or("patient"))
                    .bind(if m.source.is_some() {
                        self.staff.get("physician").copied()
                    } else {
                        Some(patient)
                    })
                    .execute(&mut *tx)
                    .await?;
            }
        }
        for rx in &record.prescriptions {
            self.prescription(tx, patient, key, rx).await?;
        }
        for visit in &record.visits {
            self.visit(tx, patient, key, visit, appointments, after)
                .await?;
        }
        Ok(())
    }

    async fn prescription(
        &self,
        tx: &mut PgConnection,
        patient: Uuid,
        key: &str,
        rx: &PrescriptionSpec,
    ) -> AppResult<()> {
        let Some(drug) = self.state.demo.drugs.get(&rx.drug_id) else {
            return Ok(());
        };
        let day = |n: i64| {
            self.today
                .checked_add(Duration::days(n))
                .unwrap_or(self.today)
        };
        let issued = day(rx.issued);
        let id = if self.guest {
            Uuid::new_v4()
        } else {
            demo_uuid(&format!("rx:{key}:{}", rx.drug_id))
        };
        sqlx::query(
            "INSERT INTO prescriptions (id, patient_id, source, drug_id, name_zh, name_en, class_id, class_zh, class_en, controlled_level, dose_text, dose_text_en, issued_on, total_days, days_per_fill, fills_allowed, valid_until, prescriber_id, is_demo, created_at)
             VALUES ($1, $2, 'clinic', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, true, $18)",
        )
        .bind(id)
        .bind(patient)
        .bind(&rx.drug_id)
        .bind(&drug.name_zh)
        .bind(&drug.name_en)
        .bind(&drug.class_id)
        .bind(&drug.class_zh)
        .bind(&drug.class_en)
        .bind(drug.controlled_level)
        .bind(&rx.dose)
        .bind(&rx.dose_en)
        .bind(issued)
        .bind(rx.total_days as i32)
        .bind(rx.days_per_fill as i32)
        .bind(rx.fills_allowed as i32)
        .bind(last_valid_day(issued, rx.total_days))
        .bind(self.staff.get("physician"))
        .bind(self.at(rx.issued, "11:00"))
        .execute(&mut *tx)
        .await?;
        for (i, (fill_day, pharmacy)) in rx.fills.iter().enumerate() {
            let name = self
                .state
                .demo
                .pharmacies
                .iter()
                .find(|p| p.id == *pharmacy)
                .map(|p| p.name.as_str())
                .unwrap_or("");
            sqlx::query("INSERT INTO fills (prescription_id, n, filled_on, pharmacy_id, pharmacy_name, dispensed_by) VALUES ($1, $2, $3, $4, $5, $6)")
                .bind(id)
                .bind(i as i32 + 1)
                .bind(day(*fill_day))
                .bind(pharmacy)
                .bind(name)
                .bind(self.staff.get("pharmacist"))
                .execute(&mut *tx)
                .await?;
        }
        Ok(())
    }

    async fn visit(
        &self,
        tx: &mut PgConnection,
        patient: Uuid,
        key: &str,
        spec: &VisitSpec,
        appointments: &HashMap<String, Uuid>,
        after: &mut After,
    ) -> AppResult<()> {
        let locale = self.locale;
        let id = if self.guest {
            Uuid::new_v4()
        } else {
            demo_uuid(&format!("visit:{key}:{}", spec.key))
        };
        let gap = Duration::seconds(40);
        let length = gap * spec.messages.len() as i32;
        let day = if self.guest {
            spec.guest_day.unwrap_or(spec.day)
        } else {
            spec.day
        };
        let start = match spec.minutes_ago {
            Some(minutes) => self.now - Duration::minutes(minutes),
            None => self
                .at(day, spec.time.as_deref().unwrap_or("09:00"))
                .min(self.now - length - Duration::minutes(5)),
        };
        let end = start + length;
        let intake = intake_state(&spec.intake, locale).map_err(AppError::Internal)?;
        let closed = matches!(spec.status, VisitStatus::Submitted | VisitStatus::Reviewed);
        let stage = if closed { Stage::Done } else { intake.stage() };
        let reviewed_at = (spec.status == VisitStatus::Reviewed)
            .then(|| (end + Duration::hours(2)).min(self.now - Duration::minutes(1)));
        let physician = self.staff.get("physician").copied();
        // A red flag is raised after the commit, by the same code a live message goes through.
        let status = match spec.status {
            VisitStatus::RedFlag => VisitStatus::Active,
            other => other,
        };
        sqlx::query(
            "INSERT INTO visits (id, locale, status, stage, intake, created_at, updated_at, last_activity_at, submitted_at, reviewed_at, reviewed_by_id, patient_id, appointment_id, title, mode, assigned_to, summary_revision, is_demo)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1, $16)",
        )
        .bind(id)
        .bind(locale.as_str())
        .bind(status.as_str())
        .bind(stage.as_str())
        .bind(serde_json::to_value(&intake).unwrap_or(json!({})))
        .bind(start)
        .bind(reviewed_at.unwrap_or(end))
        .bind(closed.then_some(end))
        .bind(reviewed_at)
        .bind(reviewed_at.and(physician))
        .bind(patient)
        .bind(
            spec.appointment
                .as_ref()
                .and_then(|k| appointments.get(k))
                .copied(),
        )
        .bind(
            intake
                .chief_complaint
                .as_deref()
                .and_then(visits::title_from),
        )
        .bind(spec.mode.as_deref().unwrap_or("ai"))
        .bind(
            spec.assigned
                .as_ref()
                .and_then(|k| self.staff.get(k))
                .copied(),
        )
        .bind(!self.guest)
        .execute(&mut *tx)
        .await?;

        let mut ids: Vec<Uuid> = Vec::new();
        let mut last_patient = None;
        for (i, message) in spec.messages.iter().enumerate() {
            let (role, author) = match message[0].strip_prefix("staff:") {
                Some(key) => ("staff", self.staff.get(key).copied()),
                None if message[0] == "patient" => ("patient", Some(patient)),
                None => ("assistant", None),
            };
            let opening = i == 0 && role == "assistant";
            let content = if opening {
                t(T::Opening, locale)
            } else if locale.is_en() {
                message.get(2).unwrap_or(&message[1]).as_str()
            } else {
                message[1].as_str()
            };
            let seq = i as i64 + 1;
            let at = start + gap * i as i32;
            let kind = if opening {
                message_kind::OPENING
            } else {
                message_kind::CHAT
            };
            let message_id: Uuid = sqlx::query_scalar("INSERT INTO messages (visit_id, role, kind, content, seq, author_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id")
                .bind(id)
                .bind(role)
                .bind(kind)
                .bind(content)
                .bind(seq)
                .bind(author)
                .bind(at)
                .fetch_one(&mut *tx)
                .await?;
            sqlx::query("INSERT INTO visit_events (visit_id, seq, type, data, created_at) VALUES ($1, $2, 'message.created', $3, $4)")
                .bind(id)
                .bind(seq)
                .bind(json!({ "id": message_id, "client_id": null, "seq": seq, "role": role, "kind": kind, "author": null, "content": content, "created_at": visits::rfc3339(at), "run_id": null, "status": "ok" }))
                .bind(at)
                .execute(&mut *tx)
                .await?;
            if role == "patient" {
                last_patient = Some(message_id);
            }
            ids.push(message_id);
        }
        let evidence: BTreeMap<&String, Vec<Uuid>> = spec
            .evidence
            .iter()
            .map(|(field, at)| (field, at.iter().map(|i| ids[*i]).collect()))
            .collect();
        sqlx::query("UPDATE visits SET last_seq = $2, evidence = $3 WHERE id = $1")
            .bind(id)
            .bind(ids.len() as i64)
            .bind(json!(evidence))
            .execute(&mut *tx)
            .await?;
        // The patient has seen their own conversation.
        sqlx::query("INSERT INTO visit_reads (visit_id, account_id, seq) VALUES ($1, $2, $3)")
            .bind(id)
            .bind(patient)
            .bind(ids.len() as i64)
            .execute(&mut *tx)
            .await?;

        if let Some(ticket) = &spec.ticket {
            self.ticket(tx, id, patient, ticket, end).await?;
        }
        if closed {
            after.summaries.push((id, spec.follow_up.clone()));
        }
        if spec.status == VisitStatus::Submitted && !self.guest {
            after.submitted.push((id, patient));
        }
        if let (Some(note), Some(at)) = (&spec.note, reviewed_at) {
            after.notes.push((id, at, note.clone()));
        }
        if let (VisitStatus::RedFlag, Some(message)) = (spec.status, last_patient) {
            after.red_flags.push((id, message, end));
        }
        Ok(())
    }

    async fn ticket(
        &self,
        tx: &mut PgConnection,
        visit: Uuid,
        patient: Uuid,
        spec: &TicketSpec,
        at: OffsetDateTime,
    ) -> AppResult<()> {
        let n: i32 = sqlx::query_scalar("INSERT INTO ticket_counters (day, n) VALUES ($1, 1) ON CONFLICT (day) DO UPDATE SET n = ticket_counters.n + 1 RETURNING n")
            .bind(self.today)
            .fetch_one(&mut *tx)
            .await?;
        let resolver = spec
            .resolved_by
            .as_ref()
            .and_then(|k| self.staff.get(k))
            .copied();
        sqlx::query(
            "INSERT INTO clinician_tickets (ticket_no, visit_id, patient_id, reason, urgency, summary, created_by, created_at, status, resolved_at, resolved_by, resolved_by_id, resolution_note)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9::uuid IS NULL THEN 'open' ELSE 'resolved' END, CASE WHEN $9::uuid IS NULL THEN NULL ELSE $8 END, (SELECT display_name FROM accounts WHERE id = $9), $9, $10)",
        )
        .bind(tickets::format_ticket_no(self.today, n))
        .bind(visit)
        .bind(patient)
        .bind(&spec.reason)
        .bind(&spec.urgency)
        .bind(&spec.summary)
        .bind(&spec.created_by)
        .bind(at)
        .bind(resolver)
        .bind(&spec.resolution)
        .execute(&mut *tx)
        .await?;
        Ok(())
    }

    /// `(key -> id)` of the patient's appointments. A slot someone real already booked is left alone.
    async fn appointments(
        &self,
        tx: &mut PgConnection,
        patient: Uuid,
        specs: &[AppointmentSpec],
    ) -> AppResult<HashMap<String, Uuid>> {
        let mut out = HashMap::new();
        let Some(physician) = self.staff.get("physician") else {
            return Ok(out);
        };
        for spec in specs {
            let starts_at = self.at(spec.day, &spec.time);
            let status = if starts_at + Duration::minutes(20) < self.now {
                "completed"
            } else if starts_at - Duration::minutes(15) < self.now {
                "checked_in"
            } else {
                "booked"
            };
            let id: Option<Uuid> = sqlx::query_scalar(
                "INSERT INTO appointments (patient_id, physician_id, department, department_en, starts_at, minutes, mode, status, reason, room, is_demo)
                 VALUES ($1, $2, $3, $4, $5, 15, $6, $7, $8, $9, true) ON CONFLICT DO NOTHING RETURNING id",
            )
            .bind(patient)
            .bind(physician)
            .bind(&spec.department)
            .bind(&spec.department_en)
            .bind(starts_at)
            .bind(&spec.mode)
            .bind(status)
            .bind(&spec.reason)
            .bind(&spec.room)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(id) = id {
                out.insert(spec.key.clone(), id);
            }
        }
        Ok(out)
    }

    /// Summaries, signed notes and red flags, once the rows are committed.
    async fn finish(&self, after: After) -> AppResult<()> {
        let db = &self.state.db;
        for (id, follow_up) in &after.summaries {
            let intake = visits::load_intake(db, *id).await?;
            let built = summary::build(SummaryInput {
                visit_id: *id,
                intake: &intake,
                locale: self.locale,
                flags: Vec::new(),
                refill: None,
                narrative: None,
                model: None,
                follow_up: follow_up.clone(),
                now: self.now,
            });
            summary::save(db, &built).await?;
        }
        for (id, at, note) in &after.notes {
            let Some(physician) = self.staff.get("physician") else {
                break;
            };
            let Some(visit) = visits::fetch(db, *id, OffsetDateTime::UNIX_EPOCH).await? else {
                continue;
            };
            let subjective = summary::load(db, *id)
                .await?
                .map(|s| notes::subjective_text(&s, Locale::ZhTw))
                .unwrap_or_default();
            let objective = match visit.patient_id {
                Some(patient) => measure::objective_text(db, patient, Locale::ZhTw).await?,
                None => String::new(),
            };
            let sections = json!({
                "subjective": subjective,
                "objective": objective,
                "assessment": note.assessment,
                "plan": note.plan,
                "patient_message": note.patient_message.get(self.locale),
            });
            sqlx::query("INSERT INTO clinical_notes (visit_id, revision, version, status, sections, author_id, signed_by, signed_at, created_at, updated_at) VALUES ($1, 2, 1, 'signed', $2, $3, $3, $4, $4, $4)")
                .bind(id)
                .bind(&sections)
                .bind(physician)
                .bind(at)
                .execute(db)
                .await?;
            sqlx::query("INSERT INTO note_versions (visit_id, version, sections, by_id, at) VALUES ($1, 1, $2, $3, $4)")
                .bind(id)
                .bind(&sections)
                .bind(physician)
                .bind(at)
                .execute(db)
                .await?;
            for body in &note.addenda {
                sqlx::query(
                    "INSERT INTO note_addenda (visit_id, body, by_id, at) VALUES ($1, $2, $3, $4)",
                )
                .bind(id)
                .bind(body)
                .bind(physician)
                .bind(*at + Duration::hours(3))
                .execute(db)
                .await?;
            }
        }
        for (id, message, at) in &after.red_flags {
            let content: String = sqlx::query_scalar("SELECT content FROM messages WHERE id = $1")
                .bind(message)
                .fetch_one(db)
                .await?;
            let Some(matched) = self.state.rules.red_flags.check(&content) else {
                tracing::warn!("a demo red-flag message no longer matches a rule");
                continue;
            };
            let Some(visit) = visits::fetch(db, *id, OffsetDateTime::UNIX_EPOCH).await? else {
                continue;
            };
            engine::raise_red_flag(self.state, &visit, &matched, Some(*message), None, None)
                .await?;
            for sql in [
                "UPDATE messages SET created_at = $2 WHERE visit_id = $1 AND kind = 'red_flag'",
                "UPDATE red_flag_events SET created_at = $2 WHERE visit_id = $1",
                "UPDATE clinician_tickets SET created_at = $2 WHERE visit_id = $1",
                "UPDATE visits SET last_activity_at = $2 WHERE id = $1",
            ] {
                sqlx::query(sql).bind(id).bind(at).execute(db).await?;
            }
        }
        for (visit, patient) in &after.submitted {
            notify::notify_staff(
                self.state,
                Permission::VisitReview,
                notify::Kind::VisitSubmitted,
                json!({ "patient_id": patient }),
                &format!("/clinic/visits/{visit}"),
                None,
            )
            .await;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Guests
// ---------------------------------------------------------------------------

/// A new guest sandbox: an isolated copy of one persona, deleted after the retention period.
pub async fn create_guest(
    state: &AppState,
    persona: &str,
    locale: Locale,
) -> AppResult<(Uuid, OffsetDateTime)> {
    let Some(p) = state.demo.persona(persona) else {
        return Err(AppError::NotFound);
    };
    let expires = state.clock.now() + Duration::days(state.settings.get().retention_days);
    let loader = Loader {
        state,
        staff: staff(state).await?,
        today: state.clock.today(),
        now: state.clock.now(),
        locale,
        guest: true,
    };
    let mut after = After::default();
    let mut tx = state.db.begin().await?;
    let id: Uuid = sqlx::query_scalar("INSERT INTO accounts (display_name, display_name_en, role, locale, is_guest, demo_key, expires_at) VALUES ($1, $2, 'patient', $3, true, $4, $5) RETURNING id")
        .bind(&p.display_name)
        .bind(&p.display_name_en)
        .bind(locale.as_str())
        .bind(persona)
        .bind(expires)
        .fetch_one(&mut *tx)
        .await?;
    loader
        .record(&mut tx, id, persona, &p.record, &HashMap::new(), &mut after)
        .await?;
    tx.commit().await?;
    loader.finish(after).await?;
    crate::rx::seed_guest_requests(state, id, persona).await?;
    Ok((id, expires))
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

const KEY: &str = "demo";

/// Pharmacies and the physician's schedule alone: what a guest record refers to. The eval runner uses it.
pub async fn ensure_reference(state: &AppState) -> AppResult<()> {
    let loader = Loader {
        state,
        staff: staff(state).await?,
        today: state.clock.today(),
        now: state.clock.now(),
        locale: Locale::ZhTw,
        guest: true,
    };
    load_reference(state, &loader).await
}

async fn load_reference(state: &AppState, loader: &Loader<'_>) -> AppResult<()> {
    for (i, p) in state.demo.pharmacies.iter().enumerate() {
        sqlx::query(
            "INSERT INTO pharmacies (id, name, name_en, district, district_en, address, address_en, hours, hours_en, services, services_en, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (id) DO UPDATE SET name = $2, name_en = $3, district = $4, district_en = $5, address = $6, address_en = $7, hours = $8, hours_en = $9, services = $10, services_en = $11, position = $12",
        )
        .bind(&p.id)
        .bind(&p.name)
        .bind(&p.name_en)
        .bind(&p.district)
        .bind(&p.district_en)
        .bind(&p.address)
        .bind(&p.address_en)
        .bind(&p.hours)
        .bind(&p.hours_en)
        .bind(json!(p.services))
        .bind(json!(p.services_en))
        .bind(i as i32)
        .execute(&state.db)
        .await?;
    }
    if let Some(physician) = loader.staff.get("physician") {
        let mut tx = state.db.begin().await?;
        sqlx::query("DELETE FROM schedule_templates WHERE physician_id = $1")
            .bind(physician)
            .execute(&mut *tx)
            .await?;
        for spec in &state.demo.schedule {
            for weekday in &spec.weekdays {
                sqlx::query("INSERT INTO schedule_templates (physician_id, weekday, starts, ends, minutes, department, department_en, mode, room) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)")
                    .bind(physician)
                    .bind(weekday)
                    .bind(parse_time(&spec.starts))
                    .bind(parse_time(&spec.ends))
                    .bind(spec.minutes)
                    .bind(&spec.department)
                    .bind(&spec.department_en)
                    .bind(&spec.mode)
                    .bind(&spec.room)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        tx.commit().await?;
    }
    Ok(())
}

/// Rebuilds the panel patients and the shared demo patient. Other accounts keep everything.
pub async fn reset(state: &AppState) -> AppResult<Value> {
    let loader = Loader {
        state,
        staff: staff(state).await?,
        today: state.clock.today(),
        now: state.clock.now(),
        locale: Locale::ZhTw,
        guest: false,
    };
    load_reference(state, &loader).await?;
    let shared = loader.staff.get("patient").copied();
    let mut after = After::default();
    let mut tx = state.db.begin().await?;
    // One rebuild at a time.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('previsit-demo', 0))")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM accounts WHERE is_demo AND role = 'patient' AND username IS NULL")
        .execute(&mut *tx)
        .await?;
    if let Some(shared) = shared {
        for sql in [
            "DELETE FROM rx_requests WHERE patient_id = $1",
            "DELETE FROM prescriptions WHERE patient_id = $1",
            "DELETE FROM visits WHERE patient_id = $1",
            "DELETE FROM appointments WHERE patient_id = $1",
            "DELETE FROM measurements WHERE patient_id = $1",
            "DELETE FROM staff_notes WHERE patient_id = $1",
            "DELETE FROM contact_log WHERE patient_id = $1",
            "DELETE FROM clinician_tickets WHERE patient_id = $1",
            "DELETE FROM access_log WHERE patient_id = $1",
            "DELETE FROM consents WHERE account_id = $1",
            "DELETE FROM drafts WHERE account_id = $1",
            "DELETE FROM idempotency_keys WHERE account_id = $1",
        ] {
            sqlx::query(sql).bind(shared).execute(&mut *tx).await?;
        }
    }
    // Links in the demo accounts' notifications pointed at what was just rebuilt.
    sqlx::query("DELETE FROM notifications n USING accounts a WHERE a.id = n.account_id AND a.is_demo AND NOT a.is_guest")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM drafts d USING accounts a WHERE a.id = d.account_id AND a.is_demo")
        .execute(&mut *tx)
        .await?;
    if let (Some(shared), Some(persona)) = (shared, state.demo.persona(DEFAULT_PERSONA)) {
        let next = AppointmentSpec {
            key: "next".into(),
            day: 2,
            time: "10:30".into(),
            department: "慢性病門診".into(),
            department_en: "Chronic care clinic".into(),
            mode: "in_person".into(),
            room: Some("第 3 診間".into()),
            reason: "慢性病回診".into(),
        };
        loader.appointments(&mut tx, shared, &[next]).await?;
        loader
            .record(
                &mut tx,
                shared,
                "patient",
                &persona.record,
                &HashMap::new(),
                &mut after,
            )
            .await?;
    }
    for p in &state.demo.panel {
        let id = demo_uuid(&format!("patient:{}", p.key));
        sqlx::query("INSERT INTO accounts (id, display_name, display_name_en, role, is_demo, demo_key, created_at) VALUES ($1, $2, $3, 'patient', true, $4, $5)")
            .bind(id)
            .bind(&p.display_name)
            .bind(&p.display_name_en)
            .bind(&p.key)
            .bind(loader.at(-120, "09:00"))
            .execute(&mut *tx)
            .await?;
        let appointments = loader.appointments(&mut tx, id, &p.appointments).await?;
        loader
            .record(&mut tx, id, &p.key, &p.record, &appointments, &mut after)
            .await?;
        for note in &p.notes {
            sqlx::query("INSERT INTO staff_notes (patient_id, author_id, body, pinned, is_demo, created_at) VALUES ($1, $2, $3, $4, true, $5)")
                .bind(id)
                .bind(loader.staff.get(&note.by))
                .bind(&note.body)
                .bind(note.pinned)
                .bind(loader.at(note.day, &note.time).min(loader.now))
                .execute(&mut *tx)
                .await?;
        }
        for contact in &p.contacts {
            sqlx::query("INSERT INTO contact_log (patient_id, author_id, channel, body, created_at) VALUES ($1, $2, $3, $4, $5)")
                .bind(id)
                .bind(loader.staff.get(&contact.by))
                .bind(&contact.channel)
                .bind(&contact.body)
                .bind(loader.at(contact.day, &contact.time).min(loader.now))
                .execute(&mut *tx)
                .await?;
        }
    }
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, revision = app_settings.revision + 1, updated_at = now()")
        .bind(KEY)
        .bind(json!({ "version": DEMO_VERSION, "seeded_on": format_date(loader.today) }))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    loader.finish(after).await?;
    crate::rx::seed_demo_requests(state).await?;
    state.hub.to_permission(
        Permission::VisitRead,
        "queue.changed",
        json!({ "name": "all" }),
    );
    Ok(json!({
        "patients": state.demo.panel.len(),
        "shared_patient": shared.is_some(),
        "pharmacies": state.demo.pharmacies.len(),
    }))
}

/// Loads the demo data when it is missing, from older files, or a week old; on other days makes sure today's
/// schedule has the panel's appointments.
pub async fn ensure(state: &AppState) -> AppResult<()> {
    let stored: Option<Value> = sqlx::query_scalar("SELECT value FROM app_settings WHERE key = $1")
        .bind(KEY)
        .fetch_optional(&state.db)
        .await?;
    let today = state.clock.today();
    let fresh = stored.as_ref().is_some_and(|v| {
        v["version"] == json!(DEMO_VERSION)
            && v["seeded_on"]
                .as_str()
                .and_then(parse_date)
                .is_some_and(|day| (today - day).whole_days() < MAX_AGE_DAYS)
    });
    if !fresh {
        let report = reset(state).await?;
        tracing::info!(%report, "demo data loaded");
        return Ok(());
    }
    let any_today: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM appointments WHERE is_demo AND (starts_at AT TIME ZONE 'Asia/Taipei')::date = $1 AND status <> 'cancelled')")
        .bind(today)
        .fetch_one(&state.db)
        .await?;
    if any_today {
        return Ok(());
    }
    let loader = Loader {
        state,
        staff: staff(state).await?,
        today,
        now: state.clock.now(),
        locale: Locale::ZhTw,
        guest: false,
    };
    let mut tx = state.db.begin().await?;
    for p in &state.demo.panel {
        let id = demo_uuid(&format!("patient:{}", p.key));
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM accounts WHERE id = $1)")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        if exists {
            let current: Vec<AppointmentSpec> = p
                .appointments
                .iter()
                .filter(|a| a.day == 0)
                .cloned()
                .collect();
            loader.appointments(&mut tx, id, &current).await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> DemoData {
        DemoData::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../data")).expect("demo data")
    }

    #[test]
    fn the_shipped_files_are_valid() {
        let data = data();
        assert_eq!(data.accounts.len(), 5);
        assert_eq!(data.personas.len(), 3);
        assert_eq!(data.panel.len(), 8);
        assert!(data.pharmacies.len() >= 3);
        assert_eq!(data.persona_cards()[0]["id"], "lin");
        assert!(
            data.persona_cards()[0].get("record").is_none(),
            "cards carry no record"
        );
    }

    #[test]
    fn demo_chief_complaints_and_messages_match_their_status() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/seed");
        let rules =
            crate::precheck::RedFlagRules::load(&root.join("red_flags.csv")).expect("rules");
        let data = data();
        let visits = data
            .personas
            .iter()
            .flat_map(|p| &p.record.visits)
            .chain(data.panel.iter().flat_map(|p| &p.record.visits));
        let mut flagged = 0;
        for visit in visits {
            let hit = visit
                .messages
                .iter()
                .filter(|m| m[0] == "patient")
                .any(|m| m[1..].iter().any(|text| rules.check(text).is_some()));
            assert_eq!(
                hit,
                visit.status == VisitStatus::RedFlag,
                "{}: red-flag rules and status disagree",
                visit.key
            );
            flagged += i32::from(hit);
        }
        assert_eq!(flagged, 1);
    }

    #[test]
    fn the_personas_cover_the_refill_and_renewal_situations() {
        let data = data();
        let lin = &data.persona("lin").expect("lin").record;
        let last = |drug: &str| {
            let rx = lin
                .prescriptions
                .iter()
                .find(|p| p.drug_id == drug)
                .expect("drug");
            (
                rx.fills.len() as i64,
                rx.fills_allowed,
                rx.fills.last().expect("fill").0,
            )
        };
        let (done, allowed, day) = last("losartan");
        assert!(done < allowed && day + 28 - 10 <= 0, "window open today");
        let (done, allowed, day) = last("metformin");
        assert!(done == allowed && day + 28 <= 7, "nearly finished");
        let wu = &data.persona("wu").expect("wu").record;
        assert!(wu.prescriptions.iter().any(|p| p.drug_id == "zolpidem"));
        assert_eq!(data.drugs["zolpidem"].controlled_level, 4);
    }

    #[test]
    fn no_demo_text_uses_simplified_characters_or_mainland_terms() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/seed/demo");
        for name in [
            "accounts.json",
            "personas.json",
            "panel.json",
            "pharmacies.json",
            "schedule.json",
        ] {
            let text = std::fs::read_to_string(dir.join(name)).expect("file");
            for c in "这们说时来还与实务该请问药医烧疗诊热无么发过对为".chars()
            {
                assert!(!text.contains(c), "{name}: simplified {c}");
            }
            for term in ["視頻", "軟件", "網絡", "信息", "默認", "質量", "用戶"] {
                assert!(!text.contains(term), "{name}: {term}");
            }
        }
    }

    #[test]
    fn demo_ids_are_stable_and_distinct() {
        assert_eq!(demo_uuid("visit:a"), demo_uuid("visit:a"));
        assert_ne!(demo_uuid("visit:a"), demo_uuid("visit:b"));
    }
}
