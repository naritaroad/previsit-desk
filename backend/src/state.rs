use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use sqlx::PgPool;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use uuid::Uuid;

use crate::clock::Clock;
use crate::config::Config;
use crate::health_edu::Handbook;
use crate::limits::Limiter;
use crate::llm::Ai;
use crate::precheck::{RedFlagRules, ScopeRules};
use crate::refill::RefillRules;

/// Every rule file the service needs, loaded and validated at start.
pub struct Rules {
    pub red_flags: RedFlagRules,
    pub scope: ScopeRules,
    pub refill: RefillRules,
}

impl Rules {
    pub fn load(data_dir: &Path) -> Result<Self> {
        let seed = data_dir.join("seed");
        Ok(Self {
            red_flags: RedFlagRules::load(&seed.join("red_flags.csv"))?,
            scope: ScopeRules::load(&seed.join("scope_rules.csv"))?,
            refill: RefillRules::load(&seed.join("refill_rules.csv"))?,
        })
    }
}

/// One message at a time per visit: a second one while the first is running gets 409.
#[derive(Default)]
pub struct VisitLocks {
    inner: Mutex<HashMap<Uuid, Arc<AsyncMutex<()>>>>,
}

impl VisitLocks {
    pub fn try_acquire(&self, visit_id: Uuid) -> Option<OwnedMutexGuard<()>> {
        let mut map = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Entries nobody holds any more (only the map owns the Arc) can go.
        map.retain(|_, lock| Arc::strong_count(lock) > 1);
        let lock = map.entry(visit_id).or_default().clone();
        lock.try_lock_owned().ok()
    }
}

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub ai: Arc<Ai>,
    pub limiter: Arc<Limiter>,
    pub handbook: Arc<Handbook>,
    pub rules: Arc<Rules>,
    pub clock: Clock,
    pub visit_locks: Arc<VisitLocks>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_visit_can_be_held_by_one_message_at_a_time() {
        let locks = VisitLocks::default();
        let id = Uuid::new_v4();
        let first = locks.try_acquire(id).expect("first");
        assert!(
            locks.try_acquire(id).is_none(),
            "second message while the first runs"
        );
        assert!(
            locks.try_acquire(Uuid::new_v4()).is_some(),
            "another visit is independent"
        );
        drop(first);
        assert!(locks.try_acquire(id).is_some(), "free again");
    }
}
