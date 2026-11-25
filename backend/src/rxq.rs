//! Read-only SQL over the rx tables for screens outside the rx module: the staff worklist, the overview counts and the
//! rows behind the oversight figures. The rx module owns every write.

use serde::Serialize;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::people::{self, PersonRef};
use crate::rx::{DecisionOutcome, Disposition, LText, metrics};

/// Statuses that end a request.
pub const CLOSED: [&str; 4] = ["declined", "visit_required", "dispensed", "cancelled"];

#[derive(Debug, Clone, Serialize)]
pub struct RxRequestBrief {
    pub id: Uuid,
    pub no: String,
    pub kind: String,
    pub status: String,
    pub priority: String,
    pub patient: PersonRef,
    pub drug_names: Vec<String>,
    pub disposition: Option<String>,
    pub assigned_to: Option<PersonRef>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub submitted_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub sla_due_at: Option<OffsetDateTime>,
    pub overdue: bool,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub unread: bool,
}

#[derive(sqlx::FromRow)]
struct BriefRow {
    id: Uuid,
    no: String,
    kind: String,
    status: String,
    priority: String,
    patient_id: Uuid,
    names_zh: Vec<String>,
    names_en: Vec<String>,
    disposition: Option<String>,
    assigned_to: Option<Uuid>,
    submitted_at: Option<OffsetDateTime>,
    sla_due_at: Option<OffsetDateTime>,
    overdue: bool,
    updated_at: OffsetDateTime,
    unread: bool,
}

/// Submitted requests (never drafts) that are open or changed in the last `days` days, for the staff worklist.
pub async fn recent(
    db: &PgPool,
    viewer: &CurrentUser,
    days: i32,
    now: OffsetDateTime,
) -> sqlx::Result<Vec<RxRequestBrief>> {
    let closed: Vec<&str> = CLOSED.to_vec();
    let rows: Vec<BriefRow> = sqlx::query_as(
        "SELECT r.id, r.no, r.kind, r.status, r.priority, r.patient_id, r.disposition, r.assigned_to, r.submitted_at, r.sla_due_at, r.updated_at,
                COALESCE((SELECT array_agg(p.name_zh ORDER BY i.position, i.id) FROM rx_request_items i JOIN prescriptions p ON p.id = i.prescription_id WHERE i.request_id = r.id), '{}') AS names_zh,
                COALESCE((SELECT array_agg(p.name_en ORDER BY i.position, i.id) FROM rx_request_items i JOIN prescriptions p ON p.id = i.prescription_id WHERE i.request_id = r.id), '{}') AS names_en,
                (r.status IN ('submitted', 'in_review') AND r.sla_due_at IS NOT NULL AND r.sla_due_at < $2) AS overdue,
                EXISTS (SELECT 1 FROM rx_messages m WHERE m.request_id = r.id AND m.author_id IS DISTINCT FROM $1
                          AND m.created_at > COALESCE((SELECT d.read_at FROM rx_reads d WHERE d.request_id = r.id AND d.account_id = $1), '-infinity'::timestamptz)) AS unread
         FROM rx_requests r
         WHERE r.submitted_at IS NOT NULL AND (r.updated_at > $2 - make_interval(days => $3) OR r.status <> ALL($4))
         ORDER BY r.updated_at DESC, r.id DESC LIMIT 500",
    )
    .bind(viewer.id)
    .bind(now)
    .bind(days)
    .bind(&closed)
    .fetch_all(db)
    .await?;
    let people = people::load(
        db,
        rows.iter()
            .flat_map(|r| std::iter::once(r.patient_id).chain(r.assigned_to)),
        viewer.locale,
    )
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| RxRequestBrief {
            patient: people.get_or_unknown(Some(r.patient_id), viewer.locale),
            assigned_to: people.get(r.assigned_to),
            drug_names: r
                .names_zh
                .into_iter()
                .zip(r.names_en)
                .map(|(zh, en)| {
                    if viewer.locale.is_en() && !en.is_empty() {
                        en
                    } else {
                        zh
                    }
                })
                .collect(),
            id: r.id,
            no: r.no,
            kind: r.kind,
            status: r.status,
            priority: r.priority,
            disposition: r.disposition,
            submitted_at: r.submitted_at,
            sla_due_at: r.sla_due_at,
            overdue: r.overdue,
            updated_at: r.updated_at,
            unread: r.unread,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Oversight rows (the arithmetic is `rx::metrics`)
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct OversightRow {
    class_id: String,
    class_zh: String,
    class_en: String,
    disposition: Option<String>,
    outcome: Option<String>,
}

/// Submitted renewal items whose request was submitted in `[from, to)`. An item without an engine result is left out.
pub async fn renewal_items(
    db: &PgPool,
    from: OffsetDateTime,
    to: OffsetDateTime,
) -> sqlx::Result<Vec<metrics::ItemRow>> {
    let rows: Vec<OversightRow> = sqlx::query_as(
        "SELECT COALESCE(NULLIF(i.class_id, ''), p.class_id) AS class_id, p.class_zh, p.class_en, i.disposition, i.outcome
         FROM rx_request_items i JOIN rx_requests r ON r.id = i.request_id JOIN prescriptions p ON p.id = i.prescription_id
         WHERE r.kind = 'renewal' AND r.submitted_at >= $1 AND r.submitted_at < $2",
    )
    .bind(from)
    .bind(to)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            Some(metrics::ItemRow {
                class_id: r.class_id,
                class: LText::new(r.class_zh, r.class_en),
                engine: r.disposition.as_deref().and_then(Disposition::parse)?,
                decision: r.outcome.as_deref().and_then(DecisionOutcome::parse),
            })
        })
        .collect())
}

/// Hours from submission to the physician's decision, one per decided renewal.
pub async fn decision_hours(
    db: &PgPool,
    from: OffsetDateTime,
    to: OffsetDateTime,
) -> sqlx::Result<Vec<f64>> {
    sqlx::query_scalar(
        "SELECT (EXTRACT(EPOCH FROM (decided_at - submitted_at)) / 3600.0)::float8 FROM rx_requests
         WHERE kind = 'renewal' AND decided_at IS NOT NULL AND submitted_at >= $1 AND submitted_at < $2",
    )
    .bind(from)
    .bind(to)
    .fetch_all(db)
    .await
}

/// `(returned, reached a pharmacy)`, counted per request.
pub async fn pharmacy_counts(
    db: &PgPool,
    from: OffsetDateTime,
    to: OffsetDateTime,
) -> sqlx::Result<(i64, i64)> {
    sqlx::query_as(
        "SELECT count(DISTINCT request_id) FILTER (WHERE to_status = 'returned'), count(DISTINCT request_id) FILTER (WHERE to_status = 'at_pharmacy')
         FROM rx_events WHERE at >= $1 AND at < $2",
    )
    .bind(from)
    .bind(to)
    .fetch_one(db)
    .await
}
