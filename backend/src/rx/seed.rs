//! Demonstration requests for the fictional patients: one in each state worth showing, dated relative to now, built
//! through the same engine and state machine as real ones. Does nothing when there are no demo prescriptions yet.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use serde_json::{Map, Value, json};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use super::engine::{EngineOutput, UrgentNotice};
use super::machine::Step;
use super::medications::{self, Prescription, RefillAnswers};
use super::protocol::{
    MonitoringEntry, MonitoringSet, Op, Protocols, Question, QuestionKind, Rule, Source, ValueKind,
    same_as_record_id,
};
use super::store::{self, NewEvent, Request, ev};
use super::{DecisionOutcome, Disposition, RenewalScope, RxKind, RxStatus};
use crate::clock::format_date;
use crate::error::AppError;
use crate::state::AppState;
use crate::tickets::{self, NewTicket};
use crate::types::{CreatedBy, RedFlagCategory, TicketReason, Urgency};

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

fn strongest(rules: &[Rule], answer: &Value) -> Option<Disposition> {
    rules
        .iter()
        .filter(|r| r.when.matches(Some(answer)))
        .map(|r| r.disposition)
        .max()
}

/// Numbers around every threshold of the rules, inside the allowed range.
fn numbers(rules: &[Rule], min: f64, max: f64) -> Vec<Value> {
    let mut out: Vec<f64> = Vec::new();
    for rule in rules.iter().filter(|r| r.when.op != Op::Missing) {
        if let Some(v) = rule.when.value.as_ref().and_then(Value::as_f64) {
            out.extend([v - 1.0, v + 1.0, v - 0.5, v + 0.5, v]);
        }
    }
    out.extend([min, (min + max) / 2.0, max]);
    out.retain(|v| (min..=max).contains(v));
    out.iter()
        .map(|v| {
            if v.fract() == 0.0 {
                json!(*v as i64)
            } else {
                json!(v)
            }
        })
        .collect()
}

/// An answer whose strongest rule is `want` (`None`: nothing fires).
fn answer_for(q: &Question, want: Option<Disposition>) -> Option<Value> {
    let candidates: Vec<Value> = match q.kind {
        QuestionKind::Boolean => vec![json!(false), json!(true)],
        QuestionKind::Choice => q.options.iter().flatten().map(|o| json!(o.value)).collect(),
        QuestionKind::Number => numbers(&q.rules, q.min.unwrap_or(0.0), q.max.unwrap_or(1000.0)),
        QuestionKind::Text => return None,
    };
    candidates
        .into_iter()
        .find(|a| strongest(&q.rules, a) == want)
}

struct Filled {
    answers: Map<String, Value>,
    monitoring: MonitoringSet,
}

/// Complete answers for one medicine that fire nothing, or exactly one rule of strength `fire`.
fn fill(
    protocols: &Protocols,
    class_id: &str,
    item_id: &str,
    fire: Option<Disposition>,
    today: time::Date,
) -> Filled {
    let mut answers = Map::new();
    answers.insert(same_as_record_id(item_id), json!(true));
    let class = protocols.class(class_id);
    let class_questions = class.map(|c| c.questions.as_slice()).unwrap_or(&[]);
    for q in protocols.general.questions.iter().chain(class_questions) {
        if let Some(a) = answer_for(q, None) {
            answers.insert(q.id.clone(), a);
        }
    }
    if let Some(want) = fire
        && let Some((id, a)) = class_questions
            .iter()
            .chain(&protocols.general.questions)
            .find_map(|q| answer_for(q, Some(want)).map(|a| (q.id.clone(), a)))
    {
        answers.insert(id, a);
    }
    let mut monitoring = MonitoringSet::new();
    for m in class.map(|c| c.monitoring.as_slice()).unwrap_or(&[]) {
        let age = m.max_age_days.unwrap_or(60).min(60) / 2;
        let value = match m.value_kind {
            ValueKind::DateOnly => None,
            ValueKind::Number => numbers(&m.rules, 0.0, 10_000.0)
                .into_iter()
                .find(|v| strongest(&m.rules, v).is_none() && *v != json!(0))
                .and_then(|v| v.as_f64()),
        };
        monitoring.insert(
            m.id.clone(),
            MonitoringEntry {
                value,
                date: Some(format_date(today - Duration::days(age))),
                source: Source::Clinic,
            },
        );
    }
    Filled {
        answers,
        monitoring,
    }
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/// How far a demonstration request has come. Hours are "ago".
#[derive(Debug, Clone, Copy, PartialEq)]
enum Stage {
    Submitted,
    InReview,
    Urgent,
    MoreInfo {
        asked: i64,
    },
    AtPharmacy {
        decided: i64,
    },
    Ready {
        decided: i64,
        ready: i64,
    },
    Dispensed {
        decided: i64,
        ready: i64,
        handed: i64,
    },
    Closed {
        decided: i64,
        outcome: DecisionOutcome,
    },
}

#[derive(Debug, Clone, Copy)]
struct Plan {
    kind: RxKind,
    submitted: i64,
    fire: Option<Disposition>,
    stage: Stage,
    /// For the account people sign in to; the rest go to the panel patients.
    for_login: bool,
}

const fn renewal(submitted: i64, fire: Option<Disposition>, stage: Stage) -> Plan {
    Plan {
        kind: RxKind::Renewal,
        submitted,
        fire,
        stage,
        for_login: false,
    }
}

const fn refill(submitted: i64, stage: Stage) -> Plan {
    Plan {
        kind: RxKind::Refill,
        submitted,
        fire: None,
        stage,
        for_login: false,
    }
}

const PANEL: [Plan; 13] = [
    Plan {
        for_login: true,
        ..renewal(30, Some(Disposition::Review), Stage::MoreInfo { asked: 6 })
    },
    renewal(5, None, Stage::Submitted),
    renewal(20, Some(Disposition::Review), Stage::InReview),
    renewal(74, Some(Disposition::InPerson), Stage::Submitted),
    renewal(0, Some(Disposition::Urgent), Stage::Urgent),
    renewal(44, Some(Disposition::Review), Stage::MoreInfo { asked: 22 }),
    renewal(50, None, Stage::AtPharmacy { decided: 10 }),
    renewal(
        70,
        None,
        Stage::Ready {
            decided: 40,
            ready: 4,
        },
    ),
    renewal(
        240,
        None,
        Stage::Dispensed {
            decided: 220,
            ready: 200,
            handed: 170,
        },
    ),
    renewal(
        290,
        Some(Disposition::InPerson),
        Stage::Closed {
            decided: 270,
            outcome: DecisionOutcome::Decline,
        },
    ),
    renewal(
        216,
        Some(Disposition::InPerson),
        Stage::Closed {
            decided: 200,
            outcome: DecisionOutcome::VisitRequired,
        },
    ),
    refill(3, Stage::Submitted),
    refill(
        26,
        Stage::Ready {
            decided: 24,
            ready: 5,
        },
    ),
];

/// A guest starts with one closed request in the past, so every medicine is still free to try.
const GUEST: Plan = renewal(
    24 * 40,
    Some(Disposition::InPerson),
    Stage::Closed {
        decided: 24 * 39,
        outcome: DecisionOutcome::VisitRequired,
    },
);

struct Staff {
    physician: Option<Uuid>,
    pharmacist: Option<Uuid>,
}

async fn staff(state: &AppState) -> Result<Staff> {
    let of = |role: &'static str| {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM accounts WHERE role = $1 AND status = 'active' ORDER BY is_demo DESC, created_at LIMIT 1")
            .bind(role)
            .fetch_optional(&state.db)
    };
    Ok(Staff {
        physician: of("physician").await?,
        pharmacist: of("pharmacist").await?,
    })
}

#[derive(sqlx::FromRow)]
struct DemoPatient {
    id: Uuid,
    login: bool,
}

/// Adds the panel's requests after the demo patients and their prescriptions were (re)built.
#[allow(dead_code)]
pub async fn seed_demo_requests(state: &AppState) -> Result<()> {
    sqlx::query("DELETE FROM rx_requests r USING accounts a WHERE a.id = r.patient_id AND r.is_demo AND a.is_demo")
        .execute(&state.db)
        .await?;
    let patients: Vec<DemoPatient> = sqlx::query_as("SELECT id, username IS NOT NULL AS login FROM accounts WHERE is_demo AND NOT is_guest AND role = 'patient' ORDER BY demo_key, id")
        .fetch_all(&state.db)
        .await?;
    let staff = staff(state).await?;
    let mut used: BTreeSet<String> = BTreeSet::new();
    // Spread the requests over the patients before giving anyone a second one.
    let mut load: BTreeMap<Uuid, usize> = BTreeMap::new();
    let mut made = 0;
    for plan in PANEL {
        let mut order: Vec<&DemoPatient> = patients
            .iter()
            .filter(|p| p.login == plan.for_login)
            .collect();
        order.sort_by_key(|p| load.get(&p.id).copied().unwrap_or(0));
        for patient in order {
            let Some(p) = pick(state, patient.id, &plan, &used).await? else {
                continue;
            };
            build(state, patient.id, &p, &plan, &staff).await?;
            used.insert(p.id.clone());
            *load.entry(patient.id).or_default() += 1;
            made += 1;
            break;
        }
    }
    tracing::info!(requests = made, "demo rx requests");
    Ok(())
}

/// Called after a guest sandbox was filled from a persona.
pub async fn seed_guest_requests(state: &AppState, patient: Uuid, _persona: &str) -> Result<()> {
    let staff = staff(state).await?;
    if staff.physician.is_some()
        && let Some(p) = pick(state, patient, &GUEST, &BTreeSet::new()).await?
    {
        build(state, patient, &p, &GUEST, &staff).await?;
    }
    Ok(())
}

/// A prescription the plan fits: one with nothing left for a renewal, one inside its window for a refill.
async fn pick(
    state: &AppState,
    patient: Uuid,
    plan: &Plan,
    used: &BTreeSet<String>,
) -> Result<Option<Prescription>> {
    let today = state.clock.today();
    let rules = &state.rules.refill;
    let submitted_on = store::taipei_date(state.clock.now() - Duration::hours(plan.submitted));
    let mut conn = state.db.acquire().await?;
    let mut list: Vec<Prescription> = store::active_prescriptions(&mut conn, patient)
        .await?
        .into_iter()
        .filter(|p| !p.self_reported && !used.contains(&p.id))
        // A request cannot be older than the prescription it is about.
        .filter(|p| p.issued_on <= submitted_on)
        .filter(|p| match plan.kind {
            RxKind::Renewal => store::scope_of(state, p).0 == RenewalScope::InScope,
            RxKind::Refill => medications::check_refill(
                p,
                RefillAnswers::default(),
                rules,
                today,
                crate::types::Locale::ZhTw,
            )
            .and_then(std::result::Result::ok)
            .is_some_and(|e| medications::is_eligible(&e.result)),
        })
        .collect();
    list.sort_by_key(|p| p.fills_left(rules, today));
    // Handing over a renewal ends the old record, so it must be used up.
    if plan.kind == RxKind::Renewal && matches!(plan.stage, Stage::Dispensed { .. }) {
        list.retain(|p| p.fills_left(rules, today) == 0);
    }
    Ok(list.into_iter().next())
}

async fn build(
    state: &AppState,
    patient: Uuid,
    p: &Prescription,
    plan: &Plan,
    staff: &Staff,
) -> Result<()> {
    build_in_tx(state, patient, p, plan, staff)
        .await
        .map_err(|e| match e {
            AppError::Internal(e) => e,
            other => anyhow::anyhow!("{other}"),
        })
}

async fn build_in_tx(
    state: &AppState,
    patient: Uuid,
    p: &Prescription,
    plan: &Plan,
    staff: &Staff,
) -> std::result::Result<(), AppError> {
    let now = state.clock.now();
    let ago = |hours: i64| now - Duration::hours(hours);
    let submitted = ago(plan.submitted);
    let prescription = Uuid::parse_str(&p.id).map_err(anyhow::Error::from)?;
    let (patient_actor, doctor, pharmacist) = (Some(patient), staff.physician, staff.pharmacist);
    let mut tx = state.db.begin().await?;
    let pharmacy_id: Option<String> =
        sqlx::query_scalar("SELECT id FROM pharmacies ORDER BY position, id LIMIT 1")
            .fetch_optional(&mut *tx)
            .await?;
    let id = store::insert_request(
        &mut tx,
        &store::NewRequest {
            patient,
            kind: plan.kind,
            locale: crate::types::Locale::ZhTw,
            pharmacy_id: pharmacy_id.as_deref(),
            at: submitted - Duration::minutes(25),
            day: store::taipei_date(submitted),
            is_demo: true,
        },
    )
    .await?;
    let (scope, reason) = store::scope_of(state, p);
    store::insert_item(
        &mut tx,
        id,
        prescription,
        0,
        &p.drug.class_id,
        scope,
        &reason.zh,
    )
    .await?;
    let mut r = store::lock(&mut tx, id).await?.ok_or(AppError::NotFound)?;
    let list = store::items(&mut tx, id).await?;
    let prescriptions = store::item_prescriptions(&mut tx, &list).await?;
    store::add_event(
        &mut tx,
        id,
        submitted - Duration::minutes(25),
        NewEvent::new(ev::CREATED, patient_actor),
    )
    .await?;

    // The patient's answers and what the checks say about them.
    let mut output: Option<EngineOutput> = None;
    let (answers, monitoring) = if plan.kind == RxKind::Renewal {
        let filled = fill(
            &state.rx.protocols,
            &p.drug.class_id,
            &list[0].id.to_string(),
            plan.fire,
            state.clock.today(),
        );
        let out = store::run_engine(
            state,
            &list,
            &prescriptions,
            &filled.answers,
            &filled.monitoring,
        );
        store::save_engine(&mut tx, id, &out, submitted).await?;
        output = Some(out);
        (Value::Object(filled.answers), json!(filled.monitoring))
    } else {
        if let Some(input) = medications::refill_input(p, RefillAnswers::default()) {
            sqlx::query("UPDATE rx_request_items SET refill = $2 WHERE id = $1")
                .bind(list[0].id)
                .bind(store::refill_stored(&input, state.clock.today()))
                .execute(&mut *tx)
                .await?;
        }
        (
            json!({ "symptom_changed": false, "side_effects": false, "special_status": "none" }),
            json!({}),
        )
    };
    let urgent = output.as_ref().and_then(|o| o.urgent.clone());
    let days_left = store::min_days_left(&prescriptions, state.clock.today());
    let priority = output
        .as_ref()
        .map_or(Urgency::Routine, |o| o.priority(days_left));
    let pickup = json!({ "date": format_date(state.clock.today() + Duration::days(1)), "slot": "afternoon" });
    sqlx::query("UPDATE rx_requests SET answers = $2, monitoring = $3, priority = $4, submitted_at = $5, sla_due_at = $6, pickup_window = $7, consent_version = 'demo', step = 'review' WHERE id = $1")
        .bind(id)
        .bind(answers)
        .bind(monitoring)
        .bind(priority.as_str())
        .bind(submitted)
        .bind(store::sla_due(state, priority, submitted))
        .bind((plan.kind == RxKind::Refill).then_some(pickup))
        .execute(&mut *tx)
        .await?;
    let first = if urgent.is_some() && plan.kind == RxKind::Renewal {
        Step::SubmitUrgent
    } else {
        Step::Submit
    };
    store::advance(
        &mut tx,
        &mut r,
        first,
        submitted,
        NewEvent::new(ev::SUBMITTED, patient_actor),
    )
    .await?;

    match plan.stage {
        Stage::Submitted => {}
        Stage::InReview => {
            start_review(&mut tx, &mut r, doctor, submitted + Duration::hours(2)).await?;
            assign(&mut tx, id, doctor).await?;
        }
        Stage::Urgent => {
            if let Some(notice) = &urgent {
                urgent_mark(&mut tx, id, notice, submitted).await?;
            }
        }
        Stage::MoreInfo { asked } => {
            start_review(&mut tx, &mut r, doctor, submitted + Duration::hours(2)).await?;
            assign(&mut tx, id, doctor).await?;
            decide(
                &mut tx,
                &mut r,
                doctor,
                ago(asked),
                DecisionOutcome::MoreInfo,
                Some("請補上最近一週在家量的血壓，早晚各幾次、大約多少？"),
            )
            .await?;
        }
        Stage::AtPharmacy { decided } => {
            to_pharmacy(&mut tx, &mut r, doctor, pharmacist, ago(decided)).await?;
        }
        Stage::Ready { decided, ready } => {
            to_pharmacy(&mut tx, &mut r, doctor, pharmacist, ago(decided)).await?;
            make_ready(&mut tx, &mut r, pharmacist, ago(ready)).await?;
        }
        Stage::Dispensed {
            decided,
            ready,
            handed,
        } => {
            to_pharmacy(&mut tx, &mut r, doctor, pharmacist, ago(decided)).await?;
            make_ready(&mut tx, &mut r, pharmacist, ago(ready)).await?;
            hand_over(&mut tx, &mut r, prescription, pharmacist, ago(handed)).await?;
        }
        Stage::Closed { decided, outcome } => {
            start_review(&mut tx, &mut r, doctor, ago(decided) - Duration::hours(1)).await?;
            let note = if outcome == DecisionOutcome::Decline {
                "這次先不續開，請在下次回診時和醫師討論。"
            } else {
                "症狀有變化，請回診讓醫師當面評估後再決定。"
            };
            decide(&mut tx, &mut r, doctor, ago(decided), outcome, Some(note)).await?;
        }
    }
    sqlx::query("UPDATE rx_requests SET updated_at = (SELECT max(at) FROM rx_events WHERE request_id = $1) WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    // The urgent one has its ticket, like a real one.
    if plan.stage == Stage::Urgent
        && let Some(notice) = urgent
    {
        tickets::open(
            state,
            NewTicket {
                source: tickets::Source::Rx {
                    request_id: id,
                    patient_id: patient,
                },
                reason: TicketReason::RedFlag,
                urgency: Urgency::Urgent,
                summary: &super::texts::rf(
                    super::texts::R::TicketRxUrgent,
                    crate::types::Locale::ZhTw,
                    &[("no", &r.no), ("label", &notice.label.zh)],
                ),
                created_by: CreatedBy::Code,
            },
        )
        .await?;
    }
    Ok(())
}

type Tx = sqlx::PgConnection;
type Done = std::result::Result<(), AppError>;

async fn assign(tx: &mut Tx, id: Uuid, to: Option<Uuid>) -> Done {
    sqlx::query("UPDATE rx_requests SET assigned_to = $2 WHERE id = $1")
        .bind(id)
        .bind(to)
        .execute(tx)
        .await?;
    Ok(())
}

async fn start_review(
    tx: &mut Tx,
    r: &mut Request,
    doctor: Option<Uuid>,
    at: OffsetDateTime,
) -> Done {
    if r.status == RxStatus::Submitted {
        store::advance(
            tx,
            r,
            Step::StartReview,
            at,
            NewEvent::new(ev::REVIEW_STARTED, doctor),
        )
        .await?;
    }
    Ok(())
}

async fn urgent_mark(tx: &mut Tx, id: Uuid, notice: &UrgentNotice, at: OffsetDateTime) -> Done {
    sqlx::query("UPDATE rx_requests SET priority = 'urgent', extra = extra || '{\"alerted\": true}'::jsonb WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let data = json!({
        "category": notice.category.map(RedFlagCategory::as_str),
        "from_text": notice.from_text,
        "label": notice.label.zh,
        "label_en": notice.label.en,
    });
    store::add_event(tx, id, at, NewEvent::new(ev::URGENT, None).data(data)).await?;
    Ok(())
}

async fn decide(
    tx: &mut Tx,
    r: &mut Request,
    doctor: Option<Uuid>,
    at: OffsetDateTime,
    outcome: DecisionOutcome,
    note: Option<&str>,
) -> Done {
    sqlx::query("UPDATE rx_request_items SET outcome = $2, outcome_note = $3, decided_by = $4, decided_at = $5 WHERE request_id = $1")
        .bind(r.id)
        .bind(outcome.as_str())
        .bind(note)
        .bind(doctor)
        .bind(at)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE rx_requests SET decided_by = $2, decided_at = $3 WHERE id = $1")
        .bind(r.id)
        .bind(doctor)
        .bind(at)
        .execute(&mut *tx)
        .await?;
    r.decided_by = doctor;
    let (step, kind) = match outcome {
        DecisionOutcome::Approve => (Step::Approve, ev::APPROVED),
        DecisionOutcome::Decline => (Step::Decline, ev::DECLINED),
        DecisionOutcome::VisitRequired => (Step::RequireVisit, ev::VISIT_REQUIRED),
        DecisionOutcome::MoreInfo => (Step::AskMore, ev::MORE_INFO),
    };
    store::advance(tx, r, step, at, NewEvent::new(kind, doctor)).await
}

/// A renewal through its physician, a refill through the pharmacist who accepts it.
async fn to_pharmacy(
    tx: &mut Tx,
    r: &mut Request,
    doctor: Option<Uuid>,
    pharmacist: Option<Uuid>,
    at: OffsetDateTime,
) -> Done {
    if r.kind == RxKind::Refill {
        assign(tx, r.id, pharmacist).await?;
        return store::advance(
            tx,
            r,
            Step::Accept,
            at,
            NewEvent::new(ev::ACCEPTED, pharmacist),
        )
        .await;
    }
    start_review(tx, r, doctor, at - Duration::hours(1)).await?;
    decide(tx, r, doctor, at, DecisionOutcome::Approve, None).await?;
    let shop = store::pharmacy(tx, r.pharmacy_id.as_deref()).await?;
    let data = shop
        .map(|p| json!({ "pharmacy": p.name, "pharmacy_en": p.name_en }))
        .unwrap_or(json!({}));
    store::advance(
        tx,
        r,
        Step::SendToPharmacy,
        at,
        NewEvent::new(ev::SENT_TO_PHARMACY, None).data(data),
    )
    .await
}

async fn make_ready(
    tx: &mut Tx,
    r: &mut Request,
    pharmacist: Option<Uuid>,
    at: OffsetDateTime,
) -> Done {
    store::advance(
        tx,
        r,
        Step::MarkReady,
        at,
        NewEvent::new(ev::READY, pharmacist),
    )
    .await?;
    sqlx::query("UPDATE rx_requests SET ready_at = $2, assigned_to = $3 WHERE id = $1")
        .bind(r.id)
        .bind(at)
        .bind(pharmacist)
        .execute(tx)
        .await?;
    Ok(())
}

async fn hand_over(
    tx: &mut Tx,
    r: &mut Request,
    prescription: Uuid,
    pharmacist: Option<Uuid>,
    at: OffsetDateTime,
) -> Done {
    let on = store::taipei_date(at);
    let shop = store::pharmacy(tx, r.pharmacy_id.as_deref()).await?;
    let next = store::next_prescription(tx, prescription, r, on).await?;
    store::add_fill(tx, next, 1, on, shop.as_ref(), pharmacist, r.id).await?;
    store::advance(
        tx,
        r,
        Step::Dispense,
        at,
        NewEvent::new(ev::DISPENSED, pharmacist),
    )
    .await?;
    sqlx::query("UPDATE rx_requests SET pharmacy_checks = '{\"identity\": true, \"allergy\": true, \"interaction\": true, \"quantity\": true}'::jsonb WHERE id = $1")
        .bind(r.id)
        .execute(&mut *tx)
        .await?;
    store::add_event(tx, r.id, at, NewEvent::new(ev::NEXT_PRESCRIPTION, None)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::engine::{self, EngineInput, ItemInput};
    use super::super::{RxRules, fixtures};
    use super::*;
    use time::macros::date;

    const TODAY: time::Date = date!(2026 - 11 - 25);

    fn result(rules: &RxRules, drug: &str, class: &str, fire: Option<Disposition>) -> Disposition {
        let filled = fill(&rules.protocols, class, "x", fire, TODAY);
        engine::evaluate(
            &rules.formulary,
            &rules.protocols,
            &fixtures::red_flags(),
            &EngineInput {
                today: TODAY,
                items: &[ItemInput {
                    item_id: "x".into(),
                    drug_id: drug.into(),
                    controlled_level: 0,
                    fills_left: 0,
                }],
                answers: &filled.answers,
                monitoring: &filled.monitoring,
            },
        )
        .disposition
    }

    /// The demo answers really produce the state they are meant to show, for every drug that can be requested.
    #[test]
    fn filled_answers_give_the_wanted_result() {
        let mut sets = vec![fixtures::rules()];
        if let Ok(shipped) = RxRules::load(&fixtures::data_dir()) {
            sets.push(shipped);
        }
        for rules in &sets {
            for drug in rules.formulary.drugs() {
                if drug.renewal_scope != RenewalScope::InScope || drug.class_id == "biguanide" {
                    continue;
                }
                let of = |fire| result(rules, &drug.drug_id, &drug.class_id, fire);
                assert_eq!(of(None), Disposition::Ready, "{}", drug.drug_id);
                for want in [
                    Disposition::Review,
                    Disposition::InPerson,
                    Disposition::Urgent,
                ] {
                    assert_eq!(of(Some(want)), want, "{} {want:?}", drug.drug_id);
                }
            }
        }
    }

    #[test]
    fn plans_run_forward_in_time() {
        for plan in PANEL.iter().chain([&GUEST]) {
            let steps: Vec<i64> = match plan.stage {
                Stage::Submitted | Stage::InReview | Stage::Urgent => vec![],
                Stage::MoreInfo { asked } => vec![asked],
                Stage::AtPharmacy { decided } => vec![decided],
                Stage::Ready { decided, ready } => vec![decided, ready],
                Stage::Dispensed {
                    decided,
                    ready,
                    handed,
                } => vec![decided, ready, handed],
                Stage::Closed { decided, .. } => vec![decided],
            };
            let mut last = plan.submitted;
            for s in steps {
                assert!(s < last && s >= 0, "{plan:?}");
                last = s;
            }
        }
    }
}
