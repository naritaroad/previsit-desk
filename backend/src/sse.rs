//! Shared pieces of the two long-lived streams (`/me/stream`, `/visits/{id}/stream`): response headers, keep-alive,
//! the per-account connection limit and the end conditions (client gone, session ended, server stopping).

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::HeaderValue;
use axum::http::header::{CACHE_CONTROL, HeaderName};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures::StreamExt;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

const KEEP_ALIVE: Duration = Duration::from_secs(15);
/// A stream ends this soon after its session was revoked or expired.
pub const RECHECK_SESSION: Duration = Duration::from_secs(30);
const MAX_STREAMS_PER_ACCOUNT: usize = 16;

/// `event:` + `data: {"v":1,"seq"?,"type","data"}`; `id:` is the seq, so `Last-Event-ID` resumes the stream.
pub fn event(seq: Option<i64>, kind: &str, data: &Value) -> Event {
    let mut payload = json!({ "v": 1, "type": kind, "data": data });
    let mut event = Event::default().event(kind);
    if let Some(seq) = seq {
        payload["seq"] = json!(seq);
        event = event.id(seq.to_string());
    }
    event.data(payload.to_string())
}

pub fn response(rx: mpsc::Receiver<Event>) -> Response {
    let stream = ReceiverStream::new(rx).map(Ok::<Event, Infallible>);
    let mut response = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(KEEP_ALIVE).text("keep-alive"))
        .into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    response
}

#[derive(Default)]
pub struct StreamSlots {
    open: Mutex<HashMap<Uuid, usize>>,
}

/// Held while a stream is open; dropping it frees the place.
pub struct StreamSlot {
    slots: Arc<StreamSlots>,
    account: Uuid,
}

impl StreamSlots {
    pub fn acquire(self: &Arc<Self>, account: Uuid) -> Option<StreamSlot> {
        let mut open = self
            .open
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let n = open.entry(account).or_insert(0);
        if *n >= MAX_STREAMS_PER_ACCOUNT {
            return None;
        }
        *n += 1;
        Some(StreamSlot {
            slots: self.clone(),
            account,
        })
    }
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        let mut open = self
            .slots
            .open
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(n) = open.get_mut(&self.account) {
            *n -= 1;
            if *n == 0 {
                open.remove(&self.account);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_account_holds_a_bounded_number_of_streams() {
        let slots = Arc::new(StreamSlots::default());
        let account = Uuid::new_v4();
        let mut held: Vec<StreamSlot> = (0..MAX_STREAMS_PER_ACCOUNT)
            .map(|_| slots.acquire(account).expect("slot"))
            .collect();
        assert!(slots.acquire(account).is_none());
        assert!(slots.acquire(Uuid::new_v4()).is_some());
        held.pop();
        assert!(slots.acquire(account).is_some());
        drop(held);
        assert!(slots.open.lock().expect("lock").is_empty());
    }
}
