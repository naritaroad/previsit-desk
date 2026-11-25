//! Shared types that mirror docs/api/contract.md. Wire names (snake_case strings) are fixed by the contract.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::people::PersonRef;

macro_rules! str_enum {
    ($(#[$meta:meta])* $name:ident { $($var:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $text)] $var),+
        }

        impl $name {
            #[allow(dead_code)]
            pub const ALL: &'static [$name] = &[$($name::$var),+];

            #[allow(dead_code)]
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

str_enum!(Locale { ZhTw => "zh-TW", En => "en" });
str_enum!(VisitStatus { Active => "active", RedFlag => "red_flag", Submitted => "submitted", Reviewed => "reviewed" });
str_enum!(Stage { ChiefComplaint => "chief_complaint", Hpi => "hpi", Background => "background", Confirm => "confirm", Done => "done" });
str_enum!(Urgency { Routine => "routine", Soon => "soon", Urgent => "urgent" });
str_enum!(RedFlagCategory {
    ChestPain => "chest_pain",
    Dyspnea => "dyspnea",
    Stroke => "stroke",
    Consciousness => "consciousness",
    GiBleeding => "gi_bleeding",
    Anaphylaxis => "anaphylaxis",
    Seizure => "seizure",
    Suicide => "suicide",
});
str_enum!(SpecialStatus {
    None => "none",
    GoingAbroad => "going_abroad",
    ReturningIsland => "returning_island",
    OceanFishingCrew => "ocean_fishing_crew",
    InternationalCrew => "international_crew",
    RareDisease => "rare_disease",
});
str_enum!(Controlled { No => "no", Yes => "yes", Unsure => "unsure" });
str_enum!(RefillOutcome { Eligible => "eligible", TooEarly => "too_early", Revisit => "revisit", Consult => "consult" });
str_enum!(TicketReason {
    RedFlag => "red_flag",
    PrescriptionRequest => "prescription_request",
    ControlledDrug => "controlled_drug",
    SymptomChange => "symptom_change",
    SideEffects => "side_effects",
    SpecialStatus => "special_status",
    OutOfScopeMedical => "out_of_scope_medical",
    PatientRequest => "patient_request",
    Other => "other",
});
str_enum!(CreatedBy { Model => "model", Code => "code", Form => "form" });
str_enum!(ScopeVerdict {
    Ok => "ok",
    PrescriptionRequest => "prescription_request",
    ControlledDrug => "controlled_drug",
    Injection => "injection",
});

impl Locale {
    pub fn is_en(self) -> bool {
        self == Locale::En
    }

    /// First tag of an `Accept-Language` header that we serve: any `en*` is English, everything else zh-TW.
    pub fn from_accept_language(header: &str) -> Locale {
        let first = header
            .split(',')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if first.starts_with("en") {
            Locale::En
        } else {
            Locale::ZhTw
        }
    }
}

/// Where a tool call came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolSource {
    Code,
    Model,
    Form,
}

impl ToolSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Code => "code",
            Self::Model => "model",
            Self::Form => "form",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolStatus {
    Ok,
    Rejected,
    Error,
}

impl ToolStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Rejected => "rejected",
            Self::Error => "error",
        }
    }
}

pub mod message_kind {
    pub const OPENING: &str = "opening";
    pub const CHAT: &str = "chat";
    pub const RED_FLAG: &str = "red_flag";
    pub const REFUSAL: &str = "refusal";
    pub const NOTICE: &str = "notice";
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Visit {
    pub id: Uuid,
    #[sqlx(try_from = "String")]
    pub locale: Locale,
    #[sqlx(try_from = "String")]
    pub status: VisitStatus,
    #[sqlx(try_from = "String")]
    pub stage: Stage,
    #[sqlx(try_from = "String")]
    pub urgency: Urgency,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub submitted_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub reviewed_at: Option<OffsetDateTime>,
    pub reviewed_by: Option<String>,
    pub review_note: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Message {
    pub id: Uuid,
    pub role: String,
    pub kind: String,
    pub content: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub run_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ToolCallRecord {
    pub id: Uuid,
    pub run_id: Option<Uuid>,
    pub step: i32,
    pub name: String,
    pub source: String,
    pub status: String,
    pub arguments: Value,
    pub result: Value,
    pub duration_ms: i32,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RunRow {
    pub id: Uuid,
    pub model: String,
    pub fallback_used: bool,
    pub status: String,
    pub steps: i32,
    pub input_tokens: i32,
    pub output_tokens: i32,
    pub error_code: Option<String>,
    pub duration_ms: i32,
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize)]
pub struct Run {
    pub id: Uuid,
    pub model: String,
    pub fallback_used: bool,
    pub status: String,
    pub steps: i32,
    pub usage: RunUsage,
    pub error_code: Option<String>,
    pub duration_ms: i32,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

impl From<RunRow> for Run {
    fn from(r: RunRow) -> Self {
        Run {
            id: r.id,
            model: r.model,
            fallback_used: r.fallback_used,
            status: r.status,
            steps: r.steps,
            usage: RunUsage {
                input_tokens: i64::from(r.input_tokens),
                output_tokens: i64::from(r.output_tokens),
            },
            error_code: r.error_code,
            duration_ms: r.duration_ms,
            created_at: r.created_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Ticket {
    pub id: Uuid,
    pub ticket_no: String,
    /// `None` for a ticket opened from an rx request.
    pub visit_id: Option<Uuid>,
    pub rx_request_id: Option<Uuid>,
    #[serde(skip)]
    pub patient_id: Option<Uuid>,
    #[sqlx(skip)]
    pub patient: Option<PersonRef>,
    pub reason: String,
    #[sqlx(try_from = "String")]
    pub urgency: Urgency,
    pub summary: String,
    pub status: String,
    pub created_by: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub resolved_at: Option<OffsetDateTime>,
    pub resolved_by: Option<String>,
    pub resolution_note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RedFlagHit {
    pub category: RedFlagCategory,
    pub label: String,
    /// ISO timestamp of the match (never the matched text).
    pub matched_at: String,
    pub message_id: Uuid,
}
