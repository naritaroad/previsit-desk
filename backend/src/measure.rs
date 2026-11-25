//! Measurements: blood pressure, glucose, weight, pulse and lab values. Patients add their own (`patient`), the clinic's
//! come with the record (`clinic`).

use std::collections::BTreeMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::http::ApiJson;
use crate::idem::{self, IdempotencyKey};
use crate::intake::contains_personal_data;
use crate::notify::local_time;
use crate::page::{self, Cursor, Page, Params};
use crate::perm::Permission;
use crate::state::AppState;
use crate::texts::{T, fmt, t};
use crate::types::Locale;

const KINDS: [&str; 5] = ["bp", "glucose", "weight", "pulse", "lab"];
/// A patient can keep this many rows; far more than daily measuring for a year.
const MAX_ROWS: i64 = 2000;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Measurement {
    pub id: Uuid,
    pub kind: String,
    pub values: Value,
    #[serde(with = "time::serde::rfc3339")]
    pub taken_at: OffsetDateTime,
    pub source: String,
}

/// Newest first.
pub async fn for_patient(
    db: &PgPool,
    patient: Uuid,
    kind: Option<&str>,
    cursor: Option<Cursor>,
    limit: i64,
) -> sqlx::Result<Vec<Measurement>> {
    sqlx::query_as(
        "SELECT id, kind, \"values\", taken_at, source FROM measurements
         WHERE patient_id = $1 AND ($2::text IS NULL OR kind = $2) AND ($3::timestamptz IS NULL OR (taken_at, id) < ($3, $4))
         ORDER BY taken_at DESC, id DESC LIMIT $5",
    )
    .bind(patient)
    .bind(kind)
    .bind(cursor.map(|c| c.at))
    .bind(cursor.map(|c| c.id))
    .bind(limit)
    .fetch_all(db)
    .await
}

/// Checks and keeps only the fields that belong to `kind`.
pub fn clean_values(
    kind: &str,
    values: &Map<String, Value>,
    locale: Locale,
) -> Result<Value, BTreeMap<String, String>> {
    let mut errors = BTreeMap::new();
    let mut out = Map::new();
    let mut number =
        |name: &str, min: f64, max: f64, errors: &mut BTreeMap<String, String>| match values
            .get(name)
            .and_then(Value::as_f64)
        {
            Some(v) if (min..=max).contains(&v) => {
                out.insert(name.to_string(), json!(v));
                Some(v)
            }
            _ => {
                errors.insert(
                    format!("values.{name}"),
                    fmt(
                        T::FieldErrRange,
                        locale,
                        &[("min", &min.to_string()), ("max", &max.to_string())],
                    ),
                );
                None
            }
        };
    let mut unit = None;
    match kind {
        "bp" => {
            let systolic = number("systolic", 50.0, 260.0, &mut errors);
            let diastolic = number("diastolic", 30.0, 200.0, &mut errors);
            if let (Some(s), Some(d)) = (systolic, diastolic)
                && d >= s
            {
                errors.insert(
                    "values.diastolic".into(),
                    t(T::FieldErrDiastolic, locale).into(),
                );
            }
            unit = Some("mmHg");
        }
        "glucose" => {
            number("value", 20.0, 800.0, &mut errors);
            unit = Some("mg/dL");
        }
        "weight" => {
            number("value", 2.0, 350.0, &mut errors);
            unit = Some("kg");
        }
        "pulse" => {
            number("value", 20.0, 250.0, &mut errors);
            unit = Some("bpm");
        }
        "lab" => {
            number("value", 0.0, 100_000.0, &mut errors);
            for (name, max, required) in [("name", 40, true), ("unit", 20, false)] {
                let text = values
                    .get(name)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("");
                let n = text.chars().count();
                if (required && n == 0) || n > max || contains_personal_data(text) {
                    errors.insert(
                        format!("values.{name}"),
                        t(T::ErrFieldRequired, locale).into(),
                    );
                } else if n > 0 {
                    out.insert(name.to_string(), json!(text));
                }
            }
        }
        _ => {
            errors.insert("kind".into(), t(T::FieldErrChoice, locale).into());
        }
    }
    if let Some(unit) = unit {
        out.insert("unit".into(), json!(unit));
    }
    if errors.is_empty() {
        Ok(Value::Object(out))
    } else {
        Err(errors)
    }
}

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Params>,
) -> AppResult<Json<Page<Measurement>>> {
    user.require(Permission::ProfileOwn)?;
    let limit = page::limit(&params)?;
    let kind = page::param(&params, "kind");
    if kind.is_some_and(|k| !KINDS.contains(&k)) {
        return Err(AppError::field("kind", t(T::FieldErrChoice, user.locale)));
    }
    let rows = for_patient(&state.db, user.id, kind, page::cursor(&params)?, limit + 1).await?;
    Ok(Json(page::cut(rows, limit, |m| Cursor {
        at: m.taken_at,
        id: m.id,
    })))
}

#[derive(Deserialize)]
pub struct NewMeasurement {
    kind: String,
    values: Map<String, Value>,
    taken_at: Option<String>,
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    key: IdempotencyKey,
    ApiJson(body): ApiJson<NewMeasurement>,
) -> AppResult<Response> {
    user.require(Permission::ProfileOwn)?;
    idem::run(&state, user.id, key, "POST /app/measurements", || async {
        let values =
            clean_values(&body.kind, &body.values, user.locale).map_err(AppError::Unprocessable)?;
        let now = state.clock.now();
        let taken_at = match body.taken_at.as_deref() {
            None => now,
            Some(text) => OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
                .ok()
                .filter(|at| *at <= now + Duration::minutes(5) && *at >= now - Duration::days(3650))
                .ok_or_else(|| AppError::field("taken_at", t(T::FieldErrFuture, user.locale)))?,
        };
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM measurements WHERE patient_id = $1")
                .bind(user.id)
                .fetch_one(&state.db)
                .await?;
        if count >= MAX_ROWS {
            return Err(AppError::InvalidState("too many measurements"));
        }
        let row: Measurement = sqlx::query_as(
            "INSERT INTO measurements (patient_id, kind, \"values\", taken_at, source, recorded_by) VALUES ($1, $2, $3, $4, 'patient', $1) RETURNING id, kind, \"values\", taken_at, source",
        )
        .bind(user.id)
        .bind(&body.kind)
        .bind(values)
        .bind(taken_at)
        .fetch_one(&state.db)
        .await?;
        Ok((
            StatusCode::CREATED,
            serde_json::to_value(row).map_err(anyhow::Error::from)?,
        ))
    })
    .await
}

/// Patients delete what they entered; clinic values stay.
pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require(Permission::ProfileOwn)?;
    let id = Uuid::parse_str(&id).map_err(|_| AppError::NotFound)?;
    let done = sqlx::query(
        "DELETE FROM measurements WHERE id = $1 AND patient_id = $2 AND source = 'patient'",
    )
    .bind(id)
    .bind(user.id)
    .execute(&state.db)
    .await?
    .rows_affected();
    if done == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

fn number(value: &Value) -> String {
    match value.as_f64() {
        Some(v) if v.fract() == 0.0 => format!("{v:.0}"),
        Some(v) => format!("{v:.1}"),
        None => String::new(),
    }
}

/// `血壓 132/78 mmHg`
pub fn describe(kind: &str, values: &Value, locale: Locale) -> String {
    let unit = values["unit"].as_str().unwrap_or("");
    let text = match kind {
        "bp" => format!(
            "{} {}/{} {unit}",
            t(T::MeasureBp, locale),
            number(&values["systolic"]),
            number(&values["diastolic"])
        ),
        "lab" => format!(
            "{} {} {unit}",
            values["name"].as_str().unwrap_or(""),
            number(&values["value"])
        ),
        _ => {
            let label = match kind {
                "glucose" => T::MeasureGlucose,
                "weight" => T::MeasureWeight,
                _ => T::MeasurePulse,
            };
            format!("{} {} {unit}", t(label, locale), number(&values["value"]))
        }
    };
    text.trim().to_string()
}

/// O of a note draft: the latest value of each kind from the last 90 days, with its date and who measured it.
pub async fn objective_text(db: &PgPool, patient: Uuid, locale: Locale) -> sqlx::Result<String> {
    let rows: Vec<Measurement> = sqlx::query_as(
        "SELECT DISTINCT ON (kind, \"values\"->>'name') id, kind, \"values\", taken_at, source FROM measurements
         WHERE patient_id = $1 AND taken_at > now() - interval '90 days'
         ORDER BY kind, \"values\"->>'name', taken_at DESC, id DESC",
    )
    .bind(patient)
    .fetch_all(db)
    .await?;
    let mut lines: Vec<String> = Vec::new();
    for kind in KINDS {
        for row in rows.iter().filter(|r| r.kind == kind) {
            let source = t(
                if row.source == "clinic" {
                    T::SourceClinic
                } else {
                    T::SourcePatient
                },
                locale,
            );
            let day = local_time(row.taken_at);
            let day = day.split(' ').next().unwrap_or("");
            lines.push(if locale.is_en() {
                format!(
                    "{} ({source}, {day})",
                    describe(&row.kind, &row.values, locale)
                )
            } else {
                format!(
                    "{}（{source}，{day}）",
                    describe(&row.kind, &row.values, locale)
                )
            });
        }
    }
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(value: Value) -> Map<String, Value> {
        serde_json::from_value(value).expect("map")
    }

    #[test]
    fn values_are_checked_and_trimmed_to_the_kind() {
        let zh = Locale::ZhTw;
        let bp = clean_values(
            "bp",
            &map(json!({ "systolic": 132, "diastolic": 78, "junk": 1 })),
            zh,
        )
        .expect("bp");
        assert_eq!(
            bp,
            json!({ "systolic": 132.0, "diastolic": 78.0, "unit": "mmHg" })
        );
        let err = clean_values("bp", &map(json!({ "systolic": 70, "diastolic": 90 })), zh)
            .expect_err("swapped");
        assert!(err.contains_key("values.diastolic"));
        let err = clean_values("glucose", &map(json!({ "value": "high" })), zh).expect_err("type");
        assert!(err.contains_key("values.value"));
        assert!(
            clean_values("lab", &map(json!({ "value": 6.8 })), zh).is_err(),
            "a lab value needs a name"
        );
        assert!(
            clean_values(
                "lab",
                &map(json!({ "name": "HbA1c", "value": 6.8, "unit": "%" })),
                zh
            )
            .is_ok()
        );
        assert!(clean_values("mood", &map(json!({})), zh).is_err());
    }

    #[test]
    fn values_read_like_a_chart_line() {
        assert_eq!(
            describe(
                "bp",
                &json!({ "systolic": 132.0, "diastolic": 78.0, "unit": "mmHg" }),
                Locale::ZhTw
            ),
            "血壓 132/78 mmHg"
        );
        assert_eq!(
            describe(
                "lab",
                &json!({ "name": "HbA1c", "value": 6.8, "unit": "%" }),
                Locale::En
            ),
            "HbA1c 6.8 %"
        );
    }
}
