//! Chronic-prescription refill check: a pure function over validated input and the numbers in
//! `data/seed/refill_rules.csv`. No model is involved. Output is one of four outcomes.
//!
//! Date convention: `supply_end = last_fill_date + days_per_fill` (the first day without medicine). The refill window
//! is `[supply_end - early_window_days, prescription_date + total_days]`. After `supply_end` the refill is still allowed,
//! with a reminder about the gap. Every `consult` opens a clinician ticket.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::Value;
use time::{Date, Duration};

use crate::clock::{format_date, parse_date};
use crate::texts::{T, fmt, t};
use crate::types::{Controlled, Locale, RefillOutcome, SpecialStatus, TicketReason, Urgency};

const REQUIRED_KEYS: [&str; 6] = [
    "max_total_days",
    "max_days_per_fill",
    "early_window_days",
    "max_fills",
    "controlled_levels_excluded",
    "special_status_one_time_full",
];
const MAX_DAYS: i64 = 3650;

#[derive(Debug, Clone)]
pub struct RuleEntry {
    pub key: String,
    pub value: String,
    pub source_url: String,
    pub text_zh: Option<String>,
    pub text_en: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RefillRules {
    pub max_total_days: i64,
    pub max_days_per_fill: i64,
    pub early_window_days: i64,
    pub max_fills: i64,
    pub special_statuses: Vec<SpecialStatus>,
    entries: Vec<RuleEntry>,
}

impl RefillRules {
    pub fn load(path: &Path) -> Result<Self> {
        let raw =
            std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        Self::parse(raw.trim_start_matches('\u{feff}'))
            .with_context(|| format!("check {}", path.display()))
    }

    /// Columns are read by name: `key,value,source_url` are required; `text_zh`, `text_en` are optional
    /// (older files without them fall back to built-in wording). `note` is for maintainers and is never shown.
    pub fn parse(csv_text: &str) -> Result<Self> {
        let mut reader = csv::ReaderBuilder::new().from_reader(csv_text.as_bytes());
        let headers = reader.headers()?.clone();
        let col = |name: &str| headers.iter().position(|h| h.trim() == name);
        let (c_key, c_value, c_url) = (
            col("key").context("missing column key")?,
            col("value").context("missing column value")?,
            col("source_url").context("missing column source_url")?,
        );
        let (c_zh, c_en) = (col("text_zh"), col("text_en"));
        let mut entries = Vec::new();
        for row in reader.records() {
            let row = row?;
            let key = row.get(c_key).unwrap_or("").trim().to_string();
            if key.is_empty() {
                continue;
            }
            let optional = |c: Option<usize>| {
                c.and_then(|i| row.get(i))
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            };
            entries.push(RuleEntry {
                key,
                value: row.get(c_value).unwrap_or("").trim().to_string(),
                source_url: row.get(c_url).unwrap_or("").trim().to_string(),
                text_zh: optional(c_zh),
                text_en: optional(c_en),
            });
        }
        for key in REQUIRED_KEYS {
            if !entries.iter().any(|e| e.key == key) {
                bail!("missing rule key {key}");
            }
        }
        let find = |key: &str| {
            entries
                .iter()
                .find(|e| e.key == key)
                .expect("checked above")
        };
        let number = |key: &str| -> Result<i64> {
            let n: i64 = find(key)
                .value
                .parse()
                .with_context(|| format!("{key} must be a whole number"))?;
            if !(1..=3650).contains(&n) {
                bail!("{key} out of range");
            }
            Ok(n)
        };
        let mut special_statuses = Vec::new();
        for part in find("special_status_one_time_full")
            .value
            .split(';')
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            special_statuses.push(
                SpecialStatus::parse(part)
                    .filter(|s| *s != SpecialStatus::None)
                    .with_context(|| format!("unknown special status {part}"))?,
            );
        }
        let max_fills = number("max_fills")?;
        if max_fills < 2 {
            bail!("max_fills must be at least 2");
        }
        Ok(Self {
            max_total_days: number("max_total_days")?,
            max_days_per_fill: number("max_days_per_fill")?,
            early_window_days: number("early_window_days")?,
            max_fills,
            special_statuses,
            entries,
        })
    }

    fn entry(&self, key: &str) -> Option<&RuleEntry> {
        self.entries.iter().find(|e| e.key == key)
    }

    fn rule_out(&self, key: &str, locale: Locale) -> Option<RuleOut> {
        let entry = self.entry(key)?;
        let from_csv = if locale.is_en() {
            entry.text_en.as_ref()
        } else {
            entry.text_zh.as_ref()
        };
        let text = match from_csv {
            Some(text) => text.clone(),
            None => {
                let template = match key {
                    "max_total_days" => T::RuleMaxTotalDays,
                    "max_days_per_fill" => T::RuleMaxDaysPerFill,
                    "early_window_days" => T::RuleEarlyWindow,
                    "max_fills" => T::RuleMaxFills,
                    "controlled_levels_excluded" => T::RuleControlled,
                    _ => T::RuleSpecialStatus,
                };
                fmt(template, locale, &[("value", &entry.value)])
            }
        };
        Some(RuleOut {
            key: entry.key.clone(),
            text,
            source_url: entry.source_url.clone(),
        })
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/// The refill form (and the model's tool arguments), as accepted. `today` is only set by the form and eval paths.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RefillInput {
    pub prescription_date: String,
    pub total_days: i64,
    pub days_per_fill: i64,
    pub fills_done: i64,
    pub last_fill_date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub today: Option<String>,
    pub controlled: Controlled,
    pub special_status: SpecialStatus,
    pub symptom_changed: bool,
    pub side_effects: bool,
}

pub type FieldErrors = BTreeMap<String, String>;

const KNOWN_FIELDS: [&str; 10] = [
    "prescription_date",
    "total_days",
    "days_per_fill",
    "fills_done",
    "last_fill_date",
    "today",
    "controlled",
    "special_status",
    "symptom_changed",
    "side_effects",
];

impl RefillInput {
    /// Type-checks a JSON object field by field, so one bad request reports every bad field.
    /// With `allow_today = false` (the model's tool) a `today` key is an error.
    pub fn from_json(
        value: &Value,
        allow_today: bool,
        locale: Locale,
    ) -> Result<Self, FieldErrors> {
        let mut errors = FieldErrors::new();
        let Some(object) = value.as_object() else {
            errors.insert("body".into(), t(T::ErrFieldRequired, locale).into());
            return Err(errors);
        };
        let required = t(T::ErrFieldRequired, locale);
        let text = |name: &str, errors: &mut FieldErrors| -> Option<String> {
            match object.get(name) {
                Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
                _ => {
                    errors.insert(name.into(), required.into());
                    None
                }
            }
        };
        let prescription_date = text("prescription_date", &mut errors);
        let last_fill_date = text("last_fill_date", &mut errors);
        let integer = |name: &str, errors: &mut FieldErrors| -> Option<i64> {
            match object.get(name).and_then(|v| {
                v.as_i64()
                    .or_else(|| v.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
            }) {
                Some(n) => Some(n),
                None => {
                    errors.insert(name.into(), required.into());
                    None
                }
            }
        };
        let total_days = integer("total_days", &mut errors);
        let days_per_fill = integer("days_per_fill", &mut errors);
        let fills_done = integer("fills_done", &mut errors);
        let flag = |name: &str, errors: &mut FieldErrors| -> Option<bool> {
            match object.get(name) {
                Some(Value::Bool(b)) => Some(*b),
                _ => {
                    errors.insert(name.into(), required.into());
                    None
                }
            }
        };
        let symptom_changed = flag("symptom_changed", &mut errors);
        let side_effects = flag("side_effects", &mut errors);
        let controlled = match object
            .get("controlled")
            .and_then(Value::as_str)
            .and_then(Controlled::parse)
        {
            Some(c) => Some(c),
            None => {
                errors.insert("controlled".into(), t(T::FieldErrChoice, locale).into());
                None
            }
        };
        let special_status = match object
            .get("special_status")
            .and_then(Value::as_str)
            .and_then(SpecialStatus::parse)
        {
            Some(s) => Some(s),
            None => {
                errors.insert("special_status".into(), t(T::FieldErrChoice, locale).into());
                None
            }
        };
        let today = match object.get("today") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if allow_today => Some(s.trim().to_string()),
            Some(_) if allow_today => {
                errors.insert("today".into(), t(T::FieldErrDate, locale).into());
                None
            }
            Some(_) => {
                errors.insert("today".into(), t(T::FieldErrUnknown, locale).into());
                None
            }
        };
        if !allow_today {
            for key in object
                .keys()
                .filter(|k| !KNOWN_FIELDS.contains(&k.as_str()) && k.as_str() != "today")
            {
                errors.insert(key.clone(), t(T::FieldErrUnknown, locale).into());
            }
        }
        if !errors.is_empty() {
            return Err(errors);
        }
        Ok(Self {
            prescription_date: prescription_date.unwrap_or_default(),
            total_days: total_days.unwrap_or_default(),
            days_per_fill: days_per_fill.unwrap_or_default(),
            fills_done: fills_done.unwrap_or_default(),
            last_fill_date: last_fill_date.unwrap_or_default(),
            today,
            controlled: controlled.unwrap_or(Controlled::No),
            special_status: special_status.unwrap_or(SpecialStatus::None),
            symptom_changed: symptom_changed.unwrap_or(false),
            side_effects: side_effects.unwrap_or(false),
        })
    }
}

/// Input that passed validation, with real dates.
#[derive(Debug, Clone)]
pub struct Checked {
    pub today: Date,
    pub prescription_date: Date,
    pub last_fill_date: Date,
    pub total_days: i64,
    pub days_per_fill: i64,
    pub fills_done: i64,
    pub controlled: Controlled,
    pub special_status: SpecialStatus,
    pub symptom_changed: bool,
    pub side_effects: bool,
}

fn plausible_date(text: &str) -> Option<Date> {
    parse_date(text).filter(|d| (2000..=2100).contains(&d.year()))
}

/// Semantic validation. `server_today` is used when the input has no `today`.
pub fn validate(
    input: &RefillInput,
    rules: &RefillRules,
    server_today: Date,
    locale: Locale,
) -> Result<Checked, FieldErrors> {
    let mut errors = FieldErrors::new();
    let date_msg = t(T::FieldErrDate, locale);
    let today = match input.today.as_deref() {
        None => Some(server_today),
        Some(text) => {
            let parsed = plausible_date(text);
            if parsed.is_none() {
                errors.insert("today".into(), date_msg.into());
            }
            parsed
        }
    };
    let prescription_date = plausible_date(&input.prescription_date);
    if prescription_date.is_none() {
        errors.insert("prescription_date".into(), date_msg.into());
    }
    let last_fill_date = plausible_date(&input.last_fill_date);
    if last_fill_date.is_none() {
        errors.insert("last_fill_date".into(), date_msg.into());
    }
    for (name, value) in [
        ("total_days", input.total_days),
        ("days_per_fill", input.days_per_fill),
    ] {
        if !(1..=MAX_DAYS).contains(&value) {
            errors.insert(name.into(), t(T::FieldErrPositive, locale).into());
        }
    }
    if !(1..=rules.max_fills).contains(&input.fills_done) {
        errors.insert(
            "fills_done".into(),
            fmt(
                T::FieldErrRange,
                locale,
                &[("min", "1"), ("max", &rules.max_fills.to_string())],
            ),
        );
    }
    if let (Some(today), Some(last)) = (today, last_fill_date)
        && last > today
    {
        errors.insert("last_fill_date".into(), t(T::FieldErrFuture, locale).into());
    }
    if let (Some(rx), Some(last)) = (prescription_date, last_fill_date)
        && rx > last
        && !errors.contains_key("last_fill_date")
    {
        errors.insert(
            "prescription_date".into(),
            t(T::FieldErrOrder, locale).into(),
        );
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    Ok(Checked {
        today: today.expect("validated"),
        prescription_date: prescription_date.expect("validated"),
        last_fill_date: last_fill_date.expect("validated"),
        total_days: input.total_days,
        days_per_fill: input.days_per_fill,
        fills_done: input.fills_done,
        controlled: input.controlled,
        special_status: input.special_status,
        symptom_changed: input.symptom_changed,
        side_effects: input.side_effects,
    })
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ReasonOut {
    pub code: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RuleOut {
    pub key: String,
    pub text: String,
    pub source_url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RefillResult {
    pub outcome: RefillOutcome,
    pub title: String,
    pub message: String,
    pub today: String,
    pub earliest_date: Option<String>,
    pub latest_date: Option<String>,
    pub next_fill_number: Option<i64>,
    pub reasons: Vec<ReasonOut>,
    pub rules: Vec<RuleOut>,
    pub handoff: bool,
    pub ticket_no: Option<String>,
}

/// The ticket a `consult` must open.
#[derive(Debug, Clone, PartialEq)]
pub struct TicketPlan {
    pub reason: TicketReason,
    pub urgency: Urgency,
    pub summary: String,
}

#[derive(Debug, Clone)]
pub struct Evaluation {
    pub result: RefillResult,
    /// Present exactly when the outcome is `consult`.
    pub ticket: Option<TicketPlan>,
}

fn days(date: Date, n: i64) -> Date {
    date.checked_add(Duration::days(n)).unwrap_or(Date::MAX)
}

/// Ticket reason by priority: controlled drug > symptom change > side effects > special status > other.
fn ticket_reason(codes: &[&str]) -> (TicketReason, Urgency) {
    let has = |c: &str| codes.contains(&c);
    if has("controlled_drug") || has("controlled_unsure") {
        (TicketReason::ControlledDrug, Urgency::Soon)
    } else if has("symptom_changed") {
        (TicketReason::SymptomChange, Urgency::Soon)
    } else if has("side_effects") {
        (TicketReason::SideEffects, Urgency::Soon)
    } else if has("special_status") {
        (TicketReason::SpecialStatus, Urgency::Routine)
    } else {
        (TicketReason::Other, Urgency::Routine)
    }
}

/// The decision, in order: consult conditions (all collected), then revisit, then too_early or eligible.
pub fn check(input: &Checked, rules: &RefillRules, locale: Locale) -> Evaluation {
    let reason = |code: &str, key: T, args: &[(&str, &str)]| ReasonOut {
        code: code.to_string(),
        text: fmt(key, locale, args),
    };
    let today_text = format_date(input.today);
    let latest = days(input.prescription_date, input.total_days);
    let make = |outcome: RefillOutcome,
                title: T,
                message: String,
                reasons: Vec<ReasonOut>,
                rule_keys: &[&str]| RefillResult {
        outcome,
        title: t(title, locale).to_string(),
        message,
        today: today_text.clone(),
        earliest_date: None,
        latest_date: None,
        next_fill_number: None,
        reasons,
        rules: rule_keys
            .iter()
            .filter_map(|k| rules.rule_out(k, locale))
            .collect(),
        handoff: false,
        ticket_no: None,
    };

    // 1. Anything that needs a person: collect every cause.
    let mut codes: Vec<&str> = Vec::new();
    let mut reasons: Vec<ReasonOut> = Vec::new();
    let mut rule_keys: Vec<&str> = Vec::new();
    match input.controlled {
        Controlled::Yes => {
            codes.push("controlled_drug");
            reasons.push(reason("controlled_drug", T::RefillReasonControlled, &[]));
            rule_keys.push("controlled_levels_excluded");
        }
        Controlled::Unsure => {
            codes.push("controlled_unsure");
            reasons.push(reason(
                "controlled_unsure",
                T::RefillReasonControlledUnsure,
                &[],
            ));
            rule_keys.push("controlled_levels_excluded");
        }
        Controlled::No => {}
    }
    if input.symptom_changed {
        codes.push("symptom_changed");
        reasons.push(reason(
            "symptom_changed",
            T::RefillReasonSymptomChanged,
            &[],
        ));
    }
    if input.side_effects {
        codes.push("side_effects");
        reasons.push(reason("side_effects", T::RefillReasonSideEffects, &[]));
    }
    if input.special_status != SpecialStatus::None
        && rules.special_statuses.contains(&input.special_status)
    {
        codes.push("special_status");
        reasons.push(reason("special_status", T::RefillReasonSpecialStatus, &[]));
        rule_keys.push("special_status_one_time_full");
    }
    if input.total_days > rules.max_total_days {
        codes.push("days_total_exceeds");
        reasons.push(reason(
            "days_total_exceeds",
            T::RefillReasonDaysTotal,
            &[
                ("total", &input.total_days.to_string()),
                ("max", &rules.max_total_days.to_string()),
            ],
        ));
        rule_keys.push("max_total_days");
    }
    if input.days_per_fill > rules.max_days_per_fill {
        codes.push("days_per_fill_exceeds");
        reasons.push(reason(
            "days_per_fill_exceeds",
            T::RefillReasonDaysPerFill,
            &[
                ("per", &input.days_per_fill.to_string()),
                ("max", &rules.max_days_per_fill.to_string()),
            ],
        ));
        rule_keys.push("max_days_per_fill");
    }
    let cap = input.days_per_fill * rules.max_fills;
    if cap < input.total_days {
        codes.push("days_insufficient");
        reasons.push(reason(
            "days_insufficient",
            T::RefillReasonDaysShort,
            &[
                ("per", &input.days_per_fill.to_string()),
                ("fills", &rules.max_fills.to_string()),
                ("cap", &cap.to_string()),
                ("total", &input.total_days.to_string()),
            ],
        ));
        rule_keys.push("max_fills");
    }
    if !codes.is_empty() {
        let (ticket_reason, urgency) = ticket_reason(&codes);
        let listed = reasons
            .iter()
            .map(|r| r.text.as_str())
            .collect::<Vec<_>>()
            .join(if locale.is_en() { " " } else { "；" });
        let mut result = make(
            RefillOutcome::Consult,
            T::RefillTitleConsult,
            t(T::RefillMsgConsult, locale).to_string(),
            reasons,
            &rule_keys,
        );
        result.handoff = true;
        return Evaluation {
            result,
            ticket: Some(TicketPlan {
                reason: ticket_reason,
                urgency,
                summary: fmt(T::TicketRefillConsult, locale, &[("reasons", &listed)]),
            }),
        };
    }

    // 2. A new visit is needed: every permitted fill is used, or the prescription expired.
    let permitted = rules
        .max_fills
        .min((input.total_days + input.days_per_fill - 1) / input.days_per_fill);
    if input.fills_done >= permitted {
        let mut result = make(
            RefillOutcome::Revisit,
            T::RefillTitleRevisit,
            t(T::RefillMsgRevisit, locale).to_string(),
            vec![reason(
                "fills_exhausted",
                T::RefillReasonFillsExhausted,
                &[("fills", &permitted.to_string())],
            )],
            &["max_fills", "max_total_days"],
        );
        result.latest_date = Some(format_date(latest));
        return Evaluation {
            result,
            ticket: None,
        };
    }
    if input.today > latest {
        let mut result = make(
            RefillOutcome::Revisit,
            T::RefillTitleRevisit,
            t(T::RefillMsgRevisit, locale).to_string(),
            vec![reason(
                "prescription_expired",
                T::RefillReasonExpired,
                &[("date", &format_date(latest))],
            )],
            &["max_total_days"],
        );
        result.latest_date = Some(format_date(latest));
        return Evaluation {
            result,
            ticket: None,
        };
    }

    // 3. Inside the window or not yet.
    let supply_end = days(input.last_fill_date, input.days_per_fill);
    let earliest = days(supply_end, -rules.early_window_days);
    let next_fill = input.fills_done + 1;
    let (earliest_text, latest_text, supply_text) = (
        format_date(earliest),
        format_date(latest),
        format_date(supply_end),
    );
    if input.today < earliest {
        let mut result = make(
            RefillOutcome::TooEarly,
            T::RefillTitleTooEarly,
            fmt(T::RefillMsgTooEarly, locale, &[("date", &earliest_text)]),
            vec![reason(
                "too_early",
                T::RefillReasonTooEarly,
                &[
                    ("supply_end", &supply_text),
                    ("date", &earliest_text),
                    ("window", &rules.early_window_days.to_string()),
                ],
            )],
            &["early_window_days"],
        );
        result.earliest_date = Some(earliest_text);
        result.latest_date = Some(latest_text);
        result.next_fill_number = Some(next_fill);
        return Evaluation {
            result,
            ticket: None,
        };
    }
    let mut reasons = vec![reason(
        "in_window",
        T::RefillReasonInWindow,
        &[("earliest", &earliest_text), ("latest", &latest_text)],
    )];
    if input.today > supply_end {
        reasons.push(reason(
            "supply_gap",
            T::RefillReasonSupplyGap,
            &[("supply_end", &supply_text)],
        ));
    }
    let mut result = make(
        RefillOutcome::Eligible,
        T::RefillTitleEligible,
        t(T::RefillMsgEligible, locale).to_string(),
        reasons,
        &["early_window_days", "max_total_days"],
    );
    result.earliest_date = Some(earliest_text);
    result.latest_date = Some(latest_text);
    result.next_fill_number = Some(next_fill);
    Evaluation {
        result,
        ticket: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules() -> RefillRules {
        RefillRules::load(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/seed/refill_rules.csv"),
        )
        .expect("refill_rules.csv")
    }

    fn d(offset: i64) -> Date {
        days(parse_date("2026-10-01").expect("date"), offset)
    }

    /// prescription_date = last_fill_date = D, 90 days in total, 30 per fill, one fill done.
    fn base(today_offset: i64) -> Checked {
        Checked {
            today: d(today_offset),
            prescription_date: d(0),
            last_fill_date: d(0),
            total_days: 90,
            days_per_fill: 30,
            fills_done: 1,
            controlled: Controlled::No,
            special_status: SpecialStatus::None,
            symptom_changed: false,
            side_effects: false,
        }
    }

    fn outcome(input: &Checked) -> RefillOutcome {
        check(input, &rules(), Locale::ZhTw).result.outcome
    }

    #[test]
    fn rules_load_the_numbers_from_the_csv() {
        let r = rules();
        assert_eq!(
            (
                r.max_total_days,
                r.max_days_per_fill,
                r.early_window_days,
                r.max_fills
            ),
            (90, 30, 10, 3)
        );
        assert_eq!(r.special_statuses.len(), 5);
    }

    #[test]
    fn the_required_table() {
        let r = rules();
        let at = |n| check(&base(n), &r, Locale::ZhTw).result;
        assert_eq!(at(20).outcome, RefillOutcome::Eligible);
        let ten = at(10);
        assert_eq!(ten.outcome, RefillOutcome::TooEarly);
        assert_eq!(
            ten.earliest_date.as_deref(),
            Some(format_date(d(20)).as_str())
        );
        assert_eq!(at(19).outcome, RefillOutcome::TooEarly);
        assert_eq!(at(95).outcome, RefillOutcome::Revisit);
        assert_eq!(at(0).outcome, RefillOutcome::TooEarly);
    }

    #[test]
    fn window_boundaries() {
        let r = rules();
        // supply_end = D+30, window opens D+20, prescription valid through D+90.
        let at = |n| check(&base(n), &r, Locale::ZhTw).result;
        assert_eq!(at(30).outcome, RefillOutcome::Eligible);
        assert!(at(30).reasons.iter().all(|x| x.code != "supply_gap"));
        let gap = at(35);
        assert_eq!(gap.outcome, RefillOutcome::Eligible);
        assert!(
            gap.reasons.iter().any(|x| x.code == "supply_gap"),
            "a gap reminder after the supply ran out"
        );
        assert_eq!(
            at(90).outcome,
            RefillOutcome::Eligible,
            "the last valid day"
        );
        assert_eq!(at(91).outcome, RefillOutcome::Revisit);
        let eligible = at(25);
        assert_eq!(
            eligible.latest_date.as_deref(),
            Some(format_date(d(90)).as_str())
        );
        assert_eq!(eligible.next_fill_number, Some(2));
    }

    #[test]
    fn second_fill_uses_the_second_last_fill_date() {
        let mut input = base(0);
        input.fills_done = 2;
        input.last_fill_date = d(30);
        input.today = d(49);
        assert_eq!(outcome(&input), RefillOutcome::TooEarly);
        input.today = d(50);
        assert_eq!(outcome(&input), RefillOutcome::Eligible);
        assert_eq!(
            check(&input, &rules(), Locale::ZhTw)
                .result
                .next_fill_number,
            Some(3)
        );
    }

    #[test]
    fn all_fills_collected_means_revisit() {
        let mut input = base(20);
        input.fills_done = 3;
        assert_eq!(outcome(&input), RefillOutcome::Revisit);
        // 60 days in two fills of 30: after two fills nothing is left.
        let mut short = base(40);
        short.total_days = 60;
        short.fills_done = 2;
        short.last_fill_date = d(30);
        assert_eq!(outcome(&short), RefillOutcome::Revisit);
    }

    #[test]
    fn every_consult_hands_off_and_names_a_ticket() {
        let r = rules();
        type Mutator = fn(&mut Checked);
        let cases: [(Mutator, TicketReason, Urgency); 8] = [
            (
                |c| c.controlled = Controlled::Yes,
                TicketReason::ControlledDrug,
                Urgency::Soon,
            ),
            (
                |c| c.controlled = Controlled::Unsure,
                TicketReason::ControlledDrug,
                Urgency::Soon,
            ),
            (
                |c| c.symptom_changed = true,
                TicketReason::SymptomChange,
                Urgency::Soon,
            ),
            (
                |c| c.side_effects = true,
                TicketReason::SideEffects,
                Urgency::Soon,
            ),
            (
                |c| c.special_status = SpecialStatus::GoingAbroad,
                TicketReason::SpecialStatus,
                Urgency::Routine,
            ),
            (
                |c| c.total_days = 100,
                TicketReason::Other,
                Urgency::Routine,
            ),
            (
                |c| c.days_per_fill = 31,
                TicketReason::Other,
                Urgency::Routine,
            ),
            (
                |c| c.days_per_fill = 20,
                TicketReason::Other,
                Urgency::Routine,
            ),
        ];
        for (mutate, reason, urgency) in cases {
            let mut input = base(20);
            mutate(&mut input);
            let eval = check(&input, &r, Locale::ZhTw);
            assert_eq!(eval.result.outcome, RefillOutcome::Consult);
            assert!(eval.result.handoff);
            let plan = eval.ticket.expect("ticket plan");
            assert_eq!((plan.reason, plan.urgency), (reason, urgency));
            assert!(!eval.result.reasons.is_empty());
        }
    }

    #[test]
    fn day_count_violations_are_consult_not_revisit() {
        let mut input = base(95);
        input.total_days = 100;
        assert_eq!(outcome(&input), RefillOutcome::Consult);
        let eval = check(&input, &rules(), Locale::ZhTw);
        let codes: Vec<&str> = eval
            .result
            .reasons
            .iter()
            .map(|r| r.code.as_str())
            .collect();
        assert!(
            codes.contains(&"days_total_exceeds") && codes.contains(&"days_insufficient"),
            "{codes:?}"
        );
    }

    #[test]
    fn ticket_reason_priority_and_all_causes_listed() {
        let mut input = base(20);
        input.controlled = Controlled::Unsure;
        input.symptom_changed = true;
        input.side_effects = true;
        input.special_status = SpecialStatus::RareDisease;
        let eval = check(&input, &rules(), Locale::ZhTw);
        let plan = eval.ticket.expect("plan");
        assert_eq!(plan.reason, TicketReason::ControlledDrug);
        assert_eq!(eval.result.reasons.len(), 4);
        for reason in &eval.result.reasons {
            assert!(
                plan.summary.contains(&reason.text),
                "summary lists {}",
                reason.code
            );
        }
        input.controlled = Controlled::No;
        assert_eq!(
            check(&input, &rules(), Locale::ZhTw)
                .ticket
                .expect("plan")
                .reason,
            TicketReason::SymptomChange
        );
        input.symptom_changed = false;
        assert_eq!(
            check(&input, &rules(), Locale::ZhTw)
                .ticket
                .expect("plan")
                .reason,
            TicketReason::SideEffects
        );
        input.side_effects = false;
        assert_eq!(
            check(&input, &rules(), Locale::ZhTw)
                .ticket
                .expect("plan")
                .reason,
            TicketReason::SpecialStatus
        );
    }

    #[test]
    fn consult_wins_over_revisit_and_eligible_has_no_ticket() {
        let mut input = base(95);
        input.symptom_changed = true;
        assert_eq!(outcome(&input), RefillOutcome::Consult);
        let eval = check(&base(20), &rules(), Locale::ZhTw);
        assert!(eval.ticket.is_none() && !eval.result.handoff);
    }

    #[test]
    fn localised_title_message_and_reasons() {
        let r = rules();
        let zh = check(&base(10), &r, Locale::ZhTw).result;
        let en = check(&base(10), &r, Locale::En).result;
        assert_eq!(zh.title, "還沒到可領藥的日子");
        assert_eq!(en.title, "Too early for the next refill");
        assert!(
            zh.message.contains(&format_date(d(20))) && en.message.contains(&format_date(d(20)))
        );
        assert!(
            zh.rules
                .iter()
                .all(|x| !x.text.is_empty() && x.source_url.starts_with("https://"))
        );
        assert!(en.rules.iter().all(|x| !x.text.is_empty()));
    }

    fn form(value: Value) -> Result<RefillInput, FieldErrors> {
        RefillInput::from_json(&value, true, Locale::ZhTw)
    }

    fn good() -> Value {
        json!({"prescription_date": "2026-10-01", "total_days": 90, "days_per_fill": 30, "fills_done": 1, "last_fill_date": "2026-10-01", "controlled": "no", "special_status": "none", "symptom_changed": false, "side_effects": false})
    }

    #[test]
    fn validation_reports_every_bad_field() {
        let r = rules();
        let today = d(20);
        let input = form(good()).expect("input");
        assert!(validate(&input, &r, today, Locale::ZhTw).is_ok());
        let mut bad = good();
        bad["prescription_date"] = json!("2026/10/01");
        bad["total_days"] = json!(0);
        bad["fills_done"] = json!(4);
        bad["last_fill_date"] = json!("2026-12-31");
        let errors =
            validate(&form(bad).expect("typed"), &r, today, Locale::ZhTw).expect_err("invalid");
        for field in [
            "prescription_date",
            "total_days",
            "fills_done",
            "last_fill_date",
        ] {
            assert!(errors.contains_key(field), "{field}: {errors:?}");
        }
    }

    #[test]
    fn validation_orders_and_ranges() {
        let r = rules();
        let mut v = good();
        v["last_fill_date"] = json!("2026-09-01");
        let errors = validate(&form(v).expect("typed"), &r, d(20), Locale::ZhTw)
            .expect_err("rx after last fill");
        assert!(errors.contains_key("prescription_date"));
        let mut v = good();
        v["fills_done"] = json!(0);
        assert!(validate(&form(v).expect("typed"), &r, d(20), Locale::ZhTw).is_err());
        let mut v = good();
        v["fills_done"] = json!(3);
        assert!(
            validate(&form(v).expect("typed"), &r, d(20), Locale::ZhTw).is_ok(),
            "3 is accepted and means revisit"
        );
    }

    #[test]
    fn today_defaults_to_the_server_date_and_can_be_overridden_on_the_form() {
        let r = rules();
        let input = form(good()).expect("input");
        assert_eq!(
            validate(&input, &r, d(20), Locale::ZhTw).expect("ok").today,
            d(20)
        );
        let mut v = good();
        v["today"] = json!("2026-10-11");
        assert_eq!(
            validate(&form(v).expect("typed"), &r, d(20), Locale::ZhTw)
                .expect("ok")
                .today,
            d(10)
        );
    }

    #[test]
    fn model_path_rejects_today_and_unknown_fields() {
        let mut v = good();
        v["today"] = json!("2026-10-11");
        let errors = RefillInput::from_json(&v, false, Locale::ZhTw).expect_err("today refused");
        assert!(errors.contains_key("today"));
        let mut v = good();
        v["colour"] = json!("red");
        assert!(
            RefillInput::from_json(&v, false, Locale::ZhTw)
                .unwrap_err()
                .contains_key("colour")
        );
        assert!(RefillInput::from_json(&good(), false, Locale::ZhTw).is_ok());
    }

    #[test]
    fn type_errors_are_reported_per_field() {
        let errors =
            form(json!({"prescription_date": 5, "total_days": "ninety", "controlled": "maybe"}))
                .expect_err("invalid");
        for field in [
            "prescription_date",
            "total_days",
            "days_per_fill",
            "fills_done",
            "last_fill_date",
            "controlled",
            "special_status",
            "symptom_changed",
            "side_effects",
        ] {
            assert!(errors.contains_key(field), "{field}");
        }
    }

    #[test]
    fn old_csv_without_text_columns_still_loads_and_new_text_columns_are_used() {
        let old = "key,value,unit,source_url,verified_on,note\nmax_total_days,90,days,https://a.example,2026-11-25,n\nmax_days_per_fill,30,days,https://a.example,,n\nearly_window_days,10,days,https://a.example,,n\nmax_fills,3,times,https://a.example,,n\ncontrolled_levels_excluded,1;2,level,https://a.example,,n\nspecial_status_one_time_full,going_abroad;rare_disease,status,https://a.example,,n\n";
        let r = RefillRules::parse(old).expect("old header");
        assert!(
            r.rule_out("max_total_days", Locale::ZhTw)
                .expect("rule")
                .text
                .contains("90")
        );
        let new = "key,value,unit,source_type,source_url,verified_on,text_zh,text_en,note
max_total_days,90,days,official,https://a.example,2026-11-25,最多 90 天（csv 文字）,At most 90 days (csv text),維護者備註
max_days_per_fill,30,days,official,https://a.example,,,,n
early_window_days,10,days,official,https://a.example,,,,n
max_fills,3,times,official,https://a.example,,,,n
controlled_levels_excluded,1;2,level,official,https://a.example,,,,n
special_status_one_time_full,going_abroad;rare_disease,status,official,https://a.example,,,,n
";
        let r = RefillRules::parse(new).expect("new header");
        let rule = r.rule_out("max_total_days", Locale::En).expect("rule");
        assert_eq!(rule.text, "At most 90 days (csv text)");
        assert!(!rule.text.contains("維護者備註"), "note is never shown");
    }

    #[test]
    fn missing_keys_and_bad_numbers_refuse_to_load() {
        assert!(RefillRules::parse("key,value,source_url\nmax_total_days,90,https://a\n").is_err());
        let all = "key,value,source_url\nmax_total_days,x,https://a\nmax_days_per_fill,30,https://a\nearly_window_days,10,https://a\nmax_fills,3,https://a\ncontrolled_levels_excluded,1;2,https://a\nspecial_status_one_time_full,going_abroad,https://a\n";
        assert!(RefillRules::parse(all).is_err());
        assert!(RefillRules::parse(&all.replace("max_total_days,x", "max_total_days,90")).is_ok());
        assert!(
            RefillRules::parse(
                &all.replace("max_total_days,x", "max_total_days,90")
                    .replace("going_abroad", "moon_landing")
            )
            .is_err()
        );
    }
}
