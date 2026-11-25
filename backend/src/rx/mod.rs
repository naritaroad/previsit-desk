//! Prescription renewal and refill requests (docs/v2/contract.md §4, docs/v2/product.md §5).
//!
//! The protocol engine sorts a request and shows why; it never approves anything, and it never writes a dose or
//! suggests another drug. A physician decides every renewal item, a pharmacist dispenses. Refill dates come from
//! [`crate::refill`] and nothing here repeats those numbers.
//!
//! Pure modules: [`formulary`], [`protocol`], [`engine`], [`machine`], [`medications`], [`metrics`], [`texts`].

pub mod engine;
pub mod formulary;
pub mod machine;
pub mod medications;
pub mod metrics;
pub mod protocol;
pub mod texts;

use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::types::Locale;

pub use formulary::Formulary;
pub use protocol::Protocols;

pub const FORMULARY_FILE: &str = "formulary.csv";
pub const PROTOCOL_FILE: &str = "renewal_protocols.json";

/// A string enum with fixed wire names (same shape as the ones in `crate::types`).
macro_rules! wire_enum {
    ($(#[$meta:meta])* $name:ident { $($var:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize)]
        pub enum $name {
            $(#[serde(rename = $text)] $var),+
        }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$var),+];

            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$var => $text),+
                }
            }

            pub fn parse(value: &str) -> Option<Self> {
                match value {
                    $($text => Some($name::$var),)+
                    _ => None,
                }
            }
        }

        impl TryFrom<String> for $name {
            type Error = String;

            fn try_from(value: String) -> Result<Self, String> {
                Self::parse(&value).ok_or_else(|| format!("unknown {} value {value}", stringify!($name)))
            }
        }
    };
}
pub(crate) use wire_enum;

wire_enum!(RxKind { Refill => "refill", Renewal => "renewal" });
wire_enum!(RxStatus {
    Draft => "draft",
    Submitted => "submitted",
    InReview => "in_review",
    MoreInfo => "more_info",
    Approved => "approved",
    PartiallyApproved => "partially_approved",
    Declined => "declined",
    VisitRequired => "visit_required",
    AtPharmacy => "at_pharmacy",
    Returned => "returned",
    Ready => "ready",
    Dispensed => "dispensed",
    Cancelled => "cancelled",
});
// Declaration order is severity order: the engine takes the maximum of everything that fired.
wire_enum!(Disposition {
    Ready => "ready",
    Review => "review",
    InPerson => "in_person",
    Urgent => "urgent",
    Excluded => "excluded",
});
wire_enum!(RenewalScope { InScope => "in_scope", PhysicianOnly => "physician_only", Excluded => "excluded" });
wire_enum!(DecisionOutcome {
    Approve => "approve",
    Decline => "decline",
    VisitRequired => "visit_required",
    MoreInfo => "more_info",
});
wire_enum!(PickupSlot { Morning => "morning", Afternoon => "afternoon", Evening => "evening" });

/// The same sentence in both languages. Stored results keep both, so a viewer always reads their own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LText {
    pub zh: String,
    pub en: String,
}

impl LText {
    pub fn new(zh: impl Into<String>, en: impl Into<String>) -> Self {
        Self {
            zh: zh.into(),
            en: en.into(),
        }
    }

    pub fn get(&self, locale: Locale) -> &str {
        if locale.is_en() { &self.en } else { &self.zh }
    }
}

/// The drug list and the question protocols, checked against each other. Loaded once; bad data refuses to start.
#[derive(Debug, Clone)]
pub struct RxRules {
    pub formulary: Formulary,
    pub protocols: Protocols,
}

impl RxRules {
    pub fn load(data_dir: &Path) -> Result<Self> {
        let seed = data_dir.join("seed");
        Self::build(
            Formulary::load(&seed.join(FORMULARY_FILE))?,
            Protocols::load(&seed.join(PROTOCOL_FILE))?,
        )
    }

    pub fn build(formulary: Formulary, protocols: Protocols) -> Result<Self> {
        for drug in formulary.drugs() {
            if drug.renewal_scope == RenewalScope::InScope
                && protocols.class(&drug.class_id).is_none()
            {
                bail!(
                    "{FORMULARY_FILE}: {} is in_scope but class {} has no protocol in {PROTOCOL_FILE}",
                    drug.drug_id,
                    drug.class_id
                );
            }
        }
        for class in &protocols.classes {
            if !formulary
                .drugs()
                .iter()
                .any(|d| d.class_id == class.class_id)
            {
                bail!(
                    "{PROTOCOL_FILE}: class {} has no drug in {FORMULARY_FILE}",
                    class.class_id
                );
            }
        }
        Ok(Self {
            formulary,
            protocols,
        })
    }

    /// Lines for the `check-data` command.
    pub fn report(&self) -> Vec<String> {
        let count = |scope| self.formulary.count(scope);
        vec![
            format!(
                "{FORMULARY_FILE}     {} drugs ({} in scope, {} physician only, {} excluded)",
                self.formulary.drugs().len(),
                count(RenewalScope::InScope),
                count(RenewalScope::PhysicianOnly),
                count(RenewalScope::Excluded)
            ),
            format!(
                "{PROTOCOL_FILE}  version {}, {} general questions, {} classes, {} rules",
                self.protocols.version,
                self.protocols.general.questions.len(),
                self.protocols.classes.len(),
                self.protocols.rule_count()
            ),
        ]
    }
}

/// `check-data` hook: loads and validates both files.
pub fn check_data(data_dir: &Path) -> Result<Vec<String>> {
    Ok(RxRules::load(data_dir).context("rx data")?.report())
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use crate::precheck::RedFlagRules;
    use crate::refill::RefillRules;

    pub const FORMULARY: &str = include_str!("fixtures/formulary.csv");
    pub const PROTOCOLS: &str = include_str!("fixtures/renewal_protocols.json");

    pub fn rules() -> RxRules {
        RxRules::build(
            Formulary::parse(FORMULARY).expect("fixture formulary"),
            Protocols::parse(PROTOCOLS).expect("fixture protocols"),
        )
        .expect("fixture rules")
    }

    pub fn data_dir() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../data")
    }

    pub fn red_flags() -> RedFlagRules {
        RedFlagRules::load(&data_dir().join("seed/red_flags.csv")).expect("red_flags.csv")
    }

    pub fn refill_rules() -> RefillRules {
        RefillRules::load(&data_dir().join("seed/refill_rules.csv")).expect("refill_rules.csv")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_round_trip() {
        for s in RxStatus::ALL {
            assert_eq!(RxStatus::parse(s.as_str()), Some(*s));
            assert_eq!(
                serde_json::to_value(s).expect("json"),
                serde_json::json!(s.as_str())
            );
        }
        assert_eq!(RxStatus::ALL.len(), 13);
        assert!(RxStatus::try_from("nope".to_string()).is_err());
    }

    #[test]
    fn dispositions_order_by_severity() {
        use Disposition::*;
        assert!(Ready < Review && Review < InPerson && InPerson < Urgent);
    }

    #[test]
    fn an_in_scope_drug_without_a_protocol_refuses_to_load() {
        let mut protocols = Protocols::parse(fixtures::PROTOCOLS).expect("fixture");
        protocols.classes.retain(|c| c.class_id != "statin");
        let err = RxRules::build(
            Formulary::parse(fixtures::FORMULARY).expect("fixture"),
            protocols,
        )
        .expect_err("must refuse");
        assert!(err.to_string().contains("statin"), "{err}");
    }

    #[test]
    fn a_protocol_class_without_a_drug_refuses_to_load() {
        let mut protocols = Protocols::parse(fixtures::PROTOCOLS).expect("fixture");
        let mut extra = protocols.classes[0].clone();
        extra.class_id = "typo_class".into();
        protocols.classes.push(extra);
        assert!(
            RxRules::build(
                Formulary::parse(fixtures::FORMULARY).expect("fixture"),
                protocols
            )
            .is_err()
        );
    }

    #[test]
    fn report_counts_the_files() {
        let lines = fixtures::rules().report();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("in scope") && lines[1].contains("version"));
    }

    /// The shipped files, when they are in the tree (they are written by another workstream).
    #[test]
    fn the_shipped_data_is_valid_when_present() {
        let dir = fixtures::data_dir();
        if dir.join("seed").join(FORMULARY_FILE).is_file()
            && dir.join("seed").join(PROTOCOL_FILE).is_file()
        {
            for line in check_data(&dir).expect("shipped rx data") {
                println!("{line}");
            }
        }
    }
}
