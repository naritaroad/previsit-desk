//! `output_guard`: checks what the model wrote before the patient sees it (diagnosis, doses, prescribing advice).
//!
//! Method: split the reply into sentences and clauses, flag clauses that make a diagnosis or give medicine advice,
//! drop the flagged sentences and add one fixed safe sentence. If nothing useful is left, replace the whole reply.
//!
//! What is allowed: restating a medicine or dose the patient said themselves, asking about their medicines,
//! pointing at the screen, and plainly refusing ("我不能建議…", "I cannot advise…"). What is forbidden: advising
//! ("建議您吃…", "可以加到…"), any dose (a number with a unit) the patient did not state, and naming a condition
//! ("您得的是…", "可能是…病", "診斷為…"). A word like "諮詢醫師" or "see a doctor" does NOT excuse a clause that
//! carries advice, a dose or a diagnosis; only an explicit refusal does, and never for a dose.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use crate::style::style_cleanup;
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

const DISEASE_ZH: &str = r"(?:[一-龥]{1,3}炎|感冒|流感|中風|梗塞|梗死|潰瘍|結石|高血壓|低血壓|高血脂|高血糖|低血糖|糖尿病|貧血|憂鬱症|焦慮症|恐慌症|失智症|氣喘|偏頭痛|癌|腫瘤|心臟病|心律不整|肺結核|帶狀皰疹|蕁麻疹|痛風|骨折|腦震盪|腸躁症|胃食道逆流|椎間盤突出|痔瘡|疝氣|氣胸|肺栓塞|甲狀腺[一-龥]{0,3}|感染|病毒|細菌|[一-龥]{1,3}症候群|過敏性[一-龥]{1,3}|失眠症|躁鬱症|過敏症)";
const MEDICINE_ACTION_ZH: &str = r"(?:吃|服用|服|使用|塗|貼|注射|加到|增加到|增加|減少|加量|減量|停藥|停用|換成|改成|改吃|多吃|少吃)";
const DOSE_NUM_ZH: &str =
    r"(?:\d+(?:\.\d+)?|[零〇一二兩三四五六七八九十百千半]+(?:點[零〇一二三四五六七八九]+)?)";
const DOSE_UNIT_ZH: &str =
    r"(?:mg|mcg|毫克|微克|公克|克|g|ml|毫升|cc|顆|粒|錠|片|包|膠囊|單位|iu|滴|瓶|支|貼|劑)";
const EN_DISEASE: &str = r"(?:infection|flu|influenza|cold|cancer|diabetes|hypertension|migraine|pneumonia|ulcer|strep(?: throat)?|covid(?:-19)?|asthma|appendicitis|gastritis|bronchitis|sinusitis|anxiety|depression|anemia|arthritis|[a-z]{3,}itis|[a-z]{3,}osis|syndrome|disease|disorder)";

/// An explicit refusal ("我不能建議…"). It excuses advice and diagnosis wording, never a dose.
static REFUSAL_ZH: LazyLock<Regex> = LazyLock::new(|| {
    re(r"無法|不能|不會|不可以|沒辦法|沒有辦法|不做|不提供|不是醫師|不開|不便|不方便")
});
/// Pointing at the screen ("您可以使用慢箋檢核表單") is not medicine advice.
static UI_ZH: LazyLock<Regex> =
    LazyLock::new(|| re(r"表單|慢箋檢核|按鈕|畫面|介面|頁面|功能|送出|填寫|開始新的"));
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
        // No subject at all: "可能是胃炎", "疑似腸胃炎", "聽起來像偏頭痛".
        re(&format!(
            r"(可能是|應該是|大概是|八成是|很可能是|疑似|看起來像是|看起來像|聽起來像是|聽起來像|像是)[^，。]{{0,6}}{DISEASE_ZH}"
        )),
    ]
});
static DIAGNOSIS_HISTORY_ZH: LazyLock<Regex> = LazyLock::new(|| {
    re(r"被診斷|診斷過|曾.{0,3}診斷|是否.{0,6}診斷|有沒有.{0,6}診斷|醫師.{0,4}診斷|診斷書")
});
/// Advice to take, use or change a medicine. A refusal or a pointer to the screen excuses these (not a dose).
static ADVICE_ZH: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        re(&format!(
            r"(建議|可以先|可以試試|可以考慮|不妨|最好|應該|需要|必須|何不|不如|乾脆)(你|您)?[^，。]{{0,4}}{MEDICINE_ACTION_ZH}"
        )),
        re(&format!(
            r"(你|您)(可以|應該|最好|不妨|需要|得|要|可|必須)(先|再)?[^，。]{{0,3}}{MEDICINE_ACTION_ZH}"
        )),
        // Soft prescriptions: "要不要先吃一顆", "可不可以多吃一點".
        re(&format!(
            r"(要不要|可不可以|能不能|何不|不如|乾脆)(先|再)?[^，。]{{0,3}}{MEDICINE_ACTION_ZH}"
        )),
        re(
            r"(我|我們)(會|來|可以)?(幫您|幫你|替您|替你|為您|為你|給您|給你)?(開|開立|開給|處方)[^，。]{0,6}(藥|處方|抗生素|止痛|退燒|消炎|類固醇)",
        ),
        re(r"開給(你|您)|處方給(你|您)"),
    ]
});
static DOSE_ZH: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"{DOSE_NUM_ZH}{DOSE_UNIT_ZH}")));

static REFUSAL_EN: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"\b(cannot|can't|unable to|not able to|won't|will not|do not recommend|don't recommend|am not a|not sure|cannot tell|can't tell|can't say|cannot say|do not know|don't know)\b",
    )
});
static DIAGNOSIS_EN: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        re(
            r"\byou (probably|likely|most likely|may|might|could) (have|be (suffering from|having|dealing with))\b",
        ),
        re(&format!(
            r"\byou (have|are suffering from|seem to have|appear to have|are having|got|caught) (a |an |the )?{EN_DISEASE}\b"
        )),
        re(r"\b(my|the) diagnosis is\b|\bdiagnosed with\b"),
        re(&format!(
            r"\b(this|that|it) (is|could be|might be|may be|sounds like|looks like|seems like) (probably |likely |just )?(a |an )?{EN_DISEASE}\b"
        )),
        re(&format!(r"\b(could|might|may) be (a |an )?{EN_DISEASE}\b")),
        re(&format!(
            r"\b(sounds|looks|seems) like (a |an )?{EN_DISEASE}\b"
        )),
    ]
});
static DIAGNOSIS_HISTORY_EN: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"\b(have|has|were|was|ever|been) (you )?(been )?diagnosed\b|\bpreviously diagnosed\b|\bdoctor (said|told|diagnosed)\b",
    )
});
static ADVICE_EN: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        re(
            r"\b(i recommend|i suggest|you should|you can|you could|you may|you might want to|you need to|you must|try|consider|go ahead and|why not|how about)\b[^,]{0,25}\b(take|taking|use|using|increase|reduce|stop|switch to|apply)\b",
        ),
        // Imperative at the start: "Take two tablets", "Do take 2 tablets", "Apply the cream".
        re(
            r"^(do |please |just )?(take|swallow|apply|use)\b[^,]{0,30}\b(pills?|tablets?|capsules?|medicine|medication|ibuprofen|tylenol|acetaminophen|paracetamol|aspirin|antibiotics?|painkillers?|drops?|cream|ointment|mg|ml)\b",
        ),
        re(r"\bi('ll| will)? (prescribe|write you a prescription)\b"),
    ]
});
static DOSE_EN: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|half|a couple of|a)\s?(?:mg|mcg|ml|g|tablets?|pills?|capsules?|drops?|teaspoons?|tsp|tbsp|puffs?)\b",
    )
});

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

/// NFKC (full-width digits and letters become ordinary ones), no whitespace, lowercase.
fn squash(text: &str) -> String {
    text.nfkc()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn dose_tokens(text: &str, re: &Regex) -> Vec<String> {
    re.find_iter(text).map(|m| squash(m.as_str())).collect()
}

/// Classifies one clause. `patient` is the patient's own words (squashed) for restating a dose they stated.
fn judge_clause(clause: &str, patient: &str) -> Option<Violation> {
    // A clause with no CJK characters is judged by the English rules.
    let is_english = !clause
        .chars()
        .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
    if is_english {
        let lower: String = clause.nfkc().collect::<String>().to_lowercase();
        let lower = lower.split_whitespace().collect::<Vec<_>>().join(" ");
        let tokens = dose_tokens(&lower, &DOSE_EN);
        let restated = !tokens.is_empty() && tokens.iter().all(|t| patient.contains(t.as_str()));
        // Any dose the patient did not state is a violation, whatever else the clause says.
        if !tokens.is_empty() && !restated {
            return Some(Violation::Dosage);
        }
        let refusal = REFUSAL_EN.is_match(&lower);
        if !refusal && ADVICE_EN.iter().any(|r| r.is_match(&lower)) {
            return Some(if tokens.is_empty() {
                Violation::Prescribing
            } else {
                Violation::Dosage
            });
        }
        if !refusal
            && !DIAGNOSIS_HISTORY_EN.is_match(&lower)
            && DIAGNOSIS_EN.iter().any(|r| r.is_match(&lower))
        {
            return Some(Violation::Diagnosis);
        }
        return None;
    }

    let c = squash(clause);
    let tokens = dose_tokens(&c, &DOSE_ZH);
    let restated = !tokens.is_empty() && tokens.iter().all(|t| patient.contains(t.as_str()));
    // Any dose the patient did not state is a violation, whatever else the clause says (no deferral excuses it).
    if !tokens.is_empty() && !restated {
        return Some(Violation::Dosage);
    }
    let refusal = REFUSAL_ZH.is_match(&c);
    let pointing_at_screen = UI_ZH.is_match(&c);
    if !refusal && !pointing_at_screen && ADVICE_ZH.iter().any(|r| r.is_match(&c)) {
        // Advice that only repeats the patient's own medicine and dose is still advice.
        return Some(if tokens.is_empty() {
            Violation::Prescribing
        } else {
            Violation::Dosage
        });
    }
    if !refusal && !DIAGNOSIS_HISTORY_ZH.is_match(&c) && DIAGNOSIS_ZH.iter().any(|r| r.is_match(&c))
    {
        return Some(Violation::Diagnosis);
    }
    None
}

/// Runs the guard. `patient_text` is everything the patient said in this visit (and the medicines recorded),
/// so a restated medicine or dose is not flagged.
pub fn check(text: &str, locale: Locale, patient_text: &str) -> GuardReport {
    let patient = squash(patient_text);
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

/// The reply the patient will see, after every safety step.
pub struct Sanitized {
    pub text: String,
    pub violations: Vec<Violation>,
    pub action: GuardAction,
}

/// The whole model-reply pipeline: clean the style first (so markdown cannot hide a pattern), run the guard,
/// clean the guard's output, and run the guard once more on the final text. If the second pass still finds
/// something, the reply is replaced outright.
pub fn sanitize_reply(raw: &str, locale: Locale, allowed: &str) -> Sanitized {
    let cleaned = style_cleanup(raw, locale);
    let cleaned = if cleaned.is_empty() {
        raw.trim().to_string()
    } else {
        cleaned
    };
    let first = check(&cleaned, locale, allowed);
    let after = style_cleanup(&first.text, locale);
    let after = if after.is_empty() {
        first.text.clone()
    } else {
        after
    };
    let second = check(&after, locale, allowed);
    if second.passed() {
        return Sanitized {
            text: after,
            violations: first.violations,
            action: first.action,
        };
    }
    let mut violations = first.violations;
    for v in second.violations {
        if !violations.contains(&v) {
            violations.push(v);
        }
    }
    Sanitized {
        text: t(T::GuardReplace, locale).to_string(),
        violations,
        action: GuardAction::Replaced,
    }
}

/// Convenience for model-authored text stored or shown elsewhere (ticket notes, intake fields, narratives):
/// true when it passes untouched.
pub fn is_clean(text: &str, locale: Locale, patient_text: &str) -> bool {
    check(text, locale, patient_text).passed()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::style::style_cleanup;

    fn run(text: &str, patient: &str) -> GuardReport {
        check(text, Locale::ZhTw, patient)
    }

    fn flagged(text: &str) -> Vec<Violation> {
        run(text, "").violations
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
            "可能是腸躁症。",
            "聽起來像椎間盤突出。",
            "疑似胃食道逆流。",
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
    fn a_deferral_word_does_not_excuse_advice_or_a_dose() {
        for text in [
            "建議您先吃兩顆普拿疼再諮詢醫師",
            "建議您吃三顆比較有用",
            "要不要先吃一顆普拿疼",
            "您可以先吃止痛藥，再請教醫師",
            "每天吃五百毫克，由醫師決定也可以",
            "您可以每天吃兩顆，藥師會再說明",
            "先吃一粒觀察，不行再問醫師",
            "半錠就好，醫師會評估",
            "建議您問醫師之前先吃一片",
            "一次一顆，不用諮詢醫師",
        ] {
            assert!(!flagged(text).is_empty(), "{text} must be flagged");
        }
        for text in [
            "You should take 400 mg ibuprofen every 6 hours until you see a doctor",
            "You probably have strep throat and should see a doctor",
            "Do take 2 tablets twice a day",
            "take 1000 mg Tylenol, okay?",
            "two tablets every six hours",
            "1 pill twice a day",
            "It could be appendicitis, ask your doctor",
            "Sounds like a migraine",
            "Take two tablets and call your doctor if it gets worse",
        ] {
            let r = check(text, Locale::En, "");
            assert!(!r.passed(), "{text} must be flagged");
        }
    }

    #[test]
    fn number_words_and_units_in_both_languages_are_caught() {
        for text in [
            "每天吃五百毫克。",
            "一次兩顆。",
            "一粒就夠。",
            "半錠。",
            "吃二點五毫克。",
            "一次十滴。",
            "每次 0.5 片。",
            "每次一百毫升。",
        ] {
            assert!(flagged(text).contains(&Violation::Dosage), "{text}");
        }
        for text in [
            "You can have two tablets.",
            "Half a tablet is enough.",
            "Use 5 ml.",
            "A couple of pills will do.",
        ] {
            assert!(!check(text, Locale::En, "").passed(), "{text}");
        }
    }

    #[test]
    fn markdown_cannot_hide_a_pattern_once_the_text_is_cleaned() {
        let hidden = "您可以**先試著**服用退燒藥";
        assert!(
            run(hidden, "").passed(),
            "the raw text slips through, which is why the engine cleans first"
        );
        let cleaned = style_cleanup(hidden, Locale::ZhTw);
        assert!(!run(&cleaned, "").passed(), "cleaned text: {cleaned}");
        let list = style_cleanup("- 建議您吃\n- **兩顆**普拿疼", Locale::ZhTw);
        assert!(!run(&list, "").passed(), "{list}");
    }

    #[test]
    fn deferring_to_the_doctor_and_pharmacist_is_allowed() {
        for text in [
            "這要請醫師判斷。",
            "用藥和劑量由藥師說明。",
            "藥師會說明劑量。",
            "我無法判斷病名，醫師會評估。",
            "我不能建議吃什麼藥。",
            "醫師會決定要不要開藥。",
            "這部分請向醫師或藥師確認。",
            "我不是醫師，這部分要請醫師判斷。",
            "我無法判斷您是不是得了胃炎。",
        ] {
            let r = run(text, "");
            assert!(r.passed(), "{text} wrongly flagged: {:?}", r.violations);
            assert_eq!(r.text, text);
        }
        for text in [
            "I cannot advise on doses.",
            "A doctor will decide that.",
            "I can't tell whether you have the flu.",
            "The pharmacist will explain the dose.",
        ] {
            let r = check(text, Locale::En, "");
            assert!(r.passed(), "{text} wrongly flagged: {:?}", r.violations);
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
            "您是不是有高血壓？",
            "您可以使用慢箋檢核表單。",
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
        // A dose the patient did not state is flagged even next to one they did.
        assert!(!run("您吃的是 5mg，可以加到 10mg。", patient).passed());
    }

    #[test]
    fn ordinary_intake_sentences_pass() {
        for text in [
            "好，咳嗽三天、晚上比較嚴重。有發燒嗎？",
            "痛是怎麼樣的痛？悶悶的，還是刺痛？",
            "我把這些整理好了，請您看看對不對。",
            "您說胸口悶，已經兩天了，我先記下來。",
            "這是很常見的症狀描述，我先記錄。",
            "如果 0 分是完全沒感覺，10 分是最難受，現在大約幾分呢？",
            "體溫量到 38.5 度，已經三天了。",
        ] {
            let r = run(text, "");
            assert!(r.passed(), "{text} wrongly flagged: {:?}", r.violations);
        }
    }

    #[test]
    fn every_fixed_text_passes_the_guard() {
        // Category and field labels are names, not sentences the assistant says.
        for key in T::ALL.iter().filter(|k| {
            !format!("{k:?}").starts_with("Cat") && !format!("{k:?}").starts_with("Field")
        }) {
            let (zh, en) = (t(*key, Locale::ZhTw), t(*key, Locale::En));
            assert!(
                check(zh, Locale::ZhTw, "").passed(),
                "{key:?} zh: {:?}",
                check(zh, Locale::ZhTw, "").violations
            );
            assert!(
                check(en, Locale::En, "").passed(),
                "{key:?} en: {:?}",
                check(en, Locale::En, "").violations
            );
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
    fn the_rewritten_text_passes_the_guard_again() {
        for text in [
            "您可能是感冒。那咳嗽是從什麼時候開始的？",
            "建議您先吃兩顆普拿疼。請問痛了幾天？",
            "建議您吃止痛藥。",
        ] {
            let first = run(text, "");
            assert!(first.action != GuardAction::None);
            assert!(
                run(&first.text, "").passed(),
                "second pass on {:?}",
                first.text
            );
        }
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

    #[test]
    fn sanitize_reply_cleans_then_guards_then_guards_again() {
        let allowed = "";
        // Markdown hides the advice from the raw text; the pipeline cleans first.
        let s = sanitize_reply(
            "您可以**先試著**服用退燒藥。請問痛了幾天？",
            Locale::ZhTw,
            allowed,
        );
        assert_ne!(s.action, GuardAction::None);
        assert!(!s.text.contains("退燒藥") && !s.text.contains("**"));
        assert!(s.text.contains("痛了幾天"));
        // A clean reply only loses its decoration.
        let s = sanitize_reply("**好**！咳嗽三天。有發燒嗎？", Locale::ZhTw, allowed);
        assert_eq!(s.action, GuardAction::None);
        assert_eq!(s.text, "好。咳嗽三天。有發燒嗎？");
        // Whatever comes out passes the guard.
        for raw in [
            "1. 建議吃兩顆止痛藥\n2. 您可能是胃炎",
            "You probably have **the flu**. Take 2 tablets.",
            "- 每天吃五百毫克",
        ] {
            let s = sanitize_reply(raw, Locale::ZhTw, allowed);
            assert!(
                check(&s.text, Locale::ZhTw, allowed).passed(),
                "{raw} -> {}",
                s.text
            );
            assert!(s.action != GuardAction::None, "{raw}");
        }
    }
}
