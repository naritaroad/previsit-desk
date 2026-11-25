//! Background upkeep: the retention sweep, expired guests, reminders and overdue notices, and the daily demo refresh.

use std::time::Duration;

use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::clock::format_date;
use crate::demo;
use crate::notify::{self, Kind};
use crate::perm::Permission;
use crate::state::AppState;
use crate::visits;

const EVERY: Duration = Duration::from_secs(10 * 60);

/// Runs once now and then every ten minutes until the server stops.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(EVERY);
        let mut shutdown = state.shutdown.clone();
        loop {
            tokio::select! {
                _ = tick.tick() => run_once(&state).await,
                _ = shutdown.changed() => break,
            }
        }
    });
}

pub async fn run_once(state: &AppState) {
    if let Err(e) = sweep(state).await {
        tracing::warn!(error = %e, "retention sweep failed");
    }
    if let Err(e) = demo::ensure(state).await {
        tracing::warn!(error = %e, "demo refresh failed");
    }
    if let Err(e) = appointment_reminders(state).await {
        tracing::warn!(error = %e, "appointment reminders failed");
    }
    if let Err(e) = refill_windows(state).await {
        tracing::warn!(error = %e, "refill reminders failed");
    }
    if let Err(e) = rx_overdue(state).await {
        tracing::warn!(error = %e, "overdue notices failed");
    }
}

/// Deletes what is past its time. `audit_log` and `usage_daily` hold no patient content and stay.
pub async fn sweep(state: &AppState) -> sqlx::Result<()> {
    let db = &state.db;
    let guests = sqlx::query(
        "DELETE FROM accounts WHERE is_guest AND expires_at IS NOT NULL AND expires_at < $1",
    )
    .bind(state.clock.now())
    .execute(db)
    .await?
    .rows_affected();
    let old = visits::cleanup(db, visits::retention_cutoff(state)).await?;
    sqlx::query("DELETE FROM sessions WHERE expires_at < now()")
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'")
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM drafts WHERE updated_at < now() - interval '60 days'")
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM notifications WHERE created_at < now() - interval '90 days'")
        .execute(db)
        .await?;
    if guests + old > 0 {
        tracing::info!(
            guests,
            visits = old,
            "removed data past the retention period"
        );
    }
    Ok(())
}

/// One reminder per appointment, from 24 hours before it starts.
async fn appointment_reminders(state: &AppState) -> sqlx::Result<()> {
    let now = state.clock.now();
    let due: Vec<(Uuid, Uuid, Uuid, OffsetDateTime, String, String)> = sqlx::query_as(
        "UPDATE appointments SET reminded_at = $1 WHERE status = 'booked' AND reminded_at IS NULL AND starts_at > $1 AND starts_at <= $1 + interval '24 hours'
         RETURNING id, patient_id, physician_id, starts_at, department, department_en",
    )
    .bind(now)
    .fetch_all(&state.db)
    .await?;
    for (id, patient, physician, at, department, department_en) in due {
        notify::notify_once(
            state,
            patient,
            Kind::ApptReminder,
            json!({ "at": visits::rfc3339(at), "physician_id": physician, "department": department, "department_en": department_en }),
            "/app/appointments",
            &format!("appt:{id}"),
        )
        .await;
    }
    Ok(())
}

/// Tells a patient once per fill when the next refill window is open. The window follows the refill rules: the
/// supply ends `days_per_fill` after the last fill, and opens `early_window_days` before that.
async fn refill_windows(state: &AppState) -> sqlx::Result<()> {
    let today = state.clock.today();
    let window = state.rules.refill.early_window_days as i32;
    let open: Vec<(Uuid, Uuid, String, String, i32, time::Date)> = sqlx::query_as(
        "SELECT p.id, p.patient_id, p.name_zh, p.name_en, f.n, (f.filled_on + p.days_per_fill - $2) AS opens
         FROM prescriptions p JOIN LATERAL (SELECT n, filled_on FROM fills WHERE prescription_id = p.id ORDER BY n DESC LIMIT 1) f ON true
         JOIN accounts a ON a.id = p.patient_id AND a.status = 'active'
         WHERE p.active AND p.source = 'clinic' AND f.n < p.fills_allowed AND p.valid_until >= $1 AND f.filled_on + p.days_per_fill - $2 <= $1
           AND NOT EXISTS (SELECT 1 FROM rx_request_items i JOIN rx_requests r ON r.id = i.request_id WHERE i.prescription_id = p.id AND r.status NOT IN ('declined', 'visit_required', 'dispensed', 'cancelled'))
           AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.account_id = p.patient_id AND n.dedupe_key = 'refill:' || p.id || ':' || f.n)",
    )
    .bind(today)
    .bind(window)
    .fetch_all(&state.db)
    .await?;
    for (id, patient, name, name_en, n, opens) in open {
        notify::notify_once(
            state,
            patient,
            Kind::RefillWindowOpen,
            json!({ "drug": name, "drug_en": name_en, "date": format_date(opens) }),
            "/app/medications",
            &format!("refill:{id}:{n}"),
        )
        .await;
    }
    Ok(())
}

/// Tells the people who decide, once, that a request passed its time limit.
async fn rx_overdue(state: &AppState) -> sqlx::Result<()> {
    let late: Vec<(Uuid, String, Uuid, Option<Uuid>)> = sqlx::query_as(
        "UPDATE rx_requests SET overdue_notified_at = $1 WHERE status IN ('submitted', 'in_review') AND sla_due_at < $1 AND overdue_notified_at IS NULL
         RETURNING id, no, patient_id, assigned_to",
    )
    .bind(state.clock.now())
    .fetch_all(&state.db)
    .await?;
    for (id, no, patient, assigned) in late {
        let params = json!({ "no": no, "patient_id": patient });
        let link = format!("/clinic/rx/{id}");
        match assigned {
            Some(account) => {
                notify::notify(state, account, Kind::RxOverdue, params, &link).await;
            }
            None => {
                notify::notify_staff(
                    state,
                    Permission::RxDecide,
                    Kind::RxOverdue,
                    params,
                    &link,
                    None,
                )
                .await;
            }
        }
        state
            .hub
            .to_permission(Permission::RxRead, "queue.changed", json!({ "name": "rx" }));
    }
    Ok(())
}
