//! Public-demo limits: an in-memory sliding-window rate limiter keyed by a salted hash of the client address
//! (the address itself is never stored), and the daily model-call cap backed by `usage_daily`.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use sqlx::PgPool;
use time::Date;

use crate::clock::Clock;

pub const WINDOW: Duration = Duration::from_secs(600);
/// Expired entries are swept at least this often, and whenever the map passes `SWEEP_AT` entries.
const SWEEP_EVERY: Duration = Duration::from_secs(60);
const SWEEP_AT: usize = 2_000;
/// Under pressure (many entries) a sweep may run this often, so a flood cannot make every request scan the map.
const SWEEP_BUSY: Duration = Duration::from_secs(5);
/// Hard ceiling on tracked (bucket, client) pairs. A new client past it is told to wait, so memory stays bounded
/// even when an attacker rotates addresses.
const MAX_ENTRIES: usize = 20_000;
const MAX_CLIENT_DAYS: usize = 50_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Bucket {
    /// `POST /visits`
    Visits,
    /// `POST /visits/{id}/messages`
    Messages,
    /// Other patient POSTs: refill-check, submit, handoff.
    Actions,
    /// `POST /auth/login`
    Login,
    /// `POST /auth/guest`, `/auth/register` and `/auth/claim`
    Guest,
    /// Every other change (autosave, settings, staff actions): a wide limit against runaway clients.
    Writes,
}

pub type ClientKey = [u8; 16];

struct Inner {
    hits: HashMap<(Bucket, ClientKey), VecDeque<Instant>>,
    last_sweep: Instant,
    /// Model calls per client and Taipei day (kept in memory only, like the rate limits).
    calls: HashMap<(ClientKey, Date), u32>,
}

pub struct Limiter {
    salt: [u8; 16],
    inner: Mutex<Inner>,
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
            inner: Mutex::new(Inner {
                hits: HashMap::new(),
                last_sweep: Instant::now(),
                calls: HashMap::new(),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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
        let mut inner = self.lock();
        let since_sweep = now.duration_since(inner.last_sweep);
        if since_sweep >= SWEEP_EVERY || (inner.hits.len() > SWEEP_AT && since_sweep >= SWEEP_BUSY)
        {
            inner.hits.retain(|_, hits| {
                hits.back()
                    .is_some_and(|last| now.duration_since(*last) < window)
            });
            inner.last_sweep = now;
        }
        if inner.hits.len() >= MAX_ENTRIES && !inner.hits.contains_key(&(bucket, key)) {
            return Err(60);
        }
        let hits = inner.hits.entry((bucket, key)).or_default();
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

    /// Model calls this client has cost today.
    pub fn client_calls(&self, key: ClientKey, day: Date) -> u32 {
        self.lock().calls.get(&(key, day)).copied().unwrap_or(0)
    }

    /// Adds `n` model calls (every attempt counts, failed ones too) to this client's day.
    pub fn add_client_calls(&self, key: ClientKey, day: Date, n: u32) {
        let mut inner = self.lock();
        if inner.calls.len() >= MAX_CLIENT_DAYS || inner.calls.keys().any(|(_, d)| *d != day) {
            inner.calls.retain(|(_, d), _| *d == day);
        }
        if inner.calls.len() < MAX_CLIENT_DAYS {
            *inner.calls.entry((key, day)).or_insert(0) += n;
        }
    }

    #[cfg(test)]
    fn tracked(&self) -> usize {
        self.lock().hits.len()
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
    cost_usd: f64,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO usage_daily (day, model, calls, input_tokens, output_tokens, cost_usd) VALUES ($1, $2, 1, $3, $4, $5)
         ON CONFLICT (day, model) DO UPDATE SET calls = usage_daily.calls + 1,
             input_tokens = usage_daily.input_tokens + EXCLUDED.input_tokens,
             output_tokens = usage_daily.output_tokens + EXCLUDED.output_tokens,
             cost_usd = usage_daily.cost_usd + EXCLUDED.cost_usd",
    )
    .bind(clock.today())
    .bind(model)
    .bind(input_tokens)
    .bind(output_tokens)
    .bind(cost_usd)
    .execute(db)
    .await?;
    Ok(())
}

/// Spending since the first day of the Taipei month, at the prices that applied when each call was made.
pub async fn spent_this_month(db: &PgPool, clock: &Clock) -> sqlx::Result<f64> {
    let today = clock.today();
    let first = Date::from_calendar_date(today.year(), today.month(), 1).unwrap_or(today);
    sqlx::query_scalar("SELECT COALESCE(SUM(cost_usd), 0)::float8 FROM usage_daily WHERE day >= $1")
        .bind(first)
        .fetch_one(db)
        .await
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
    fn expired_entries_are_swept_and_the_map_stays_bounded() {
        let limiter = Limiter::new();
        let t0 = Instant::now();
        for i in 0..50u32 {
            let key = limiter.key(&format!("client-{i}"));
            assert!(
                limiter
                    .check_at(Bucket::Writes, key, 5, TEN_MINUTES, t0)
                    .is_ok()
            );
        }
        assert_eq!(limiter.tracked(), 50);
        // A minute later the sweep runs, but nothing has expired yet.
        let key = limiter.key("late");
        assert!(
            limiter
                .check_at(
                    Bucket::Writes,
                    key,
                    5,
                    TEN_MINUTES,
                    t0 + Duration::from_secs(61)
                )
                .is_ok()
        );
        assert_eq!(limiter.tracked(), 51);
        // After the window the old clients are dropped by the next sweep.
        assert!(
            limiter
                .check_at(
                    Bucket::Writes,
                    key,
                    5,
                    TEN_MINUTES,
                    t0 + Duration::from_secs(700)
                )
                .is_ok()
        );
        assert_eq!(limiter.tracked(), 1);
    }

    #[test]
    fn a_flood_of_new_clients_hits_the_hard_cap() {
        let limiter = Limiter::new();
        let t0 = Instant::now();
        let mut refused = 0;
        for i in 0..(MAX_ENTRIES + 50) {
            let key = limiter.key(&format!("flood-{i}"));
            if limiter
                .check_at(Bucket::Visits, key, 1, TEN_MINUTES, t0)
                .is_err()
            {
                refused += 1;
            }
        }
        assert_eq!(refused, 50);
        assert!(limiter.tracked() <= MAX_ENTRIES);
        // A client already tracked is still served by its own bucket.
        let known = limiter.key("flood-0");
        assert!(
            limiter
                .check_at(Bucket::Visits, known, 1, TEN_MINUTES, t0)
                .is_err(),
            "its own limit, not the cap"
        );
    }

    #[test]
    fn per_client_daily_calls_count_and_reset_on_a_new_day() {
        let limiter = Limiter::new();
        let (a, b) = (limiter.key("a"), limiter.key("b"));
        let day = time::macros::date!(2026 - 11 - 25);
        let next = time::macros::date!(2026 - 11 - 26);
        assert_eq!(limiter.client_calls(a, day), 0);
        limiter.add_client_calls(a, day, 2);
        limiter.add_client_calls(a, day, 1);
        limiter.add_client_calls(b, day, 5);
        assert_eq!(
            (limiter.client_calls(a, day), limiter.client_calls(b, day)),
            (3, 5)
        );
        assert_eq!(limiter.client_calls(a, next), 0);
        limiter.add_client_calls(a, next, 1);
        assert_eq!(
            limiter.client_calls(b, day),
            0,
            "yesterday's counters are dropped"
        );
        assert_eq!(limiter.client_calls(a, next), 1);
    }

    #[test]
    fn keys_are_salted_per_limiter_and_never_the_address() {
        let (one, two) = (Limiter::new(), Limiter::new());
        assert_eq!(one.key("203.0.113.9"), one.key("203.0.113.9"));
        assert_ne!(one.key("203.0.113.9"), two.key("203.0.113.9"));
        assert_ne!(one.key("203.0.113.9"), one.key("203.0.113.10"));
    }
}
