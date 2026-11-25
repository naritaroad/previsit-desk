//! Oversight numbers (contract §6 `GET /admin/oversight`): how often the engine and the physician agree per class,
//! how long decisions take, how often a pharmacist returns a request. Pure functions over rows read by the store.
//!
//! Agreement: the engine said `ready` and the physician approved, or the engine said `in_person`/`urgent` and the
//! physician asked for a visit or declined; divided by the decided items where the engine said one of those three.
//! With `review` the engine makes no prediction, so those items are left out and counted on their own.
//! `more_info` is not a decision yet.

use std::collections::BTreeMap;

use serde::Serialize;

use super::{DecisionOutcome, Disposition, LText};
use crate::types::Locale;

/// The number of cases per class that the (not implemented) next oversight stage would need. Display only.
pub const THRESHOLD_TOTAL: u32 = 250;

/// One submitted item with its latest engine result and decision.
#[derive(Debug, Clone)]
pub struct ItemRow {
    pub class_id: String,
    pub class: LText,
    pub engine: Disposition,
    pub decision: Option<DecisionOutcome>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClassStats {
    pub class_id: String,
    pub class: String,
    pub total: u32,
    pub engine: BTreeMap<&'static str, u32>,
    pub decisions: BTreeMap<&'static str, u32>,
    pub agreement_rate: Option<f64>,
    /// Decided items where the engine only asked for a look: in neither side of `agreement_rate`.
    pub review_decided: u32,
    pub threshold_total: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Turnaround {
    pub median_h: Option<f64>,
    pub p90_h: Option<f64>,
}

pub fn agrees(engine: Disposition, decision: DecisionOutcome) -> bool {
    match engine {
        Disposition::Ready => decision == DecisionOutcome::Approve,
        Disposition::InPerson | Disposition::Urgent => matches!(
            decision,
            DecisionOutcome::VisitRequired | DecisionOutcome::Decline
        ),
        Disposition::Review | Disposition::Excluded => false,
    }
}

fn round(value: f64, places: i32) -> f64 {
    let f = 10f64.powi(places);
    (value * f).round() / f
}

pub fn by_class(rows: &[ItemRow], locale: Locale) -> Vec<ClassStats> {
    let mut groups: BTreeMap<&str, Vec<&ItemRow>> = BTreeMap::new();
    for row in rows {
        groups.entry(&row.class_id).or_default().push(row);
    }
    groups
        .into_iter()
        .map(|(class_id, rows)| {
            let mut engine: BTreeMap<&'static str, u32> =
                Disposition::ALL.iter().map(|d| (d.as_str(), 0)).collect();
            let mut decisions: BTreeMap<&'static str, u32> = DecisionOutcome::ALL
                .iter()
                .map(|d| (d.as_str(), 0))
                .collect();
            let (mut decided, mut agreed, mut review_decided) = (0u32, 0u32, 0u32);
            for row in &rows {
                *engine.entry(row.engine.as_str()).or_default() += 1;
                let Some(d) = row.decision else { continue };
                *decisions.entry(d.as_str()).or_default() += 1;
                if d == DecisionOutcome::MoreInfo {
                    continue;
                }
                if row.engine == Disposition::Review {
                    review_decided += 1;
                } else {
                    decided += 1;
                    agreed += u32::from(agrees(row.engine, d));
                }
            }
            ClassStats {
                class_id: class_id.to_string(),
                class: rows[0].class.get(locale).to_string(),
                total: rows.len() as u32,
                engine,
                decisions,
                agreement_rate: (decided > 0)
                    .then(|| round(f64::from(agreed) / f64::from(decided), 4)),
                review_decided,
                threshold_total: THRESHOLD_TOTAL,
            }
        })
        .collect()
}

/// Nearest-rank percentile of hours.
fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (p * sorted.len() as f64).ceil().max(1.0) as usize;
    Some(round(sorted[rank.min(sorted.len()) - 1], 2))
}

/// `hours` from submission to the first physician decision.
pub fn turnaround(hours: &[f64]) -> Turnaround {
    let mut sorted: Vec<f64> = hours
        .iter()
        .copied()
        .filter(|h| h.is_finite() && *h >= 0.0)
        .collect();
    sorted.sort_by(f64::total_cmp);
    Turnaround {
        median_h: percentile(&sorted, 0.5),
        p90_h: percentile(&sorted, 0.9),
    }
}

/// Requests a pharmacist returned, out of those that reached a pharmacy.
pub fn returned_rate(returned: i64, reached_pharmacy: i64) -> Option<f64> {
    (reached_pharmacy > 0).then(|| round(returned as f64 / reached_pharmacy as f64, 4))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(class: &str, engine: Disposition, decision: Option<DecisionOutcome>) -> ItemRow {
        ItemRow {
            class_id: class.into(),
            class: LText::new("類別", "Class"),
            engine,
            decision,
        }
    }

    /// The whole agreement table.
    #[test]
    fn agreement_is_exactly_the_contract_definition() {
        use DecisionOutcome as O;
        for engine in Disposition::ALL {
            for decision in DecisionOutcome::ALL {
                let want = matches!(
                    (engine, decision),
                    (Disposition::Ready, O::Approve)
                        | (
                            Disposition::InPerson | Disposition::Urgent,
                            O::VisitRequired | O::Decline
                        )
                );
                assert_eq!(agrees(*engine, *decision), want, "{engine:?} {decision:?}");
            }
        }
    }

    #[test]
    fn classes_count_engine_results_decisions_and_agreement() {
        use DecisionOutcome as O;
        use Disposition as D;
        let rows = [
            row("ccb", D::Ready, Some(O::Approve)),
            row("ccb", D::Ready, Some(O::Decline)),
            row("ccb", D::InPerson, Some(O::VisitRequired)),
            row("ccb", D::Review, Some(O::Approve)),
            row("ccb", D::Ready, Some(O::MoreInfo)),
            row("ccb", D::Ready, None),
            row("arb", D::Ready, None),
        ];
        let stats = by_class(&rows, Locale::En);
        assert_eq!(stats.len(), 2);
        let ccb = stats.iter().find(|s| s.class_id == "ccb").expect("ccb");
        assert_eq!(ccb.total, 6);
        assert_eq!((ccb.engine["ready"], ccb.engine["urgent"]), (4, 0));
        assert_eq!(
            (ccb.decisions["approve"], ccb.decisions["more_info"]),
            (2, 1)
        );
        assert_eq!(
            ccb.agreement_rate,
            Some(0.6667),
            "2 of the 3 decided where the engine said ready or in_person"
        );
        assert_eq!(ccb.review_decided, 1);
        assert_eq!(ccb.threshold_total, 250);
        let arb = stats.iter().find(|s| s.class_id == "arb").expect("arb");
        assert_eq!(
            arb.agreement_rate, None,
            "no decision yet is not zero agreement"
        );
        assert!(by_class(&[], Locale::ZhTw).is_empty());
    }

    #[test]
    fn turnaround_uses_the_nearest_rank() {
        assert_eq!(
            turnaround(&[]),
            Turnaround {
                median_h: None,
                p90_h: None
            }
        );
        let t = turnaround(&[5.0, 1.0, 3.0, 2.0, 4.0, 6.0, 7.0, 8.0, 9.0, 10.0]);
        assert_eq!((t.median_h, t.p90_h), (Some(5.0), Some(9.0)));
        let t = turnaround(&[2.5, f64::NAN, -1.0]);
        assert_eq!((t.median_h, t.p90_h), (Some(2.5), Some(2.5)));
    }

    #[test]
    fn returned_rate_needs_a_denominator() {
        assert_eq!(returned_rate(0, 0), None);
        assert_eq!(returned_rate(1, 8), Some(0.125));
    }
}
