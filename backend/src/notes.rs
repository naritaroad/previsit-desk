//! Clinical notes (contract §5). The program drafts S and O from what the patient said and measured; A, P and the
//! message to the patient are written by people. A signed note is locked; later changes are addenda.

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::audit::{self, AuditKind};
use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::events;
use crate::http::ApiJson;
use crate::intake::{NOT_APPLICABLE, Severity};
use crate::measure;
use crate::notify;
use crate::people::{self, PersonRef};
use crate::perm::Permission;
use crate::state::AppState;
use crate::summary::PrevisitSummary;
use crate::texts::{T, field_label, fmt, t};
use crate::types::{Locale, Visit, VisitStatus};
use crate::visit_routes::staff_visit;
use crate::visits;

const MAX_SECTION_CHARS: usize = 4000;
const MAX_ADDENDUM_CHARS: usize = 2000;
const AI_DRAFTED: [&str; 2] = ["subjective", "objective"];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sections {
    #[serde(default)]
    pub subjective: String,
    #[serde(default)]
    pub objective: String,
    #[serde(default)]
    pub assessment: String,
    #[serde(default)]
    pub plan: String,
    #[serde(default)]
    pub patient_message: String,
}

impl Sections {
    fn check(&self, locale: Locale) -> AppResult<()> {
        for (name, text) in [
            ("sections.subjective", &self.subjective),
            ("sections.objective", &self.objective),
            ("sections.assessment", &self.assessment),
            ("sections.plan", &self.plan),
            ("sections.patient_message", &self.patient_message),
        ] {
            if text.chars().count() > MAX_SECTION_CHARS {
                return Err(AppError::field(
                    name,
                    fmt(
                        T::FieldErrLength,
                        locale,
                        &[("min", "0"), ("max", &MAX_SECTION_CHARS.to_string())],
                    ),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Addendum {
    pub body: String,
    pub by: Option<PersonRef>,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize)]
pub struct Version {
    pub version: i32,
    pub by: Option<PersonRef>,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClinicalNote {
    pub revision: i32,
    pub version: i32,
    pub status: String,
    pub sections: Sections,
    pub ai_drafted: [&'static str; 2],
    pub author: Option<PersonRef>,
    pub signed_by: Option<PersonRef>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub signed_at: Option<OffsetDateTime>,
    pub addenda: Vec<Addendum>,
    pub history: Vec<Version>,
}

impl ClinicalNote {
    /// What the patient may see: nothing before signing, then only the message to them and who signed it.
    pub fn for_patient(self) -> Option<Self> {
        if self.status != "signed" {
            return None;
        }
        Some(Self {
            sections: Sections {
                patient_message: self.sections.patient_message,
                ..Sections::default()
            },
            author: None,
            addenda: Vec::new(),
            history: Vec::new(),
            ..self
        })
    }
}

#[derive(sqlx::FromRow)]
struct NoteRow {
    revision: i32,
    version: i32,
    status: String,
    sections: Value,
    author_id: Option<Uuid>,
    signed_by: Option<Uuid>,
    signed_at: Option<OffsetDateTime>,
}

/// The stored note of a visit.
pub async fn load(
    db: &PgPool,
    visit_id: Uuid,
    locale: Locale,
) -> sqlx::Result<Option<ClinicalNote>> {
    let row: Option<NoteRow> = sqlx::query_as("SELECT revision, version, status, sections, author_id, signed_by, signed_at FROM clinical_notes WHERE visit_id = $1")
        .bind(visit_id)
        .fetch_optional(db)
        .await?;
    let Some(row) = row else { return Ok(None) };
    let addenda: Vec<(String, Option<Uuid>, OffsetDateTime)> = sqlx::query_as(
        "SELECT body, by_id, at FROM note_addenda WHERE visit_id = $1 ORDER BY at, id",
    )
    .bind(visit_id)
    .fetch_all(db)
    .await?;
    let versions: Vec<(i32, Option<Uuid>, OffsetDateTime)> = sqlx::query_as(
        "SELECT version, by_id, at FROM note_versions WHERE visit_id = $1 ORDER BY version DESC",
    )
    .bind(visit_id)
    .fetch_all(db)
    .await?;
    let people = people::load(
        db,
        [row.author_id, row.signed_by]
            .into_iter()
            .chain(addenda.iter().map(|a| a.1))
            .chain(versions.iter().map(|v| v.1))
            .flatten(),
        locale,
    )
    .await?;
    Ok(Some(ClinicalNote {
        revision: row.revision,
        version: row.version,
        status: row.status,
        sections: serde_json::from_value(row.sections).unwrap_or_default(),
        ai_drafted: AI_DRAFTED,
        author: people.get(row.author_id),
        signed_by: people.get(row.signed_by),
        signed_at: row.signed_at,
        addenda: addenda
            .into_iter()
            .map(|(body, by, at)| Addendum {
                body,
                by: people.get(by),
                at,
            })
            .collect(),
        history: versions
            .into_iter()
            .map(|(version, by, at)| Version {
                version,
                by: people.get(by),
                at,
            })
            .collect(),
    }))
}

// ---------------------------------------------------------------------------
// The first draft
// ---------------------------------------------------------------------------

/// S: the patient's own words, field by field.
pub fn subjective_text(summary: &PrevisitSummary, locale: Locale) -> String {
    let (colon, sep, list_sep) = if locale.is_en() {
        (": ", "; ", ", ")
    } else {
        ("：", "；", "、")
    };
    let shown = |text: &str| {
        if text == NOT_APPLICABLE {
            t(T::NotApplicable, locale).to_string()
        } else {
            text.to_string()
        }
    };
    let mut lines: Vec<String> = Vec::new();
    if let Some(text) = &summary.chief_complaint {
        lines.push(format!(
            "{}{colon}{}",
            field_label("chief_complaint", locale),
            shown(text)
        ));
    }
    let h = &summary.hpi;
    let mut hpi: Vec<String> = Vec::new();
    for (key, value) in [
        ("hpi.onset", &h.onset),
        ("hpi.course", &h.course),
        ("hpi.location", &h.location),
        ("hpi.character", &h.character),
        ("hpi.modifiers", &h.modifiers),
        ("hpi.associated", &h.associated),
    ] {
        if let Some(text) = value {
            hpi.push(format!(
                "{}{colon}{}",
                field_label(key, locale),
                shown(text)
            ));
        }
    }
    if let Some(Severity::Score(n)) = h.severity {
        hpi.push(format!(
            "{}{colon}{}",
            field_label("hpi.severity", locale),
            fmt(T::SeverityOutOf, locale, &[("n", &n.to_string())])
        ));
    }
    if !hpi.is_empty() {
        lines.push(hpi.join(sep));
    }
    for (key, items) in [
        ("past_history", &summary.past_history),
        ("medications", &summary.medications),
        ("allergies", &summary.allergies),
    ] {
        if summary.not_collected.iter().any(|k| k == key) {
            continue;
        }
        let text = if items.is_empty() {
            t(T::NoneLabel, locale).to_string()
        } else {
            items.join(list_sep)
        };
        lines.push(format!("{}{colon}{text}", field_label(key, locale)));
    }
    if !summary.patient_questions.is_empty() {
        lines.push(format!(
            "{}{colon}{}",
            t(T::PatientQuestionsLabel, locale),
            summary.patient_questions.join(sep)
        ));
    }
    if !summary.not_collected.is_empty() {
        let fields: Vec<&str> = summary
            .not_collected
            .iter()
            .map(|k| field_label(k, locale))
            .collect();
        lines.push(format!(
            "{}{colon}{}",
            t(T::NotCollectedLabel, locale),
            fields.join(list_sep)
        ));
    }
    lines.join("\n")
}

async fn draft(state: &AppState, visit: &Visit, locale: Locale) -> AppResult<ClinicalNote> {
    let subjective = visits::current_summary(&state.db, &state.rules, visit, state.clock.now())
        .await?
        .map(|s| subjective_text(&s, locale))
        .unwrap_or_default();
    let objective = match visit.patient_id {
        Some(patient) => measure::objective_text(&state.db, patient, locale).await?,
        None => String::new(),
    };
    Ok(ClinicalNote {
        revision: 0,
        version: 0,
        status: "draft".into(),
        sections: Sections {
            subjective,
            objective,
            ..Sections::default()
        },
        ai_drafted: AI_DRAFTED,
        author: None,
        signed_by: None,
        signed_at: None,
        addenda: Vec::new(),
        history: Vec::new(),
    })
}

async fn current(state: &AppState, visit: &Visit, locale: Locale) -> AppResult<ClinicalNote> {
    match load(&state.db, visit.id, locale).await? {
        Some(note) => Ok(note),
        None => draft(state, visit, locale).await,
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<ClinicalNote>> {
    let visit = staff_visit(&state, &user, &id, Permission::VisitRead, "note").await?;
    Ok(Json(current(&state, &visit, user.locale).await?))
}

#[derive(Deserialize)]
pub struct PutNote {
    revision: i32,
    sections: Sections,
}

/// A new version row starts when someone else edits, or when the last one is older than this; an autosave within the
/// window overwrites the current version.
const VERSION_WINDOW: &str = "10 minutes";

pub async fn put(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<PutNote>,
) -> AppResult<Json<ClinicalNote>> {
    let visit = staff_visit(&state, &user, &id, Permission::VisitReview, "note").await?;
    body.sections.check(user.locale)?;
    let sections = serde_json::to_value(&body.sections).map_err(anyhow::Error::from)?;
    let mut tx = state.db.begin().await?;
    // The visit row serialises writers of the same note.
    sqlx::query("SELECT 1 FROM visits WHERE id = $1 FOR UPDATE")
        .bind(visit.id)
        .execute(&mut *tx)
        .await?;
    let existing: Option<(i32, i32, String, Option<Uuid>)> = sqlx::query_as(
        "SELECT revision, version, status, author_id FROM clinical_notes WHERE visit_id = $1",
    )
    .bind(visit.id)
    .fetch_optional(&mut *tx)
    .await?;
    let version = match &existing {
        Some((_, _, status, _)) if status == "signed" => {
            return Err(AppError::InvalidState("a signed note takes addenda only"));
        }
        Some((revision, ..)) if *revision != body.revision => {
            drop(tx);
            return Err(AppError::stale(current(&state, &visit, user.locale).await?));
        }
        None if body.revision != 0 => {
            drop(tx);
            return Err(AppError::stale(current(&state, &visit, user.locale).await?));
        }
        None => {
            sqlx::query(
                "INSERT INTO clinical_notes (visit_id, sections, author_id) VALUES ($1, $2, $3)",
            )
            .bind(visit.id)
            .bind(&sections)
            .bind(user.id)
            .execute(&mut *tx)
            .await?;
            1
        }
        Some((_, version, _, author)) => {
            let fresh: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM note_versions WHERE visit_id = $1 AND version = $2 AND at > now() - $3::text::interval)",
            )
            .bind(visit.id)
            .bind(version)
            .bind(VERSION_WINDOW)
            .fetch_one(&mut *tx)
            .await?;
            let version = if *author == Some(user.id) && fresh {
                *version
            } else {
                version + 1
            };
            sqlx::query("UPDATE clinical_notes SET sections = $2, author_id = $3, revision = revision + 1, version = $4, updated_at = now() WHERE visit_id = $1")
                .bind(visit.id)
                .bind(&sections)
                .bind(user.id)
                .bind(version)
                .execute(&mut *tx)
                .await?;
            version
        }
    };
    sqlx::query(
        "INSERT INTO note_versions (visit_id, version, sections, by_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (visit_id, version) DO UPDATE SET sections = EXCLUDED.sections",
    )
    .bind(visit.id)
    .bind(version)
    .bind(&sections)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(current(&state, &visit, user.locale).await?))
}

#[derive(Deserialize)]
pub struct SignBody {
    revision: i32,
}

pub async fn sign(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<SignBody>,
) -> AppResult<Json<ClinicalNote>> {
    let visit = staff_visit(&state, &user, &id, Permission::NoteSign, "note").await?;
    if !matches!(visit.status, VisitStatus::Submitted | VisitStatus::RedFlag) {
        return Err(AppError::InvalidState(
            "only a submitted or red-flag visit can be signed off",
        ));
    }
    let Some(note) = load(&state.db, visit.id, user.locale).await? else {
        return Err(AppError::stale(draft(&state, &visit, user.locale).await?));
    };
    if note.status == "signed" {
        return Err(AppError::InvalidState("the note is already signed"));
    }
    if note.revision != body.revision {
        return Err(AppError::stale(note));
    }
    // A signature needs the physician's own judgement on the page.
    let mut missing = std::collections::BTreeMap::new();
    for (name, text) in [
        ("sections.assessment", &note.sections.assessment),
        ("sections.plan", &note.sections.plan),
    ] {
        if text.trim().is_empty() {
            missing.insert(
                name.to_string(),
                t(T::FieldErrSignature, user.locale).to_string(),
            );
        }
    }
    if !missing.is_empty() {
        return Err(AppError::Unprocessable(missing));
    }
    let mut tx = state.db.begin().await?;
    let signed = sqlx::query("UPDATE clinical_notes SET status = 'signed', signed_by = $2, signed_at = now(), revision = revision + 1, updated_at = now() WHERE visit_id = $1 AND status = 'draft' AND revision = $3")
        .bind(visit.id)
        .bind(user.id)
        .bind(body.revision)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if signed == 0 {
        drop(tx);
        return Err(AppError::stale(current(&state, &visit, user.locale).await?));
    }
    sqlx::query("UPDATE visits SET status = 'reviewed', reviewed_at = now(), reviewed_by = $2, reviewed_by_id = $3, updated_at = now() WHERE id = $1")
        .bind(visit.id)
        .bind(&user.display_name)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    audit::audit(
        &state.db,
        Some(&user),
        AuditKind::Clinic,
        "note.sign",
        &format!("visit:{}", visit.id),
        Value::Null,
    )
    .await;
    after_review(&state, &user, &visit).await?;
    Ok(Json(current(&state, &visit, user.locale).await?))
}

async fn after_review(state: &AppState, user: &CurrentUser, visit: &Visit) -> AppResult<()> {
    events::append(
        state,
        visit.id,
        "note.signed",
        json!({ "visit_id": visit.id, "by": user.person(visit.locale), "at": visits::rfc3339(state.clock.now()) }),
    )
    .await?;
    visits::emit_updated(state, visit.id).await?;
    visits::changed(state, visit.id, visit.patient_id, true);
    if let Some(patient) = visit.patient_id {
        notify::notify(
            state,
            patient,
            notify::Kind::VisitReviewed,
            json!({ "actor_id": user.id, "title": visits::display_title(visit, Locale::ZhTw), "title_en": visits::display_title(visit, Locale::En) }),
            &format!("/app/visits/{}", visit.id),
        )
        .await;
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct AddendumBody {
    body: String,
}

/// Adds to a signed note. A visit that went back to `red_flag` after signing is reviewed again by this.
pub async fn addendum(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<AddendumBody>,
) -> AppResult<Json<ClinicalNote>> {
    let visit = staff_visit(&state, &user, &id, Permission::NoteSign, "note").await?;
    let text = body.body.trim();
    let n = text.chars().count();
    if !(1..=MAX_ADDENDUM_CHARS).contains(&n) {
        return Err(AppError::field(
            "body",
            fmt(
                T::FieldErrLength,
                user.locale,
                &[("min", "1"), ("max", &MAX_ADDENDUM_CHARS.to_string())],
            ),
        ));
    }
    let added = sqlx::query("INSERT INTO note_addenda (visit_id, body, by_id) SELECT visit_id, $2, $3 FROM clinical_notes WHERE visit_id = $1 AND status = 'signed'")
        .bind(visit.id)
        .bind(text)
        .bind(user.id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if added == 0 {
        return Err(AppError::InvalidState("only a signed note takes addenda"));
    }
    audit::audit(
        &state.db,
        Some(&user),
        AuditKind::Clinic,
        "note.addendum",
        &format!("visit:{}", visit.id),
        Value::Null,
    )
    .await;
    if visit.status == VisitStatus::RedFlag {
        sqlx::query("UPDATE visits SET status = 'reviewed', reviewed_at = now(), reviewed_by = $2, reviewed_by_id = $3, updated_at = now() WHERE id = $1 AND status = 'red_flag'")
            .bind(visit.id)
            .bind(&user.display_name)
            .bind(user.id)
            .execute(&state.db)
            .await?;
        after_review(&state, &user, &visit).await?;
    }
    Ok(Json(current(&state, &visit, user.locale).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(status: &str) -> ClinicalNote {
        ClinicalNote {
            revision: 3,
            version: 1,
            status: status.into(),
            sections: Sections {
                subjective: "S".into(),
                objective: "O".into(),
                assessment: "A".into(),
                plan: "P".into(),
                patient_message: "多喝水".into(),
            },
            ai_drafted: AI_DRAFTED,
            author: None,
            signed_by: None,
            signed_at: None,
            addenda: vec![Addendum {
                body: "x".into(),
                by: None,
                at: OffsetDateTime::UNIX_EPOCH,
            }],
            history: vec![],
        }
    }

    #[test]
    fn patients_see_only_the_message_and_only_after_signing() {
        assert!(note("draft").for_patient().is_none());
        let shown = note("signed").for_patient().expect("note");
        assert_eq!(
            shown.sections,
            Sections {
                patient_message: "多喝水".into(),
                ..Sections::default()
            }
        );
        assert!(shown.addenda.is_empty());
    }

    #[test]
    fn the_program_never_drafts_assessment_or_plan() {
        assert_eq!(AI_DRAFTED, ["subjective", "objective"]);
    }
}
