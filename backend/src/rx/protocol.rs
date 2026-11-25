//! Renewal question protocols (`data/seed/renewal_protocols.json`): loading, strict validation, the question list a
//! request needs, and the check of what a patient sends back. Unknown fields, rules that can never fire, duplicate ids
//! and one-language texts all refuse to start.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use anyhow::{Context, Result, bail, ensure};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use time::Date;

use super::formulary::{is_identifier, is_url};
use super::texts::{R, rf, rt};
use super::{Disposition, LText, RenewalScope, RxKind, wire_enum};
use crate::clock::{format_date, parse_date};
use crate::pii;
use crate::refill::FieldErrors;
use crate::texts::{T, fmt, t};
use crate::types::{Locale, SpecialStatus};

/// Longest free-text answer, in characters.
pub const MAX_TEXT_CHARS: usize = 1000;
/// A monitoring value outside this range is a typing error for every measurement we ask about.
const MAX_MONITORING_VALUE: f64 = 10_000.0;

pub const SAME_AS_RECORD: &str = "same_as_record";
pub const REFILL_SYMPTOM: &str = "symptom_changed";
pub const REFILL_SIDE_EFFECTS: &str = "side_effects";
pub const REFILL_SPECIAL: &str = "special_status";

wire_enum!(QuestionKind { Boolean => "boolean", Choice => "choice", Number => "number", Text => "text" });
wire_enum!(ValueKind { Number => "number", DateOnly => "date_only" });
wire_enum!(Op {
    Eq => "eq",
    Neq => "neq",
    Gt => "gt",
    Gte => "gte",
    Lt => "lt",
    Lte => "lte",
    In => "in",
    Missing => "missing",
});

// ---------------------------------------------------------------------------
// File shape
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct When {
    pub op: Op,
    #[serde(default)]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub when: When,
    pub disposition: Disposition,
    pub reason_zh: String,
    pub reason_en: String,
    #[serde(default)]
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    pub value: String,
    pub label_zh: String,
    pub label_en: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Question {
    pub id: String,
    pub kind: QuestionKind,
    pub label_zh: String,
    pub label_en: String,
    #[serde(default)]
    pub help_zh: Option<String>,
    #[serde(default)]
    pub help_en: Option<String>,
    #[serde(default)]
    pub options: Option<Vec<Choice>>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    pub required: bool,
    #[serde(default)]
    pub rules: Vec<Rule>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Monitoring {
    pub id: String,
    pub label_zh: String,
    pub label_en: String,
    /// `null`: the source gives no interval, so only a missing value counts as out of date.
    pub max_age_days: Option<i64>,
    pub value_kind: ValueKind,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub rules: Vec<Rule>,
    pub stale_disposition: Disposition,
    pub reason_zh: String,
    pub reason_en: String,
    #[serde(default)]
    pub source_type: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub verified_on: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct General {
    pub questions: Vec<Question>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClassProtocol {
    pub class_id: String,
    pub title_zh: String,
    pub title_en: String,
    pub summary_zh: String,
    pub summary_en: String,
    pub questions: Vec<Question>,
    pub monitoring: Vec<Monitoring>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Protocols {
    pub version: String,
    /// Who signed off, as written by the maintainer: a string, or an object with one text per language.
    pub approved_by_note: Value,
    pub general: General,
    pub classes: Vec<ClassProtocol>,
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn has_cjk(text: &str) -> bool {
    text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

fn both(owner: &str, what: &str, zh: &str, en: &str) -> Result<()> {
    ensure!(!zh.trim().is_empty(), "{owner}: {what}_zh is empty");
    ensure!(!en.trim().is_empty(), "{owner}: {what}_en is empty");
    ensure!(has_cjk(zh), "{owner}: {what}_zh has no Chinese");
    ensure!(!has_cjk(en), "{owner}: {what}_en contains Chinese");
    Ok(())
}

/// Whether a reason tells the patient to change their medicine ("請立刻停藥"). Saying that a change should be discussed
/// with the physician, or must not be made, is fine.
fn tells_to_change_medicine(zh: &str, en: &str) -> bool {
    static ZH: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new("(請|立刻|立即|馬上|應|先|需要).{0,6}(停藥|停用|換藥|加藥|減藥|加量|減量|停止服用|停止吃)")
            .expect("regex")
    });
    static EN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)(^|[.;!?]\s+)(please\s+)?(stop|increase|reduce|lower|raise|switch|change|double|halve)\b")
            .expect("regex")
    });
    let zh_hit = zh
        .split(['。', '，', '；', '、'])
        .filter(|clause| !["醫師", "不", "勿", "別"].iter().any(|w| clause.contains(w)))
        .any(|clause| ZH.is_match(clause));
    zh_hit || EN.is_match(en.trim())
}

fn check_reason(owner: &str, zh: &str, en: &str) -> Result<()> {
    both(owner, "reason", zh, en)?;
    ensure!(
        !tells_to_change_medicine(zh, en),
        "{owner}: a reason may not tell the patient to stop or change a medicine"
    );
    Ok(())
}

fn blank(text: &Option<String>) -> bool {
    text.as_deref().is_none_or(|s| s.trim().is_empty())
}

fn check_url(owner: &str, url: &Option<String>) -> Result<()> {
    match url.as_deref().map(str::trim) {
        None | Some("") => Ok(()),
        Some(u) => {
            ensure!(is_url(u), "{owner}: bad source_url {u}");
            Ok(())
        }
    }
}

/// What a rule value must look like for the answer it is compared with.
enum Answers<'a> {
    Boolean,
    Choice(&'a [Choice]),
    Number { min: Option<f64>, max: Option<f64> },
    Text,
    DateOnly,
}

fn check_rule(owner: &str, rule: &Rule, answers: &Answers<'_>) -> Result<()> {
    check_reason(owner, &rule.reason_zh, &rule.reason_en)?;
    check_url(owner, &rule.source_url)?;
    ensure!(
        matches!(
            rule.disposition,
            Disposition::Review | Disposition::InPerson | Disposition::Urgent
        ),
        "{owner}: a rule may only lead to review, in_person or urgent"
    );
    let op = rule.when.op;
    if op == Op::Missing {
        ensure!(rule.when.value.is_none(), "{owner}: missing takes no value");
        return Ok(());
    }
    let value = rule
        .when
        .value
        .as_ref()
        .with_context(|| format!("{owner}: {} needs a value", op.as_str()))?;
    let one_ok = |v: &Value| -> bool {
        match answers {
            Answers::Boolean => v.is_boolean(),
            Answers::Choice(options) => v
                .as_str()
                .is_some_and(|s| options.iter().any(|o| o.value == s)),
            Answers::Number { .. } => v.as_f64().is_some(),
            Answers::Text => v.is_string(),
            Answers::DateOnly => false,
        }
    };
    match op {
        Op::In => {
            let list = value
                .as_array()
                .filter(|l| !l.is_empty())
                .with_context(|| format!("{owner}: in needs a list"))?;
            ensure!(
                !matches!(answers, Answers::Boolean),
                "{owner}: in does not fit a yes/no question"
            );
            ensure!(list.iter().all(one_ok), "{owner}: bad value in list");
        }
        Op::Eq | Op::Neq => ensure!(one_ok(value), "{owner}: the rule value does not fit"),
        _ => {
            let Answers::Number { min, max } = answers else {
                bail!("{owner}: {} only fits a number", op.as_str());
            };
            let n = value
                .as_f64()
                .with_context(|| format!("{owner}: the rule value must be a number"))?;
            // A threshold nobody can reach is a typing error, and a rule that never fires is worse than none.
            let reachable = match op {
                Op::Gt => max.is_none_or(|m| n < m),
                Op::Gte => max.is_none_or(|m| n <= m),
                Op::Lt => min.is_none_or(|m| n > m),
                _ => min.is_none_or(|m| n >= m),
            };
            ensure!(
                reachable,
                "{owner}: no allowed answer can be {} {n}",
                op.as_str()
            );
        }
    }
    Ok(())
}

fn check_question(owner: &str, q: &Question) -> Result<()> {
    ensure!(is_identifier(&q.id), "{owner}: bad question id {}", q.id);
    ensure!(
        q.id != REFILL_SPECIAL && !q.id.starts_with(SAME_AS_RECORD),
        "{owner}: the id {} is reserved",
        q.id
    );
    both(owner, "label", &q.label_zh, &q.label_en)?;
    match (blank(&q.help_zh), blank(&q.help_en)) {
        (true, true) => {}
        (false, false) => both(
            owner,
            "help",
            q.help_zh.as_deref().unwrap_or(""),
            q.help_en.as_deref().unwrap_or(""),
        )?,
        _ => bail!("{owner}: help needs both languages"),
    }
    let options = q.options.as_deref().unwrap_or(&[]);
    if q.kind == QuestionKind::Choice {
        ensure!(options.len() >= 2, "{owner}: a choice needs two options");
        let mut seen = HashSet::new();
        for o in options {
            ensure!(
                !o.value.trim().is_empty() && seen.insert(o.value.as_str()),
                "{owner}: option value empty or duplicated"
            );
            ensure!(
                !o.label_zh.trim().is_empty() && !o.label_en.trim().is_empty(),
                "{owner}: option {} needs both labels",
                o.value
            );
        }
    } else {
        ensure!(options.is_empty(), "{owner}: only a choice has options");
    }
    if q.kind == QuestionKind::Number {
        if let (Some(min), Some(max)) = (q.min, q.max) {
            ensure!(min < max, "{owner}: min must be below max");
        }
    } else {
        ensure!(
            q.min.is_none() && q.max.is_none(),
            "{owner}: only a number has min and max"
        );
    }
    let answers = match q.kind {
        QuestionKind::Boolean => Answers::Boolean,
        QuestionKind::Choice => Answers::Choice(options),
        QuestionKind::Number => Answers::Number {
            min: q.min,
            max: q.max,
        },
        QuestionKind::Text => Answers::Text,
    };
    for rule in &q.rules {
        check_rule(owner, rule, &answers)?;
    }
    Ok(())
}

fn check_monitoring(owner: &str, m: &Monitoring) -> Result<()> {
    ensure!(is_identifier(&m.id), "{owner}: bad monitoring id {}", m.id);
    both(owner, "label", &m.label_zh, &m.label_en)?;
    check_reason(owner, &m.reason_zh, &m.reason_en)?;
    ensure!(
        m.max_age_days.is_none_or(|d| (1..=3650).contains(&d)),
        "{owner}: max_age_days must be 1 to 3650 or null"
    );
    ensure!(
        matches!(
            m.stale_disposition,
            Disposition::Review | Disposition::InPerson
        ),
        "{owner}: stale_disposition must be review or in_person"
    );
    check_url(owner, &m.source_url)?;
    if let Some(day) = m.verified_on.as_deref().filter(|d| !d.trim().is_empty()) {
        ensure!(
            parse_date(day).is_some(),
            "{owner}: verified_on must be YYYY-MM-DD or empty"
        );
    }
    let answers = match m.value_kind {
        ValueKind::Number => Answers::Number {
            min: Some(0.0),
            max: Some(MAX_MONITORING_VALUE),
        },
        ValueKind::DateOnly => Answers::DateOnly,
    };
    for rule in &m.rules {
        check_rule(owner, rule, &answers)?;
    }
    Ok(())
}

impl Question {
    /// Blocks submitting while unanswered. A `missing` rule says what an absent answer means (someone without a blood
    /// pressure cuff can still ask), so such a question fires its rule instead of blocking.
    pub fn must_answer(&self) -> bool {
        self.required && !self.rules.iter().any(|r| r.when.op == Op::Missing)
    }
}

impl Protocols {
    pub fn load(path: &Path) -> Result<Self> {
        let raw =
            std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        Self::parse(&raw).with_context(|| format!("check {}", path.display()))
    }

    pub fn parse(json: &str) -> Result<Self> {
        let parsed: Self = serde_json::from_str(json.trim_start_matches('\u{feff}'))?;
        parsed.validate()?;
        Ok(parsed)
    }

    fn validate(&self) -> Result<()> {
        ensure!(!self.version.trim().is_empty(), "version is empty");
        match &self.approved_by_note {
            Value::String(s) => ensure!(!s.trim().is_empty(), "approved_by_note is empty"),
            Value::Object(o) => ensure!(
                !o.is_empty() && o.values().all(Value::is_string),
                "approved_by_note must hold texts"
            ),
            _ => bail!("approved_by_note must be a text"),
        }
        ensure!(
            !self.general.questions.is_empty(),
            "there are no general questions"
        );
        ensure!(!self.classes.is_empty(), "there are no classes");

        let mut general_ids = HashSet::new();
        for q in &self.general.questions {
            let owner = format!("general.{}", q.id);
            check_question(&owner, q)?;
            ensure!(
                general_ids.insert(q.id.as_str()),
                "{owner}: id is used twice"
            );
        }
        let mut class_ids = HashSet::new();
        let mut shared: BTreeMap<&str, (&str, &Question)> = BTreeMap::new();
        let mut shared_monitoring: BTreeMap<&str, (&str, &Monitoring)> = BTreeMap::new();
        for class in &self.classes {
            let name = class.class_id.as_str();
            ensure!(is_identifier(name), "bad class_id {name}");
            ensure!(class_ids.insert(name), "class {name} is listed twice");
            both(name, "title", &class.title_zh, &class.title_en)?;
            both(name, "summary", &class.summary_zh, &class.summary_en)?;
            let mut in_class = HashSet::new();
            for q in &class.questions {
                let owner = format!("{name}.{}", q.id);
                check_question(&owner, q)?;
                ensure!(in_class.insert(q.id.as_str()), "{owner}: id is used twice");
                ensure!(
                    !general_ids.contains(q.id.as_str()),
                    "{owner}: the id is already a general question"
                );
                // The same id in two classes is asked once, so both must mean the same question.
                match shared.get(q.id.as_str()) {
                    Some((other, o)) => ensure!(
                        same_question(o, q),
                        "{owner}: differs from the question with the same id in {other}"
                    ),
                    None => {
                        shared.insert(&q.id, (name, q));
                    }
                }
            }
            for m in &class.monitoring {
                let owner = format!("{name}.{}", m.id);
                check_monitoring(&owner, m)?;
                ensure!(in_class.insert(m.id.as_str()), "{owner}: id is used twice");
                match shared_monitoring.get(m.id.as_str()) {
                    Some((other, o)) => ensure!(
                        o.value_kind == m.value_kind
                            && o.unit == m.unit
                            && o.label_zh == m.label_zh
                            && o.label_en == m.label_en,
                        "{owner}: differs from the monitoring with the same id in {other}"
                    ),
                    None => {
                        shared_monitoring.insert(&m.id, (name, m));
                    }
                }
            }
        }
        for id in shared_monitoring.keys() {
            ensure!(
                !general_ids.contains(id) && !shared.contains_key(id),
                "{id} is both a question and a monitoring entry"
            );
        }
        Ok(())
    }

    pub fn class(&self, class_id: &str) -> Option<&ClassProtocol> {
        self.classes.iter().find(|c| c.class_id == class_id)
    }

    pub fn rule_count(&self) -> usize {
        self.general
            .questions
            .iter()
            .chain(self.classes.iter().flat_map(|c| &c.questions))
            .map(|q| q.rules.len())
            .sum::<usize>()
            + self
                .classes
                .iter()
                .flat_map(|c| &c.monitoring)
                // Being out of date is a rule of its own.
                .map(|m| m.rules.len() + 1)
                .sum::<usize>()
    }

    pub fn approved_by(&self, locale: Locale) -> String {
        match &self.approved_by_note {
            Value::String(s) => s.clone(),
            Value::Object(o) => {
                let wanted = if locale.is_en() { "en" } else { "zh" };
                o.iter()
                    .find(|(k, _)| k.as_str() == wanted || k.ends_with(&format!("_{wanted}")))
                    .or_else(|| o.iter().next())
                    .and_then(|(_, v)| v.as_str())
                    .unwrap_or("")
                    .to_string()
            }
            _ => String::new(),
        }
    }

    /// Public `GET /rx/protocols`: everything a reader needs to see why a question is asked.
    pub fn public(&self, locale: Locale) -> Value {
        let question = |q: &Question| {
            serde_json::json!({
                "id": q.id,
                "kind": q.kind,
                "label": pick(&q.label_zh, &q.label_en, locale),
                "required": q.must_answer(),
                "rules": rules_out(&q.rules, locale),
            })
        };
        serde_json::json!({
            "version": self.version,
            "approved_by_note": self.approved_by(locale),
            "general": { "questions": self.general.questions.iter().map(question).collect::<Vec<_>>() },
            "classes": self.classes.iter().map(|c| serde_json::json!({
                "class_id": c.class_id,
                "title": pick(&c.title_zh, &c.title_en, locale),
                "summary": pick(&c.summary_zh, &c.summary_en, locale),
                "questions": c.questions.iter().map(question).collect::<Vec<_>>(),
                "monitoring": c.monitoring.iter().map(|m| serde_json::json!({
                    "id": m.id,
                    "label": pick(&m.label_zh, &m.label_en, locale),
                    "max_age_days": m.max_age_days,
                    "value_kind": m.value_kind,
                    "unit": m.unit,
                    "rules": rules_out(&m.rules, locale),
                    "stale_disposition": m.stale_disposition,
                    "reason": pick(&m.reason_zh, &m.reason_en, locale),
                    "source_type": non_blank(&m.source_type),
                    "source_url": non_blank(&m.source_url),
                    "verified_on": non_blank(&m.verified_on),
                })).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
        })
    }
}

fn rules_out(rules: &[Rule], locale: Locale) -> Vec<Value> {
    rules
        .iter()
        .map(|r| {
            serde_json::json!({
                "when": { "op": r.when.op, "value": r.when.value },
                "disposition": r.disposition,
                "reason": pick(&r.reason_zh, &r.reason_en, locale),
                "source_url": non_blank(&r.source_url),
            })
        })
        .collect()
}

pub(super) fn non_blank(text: &Option<String>) -> Option<String> {
    text.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn pick<'a>(zh: &'a str, en: &'a str, locale: Locale) -> &'a str {
    if locale.is_en() { en } else { zh }
}

fn same_question(a: &Question, b: &Question) -> bool {
    let options = |q: &Question| -> Vec<String> {
        q.options
            .iter()
            .flatten()
            .map(|o| o.value.clone())
            .collect()
    };
    a.kind == b.kind
        && a.label_zh == b.label_zh
        && a.label_en == b.label_en
        && a.unit == b.unit
        && a.min == b.min
        && a.max == b.max
        && options(a) == options(b)
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

pub fn is_missing(answer: Option<&Value>) -> bool {
    match answer {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.trim().is_empty(),
        Some(_) => false,
    }
}

fn equal(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x == y,
        _ => a == b,
    }
}

impl When {
    /// Nothing but `missing` can match an answer that is not there.
    pub fn matches(&self, answer: Option<&Value>) -> bool {
        if self.op == Op::Missing {
            return is_missing(answer);
        }
        let (Some(answer), Some(value)) = (answer.filter(|a| !is_missing(Some(a))), &self.value)
        else {
            return false;
        };
        let numbers = answer.as_f64().zip(value.as_f64());
        match self.op {
            Op::Eq => equal(answer, value),
            Op::Neq => !equal(answer, value),
            Op::In => value
                .as_array()
                .is_some_and(|list| list.iter().any(|v| equal(answer, v))),
            Op::Gt => numbers.is_some_and(|(a, v)| a > v),
            Op::Gte => numbers.is_some_and(|(a, v)| a >= v),
            Op::Lt => numbers.is_some_and(|(a, v)| a < v),
            Op::Lte => numbers.is_some_and(|(a, v)| a <= v),
            Op::Missing => false,
        }
    }
}

// ---------------------------------------------------------------------------
// The question list of one request
// ---------------------------------------------------------------------------

/// What the question list needs to know about one item.
#[derive(Debug, Clone)]
pub struct ItemKey {
    pub item_id: String,
    pub drug_name: LText,
    pub class_id: String,
    pub scope: RenewalScope,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OptionOut {
    pub value: String,
    pub label: String,
}

/// Contract §4 `ProtocolQuestion`, already in the reader's language.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QuestionOut {
    pub id: String,
    pub scope: &'static str,
    pub class_id: Option<String>,
    pub kind: &'static str,
    pub label: String,
    pub help: Option<String>,
    pub options: Vec<OptionOut>,
    pub unit: Option<String>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub required: bool,
    pub max_age_days: Option<i64>,
}

pub fn same_as_record_id(item_id: &str) -> String {
    format!("{SAME_AS_RECORD}:{item_id}")
}

fn question_out(q: &Question, scope: &'static str, class: Option<&str>, l: Locale) -> QuestionOut {
    QuestionOut {
        id: q.id.clone(),
        scope,
        class_id: class.map(str::to_string),
        kind: q.kind.as_str(),
        label: pick(&q.label_zh, &q.label_en, l).to_string(),
        help: non_blank(if l.is_en() { &q.help_en } else { &q.help_zh }),
        options: q
            .options
            .iter()
            .flatten()
            .map(|o| OptionOut {
                value: o.value.clone(),
                label: pick(&o.label_zh, &o.label_en, l).to_string(),
            })
            .collect(),
        unit: non_blank(&q.unit),
        min: q.min,
        max: q.max,
        required: q.must_answer(),
        max_age_days: None,
    }
}

fn plain_question(
    id: String,
    kind: &'static str,
    label: String,
    options: Vec<OptionOut>,
) -> QuestionOut {
    QuestionOut {
        id,
        scope: "general",
        class_id: None,
        kind,
        label,
        help: None,
        options,
        unit: None,
        min: None,
        max: None,
        required: true,
        max_age_days: None,
    }
}

/// The three things a refill check asks (the same inputs as [`crate::refill::RefillInput`]).
fn refill_questions(locale: Locale) -> Vec<QuestionOut> {
    let special = SpecialStatus::ALL
        .iter()
        .map(|s| OptionOut {
            value: s.as_str().to_string(),
            label: rt(
                match s {
                    SpecialStatus::None => R::SpecialNone,
                    SpecialStatus::GoingAbroad => R::SpecialGoingAbroad,
                    SpecialStatus::ReturningIsland => R::SpecialReturningIsland,
                    SpecialStatus::OceanFishingCrew => R::SpecialOceanFishing,
                    SpecialStatus::InternationalCrew => R::SpecialInternationalCrew,
                    SpecialStatus::RareDisease => R::SpecialRareDisease,
                },
                locale,
            )
            .to_string(),
        })
        .collect();
    vec![
        plain_question(
            REFILL_SYMPTOM.into(),
            "boolean",
            rt(R::QRefillSymptom, locale).into(),
            Vec::new(),
        ),
        plain_question(
            REFILL_SIDE_EFFECTS.into(),
            "boolean",
            rt(R::QRefillSideEffects, locale).into(),
            Vec::new(),
        ),
        plain_question(
            REFILL_SPECIAL.into(),
            "choice",
            rt(R::QRefillSpecial, locale).into(),
            special,
        ),
    ]
}

/// The merged list for a request: one "same as the record" question per item, the general questions, then each class
/// once (a question or measurement shared by two classes is asked once), then monitoring. Excluded items add nothing.
pub fn questions_for(
    protocols: &Protocols,
    kind: RxKind,
    items: &[ItemKey],
    locale: Locale,
) -> Vec<QuestionOut> {
    if kind == RxKind::Refill {
        return refill_questions(locale);
    }
    let mut out: Vec<QuestionOut> = Vec::new();
    let open: Vec<&ItemKey> = items
        .iter()
        .filter(|i| i.scope != RenewalScope::Excluded)
        .collect();
    for item in &open {
        out.push(plain_question(
            same_as_record_id(&item.item_id),
            "boolean",
            rf(
                R::QSameAsRecord,
                locale,
                &[("drug", item.drug_name.get(locale))],
            ),
            Vec::new(),
        ));
    }
    if open.is_empty() {
        return out;
    }
    for q in &protocols.general.questions {
        out.push(question_out(q, "general", None, locale));
    }
    let mut classes: Vec<&ClassProtocol> = Vec::new();
    for item in &open {
        if let Some(class) = protocols.class(&item.class_id)
            && !classes.iter().any(|c| c.class_id == class.class_id)
        {
            classes.push(class);
        }
    }
    for class in &classes {
        for q in &class.questions {
            match out.iter_mut().find(|o| o.id == q.id) {
                // Asked once; required when any class requires it.
                Some(existing) => existing.required |= q.must_answer(),
                None => out.push(question_out(q, "class", Some(&class.class_id), locale)),
            }
        }
    }
    for class in &classes {
        for m in &class.monitoring {
            match out.iter_mut().find(|o| o.id == m.id) {
                // Asked once, with the strictest age.
                Some(existing) => {
                    existing.max_age_days = match (existing.max_age_days, m.max_age_days) {
                        (Some(a), Some(b)) => Some(a.min(b)),
                        (a, b) => a.or(b),
                    };
                }
                None => out.push(QuestionOut {
                    id: m.id.clone(),
                    scope: "monitoring",
                    class_id: Some(class.class_id.clone()),
                    kind: match m.value_kind {
                        ValueKind::Number => "number",
                        ValueKind::DateOnly => "date",
                    },
                    label: pick(&m.label_zh, &m.label_en, locale).to_string(),
                    help: None,
                    options: Vec::new(),
                    unit: non_blank(&m.unit),
                    min: None,
                    max: None,
                    // An older or absent value is allowed: it fires the stale rule instead of blocking the patient.
                    required: false,
                    max_age_days: m.max_age_days,
                }),
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// What the patient sends back
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Cleaned {
    /// The new full set (previous answers with the patch applied).
    pub answers: Map<String, Value>,
    /// How many identifiers were masked in free text.
    pub masked: usize,
    /// Masked free-text values that this patch changed (for red-flag checks).
    pub texts: Vec<String>,
}

/// Applies a patch of answers. Only questions in `questions` are kept (an unknown key is dropped, never stored);
/// `null` clears an answer. Wrong types and values out of range are reported per field and nothing is applied.
pub fn clean_answers(
    questions: &[QuestionOut],
    previous: &Map<String, Value>,
    patch: &Map<String, Value>,
    locale: Locale,
) -> Result<Cleaned, FieldErrors> {
    let mut errors = FieldErrors::new();
    let mut out = Cleaned {
        answers: previous
            .iter()
            .filter(|(k, _)| questions.iter().any(|q| q.id == **k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        ..Cleaned::default()
    };
    for q in questions.iter().filter(|q| q.scope != "monitoring") {
        let Some(value) = patch.get(&q.id) else {
            continue;
        };
        if is_missing(Some(value)) {
            out.answers.remove(&q.id);
            continue;
        }
        let accepted = match q.kind {
            "boolean" if value.is_boolean() => Some(value.clone()),
            "choice" => value
                .as_str()
                .filter(|s| q.options.iter().any(|o| o.value == *s))
                .map(|s| Value::from(s.to_string())),
            "number" => value.as_f64().filter(|n| n.is_finite()).and_then(|n| {
                let fits = q.min.is_none_or(|m| n >= m) && q.max.is_none_or(|m| n <= m);
                fits.then(|| value.clone())
            }),
            "text" => value
                .as_str()
                .map(str::trim)
                .filter(|s| s.chars().count() <= MAX_TEXT_CHARS)
                .map(|s| {
                    let masked = pii::mask(s);
                    out.masked += masked.count;
                    if previous.get(&q.id).and_then(Value::as_str) != Some(masked.text.as_str()) {
                        out.texts.push(masked.text.clone());
                    }
                    Value::from(masked.text)
                }),
            _ => None,
        };
        match accepted {
            Some(v) => {
                out.answers.insert(q.id.clone(), v);
            }
            None => {
                errors.insert(q.id.clone(), answer_error(q, locale));
            }
        }
    }
    if errors.is_empty() {
        Ok(out)
    } else {
        Err(errors)
    }
}

fn answer_error(q: &QuestionOut, locale: Locale) -> String {
    match (q.kind, q.min, q.max) {
        ("number", Some(min), Some(max)) => fmt(
            T::FieldErrRange,
            locale,
            &[("min", &min.to_string()), ("max", &max.to_string())],
        ),
        ("number", _, _) => rt(R::ErrNumber, locale).to_string(),
        ("text", _, _) => rf(
            R::ErrTextLength,
            locale,
            &[("max", &MAX_TEXT_CHARS.to_string())],
        ),
        _ => t(T::FieldErrChoice, locale).to_string(),
    }
}

/// Required questions that still have no answer.
pub fn missing_required(
    questions: &[QuestionOut],
    answers: &Map<String, Value>,
    locale: Locale,
) -> FieldErrors {
    questions
        .iter()
        .filter(|q| q.required && q.scope != "monitoring" && is_missing(answers.get(&q.id)))
        .map(|q| (q.id.clone(), rt(R::ErrAnswerRequired, locale).to_string()))
        .collect()
}

wire_enum!(Source { Patient => "patient", Clinic => "clinic" });

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonitoringEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    pub source: Source,
}

pub type MonitoringSet = BTreeMap<String, MonitoringEntry>;

/// Applies a patch of monitoring values. What a patient types is always marked `patient`; a `clinic` mark survives only
/// on an entry the server filled in before and the patient left unchanged. `null` clears an entry.
pub fn clean_monitoring(
    questions: &[QuestionOut],
    previous: &MonitoringSet,
    patch: &Map<String, Value>,
    today: Date,
    locale: Locale,
) -> Result<MonitoringSet, FieldErrors> {
    let mut errors = FieldErrors::new();
    let monitored: Vec<&QuestionOut> = questions
        .iter()
        .filter(|q| q.scope == "monitoring")
        .collect();
    let mut out: MonitoringSet = previous
        .iter()
        .filter(|(k, _)| monitored.iter().any(|q| q.id == **k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for q in monitored {
        let Some(raw) = patch.get(&q.id) else {
            continue;
        };
        if raw.is_null() {
            out.remove(&q.id);
            continue;
        }
        let Some(object) = raw.as_object() else {
            errors.insert(q.id.clone(), t(T::ErrFieldRequired, locale).into());
            continue;
        };
        let value = match object.get("value") {
            v if is_missing(v) => None,
            Some(v) if q.kind == "number" => {
                match v
                    .as_f64()
                    .filter(|n| (0.0..=MAX_MONITORING_VALUE).contains(n))
                {
                    Some(n) => Some(n),
                    None => {
                        errors.insert(q.id.clone(), rt(R::ErrNumber, locale).into());
                        continue;
                    }
                }
            }
            _ => None,
        };
        let date = match object.get("date") {
            v if is_missing(v) => None,
            Some(v) => match v
                .as_str()
                .and_then(parse_date)
                .filter(|d| (2000..=2100).contains(&d.year()))
            {
                Some(d) if d > today => {
                    errors.insert(q.id.clone(), t(T::FieldErrFuture, locale).into());
                    continue;
                }
                Some(d) => Some(format_date(d)),
                None => {
                    errors.insert(q.id.clone(), t(T::FieldErrDate, locale).into());
                    continue;
                }
            },
            None => None,
        };
        if value.is_none() && date.is_none() {
            out.remove(&q.id);
            continue;
        }
        let source = match previous.get(&q.id) {
            Some(old) if old.value == value && old.date == date => old.source,
            _ => Source::Patient,
        };
        out.insert(
            q.id.clone(),
            MonitoringEntry {
                value,
                date,
                source,
            },
        );
    }
    if errors.is_empty() {
        Ok(out)
    } else {
        Err(errors)
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::{self, PROTOCOLS};
    use super::*;
    use serde_json::json;
    use time::macros::date;

    fn fixture() -> Value {
        serde_json::from_str(PROTOCOLS).expect("json")
    }

    fn load(value: &Value) -> Result<Protocols> {
        Protocols::parse(&value.to_string())
    }

    fn item(id: &str, class: &str, scope: RenewalScope) -> ItemKey {
        ItemKey {
            item_id: id.into(),
            drug_name: LText::new("某藥", "Some drug"),
            class_id: class.into(),
            scope,
        }
    }

    fn renewal(classes: &[&str]) -> Vec<QuestionOut> {
        let items: Vec<ItemKey> = classes
            .iter()
            .enumerate()
            .map(|(i, c)| item(&format!("i{i}"), c, RenewalScope::InScope))
            .collect();
        questions_for(
            &fixtures::rules().protocols,
            RxKind::Renewal,
            &items,
            Locale::ZhTw,
        )
    }

    #[test]
    fn the_fixture_loads() {
        let p = Protocols::parse(PROTOCOLS).expect("fixture");
        assert_eq!(p.version, "fixture-1");
        assert!(p.class("ccb").is_some() && p.class("nope").is_none());
        assert!(p.rule_count() > 5);
    }

    /// Each edit breaks one thing; every one must refuse to load.
    #[test]
    fn bad_files_refuse_to_load() {
        type Edit = fn(&mut Value);
        let edits: Vec<(&str, Edit)> = vec![
            ("no version", |v| v["version"] = json!("")),
            ("no general", |v| v["general"]["questions"] = json!([])),
            ("no classes", |v| v["classes"] = json!([])),
            ("unknown field", |v| v["classes"][0]["extra"] = json!(1)),
            ("misspelt field", |v| {
                v["general"]["questions"][0]["requierd"] = json!(true)
            }),
            ("unknown kind", |v| {
                v["general"]["questions"][0]["kind"] = json!("date")
            }),
            ("unknown op", |v| {
                v["general"]["questions"][0]["rules"][0]["when"]["op"] = json!("like")
            }),
            ("rule value of the wrong type", |v| {
                v["general"]["questions"][0]["rules"][0]["when"]["value"] = json!("yes")
            }),
            ("rule value not an option", |v| {
                v["general"]["questions"][1]["rules"][0]["when"]["value"] = json!("awful")
            }),
            ("a rule that approves", |v| {
                v["general"]["questions"][0]["rules"][0]["disposition"] = json!("ready")
            }),
            ("a rule that excludes", |v| {
                v["general"]["questions"][0]["rules"][0]["disposition"] = json!("excluded")
            }),
            ("missing with a value", |v| {
                v["general"]["questions"][0]["rules"][0]["when"] =
                    json!({"op": "missing", "value": 1})
            }),
            ("no rule value", |v| {
                v["general"]["questions"][0]["rules"][0]["when"] = json!({"op": "eq"})
            }),
            ("greater than on yes/no", |v| {
                v["general"]["questions"][0]["rules"][0]["when"] = json!({"op": "gt", "value": 1})
            }),
            ("no English reason", |v| {
                v["general"]["questions"][0]["rules"][0]["reason_en"] = json!("")
            }),
            ("Chinese in English", |v| {
                v["general"]["questions"][0]["label_en"] = json!("胸痛")
            }),
            ("English in Chinese", |v| {
                v["general"]["questions"][0]["label_zh"] = json!("pain")
            }),
            ("help in one language", |v| {
                v["general"]["questions"][0]["help_zh"] = json!("說明")
            }),
            ("bad url", |v| {
                v["general"]["questions"][0]["rules"][0]["source_url"] = json!("file:///x")
            }),
            ("duplicate general id", |v| {
                let q = v["general"]["questions"][0].clone();
                v["general"]["questions"]
                    .as_array_mut()
                    .expect("array")
                    .push(q);
            }),
            ("class repeats a general id", |v| {
                let q = v["general"]["questions"][0].clone();
                v["classes"][0]["questions"]
                    .as_array_mut()
                    .expect("array")
                    .push(q);
            }),
            ("duplicate class", |v| {
                let c = v["classes"][0].clone();
                v["classes"].as_array_mut().expect("array").push(c);
            }),
            ("one option", |v| {
                let first = v["general"]["questions"][1]["options"][2].clone();
                v["general"]["questions"][1]["options"] = json!([first]);
            }),
            ("options on yes/no", |v| {
                v["general"]["questions"][0]["options"] =
                    v["general"]["questions"][1]["options"].clone()
            }),
            ("min above max", |v| {
                v["classes"][2]["questions"][0]["min"] = json!(20)
            }),
            ("unreachable threshold", |v| {
                v["classes"][2]["questions"][0]["rules"][0]["when"]["value"] = json!(11)
            }),
            ("age zero", |v| {
                v["classes"][0]["monitoring"][0]["max_age_days"] = json!(0)
            }),
            ("stale may not be urgent", |v| {
                v["classes"][0]["monitoring"][0]["stale_disposition"] = json!("urgent")
            }),
            ("value rule on a date", |v| {
                v["classes"][1]["monitoring"][1]["rules"] =
                    v["classes"][0]["monitoring"][0]["rules"].clone()
            }),
            ("shared monitoring with another unit", |v| {
                v["classes"][1]["monitoring"][0]["unit"] = json!("kPa")
            }),
            ("verified_on not a date", |v| {
                v["classes"][0]["monitoring"][0]["verified_on"] = json!("soon")
            }),
            ("reserved id", |v| {
                v["general"]["questions"][0]["id"] = json!("same_as_record")
            }),
        ];
        for (why, edit) in edits {
            let mut v = fixture();
            edit(&mut v);
            assert!(load(&v).is_err(), "should refuse: {why}");
        }
        assert!(Protocols::parse("{").is_err());
    }

    #[test]
    fn a_reason_never_tells_the_patient_to_change_a_medicine() {
        for (zh, en) in [
            ("請立刻停藥並就醫。", "This may be serious. Seek care now."),
            ("先減量再觀察。", "Seek care."),
            ("請就醫。", "Stop the medicine and seek care now."),
            ("請就醫。", "This is serious. Please reduce the dose."),
        ] {
            assert!(tells_to_change_medicine(zh, en), "{zh} / {en}");
            let mut v = fixture();
            v["general"]["questions"][0]["rules"][0]["reason_zh"] = json!(zh);
            v["general"]["questions"][0]["rules"][0]["reason_en"] = json!(en);
            assert!(load(&v).is_err());
        }
        for (zh, en) in [
            ("不可自行突然停藥，請醫師確認。", "Do not stop it on your own."),
            ("請醫師確認是否需要減量。", "The doctor should check the dose."),
            ("最近有突然停藥的情形。", "It was stopped suddenly."),
            ("請勿自行停藥。", "Do not stop taking it."),
        ] {
            assert!(!tells_to_change_medicine(zh, en), "{zh} / {en}");
        }
    }

    #[test]
    fn rules_match_only_what_they_say() {
        let when = |op: Op, value: Value| When {
            op,
            value: Some(value),
        };
        assert!(when(Op::Eq, json!(7)).matches(Some(&json!(7.0))));
        assert!(when(Op::Neq, json!("a")).matches(Some(&json!("b"))));
        assert!(
            !when(Op::Neq, json!("a")).matches(None),
            "no answer is not a different answer"
        );
        assert!(when(Op::In, json!(["a", "b"])).matches(Some(&json!("b"))));
        assert!(!when(Op::In, json!(["a", "b"])).matches(Some(&json!("c"))));
        assert!(when(Op::Gt, json!(2)).matches(Some(&json!(2.5))));
        assert!(!when(Op::Gt, json!(2)).matches(Some(&json!(2))));
        assert!(when(Op::Gte, json!(2)).matches(Some(&json!(2))));
        assert!(when(Op::Lt, json!(2)).matches(Some(&json!(1))));
        assert!(when(Op::Lte, json!(2)).matches(Some(&json!(2))));
        assert!(
            !when(Op::Gt, json!(2)).matches(Some(&json!("9"))),
            "text is not a number"
        );
        let missing = When {
            op: Op::Missing,
            value: None,
        };
        for gone in [None, Some(json!(null)), Some(json!("  "))] {
            assert!(missing.matches(gone.as_ref()));
        }
        assert!(!missing.matches(Some(&json!(false))), "no is an answer");
    }

    #[test]
    fn questions_merge_general_and_class_and_ask_shared_ones_once() {
        let questions = renewal(&["ccb", "arb", "ccb"]);
        let count = |id: &str| questions.iter().filter(|q| q.id == id).count();
        assert_eq!(count("chest_pain_now"), 1);
        assert_eq!(count("leg_swelling"), 1);
        assert_eq!(count("bp_systolic"), 1, "shared by two classes");
        assert_eq!(count("kidney_test"), 1);
        assert_eq!(count("muscle_pain"), 0, "a class nobody asked for");
        assert_eq!(count("same_as_record:i0"), 1);
        assert_eq!(count("same_as_record:i2"), 1);
        let bp = questions
            .iter()
            .find(|q| q.id == "bp_systolic")
            .expect("bp");
        assert_eq!(
            (bp.scope, bp.kind, bp.max_age_days),
            ("monitoring", "number", Some(30))
        );
        let kidney = questions
            .iter()
            .find(|q| q.id == "kidney_test")
            .expect("kidney");
        assert_eq!(kidney.kind, "date");
    }

    #[test]
    fn excluded_items_add_no_questions() {
        let p = fixtures::rules().protocols;
        let only_excluded = [item("i0", "hypnotic", RenewalScope::Excluded)];
        assert!(questions_for(&p, RxKind::Renewal, &only_excluded, Locale::ZhTw).is_empty());
    }

    #[test]
    fn a_drug_without_a_class_protocol_still_gets_the_general_questions() {
        let p = fixtures::rules().protocols;
        let warfarin = [item("i0", "anticoagulant", RenewalScope::PhysicianOnly)];
        let questions = questions_for(&p, RxKind::Renewal, &warfarin, Locale::En);
        assert!(questions.iter().any(|q| q.id == "chest_pain_now"));
        assert!(questions.iter().all(|q| q.scope == "general"));
        assert!(questions[0].label.contains("Some drug"));
    }

    #[test]
    fn a_refill_asks_the_refill_check_inputs_only() {
        let p = fixtures::rules().protocols;
        let ids: Vec<String> = questions_for(&p, RxKind::Refill, &[], Locale::ZhTw)
            .into_iter()
            .map(|q| q.id)
            .collect();
        assert_eq!(ids, ["symptom_changed", "side_effects", "special_status"]);
    }

    #[test]
    fn answers_are_type_checked_masked_and_merged() {
        let questions = renewal(&["statin"]);
        let previous = json!({"new_drug": true, "symptom_change": "same", "stray": 1});
        let patch = json!({
            "chest_pain_now": false, "muscle_pain": 3, "symptom_change": null,
            "note": " 我的手機 0912345678 ", "unknown": "dropped"
        });
        let cleaned = clean_answers(
            &questions,
            previous.as_object().expect("object"),
            patch.as_object().expect("object"),
            Locale::ZhTw,
        )
        .expect("clean");
        assert_eq!(cleaned.answers["new_drug"], json!(true));
        assert_eq!(cleaned.answers["muscle_pain"], json!(3));
        assert!(
            !cleaned.answers.contains_key("symptom_change"),
            "null clears"
        );
        assert!(
            !cleaned.answers.contains_key("unknown") && !cleaned.answers.contains_key("stray"),
            "unknown keys are not stored"
        );
        assert_eq!(cleaned.masked, 1);
        assert_eq!(cleaned.answers["note"], json!("我的手機 【已遮蔽】"));
        assert_eq!(cleaned.texts.len(), 1);
    }

    #[test]
    fn bad_answers_are_reported_per_field() {
        let questions = renewal(&["statin"]);
        let patch = json!({
            "chest_pain_now": "no", "symptom_change": "awful", "muscle_pain": 11,
            "note": "字".repeat(MAX_TEXT_CHARS + 1)
        });
        let errors = clean_answers(
            &questions,
            &Map::new(),
            patch.as_object().expect("object"),
            Locale::En,
        )
        .expect_err("bad");
        let keys: Vec<&str> = errors.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            ["chest_pain_now", "muscle_pain", "note", "symptom_change"]
        );
        assert_eq!(errors["muscle_pain"], "Must be between 0 and 10.");
    }

    #[test]
    fn required_questions_without_an_answer_are_listed() {
        let questions = renewal(&["statin"]);
        let answers = json!({"chest_pain_now": false});
        let missing = missing_required(
            &questions,
            answers.as_object().expect("object"),
            Locale::ZhTw,
        );
        assert!(missing.contains_key("muscle_pain") && missing.contains_key("same_as_record:i0"));
        assert!(!missing.contains_key("chest_pain_now") && !missing.contains_key("note"));
    }

    #[test]
    fn a_missing_rule_lets_the_patient_submit_without_that_answer() {
        let mut v = fixture();
        v["classes"][2]["questions"][0]["rules"]
            .as_array_mut()
            .expect("rules")
            .push(json!({"when": {"op": "missing"}, "disposition": "review", "reason_zh": "沒有填分數。", "reason_en": "No score given."}));
        let p = load(&v).expect("valid");
        let q = &p.class("statin").expect("statin").questions[0];
        assert!(q.required && !q.must_answer());
        let items = [item("i0", "statin", RenewalScope::InScope)];
        let questions = questions_for(&p, RxKind::Renewal, &items, Locale::ZhTw);
        assert!(
            !missing_required(&questions, &Map::new(), Locale::ZhTw).contains_key("muscle_pain")
        );
    }

    #[test]
    fn monitoring_without_an_interval_is_allowed() {
        let mut v = fixture();
        v["classes"][0]["monitoring"][0]["max_age_days"] = Value::Null;
        let p = load(&v).expect("null means no interval");
        let items = [
            item("i0", "ccb", RenewalScope::InScope),
            item("i1", "arb", RenewalScope::InScope),
        ];
        let questions = questions_for(&p, RxKind::Renewal, &items, Locale::ZhTw);
        let bp = questions
            .iter()
            .find(|q| q.id == "bp_systolic")
            .expect("bp");
        assert_eq!(
            bp.max_age_days,
            Some(30),
            "the class that has one still counts"
        );
    }

    #[test]
    fn monitoring_values_are_checked_and_marked_as_the_patients_own() {
        let questions = renewal(&["ccb", "arb"]);
        let today = date!(2026 - 11 - 25);
        let mut previous = MonitoringSet::new();
        previous.insert(
            "bp_systolic".into(),
            MonitoringEntry {
                value: Some(132.0),
                date: Some("2026-11-20".into()),
                source: Source::Clinic,
            },
        );
        let apply = |patch: Value| {
            clean_monitoring(
                &questions,
                &previous,
                patch.as_object().expect("object"),
                today,
                Locale::ZhTw,
            )
        };
        let unchanged = apply(
            json!({"bp_systolic": {"value": 132, "date": "2026-11-20", "source": "patient"}}),
        )
        .expect("ok");
        assert_eq!(unchanged["bp_systolic"].source, Source::Clinic);
        let edited =
            apply(json!({"bp_systolic": {"value": 128, "date": "2026-11-24", "source": "clinic"}}))
                .expect("ok");
        assert_eq!(
            edited["bp_systolic"].source,
            Source::Patient,
            "a patient cannot claim clinic"
        );
        assert!(apply(json!({"bp_systolic": null})).expect("ok").is_empty());
        for bad in [
            json!({"bp_systolic": {"value": 99999, "date": "2026-11-24"}}),
            json!({"bp_systolic": {"value": 120, "date": "2026-11-26"}}),
            json!({"bp_systolic": {"value": 120, "date": "yesterday"}}),
            json!({"kidney_test": "2026-11-01"}),
        ] {
            assert!(apply(bad.clone()).is_err(), "{bad}");
        }
        let dated = apply(json!({"kidney_test": {"date": "2026-03-01"}})).expect("ok");
        assert_eq!(dated["kidney_test"].date.as_deref(), Some("2026-03-01"));
    }

    #[test]
    fn the_public_view_is_localised() {
        let p = fixtures::rules().protocols;
        let zh = p.public(Locale::ZhTw);
        let en = p.public(Locale::En);
        assert_eq!(zh["classes"][0]["title"], "鈣離子阻斷劑");
        assert_eq!(en["classes"][0]["title"], "Calcium channel blocker");
        assert_eq!(
            en["classes"][0]["monitoring"][0]["stale_disposition"],
            "review"
        );
    }
}
