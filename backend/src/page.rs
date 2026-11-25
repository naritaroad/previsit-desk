//! Lists: `{items, next_cursor, total?}` with `cursor`, `limit` (30, at most 100) and `q` (contract, top).
//! Cursors are keyset positions `(sort time in microseconds, id)`, so rows added meanwhile never shift a page.

use std::collections::HashMap;

use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::texts::{T, t};
use crate::types::Locale;

#[derive(Debug, Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
}

impl<T> Page<T> {
    /// A list that always fits in one page.
    pub fn all(items: Vec<T>) -> Self {
        Self {
            items,
            next_cursor: None,
            total: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cursor {
    pub at: OffsetDateTime,
    pub id: Uuid,
}

impl Cursor {
    pub fn encode(&self) -> String {
        format!(
            "{}_{}",
            self.at.unix_timestamp_nanos() / 1000,
            self.id.simple()
        )
    }

    pub fn parse(text: &str) -> Option<Self> {
        let (micros, id) = text.split_once('_')?;
        Some(Self {
            at: OffsetDateTime::from_unix_timestamp_nanos(
                micros.parse::<i128>().ok()?.checked_mul(1000)?,
            )
            .ok()?,
            id: Uuid::parse_str(id).ok()?,
        })
    }
}

pub type Params = HashMap<String, String>;

pub fn param<'a>(params: &'a Params, name: &str) -> Option<&'a str> {
    params.get(name).map(|v| v.trim()).filter(|v| !v.is_empty())
}

pub fn limit(params: &Params) -> AppResult<i64> {
    limit_or(params, 30, 100)
}

pub fn limit_or(params: &Params, default: i64, max: i64) -> AppResult<i64> {
    match param(params, "limit") {
        None => Ok(default),
        Some(text) => text
            .parse::<i64>()
            .ok()
            .filter(|n| *n >= 1)
            .map(|n| n.min(max))
            .ok_or_else(|| AppError::field("limit", t(T::FieldErrPositive, Locale::ZhTw))),
    }
}

pub fn cursor(params: &Params) -> AppResult<Option<Cursor>> {
    match param(params, "cursor") {
        None => Ok(None),
        Some(text) => Cursor::parse(text)
            .map(Some)
            .ok_or_else(|| AppError::field("cursor", t(T::FieldErrChoice, Locale::ZhTw))),
    }
}

/// `%q%` for ILIKE with the wildcards in the text escaped.
pub fn like(params: &Params) -> Option<String> {
    param(params, "q").map(|q| {
        let q: String = q.chars().take(60).collect();
        format!("%{}%", escape_like(&q))
    })
}

pub fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Cuts a `limit + 1` fetch down to a page and makes the cursor of its last row.
pub fn cut<T>(mut items: Vec<T>, limit: i64, key: impl Fn(&T) -> Cursor) -> Page<T> {
    let more = items.len() as i64 > limit;
    items.truncate(limit as usize);
    let next_cursor = if more {
        items.last().map(|last| key(last).encode())
    } else {
        None
    };
    Page {
        items,
        next_cursor,
        total: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn cursors_round_trip_at_database_precision() {
        let c = Cursor {
            at: datetime!(2026-11-25 08:00:00.123456 UTC),
            id: Uuid::new_v4(),
        };
        assert_eq!(Cursor::parse(&c.encode()), Some(c));
        assert!(Cursor::parse("nope").is_none());
        assert!(Cursor::parse("12_zz").is_none());
    }

    #[test]
    fn limits_are_bounded() {
        let params = |v: &str| Params::from([("limit".to_string(), v.to_string())]);
        assert_eq!(limit(&Params::new()).expect("default"), 30);
        assert_eq!(limit(&params("500")).expect("cap"), 100);
        assert!(limit(&params("0")).is_err());
        assert!(limit(&params("x")).is_err());
    }

    #[test]
    fn a_full_page_hands_out_a_cursor_and_a_short_one_does_not() {
        let key = |n: &i64| Cursor {
            at: OffsetDateTime::from_unix_timestamp(*n).expect("time"),
            id: Uuid::nil(),
        };
        let page = cut(vec![3, 2, 1], 2, key);
        assert_eq!(page.items, vec![3, 2]);
        assert_eq!(
            Cursor::parse(page.next_cursor.as_deref().expect("cursor")),
            Some(key(&2))
        );
        assert!(cut(vec![1], 2, key).next_cursor.is_none());
    }

    #[test]
    fn like_patterns_are_escaped() {
        assert_eq!(escape_like("50%_off\\"), "50\\%\\_off\\\\");
    }
}
