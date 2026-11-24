//! One clock for the whole service, fixed to Asia/Taipei (UTC+8, no daylight saving).
//! Refill dates, ticket-number days, the daily model-call cap and the retention cut-off all read it,
//! and tests inject a fixed instant.

use time::{Date, Duration, OffsetDateTime, UtcOffset};

#[derive(Debug, Clone, Copy)]
pub struct Clock {
    fixed: Option<OffsetDateTime>,
}

fn taipei() -> UtcOffset {
    UtcOffset::from_hms(8, 0, 0).expect("valid offset")
}

impl Clock {
    pub fn system() -> Self {
        Self { fixed: None }
    }

    /// A clock stuck at `instant` (tests, eval replays).
    #[allow(dead_code)]
    pub fn fixed(instant: OffsetDateTime) -> Self {
        Self {
            fixed: Some(instant),
        }
    }

    pub fn now(&self) -> OffsetDateTime {
        self.fixed.unwrap_or_else(OffsetDateTime::now_utc)
    }

    /// Calendar date in Taiwan.
    pub fn today(&self) -> Date {
        self.now().to_offset(taipei()).date()
    }

    pub fn retention_cutoff(&self, days: i64) -> OffsetDateTime {
        self.now() - Duration::days(days)
    }
}

pub fn format_date(date: Date) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

pub fn parse_date(text: &str) -> Option<Date> {
    Date::parse(
        text.trim(),
        time::macros::format_description!("[year]-[month]-[day]"),
    )
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn taipei_day_rolls_over_eight_hours_before_utc() {
        // 17:00 UTC on 11-24 is already 01:00 on 11-25 in Taipei.
        let clock = Clock::fixed(datetime!(2026-11-24 17:00 UTC));
        assert_eq!(format_date(clock.today()), "2026-11-25");
        let clock = Clock::fixed(datetime!(2026-11-24 15:59 UTC));
        assert_eq!(format_date(clock.today()), "2026-11-24");
    }

    #[test]
    fn dates_parse_and_format() {
        let d = parse_date("2026-02-03").expect("date");
        assert_eq!(format_date(d), "2026-02-03");
        assert!(parse_date("2026-13-01").is_none());
        assert!(parse_date("20260203").is_none());
    }

    #[test]
    fn retention_cutoff_subtracts_days() {
        let clock = Clock::fixed(datetime!(2026-11-25 00:00 UTC));
        assert_eq!(clock.retention_cutoff(14), datetime!(2026-11-11 00:00 UTC));
    }
}
