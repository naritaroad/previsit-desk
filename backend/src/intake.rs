//! Intake state: the fields the history taking fills in, merging of model patches, the stage and what is missing.
//! The stage comes from the fields (program), never from the model.

use std::sync::LazyLock;

use regex::Regex;
use serde::de::{self, Deserializer};
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::pii;
use crate::types::Stage;

/// Asking order. `missing` and `progress` always cover all of these (total 11).
pub const FIELD_KEYS: [&str; 11] = [
    "chief_complaint",
    "hpi.onset",
    "hpi.course",
    "hpi.location",
    "hpi.character",
    "hpi.severity",
    "hpi.modifiers",
    "hpi.associated",
    "past_history",
    "medications",
    "allergies",
];

pub const NOT_APPLICABLE: &str = "不適用";
const MAX_TEXT_CHARS: usize = 200;
const MAX_ITEM_CHARS: usize = 80;
const MAX_ITEMS: usize = 20;
const MAX_QUESTIONS: usize = 10;

/// 0 to 10, or "n/a" when the patient cannot or need not rate it (counts as answered).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Score(u8),
    NotApplicable,
}

impl Serialize for Severity {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Severity::Score(n) => serializer.serialize_u8(*n),
            Severity::NotApplicable => serializer.serialize_str("n/a"),
        }
    }
}

impl<'de> Deserialize<'de> for Severity {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        parse_severity(&value).map_err(de::Error::custom)
    }
}

fn parse_severity(value: &Value) -> Result<Severity, String> {
    match value {
        Value::Number(n) => {
            let f = n.as_f64().ok_or("severity must be a number from 0 to 10")?;
            if f.fract() == 0.0 && (0.0..=10.0).contains(&f) {
                Ok(Severity::Score(f as u8))
            } else {
                Err("severity must be a whole number from 0 to 10".into())
            }
        }
        Value::String(s) => {
            let s = s.trim();
            if is_not_applicable(s) {
                Ok(Severity::NotApplicable)
            } else {
                match s.parse::<u8>() {
                    Ok(n) if n <= 10 => Ok(Severity::Score(n)),
                    _ => Err("severity must be a whole number from 0 to 10".into()),
                }
            }
        }
        _ => Err("severity must be a number from 0 to 10 or \"n/a\"".into()),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Hpi {
    pub onset: Option<String>,
    pub modifiers: Option<String>,
    pub character: Option<String>,
    pub location: Option<String>,
    pub severity: Option<Severity>,
    pub course: Option<String>,
    pub associated: Option<String>,
}

/// `answered: true` with no items means the patient said "none".
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ListField {
    pub answered: bool,
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct IntakeState {
    #[serde(default)]
    pub chief_complaint: Option<String>,
    #[serde(default)]
    pub hpi: Hpi,
    #[serde(default)]
    pub past_history: ListField,
    #[serde(default)]
    pub medications: ListField,
    #[serde(default)]
    pub allergies: ListField,
    #[serde(default)]
    pub patient_questions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct IntakeView {
    pub state: IntakeState,
    pub stage: Stage,
    pub missing: Vec<&'static str>,
    pub progress: Progress,
}

impl IntakeState {
    /// Keys still empty, in asking order.
    pub fn missing(&self) -> Vec<&'static str> {
        FIELD_KEYS
            .iter()
            .copied()
            .filter(|key| !self.has(key))
            .collect()
    }

    pub fn has(&self, key: &str) -> bool {
        match key {
            "chief_complaint" => self.chief_complaint.is_some(),
            "hpi.onset" => self.hpi.onset.is_some(),
            "hpi.course" => self.hpi.course.is_some(),
            "hpi.location" => self.hpi.location.is_some(),
            "hpi.character" => self.hpi.character.is_some(),
            "hpi.severity" => self.hpi.severity.is_some(),
            "hpi.modifiers" => self.hpi.modifiers.is_some(),
            "hpi.associated" => self.hpi.associated.is_some(),
            "past_history" => self.past_history.answered,
            "medications" => self.medications.answered,
            "allergies" => self.allergies.answered,
            _ => false,
        }
    }

    /// Stage from the core fields only: chief complaint; onset, course, severity, associated; the three lists.
    /// Location, character and modifiers are "ask when you can" and never block the next stage.
    pub fn stage(&self) -> Stage {
        if self.chief_complaint.is_none() {
            Stage::ChiefComplaint
        } else if ["hpi.onset", "hpi.course", "hpi.severity", "hpi.associated"]
            .iter()
            .any(|k| !self.has(k))
        {
            Stage::Hpi
        } else if !(self.past_history.answered
            && self.medications.answered
            && self.allergies.answered)
        {
            Stage::Background
        } else {
            Stage::Confirm
        }
    }

    pub fn progress(&self) -> Progress {
        Progress {
            done: FIELD_KEYS.len() - self.missing().len(),
            total: FIELD_KEYS.len(),
        }
    }

    /// The view the API and the SSE stream send. `stage` is the stored visit stage (it can be `done`).
    pub fn view(&self, stage: Stage) -> IntakeView {
        IntakeView {
            state: self.clone(),
            stage,
            missing: self.missing(),
            progress: self.progress(),
        }
    }
}

// ---------------------------------------------------------------------------
// Patches from the model
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HpiPatch {
    pub onset: Option<String>,
    pub modifiers: Option<String>,
    pub character: Option<String>,
    pub location: Option<String>,
    pub severity: Option<Value>,
    pub course: Option<String>,
    pub associated: Option<String>,
}

/// What `record_intake` accepts. Unknown fields are an error so the model learns the schema.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntakePatch {
    pub chief_complaint: Option<String>,
    pub onset: Option<String>,
    pub modifiers: Option<String>,
    pub character: Option<String>,
    pub location: Option<String>,
    pub severity: Option<Value>,
    pub course: Option<String>,
    pub associated: Option<String>,
    pub hpi: Option<HpiPatch>,
    pub past_history: Option<Vec<String>>,
    pub no_past_history: Option<bool>,
    pub medications: Option<Vec<String>>,
    pub no_medications: Option<bool>,
    pub allergies: Option<Vec<String>>,
    pub no_allergies: Option<bool>,
    pub patient_questions: Option<Vec<String>>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PatchOutcome {
    /// Field keys whose value actually changed.
    pub applied: Vec<String>,
    /// `(field, reason)` for values that were refused.
    pub rejected: Vec<(String, String)>,
}

static NAME_STATEMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(我叫|我姓|姓名|名字是|名字叫|my name is|i am called|call me)").expect("regex")
});
static ADDRESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[縣市].{0,8}[區鄉鎮市].{0,10}[路街段巷弄].{0,8}號").expect("regex")
});

pub const PII_REASON: &str =
    "contains personal data; do not record names, ID numbers, phone numbers or addresses";

pub fn contains_personal_data(text: &str) -> bool {
    pii::looks_personal(text) || NAME_STATEMENT.is_match(text) || ADDRESS.is_match(text)
}

pub fn is_not_applicable(text: &str) -> bool {
    matches!(
        text.trim().to_lowercase().as_str(),
        "n/a" | "na" | "not applicable" | "不適用" | "none applicable"
    )
}

fn is_none_word(text: &str) -> bool {
    matches!(
        text.trim().to_lowercase().as_str(),
        "無" | "沒有"
            | "沒"
            | "none"
            | "no"
            | "nil"
            | "否"
            | "都沒有"
            | "無特殊"
            | "n/a"
            | "不適用"
    )
}

/// Trimmed, whitespace-collapsed text; "N/A" spellings become the fixed `不適用`.
fn clean_text(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if is_not_applicable(&collapsed) {
        NOT_APPLICABLE.to_string()
    } else {
        collapsed
    }
}

fn set_text(slot: &mut Option<String>, key: &str, value: Option<&String>, out: &mut PatchOutcome) {
    let Some(raw) = value else { return };
    let text = clean_text(raw);
    if text.is_empty() {
        return;
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        out.rejected.push((
            key.to_string(),
            format!("longer than {MAX_TEXT_CHARS} characters"),
        ));
    } else if contains_personal_data(&text) {
        out.rejected.push((key.to_string(), PII_REASON.to_string()));
    } else if slot.as_deref() != Some(text.as_str()) {
        *slot = Some(text);
        out.applied.push(key.to_string());
    }
}

fn merge_list(
    field: &mut ListField,
    key: &str,
    items: Option<&Vec<String>>,
    none: Option<bool>,
    out: &mut PatchOutcome,
) {
    let before = field.clone();
    let mut said_none = none == Some(true);
    if let Some(items) = items {
        if items.len() > MAX_ITEMS {
            out.rejected
                .push((key.to_string(), format!("more than {MAX_ITEMS} items")));
            return;
        }
        for raw in items {
            let item = clean_text(raw);
            if item.is_empty() {
                continue;
            }
            if is_none_word(&item) {
                said_none = true;
                continue;
            }
            if item.chars().count() > MAX_ITEM_CHARS {
                out.rejected.push((
                    key.to_string(),
                    format!("an item is longer than {MAX_ITEM_CHARS} characters"),
                ));
            } else if contains_personal_data(&item) {
                out.rejected.push((key.to_string(), PII_REASON.to_string()));
            } else if !field
                .items
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(&item))
            {
                if field.items.len() >= MAX_ITEMS {
                    out.rejected
                        .push((key.to_string(), format!("more than {MAX_ITEMS} items")));
                    break;
                }
                field.items.push(item);
                field.answered = true;
            }
        }
    }
    // "None" only closes an empty list; it never wipes items the patient already named.
    if said_none && field.items.is_empty() {
        field.answered = true;
    }
    if *field != before {
        out.applied.push(key.to_string());
    }
}

impl IntakeState {
    /// Merges `patch`. Valid parts are applied even when other parts are refused.
    pub fn apply(&mut self, patch: &IntakePatch) -> PatchOutcome {
        let mut out = PatchOutcome::default();
        set_text(
            &mut self.chief_complaint,
            "chief_complaint",
            patch.chief_complaint.as_ref(),
            &mut out,
        );

        let nested = patch.hpi.as_ref();
        let pick = |flat: &Option<String>, deep: Option<&Option<String>>| -> Option<String> {
            flat.clone().or_else(|| deep.and_then(|d| d.clone()))
        };
        let onset = pick(&patch.onset, nested.map(|h| &h.onset));
        let modifiers = pick(&patch.modifiers, nested.map(|h| &h.modifiers));
        let character = pick(&patch.character, nested.map(|h| &h.character));
        let location = pick(&patch.location, nested.map(|h| &h.location));
        let course = pick(&patch.course, nested.map(|h| &h.course));
        let associated = pick(&patch.associated, nested.map(|h| &h.associated));
        set_text(&mut self.hpi.onset, "hpi.onset", onset.as_ref(), &mut out);
        set_text(
            &mut self.hpi.course,
            "hpi.course",
            course.as_ref(),
            &mut out,
        );
        set_text(
            &mut self.hpi.location,
            "hpi.location",
            location.as_ref(),
            &mut out,
        );
        set_text(
            &mut self.hpi.character,
            "hpi.character",
            character.as_ref(),
            &mut out,
        );
        set_text(
            &mut self.hpi.modifiers,
            "hpi.modifiers",
            modifiers.as_ref(),
            &mut out,
        );
        set_text(
            &mut self.hpi.associated,
            "hpi.associated",
            associated.as_ref(),
            &mut out,
        );

        let severity = patch
            .severity
            .as_ref()
            .or_else(|| nested.and_then(|h| h.severity.as_ref()));
        if let Some(value) = severity.filter(|v| !v.is_null()) {
            match parse_severity(value) {
                Ok(parsed) if self.hpi.severity != Some(parsed) => {
                    self.hpi.severity = Some(parsed);
                    out.applied.push("hpi.severity".into());
                }
                Ok(_) => {}
                Err(reason) => out.rejected.push(("hpi.severity".into(), reason)),
            }
        }

        merge_list(
            &mut self.past_history,
            "past_history",
            patch.past_history.as_ref(),
            patch.no_past_history,
            &mut out,
        );
        merge_list(
            &mut self.medications,
            "medications",
            patch.medications.as_ref(),
            patch.no_medications,
            &mut out,
        );
        merge_list(
            &mut self.allergies,
            "allergies",
            patch.allergies.as_ref(),
            patch.no_allergies,
            &mut out,
        );

        if let Some(questions) = &patch.patient_questions {
            let before = self.patient_questions.len();
            for raw in questions {
                let q = clean_text(raw);
                if q.is_empty() || self.patient_questions.contains(&q) {
                    continue;
                }
                if q.chars().count() > MAX_TEXT_CHARS {
                    out.rejected.push((
                        "patient_questions".into(),
                        format!("longer than {MAX_TEXT_CHARS} characters"),
                    ));
                } else if contains_personal_data(&q) {
                    out.rejected
                        .push(("patient_questions".into(), PII_REASON.to_string()));
                } else if self.patient_questions.len() >= MAX_QUESTIONS {
                    out.rejected.push((
                        "patient_questions".into(),
                        format!("more than {MAX_QUESTIONS} questions"),
                    ));
                    break;
                } else {
                    self.patient_questions.push(q);
                }
            }
            if self.patient_questions.len() != before {
                out.applied.push("patient_questions".into());
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn patch(value: Value) -> IntakePatch {
        serde_json::from_value(value).expect("patch")
    }

    fn full_core() -> IntakeState {
        let mut s = IntakeState::default();
        s.apply(&patch(json!({
            "chief_complaint": "咳嗽", "onset": "三天前", "course": "晚上比較嚴重", "severity": 4, "associated": "沒有發燒",
            "no_past_history": true, "medications": ["降血壓藥"], "no_allergies": true
        })));
        s
    }

    #[test]
    fn empty_state_starts_at_chief_complaint_with_everything_missing() {
        let s = IntakeState::default();
        assert_eq!(s.stage(), Stage::ChiefComplaint);
        assert_eq!(s.missing(), FIELD_KEYS.to_vec());
        let p = s.progress();
        assert_eq!((p.done, p.total), (0, 11));
    }

    #[test]
    fn stage_walks_chief_complaint_hpi_background_confirm() {
        let mut s = IntakeState::default();
        s.apply(&patch(json!({"chief_complaint": "頭痛"})));
        assert_eq!(s.stage(), Stage::Hpi);
        s.apply(&patch(
            json!({"onset": "昨天", "course": "越來越痛", "severity": 6}),
        ));
        assert_eq!(s.stage(), Stage::Hpi, "associated is still missing");
        s.apply(&patch(json!({"associated": "想吐"})));
        assert_eq!(s.stage(), Stage::Background);
        s.apply(&patch(
            json!({"no_past_history": true, "medications": ["普拿疼"]}),
        ));
        assert_eq!(s.stage(), Stage::Background, "allergies still unanswered");
        s.apply(&patch(json!({"no_allergies": true})));
        assert_eq!(s.stage(), Stage::Confirm);
        // Location, character and modifiers did not block the confirm stage and are still listed as missing.
        assert_eq!(
            s.missing(),
            vec!["hpi.location", "hpi.character", "hpi.modifiers"]
        );
        let p = s.progress();
        assert_eq!((p.done, p.total), (8, 11));
    }

    #[test]
    fn missing_follows_the_asking_order() {
        let mut s = IntakeState::default();
        s.apply(&patch(
            json!({"chief_complaint": "咳嗽", "course": "一直咳", "severity": 3}),
        ));
        assert_eq!(
            s.missing()[..3],
            ["hpi.onset", "hpi.location", "hpi.character"]
        );
    }

    #[test]
    fn severity_accepts_0_to_10_and_na_only() {
        let mut s = IntakeState::default();
        for (value, expected) in [
            (json!(0), Some(Severity::Score(0))),
            (json!(10), Some(Severity::Score(10))),
            (json!(7.0), Some(Severity::Score(7))),
            (json!("5"), Some(Severity::Score(5))),
            (json!("n/a"), Some(Severity::NotApplicable)),
            (json!("N/A"), Some(Severity::NotApplicable)),
            (json!("不適用"), Some(Severity::NotApplicable)),
        ] {
            let mut t = IntakeState::default();
            let out = t.apply(&patch(json!({ "severity": value })));
            assert_eq!(t.hpi.severity, expected, "{value}");
            assert!(out.rejected.is_empty());
        }
        for bad in [json!(11), json!(-1), json!(6.5), json!("很痛"), json!(true)] {
            let out = s.apply(&patch(json!({ "severity": bad })));
            assert_eq!(out.rejected.len(), 1, "{bad}");
            assert_eq!(s.hpi.severity, None);
        }
    }

    #[test]
    fn severity_na_counts_as_answered_and_serialises_as_n_slash_a() {
        let mut s = IntakeState::default();
        s.apply(&patch(json!({"severity": "n/a"})));
        assert!(s.has("hpi.severity"));
        assert_eq!(
            serde_json::to_value(&s).expect("json")["hpi"]["severity"],
            json!("n/a")
        );
        s.apply(&patch(json!({"severity": 4})));
        assert_eq!(
            serde_json::to_value(&s).expect("json")["hpi"]["severity"],
            json!(4)
        );
        let back: IntakeState =
            serde_json::from_value(serde_json::to_value(&s).expect("json")).expect("roundtrip");
        assert_eq!(back, s);
    }

    #[test]
    fn na_spellings_normalise_to_the_fixed_string() {
        for spelling in ["N/A", "n/a", "not applicable", "不適用", " 不適用 "] {
            let mut s = IntakeState::default();
            s.apply(&patch(json!({"location": spelling})));
            assert_eq!(s.hpi.location.as_deref(), Some("不適用"), "{spelling}");
        }
    }

    #[test]
    fn lists_distinguish_none_from_unanswered() {
        let mut s = IntakeState::default();
        assert!(!s.allergies.answered);
        s.apply(&patch(json!({"no_allergies": true})));
        assert!(s.allergies.answered && s.allergies.items.is_empty());
        s.apply(&patch(
            json!({"medications": ["降血壓藥", "降血壓藥", "胃藥"]}),
        ));
        assert_eq!(s.medications.items, vec!["降血壓藥", "胃藥"]);
        // "none" never wipes named items.
        s.apply(&patch(json!({"no_medications": true})));
        assert_eq!(s.medications.items.len(), 2);
        // A literal 無 in the items means none.
        let mut t = IntakeState::default();
        t.apply(&patch(json!({"past_history": ["無"]})));
        assert!(t.past_history.answered && t.past_history.items.is_empty());
    }

    #[test]
    fn personal_data_is_rejected_but_valid_parts_still_apply() {
        let mut s = IntakeState::default();
        let out = s.apply(&patch(json!({"chief_complaint": "我叫王小明，頭痛", "onset": "昨天", "medications": ["電話 0912345678"], "patient_questions": ["身分證 A123456789 怎麼辦"]})));
        assert_eq!(s.chief_complaint, None);
        assert_eq!(s.hpi.onset.as_deref(), Some("昨天"));
        assert!(!s.medications.answered);
        assert!(s.patient_questions.is_empty());
        assert_eq!(out.applied, vec!["hpi.onset"]);
        assert_eq!(out.rejected.len(), 3);
        assert!(
            out.rejected
                .iter()
                .all(|(_, reason)| reason.contains("personal data"))
        );
    }

    #[test]
    fn address_and_email_patterns_are_rejected() {
        assert!(contains_personal_data("住台北市中正區忠孝東路一段1號"));
        assert!(contains_personal_data("mail me at a@b.co"));
        assert!(contains_personal_data("my name is Lee"));
        assert!(!contains_personal_data("右上腹痛，吃完油膩的更明顯"));
    }

    #[test]
    fn limits_on_length_and_count() {
        let mut s = IntakeState::default();
        let long = "痛".repeat(201);
        let out = s.apply(&patch(
            json!({"chief_complaint": long, "past_history": ["藥".repeat(81)]}),
        ));
        assert_eq!(out.rejected.len(), 2);
        let many: Vec<String> = (0..21).map(|i| format!("item{i}")).collect();
        let out = s.apply(&patch(json!({"medications": many})));
        assert_eq!(out.rejected.len(), 1);
        assert!(!s.medications.answered);
    }

    #[test]
    fn unknown_fields_are_an_error() {
        assert!(serde_json::from_value::<IntakePatch>(json!({"diagnosis": "flu"})).is_err());
        assert!(serde_json::from_value::<IntakePatch>(json!({"hpi": {"colour": "red"}})).is_err());
    }

    #[test]
    fn nested_hpi_is_accepted_and_unchanged_values_are_not_reported() {
        let mut s = IntakeState::default();
        let out = s.apply(&patch(json!({"hpi": {"onset": "兩天", "severity": 3}})));
        assert_eq!(out.applied, vec!["hpi.onset", "hpi.severity"]);
        let again = s.apply(&patch(json!({"onset": "兩天", "severity": 3})));
        assert!(again.applied.is_empty() && again.rejected.is_empty());
    }

    #[test]
    fn patient_questions_accumulate_without_duplicates() {
        let mut s = IntakeState::default();
        s.apply(&patch(json!({"patient_questions": ["這會不會是癌症？"]})));
        s.apply(&patch(
            json!({"patient_questions": ["這會不會是癌症？", "需要做檢查嗎？"]}),
        ));
        assert_eq!(s.patient_questions.len(), 2);
        assert_eq!(
            s.missing().len(),
            11,
            "questions do not count toward progress"
        );
    }

    #[test]
    fn view_reports_stage_missing_and_progress() {
        let s = full_core();
        let view = s.view(s.stage());
        assert_eq!(view.stage, Stage::Confirm);
        assert_eq!(view.progress.done, 8);
        assert_eq!(
            view.missing,
            vec!["hpi.location", "hpi.character", "hpi.modifiers"]
        );
    }
}
