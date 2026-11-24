//! Public-demo limits: an in-memory sliding-window rate limiter keyed by a salted hash of the client address
//! (the address itself is never stored), and the daily model-call cap backed by `usage_daily`.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use sqlx::PgPool;

use crate::clock::Clock;

pub const WINDOW: Duration = Duration::from_secs(600);
const SWEEP_AT: usize = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Bucket {
    /// `POST /visits`
    Visits,
    /// `POST /visits/{id}/messages`
    Messages,
    /// Other patient POSTs: refill-check, submit, handoff.
    Actions,
    /// `GET /visits/{id}` (anti-enumeration).
    Reads,
    /// `POST /auth/login`
    Login,
}

pub type ClientKey = [u8; 16];

pub struct Limiter {
    salt: [u8; 16],
    hits: Mutex<HashMap<(Bucket, ClientKey), VecDeque<Instant>>>,
}

impl Default for Limiter {
    fn default() -> Self {
        Self::new()
    }
}

impl Limiter {
    pub fn new() -> Self {
        let mut salt = [0u8; 16];
        rand::fill(&mut salt[..]);
        Self {
            salt,
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// Salted hash of the client address; the salt changes on every restart.
    pub fn key(&self, address: &str) -> ClientKey {
        let mut hasher = Sha256::new();
        hasher.update(self.salt);
        hasher.update(address.as_bytes());
        let digest = hasher.finalize();
        let mut key = [0u8; 16];
        key.copy_from_slice(&digest[..16]);
        key
    }

    /// Counts one event, or returns the seconds to wait. Blocked attempts are not counted.
    pub fn check(&self, bucket: Bucket, key: ClientKey, max: u32) -> Result<(), u64> {
        self.check_at(bucket, key, max, WINDOW, Instant::now())
    }

    pub fn check_at(
        &self,
        bucket: Bucket,
        key: ClientKey,
        max: u32,
        window: Duration,
        now: Instant,
    ) -> Result<(), u64> {
        let mut map = self
            .hits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if map.len() > SWEEP_AT {
            map.retain(|_, hits| {
                hits.back()
                    .is_some_and(|last| now.duration_since(*last) < window)
            });
        }
        let hits = map.entry((bucket, key)).or_default();
        while hits
            .front()
            .is_some_and(|first| now.duration_since(*first) >= window)
        {
            hits.pop_front();
        }
        if hits.len() >= max as usize {
            let oldest = hits.front().copied().unwrap_or(now);
            let wait = window.saturating_sub(now.duration_since(oldest));
            return Err(wait.as_secs().max(1));
        }
        hits.push_back(now);
        Ok(())
    }
}

/// Model calls made today (Taipei day), all models together.
pub async fn calls_today(db: &PgPool, clock: &Clock) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COALESCE(SUM(calls), 0)::bigint FROM usage_daily WHERE day = $1")
        .bind(clock.today())
        .fetch_one(db)
        .await
}

/// Adds one model call (and its tokens) to today's row for `model`.
pub async fn record_call(
    db: &PgPool,
    clock: &Clock,
    model: &str,
    input_tokens: i64,
    output_tokens: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO usage_daily (day, model, calls, input_tokens, output_tokens) VALUES ($1, $2, 1, $3, $4)
         ON CONFLICT (day, model) DO UPDATE SET calls = usage_daily.calls + 1,
             input_tokens = usage_daily.input_tokens + EXCLUDED.input_tokens,
             output_tokens = usage_daily.output_tokens + EXCLUDED.output_tokens",
    )
    .bind(clock.today())
    .bind(model)
    .bind(input_tokens)
    .bind(output_tokens)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEN_MINUTES: Duration = Duration::from_secs(600);

    #[test]
    fn allows_up_to_the_limit_then_blocks_with_a_wait_time() {
        let limiter = Limiter::new();
        let key = limiter.key("203.0.113.9");
        let t0 = Instant::now();
        for i in 0..3 {
            assert!(
                limiter
                    .check_at(
                        Bucket::Messages,
                        key,
                        3,
                        TEN_MINUTES,
                        t0 + Duration::from_secs(i)
                    )
                    .is_ok()
            );
        }
        let wait = limiter
            .check_at(
                Bucket::Messages,
                key,
                3,
                TEN_MINUTES,
                t0 + Duration::from_secs(10),
            )
            .expect_err("blocked");
        assert!((589..=600).contains(&wait), "wait {wait}");
    }

    #[test]
    fn the_window_slides() {
        let limiter = Limiter::new();
        let key = limiter.key("a");
        let t0 = Instant::now();
        assert!(
            limiter
                .check_at(Bucket::Visits, key, 2, TEN_MINUTES, t0)
                .is_ok()
        );
        assert!(
            limiter
                .check_at(
                    Bucket::Visits,
                    key,
                    2,
                    TEN_MINUTES,
                    t0 + Duration::from_secs(300)
                )
                .is_ok()
        );
        assert!(
            limiter
                .check_at(
                    Bucket::Visits,
                    key,
                    2,
                    TEN_MINUTES,
                    t0 + Duration::from_secs(301)
                )
                .is_err()
        );
        // The first event has aged out after 10 minutes, so one slot is free again.
        assert!(
            limiter
                .check_at(
                    Bucket::Visits,
                    key,
                    2,
                    TEN_MINUTES,
                    t0 + Duration::from_secs(601)
                )
                .is_ok()
        );
        assert!(
            limiter
                .check_at(
                    Bucket::Visits,
                    key,
                    2,
                    TEN_MINUTES,
                    t0 + Duration::from_secs(602)
                )
                .is_err()
        );
    }

    #[test]
    fn blocked_attempts_do_not_extend_the_block() {
        let limiter = Limiter::new();
        let key = limiter.key("a");
        let t0 = Instant::now();
        assert!(
            limiter
                .check_at(Bucket::Login, key, 1, TEN_MINUTES, t0)
                .is_ok()
        );
        for s in 1..50 {
            assert!(
                limiter
                    .check_at(
                        Bucket::Login,
                        key,
                        1,
                        TEN_MINUTES,
                        t0 + Duration::from_secs(s)
                    )
                    .is_err()
            );
        }
        assert!(
            limiter
                .check_at(
                    Bucket::Login,
                    key,
                    1,
                    TEN_MINUTES,
                    t0 + Duration::from_secs(601)
                )
                .is_ok()
        );
    }

    #[test]
    fn buckets_and_clients_are_independent() {
        let limiter = Limiter::new();
        let (a, b) = (limiter.key("a"), limiter.key("b"));
        let t0 = Instant::now();
        assert!(
            limiter
                .check_at(Bucket::Messages, a, 1, TEN_MINUTES, t0)
                .is_ok()
        );
        assert!(
            limiter
                .check_at(Bucket::Messages, a, 1, TEN_MINUTES, t0)
                .is_err()
        );
        assert!(
            limiter
                .check_at(Bucket::Messages, b, 1, TEN_MINUTES, t0)
                .is_ok(),
            "another client"
        );
        assert!(
            limiter
                .check_at(Bucket::Visits, a, 1, TEN_MINUTES, t0)
                .is_ok(),
            "another bucket"
        );
    }

    #[test]
    fn keys_are_salted_per_limiter_and_never_the_address() {
        let (one, two) = (Limiter::new(), Limiter::new());
        assert_eq!(one.key("203.0.113.9"), one.key("203.0.113.9"));
        assert_ne!(one.key("203.0.113.9"), two.key("203.0.113.9"));
        assert_ne!(one.key("203.0.113.9"), one.key("203.0.113.10"));
    }
}
