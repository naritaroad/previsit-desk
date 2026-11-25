//! The renewal protocol engine: pure and deterministic. Same answers, same data, same day, same result.
//!
//! It sorts each item into `ready`, `review`, `in_person`, `urgent` or `excluded` and lists the rules that fired. The
//! result decides what a physician sees and how soon. It never approves, and it contains no dose and no drug choice.
//! Doubt goes up, never down: an unknown drug is excluded, an unanswered required question and an out-of-date
//! measurement need a look.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::Date;

use super::formulary::{Drug, Formulary};
use super::protocol::{
    ClassProtocol, Monitoring, MonitoringSet, Protocols, Question, QuestionKind, ValueKind,
    is_missing, non_blank, same_as_record_id,
};
use super::texts::{R, rt};
use super::{Disposition, LText, RenewalScope};
use crate::clock::parse_date;
use crate::precheck::{RedFlagMatch, RedFlagRules};
use crate::types::{Locale, RedFlagCategory, Urgency};

/// An item running out within this many days is handled sooner.
const SUPPLY_SOON_DAYS: i64 = 7;

#[derive(Debug, Clone)]
pub struct ItemInput {
    pub item_id: String,
    pub drug_id: String,
    /// From the prescription record; the stricter of this and the drug list counts.
    pub controlled_level: u8,
    /// Fills of the current prescription that can still be collected (0 when used up or expired).
    pub fills_left: i64,
}

pub struct EngineInput<'a> {
    pub today: Date,
    pub items: &'a [ItemInput],
    pub answers: &'a Map<String, Value>,
    pub monitoring: &'a MonitoringSet,
}

/// One rule that fired. Both languages are kept, so the result can be stored and read by anyone later.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fired {
    pub question_id: String,
    pub label: LText,
    pub answer: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer_label: Option<LText>,
    pub disposition: Disposition,
    pub reason: LText,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ItemResult {
    pub item_id: String,
    pub scope: RenewalScope,
    pub scope_reason: LText,
    pub disposition: Disposition,
    pub fired: Vec<Fired>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EngineOutput {
    pub protocol_version: String,
    pub disposition: Disposition,
    pub items: Vec<ItemResult>,
    /// Labels of measurements that are missing or too old.
    pub stale_monitoring: Vec<LText>,
    /// Required questions without an answer.
    pub unanswered: Vec<String>,
    /// Set exactly when something urgent fired.
    pub urgent: Option<UrgentNotice>,
}

/// What the fixed emergency text is about.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UrgentNotice {
    /// The red-flag category, when the wording names one. Self-harm has its own text.
    pub category: Option<RedFlagCategory>,
    /// Free text, or the answer to a question.
    pub from_text: bool,
    /// The red-flag label or the question's own label, never a diagnosis.
    pub label: LText,
}

impl UrgentNotice {
    /// Free text that matched a red-flag rule.
    pub fn from_text(hit: &RedFlagMatch) -> Self {
        Self {
            category: Some(hit.category),
            from_text: true,
            label: LText::new(&hit.label_zh, &hit.label_en),
        }
    }

    /// "您寫的內容提到「…」", for the patient.
    pub fn noticed(&self) -> LText {
        let key = if self.from_text {
            R::NoticedText
        } else {
            R::NoticedAnswer
        };
        pair_with(key, "label", &self.label)
    }

    /// `alerted`: the care team has been told. Never claim it when no ticket was opened.
    pub fn text(&self, alerted: bool, locale: Locale) -> String {
        super::texts::urgent_text(self.category, &self.noticed(), alerted, locale)
    }
}

/// Contract §4 `FiredRule`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FiredOut {
    pub question_id: String,
    pub label: String,
    pub answer: Value,
    pub disposition: Disposition,
    pub reason: String,
    pub source_url: Option<String>,
}

/// Contract §4 `EngineResult`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EngineResultOut {
    pub protocol_version: String,
    pub disposition: Disposition,
    pub evaluated_at: String,
    pub summary: String,
    pub stale_monitoring: Vec<String>,
}

impl Fired {
    pub fn to_out(&self, locale: Locale) -> FiredOut {
        FiredOut {
            question_id: self.question_id.clone(),
            label: self.label.get(locale).to_string(),
            answer: match &self.answer_label {
                Some(label) => Value::from(label.get(locale)),
                None => self.answer.clone(),
            },
            disposition: self.disposition,
            reason: self.reason.get(locale).to_string(),
            source_url: self.source_url.clone(),
        }
    }
}

impl EngineOutput {
    #[cfg(test)]
    pub fn item(&self, item_id: &str) -> Option<&ItemResult> {
        self.items.iter().find(|i| i.item_id == item_id)
    }

    /// Distinct questions that fired on items that can be submitted.
    pub fn points(&self) -> usize {
        let mut ids: Vec<&str> = self
            .items
            .iter()
            .filter(|i| i.disposition != Disposition::Excluded)
            .flat_map(|i| i.fired.iter().map(|f| f.question_id.as_str()))
            .collect();
        ids.sort_unstable();
        ids.dedup();
        ids.len()
    }

    /// Patients read the fixed emergency text when urgent; staff read what to do.
    pub fn summary(&self, locale: Locale, staff: bool, alerted: bool) -> String {
        let n = self.points().to_string();
        match self.disposition {
            Disposition::Ready => rt(R::SummaryReady, locale).to_string(),
            Disposition::Review => super::texts::rf(R::SummaryReview, locale, &[("n", &n)]),
            Disposition::InPerson => super::texts::rf(R::SummaryInPerson, locale, &[("n", &n)]),
            Disposition::Urgent if staff => rt(R::SummaryUrgentStaff, locale).to_string(),
            Disposition::Urgent => self
                .urgent
                .as_ref()
                .map(|u| u.text(alerted, locale))
                .unwrap_or_default(),
            Disposition::Excluded => rt(R::SummaryExcluded, locale).to_string(),
        }
    }

    pub fn to_out(
        &self,
        locale: Locale,
        staff: bool,
        alerted: bool,
        evaluated_at: String,
    ) -> EngineResultOut {
        EngineResultOut {
            protocol_version: self.protocol_version.clone(),
            disposition: self.disposition,
            evaluated_at,
            summary: self.summary(locale, staff, alerted),
            stale_monitoring: self
                .stale_monitoring
                .iter()
                .map(|l| l.get(locale).to_string())
                .collect(),
        }
    }

    /// Queue priority: urgent answers first; in-person signals or a supply about to end come sooner.
    pub fn priority(&self, min_days_left: Option<i64>) -> Urgency {
        match self.disposition {
            Disposition::Urgent => Urgency::Urgent,
            Disposition::InPerson => Urgency::Soon,
            _ if min_days_left.is_some_and(|d| d <= SUPPLY_SOON_DAYS) => Urgency::Soon,
            _ => Urgency::Routine,
        }
    }
}

fn pair(key: R) -> LText {
    let (zh, en) = key.pair();
    LText::new(zh, en)
}

fn pair_with(key: R, name: &str, value: &LText) -> LText {
    let (zh, en) = key.pair();
    let hole = format!("{{{name}}}");
    LText::new(zh.replace(&hole, &value.zh), en.replace(&hole, &value.en))
}

fn label_of(q: &Question) -> LText {
    LText::new(&q.label_zh, &q.label_en)
}

/// Scope of one item and why, before any answer is read.
fn scope_of(drug: Option<&Drug>, controlled_level: u8) -> (RenewalScope, LText, Option<Fired>) {
    let level = controlled_level.max(drug.map_or(0, |d| d.controlled_level));
    let fired = |id: &str, label: R, answer: Value, disposition, reason: LText, url| Fired {
        question_id: id.to_string(),
        label: pair(label),
        answer,
        answer_label: None,
        disposition,
        reason,
        source_url: url,
    };
    let Some(drug) = drug else {
        let reason = pair(R::ReasonUnknownDrug);
        return (
            RenewalScope::Excluded,
            reason.clone(),
            Some(fired(
                "scope",
                R::LabelScope,
                Value::Null,
                Disposition::Excluded,
                reason,
                None,
            )),
        );
    };
    let own_reason = |fallback: R| {
        if drug.reason.zh.is_empty() {
            pair(fallback)
        } else {
            drug.reason.clone()
        }
    };
    if level > 0 {
        let reason = own_reason(R::ReasonControlled);
        return (
            RenewalScope::Excluded,
            reason.clone(),
            Some(fired(
                "controlled_level",
                R::LabelControlled,
                json!(level),
                Disposition::Excluded,
                reason,
                drug.source_url.clone(),
            )),
        );
    }
    match drug.renewal_scope {
        RenewalScope::InScope => (RenewalScope::InScope, drug.reason.clone(), None),
        RenewalScope::PhysicianOnly => {
            let reason = own_reason(R::ReasonPhysicianOnly);
            (
                RenewalScope::PhysicianOnly,
                reason.clone(),
                Some(fired(
                    "scope",
                    R::LabelScope,
                    json!(RenewalScope::PhysicianOnly),
                    Disposition::Review,
                    reason,
                    drug.source_url.clone(),
                )),
            )
        }
        RenewalScope::Excluded => {
            let reason = own_reason(R::SummaryExcluded);
            (
                RenewalScope::Excluded,
                reason.clone(),
                Some(fired(
                    "scope",
                    R::LabelScope,
                    json!(RenewalScope::Excluded),
                    Disposition::Excluded,
                    reason,
                    drug.source_url.clone(),
                )),
            )
        }
    }
}

/// Scope and reason of a drug for display, without evaluating anything.
pub fn scope_for(
    formulary: &Formulary,
    drug_id: &str,
    controlled_level: u8,
) -> (RenewalScope, LText) {
    let (scope, reason, _) = scope_of(formulary.get(drug_id), controlled_level);
    (scope, reason)
}

struct Run<'a> {
    input: &'a EngineInput<'a>,
    red_flags: &'a RedFlagRules,
    unanswered: Vec<String>,
    stale: Vec<LText>,
    urgent: Vec<UrgentNotice>,
}

impl Run<'_> {
    fn note_unanswered(&mut self, id: &str, label: &LText, fired: &mut Vec<Fired>) {
        if !self.unanswered.iter().any(|u| u == id) {
            self.unanswered.push(id.to_string());
        }
        fired.push(Fired {
            question_id: id.to_string(),
            label: pair_with(R::LabelUnanswered, "label", label),
            answer: Value::Null,
            answer_label: None,
            disposition: Disposition::Review,
            reason: pair(R::ReasonUnanswered),
            source_url: None,
        });
    }

    fn questions(&mut self, questions: &[Question], fired: &mut Vec<Fired>) {
        for q in questions {
            let answer = self.input.answers.get(&q.id);
            let label = label_of(q);
            let before = fired.len();
            for rule in &q.rules {
                if !rule.when.matches(answer) {
                    continue;
                }
                let answer_label = answer.and_then(Value::as_str).and_then(|value| {
                    q.options
                        .iter()
                        .flatten()
                        .find(|o| o.value == value)
                        .map(|o| LText::new(&o.label_zh, &o.label_en))
                });
                if rule.disposition == Disposition::Urgent {
                    self.urgent_rule(&label, &rule.reason_zh);
                }
                fired.push(Fired {
                    question_id: q.id.clone(),
                    label: label.clone(),
                    answer: answer.cloned().unwrap_or(Value::Null),
                    answer_label,
                    disposition: rule.disposition,
                    reason: LText::new(&rule.reason_zh, &rule.reason_en),
                    source_url: non_blank(&rule.source_url),
                });
            }
            if q.required && is_missing(answer) && fired.len() == before {
                self.note_unanswered(&q.id, &label, fired);
            }
            // Free text goes through the same red-flag rules as chat messages.
            if q.kind == QuestionKind::Text
                && let Some(text) = answer.and_then(Value::as_str)
                && let Some(hit) = self.red_flags.check(text)
            {
                self.urgent.push(UrgentNotice::from_text(&hit));
                fired.push(Fired {
                    question_id: q.id.clone(),
                    label,
                    answer: Value::from(text),
                    answer_label: None,
                    disposition: Disposition::Urgent,
                    reason: pair_with(
                        R::ReasonRedFlagText,
                        "label",
                        &LText::new(hit.label_zh, hit.label_en),
                    ),
                    source_url: None,
                });
            }
        }
    }

    /// Which emergency text fits an urgent rule: the red-flag category its own wording names, else the general one.
    fn urgent_rule(&mut self, label: &LText, reason_zh: &str) {
        let category = self
            .red_flags
            .check(reason_zh)
            .or_else(|| self.red_flags.check(&label.zh))
            .map(|hit| hit.category);
        self.urgent.push(UrgentNotice {
            category,
            from_text: false,
            label: label.clone(),
        });
    }

    fn monitoring(&mut self, list: &[Monitoring], fired: &mut Vec<Fired>) {
        for m in list {
            let label = LText::new(&m.label_zh, &m.label_en);
            let entry = self.input.monitoring.get(&m.id);
            let date = entry.and_then(|e| e.date.as_deref()).and_then(parse_date);
            let value = entry.and_then(|e| e.value);
            let complete =
                date.is_some() && (m.value_kind == ValueKind::DateOnly || value.is_some());
            let fresh = complete
                && date.is_some_and(|d| {
                    let age = (self.input.today - d).whole_days();
                    age >= 0 && m.max_age_days.is_none_or(|max| age <= max)
                });
            let answer = match entry {
                None => Value::Null,
                Some(_) if m.value_kind == ValueKind::DateOnly => {
                    json!(entry.and_then(|e| e.date.clone()))
                }
                Some(e) => match (&e.value, &e.date) {
                    (Some(v), Some(d)) => json!(format!(
                        "{v}{} ({d})",
                        non_blank(&m.unit)
                            .map(|u| format!(" {u}"))
                            .unwrap_or_default()
                    )),
                    (Some(v), None) => json!(v),
                    (None, d) => json!(d),
                },
            };
            if !fresh {
                if !self.stale.contains(&label) {
                    self.stale.push(label.clone());
                }
                fired.push(Fired {
                    question_id: m.id.clone(),
                    label: label.clone(),
                    answer: answer.clone(),
                    answer_label: None,
                    disposition: m.stale_disposition,
                    reason: LText::new(&m.reason_zh, &m.reason_en),
                    source_url: non_blank(&m.source_url),
                });
            }
            // An old reading says nothing about today, but one without a date might be from today.
            let usable = fresh || date.is_none();
            let number = value.filter(|_| usable).map(Value::from);
            for rule in &m.rules {
                let matched = match rule.when.op {
                    super::protocol::Op::Missing => !complete && rule.when.matches(number.as_ref()),
                    _ => rule.when.matches(number.as_ref()),
                };
                if !matched {
                    continue;
                }
                if rule.disposition == Disposition::Urgent {
                    self.urgent_rule(&label, &rule.reason_zh);
                }
                fired.push(Fired {
                    question_id: m.id.clone(),
                    label: label.clone(),
                    answer: answer.clone(),
                    answer_label: None,
                    disposition: rule.disposition,
                    reason: LText::new(&rule.reason_zh, &rule.reason_en),
                    source_url: non_blank(&rule.source_url).or_else(|| non_blank(&m.source_url)),
                });
            }
        }
    }
}

/// Within one question the strongest rules speak: a value of 190 fires "very high", and "high" adds nothing.
fn keep_strongest(fired: Vec<Fired>) -> Vec<Fired> {
    let strongest = |id: &str| {
        fired
            .iter()
            .filter(|f| f.question_id == id)
            .map(|f| f.disposition)
            .max()
    };
    let mut out: Vec<Fired> = Vec::new();
    for f in &fired {
        if strongest(&f.question_id) == Some(f.disposition) && !out.contains(f) {
            out.push(f.clone());
        }
    }
    out
}

pub fn evaluate(
    formulary: &Formulary,
    protocols: &Protocols,
    red_flags: &RedFlagRules,
    input: &EngineInput<'_>,
) -> EngineOutput {
    let mut run = Run {
        input,
        red_flags,
        unanswered: Vec::new(),
        stale: Vec::new(),
        urgent: Vec::new(),
    };
    let mut items = Vec::new();
    for item in input.items {
        let drug = formulary.get(&item.drug_id);
        let (scope, scope_reason, scope_fired) = scope_of(drug, item.controlled_level);
        let mut fired: Vec<Fired> = scope_fired.into_iter().collect();
        if scope != RenewalScope::Excluded {
            let name = drug
                .map(|d| d.name.clone())
                .unwrap_or_else(|| pair(R::LabelScope));
            let same_id = same_as_record_id(&item.item_id);
            let same_label = pair_with(R::QSameAsRecord, "drug", &name);
            match input.answers.get(&same_id) {
                Some(Value::Bool(true)) => {}
                Some(Value::Bool(false)) => fired.push(Fired {
                    question_id: same_id,
                    label: same_label,
                    answer: Value::Bool(false),
                    answer_label: None,
                    disposition: Disposition::Review,
                    reason: pair(R::ReasonNotSame),
                    source_url: None,
                }),
                _ => run.note_unanswered(&same_id, &same_label, &mut fired),
            }
            if item.fills_left > 0 {
                let n = item.fills_left.to_string();
                fired.push(Fired {
                    question_id: "fills_left".into(),
                    label: pair(R::LabelFillsLeft),
                    answer: json!(item.fills_left),
                    answer_label: None,
                    disposition: Disposition::Review,
                    reason: pair_with(R::ReasonFillsLeft, "n", &LText::new(&n, &n)),
                    source_url: None,
                });
            }
            run.questions(&protocols.general.questions, &mut fired);
            let class: Option<&ClassProtocol> = drug.and_then(|d| protocols.class(&d.class_id));
            match class {
                Some(class) => {
                    run.questions(&class.questions, &mut fired);
                    run.monitoring(&class.monitoring, &mut fired);
                }
                // Loading refuses an in-scope drug without a protocol, so this only guards against new code paths.
                None if scope == RenewalScope::InScope => fired.push(Fired {
                    question_id: "protocol".into(),
                    label: pair(R::LabelScope),
                    answer: Value::Null,
                    answer_label: None,
                    disposition: Disposition::Review,
                    reason: pair(R::ReasonNoProtocol),
                    source_url: None,
                }),
                None => {}
            }
        }
        let fired = keep_strongest(fired);
        let disposition = if scope == RenewalScope::Excluded {
            Disposition::Excluded
        } else {
            fired
                .iter()
                .map(|f| f.disposition)
                .max()
                .unwrap_or(Disposition::Ready)
        };
        items.push(ItemResult {
            item_id: item.item_id.clone(),
            scope,
            scope_reason,
            disposition,
            fired,
        });
    }
    let disposition = items
        .iter()
        .map(|i| i.disposition)
        .filter(|d| *d != Disposition::Excluded)
        .max()
        .unwrap_or(Disposition::Excluded);
    let urgent = if disposition == Disposition::Urgent {
        // The self-harm text also names 119, so it wins over the others.
        run.urgent
            .iter()
            .find(|u| u.category == Some(RedFlagCategory::Suicide))
            .or_else(|| run.urgent.first())
            .cloned()
    } else {
        None
    };
    EngineOutput {
        protocol_version: protocols.version.clone(),
        disposition,
        items,
        stale_monitoring: run.stale,
        unanswered: run.unanswered,
        urgent,
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures;
    use super::super::protocol::{MonitoringEntry, Source};
    use super::*;
    use time::macros::date;

    const TODAY: Date = date!(2026 - 11 - 25);

    fn item(id: &str, drug: &str) -> ItemInput {
        ItemInput {
            item_id: id.into(),
            drug_id: drug.into(),
            controlled_level: 0,
            fills_left: 0,
        }
    }

    fn bp(value: f64, date: &str) -> MonitoringSet {
        MonitoringSet::from([(
            "bp_systolic".to_string(),
            MonitoringEntry {
                value: Some(value),
                date: Some(date.into()),
                source: Source::Patient,
            },
        )])
    }

    /// Answers that fire nothing for the given items.
    fn calm(items: &[ItemInput]) -> Map<String, Value> {
        let mut answers = json!({
            "chest_pain_now": false, "symptom_change": "same", "new_drug": false,
            "leg_swelling": false, "pregnant": "no", "muscle_pain": 0, "last_meal_note": "三餐正常"
        })
        .as_object()
        .expect("object")
        .clone();
        for i in items {
            answers.insert(same_as_record_id(&i.item_id), json!(true));
        }
        answers
    }

    fn run(
        items: &[ItemInput],
        answers: &Map<String, Value>,
        monitoring: &MonitoringSet,
    ) -> EngineOutput {
        let rules = fixtures::rules();
        evaluate(
            &rules.formulary,
            &rules.protocols,
            &fixtures::red_flags(),
            &EngineInput {
                today: TODAY,
                items,
                answers,
                monitoring,
            },
        )
    }

    fn with(items: &[ItemInput], patch: Value) -> Map<String, Value> {
        let mut answers = calm(items);
        for (k, v) in patch.as_object().expect("object") {
            answers.insert(k.clone(), v.clone());
        }
        answers
    }

    #[test]
    fn calm_answers_and_fresh_data_are_ready_and_still_say_a_physician_decides() {
        let items = [item("a", "amlodipine")];
        let out = run(&items, &calm(&items), &bp(128.0, "2026-11-20"));
        assert_eq!(out.disposition, Disposition::Ready);
        assert!(out.items[0].fired.is_empty() && out.unanswered.is_empty());
        assert!(out.urgent.is_none());
        assert!(
            out.summary(Locale::ZhTw, false, true)
                .contains("不代表核准")
        );
        assert_eq!(out.priority(Some(20)), Urgency::Routine);
        assert_eq!(out.priority(Some(3)), Urgency::Soon);
    }

    #[test]
    fn the_same_input_always_gives_the_same_output() {
        let items = [item("a", "amlodipine"), item("b", "losartan")];
        let answers = with(&items, json!({"new_drug": true}));
        let first = run(&items, &answers, &MonitoringSet::new());
        for _ in 0..5 {
            assert_eq!(run(&items, &answers, &MonitoringSet::new()), first);
        }
    }

    #[test]
    fn a_class_rule_touches_only_its_own_class() {
        let items = [item("a", "amlodipine"), item("b", "atorvastatin")];
        let out = run(
            &items,
            &with(&items, json!({"leg_swelling": true})),
            &bp(128.0, "2026-11-20"),
        );
        assert_eq!(out.item("a").expect("a").disposition, Disposition::Review);
        assert_eq!(out.item("b").expect("b").disposition, Disposition::Ready);
        assert_eq!(out.disposition, Disposition::Review);
        assert_eq!(out.points(), 1);
    }

    #[test]
    fn a_general_rule_touches_every_open_item() {
        let items = [
            item("a", "amlodipine"),
            item("b", "atorvastatin"),
            item("c", "zolpidem"),
        ];
        let out = run(
            &items,
            &with(&items, json!({"symptom_change": "worse"})),
            &bp(128.0, "2026-11-20"),
        );
        for id in ["a", "b"] {
            assert_eq!(
                out.item(id).expect("item").disposition,
                Disposition::InPerson
            );
        }
        assert_eq!(out.item("c").expect("c").disposition, Disposition::Excluded);
        assert_eq!(out.disposition, Disposition::InPerson);
        assert_eq!(out.priority(None), Urgency::Soon);
        let fired = out.items[0].fired[0].to_out(Locale::ZhTw);
        assert_eq!(fired.answer, json!("變差"), "a choice shows its label");
        assert_eq!(
            out.items[0].fired[0].to_out(Locale::En).answer,
            json!("Worse")
        );
    }

    #[test]
    fn urgent_answers_show_the_fixed_emergency_text() {
        let items = [item("a", "amlodipine")];
        let out = run(
            &items,
            &with(&items, json!({"chest_pain_now": true})),
            &bp(128.0, "2026-11-20"),
        );
        assert_eq!(out.disposition, Disposition::Urgent);
        let urgent = out.urgent.as_ref().expect("urgent");
        assert_eq!(urgent.category, Some(RedFlagCategory::ChestPain));
        let before = out.summary(Locale::ZhTw, false, false);
        let after = out.summary(Locale::ZhTw, false, true);
        assert!(before.contains("119") && before.contains("現在有胸痛"));
        assert!(after.contains("醫療團隊已收到通知") && !before.contains("已收到通知"));
        assert!(
            !out.summary(Locale::ZhTw, true, true).contains("119"),
            "staff read what to do instead"
        );
        assert_eq!(out.priority(Some(30)), Urgency::Urgent);
    }

    #[test]
    fn free_text_goes_through_the_red_flag_rules() {
        let items = [item("a", "atorvastatin")];
        let out = run(
            &items,
            &with(&items, json!({"note": "最近很累，我想死"})),
            &MonitoringSet::new(),
        );
        assert_eq!(out.disposition, Disposition::Urgent);
        let urgent = out.urgent.as_ref().expect("urgent");
        assert_eq!(urgent.category, Some(RedFlagCategory::Suicide));
        assert!(urgent.text(true, Locale::ZhTw).contains("1925"));
        let calm_text = run(
            &items,
            &with(&items, json!({"note": "我沒有胸痛，想換成早上領藥"})),
            &MonitoringSet::new(),
        );
        assert_eq!(calm_text.disposition, Disposition::Ready);
    }

    #[test]
    fn self_harm_wins_when_several_emergencies_are_named() {
        let items = [item("a", "atorvastatin")];
        let out = run(
            &items,
            &with(&items, json!({"chest_pain_now": true, "note": "我想死"})),
            &MonitoringSet::new(),
        );
        assert_eq!(
            out.urgent.expect("urgent").category,
            Some(RedFlagCategory::Suicide)
        );
    }

    #[test]
    fn monitoring_age_and_value_are_both_checked() {
        let items = [item("a", "amlodipine")];
        let answers = calm(&items);
        let at = |m: &MonitoringSet| run(&items, &answers, m);

        assert_eq!(
            at(&bp(128.0, "2026-10-26")).disposition,
            Disposition::Ready,
            "exactly 30 days old"
        );
        let old = at(&bp(128.0, "2026-10-25"));
        assert_eq!(old.disposition, Disposition::Review, "31 days old");
        assert_eq!(old.stale_monitoring.len(), 1);
        let missing = at(&MonitoringSet::new());
        assert_eq!(missing.disposition, Disposition::Review);
        assert_eq!(
            missing
                .to_out(Locale::ZhTw, true, true, String::new())
                .stale_monitoring,
            ["收縮壓"]
        );

        assert_eq!(
            at(&bp(155.0, "2026-11-24")).disposition,
            Disposition::InPerson
        );
        assert_eq!(
            at(&bp(190.0, "2026-11-24")).disposition,
            Disposition::Urgent
        );
        assert_eq!(
            at(&bp(190.0, "2026-09-01")).disposition,
            Disposition::Review,
            "a two-month-old reading is out of date, not an emergency today"
        );
        let mut undated = bp(190.0, "2026-11-24");
        undated.get_mut("bp_systolic").expect("bp").date = None;
        assert_eq!(
            at(&undated).disposition,
            Disposition::Urgent,
            "without a date it might be from today"
        );
        assert_eq!(
            at(&bp(128.0, "2026-11-26")).disposition,
            Disposition::Review,
            "a future date is not fresh"
        );
    }

    #[test]
    fn only_the_strongest_rule_of_a_question_is_listed() {
        let items = [item("a", "amlodipine")];
        let out = run(&items, &calm(&items), &bp(190.0, "2026-11-24"));
        assert_eq!(out.items[0].fired.len(), 1);
        assert_eq!(out.items[0].fired[0].reason.zh, "血壓很高。");
    }

    #[test]
    fn date_only_monitoring_needs_just_a_recent_date() {
        let items = [item("b", "losartan")];
        let mut m = bp(128.0, "2026-11-20");
        let without = run(&items, &calm(&items), &m);
        assert_eq!(without.disposition, Disposition::InPerson);
        m.insert(
            "kidney_test".into(),
            MonitoringEntry {
                value: None,
                date: Some("2026-03-01".into()),
                source: Source::Clinic,
            },
        );
        assert_eq!(
            run(&items, &calm(&items), &m).disposition,
            Disposition::Ready
        );
    }

    #[test]
    fn scope_controlled_level_and_unknown_drugs() {
        let items = [
            item("w", "warfarin"),
            item("i", "insulin_glargine"),
            item("z", "zolpidem"),
            item("u", "something_else"),
        ];
        let out = run(&items, &calm(&items), &MonitoringSet::new());
        assert_eq!(out.item("w").expect("w").disposition, Disposition::Review);
        for id in ["i", "z", "u"] {
            let it = out.item(id).expect("item");
            assert_eq!(it.disposition, Disposition::Excluded, "{id}");
            assert_eq!(it.fired.len(), 1, "{id}: only the scope reason");
            assert!(!it.scope_reason.zh.is_empty());
        }
        assert_eq!(out.disposition, Disposition::Review);
    }

    #[test]
    fn a_controlled_level_on_the_prescription_alone_excludes_the_item() {
        let mut items = [item("a", "amlodipine")];
        items[0].controlled_level = 3;
        let out = run(&items, &calm(&items), &bp(128.0, "2026-11-20"));
        assert_eq!(out.disposition, Disposition::Excluded);
        assert_eq!(out.items[0].fired[0].question_id, "controlled_level");
    }

    #[test]
    fn all_excluded_is_excluded_and_nothing_is_asked() {
        let items = [item("z", "zolpidem")];
        let out = run(&items, &Map::new(), &MonitoringSet::new());
        assert_eq!(out.disposition, Disposition::Excluded);
        assert!(out.unanswered.is_empty());
        assert_eq!(
            run(&[], &Map::new(), &MonitoringSet::new()).disposition,
            Disposition::Excluded
        );
    }

    #[test]
    fn unanswered_required_questions_never_count_as_fine() {
        let items = [item("a", "atorvastatin")];
        let out = run(&items, &Map::new(), &MonitoringSet::new());
        assert_eq!(out.disposition, Disposition::Review);
        assert!(out.unanswered.contains(&"muscle_pain".to_string()));
        assert!(out.unanswered.contains(&"same_as_record:a".to_string()));
        assert!(!out.unanswered.contains(&"note".to_string()));
    }

    #[test]
    fn taking_it_differently_and_fills_left_need_a_look() {
        let mut items = [item("a", "atorvastatin")];
        items[0].fills_left = 1;
        let out = run(
            &items,
            &with(&items, json!({"same_as_record:a": false})),
            &MonitoringSet::new(),
        );
        assert_eq!(out.disposition, Disposition::Review);
        let ids: Vec<&str> = out.items[0]
            .fired
            .iter()
            .map(|f| f.question_id.as_str())
            .collect();
        assert_eq!(ids, ["same_as_record:a", "fills_left"]);
    }

    #[test]
    fn numbers_lists_and_missing_rules_fire() {
        let statin = [item("a", "atorvastatin")];
        for (score, expected) in [
            (0, Disposition::Ready),
            (2, Disposition::Ready),
            (3, Disposition::Review),
            (7, Disposition::InPerson),
        ] {
            let out = run(
                &statin,
                &with(&statin, json!({"muscle_pain": score})),
                &MonitoringSet::new(),
            );
            assert_eq!(out.disposition, expected, "score {score}");
        }
        let metformin = [item("m", "metformin")];
        let mut answers = calm(&metformin);
        answers.remove("last_meal_note");
        assert_eq!(
            run(&metformin, &answers, &MonitoringSet::new()).disposition,
            Disposition::Review
        );
    }

    /// Adding a worse answer can only raise the result.
    #[test]
    fn worse_answers_never_lower_the_disposition() {
        let items = [item("a", "amlodipine"), item("b", "atorvastatin")];
        let base = run(&items, &calm(&items), &bp(128.0, "2026-11-20")).disposition;
        let mut worst = base;
        let mut answers = calm(&items);
        for (key, value) in [
            ("new_drug", json!(true)),
            ("leg_swelling", json!(true)),
            ("symptom_change", json!("worse")),
            ("muscle_pain", json!(9)),
            ("chest_pain_now", json!(true)),
        ] {
            answers.insert(key.into(), value);
            let now = run(&items, &answers, &bp(128.0, "2026-11-20")).disposition;
            assert!(now >= worst, "{key} lowered {worst:?} to {now:?}");
            worst = now;
        }
        assert_eq!(worst, Disposition::Urgent);
    }

    /// Whatever the answers, the output has no field or word for approving, dosing or changing the drug.
    #[test]
    fn output_has_no_approval_and_no_dose() {
        let items = [
            item("a", "amlodipine"),
            item("w", "warfarin"),
            item("z", "zolpidem"),
        ];
        for answers in [
            calm(&items),
            with(&items, json!({"new_drug": true})),
            Map::new(),
        ] {
            let out = run(&items, &answers, &MonitoringSet::new());
            let text = serde_json::to_string(&out).expect("json").to_lowercase();
            for word in [
                "approve", "\"dose", "dosage", "核准", "劑量", "5 mg", "10 mg",
            ] {
                assert!(!text.contains(word), "{word} in {text}");
            }
        }
    }

    #[test]
    fn the_stored_result_survives_a_round_trip() {
        let items = [item("a", "amlodipine"), item("z", "zolpidem")];
        let out = run(
            &items,
            &with(&items, json!({"chest_pain_now": true})),
            &MonitoringSet::new(),
        );
        let stored = serde_json::to_value(&out).expect("json");
        let back: EngineOutput = serde_json::from_value(stored).expect("back");
        assert_eq!(back, out);
    }

    #[test]
    fn a_value_without_an_interval_is_only_stale_when_absent() {
        let mut rules = fixtures::rules();
        for class in &mut rules.protocols.classes {
            for m in &mut class.monitoring {
                m.max_age_days = None;
            }
        }
        let items = [item("a", "amlodipine")];
        let answers = calm(&items);
        let at = |monitoring: &MonitoringSet| {
            evaluate(
                &rules.formulary,
                &rules.protocols,
                &fixtures::red_flags(),
                &EngineInput {
                    today: TODAY,
                    items: &items,
                    answers: &answers,
                    monitoring,
                },
            )
            .disposition
        };
        assert_eq!(at(&bp(128.0, "2024-01-01")), Disposition::Ready);
        assert_eq!(at(&MonitoringSet::new()), Disposition::Review);
    }

    /// Sweeps the shipped drug list and protocols (skipped while another workstream is still writing them): every drug
    /// gets a scope, every rule of every question can fire, and every urgent rule shows a text that names 119.
    #[test]
    fn every_shipped_rule_can_fire() {
        let Ok(rules) = super::super::RxRules::load(&fixtures::data_dir()) else {
            assert!(
                !fixtures::data_dir()
                    .join("seed")
                    .join(super::super::PROTOCOL_FILE)
                    .is_file(),
                "the shipped files exist but do not load"
            );
            return;
        };
        let red_flags = fixtures::red_flags();
        let mut checked = 0;
        for drug in rules.formulary.drugs() {
            let items = [item("x", &drug.drug_id)];
            let Some(class) = rules.protocols.class(&drug.class_id) else {
                continue;
            };
            for q in rules
                .protocols
                .general
                .questions
                .iter()
                .chain(&class.questions)
            {
                for rule in &q.rules {
                    use super::super::protocol::Op;
                    let value = rule.when.value.clone().unwrap_or(Value::Null);
                    let answer = match rule.when.op {
                        Op::Missing => Value::Null,
                        Op::In => value[0].clone(),
                        Op::Gt => json!(value.as_f64().expect("number") + 1.0),
                        Op::Lt => json!(value.as_f64().expect("number") - 1.0),
                        Op::Neq => continue,
                        _ => value,
                    };
                    let mut answers = Map::new();
                    answers.insert(q.id.clone(), answer);
                    let out = evaluate(
                        &rules.formulary,
                        &rules.protocols,
                        &red_flags,
                        &EngineInput {
                            today: TODAY,
                            items: &items,
                            answers: &answers,
                            monitoring: &MonitoringSet::new(),
                        },
                    );
                    assert!(
                        out.items[0]
                            .fired
                            .iter()
                            .any(|f| f.question_id == q.id && f.disposition >= rule.disposition),
                        "{} {}",
                        drug.drug_id,
                        q.id
                    );
                    if rule.disposition == Disposition::Urgent {
                        assert!(
                            out.urgent
                                .as_ref()
                                .expect("urgent")
                                .text(true, Locale::ZhTw)
                                .contains("119")
                        );
                    }
                    checked += 1;
                }
            }
        }
        assert!(checked > 100, "{checked}");
    }

    /// `cargo test rx::engine::tests::print_six_examples -- --nocapture` prints what a physician would see.
    #[test]
    fn print_six_examples() {
        let a = [item("a", "amlodipine")];
        let two = [item("a", "amlodipine"), item("b", "losartan")];
        let mixed = [item("w", "warfarin"), item("z", "zolpidem")];
        let fresh = bp(128.0, "2026-11-20");
        let cases = [
            ("1 ready", run(&a, &calm(&a), &fresh)),
            (
                "2 review",
                run(
                    &a,
                    &with(&a, json!({"new_drug": true})),
                    &MonitoringSet::new(),
                ),
            ),
            (
                "3 in_person",
                run(&two, &with(&two, json!({"pregnant": "unsure"})), &fresh),
            ),
            (
                "4 urgent (answer)",
                run(&a, &with(&a, json!({"chest_pain_now": true})), &fresh),
            ),
            (
                "5 urgent (free text)",
                run(&a, &with(&a, json!({"note": "我不想活了"})), &fresh),
            ),
            (
                "6 physician_only + excluded",
                run(&mixed, &calm(&mixed), &fresh),
            ),
        ];
        for (name, out) in &cases {
            println!(
                "== {name}: overall {} | {}",
                out.disposition.as_str(),
                out.summary(Locale::ZhTw, false, true).replace('\n', " ")
            );
            for i in &out.items {
                println!(
                    "   item {} scope={} disposition={}",
                    i.item_id,
                    i.scope.as_str(),
                    i.disposition.as_str()
                );
                for f in &i.fired {
                    let f = f.to_out(Locale::ZhTw);
                    println!(
                        "     - {} = {} -> {} | {}",
                        f.question_id,
                        f.answer,
                        f.disposition.as_str(),
                        f.reason
                    );
                }
            }
        }
        let got: Vec<Disposition> = cases.iter().map(|(_, o)| o.disposition).collect();
        assert_eq!(
            got,
            [
                Disposition::Ready,
                Disposition::Review,
                Disposition::InPerson,
                Disposition::Urgent,
                Disposition::Urgent,
                Disposition::Review
            ]
        );
    }
}
