//! The pre-visit summary for the clinician: built by the program from the intake fields (never from model prose),
//! with an optional narrative paragraph written by the model after guard and personal-data checks.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::intake::{Hpi, IntakeState, ListField, NOT_APPLICABLE, Severity};
use crate::texts::{T, field_label, fmt, t};
use crate::types::Locale;

pub const NARRATIVE_MAX_CHARS: usize = 300;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TriggeredFlag {
    pub category: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RedFlagScreen {
    pub checked: bool,
    pub triggered: Vec<TriggeredFlag>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GeneratedBy {
    /// `model` or `code`
    pub kind: String,
    pub model: Option<String>,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrevisitSummary {
    pub visit_id: Uuid,
    pub chief_complaint: Option<String>,
    pub hpi: Hpi,
    pub past_history: Vec<String>,
    pub medications: Vec<String>,
    pub allergies: Vec<String>,
    pub not_collected: Vec<String>,
    pub red_flag_screen: RedFlagScreen,
    pub patient_questions: Vec<String>,
    pub narrative: String,
    /// Latest refill check result, overlaid when the summary is read.
    pub refill: Option<Value>,
    pub generated_by: GeneratedBy,
    pub disclaimer: String,
}

fn shown(text: &str, locale: Locale) -> String {
    if text == NOT_APPLICABLE {
        t(T::NotApplicable, locale).to_string()
    } else {
        text.to_string()
    }
}

fn list_text(field: &ListField, locale: Locale) -> String {
    if field.items.is_empty() {
        t(T::NoneLabel, locale).to_string()
    } else {
        field.items.join(if locale.is_en() { ", " } else { "、" })
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{cut}…")
}

/// A plain paragraph built from the fields that were collected, at most 300 characters, no interpretation.
pub fn code_narrative(intake: &IntakeState, locale: Locale) -> String {
    let (sep, colon, stop) = if locale.is_en() {
        ("; ", ": ", ". ")
    } else {
        ("；", "：", "。")
    };
    let label = |key: &str| field_label(key, locale);
    let mut hpi_parts: Vec<String> = Vec::new();
    let h = &intake.hpi;
    for (key, value) in [
        ("hpi.onset", &h.onset),
        ("hpi.course", &h.course),
        ("hpi.location", &h.location),
        ("hpi.character", &h.character),
        ("hpi.modifiers", &h.modifiers),
        ("hpi.associated", &h.associated),
    ] {
        if let Some(v) = value {
            hpi_parts.push(format!("{}{colon}{}", label(key), shown(v, locale)));
        }
    }
    match h.severity {
        Some(Severity::Score(n)) => hpi_parts.push(format!(
            "{}{colon}{}",
            label("hpi.severity"),
            fmt(T::SeverityOutOf, locale, &[("n", &n.to_string())])
        )),
        Some(Severity::NotApplicable) => hpi_parts.push(format!(
            "{}{colon}{}",
            label("hpi.severity"),
            t(T::NotApplicable, locale)
        )),
        None => {}
    }
    let mut sentences: Vec<String> = Vec::new();
    if let Some(cc) = &intake.chief_complaint {
        sentences.push(format!(
            "{}{colon}{}",
            label("chief_complaint"),
            shown(cc, locale)
        ));
    }
    if !hpi_parts.is_empty() {
        sentences.push(hpi_parts.join(sep));
    }
    for (key, field) in [
        ("past_history", &intake.past_history),
        ("medications", &intake.medications),
        ("allergies", &intake.allergies),
    ] {
        if field.answered {
            sentences.push(format!("{}{colon}{}", label(key), list_text(field, locale)));
        }
    }
    if !intake.patient_questions.is_empty() {
        sentences.push(format!(
            "{}{colon}{}",
            t(T::PatientQuestionsLabel, locale),
            intake.patient_questions.join(sep)
        ));
    }
    let missing = intake.missing();
    if !missing.is_empty() {
        sentences.push(format!(
            "{}{colon}{}",
            t(T::NotCollectedLabel, locale),
            missing
                .iter()
                .map(|k| label(k))
                .collect::<Vec<_>>()
                .join(if locale.is_en() { ", " } else { "、" })
        ));
    }
    if sentences.is_empty() {
        return t(T::NarrativeEmpty, locale).to_string();
    }
    let joined = if locale.is_en() {
        sentences.join(stop) + "."
    } else {
        sentences.join(stop) + "。"
    };
    truncate_chars(&joined, NARRATIVE_MAX_CHARS)
}

pub struct SummaryInput<'a> {
    pub visit_id: Uuid,
    pub intake: &'a IntakeState,
    pub locale: Locale,
    pub flags: Vec<TriggeredFlag>,
    pub refill: Option<Value>,
    /// A checked model narrative; `None` uses the program's own.
    pub narrative: Option<String>,
    pub model: Option<String>,
    pub now: OffsetDateTime,
}

pub fn build(input: SummaryInput<'_>) -> PrevisitSummary {
    let SummaryInput {
        visit_id,
        intake,
        locale,
        flags,
        refill,
        narrative,
        model,
        now,
    } = input;
    let from_model = narrative.is_some();
    let note = t(
        if flags.is_empty() {
            T::RedFlagNoteClear
        } else {
            T::RedFlagNoteHit
        },
        locale,
    )
    .to_string();
    PrevisitSummary {
        visit_id,
        chief_complaint: intake.chief_complaint.clone(),
        hpi: intake.hpi.clone(),
        past_history: intake.past_history.items.clone(),
        medications: intake.medications.items.clone(),
        allergies: intake.allergies.items.clone(),
        not_collected: intake.missing().into_iter().map(str::to_string).collect(),
        red_flag_screen: RedFlagScreen {
            checked: true,
            triggered: flags,
            note,
        },
        patient_questions: intake.patient_questions.clone(),
        narrative: narrative
            .map(|n| truncate_chars(&n, NARRATIVE_MAX_CHARS))
            .unwrap_or_else(|| code_narrative(intake, locale)),
        refill,
        generated_by: GeneratedBy {
            kind: if from_model { "model" } else { "code" }.to_string(),
            model: if from_model { model } else { None },
            at: now
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default(),
        },
        disclaimer: t(T::Disclaimer, locale).to_string(),
    }
}

pub async fn save(db: &PgPool, summary: &PrevisitSummary) -> sqlx::Result<()> {
    let content = serde_json::to_value(summary).unwrap_or(Value::Null);
    sqlx::query(
        "INSERT INTO previsit_summaries (visit_id, content, generated_by, model) VALUES ($1, $2, $3, $4)
         ON CONFLICT (visit_id) DO UPDATE SET content = EXCLUDED.content, generated_by = EXCLUDED.generated_by, model = EXCLUDED.model, updated_at = now()",
    )
    .bind(summary.visit_id)
    .bind(content)
    .bind(&summary.generated_by.kind)
    .bind(&summary.generated_by.model)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn load(db: &PgPool, visit_id: Uuid) -> sqlx::Result<Option<PrevisitSummary>> {
    let content: Option<Value> =
        sqlx::query_scalar("SELECT content FROM previsit_summaries WHERE visit_id = $1")
            .bind(visit_id)
            .fetch_optional(db)
            .await?;
    Ok(content.and_then(|c| serde_json::from_value(c).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intake::IntakePatch;
    use serde_json::json;
    use time::macros::datetime;

    fn intake(patch: Value) -> IntakeState {
        let mut s = IntakeState::default();
        s.apply(&serde_json::from_value::<IntakePatch>(patch).expect("patch"));
        s
    }

    #[test]
    fn narrative_lists_collected_fields_and_what_is_missing() {
        let s = intake(
            json!({"chief_complaint": "咳嗽", "onset": "三天前", "severity": 4, "no_allergies": true, "medications": ["降血壓藥"]}),
        );
        let text = code_narrative(&s, Locale::ZhTw);
        assert!(text.contains("主訴：咳嗽"));
        assert!(text.contains("發作時間：三天前") && text.contains("嚴重程度：4 分（0–10）"));
        assert!(text.contains("目前用藥：降血壓藥") && text.contains("藥物或食物過敏：無"));
        assert!(text.contains("未取得：") && text.contains("病程變化"));
        assert!(text.chars().count() <= NARRATIVE_MAX_CHARS);
    }

    #[test]
    fn narrative_never_exceeds_300_characters() {
        let long = "很長的描述".repeat(30);
        let s = intake(
            json!({"chief_complaint": long.clone(), "onset": long.clone(), "course": long.clone(), "associated": long}),
        );
        let text = code_narrative(&s, Locale::ZhTw);
        assert_eq!(text.chars().count(), NARRATIVE_MAX_CHARS);
        assert!(text.ends_with('…'));
    }

    #[test]
    fn english_narrative_and_na_values() {
        let s =
            intake(json!({"chief_complaint": "cough", "location": "不適用", "severity": "n/a"}));
        let text = code_narrative(&s, Locale::En);
        assert!(
            text.contains("Chief complaint: cough")
                && text.contains("Location: N/A")
                && text.contains("Severity: N/A")
        );
    }

    #[test]
    fn empty_intake_has_a_plain_narrative_and_everything_not_collected() {
        let empty = IntakeState::default();
        let summary = build(SummaryInput {
            visit_id: Uuid::nil(),
            intake: &empty,
            locale: Locale::ZhTw,
            flags: vec![],
            refill: None,
            narrative: None,
            model: None,
            now: datetime!(2026-11-25 00:00 UTC),
        });
        assert_eq!(summary.chief_complaint, None);
        assert_eq!(summary.not_collected.len(), 11);
        assert_eq!(summary.generated_by.kind, "code");
        assert!(summary.red_flag_screen.checked && summary.red_flag_screen.triggered.is_empty());
        assert!(summary.disclaimer.contains("沒有經過診斷"));
        assert_eq!(summary.generated_by.at, "2026-11-25T00:00:00Z");
    }

    #[test]
    fn a_model_narrative_is_attributed_to_the_model_and_capped() {
        let s = intake(json!({"chief_complaint": "咳嗽"}));
        let summary = build(SummaryInput {
            visit_id: Uuid::nil(),
            intake: &s,
            locale: Locale::ZhTw,
            flags: vec![TriggeredFlag {
                category: "chest_pain".into(),
                label: "胸痛".into(),
            }],
            refill: None,
            narrative: Some("字".repeat(400)),
            model: Some("gemini-x".into()),
            now: datetime!(2026-11-25 00:00 UTC),
        });
        assert_eq!(summary.generated_by.kind, "model");
        assert_eq!(summary.generated_by.model.as_deref(), Some("gemini-x"));
        assert_eq!(summary.narrative.chars().count(), NARRATIVE_MAX_CHARS);
        assert!(summary.red_flag_screen.note.contains("命中"));
    }

    #[test]
    fn summary_roundtrips_through_json() {
        let s = intake(json!({"chief_complaint": "咳嗽", "severity": "n/a"}));
        let summary = build(SummaryInput {
            visit_id: Uuid::nil(),
            intake: &s,
            locale: Locale::ZhTw,
            flags: vec![],
            refill: Some(json!({"outcome": "eligible"})),
            narrative: None,
            model: None,
            now: datetime!(2026-11-25 00:00 UTC),
        });
        let back: PrevisitSummary =
            serde_json::from_value(serde_json::to_value(&summary).expect("json")).expect("back");
        assert_eq!(back.chief_complaint.as_deref(), Some("咳嗽"));
        assert_eq!(back.refill, Some(json!({"outcome": "eligible"})));
    }
}
