//! Masks identifiers in patient text before it is stored or sent to a model (backend-spec §13.4):
//! Taiwan ID numbers, mobile and landline numbers, email addresses and any run of 8 or more digits.
//! Names cannot be detected reliably; the interface tells patients not to type them.

use std::sync::LazyLock;

use regex::Regex;

pub const MASK: &str = "【已遮蔽】";

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Masked {
    pub text: String,
    pub count: usize,
    pub kinds: Vec<&'static str>,
}

struct Pattern {
    kind: &'static str,
    regex: Regex,
}

fn compile(kind: &'static str, pattern: &str) -> Pattern {
    Pattern {
        kind,
        regex: Regex::new(pattern).expect("pii pattern"),
    }
}

// Order matters: the most specific shapes first, the generic digit run last.
static PATTERNS: LazyLock<Vec<Pattern>> = LazyLock::new(|| {
    vec![
        compile("email", r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"),
        // ASCII word boundaries, so "身分證A123456789" (no space after a CJK character) still matches.
        compile("id_number", r"(?i)(?-u:\b)[A-Z][12]\d{8}(?-u:\b)"),
        compile("mobile", r"(?-u:\b)09\d{2}[- ]?\d{3}[- ]?\d{3}(?-u:\b)"),
        compile("landline", r"(?-u:\b)0\d{1,2}[- ]?\d{6,8}(?-u:\b)"),
        compile("long_number", r"\d{8,}"),
    ]
});

/// Replaces every match with [`MASK`] and reports what was found.
pub fn mask(text: &str) -> Masked {
    let mut out = text.to_string();
    let mut count = 0;
    let mut kinds: Vec<&'static str> = Vec::new();
    for pattern in PATTERNS.iter() {
        let hits = pattern.regex.find_iter(&out).count();
        if hits > 0 {
            count += hits;
            if !kinds.contains(&pattern.kind) {
                kinds.push(pattern.kind);
            }
            out = pattern.regex.replace_all(&out, MASK).into_owned();
        }
    }
    Masked {
        text: out,
        count,
        kinds,
    }
}

/// True when text still looks like it carries personal data (used on model-written text).
pub fn looks_personal(text: &str) -> bool {
    PATTERNS.iter().any(|p| p.regex.is_match(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_id_phone_email_and_long_numbers() {
        let m = mask(
            "我的身分證 A123456789，手機 0912-345-678，信箱 someone@example.com，健保卡 1234567890123",
        );
        assert_eq!(m.count, 4);
        assert!(
            !m.text.contains("A123456789")
                && !m.text.contains("0912")
                && !m.text.contains("example.com")
                && !m.text.contains("1234567890123")
        );
        assert_eq!(m.text.matches(MASK).count(), 4);
        assert!(
            m.kinds.contains(&"id_number")
                && m.kinds.contains(&"mobile")
                && m.kinds.contains(&"email")
                && m.kinds.contains(&"long_number")
        );
    }

    #[test]
    fn masks_landline_numbers() {
        let m = mask("電話 02-12345678 或 0225551234");
        assert_eq!(m.count, 2);
        assert!(m.kinds.contains(&"landline"));
    }

    #[test]
    fn leaves_ordinary_medical_numbers_alone() {
        for text in [
            "血壓 140/90，脈搏 88",
            "痛了 3 天，嚴重度 7 分",
            "我吃 500 毫克，一天三次",
            "2026-11-25 開的慢箋",
            "體溫 38.5 度",
            "I am 63 years old",
        ] {
            let m = mask(text);
            assert_eq!(m.count, 0, "{text}");
            assert_eq!(m.text, text);
        }
    }

    #[test]
    fn lowercase_id_letters_are_masked_too() {
        assert_eq!(mask("id f234567890").count, 1);
    }

    #[test]
    fn personal_check_flags_leftovers() {
        assert!(looks_personal("call me at 0912345678"));
        assert!(!looks_personal("頭痛三天"));
    }
}
