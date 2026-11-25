//! Notifications (contract §8): one row per reader, stored as kind + params and rendered in the reader's language
//! when listed. A notification never carries message text.

use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{OffsetDateTime, UtcOffset};
use uuid::Uuid;

use crate::people::{self, People};
use crate::perm::Permission;
use crate::state::AppState;
use crate::texts::{self, T, t};
use crate::types::Locale;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum Kind {
    VisitReviewed,
    VisitStaffMessage,
    RxStatus,
    RxMoreInfo,
    RxReady,
    RxMessage,
    ApptReminder,
    RefillWindowOpen,
    TicketNew,
    RxNew,
    RxOverdue,
    VisitSubmitted,
    RedFlag,
}

impl Kind {
    pub const ALL: [Kind; 13] = [
        Kind::VisitReviewed,
        Kind::VisitStaffMessage,
        Kind::RxStatus,
        Kind::RxMoreInfo,
        Kind::RxReady,
        Kind::RxMessage,
        Kind::ApptReminder,
        Kind::RefillWindowOpen,
        Kind::TicketNew,
        Kind::RxNew,
        Kind::RxOverdue,
        Kind::VisitSubmitted,
        Kind::RedFlag,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::VisitReviewed => "visit.reviewed",
            Kind::VisitStaffMessage => "visit.staff_message",
            Kind::RxStatus => "rx.status",
            Kind::RxMoreInfo => "rx.more_info",
            Kind::RxReady => "rx.ready",
            Kind::RxMessage => "rx.message",
            Kind::ApptReminder => "appt.reminder",
            Kind::RefillWindowOpen => "refill.window_open",
            Kind::TicketNew => "ticket.new",
            Kind::RxNew => "rx.new",
            Kind::RxOverdue => "rx.overdue",
            Kind::VisitSubmitted => "visit.submitted",
            Kind::RedFlag => "red_flag",
        }
    }

    fn texts(self) -> (T, T) {
        match self {
            Kind::VisitReviewed => (T::NtfVisitReviewed, T::NtfVisitReviewedBody),
            Kind::VisitStaffMessage => (T::NtfStaffMessage, T::NtfStaffMessageBody),
            Kind::RxStatus => (T::NtfRxStatus, T::NtfRxStatusBody),
            Kind::RxMoreInfo => (T::NtfRxMoreInfo, T::NtfRxMoreInfoBody),
            Kind::RxReady => (T::NtfRxReady, T::NtfRxReadyBody),
            Kind::RxMessage => (T::NtfRxMessage, T::NtfRxMessageBody),
            Kind::ApptReminder => (T::NtfApptReminder, T::NtfApptReminderBody),
            Kind::RefillWindowOpen => (T::NtfRefillWindow, T::NtfRefillWindowBody),
            Kind::TicketNew => (T::NtfTicketNew, T::NtfTicketNewBody),
            Kind::RxNew => (T::NtfRxNew, T::NtfRxNewBody),
            Kind::RxOverdue => (T::NtfRxOverdue, T::NtfRxOverdueBody),
            Kind::VisitSubmitted => (T::NtfVisitSubmitted, T::NtfVisitSubmittedBody),
            Kind::RedFlag => (T::NtfRedFlag, T::NtfRedFlagBody),
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == text)
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct NotificationRow {
    pub id: Uuid,
    pub kind: String,
    pub params: Value,
    pub link: Option<String>,
    pub read_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize)]
pub struct Notification {
    pub id: Uuid,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub link: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub read_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// Taipei wall-clock time, `2026-11-26 09:30`.
pub fn local_time(at: OffsetDateTime) -> String {
    let local = at.to_offset(UtcOffset::from_hms(8, 0, 0).unwrap_or(UtcOffset::UTC));
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}",
        local.year(),
        u8::from(local.month()),
        local.day(),
        local.hour(),
        local.minute()
    )
}

fn person_ids(params: &Value) -> impl Iterator<Item = Uuid> + '_ {
    ["actor_id", "patient_id", "physician_id"]
        .into_iter()
        .filter_map(|k| params[k].as_str())
        .filter_map(|v| Uuid::parse_str(v).ok())
}

/// Fills `{placeholders}` from params. `x_id` gives `{x}` a person's name; `x_en` overrides `x` for English;
/// `status`, `rx_kind` and `reason` are codes with labels; `at` is a timestamp shown in Taipei time.
fn fill(template: &str, params: &Value, people: &People, locale: Locale) -> String {
    let mut out = template.to_string();
    let mut put = |name: &str, value: &str| {
        out = out.replace(&format!("{{{name}}}"), value);
    };
    let Some(map) = params.as_object() else {
        return out;
    };
    for (key, value) in map {
        let Some(text) = value
            .as_str()
            .map(str::to_string)
            .or_else(|| value.as_i64().map(|n| n.to_string()))
        else {
            continue;
        };
        if key.ends_with("_en") {
            continue;
        }
        if let Some(name) = key.strip_suffix("_id") {
            if let Ok(id) = Uuid::parse_str(&text) {
                let person = people.get(Some(id));
                let shown = person
                    .map(|p| p.display_name)
                    .unwrap_or_else(|| t(T::SomeoneLabel, locale).to_string());
                put(name, &shown);
            }
            continue;
        }
        let shown = match key.as_str() {
            "status" => texts::rx_status_label(&text, locale).to_string(),
            "rx_kind" => texts::rx_kind_label(&text, locale).to_string(),
            "reason" => texts::ticket_reason_label(&text, locale).to_string(),
            "at" => OffsetDateTime::parse(&text, &time::format_description::well_known::Rfc3339)
                .map(local_time)
                .unwrap_or(text),
            _ => map
                .get(&format!("{key}_en"))
                .and_then(Value::as_str)
                .filter(|v| locale.is_en() && !v.is_empty())
                .map(str::to_string)
                .unwrap_or(text),
        };
        put(key, &shown);
    }
    out
}

pub async fn render(
    db: &PgPool,
    rows: Vec<NotificationRow>,
    locale: Locale,
) -> sqlx::Result<Vec<Notification>> {
    let people = people::load(
        db,
        rows.iter()
            .flat_map(|r| person_ids(&r.params).collect::<Vec<_>>()),
        locale,
    )
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let (title, body) = Kind::parse(&r.kind)?.texts();
            Some(Notification {
                title: fill(t(title, locale), &r.params, &people, locale),
                body: fill(t(body, locale), &r.params, &people, locale),
                id: r.id,
                kind: r.kind,
                link: r.link,
                read_at: r.read_at,
                created_at: r.created_at,
            })
        })
        .collect())
}

/// Tells one account. A failure is logged and never undoes what the notification is about.
pub async fn notify(state: &AppState, account: Uuid, kind: Kind, params: Value, link: &str) {
    if let Err(e) = insert(state, &[account], kind, params, link, None).await {
        tracing::error!(error = %e, kind = kind.as_str(), "could not write a notification");
    }
}

/// Like [`notify`], but at most once per `dedupe` key and account.
#[allow(dead_code)]
pub async fn notify_once(
    state: &AppState,
    account: Uuid,
    kind: Kind,
    params: Value,
    link: &str,
    dedupe: &str,
) {
    if let Err(e) = insert(state, &[account], kind, params, link, Some(dedupe)).await {
        tracing::error!(error = %e, kind = kind.as_str(), "could not write a notification");
    }
}

/// Tells every active staff account whose role holds `permission`.
pub async fn notify_staff(
    state: &AppState,
    permission: Permission,
    kind: Kind,
    params: Value,
    link: &str,
    dedupe: Option<&str>,
) {
    let roles: Vec<&str> = crate::perm::Role::ALL
        .iter()
        .filter(|r| r.is_staff() && r.can(permission))
        .map(|r| r.as_str())
        .collect();
    let ids: Result<Vec<Uuid>, _> =
        sqlx::query_scalar("SELECT id FROM accounts WHERE role = ANY($1) AND status = 'active'")
            .bind(&roles)
            .fetch_all(&state.db)
            .await;
    let result = match ids {
        Ok(ids) => insert(state, &ids, kind, params, link, dedupe).await,
        Err(e) => Err(e),
    };
    if let Err(e) = result {
        tracing::error!(error = %e, kind = kind.as_str(), "could not write staff notifications");
    }
}

async fn insert(
    state: &AppState,
    accounts: &[Uuid],
    kind: Kind,
    params: Value,
    link: &str,
    dedupe: Option<&str>,
) -> sqlx::Result<()> {
    #[derive(sqlx::FromRow)]
    struct Inserted {
        account_id: Uuid,
        locale: String,
        #[sqlx(flatten)]
        row: NotificationRow,
    }
    let rows: Vec<Inserted> = sqlx::query_as(
        "WITH n AS (
            INSERT INTO notifications (account_id, kind, params, link, dedupe_key)
            SELECT a, $2, $3, $4, $5 FROM unnest($1::uuid[]) AS a
            ON CONFLICT DO NOTHING RETURNING id, account_id, kind, params, link, read_at, created_at)
         SELECT n.*, a.locale FROM n JOIN accounts a ON a.id = n.account_id",
    )
    .bind(accounts)
    .bind(kind.as_str())
    .bind(&params)
    .bind(link)
    .bind(dedupe)
    .fetch_all(&state.db)
    .await?;
    for inserted in rows {
        let locale = Locale::parse(&inserted.locale).unwrap_or(Locale::ZhTw);
        let rendered = render(&state.db, vec![inserted.row], locale).await?;
        if let Some(notification) = rendered.into_iter().next() {
            state.hub.to_account(
                inserted.account_id,
                "notification",
                serde_json::to_value(notification).unwrap_or(json!({})),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_match_the_contract_list() {
        let names: Vec<&str> = Kind::ALL.iter().map(|k| k.as_str()).collect();
        assert_eq!(
            names,
            [
                "visit.reviewed",
                "visit.staff_message",
                "rx.status",
                "rx.more_info",
                "rx.ready",
                "rx.message",
                "appt.reminder",
                "refill.window_open",
                "ticket.new",
                "rx.new",
                "rx.overdue",
                "visit.submitted",
                "red_flag"
            ]
        );
        for kind in Kind::ALL {
            assert_eq!(Kind::parse(kind.as_str()), Some(kind));
        }
    }

    #[test]
    fn placeholders_are_filled_in_the_readers_language() {
        let people = People::default();
        let params = json!({ "no": "RX-20261125-0001", "status": "ready", "pharmacy": "安和藥局", "pharmacy_en": "Anhe Pharmacy" });
        let zh = fill("{no} {status} {pharmacy}", &params, &people, Locale::ZhTw);
        assert!(zh.contains("RX-20261125-0001") && zh.contains("安和藥局"));
        let en = fill("{no} {status} {pharmacy}", &params, &people, Locale::En);
        assert!(en.contains("Anhe Pharmacy"), "{en}");
        assert!(!en.contains('{'));
    }

    #[test]
    fn times_are_shown_in_taipei() {
        assert_eq!(
            local_time(time::macros::datetime!(2026-11-25 01:30 UTC)),
            "2026-11-25 09:30"
        );
    }
}
