//! `output_guard`: checks what the model wrote before the patient sees it (diagnosis, doses, prescribing advice).
//!
//! Method: split the reply into sentences and clauses, flag clauses that make a diagnosis or give medicine advice,
//! drop the flagged sentences and add one fixed safe sentence. If nothing useful is left, replace the whole reply.
//! Allowed: restating a medicine or dose the patient said themselves, asking about medicines, and saying that a
//! doctor or pharmacist decides. Forbidden: advising ("建議您吃…", "可以加到…", "每天…mg") and naming a condition
//! ("您得的是…", "可能是…病", "診斷為…").

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

use crate::texts::{T, t};
use crate::types::Locale;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Violation {
    Diagnosis,
    Dosage,
    Prescribing,
}

impl Violation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Diagnosis => "diagnosis",
            Self::Dosage => "dosage",
            Self::Prescribing => "prescribing",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardAction {
    None,
    Rewritten,
    Replaced,
}

impl GuardAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Rewritten => "rewritten",
            Self::Replaced => "replaced",
        }
    }
}

#[derive(Debug, Clone)]
pub struct GuardReport {
    pub text: String,
    pub violations: Vec<Violation>,
    pub action: GuardAction,
}

impl GuardReport {
    pub fn passed(&self) -> bool {
        self.violations.is_empty()
    }
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("guard pattern")
}

const DISEASE_ZH: &str = r"(?:[一-龥]{1,3}炎|感冒|流感|中風|梗塞|梗死|潰瘍|結石|高血壓|低血壓|糖尿病|貧血|憂鬱症|焦慮症|恐慌症|失智症|氣喘|偏頭痛|癌|腫瘤|心臟病|心律不整|肺結核|帶狀皰疹|蕁麻疹|痛風|骨折|腦震盪|[一-龥]{1,3}症候群|過敏性[一-龥]{1,3})";
const MEDICINE_ACTION_ZH: &str = r"(?:吃|服用|服|使用|塗|貼|注射|加到|增加到|增加|減少|加量|減量|停藥|停用|換成|改成|改吃|多吃|少吃)";
const DOSE_UNIT: &str = r"(?:mg|毫克|公克|克|ml|毫升|cc|顆|粒|錠|片|包|膠囊|單位|iu|滴)";

static DEFER_ZH: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"無法|不能|不會|不可以|沒辦法|不做|不提供|不是醫師|不開|由醫師|醫師會|醫師將|請醫師|交給醫師|請教醫師|詢問醫師|問醫師|醫師判斷|醫師評估|醫師決定|請藥師|由藥師|藥師會|藥師說明|藥師確認|向醫師|跟醫師|和醫師|諮詢|醫師或藥師|藥師或醫師",
    )
});
/// Pointing at the screen ("您可以使用慢箋檢核表單") is not medicine advice.
static UI_ZH: LazyLock<Regex> =
    LazyLock::new(|| re(r"表單|慢箋檢核|按鈕|畫面|介面|頁面|功能|送出|填寫|開始新的"));
static QUESTION_ZH: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"嗎$|呢$|請問|有沒有|是否|有無|要不要|可不可以|能不能|什麼藥|哪些藥|哪種藥|有在(吃|服用|用)|有(吃|服用|用)|目前.{0,2}(在)?(吃|服用|用)|平常.{0,2}(吃|服用|用)|正在(吃|服用)|固定(吃|服用)|有沒",
    )
});
static DIAGNOSIS_ZH: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        re(&format!(
            r"(你|您|妳)[^，。]{{0,3}}(得的是|得了|是得了|可能是|應該是|很可能是|大概是|八成是|可能有|可能得了|可能患有|患有|罹患|可能罹患|看起來像是|看起來是|看起來像|屬於)[^，。]{{0,12}}{DISEASE_ZH}"
        )),
        re(r"診斷(為|是|結果是|出)"),
        re(&format!(
            r"這(是|像是|可能是|應該是|很可能是)[^，。]{{0,6}}{DISEASE_ZH}"
        )),
        re(&format!(
            r"(症狀|情況|狀況)(看起來)?(像|是|屬於|符合)[^，。]{{0,8}}{DISEASE_ZH}"
        )),
    ]
});
static DIAGNOSIS_HISTORY_ZH: LazyLock<Regex> = LazyLock::new(|| {
    re(r"被診斷|診斷過|曾.{0,3}診斷|是否.{0,6}診斷|有沒有.{0,6}診斷|醫師.{0,4}診斷|診斷書")
});
static ADVICE_ZH: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        re(&format!(
            r"(建議|可以先|可以試試|可以考慮|不妨|最好|應該|需要)(你|您)?[^，。]{{0,4}}{MEDICINE_ACTION_ZH}"
        )),
        re(&format!(
            r"(你|您)(可以|應該|最好|不妨|需要|得|要|可)(先|再)?[^，。]{{0,3}}{MEDICINE_ACTION_ZH}"
        )),
        re(
            r"(我|我們)(會|來|可以)?(幫您|幫你|替您|替你|為您|為你|給您|給你)?(開|開立|開給|處方)[^，。]{0,6}(藥|處方|抗生素|止痛|退燒|消炎|類固醇)",
        ),
        re(r"開給(你|您)|處方給(你|您)"),
    ]
});
static DOSE_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"(?:\d+(?:\.\d+)?|[一二兩三四五六七八九十半]+)\s?{DOSE_UNIT}"
    ))
});
static DOSE_CUE_ZH: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"每天|每日|每次|一天|一日|一次|每隔|每\d+小時|早晚|睡前|飯後|飯前|早上|晚上|三餐|\d+次|[一二兩三四五六七八九十]次",
    )
});

static DEFER_EN: LazyLock<Regex> = LazyLock::new(|| {
    re(r"cannot|can't|do not|don't|not able|unable|not a doctor|doctor|pharmacist|clinician")
});
static QUESTION_EN: LazyLock<Regex> =
    LazyLock::new(|| re(r"\?$|^(do|are|have|has|did|is|what|which|how long|any|can you tell)\b"));
static DIAGNOSIS_EN: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        re(r"\byou (may|might|probably|likely|could) (have|be suffering from)\b"),
        re(
            r"\byou (have|are suffering from|seem to have|appear to have|are having) (a |an |the )?(infection|flu|cold|cancer|diabetes|hypertension|migraine|pneumonia|ulcer|[a-z]+itis)\b",
        ),
        re(r"\b(my|the) diagnosis is\b|\bdiagnosed with\b"),
        re(
            r"\b(this|that|it) (is|sounds like|looks like) (probably |likely )?(a |an )?([a-z]+itis|infection|flu|cancer|migraine|pneumonia|diabetes)\b",
        ),
    ]
});
static ADVICE_EN: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        re(
            r"\b(i recommend|i suggest|you should|you can|you could|you may|try)\b[^,]{0,25}\b(take|taking|use|using|increase|reduce|stop|switch to)\b",
        ),
        re(r"\b(take|taking) \d"),
        re(r"\bi('ll| will)? (prescribe|write you a prescription)\b"),
    ]
});
static DOSE_EN: LazyLock<Regex> =
    LazyLock::new(|| re(r"\d+(\.\d+)?\s?(mg|ml|mcg|g|tablets?|pills?|capsules?|drops?)\b"));

/// Sentences with their terminators; `.` only ends a sentence when followed by whitespace or the end.
fn split_sentences(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut sentences = Vec::new();
    let mut current = String::new();
    for (i, c) in chars.iter().enumerate() {
        current.push(*c);
        let ends = match c {
            '。' | '！' | '？' | '!' | '?' | '；' | ';' | '\n' => true,
            '.' => chars.get(i + 1).is_none_or(|n| n.is_whitespace()),
            _ => false,
        };
        if ends {
            sentences.push(std::mem::take(&mut current));
        }
    }
    if !current.trim().is_empty() {
        sentences.push(current);
    }
    sentences
}

fn clauses(sentence: &str) -> impl Iterator<Item = &str> {
    sentence
        .split(|c| {
            matches!(
                c,
                '，' | ',' | '、' | '：' | ':' | '。' | '！' | '？' | '!' | '?' | '；' | ';' | '\n'
            )
        })
        .map(str::trim)
        .filter(|c| !c.is_empty())
}

fn strip_spaces(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

fn dose_tokens(text: &str, re: &Regex) -> Vec<String> {
    re.find_iter(text)
        .map(|m| strip_spaces(m.as_str()).to_lowercase())
        .collect()
}

/// Classifies one clause. `patient` is the patient's own words (whitespace removed, lowercase) for restatement.
fn judge_clause(clause: &str, patient: &str) -> Option<Violation> {
    // English clauses first: a clause with no CJK characters is judged by the English rules.
    let is_english = !clause
        .chars()
        .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
    if is_english {
        let lower = clause.to_lowercase();
        let lower = lower.trim();
        if DIAGNOSIS_EN.iter().any(|r| r.is_match(lower)) && !DEFER_EN.is_match(lower) {
            return Some(Violation::Diagnosis);
        }
        if DEFER_EN.is_match(lower) || QUESTION_EN.is_match(lower) {
            return None;
        }
        let tokens = dose_tokens(lower, &DOSE_EN);
        let patient_says_it =
            !tokens.is_empty() && tokens.iter().all(|tok| patient.contains(tok.as_str()));
        if ADVICE_EN[0].is_match(lower) || ADVICE_EN[2].is_match(lower) {
            return Some(if tokens.is_empty() {
                Violation::Prescribing
            } else {
                Violation::Dosage
            });
        }
        // "take 5 mg" with no advice verb is only a violation when the patient never said that dose.
        if ADVICE_EN[1].is_match(lower) && !tokens.is_empty() && !patient_says_it {
            return Some(Violation::Dosage);
        }
        return None;
    }

    let c = strip_spaces(clause);
    let deferring = DEFER_ZH.is_match(&c) || UI_ZH.is_match(&c);
    if !deferring
        && !DIAGNOSIS_HISTORY_ZH.is_match(&c)
        && DIAGNOSIS_ZH.iter().any(|r| r.is_match(&c))
    {
        return Some(Violation::Diagnosis);
    }
    if deferring || QUESTION_ZH.is_match(&c) {
        return None;
    }
    let tokens = dose_tokens(&c, &DOSE_TOKEN);
    let patient_says_it =
        !tokens.is_empty() && tokens.iter().all(|tok| patient.contains(tok.as_str()));
    let advising = ADVICE_ZH.iter().any(|r| r.is_match(&c));
    if advising {
        // Advice that only repeats the patient's own medicine and dose is still advice ("您可以每天吃…").
        return Some(if tokens.is_empty() {
            Violation::Prescribing
        } else {
            Violation::Dosage
        });
    }
    if !tokens.is_empty() && DOSE_CUE_ZH.is_match(&c) && !patient_says_it {
        return Some(Violation::Dosage);
    }
    None
}

/// Runs the guard. `patient_text` is everything the patient said in this visit (and the medicines recorded),
/// so a restated medicine or dose is not flagged.
pub fn check(text: &str, locale: Locale, patient_text: &str) -> GuardReport {
    let patient = strip_spaces(patient_text).to_lowercase();
    let sentences = split_sentences(text);
    let mut kept: Vec<&str> = Vec::new();
    let mut violations: Vec<Violation> = Vec::new();
    for sentence in &sentences {
        let verdict = clauses(sentence).find_map(|clause| judge_clause(clause, &patient));
        match verdict {
            Some(v) => {
                if !violations.contains(&v) {
                    violations.push(v);
                }
            }
            None => kept.push(sentence),
        }
    }
    if violations.is_empty() {
        return GuardReport {
            text: text.to_string(),
            violations,
            action: GuardAction::None,
        };
    }
    let remaining = kept.concat();
    let remaining = remaining.trim();
    let meaningful = remaining.chars().filter(|c| c.is_alphanumeric()).count() >= 6;
    if !meaningful {
        return GuardReport {
            text: t(T::GuardReplace, locale).to_string(),
            violations,
            action: GuardAction::Replaced,
        };
    }
    let note = t(
        match violations[0] {
            Violation::Diagnosis => T::GuardDiagnosis,
            Violation::Dosage => T::GuardDosage,
            Violation::Prescribing => T::GuardPrescribing,
        },
        locale,
    );
    let separator = if locale.is_en() { " " } else { "" };
    GuardReport {
        text: format!("{note}{separator}{remaining}"),
        violations,
        action: GuardAction::Rewritten,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str, patient: &str) -> GuardReport {
        check(text, Locale::ZhTw, patient)
    }

    #[test]
    fn diagnosis_statements_are_flagged() {
        for text in [
            "您得的是胃炎。",
            "您可能是感冒，先多休息。",
            "你應該是腸胃炎。",
            "診斷為高血壓。",
            "這是肺炎。",
            "您可能有糖尿病。",
            "您的症狀看起來像偏頭痛。",
            "您可能罹患心臟病。",
        ] {
            let r = run(text, "");
            assert!(r.violations.contains(&Violation::Diagnosis), "{text}");
            assert_ne!(r.action, GuardAction::None);
        }
    }

    #[test]
    fn advice_and_doses_are_flagged() {
        for (text, kind) in [
            ("建議您吃止痛藥。", Violation::Prescribing),
            ("您可以先服用退燒藥。", Violation::Prescribing),
            ("可以加到每天 2 顆。", Violation::Dosage),
            ("建議每天吃 500mg。", Violation::Dosage),
            ("每天三次，每次兩顆。", Violation::Dosage),
            ("我幫您開抗生素。", Violation::Prescribing),
            ("您應該停藥。", Violation::Prescribing),
            ("一天可以吃 3 顆止痛藥。", Violation::Dosage),
        ] {
            let r = run(text, "");
            assert!(r.violations.contains(&kind), "{text} -> {:?}", r.violations);
        }
    }

    #[test]
    fn deferring_to_the_doctor_and_pharmacist_is_allowed() {
        for text in [
            "這要請醫師判斷。",
            "用藥和劑量由藥師說明。",
            "我無法判斷病名，醫師會評估。",
            "我不能建議吃什麼藥。",
            "醫師會決定要不要開藥。",
            "這部分請向醫師或藥師確認。",
            "我不是醫師，這部分要請醫師判斷。",
        ] {
            let r = run(text, "");
            assert!(r.passed(), "{text} wrongly flagged: {:?}", r.violations);
            assert_eq!(r.text, text);
        }
    }

    #[test]
    fn asking_about_medicines_and_history_is_allowed() {
        for text in [
            "平常有在吃什麼藥嗎？",
            "您目前有服用任何藥物嗎？",
            "請問您有沒有被診斷過高血壓？",
            "醫師有說過是什麼原因嗎？",
            "對藥物或食物過敏的話也告訴我一聲。",
            "您有在吃降血壓藥嗎？",
            "是否曾經被診斷為糖尿病？",
        ] {
            let r = run(text, "");
            assert!(r.passed(), "{text} wrongly flagged: {:?}", r.violations);
        }
    }

    #[test]
    fn restating_the_patients_own_medicine_and_dose_is_allowed() {
        let patient = "我每天早上吃一顆降血壓藥，是5mg的，還有胃藥";
        for text in [
            "好，您每天早上吃一顆降血壓藥，5mg。",
            "目前用藥：降血壓藥 5mg，每天早上一顆。",
            "您說的胃藥，一天吃一顆，我記下來了。",
        ] {
            let r = run(text, patient);
            assert!(r.passed(), "{text} wrongly flagged: {:?}", r.violations);
        }
        // The same dose is advice when the patient never said it.
        assert!(!run("每天早上吃一顆降血壓藥。", "").passed());
        // Advice stays flagged even if it repeats the patient's numbers.
        assert!(!run("建議您每天吃一顆降血壓藥。", patient).passed());
    }

    #[test]
    fn ordinary_intake_sentences_pass() {
        for text in [
            "好，咳嗽三天、晚上比較嚴重。有發燒嗎？",
            "痛是怎麼樣的痛？悶悶的，還是刺痛？",
            "我把這些整理好了，請您看看對不對。",
            "您說胸口悶，已經兩天了，我先記下來。",
            "這是很常見的症狀描述，我先記錄。",
        ] {
            let r = run(text, "");
            assert!(r.passed(), "{text} wrongly flagged: {:?}", r.violations);
        }
    }

    #[test]
    fn flagged_sentences_are_dropped_and_the_rest_is_kept_with_a_safe_note() {
        let r = run("您可能是感冒。那咳嗽是從什麼時候開始的？", "");
        assert_eq!(r.action, GuardAction::Rewritten);
        assert!(r.text.starts_with(t(T::GuardDiagnosis, Locale::ZhTw)));
        assert!(r.text.contains("咳嗽是從什麼時候開始的"));
        assert!(!r.text.contains("感冒"));
    }

    #[test]
    fn a_reply_with_nothing_left_is_replaced() {
        let r = run("建議您吃止痛藥。", "");
        assert_eq!(r.action, GuardAction::Replaced);
        assert_eq!(r.text, t(T::GuardReplace, Locale::ZhTw));
        let r = run("您得的是胃炎。建議每天吃兩顆。", "");
        assert_eq!(r.action, GuardAction::Replaced);
        assert!(
            r.violations.contains(&Violation::Diagnosis)
                && r.violations.contains(&Violation::Dosage)
        );
    }

    #[test]
    fn english_replies_are_guarded_too() {
        let bad = [
            ("You probably have the flu.", Violation::Diagnosis),
            (
                "I recommend taking 500 mg of ibuprofen twice a day.",
                Violation::Dosage,
            ),
            ("You should take some painkillers.", Violation::Prescribing),
            ("You are diagnosed with pneumonia.", Violation::Diagnosis),
        ];
        for (text, kind) in bad {
            let r = check(text, Locale::En, "");
            assert!(r.violations.contains(&kind), "{text} -> {:?}", r.violations);
        }
        for text in [
            "How long have you had the cough?",
            "What medicines do you take?",
            "A doctor will decide that, I cannot advise on doses.",
            "You mentioned you take 5 mg every morning, I noted it.",
        ] {
            let r = check(text, Locale::En, "i take 5 mg every morning");
            assert!(r.passed(), "{text} wrongly flagged: {:?}", r.violations);
        }
        let r = check(
            "You probably have the flu. How long has the cough lasted?",
            Locale::En,
            "",
        );
        assert_eq!(r.action, GuardAction::Rewritten);
        assert!(r.text.contains("How long has the cough lasted?") && !r.text.contains("flu"));
    }

    #[test]
    fn sentence_splitting_keeps_decimals_together() {
        let parts = split_sentences("Take 2.5 mg now. Then rest.");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], "Take 2.5 mg now.");
        assert_eq!(parts[1], " Then rest.");
    }
}
