//! Roles, permissions and the one table that joins them (docs/v2/contract.md §1). Handlers name the permission
//! they need; nothing else in the code asks "is this a physician".

use crate::texts::{T, t};
use crate::types::Locale;

macro_rules! named_enum {
    ($(#[$meta:meta])* $name:ident { $($var:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
        pub enum $name {
            $(#[serde(rename = $text)] $var),+
        }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$var),+];

            #[allow(dead_code)]
            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$var => $text),+
                }
            }

            #[allow(dead_code)]
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

named_enum!(Role {
    Patient => "patient",
    Physician => "physician",
    Pharmacist => "pharmacist",
    Coordinator => "coordinator",
    Admin => "admin",
});

named_enum!(Permission {
    VisitOwn => "visit.own",
    RxOwn => "rx.own",
    ProfileOwn => "profile.own",
    ApptOwn => "appt.own",
    VisitRead => "visit.read",
    VisitReview => "visit.review",
    NoteSign => "note.sign",
    ThreadReply => "thread.reply",
    TicketHandle => "ticket.handle",
    PatientRead => "patient.read",
    PatientManage => "patient.manage",
    ApptManage => "appt.manage",
    RxRead => "rx.read",
    RxDecide => "rx.decide",
    RxDispense => "rx.dispense",
    AccountManage => "account.manage",
    SettingsManage => "settings.manage",
    AuditRead => "audit.read",
    OversightRead => "oversight.read",
    RulesRead => "rules.read",
    DemoReset => "demo.reset",
});

impl Role {
    pub fn permissions(self) -> &'static [Permission] {
        use Permission::*;
        match self {
            Role::Patient => &[VisitOwn, RxOwn, ProfileOwn, ApptOwn],
            Role::Physician => &[
                VisitRead,
                VisitReview,
                NoteSign,
                ThreadReply,
                TicketHandle,
                PatientRead,
                PatientManage,
                ApptManage,
                RxRead,
                RxDecide,
                OversightRead,
                RulesRead,
            ],
            // The physician's set without signing notes and deciding rx requests.
            Role::Coordinator => &[
                VisitRead,
                VisitReview,
                ThreadReply,
                TicketHandle,
                PatientRead,
                PatientManage,
                ApptManage,
                RxRead,
                OversightRead,
                RulesRead,
            ],
            // patient.read is limited to medicines, allergies and rx; thread.reply to rx threads.
            Role::Pharmacist => &[PatientRead, ThreadReply, RxRead, RxDispense, RulesRead],
            // No permission here reads patient content.
            Role::Admin => &[
                AccountManage,
                SettingsManage,
                AuditRead,
                OversightRead,
                RulesRead,
                DemoReset,
            ],
        }
    }

    pub fn can(self, permission: Permission) -> bool {
        self.permissions().contains(&permission)
    }

    pub fn is_staff(self) -> bool {
        self != Role::Patient
    }
}

impl Permission {
    /// `(label, description)` for the permission matrix.
    pub fn describe(self, locale: Locale) -> (&'static str, &'static str) {
        use Permission::*;
        let (label, description) = match self {
            VisitOwn => (T::PermVisitOwn, T::PermVisitOwnDesc),
            RxOwn => (T::PermRxOwn, T::PermRxOwnDesc),
            ProfileOwn => (T::PermProfileOwn, T::PermProfileOwnDesc),
            ApptOwn => (T::PermApptOwn, T::PermApptOwnDesc),
            VisitRead => (T::PermVisitRead, T::PermVisitReadDesc),
            VisitReview => (T::PermVisitReview, T::PermVisitReviewDesc),
            NoteSign => (T::PermNoteSign, T::PermNoteSignDesc),
            ThreadReply => (T::PermThreadReply, T::PermThreadReplyDesc),
            TicketHandle => (T::PermTicketHandle, T::PermTicketHandleDesc),
            PatientRead => (T::PermPatientRead, T::PermPatientReadDesc),
            PatientManage => (T::PermPatientManage, T::PermPatientManageDesc),
            ApptManage => (T::PermApptManage, T::PermApptManageDesc),
            RxRead => (T::PermRxRead, T::PermRxReadDesc),
            RxDecide => (T::PermRxDecide, T::PermRxDecideDesc),
            RxDispense => (T::PermRxDispense, T::PermRxDispenseDesc),
            AccountManage => (T::PermAccountManage, T::PermAccountManageDesc),
            SettingsManage => (T::PermSettingsManage, T::PermSettingsManageDesc),
            AuditRead => (T::PermAuditRead, T::PermAuditReadDesc),
            OversightRead => (T::PermOversightRead, T::PermOversightReadDesc),
            RulesRead => (T::PermRulesRead, T::PermRulesReadDesc),
            DemoReset => (T::PermDemoReset, T::PermDemoResetDesc),
        };
        (t(label, locale), t(description, locale))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Permission::*;

    fn allowed(role: Role) -> Vec<Permission> {
        let mut list = role.permissions().to_vec();
        list.sort();
        list
    }

    fn sorted(mut list: Vec<Permission>) -> Vec<Permission> {
        list.sort();
        list
    }

    #[test]
    fn the_matrix_matches_the_contract() {
        assert_eq!(
            allowed(Role::Patient),
            sorted(vec![VisitOwn, RxOwn, ProfileOwn, ApptOwn])
        );
        assert_eq!(
            allowed(Role::Physician),
            sorted(vec![
                VisitRead,
                VisitReview,
                NoteSign,
                ThreadReply,
                TicketHandle,
                PatientRead,
                PatientManage,
                ApptManage,
                RxRead,
                RxDecide,
                OversightRead,
                RulesRead
            ])
        );
        assert_eq!(
            allowed(Role::Pharmacist),
            sorted(vec![
                RxRead,
                RxDispense,
                PatientRead,
                ThreadReply,
                RulesRead
            ])
        );
        assert_eq!(
            allowed(Role::Admin),
            sorted(vec![
                AccountManage,
                SettingsManage,
                AuditRead,
                OversightRead,
                RulesRead,
                DemoReset
            ])
        );
    }

    #[test]
    fn a_coordinator_is_a_physician_without_signing_and_deciding() {
        let mut expected = allowed(Role::Physician);
        expected.retain(|p| !matches!(p, NoteSign | RxDecide));
        assert_eq!(allowed(Role::Coordinator), expected);
    }

    #[test]
    fn admin_and_patient_hold_no_staff_content_permission() {
        for p in [
            VisitRead,
            VisitReview,
            NoteSign,
            ThreadReply,
            TicketHandle,
            PatientRead,
            PatientManage,
            RxRead,
            RxDecide,
            RxDispense,
            ApptManage,
        ] {
            assert!(!Role::Admin.can(p), "admin must not have {}", p.as_str());
            assert!(
                !Role::Patient.can(p),
                "patient must not have {}",
                p.as_str()
            );
        }
    }

    #[test]
    fn every_permission_is_held_by_someone_and_named_in_both_languages() {
        for p in Permission::ALL {
            assert!(Role::ALL.iter().any(|r| r.can(*p)), "{}", p.as_str());
            for locale in [Locale::ZhTw, Locale::En] {
                let (label, description) = p.describe(locale);
                assert!(!label.is_empty() && !description.is_empty());
            }
            assert_eq!(Permission::parse(p.as_str()), Some(*p));
        }
        for r in Role::ALL {
            assert_eq!(Role::parse(r.as_str()), Some(*r));
        }
        assert!(Role::parse("clinician").is_none());
    }
}
