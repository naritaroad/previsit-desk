//! The two ledgers: `audit_log` (who changed what) and `access_log` (which staff member read which patient's data).
//! Neither ever holds message text, passwords or tokens.

use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::CurrentUser;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditKind {
    Admin,
    /// Used by the rx module for decisions and dispensing.
    #[allow(dead_code)]
    Rx,
    Auth,
    Clinic,
}

impl AuditKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Rx => "rx",
            Self::Auth => "auth",
            Self::Clinic => "clinic",
        }
    }
}

/// Writes one audit row. `target` is `type:id`; `detail` holds changed keys and ids, never free text from a patient.
/// A failed write is logged and does not undo the action that was already done.
pub async fn audit(
    db: &PgPool,
    actor: Option<&CurrentUser>,
    kind: AuditKind,
    action: &str,
    target: &str,
    detail: Value,
) {
    let detail = if detail.is_null() {
        Value::Object(Default::default())
    } else {
        detail
    };
    let result = sqlx::query("INSERT INTO audit_log (actor_id, actor_name, actor_role, kind, action, target, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(actor.map(|a| a.id))
        .bind(actor.map(|a| a.display_name.as_str()).unwrap_or(""))
        .bind(actor.map(|a| a.role.as_str()).unwrap_or(""))
        .bind(kind.as_str())
        .bind(action)
        .bind(target)
        .bind(detail)
        .execute(db)
        .await;
    if let Err(e) = result {
        tracing::error!(error = %e, action, "could not write the audit row");
    }
}

/// Records that a staff member read a patient's data. Patients reading their own data are not logged.
/// The same person re-reading the same thing within a minute (a page that refreshes itself) is one entry.
/// Unlike `audit`, a failure here fails the read: no record, no access.
pub async fn log_access(
    db: &PgPool,
    actor: &CurrentUser,
    patient_id: Option<Uuid>,
    action: &str,
    resource: &str,
    resource_id: &str,
) -> sqlx::Result<()> {
    if Some(actor.id) == patient_id {
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO access_log (actor_id, actor_name, actor_role, patient_id, action, resource, resource_id)
         SELECT $1, $2, $3, $4, $5, $6, $7
         WHERE NOT EXISTS (SELECT 1 FROM access_log l WHERE l.actor_id = $1 AND l.patient_id IS NOT DISTINCT FROM $4 AND l.action = $5
                             AND l.resource = $6 AND l.resource_id = $7 AND l.at > now() - interval '60 seconds')",
    )
    .bind(actor.id)
    .bind(&actor.display_name)
    .bind(actor.role.as_str())
    .bind(patient_id)
    .bind(action)
    .bind(resource)
    .bind(resource_id)
    .execute(db)
    .await?;
    Ok(())
}
