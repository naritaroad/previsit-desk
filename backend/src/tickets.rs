//! Clinician tickets: creation with (visit, reason) de-duplication, numbering `T-YYYYMMDD-NNNN`, listing, resolving.

use serde::Serialize;
use sqlx::PgPool;
use time::Date;
use uuid::Uuid;

use crate::clock::Clock;
use crate::types::{CreatedBy, Ticket, TicketReason, Urgency};

macro_rules! ticket_cols {
    () => {
        "t.id, t.ticket_no, t.visit_id, t.reason, t.urgency, t.summary, t.status, t.created_by, t.created_at, t.resolved_at, t.resolved_by, t.resolution_note"
    };
}

pub fn format_ticket_no(day: Date, n: i32) -> String {
    format!(
        "T-{:04}{:02}{:02}-{:04}",
        day.year(),
        u8::from(day.month()),
        day.day(),
        n
    )
}

pub struct NewTicket<'a> {
    pub visit_id: Uuid,
    pub reason: TicketReason,
    pub urgency: Urgency,
    pub summary: &'a str,
    pub created_by: CreatedBy,
}

pub struct Created {
    pub ticket: Ticket,
    /// An open ticket with the same visit and reason already existed; nothing new was opened.
    pub deduped: bool,
}

fn urgency_rank(u: Urgency) -> u8 {
    match u {
        Urgency::Routine => 0,
        Urgency::Soon => 1,
        Urgency::Urgent => 2,
    }
}

/// Opens a ticket, or returns the open one for the same visit and reason (raising its urgency if the new one is higher).
/// One transaction with an advisory lock per (visit, reason) so two parallel requests cannot both open one.
pub async fn create_or_get(
    db: &PgPool,
    clock: &Clock,
    new: NewTicket<'_>,
) -> sqlx::Result<Created> {
    let mut tx = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("ticket:{}:{}", new.visit_id, new.reason.as_str()))
        .execute(&mut *tx)
        .await?;

    let existing: Option<Ticket> = sqlx::query_as(concat!("SELECT ", ticket_cols!(), " FROM clinician_tickets t WHERE t.visit_id = $1 AND t.reason = $2 AND t.status = 'open' ORDER BY t.created_at LIMIT 1"))
        .bind(new.visit_id)
        .bind(new.reason.as_str())
        .fetch_optional(&mut *tx)
        .await?;
    if let Some(mut ticket) = existing {
        if urgency_rank(new.urgency) > urgency_rank(ticket.urgency) {
            sqlx::query("UPDATE clinician_tickets SET urgency = $2 WHERE id = $1")
                .bind(ticket.id)
                .bind(new.urgency.as_str())
                .execute(&mut *tx)
                .await?;
            ticket.urgency = new.urgency;
        }
        tx.commit().await?;
        return Ok(Created {
            ticket,
            deduped: true,
        });
    }

    // One atomic upsert hands out the next number of the day.
    let n: i32 = sqlx::query_scalar("INSERT INTO ticket_counters (day, n) VALUES ($1, 1) ON CONFLICT (day) DO UPDATE SET n = ticket_counters.n + 1 RETURNING n").bind(clock.today()).fetch_one(&mut *tx).await?;
    let ticket_no = format_ticket_no(clock.today(), n);
    let ticket: Ticket = sqlx::query_as(
        "INSERT INTO clinician_tickets AS t (ticket_no, visit_id, reason, urgency, summary, created_by) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING t.id, t.ticket_no, t.visit_id, t.reason, t.urgency, t.summary, t.status, t.created_by, t.created_at, t.resolved_at, t.resolved_by, t.resolution_note",
    )
    .bind(&ticket_no)
    .bind(new.visit_id)
    .bind(new.reason.as_str())
    .bind(new.urgency.as_str())
    .bind(new.summary)
    .bind(new.created_by.as_str())
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Created {
        ticket,
        deduped: false,
    })
}

pub async fn for_visit(db: &PgPool, visit_id: Uuid) -> sqlx::Result<Vec<Ticket>> {
    sqlx::query_as(concat!(
        "SELECT ",
        ticket_cols!(),
        " FROM clinician_tickets t WHERE t.visit_id = $1 ORDER BY t.created_at, t.id"
    ))
    .bind(visit_id)
    .fetch_all(db)
    .await
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TicketRow {
    #[serde(flatten)]
    #[sqlx(flatten)]
    pub ticket: Ticket,
    pub chief_complaint: Option<String>,
}

/// `status`: `open`, `resolved` or `all`. Urgent first, then newest first.
pub async fn list(db: &PgPool, status: &str) -> sqlx::Result<Vec<TicketRow>> {
    sqlx::query_as(concat!(
        "SELECT ",
        ticket_cols!(),
        ", v.intake->>'chief_complaint' AS chief_complaint FROM clinician_tickets t JOIN visits v ON v.id = t.visit_id
         WHERE ($1 = 'all' OR t.status = $1)
         ORDER BY CASE t.urgency WHEN 'urgent' THEN 0 WHEN 'soon' THEN 1 ELSE 2 END, t.created_at DESC, t.id LIMIT 500"
    ))
    .bind(status)
    .fetch_all(db)
    .await
}

pub enum ResolveError {
    NotFound,
    AlreadyResolved,
    Db(sqlx::Error),
}

impl From<sqlx::Error> for ResolveError {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e)
    }
}

pub async fn resolve(
    db: &PgPool,
    id: Uuid,
    by: &str,
    note: Option<&str>,
) -> Result<Ticket, ResolveError> {
    let updated: Option<Ticket> = sqlx::query_as(
        "UPDATE clinician_tickets AS t SET status = 'resolved', resolved_at = now(), resolved_by = $2, resolution_note = $3 WHERE t.id = $1 AND t.status = 'open'
         RETURNING t.id, t.ticket_no, t.visit_id, t.reason, t.urgency, t.summary, t.status, t.created_by, t.created_at, t.resolved_at, t.resolved_by, t.resolution_note",
    )
    .bind(id)
    .bind(by)
    .bind(note)
    .fetch_optional(db)
    .await?;
    if let Some(ticket) = updated {
        return Ok(ticket);
    }
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM clinician_tickets WHERE id = $1)")
            .bind(id)
            .fetch_one(db)
            .await?;
    Err(if exists {
        ResolveError::AlreadyResolved
    } else {
        ResolveError::NotFound
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    #[test]
    fn ticket_numbers_are_dated_and_zero_padded() {
        assert_eq!(
            format_ticket_no(date!(2026 - 11 - 25), 1),
            "T-20261125-0001"
        );
        assert_eq!(
            format_ticket_no(date!(2026 - 01 - 05), 42),
            "T-20260105-0042"
        );
        assert_eq!(
            format_ticket_no(date!(2026 - 11 - 25), 12345),
            "T-20261125-12345"
        );
    }

    #[test]
    fn urgency_ranks_order_routine_soon_urgent() {
        assert!(urgency_rank(Urgency::Urgent) > urgency_rank(Urgency::Soon));
        assert!(urgency_rank(Urgency::Soon) > urgency_rank(Urgency::Routine));
    }
}
