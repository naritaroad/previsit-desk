//! Deterministic clean-up of model replies after `output_guard`, and a style report used by the eval runner.
//!
//! The assistant should sound like a calm intake nurse: plain sentences, no markdown, no emoji, no exclamation
//! marks, no stock closers. The prompt asks for that; this step makes it hold even when the model slips.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

use crate::types::Locale;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("style pattern")
}

static FENCE: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^\s*```[a-zA-Z0-9]*\s*$"));
static HEADING: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^\s{0,3}#{1,6}\s*"));
static BOLD_STAR: LazyLock<Regex> = LazyLock::new(|| re(r"\*\*([^*\n]+?)\*\*"));
static BOLD_UNDERSCORE: LazyLock<Regex> = LazyLock::new(|| re(r"__([^_\n]+?)__"));
static ITALIC_STAR: LazyLock<Regex> = LazyLock::new(|| re(r"\*([^*\s][^*\n]*?)\*"));
static LINK: LazyLock<Regex> = LazyLock::new(|| re(r"\[([^\]\n]+)\]\(([^)\s]+)\)"));
static BLOCKQUOTE: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^\s*>\s?"));
static LIST_LINE: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^\s*(?:[-*•·▪●○◦]|\d{1,2}[.)、）]|[①②③④⑤⑥⑦⑧⑨⑩]|[（(]\d{1,2}[)）])\s*(.+?)\s*$")
});
static BLANK_RUNS: LazyLock<Regex> = LazyLock::new(|| re(r"\n{3,}"));
static EXCLAIM_RUNS: LazyLock<Regex> = LazyLock::new(|| re(r"。{2,}"));
static LEADING_FILLER: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)^(?:感謝您的分享|謝謝您的分享|謝謝您告訴我這些|感謝您提供這些資訊|好的，我了解了|我了解了|了解了|了解|明白了|thank you for sharing(?: that)?|i understand(?: your concern)?|great|certainly|sure|of course|absolutely)[，。,.!！\s]+",
    )
});
static CLOSERS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        re(r"^希望(這些|以上|這樣|這)[^。！？]{0,14}有(所)?幫助"),
        re(
            r"^(如果|若)(您|你)?(還)?有(其他|任何|別的)?[^。！？，]{0,10}(問題|疑問|想問|想了解)[^。！？]{0,16}(隨時|歡迎|請)[^。！？]*",
        ),
        re(
            r"^(有任何|若有任何|如有任何)[^。！？，]{0,10}(問題|疑問)[^。！？]{0,16}(隨時|歡迎|請)[^。！？]*",
        ),
        re(r"^歡迎(您)?(隨時)?[^。！？]{0,12}(提問|詢問|問我|告訴我)"),
        re(r"^(祝|願)(您|你)[^。！？]{0,12}(康復|健康|順利|平安)"),
        re(r"^(謝謝|感謝)(您|你)的(分享|耐心|配合|回答|提供)"),
        re(r"^我(很|非常)?(樂意|隨時)[^。！？]{0,10}(協助|幫忙|幫助)"),
        re(
            r"(?i)^(i hope this helps|feel free to (ask|reach out)|let me know if you have (any|more) questions|if you have any (other |more )?questions|take care|wishing you)",
        ),
    ]
});

fn is_emoji(c: char) -> bool {
    matches!(c, '\u{1F000}'..='\u{1FAFF}' | '\u{2600}'..='\u{27BF}' | '\u{FE0F}' | '\u{200D}' | '\u{2B50}' | '\u{2B06}' | '\u{2B07}' | '\u{2B1B}' | '\u{2B1C}' | '\u{231A}'..='\u{23FF}')
}

/// Drops emoji and decorative tildes (`～`, and `~` unless it sits between digits as in `3~5`).
fn strip_decoration(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, c) in chars.iter().enumerate() {
        if is_emoji(*c) {
            continue;
        }
        if *c == '～' || *c == '~' {
            let between_digits = i > 0
                && chars[i - 1].is_ascii_digit()
                && chars.get(i + 1).is_some_and(|n| n.is_ascii_digit());
            if !between_digits {
                continue;
            }
        }
        out.push(*c);
    }
    out
}

/// Sentences keeping their terminators (CJK and ASCII sentence marks, line breaks).
fn sentences(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut current = String::new();
    for (i, c) in chars.iter().enumerate() {
        current.push(*c);
        let ends = match c {
            '。' | '？' | '?' | '\n' => true,
            '.' => chars.get(i + 1).is_none_or(|n| n.is_whitespace()),
            _ => false,
        };
        if ends {
            out.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn ends_with_punctuation(text: &str) -> bool {
    text.chars().last().is_some_and(|c| {
        matches!(
            c,
            '。' | '？' | '！' | '?' | '!' | '.' | '；' | ';' | '，' | ',' | '、' | '：' | ':'
        )
    })
}

/// Joins runs of list lines into one plain paragraph; other lines stay as they are.
fn flatten_lists(text: &str, locale: Locale) -> String {
    let mut lines_out: Vec<String> = Vec::new();
    let mut pending: Vec<String> = Vec::new();
    let flush = |pending: &mut Vec<String>, lines_out: &mut Vec<String>| {
        if pending.is_empty() {
            return;
        }
        lines_out.push(pending.join(if locale.is_en() { " " } else { "" }));
        pending.clear();
    };
    for line in text.lines() {
        if let Some(caps) = LIST_LINE.captures(line) {
            let mut item = caps[1].to_string();
            if !ends_with_punctuation(&item) {
                item.push(if locale.is_en() { '.' } else { '。' });
            }
            pending.push(item);
        } else {
            flush(&mut pending, &mut lines_out);
            lines_out.push(line.trim_end().to_string());
        }
    }
    flush(&mut pending, &mut lines_out);
    lines_out.join("\n")
}

/// Removes trailing stock closers, but never the last remaining sentence.
fn drop_closers(text: &str) -> String {
    let mut parts = sentences(text);
    while parts.len() > 1 {
        let last = parts.last().map(|s| s.trim()).unwrap_or("");
        if last.is_empty() {
            parts.pop();
            continue;
        }
        if CLOSERS.iter().any(|c| c.is_match(last)) {
            parts.pop();
        } else {
            break;
        }
    }
    parts.concat().trim_end().to_string()
}

pub fn style_cleanup(text: &str, locale: Locale) -> String {
    let mut s = text.replace("\r\n", "\n").replace(r"\n", "\n");
    s = FENCE.replace_all(&s, "").into_owned();
    s = s.replace('`', "");
    s = HEADING.replace_all(&s, "").into_owned();
    s = BLOCKQUOTE.replace_all(&s, "").into_owned();
    s = LINK.replace_all(&s, "$1").into_owned();
    s = BOLD_STAR.replace_all(&s, "$1").into_owned();
    s = BOLD_UNDERSCORE.replace_all(&s, "$1").into_owned();
    s = ITALIC_STAR.replace_all(&s, "$1").into_owned();
    s = flatten_lists(&s, locale);
    s = strip_decoration(&s);
    s = s
        .replace('！', "。")
        .replace('!', if locale.is_en() { "." } else { "。" });
    s = s.replace("。？", "？").replace("？。", "？");
    s = EXCLAIM_RUNS.replace_all(&s, "。").into_owned();
    // Strip an acknowledgement opener only when something follows it.
    if let Some(m) = LEADING_FILLER.find(&s)
        && s[m.end()..].trim().chars().count() >= 4
    {
        s = s[m.end()..].to_string();
    }
    s = drop_closers(&s);
    s = s.lines().map(str::trim_end).collect::<Vec<_>>().join("\n");
    s = BLANK_RUNS.replace_all(&s, "\n\n").into_owned();
    s.trim().to_string()
}

// ---------------------------------------------------------------------------
// Style report (eval)
// ---------------------------------------------------------------------------

const BOILERPLATE: &[&str] = &[
    "希望這些資訊對您有幫助",
    "希望這些對您有幫助",
    "歡迎隨時",
    "作為 AI",
    "作為一個 AI",
    "作為一個人工智慧",
    "感謝您的分享",
    "謝謝您的分享",
    "我很抱歉聽到",
    "很抱歉聽到",
    "如果還有其他問題",
    "如果您還有其他問題",
    "請隨時告訴我",
    "i understand your concern",
    "i hope this helps",
    "feel free to ask",
    "as an ai",
    "certainly!",
    "great!",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StyleReport {
    pub markdown: bool,
    pub emoji: bool,
    pub exclamation: bool,
    pub question_marks: usize,
    pub cjk_chars: usize,
    pub boilerplate: Vec<String>,
    /// More than two question marks, or more than 160 CJK characters: a soft warning only.
    pub too_long_or_many_questions: bool,
}

static MARKDOWN_MARKS: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?m)\*\*|__|^\s{0,3}#{1,6}\s|`|\[[^\]\n]+\]\([^)\s]+\)|^\s*>\s"));

pub fn style_report(text: &str) -> StyleReport {
    let markdown = MARKDOWN_MARKS.is_match(text) || text.lines().any(|l| LIST_LINE.is_match(l));
    let cjk_chars = text
        .chars()
        .filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c))
        .count();
    let question_marks = text.chars().filter(|c| matches!(c, '？' | '?')).count();
    let lower = text.to_lowercase();
    let boilerplate: Vec<String> = BOILERPLATE
        .iter()
        .filter(|p| lower.contains(&p.to_lowercase()))
        .map(|p| p.to_string())
        .collect();
    StyleReport {
        markdown,
        emoji: text.chars().any(is_emoji),
        exclamation: text.contains('！') || text.contains('!'),
        question_marks,
        cjk_chars,
        boilerplate,
        too_long_or_many_questions: question_marks > 2 || cjk_chars > 160,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zh(text: &str) -> String {
        style_cleanup(text, Locale::ZhTw)
    }

    #[test]
    fn markdown_markers_are_removed_and_the_words_stay() {
        assert_eq!(zh("**請問**咳嗽幾天了？"), "請問咳嗽幾天了？");
        assert_eq!(zh("## 摘要\n咳嗽三天"), "摘要\n咳嗽三天");
        assert_eq!(
            zh("請看 [衛教手冊](https://example.com/a) 的說明"),
            "請看 衛教手冊 的說明"
        );
        assert_eq!(zh("這是*重點*喔"), "這是重點喔");
        assert_eq!(zh("用 `record` 記下"), "用 record 記下");
        assert_eq!(zh("> 引用的話"), "引用的話");
    }

    #[test]
    fn list_lines_become_plain_sentences() {
        assert_eq!(
            zh("您目前的狀況：\n- 咳嗽三天\n- 晚上比較嚴重\n- 沒有發燒\n請問平常有吃藥嗎？"),
            "您目前的狀況：\n咳嗽三天。晚上比較嚴重。沒有發燒。\n請問平常有吃藥嗎？"
        );
        assert_eq!(
            zh("1. 發作時間\n2) 嚴重程度\n3、有沒有發燒？"),
            "發作時間。嚴重程度。有沒有發燒？"
        );
        assert_eq!(
            style_cleanup("* cough for three days\n* worse at night", Locale::En),
            "cough for three days. worse at night."
        );
    }

    #[test]
    fn emoji_and_tildes_are_stripped_but_number_ranges_survive() {
        assert_eq!(zh("好的😊 我記下來了✨～"), "好的 我記下來了");
        assert_eq!(zh("大概痛 3~5 天"), "大概痛 3~5 天");
        assert_eq!(zh("請放心～"), "請放心");
    }

    #[test]
    fn exclamation_marks_become_full_stops() {
        assert_eq!(zh("好的！我記下來了！"), "好的。我記下來了。");
        assert_eq!(zh("沒問題!請繼續"), "沒問題。請繼續");
        assert_eq!(
            style_cleanup("Got it! Next question.", Locale::En),
            "Got it. Next question."
        );
        assert_eq!(zh("真的嗎！？"), "真的嗎？");
        assert_eq!(zh("好！！！"), "好。");
    }

    #[test]
    fn leading_acknowledgement_fillers_are_dropped_only_when_text_follows() {
        assert_eq!(
            zh("了解，咳嗽三天、晚上比較嚴重。平常有在吃藥嗎？"),
            "咳嗽三天、晚上比較嚴重。平常有在吃藥嗎？"
        );
        assert_eq!(
            zh("感謝您的分享，請問從什麼時候開始的？"),
            "請問從什麼時候開始的？"
        );
        assert_eq!(zh("了解"), "了解", "never empties the reply");
        assert_eq!(
            style_cleanup("Certainly, how long has it lasted?", Locale::En),
            "how long has it lasted?"
        );
    }

    #[test]
    fn stock_closers_are_removed_from_the_end_only() {
        assert_eq!(
            zh("咳嗽三天，我記下來了。希望這些資訊對您有幫助。"),
            "咳嗽三天，我記下來了。"
        );
        assert_eq!(
            zh("您的摘要整理好了。如果您還有其他問題，歡迎隨時告訴我。"),
            "您的摘要整理好了。"
        );
        assert_eq!(
            zh("好，我記下了。有任何問題，請隨時詢問。祝您早日康復。"),
            "好，我記下了。"
        );
        assert_eq!(
            style_cleanup(
                "Noted the cough. Feel free to ask me anything else.",
                Locale::En
            ),
            "Noted the cough."
        );
        // A question that happens to start similarly is a real intake question and stays.
        assert_eq!(
            zh("如果還有其他不舒服，請告訴我。"),
            "如果還有其他不舒服，請告訴我。"
        );
        assert_eq!(
            zh("如果有其他症狀，也請說一聲。"),
            "如果有其他症狀，也請說一聲。"
        );
        // Closers in the middle are not touched.
        assert_eq!(
            zh("歡迎隨時問。接下來請問您幾歲？"),
            "歡迎隨時問。接下來請問您幾歲？"
        );
    }

    #[test]
    fn plain_replies_pass_through_unchanged() {
        for text in [
            "好，咳嗽三天、晚上比較嚴重。平常有在吃什麼藥嗎？對藥物或食物過敏的話也告訴我一聲。",
            "我先記下來。胸口悶是整天都悶，還是一陣一陣的？",
            "主訴：咳嗽三天\n發作時間：三天前\n嚴重程度：4 分\n請問這樣正確嗎？",
        ] {
            assert_eq!(zh(text), text);
        }
    }

    #[test]
    fn literal_backslash_n_becomes_a_line_break() {
        assert_eq!(zh(r"第一行\n第二行"), "第一行\n第二行");
    }

    #[test]
    fn report_flags_what_cleanup_should_have_removed() {
        let clean = style_report("好，咳嗽三天。平常有在吃藥嗎？");
        assert!(
            !clean.markdown
                && !clean.emoji
                && !clean.exclamation
                && clean.boilerplate.is_empty()
                && !clean.too_long_or_many_questions
        );
        let messy = style_report("**好**！😊 希望這些資訊對您有幫助。");
        assert!(messy.markdown && messy.emoji && messy.exclamation);
        assert_eq!(messy.boilerplate, vec!["希望這些資訊對您有幫助"]);
        assert!(style_report("一？二？三？").too_long_or_many_questions);
        assert!(style_report(&"痛".repeat(161)).too_long_or_many_questions);
        assert!(style_report("- 項目一\n- 項目二").markdown);
        // After cleanup the markdown and emoji checks are clean.
        let fixed = style_report(&zh("**好**！😊\n- 一\n- 二"));
        assert!(!fixed.markdown && !fixed.emoji);
    }
}
