//! The durable event log of a visit (`visit_events`) and the stream that replays it.
//!
//! Every event takes the next `seq` under the visit's row lock, so numbers become visible in order and a reader that
//! has seen `n` has seen everything up to `n`. `message.delta` is broadcast only. A broadcast is a wake-up: a follower
//! that missed one reads the log again.

use std::sync::Arc;

use axum::response::sse::Event;
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use crate::auth;
use crate::hub::VisitEvent;
use crate::people::{self, PersonRef};
use crate::sse;
use crate::state::AppState;
use crate::types::{Locale, Message};

const REPLAY_PAGE: i64 = 200;

/// Who may see an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    All,
    #[allow(dead_code)]
    Staff,
}

async fn next_seq(tx: &mut sqlx::PgConnection, visit_id: Uuid) -> sqlx::Result<i64> {
    sqlx::query_scalar("UPDATE visits SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq")
        .bind(visit_id)
        .fetch_one(tx)
        .await
}

async fn insert_event(
    tx: &mut sqlx::PgConnection,
    visit_id: Uuid,
    seq: i64,
    kind: &str,
    data: &Value,
    visibility: Visibility,
) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO visit_events (visit_id, seq, type, data, visibility) VALUES ($1, $2, $3, $4, $5)")
        .bind(visit_id)
        .bind(seq)
        .bind(kind)
        .bind(data)
        .bind(match visibility {
            Visibility::All => "all",
            Visibility::Staff => "staff",
        })
        .execute(tx)
        .await?;
    Ok(())
}

fn publish(
    state: &AppState,
    visit_id: Uuid,
    seq: Option<i64>,
    kind: &str,
    data: Value,
    vis: Visibility,
) {
    state.hub.publish_visit(
        visit_id,
        VisitEvent {
            seq,
            kind: kind.to_string(),
            data: Arc::new(data),
            staff_only: vis == Visibility::Staff,
        },
    );
}

/// Stores an event, then wakes the followers. Returns its `seq`.
pub async fn append(
    state: &AppState,
    visit_id: Uuid,
    kind: &str,
    data: Value,
) -> sqlx::Result<i64> {
    append_for(state, visit_id, kind, data, Visibility::All).await
}

pub async fn append_for(
    state: &AppState,
    visit_id: Uuid,
    kind: &str,
    data: Value,
    visibility: Visibility,
) -> sqlx::Result<i64> {
    let mut tx = state.db.begin().await?;
    let seq = next_seq(&mut tx, visit_id).await?;
    insert_event(&mut tx, visit_id, seq, kind, &data, visibility).await?;
    tx.commit().await?;
    publish(state, visit_id, Some(seq), kind, data, visibility);
    Ok(seq)
}

/// A piece of a reply: broadcast to whoever is watching, never stored.
pub fn delta(state: &AppState, visit_id: Uuid, text: &str) {
    publish(
        state,
        visit_id,
        None,
        "message.delta",
        json!({ "text": text }),
        Visibility::All,
    );
}

pub struct NewMessage<'a> {
    pub role: &'a str,
    pub kind: &'a str,
    pub content: &'a str,
    pub run_id: Option<Uuid>,
    pub author: Option<Uuid>,
    pub client_id: Option<&'a str>,
}

/// Stores a message together with its `message.created` event; both carry the same `seq`.
/// A repeated `client_id` violates the unique index and surfaces as a database error for the caller to handle.
pub async fn insert_message(
    state: &AppState,
    visit_id: Uuid,
    locale: Locale,
    new: NewMessage<'_>,
) -> sqlx::Result<Message> {
    let author: Option<PersonRef> = match new.author {
        Some(id) => people::one(&state.db, id, locale).await?,
        None => None,
    };
    let mut tx = state.db.begin().await?;
    let seq = next_seq(&mut tx, visit_id).await?;
    let mut message: Message = sqlx::query_as(
        "INSERT INTO messages (visit_id, role, kind, content, run_id, seq, client_id, author_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, client_id, seq, role, kind, author_id, content, created_at, run_id, status",
    )
    .bind(visit_id)
    .bind(new.role)
    .bind(new.kind)
    .bind(new.content)
    .bind(new.run_id)
    .bind(seq)
    .bind(new.client_id)
    .bind(new.author)
    .fetch_one(&mut *tx)
    .await?;
    message.author = author;
    let data = serde_json::to_value(&message).unwrap_or(Value::Null);
    insert_event(
        &mut tx,
        visit_id,
        seq,
        "message.created",
        &data,
        Visibility::All,
    )
    .await?;
    tx.commit().await?;
    publish(
        state,
        visit_id,
        Some(seq),
        "message.created",
        data,
        Visibility::All,
    );
    Ok(message)
}

#[derive(sqlx::FromRow)]
struct EventRow {
    seq: i64,
    r#type: String,
    data: Value,
    visibility: String,
}

async fn page_after(db: &PgPool, visit_id: Uuid, after: i64) -> sqlx::Result<Vec<EventRow>> {
    sqlx::query_as("SELECT seq, type, data, visibility FROM visit_events WHERE visit_id = $1 AND seq > $2 ORDER BY seq LIMIT $3")
        .bind(visit_id)
        .bind(after)
        .bind(REPLAY_PAGE)
        .fetch_all(db)
        .await
}

/// Moves the account's read position of a visit forward.
pub async fn mark_read(
    db: &PgPool,
    visit_id: Uuid,
    account_id: Uuid,
    seq: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO visit_reads (visit_id, account_id, seq) VALUES ($1, $2, $3)
         ON CONFLICT (visit_id, account_id) DO UPDATE SET seq = GREATEST(visit_reads.seq, EXCLUDED.seq), read_at = now()",
    )
    .bind(visit_id)
    .bind(account_id)
    .bind(seq)
    .execute(db)
    .await?;
    Ok(())
}

/// What a follower is and what it has seen.
pub struct Follower {
    pub visit_id: Uuid,
    pub account_id: Uuid,
    pub session_id: Uuid,
    pub is_patient: bool,
    /// Everything up to this `seq` is already with the client.
    pub last: i64,
}

impl Follower {
    fn counts_as_read(&self, kind: &str, data: &Value) -> bool {
        kind == "message.created" && (data["role"] == "patient") != self.is_patient
    }

    /// Sends everything after `last` from the log. `false` when the client is gone.
    async fn replay(&mut self, state: &AppState, tx: &mpsc::Sender<Event>) -> sqlx::Result<bool> {
        let mut read_to = None;
        loop {
            let rows = page_after(&state.db, self.visit_id, self.last).await?;
            let full = rows.len() as i64 == REPLAY_PAGE;
            for row in rows {
                self.last = row.seq;
                if row.visibility == "staff" && self.is_patient {
                    continue;
                }
                if self.counts_as_read(&row.r#type, &row.data) {
                    read_to = Some(row.seq);
                }
                if tx
                    .send(sse::event(Some(row.seq), &row.r#type, &row.data))
                    .await
                    .is_err()
                {
                    return Ok(false);
                }
            }
            if !full {
                break;
            }
        }
        if let Some(seq) = read_to {
            mark_read(&state.db, self.visit_id, self.account_id, seq).await?;
        }
        Ok(true)
    }

    /// Replays, then follows until the client leaves, the session ends or the server stops.
    pub async fn run(
        mut self,
        state: AppState,
        mut events: broadcast::Receiver<VisitEvent>,
        tx: mpsc::Sender<Event>,
    ) {
        match self.replay(&state, &tx).await {
            Ok(true) => {}
            Ok(false) => return,
            Err(e) => {
                tracing::error!(error = %e, "could not replay a visit stream");
                return;
            }
        }
        let mut shutdown = state.shutdown.clone();
        let mut recheck = tokio::time::interval(sse::RECHECK_SESSION);
        recheck.tick().await;
        loop {
            let received = tokio::select! {
                received = events.recv() => received,
                _ = tx.closed() => break,
                _ = shutdown.changed() => break,
                _ = recheck.tick() => {
                    if auth::session_alive(&state.db, self.session_id).await.unwrap_or(false) {
                        continue;
                    }
                    break;
                }
            };
            let alive = match received {
                Ok(event) => match event.seq {
                    None => tx
                        .send(sse::event(None, &event.kind, &event.data))
                        .await
                        .is_ok(),
                    Some(seq) if seq <= self.last => true,
                    Some(seq) if seq == self.last + 1 => {
                        self.last = seq;
                        if event.staff_only && self.is_patient {
                            true
                        } else {
                            if self.counts_as_read(&event.kind, &event.data) {
                                let _ =
                                    mark_read(&state.db, self.visit_id, self.account_id, seq).await;
                            }
                            tx.send(sse::event(Some(seq), &event.kind, &event.data))
                                .await
                                .is_ok()
                        }
                    }
                    // Two writers woke us out of order, or we were slow: the log has the right order.
                    Some(_) => self.replay(&state, &tx).await.unwrap_or(false),
                },
                Err(RecvError::Lagged(_)) => self.replay(&state, &tx).await.unwrap_or(false),
                Err(RecvError::Closed) => false,
            };
            if !alive {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_other_sides_messages_move_the_read_position() {
        let follower = |is_patient| Follower {
            visit_id: Uuid::nil(),
            account_id: Uuid::nil(),
            session_id: Uuid::nil(),
            is_patient,
            last: 0,
        };
        let from = |role: &str| json!({ "role": role });
        assert!(follower(true).counts_as_read("message.created", &from("staff")));
        assert!(follower(true).counts_as_read("message.created", &from("assistant")));
        assert!(!follower(true).counts_as_read("message.created", &from("patient")));
        assert!(follower(false).counts_as_read("message.created", &from("patient")));
        assert!(!follower(false).counts_as_read("message.created", &from("staff")));
        assert!(!follower(true).counts_as_read("visit.updated", &from("staff")));
    }
}
