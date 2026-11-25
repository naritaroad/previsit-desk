//! The request state machine: which step leads where, and which actions the signed-in person has right now.
//! Pure and total. The HTTP layer asks [`can`] before doing anything and [`next`] for the new status, so nothing else
//! decides transitions.
//!
//! Renewal: `draft → submitted → in_review ⇄ more_info → approved | partially_approved | declined | visit_required`,
//! then `approved → at_pharmacy → ready → dispensed`. Refill: `draft → submitted → at_pharmacy → ready → dispensed`.
//! A pharmacist may return a request or ask the physician; an unfinished request can be cancelled by its owner.

use std::collections::BTreeMap;

use serde::Deserialize;

use super::texts::{R, rt};
use super::{DecisionOutcome, Disposition, RxKind, RxStatus, wire_enum};
use crate::refill::FieldErrors;
use crate::types::Locale;

wire_enum!(
    /// What a person can do. The names are the contract's `allowed_actions`.
    Action {
        Edit => "edit",
        Evaluate => "evaluate",
        Submit => "submit",
        Reply => "reply",
        Cancel => "cancel",
        Message => "message",
        StaffMessage => "staff_message",
        Assign => "assign",
        Decide => "decide",
        Accept => "accept",
        MarkReady => "ready",
        Dispense => "dispense",
        Return => "return",
        AskPhysician => "ask_physician",
    }
);

/// What happened to the request. One action may cause several steps (a decision sends approved items on).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Step {
    Submit,
    /// Submitted with an urgent answer: straight to the physician, never the ordinary queue.
    SubmitUrgent,
    StartReview,
    Approve,
    PartiallyApprove,
    Decline,
    RequireVisit,
    AskMore,
    Reply,
    SendToPharmacy,
    Accept,
    MarkReady,
    Dispense,
    Return,
    AskPhysician,
    Cancel,
}

impl Step {
    pub const ALL: &'static [Step] = &[
        Step::Submit,
        Step::SubmitUrgent,
        Step::StartReview,
        Step::Approve,
        Step::PartiallyApprove,
        Step::Decline,
        Step::RequireVisit,
        Step::AskMore,
        Step::Reply,
        Step::SendToPharmacy,
        Step::Accept,
        Step::MarkReady,
        Step::Dispense,
        Step::Return,
        Step::AskPhysician,
        Step::Cancel,
    ];

    /// The action that may cause this step; `None` when it only follows another step.
    pub fn action(self) -> Option<Action> {
        match self {
            Step::Submit | Step::SubmitUrgent => Some(Action::Submit),
            // Opening a decision or assigning a physician starts the review.
            Step::StartReview => None,
            Step::Approve
            | Step::PartiallyApprove
            | Step::Decline
            | Step::RequireVisit
            | Step::AskMore => Some(Action::Decide),
            Step::SendToPharmacy => None,
            Step::Reply => Some(Action::Reply),
            Step::Accept => Some(Action::Accept),
            Step::MarkReady => Some(Action::MarkReady),
            Step::Dispense => Some(Action::Dispense),
            Step::Return => Some(Action::Return),
            Step::AskPhysician => Some(Action::AskPhysician),
            Step::Cancel => Some(Action::Cancel),
        }
    }
}

impl RxStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            RxStatus::Declined
                | RxStatus::VisitRequired
                | RxStatus::Dispensed
                | RxStatus::Cancelled
        )
    }

    /// Still being worked on (a draft counts: it blocks a second request for the same medicine).
    pub fn is_open(self) -> bool {
        !self.is_terminal()
    }

    /// The physician's clock runs in these states.
    pub fn waits_for_physician(self) -> bool {
        matches!(self, RxStatus::Submitted | RxStatus::InReview)
    }

    pub fn patient_can_edit(self) -> bool {
        matches!(self, RxStatus::Draft | RxStatus::MoreInfo)
    }
}

/// The status after `step`, or `None` when the step is not possible from `from`.
pub fn next(kind: RxKind, from: RxStatus, step: Step) -> Option<RxStatus> {
    use RxStatus as S;
    let renewal = kind == RxKind::Renewal;
    match (from, step) {
        (S::Draft, Step::Submit) => Some(S::Submitted),
        (S::Draft, Step::SubmitUrgent) if renewal => Some(S::InReview),

        // The physician's part. A returned renewal goes back to the physician; a refill only after the pharmacist asks.
        (S::Submitted | S::Returned, Step::StartReview) if renewal => Some(S::InReview),
        (S::InReview, Step::Approve) => Some(S::Approved),
        (S::InReview, Step::PartiallyApprove) if renewal => Some(S::PartiallyApproved),
        (S::InReview, Step::Decline) => Some(S::Declined),
        (S::InReview, Step::RequireVisit) => Some(S::VisitRequired),
        (S::InReview, Step::AskMore) => Some(S::MoreInfo),
        (S::MoreInfo, Step::Reply) => Some(S::InReview),
        (S::Approved | S::PartiallyApproved, Step::SendToPharmacy) => Some(S::AtPharmacy),

        // The pharmacist's part.
        (S::Submitted | S::Returned, Step::Accept) if !renewal => Some(S::AtPharmacy),
        (S::AtPharmacy, Step::MarkReady) => Some(S::Ready),
        (S::Ready, Step::Dispense) => Some(S::Dispensed),
        (S::AtPharmacy | S::Ready, Step::Return) => Some(S::Returned),
        (S::Submitted, Step::Return) if !renewal => Some(S::Returned),
        (S::AtPharmacy | S::Ready, Step::AskPhysician) => Some(S::InReview),
        (S::Submitted | S::Returned, Step::AskPhysician) if !renewal => Some(S::InReview),

        (from, Step::Cancel) if from.is_open() => Some(S::Cancelled),
        _ => None,
    }
}

/// Who is looking, reduced to what the machine needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Viewer {
    /// The patient whose request this is, holding `rx.own`.
    pub owner: bool,
    /// `rx.read`
    pub read: bool,
    /// `rx.decide`
    pub decide: bool,
    /// `rx.dispense`
    pub dispense: bool,
}

/// Staff never see drafts; patients only see their own.
pub fn can_see(status: RxStatus, viewer: Viewer) -> bool {
    viewer.owner || (viewer.read && status != RxStatus::Draft)
}

pub fn can(kind: RxKind, status: RxStatus, viewer: Viewer, action: Action) -> bool {
    use RxStatus as S;
    if !can_see(status, viewer) {
        return false;
    }
    let staff = viewer.read && !viewer.owner;
    let step = |s: Step| next(kind, status, s).is_some();
    match action {
        Action::Edit | Action::Evaluate => viewer.owner && status.patient_can_edit(),
        Action::Submit => viewer.owner && step(Step::Submit),
        Action::Reply => viewer.owner && step(Step::Reply),
        Action::Cancel => viewer.owner && step(Step::Cancel),
        Action::Message => (viewer.owner || staff) && !matches!(status, S::Draft | S::Cancelled),
        Action::StaffMessage => staff,
        Action::Assign => staff && status.is_open(),
        // Deciding from `submitted` (or a returned renewal) starts the review first.
        Action::Decide => {
            staff && viewer.decide && (status == S::InReview || step(Step::StartReview))
        }
        Action::Accept => staff && viewer.dispense && step(Step::Accept),
        Action::MarkReady => staff && viewer.dispense && step(Step::MarkReady),
        Action::Dispense => staff && viewer.dispense && step(Step::Dispense),
        Action::Return => staff && viewer.dispense && step(Step::Return),
        Action::AskPhysician => staff && viewer.dispense && step(Step::AskPhysician),
    }
}

/// Contract §4 `allowed_actions`, in a fixed order.
pub fn allowed_actions(kind: RxKind, status: RxStatus, viewer: Viewer) -> Vec<&'static str> {
    Action::ALL
        .iter()
        .filter(|a| can(kind, status, viewer, **a))
        .map(|a| a.as_str())
        .collect()
}

// ---------------------------------------------------------------------------
// A physician's decision
// ---------------------------------------------------------------------------

/// One item of the request as the physician sees it.
#[derive(Debug, Clone)]
pub struct DecidableItem {
    pub item_id: String,
    pub engine: Option<Disposition>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemDecision {
    pub item_id: String,
    pub outcome: DecisionOutcome,
    #[serde(default)]
    pub note: Option<String>,
}

fn written(text: &Option<String>) -> bool {
    text.as_deref().is_some_and(|s| !s.trim().is_empty())
}

/// Checks a decision and says which step it is. Every item needs exactly one outcome; anything but an approval needs a
/// reason the patient can read; approving against an in-person or urgent engine result needs the physician's reason;
/// nothing is approved without a pharmacy to send it to. There is no way to change a drug or a dose here.
pub fn check_decision(
    items: &[DecidableItem],
    decisions: &[ItemDecision],
    patient_message: &Option<String>,
    has_pharmacy: bool,
    locale: Locale,
) -> Result<Step, FieldErrors> {
    let mut errors = FieldErrors::new();
    let mut by_item: BTreeMap<&str, &ItemDecision> = BTreeMap::new();
    for d in decisions {
        if !items.iter().any(|i| i.item_id == d.item_id) || by_item.insert(&d.item_id, d).is_some()
        {
            errors.insert(
                d.item_id.clone(),
                rt(R::ErrDecisionUnknownItem, locale).to_string(),
            );
        }
    }
    for item in items {
        let Some(d) = by_item.get(item.item_id.as_str()) else {
            errors.insert(
                item.item_id.clone(),
                rt(R::ErrDecisionMissing, locale).to_string(),
            );
            continue;
        };
        let complaint = match d.outcome {
            DecisionOutcome::Approve if !has_pharmacy => Some(R::ErrNoPharmacy),
            DecisionOutcome::Approve
                if matches!(
                    item.engine,
                    Some(Disposition::InPerson | Disposition::Urgent)
                ) && !written(&d.note) =>
            {
                Some(R::ErrOverrideNote)
            }
            // The question must sit on the item it is about; a reason may be shared in the message to the patient.
            DecisionOutcome::MoreInfo if !written(&d.note) => Some(R::ErrDecisionNote),
            DecisionOutcome::Decline | DecisionOutcome::VisitRequired
                if !written(&d.note) && !written(patient_message) =>
            {
                Some(R::ErrDecisionNote)
            }
            _ => None,
        };
        if let Some(key) = complaint {
            errors.insert(item.item_id.clone(), rt(key, locale).to_string());
        }
    }
    if !errors.is_empty() || items.is_empty() {
        if errors.is_empty() {
            errors.insert(
                "items".into(),
                rt(R::ErrDecisionMissing, locale).to_string(),
            );
        }
        return Err(errors);
    }
    Ok(resolve(decisions.iter().map(|d| d.outcome)))
}

/// Any open question keeps the request open; otherwise anything approved goes on; otherwise a visit beats a refusal.
fn resolve(outcomes: impl Iterator<Item = DecisionOutcome>) -> Step {
    let all: Vec<DecisionOutcome> = outcomes.collect();
    let count = |o| all.iter().filter(|x| **x == o).count();
    if count(DecisionOutcome::MoreInfo) > 0 {
        Step::AskMore
    } else if count(DecisionOutcome::Approve) == all.len() {
        Step::Approve
    } else if count(DecisionOutcome::Approve) > 0 {
        Step::PartiallyApprove
    } else if count(DecisionOutcome::VisitRequired) > 0 {
        Step::RequireVisit
    } else {
        Step::Decline
    }
}

// ---------------------------------------------------------------------------
// Handing over the medicine
// ---------------------------------------------------------------------------

/// The four checks a pharmacist confirms before handing over. A missing one counts as not done.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(default)]
pub struct DispenseChecks {
    pub identity: bool,
    pub allergy: bool,
    pub interaction: bool,
    pub quantity: bool,
}

impl DispenseChecks {
    pub fn complete(self) -> bool {
        self.identity && self.allergy && self.interaction && self.quantity
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeSet, HashSet};

    const PATIENT: Viewer = Viewer {
        owner: true,
        read: false,
        decide: false,
        dispense: false,
    };
    const PHYSICIAN: Viewer = Viewer {
        owner: false,
        read: true,
        decide: true,
        dispense: false,
    };
    const COORDINATOR: Viewer = Viewer {
        owner: false,
        read: true,
        decide: false,
        dispense: false,
    };
    const PHARMACIST: Viewer = Viewer {
        owner: false,
        read: true,
        decide: false,
        dispense: true,
    };
    /// Another patient, or an administrator (no rx permission).
    const STRANGER: Viewer = Viewer {
        owner: false,
        read: false,
        decide: false,
        dispense: false,
    };

    fn kinds() -> [RxKind; 2] {
        [RxKind::Renewal, RxKind::Refill]
    }

    /// The whole table, written out by hand. Anything not here must be impossible.
    fn expected() -> HashSet<(RxKind, RxStatus, Step, RxStatus)> {
        use RxKind::*;
        use RxStatus::*;
        use Step as T;
        let mut t = HashSet::from([
            (Renewal, Draft, T::Submit, Submitted),
            (Renewal, Draft, T::SubmitUrgent, InReview),
            (Renewal, Submitted, T::StartReview, InReview),
            (Renewal, Returned, T::StartReview, InReview),
            (Renewal, InReview, T::Approve, Approved),
            (Renewal, InReview, T::PartiallyApprove, PartiallyApproved),
            (Renewal, InReview, T::Decline, Declined),
            (Renewal, InReview, T::RequireVisit, VisitRequired),
            (Renewal, InReview, T::AskMore, MoreInfo),
            (Renewal, MoreInfo, T::Reply, InReview),
            (Renewal, Approved, T::SendToPharmacy, AtPharmacy),
            (Renewal, PartiallyApproved, T::SendToPharmacy, AtPharmacy),
            (Renewal, AtPharmacy, T::MarkReady, Ready),
            (Renewal, AtPharmacy, T::Return, Returned),
            (Renewal, AtPharmacy, T::AskPhysician, InReview),
            (Renewal, Ready, T::Dispense, Dispensed),
            (Renewal, Ready, T::Return, Returned),
            (Renewal, Ready, T::AskPhysician, InReview),
            (Refill, Draft, T::Submit, Submitted),
            (Refill, Submitted, T::Accept, AtPharmacy),
            (Refill, Submitted, T::Return, Returned),
            (Refill, Submitted, T::AskPhysician, InReview),
            (Refill, Returned, T::Accept, AtPharmacy),
            (Refill, Returned, T::AskPhysician, InReview),
            (Refill, InReview, T::Approve, Approved),
            (Refill, InReview, T::Decline, Declined),
            (Refill, InReview, T::RequireVisit, VisitRequired),
            (Refill, InReview, T::AskMore, MoreInfo),
            (Refill, MoreInfo, T::Reply, InReview),
            (Refill, Approved, T::SendToPharmacy, AtPharmacy),
            // `partially_approved` is never reached by a refill, but leaving it must still be defined.
            (Refill, PartiallyApproved, T::SendToPharmacy, AtPharmacy),
            (Refill, AtPharmacy, T::MarkReady, Ready),
            (Refill, AtPharmacy, T::Return, Returned),
            (Refill, AtPharmacy, T::AskPhysician, InReview),
            (Refill, Ready, T::Dispense, Dispensed),
            (Refill, Ready, T::Return, Returned),
            (Refill, Ready, T::AskPhysician, InReview),
        ]);
        for kind in kinds() {
            for from in [
                Draft,
                Submitted,
                InReview,
                MoreInfo,
                Approved,
                PartiallyApproved,
                AtPharmacy,
                Returned,
                Ready,
            ] {
                t.insert((kind, from, T::Cancel, Cancelled));
            }
        }
        t
    }

    /// Every (kind, status, step) combination: 2 x 13 x 16 = 416.
    #[test]
    fn the_transition_table_is_exactly_the_written_one() {
        let expected = expected();
        let mut seen = 0;
        for kind in kinds() {
            for from in RxStatus::ALL {
                for step in Step::ALL {
                    seen += 1;
                    let got = next(kind, *from, *step);
                    let want = expected
                        .iter()
                        .find(|(k, f, s, _)| *k == kind && f == from && s == step)
                        .map(|(_, _, _, to)| *to);
                    assert_eq!(got, want, "{kind:?} {from:?} {step:?}");
                }
            }
        }
        assert_eq!(seen, 416);
    }

    #[test]
    fn terminal_states_have_no_way_out() {
        for kind in kinds() {
            for status in RxStatus::ALL.iter().filter(|s| s.is_terminal()) {
                assert!(Step::ALL.iter().all(|s| next(kind, *status, *s).is_none()));
                assert!(
                    !allowed_actions(kind, *status, PATIENT).contains(&"cancel"),
                    "{status:?}"
                );
            }
        }
    }

    /// Follows every path that avoids the given steps and collects the statuses reached.
    fn reachable(kind: RxKind, without: &[Step]) -> BTreeSet<RxStatus> {
        let mut seen = BTreeSet::from([RxStatus::Draft]);
        let mut todo = vec![RxStatus::Draft];
        while let Some(from) = todo.pop() {
            for step in Step::ALL.iter().filter(|s| !without.contains(s)) {
                if let Some(to) = next(kind, from, *step)
                    && seen.insert(to)
                {
                    todo.push(to);
                }
            }
        }
        seen
    }

    #[test]
    fn no_renewal_reaches_a_pharmacy_without_a_physician_approving() {
        let seen = reachable(RxKind::Renewal, &[Step::Approve, Step::PartiallyApprove]);
        for status in [
            RxStatus::Approved,
            RxStatus::PartiallyApproved,
            RxStatus::AtPharmacy,
            RxStatus::Ready,
            RxStatus::Dispensed,
        ] {
            assert!(!seen.contains(&status), "{status:?} without an approval");
        }
    }

    #[test]
    fn nothing_is_dispensed_without_the_pharmacist() {
        for kind in kinds() {
            for step in [Step::MarkReady, Step::Dispense] {
                assert!(!reachable(kind, &[step]).contains(&RxStatus::Dispensed));
            }
        }
        assert!(
            !reachable(RxKind::Refill, &[Step::Accept, Step::Approve])
                .contains(&RxStatus::AtPharmacy)
        );
    }

    #[test]
    fn every_status_is_reachable_for_a_renewal() {
        assert_eq!(
            reachable(RxKind::Renewal, &[]).len(),
            RxStatus::ALL.len(),
            "no dead status"
        );
        assert!(
            !reachable(RxKind::Refill, &[]).contains(&RxStatus::PartiallyApproved),
            "one item cannot be partly approved"
        );
    }

    /// Every (kind, status, viewer, action): only people with the permission, only when a step exists.
    #[test]
    fn actions_follow_permissions_and_status() {
        for kind in kinds() {
            for status in RxStatus::ALL {
                for viewer in [PATIENT, PHYSICIAN, COORDINATOR, PHARMACIST, STRANGER] {
                    for action in Action::ALL {
                        let ok = can(kind, *status, viewer, *action);
                        if !ok {
                            continue;
                        }
                        let who = format!("{kind:?} {status:?} {viewer:?} {action:?}");
                        assert!(can_see(*status, viewer), "{who}");
                        match action {
                            Action::Edit
                            | Action::Evaluate
                            | Action::Submit
                            | Action::Reply
                            | Action::Cancel => assert!(viewer.owner, "{who}"),
                            Action::Decide => assert!(viewer.decide && !viewer.owner, "{who}"),
                            Action::Accept
                            | Action::MarkReady
                            | Action::Dispense
                            | Action::Return
                            | Action::AskPhysician => {
                                assert!(viewer.dispense && !viewer.owner, "{who}")
                            }
                            Action::Assign | Action::StaffMessage => {
                                assert!(viewer.read && !viewer.owner, "{who}")
                            }
                            Action::Message => assert!(viewer.read || viewer.owner, "{who}"),
                        }
                        if matches!(
                            action,
                            Action::Submit
                                | Action::Reply
                                | Action::Cancel
                                | Action::Accept
                                | Action::MarkReady
                                | Action::Dispense
                                | Action::Return
                                | Action::AskPhysician
                        ) {
                            assert!(
                                Step::ALL.iter().any(|s| s.action() == Some(*action)
                                    && next(kind, *status, *s).is_some()),
                                "{who}: an action without a step"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn strangers_see_and_do_nothing_and_staff_never_see_drafts() {
        for kind in kinds() {
            for status in RxStatus::ALL {
                assert!(allowed_actions(kind, *status, STRANGER).is_empty());
            }
            for viewer in [PHYSICIAN, COORDINATOR, PHARMACIST] {
                assert!(!can_see(RxStatus::Draft, viewer));
                assert!(allowed_actions(kind, RxStatus::Draft, viewer).is_empty());
            }
        }
    }

    #[test]
    fn a_physician_who_is_also_the_patient_cannot_decide_their_own_request() {
        let own = Viewer {
            owner: true,
            ..PHYSICIAN
        };
        assert!(!can(
            RxKind::Renewal,
            RxStatus::InReview,
            own,
            Action::Decide
        ));
        let own = Viewer {
            owner: true,
            ..PHARMACIST
        };
        assert!(!can(RxKind::Refill, RxStatus::Ready, own, Action::Dispense));
    }

    #[test]
    fn the_listed_actions_are_the_expected_ones() {
        let a = |k, s, v| allowed_actions(k, s, v);
        assert_eq!(
            a(RxKind::Renewal, RxStatus::Draft, PATIENT),
            ["edit", "evaluate", "submit", "cancel"]
        );
        assert_eq!(
            a(RxKind::Renewal, RxStatus::MoreInfo, PATIENT),
            ["edit", "evaluate", "reply", "cancel", "message"]
        );
        assert_eq!(
            a(RxKind::Renewal, RxStatus::Submitted, PHYSICIAN),
            ["message", "staff_message", "assign", "decide"]
        );
        assert_eq!(
            a(RxKind::Renewal, RxStatus::InReview, COORDINATOR),
            ["message", "staff_message", "assign"]
        );
        assert_eq!(
            a(RxKind::Renewal, RxStatus::AtPharmacy, PHARMACIST),
            [
                "message",
                "staff_message",
                "assign",
                "ready",
                "return",
                "ask_physician"
            ]
        );
        assert_eq!(
            a(RxKind::Refill, RxStatus::Submitted, PHARMACIST),
            [
                "message",
                "staff_message",
                "assign",
                "accept",
                "return",
                "ask_physician"
            ]
        );
        assert_eq!(
            a(RxKind::Refill, RxStatus::Submitted, PHYSICIAN),
            ["message", "staff_message", "assign"],
            "a refill reaches the physician only when the pharmacist asks"
        );
        assert_eq!(a(RxKind::Refill, RxStatus::Dispensed, PATIENT), ["message"]);
        assert!(a(RxKind::Refill, RxStatus::Cancelled, PATIENT).is_empty());
    }

    fn items(list: &[(&str, Disposition)]) -> Vec<DecidableItem> {
        list.iter()
            .map(|(id, d)| DecidableItem {
                item_id: id.to_string(),
                engine: Some(*d),
            })
            .collect()
    }

    fn decide(id: &str, outcome: DecisionOutcome, note: &str) -> ItemDecision {
        ItemDecision {
            item_id: id.into(),
            outcome,
            note: (!note.is_empty()).then(|| note.to_string()),
        }
    }

    #[test]
    fn decisions_resolve_to_one_step() {
        use DecisionOutcome::*;
        let two = items(&[("a", Disposition::Ready), ("b", Disposition::Ready)]);
        let step = |x, y| {
            check_decision(
                &two,
                &[decide("a", x, "原因"), decide("b", y, "原因")],
                &None,
                true,
                Locale::ZhTw,
            )
            .expect("valid")
        };
        assert_eq!(step(Approve, Approve), Step::Approve);
        assert_eq!(step(Approve, Decline), Step::PartiallyApprove);
        assert_eq!(step(Approve, VisitRequired), Step::PartiallyApprove);
        assert_eq!(step(Decline, VisitRequired), Step::RequireVisit);
        assert_eq!(step(Decline, Decline), Step::Decline);
        assert_eq!(step(Approve, MoreInfo), Step::AskMore);
        assert_eq!(step(MoreInfo, Decline), Step::AskMore);
    }

    #[test]
    fn a_decision_must_cover_every_item_exactly_once() {
        use DecisionOutcome::Approve;
        let two = items(&[("a", Disposition::Ready), ("b", Disposition::Ready)]);
        let check = |d: &[ItemDecision]| check_decision(&two, d, &None, true, Locale::ZhTw);
        assert!(
            check(&[decide("a", Approve, "")])
                .expect_err("b")
                .contains_key("b")
        );
        assert!(
            check(&[
                decide("a", Approve, ""),
                decide("b", Approve, ""),
                decide("c", Approve, "")
            ])
            .expect_err("c")
            .contains_key("c")
        );
        assert!(
            check(&[
                decide("a", Approve, ""),
                decide("a", Approve, ""),
                decide("b", Approve, "")
            ])
            .is_err(),
            "twice"
        );
        assert!(check_decision(&[], &[], &None, true, Locale::ZhTw).is_err());
    }

    #[test]
    fn reasons_are_required_where_they_matter() {
        use DecisionOutcome::*;
        let check = |engine, outcome, note: &str, message: Option<&str>, pharmacy| {
            check_decision(
                &items(&[("a", engine)]),
                &[decide("a", outcome, note)],
                &message.map(str::to_string),
                pharmacy,
                Locale::ZhTw,
            )
        };
        assert!(check(Disposition::Ready, Approve, "", None, true).is_ok());
        assert!(
            check(Disposition::Ready, Approve, "", None, false).is_err(),
            "no pharmacy"
        );
        assert!(check(Disposition::InPerson, Approve, "", None, true).is_err());
        assert!(check(Disposition::Urgent, Approve, " ", None, true).is_err());
        assert!(check(Disposition::InPerson, Approve, "已電話確認", None, true).is_ok());
        for outcome in [Decline, VisitRequired] {
            assert!(check(Disposition::Ready, outcome, "", None, true).is_err());
            assert!(
                check(Disposition::Ready, outcome, "", Some("請回診"), false).is_ok(),
                "the message to the patient is a reason"
            );
        }
        assert!(
            check(Disposition::Ready, MoreInfo, "", Some("請補充"), true).is_err(),
            "the question belongs on the item"
        );
        assert!(check(Disposition::Ready, MoreInfo, "最近血壓多少？", None, false).is_ok());
    }

    /// The payload type has no place for a drug or a dose, and an extra field is refused rather than ignored.
    #[test]
    fn a_decision_cannot_carry_a_dose_or_a_drug() {
        let ok = serde_json::json!({"item_id": "a", "outcome": "approve", "note": "x"});
        assert!(serde_json::from_value::<ItemDecision>(ok).is_ok());
        for extra in ["dose_text", "drug_id", "days_per_fill"] {
            let mut v = serde_json::json!({"item_id": "a", "outcome": "approve"});
            v[extra] = serde_json::json!("x");
            assert!(
                serde_json::from_value::<ItemDecision>(v).is_err(),
                "{extra}"
            );
        }
        assert!(
            serde_json::from_value::<ItemDecision>(
                serde_json::json!({"item_id": "a", "outcome": "increase"})
            )
            .is_err()
        );
    }

    #[test]
    fn all_four_checks_are_needed() {
        for bits in 0..16u8 {
            let c = DispenseChecks {
                identity: bits & 1 != 0,
                allergy: bits & 2 != 0,
                interaction: bits & 4 != 0,
                quantity: bits & 8 != 0,
            };
            assert_eq!(c.complete(), bits == 15);
        }
        let partial: DispenseChecks = serde_json::from_str(r#"{"identity": true}"#).expect("json");
        assert!(!partial.complete());
    }

    /// `cargo test rx::machine::tests::print_table -- --nocapture` prints the tables for the report.
    #[test]
    fn print_table() {
        for kind in kinds() {
            println!("== {}", kind.as_str());
            for from in RxStatus::ALL {
                let steps: Vec<String> = Step::ALL
                    .iter()
                    .filter_map(|s| {
                        next(kind, *from, *s).map(|to| format!("{s:?}->{}", to.as_str()))
                    })
                    .collect();
                println!("{:<19} {}", from.as_str(), steps.join(", "));
            }
            for (name, viewer) in [
                ("patient", PATIENT),
                ("physician", PHYSICIAN),
                ("coordinator", COORDINATOR),
                ("pharmacist", PHARMACIST),
            ] {
                println!("-- {name}");
                for status in RxStatus::ALL {
                    let list = allowed_actions(kind, *status, viewer);
                    if !list.is_empty() {
                        println!("   {:<19} {}", status.as_str(), list.join(", "));
                    }
                }
            }
        }
    }
}
