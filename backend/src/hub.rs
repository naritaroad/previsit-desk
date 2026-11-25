//! In-process fan-out. Visit streams get a wake-up per persisted event (the log in `visit_events` is the truth),
//! and `GET /me/stream` gets account-level signals. One process serves the app, so a broadcast channel is enough.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::Value;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::perm::{Permission, Role};

/// Something that happened in a visit. `seq` is `None` for `message.delta`, which is never stored.
#[derive(Debug, Clone)]
pub struct VisitEvent {
    pub seq: Option<i64>,
    pub kind: String,
    pub data: Arc<Value>,
    pub staff_only: bool,
}

#[derive(Debug, Clone)]
pub enum Target {
    Account(Uuid),
    /// Every signed-in account whose role holds the permission.
    Permission(Permission),
}

#[derive(Debug, Clone)]
pub struct Signal {
    pub target: Target,
    pub kind: &'static str,
    pub data: Arc<Value>,
}

impl Signal {
    pub fn is_for(&self, account: Uuid, role: Role) -> bool {
        match &self.target {
            Target::Account(id) => *id == account,
            Target::Permission(p) => role.can(*p),
        }
    }
}

const VISIT_CAPACITY: usize = 256;
const SIGNAL_CAPACITY: usize = 1024;

pub struct Hub {
    visits: Mutex<HashMap<Uuid, broadcast::Sender<VisitEvent>>>,
    signals: broadcast::Sender<Signal>,
}

impl Default for Hub {
    fn default() -> Self {
        Self {
            visits: Mutex::new(HashMap::new()),
            signals: broadcast::channel(SIGNAL_CAPACITY).0,
        }
    }
}

impl Hub {
    fn lock(&self) -> MutexGuard<'_, HashMap<Uuid, broadcast::Sender<VisitEvent>>> {
        self.visits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn subscribe_visit(&self, visit_id: Uuid) -> broadcast::Receiver<VisitEvent> {
        let mut map = self.lock();
        // Channels nobody listens to any more can go.
        map.retain(|_, tx| tx.receiver_count() > 0);
        map.entry(visit_id)
            .or_insert_with(|| broadcast::channel(VISIT_CAPACITY).0)
            .subscribe()
    }

    pub fn publish_visit(&self, visit_id: Uuid, event: VisitEvent) {
        if let Some(tx) = self.lock().get(&visit_id) {
            let _ = tx.send(event);
        }
    }

    pub fn subscribe_signals(&self) -> broadcast::Receiver<Signal> {
        self.signals.subscribe()
    }

    /// Account-level event for `GET /me/stream`: `notification`, `visit.changed`, `rx.changed`.
    pub fn to_account(&self, account: Uuid, kind: &'static str, data: Value) {
        let _ = self.signals.send(Signal {
            target: Target::Account(account),
            kind,
            data: Arc::new(data),
        });
    }

    /// Account-level event for everyone who holds `permission`, typically `queue.changed`.
    pub fn to_permission(&self, permission: Permission, kind: &'static str, data: Value) {
        let _ = self.signals.send(Signal {
            target: Target::Permission(permission),
            kind,
            data: Arc::new(data),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn visit_events_reach_only_that_visits_followers() {
        let hub = Hub::default();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut rx_a = hub.subscribe_visit(a);
        let mut rx_b = hub.subscribe_visit(b);
        hub.publish_visit(
            a,
            VisitEvent {
                seq: Some(1),
                kind: "x".into(),
                data: Arc::new(json!({})),
                staff_only: false,
            },
        );
        assert_eq!(rx_a.recv().await.expect("event").seq, Some(1));
        assert!(rx_b.try_recv().is_err());
    }

    #[tokio::test]
    async fn unused_visit_channels_are_dropped() {
        let hub = Hub::default();
        let rx = hub.subscribe_visit(Uuid::new_v4());
        drop(rx);
        let _other = hub.subscribe_visit(Uuid::new_v4());
        assert_eq!(hub.lock().len(), 1);
    }

    #[test]
    fn signals_go_to_the_account_or_to_holders_of_the_permission() {
        let me = Uuid::new_v4();
        let direct = Signal {
            target: Target::Account(me),
            kind: "notification",
            data: Arc::new(json!({})),
        };
        assert!(direct.is_for(me, Role::Patient));
        assert!(!direct.is_for(Uuid::new_v4(), Role::Patient));
        let queue = Signal {
            target: Target::Permission(Permission::RxDispense),
            kind: "queue.changed",
            data: Arc::new(json!({})),
        };
        assert!(queue.is_for(me, Role::Pharmacist));
        assert!(!queue.is_for(me, Role::Patient));
        assert!(!queue.is_for(me, Role::Admin));
    }
}
