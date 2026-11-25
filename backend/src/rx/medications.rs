//! Medication cards (contract §3 `MedicationCard`): how much is left, when the next fill can be collected, what can be
//! asked for. Every refill date and outcome comes from [`crate::refill`]; this module only turns records into its input
//! and its result into a card.
//!
//! Dates follow the refill convention: `supply_ends_on` is the first day without medicine, the same day the refill
//! texts name ("用完前").

use serde::Serialize;
use serde_json::{Map, Value};
use time::{Date, Duration};

use super::formulary::DrugRef;
use super::protocol::{REFILL_SIDE_EFFECTS, REFILL_SPECIAL, REFILL_SYMPTOM};
use super::{LText, RenewalScope, wire_enum};
use crate::clock::format_date;
use crate::refill::{self, Evaluation, FieldErrors, RefillInput, RefillResult, RefillRules};
use crate::types::{Controlled, Locale, RefillOutcome, SpecialStatus};

/// A window opening within this many days is shown as "soon" (display only, no rule depends on it).
const WINDOW_SOON_DAYS: i64 = 7;

wire_enum!(MedState {
    OnHand => "on_hand",
    WindowOpen => "window_open",
    WindowSoon => "window_soon",
    Late => "late",
    Finished => "finished",
    Expired => "expired",
});

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Fill {
    pub n: i64,
    pub filled_on: String,
    pub pharmacy_name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FillRecord {
    pub n: i64,
    pub filled_on: Date,
    pub pharmacy_name: String,
}

/// A prescription record as stored. A self-reported medicine has no days and no fills.
#[derive(Debug, Clone)]
pub struct Prescription {
    pub id: String,
    pub drug: DrugRef,
    /// As written on the record. Shown, never computed.
    pub dose: LText,
    pub self_reported: bool,
    /// A record this system made when a renewal was handed over (demonstration only).
    pub is_demo: bool,
    pub issued_on: Date,
    pub total_days: i64,
    pub days_per_fill: i64,
    pub fills: Vec<FillRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Window {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MedicationCard {
    pub prescription_id: String,
    pub drug: DrugRef,
    pub dose_text: String,
    pub source: &'static str,
    /// Not in the contract's minimum: true for the demonstration record a handed-over renewal creates.
    pub is_demo: bool,
    pub issued_on: String,
    pub total_days: i64,
    pub days_per_fill: i64,
    pub fills: Vec<Fill>,
    pub fills_allowed: i64,
    pub supply_ends_on: String,
    pub next_window: Option<Window>,
    pub valid_until: String,
    pub state: MedState,
    pub renewal_scope: RenewalScope,
    pub days_left: i64,
    pub open_request_id: Option<String>,
    pub refill_preview: Option<RefillResult>,
}

fn plus(date: Date, n: i64) -> Date {
    date.checked_add(Duration::days(n)).unwrap_or(Date::MAX)
}

impl Prescription {
    pub fn fills_done(&self) -> i64 {
        self.fills.len() as i64
    }

    /// How many fills this prescription allows: as many as cover its days, never more than the rule.
    pub fn fills_allowed(&self, rules: &RefillRules) -> i64 {
        if self.days_per_fill <= 0 || self.total_days <= 0 {
            return 0;
        }
        rules
            .max_fills
            .min((self.total_days + self.days_per_fill - 1) / self.days_per_fill)
    }

    /// The last day a fill can be collected, as the refill check says. The day count is not repeated here; it is read
    /// from a check of the same prescription on its first day.
    pub fn valid_until(&self, rules: &RefillRules) -> Date {
        let issued = format_date(self.issued_on);
        let first_day = RefillInput {
            prescription_date: issued.clone(),
            total_days: self.total_days,
            days_per_fill: self.days_per_fill,
            fills_done: 1,
            last_fill_date: issued,
            today: None,
            controlled: Controlled::No,
            special_status: SpecialStatus::None,
            symptom_changed: false,
            side_effects: false,
        };
        refill::validate(&first_day, rules, self.issued_on, Locale::ZhTw)
            .ok()
            .and_then(|c| refill::check(&c, rules, Locale::ZhTw).result.latest_date)
            .and_then(|d| crate::clock::parse_date(&d))
            // Days outside the rules go to a person; the last covered day is the careful answer.
            .unwrap_or_else(|| plus(self.issued_on, (self.total_days - 1).max(0)))
    }

    pub fn last_fill(&self) -> Option<&FillRecord> {
        self.fills.iter().max_by_key(|f| (f.filled_on, f.n))
    }

    /// The first day without medicine. The last fill may be shorter than the others (80 days = 30 + 30 + 20).
    pub fn supply_ends_on(&self) -> Date {
        match self.last_fill() {
            None => self.issued_on,
            Some(last) => {
                let before = (self.fills_done() - 1).max(0) * self.days_per_fill;
                let covered = self.days_per_fill.min((self.total_days - before).max(0));
                plus(last.filled_on, covered)
            }
        }
    }

    pub fn days_left(&self, today: Date) -> i64 {
        (self.supply_ends_on() - today).whole_days().max(0)
    }

    /// Fills that can still be collected with this prescription.
    pub fn fills_left(&self, rules: &RefillRules, today: Date) -> i64 {
        if self.self_reported || today > self.valid_until(rules) {
            0
        } else {
            (self.fills_allowed(rules) - self.fills_done()).max(0)
        }
    }
}

/// What the patient answered for a refill, or calm defaults for a preview.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefillAnswers {
    pub symptom_changed: bool,
    pub side_effects: bool,
    pub special_status: SpecialStatus,
}

impl Default for RefillAnswers {
    fn default() -> Self {
        Self {
            symptom_changed: false,
            side_effects: false,
            special_status: SpecialStatus::None,
        }
    }
}

impl RefillAnswers {
    /// `None` until all three questions are answered: an unanswered question is never read as "no".
    pub fn from_answers(answers: &Map<String, Value>) -> Option<Self> {
        Some(Self {
            symptom_changed: answers.get(REFILL_SYMPTOM)?.as_bool()?,
            side_effects: answers.get(REFILL_SIDE_EFFECTS)?.as_bool()?,
            special_status: SpecialStatus::parse(answers.get(REFILL_SPECIAL)?.as_str()?)?,
        })
    }
}

/// The refill input of a clinic prescription. `None` when nothing has been filled yet (the first fill is not a refill)
/// or the medicine is self-reported.
pub fn refill_input(p: &Prescription, answers: RefillAnswers) -> Option<RefillInput> {
    if p.self_reported {
        return None;
    }
    let last = p.last_fill()?;
    Some(RefillInput {
        prescription_date: format_date(p.issued_on),
        total_days: p.total_days,
        days_per_fill: p.days_per_fill,
        fills_done: p.fills_done(),
        last_fill_date: format_date(last.filled_on),
        today: None,
        controlled: if p.drug.controlled_level > 0 {
            Controlled::Yes
        } else {
            Controlled::No
        },
        special_status: answers.special_status,
        symptom_changed: answers.symptom_changed,
        side_effects: answers.side_effects,
    })
}

/// Runs the refill check for a prescription on `today`.
pub fn check_refill(
    p: &Prescription,
    answers: RefillAnswers,
    rules: &RefillRules,
    today: Date,
    locale: Locale,
) -> Option<Result<Evaluation, FieldErrors>> {
    let input = refill_input(p, answers)?;
    Some(
        refill::validate(&input, rules, today, locale)
            .map(|checked| refill::check(&checked, rules, locale)),
    )
}

/// Submit and hand-over both need this to be true on their own day.
pub fn is_eligible(result: &RefillResult) -> bool {
    result.outcome == RefillOutcome::Eligible
}

/// Builds the card. `open_request_id` is an unfinished request for this prescription, if any.
pub fn card(
    p: &Prescription,
    scope: RenewalScope,
    rules: &RefillRules,
    today: Date,
    open_request_id: Option<String>,
    locale: Locale,
) -> MedicationCard {
    let preview = check_refill(p, RefillAnswers::default(), rules, today, locale)
        .and_then(Result::ok)
        .map(|e| e.result);
    let supply_end = p.supply_ends_on();
    let valid_until = p.valid_until(rules);
    let first_fill_open = !p.self_reported && p.fills.is_empty() && today <= valid_until;
    let next_window = match &preview {
        Some(r) if matches!(r.outcome, RefillOutcome::Eligible | RefillOutcome::TooEarly) => r
            .earliest_date
            .clone()
            .zip(r.latest_date.clone())
            .map(|(from, to)| Window { from, to }),
        _ if first_fill_open && p.total_days > 0 => Some(Window {
            from: format_date(p.issued_on),
            to: format_date(valid_until),
        }),
        _ => None,
    };
    let state = if p.self_reported {
        MedState::OnHand
    } else if p.fills_done() >= p.fills_allowed(rules) {
        MedState::Finished
    } else if today > valid_until {
        MedState::Expired
    } else if first_fill_open {
        MedState::WindowOpen
    } else {
        match preview.as_ref().map(|r| r.outcome) {
            Some(RefillOutcome::Eligible) if today > supply_end => MedState::Late,
            Some(RefillOutcome::Eligible) => MedState::WindowOpen,
            Some(RefillOutcome::TooEarly)
                if preview
                    .as_ref()
                    .and_then(|r| r.earliest_date.as_deref())
                    .and_then(crate::clock::parse_date)
                    .is_some_and(|d| (d - today).whole_days() <= WINDOW_SOON_DAYS) =>
            {
                MedState::WindowSoon
            }
            // A person has to look first (controlled drug, unusual days): show supply only.
            _ if today > supply_end => MedState::Late,
            _ => MedState::OnHand,
        }
    };
    let mut fills: Vec<Fill> = p
        .fills
        .iter()
        .map(|f| Fill {
            n: f.n,
            filled_on: format_date(f.filled_on),
            pharmacy_name: f.pharmacy_name.clone(),
        })
        .collect();
    fills.sort_by_key(|f| f.n);
    MedicationCard {
        prescription_id: p.id.clone(),
        drug: p.drug.clone(),
        dose_text: if p.dose.get(locale).is_empty() {
            p.dose.zh.clone()
        } else {
            p.dose.get(locale).to_string()
        },
        is_demo: p.is_demo,
        source: if p.self_reported {
            "self_reported"
        } else {
            "clinic"
        },
        issued_on: format_date(p.issued_on),
        total_days: p.total_days,
        days_per_fill: p.days_per_fill,
        fills,
        fills_allowed: p.fills_allowed(rules),
        supply_ends_on: format_date(supply_end),
        next_window,
        valid_until: format_date(valid_until),
        state,
        renewal_scope: scope,
        days_left: p.days_left(today),
        open_request_id,
        refill_preview: preview,
    }
}

/// What a chat tool may read back to its own patient: names, dates and states. No dose, no advice.
pub fn summary_line(card: &MedicationCard, locale: Locale) -> Value {
    let name = LText::new(&card.drug.name_zh, &card.drug.name_en);
    serde_json::json!({
        "prescription_id": card.prescription_id,
        "drug": name.get(locale),
        "source": card.source,
        "state": card.state,
        "fills_done": card.fills.len(),
        "fills_allowed": card.fills_allowed,
        "supply_ends_on": card.supply_ends_on,
        "next_window": card.next_window,
        "valid_until": card.valid_until,
        "renewal_scope": card.renewal_scope,
        "has_open_request": card.open_request_id.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::super::fixtures;
    use super::*;
    use serde_json::json;
    use time::macros::date;

    const ISSUED: Date = date!(2026 - 10 - 01);

    fn drug(level: u8) -> DrugRef {
        DrugRef {
            drug_id: "amlodipine".into(),
            name_zh: "氨氯地平".into(),
            name_en: "Amlodipine".into(),
            class_id: "ccb".into(),
            class_zh: "鈣離子阻斷劑".into(),
            class_en: "Calcium channel blocker".into(),
            controlled_level: level,
        }
    }

    fn rx(fill_days: &[i64]) -> Prescription {
        Prescription {
            id: "p1".into(),
            drug: drug(0),
            dose: LText::new("每天一次", "Once a day"),
            is_demo: false,
            self_reported: false,
            issued_on: ISSUED,
            total_days: 90,
            days_per_fill: 30,
            fills: fill_days
                .iter()
                .enumerate()
                .map(|(i, d)| FillRecord {
                    n: i as i64 + 1,
                    filled_on: plus(ISSUED, *d),
                    pharmacy_name: "示範藥局".into(),
                })
                .collect(),
        }
    }

    fn on(p: &Prescription, day: i64) -> MedicationCard {
        card(
            p,
            RenewalScope::InScope,
            &fixtures::refill_rules(),
            plus(ISSUED, day),
            None,
            Locale::ZhTw,
        )
    }

    /// The same boundary days as backend-spec §13.5(e), read from the card.
    #[test]
    fn states_follow_the_refill_check_day_by_day() {
        let p = rx(&[0]);
        for (day, state) in [
            (0, MedState::OnHand),
            (12, MedState::OnHand),
            (13, MedState::WindowSoon),
            (19, MedState::WindowSoon),
            (20, MedState::WindowOpen),
            (30, MedState::WindowOpen),
            (31, MedState::Late),
            (90, MedState::Late),
            (91, MedState::Expired),
        ] {
            assert_eq!(on(&p, day).state, state, "day {day}");
        }
    }

    /// The last day is whatever the refill check says, so a change there changes every card.
    #[test]
    fn validity_is_the_refill_checks_own_last_day() {
        let rules = fixtures::refill_rules();
        let p = rx(&[0]);
        let last = p.valid_until(&rules);
        let at = |day| {
            check_refill(&p, RefillAnswers::default(), &rules, day, Locale::ZhTw)
                .expect("a refill")
                .expect("valid")
                .result
                .outcome
        };
        assert_eq!(at(last), RefillOutcome::Eligible);
        assert_eq!(at(plus(last, 1)), RefillOutcome::Revisit);
        let mut long = rx(&[0]);
        long.total_days = 120;
        assert_eq!(
            long.valid_until(&rules),
            plus(ISSUED, 119),
            "days outside the rules: the last covered day"
        );
    }

    #[test]
    fn window_and_supply_come_from_the_refill_rules() {
        let c = on(&rx(&[0]), 10);
        assert_eq!(c.supply_ends_on, "2026-10-31");
        assert_eq!(
            c.next_window,
            Some(Window {
                from: "2026-10-21".into(),
                to: "2026-12-30".into()
            })
        );
        assert_eq!(c.valid_until, "2026-12-30");
        assert_eq!(c.days_left, 20);
        let preview = c.refill_preview.expect("preview");
        assert_eq!(preview.outcome, RefillOutcome::TooEarly);
        assert_eq!(preview.earliest_date.as_deref(), Some("2026-10-21"));
    }

    #[test]
    fn a_used_up_prescription_is_finished_and_has_no_window() {
        let c = on(&rx(&[0, 25, 52]), 60);
        assert_eq!(c.state, MedState::Finished);
        assert_eq!(c.next_window, None);
        assert_eq!(c.days_left, 22);
        assert_eq!(
            c.refill_preview.expect("preview").outcome,
            RefillOutcome::Revisit
        );
        assert_eq!(
            rx(&[0, 25, 52]).fills_left(&fixtures::refill_rules(), plus(ISSUED, 60)),
            0
        );
    }

    #[test]
    fn a_short_last_fill_counts_its_real_days() {
        let mut p = rx(&[0, 25, 52]);
        p.total_days = 80;
        assert_eq!(
            p.supply_ends_on(),
            plus(ISSUED, 52 + 20),
            "80 = 30 + 30 + 20"
        );
        p.fills.truncate(2);
        assert_eq!(p.supply_ends_on(), plus(ISSUED, 25 + 30));
        assert_eq!(p.fills_allowed(&fixtures::refill_rules()), 3);
    }

    #[test]
    fn before_the_first_fill_the_window_is_the_whole_validity() {
        let c = on(&rx(&[]), 5);
        assert_eq!(c.state, MedState::WindowOpen);
        assert!(c.refill_preview.is_none(), "the first fill is not a refill");
        assert_eq!(c.next_window.expect("window").from, "2026-10-01");
        assert_eq!(c.days_left, 0);
        assert_eq!(on(&rx(&[]), 91).state, MedState::Expired);
    }

    #[test]
    fn a_controlled_drug_shows_supply_but_no_window() {
        let mut p = rx(&[0]);
        p.drug = drug(4);
        let c = on(&p, 25);
        assert_eq!(c.next_window, None);
        assert_eq!(c.state, MedState::OnHand);
        assert_eq!(
            c.refill_preview.expect("preview").outcome,
            RefillOutcome::Consult
        );
    }

    #[test]
    fn self_reported_medicines_have_no_window_and_no_refill() {
        let mut p = rx(&[]);
        p.self_reported = true;
        p.total_days = 0;
        p.days_per_fill = 0;
        let c = on(&p, 5);
        assert_eq!(
            (c.state, c.source, c.fills_allowed),
            (MedState::OnHand, "self_reported", 0)
        );
        assert!(c.next_window.is_none() && c.refill_preview.is_none());
        assert!(refill_input(&p, RefillAnswers::default()).is_none());
        assert_eq!(p.fills_left(&fixtures::refill_rules(), ISSUED), 0);
    }

    #[test]
    fn fills_left_is_zero_after_expiry() {
        let p = rx(&[0]);
        let rules = fixtures::refill_rules();
        assert_eq!(p.fills_left(&rules, plus(ISSUED, 60)), 2);
        assert_eq!(p.fills_left(&rules, plus(ISSUED, 91)), 0);
    }

    #[test]
    fn refill_answers_need_all_three() {
        let full =
            json!({"symptom_changed": false, "side_effects": true, "special_status": "none"});
        let a = RefillAnswers::from_answers(full.as_object().expect("object")).expect("answers");
        assert!(a.side_effects && !a.symptom_changed);
        for missing in ["symptom_changed", "side_effects", "special_status"] {
            let mut m = full.as_object().expect("object").clone();
            m.remove(missing);
            assert!(RefillAnswers::from_answers(&m).is_none(), "{missing}");
        }
    }

    /// Eligible when submitted, no longer eligible on the day it is handed over.
    #[test]
    fn eligibility_is_checked_again_on_another_day() {
        let p = rx(&[0]);
        let rules = fixtures::refill_rules();
        let at = |day| {
            check_refill(
                &p,
                RefillAnswers::default(),
                &rules,
                plus(ISSUED, day),
                Locale::ZhTw,
            )
            .expect("a refill")
            .expect("valid")
            .result
        };
        assert!(is_eligible(&at(88)));
        assert!(
            !is_eligible(&at(91)),
            "expired between submitting and collecting"
        );
        assert!(!is_eligible(&at(15)));
    }

    #[test]
    fn symptoms_or_side_effects_make_a_refill_a_consult_with_a_ticket() {
        let p = rx(&[0]);
        let e = check_refill(
            &p,
            RefillAnswers {
                side_effects: true,
                ..RefillAnswers::default()
            },
            &fixtures::refill_rules(),
            plus(ISSUED, 25),
            Locale::ZhTw,
        )
        .expect("a refill")
        .expect("valid");
        assert_eq!(e.result.outcome, RefillOutcome::Consult);
        assert!(e.ticket.is_some());
    }

    #[test]
    fn the_chat_summary_has_no_dose() {
        let line = summary_line(&on(&rx(&[0]), 25), Locale::ZhTw);
        assert_eq!(line["state"], "window_open");
        assert!(!line.to_string().contains("每天一次"));
    }
}
