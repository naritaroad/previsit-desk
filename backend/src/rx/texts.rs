//! Fixed texts of the prescription request flow, in the same style as [`crate::texts`]: zh-TW and en side by side,
//! so a key can never exist in one language only. The emergency wording is not here; it is reused from `crate::texts`.

use crate::types::Locale;

macro_rules! rx_texts {
    ($($key:ident => ($zh:literal, $en:literal)),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum R {
            $($key),+
        }

        impl R {
            #[allow(dead_code)]
            pub const ALL: &'static [R] = &[$(R::$key),+];

            pub(crate) fn pair(self) -> (&'static str, &'static str) {
                match self {
                    $(R::$key => ($zh, $en)),+
                }
            }
        }
    };
}

rx_texts! {
    // ---- questions ----
    QSameAsRecord => (
        "您現在吃的{drug}，和處方紀錄上寫的一樣嗎？",
        "Are you taking {drug} exactly as the prescription record says?"
    ),
    QRefillSymptom => ("上次領藥之後，症狀有變化嗎？", "Have your symptoms changed since the last fill?"),
    QRefillSideEffects => ("吃藥後有不舒服，或懷疑是副作用嗎？", "Have you felt unwell, or do you suspect a side effect?"),
    QRefillSpecial => ("您有下列身分，想一次領完剩下的藥嗎？", "Do any of these apply, and do you want the rest all at once?"),
    SpecialNone => ("沒有", "None of these"),
    SpecialGoingAbroad => ("預定出國", "Going abroad"),
    SpecialReturningIsland => ("要回離島", "Returning to an outlying island"),
    SpecialOceanFishing => ("遠洋漁船船員", "Ocean fishing crew"),
    SpecialInternationalCrew => ("國際航線船員", "International shipping crew"),
    SpecialRareDisease => ("罕見疾病病人", "Rare disease patient"),

    // ---- answer errors ----
    ErrAnswerRequired => ("這一題還沒回答。", "This question has no answer yet."),
    ErrNumber => ("請填數字。", "Enter a number."),
    ErrTextLength => ("最多 {max} 個字。", "At most {max} characters."),
    ErrPharmacyRequired => ("請選一間領藥的藥局。", "Choose a pharmacy."),
    ErrPickupRequired => ("請選取藥日期和時段。", "Choose a pickup date and time."),
    ErrPickupPast => ("取藥日期不能早於今天。", "The pickup date cannot be in the past."),
    ErrConsentVersion => ("說明內容已更新，請重新看過再同意。", "The notice has changed. Read it again before you agree."),
    ErrAllExcluded => (
        "選的藥都不接受線上續開申請，請預約回診。",
        "None of these medicines can be renewed online. Book a visit instead."
    ),
    ErrNotPrescribedHere => (
        "這是您自己填的用藥，沒有診所的處方紀錄，不能在這裡申請。",
        "You added this medicine yourself. It has no clinic prescription, so it cannot be requested here."
    ),
    ErrOpenRequest => ("這個藥已經有一件處理中的申請。", "There is already an open request for this medicine."),
    ErrRefillNeedsFill => (
        "這張慢箋還沒有領過第一次藥，請先拿處方箋到藥局領藥。",
        "The first supply has not been collected yet. Take the prescription to a pharmacy first."
    ),
    ErrRefillOneItem => ("領藥預約一次選一張處方。", "Choose one prescription per refill booking."),
    ErrDecisionMissing => ("每一項都要有決定。", "Every item needs a decision."),
    ErrDecisionUnknownItem => ("這一項不在這件申請裡。", "This item is not part of the request."),
    ErrDecisionNote => ("請寫原因或要問的問題。", "Write the reason or the question."),
    ErrOverrideNote => (
        "檢核結果建議當面看診，核准前請寫下理由。",
        "The checks suggest an in-person visit. Write your reason before approving."
    ),
    ErrNoPharmacy => (
        "病人還沒選藥局，不能核准。請先要求補充資料。",
        "The patient has not chosen a pharmacy, so it cannot be approved. Ask for more information first."
    ),
    ErrDispenseChecks => ("四項核對都完成才能交付藥品。", "Finish all four checks before handing over the medicine."),
    ErrReturnNote => ("請寫退回或詢問的原因。", "Write why you are returning it or asking."),
    ErrMessageEmpty => ("請輸入內容。", "Write something first."),

    // ---- engine ----
    SummaryReady => (
        "沒有規則觸發。這不代表核准，仍由醫師審閱後決定。",
        "No rule fired. This is not an approval; a physician still reviews and decides."
    ),
    SummaryReview => ("有 {n} 項需要醫師留意。", "{n} point(s) for the physician to look at."),
    SummaryInPerson => ("有 {n} 項需要留意，其中有建議當面看診的情況。", "{n} point(s) to look at, including some that suggest an in-person visit."),
    SummaryUrgentStaff => ("出現緊急情況的回答，請先聯絡病人。", "An answer points to an emergency. Contact the patient first."),
    SummaryExcluded => (
        "這些藥不接受線上續開申請，請預約回診。",
        "These medicines cannot be renewed online. Book a visit instead."
    ),
    LabelScope => ("藥品範圍", "Medicine scope"),
    LabelControlled => ("管制藥品", "Controlled drug"),
    LabelFillsLeft => ("剩餘領藥次數", "Fills left"),
    LabelUnanswered => ("尚未回答：{label}", "Not answered: {label}"),
    ReasonControlled => ("管制藥品不接受線上申請。", "Controlled drugs are not accepted online."),
    ReasonUnknownDrug => ("這個藥不在系統的藥品清單裡，不接受線上申請。", "This medicine is not on the list, so it is not accepted online."),
    ReasonPhysicianOnly => ("這類藥要由醫師個別評估。", "A physician has to assess this medicine individually."),
    ReasonNoProtocol => ("這類藥沒有檢核題目，由醫師評估。", "There are no checks for this class, so a physician assesses it."),
    ReasonNotSame => ("病人說現在的吃法和處方紀錄不同。", "The patient says they take it differently from the record."),
    ReasonUnanswered => ("必答題沒有回答。", "A required question has no answer."),
    ReasonRedFlagText => ("病人寫的內容命中紅旗規則「{label}」。", "What the patient wrote matched the red-flag rule \"{label}\"."),
    ReasonFillsLeft => (
        "這張慢箋還有 {n} 次可以領，請確認是否需要提前續開。",
        "This prescription still has {n} fill(s) left. Check whether renewing now is needed."
    ),

    // ---- timeline events ----
    EvCreated => ("建立申請", "Request created"),
    EvSubmitted => ("病人送出申請", "Submitted by the patient"),
    EvItemsLeftOut => ("不接受線上申請，沒有一起送出：{drugs}", "Not accepted online, left out of the request: {drugs}"),
    EvUrgent => ("回答出現緊急情況，已通知醫療團隊", "An answer pointed to an emergency. The care team was alerted"),
    EvAssigned => ("指派給{name}", "Assigned to {name}"),
    EvUnassigned => ("取消指派", "Assignment removed"),
    EvReviewStarted => ("醫師開始審閱", "Review started"),
    EvApproved => ("醫師同意續開", "The physician agreed to renew"),
    EvPartiallyApproved => ("醫師同意部分藥品續開", "The physician agreed to renew some of the medicines"),
    EvDeclined => ("醫師沒有同意續開", "The physician did not agree to renew"),
    EvVisitRequired => ("醫師請病人回診", "The physician asked for a visit"),
    EvMoreInfo => ("醫師請病人補充資料", "The physician asked for more information"),
    EvReplied => ("病人已補充資料", "The patient sent more information"),
    EvSentToPharmacy => ("送到{pharmacy}", "Sent to {pharmacy}"),
    EvAccepted => ("藥局接件", "Accepted by the pharmacy"),
    EvReady => ("備藥完成，可以取藥", "Prepared and ready to collect"),
    EvDispensed => ("已完成核對並交付藥品", "Checked and handed over"),
    EvFillRecorded => ("已記錄第 {n} 次領藥", "Fill {n} recorded"),
    EvNextPrescription => ("已建立下一張處方紀錄（示範）", "Next prescription record created (demo)"),
    EvReturned => ("藥師退回：{note}", "Returned by the pharmacist: {note}"),
    EvAskedPhysician => ("藥師請醫師確認：{note}", "The pharmacist asked the physician: {note}"),
    EvCancelled => ("病人取消申請", "Cancelled by the patient"),
    EvOverdue => ("超過預計處理時間", "Past the expected handling time"),

    // ---- tickets ----
    TicketRxUrgent => (
        "申請 {no} 的回答出現緊急情況：{reasons}。系統已顯示固定的緊急提醒，請盡快聯絡病人。",
        "Answers in request {no} point to an emergency: {reasons}. The fixed emergency notice was shown. Contact the patient promptly."
    ),
}

/// The text for `key` in `locale` (placeholders untouched).
pub fn rt(key: R, locale: Locale) -> &'static str {
    let (zh, en) = key.pair();
    if locale.is_en() { en } else { zh }
}

/// The text with `{name}` placeholders replaced.
pub fn rf(key: R, locale: Locale, args: &[(&str, &str)]) -> String {
    let mut out = rt(key, locale).to_string();
    for (name, value) in args {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn placeholders(text: &str) -> BTreeSet<&str> {
        text.split('{')
            .skip(1)
            .filter_map(|part| part.split_once('}').map(|(name, _)| name))
            .collect()
    }

    #[test]
    fn both_languages_exist_with_the_same_placeholders() {
        for key in R::ALL {
            let (zh, en) = key.pair();
            assert!(!zh.trim().is_empty() && !en.trim().is_empty(), "{key:?}");
            assert_eq!(placeholders(zh), placeholders(en), "{key:?}");
            assert!(
                zh.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
                "{key:?}"
            );
            assert!(
                !en.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
                "{key:?}"
            );
        }
    }

    #[test]
    fn texts_use_taiwan_wording_without_cheer_or_markdown() {
        let simplified = "这们说时来还与实务该请问药医烧疗诊热无么发过对为";
        let mainland = [
            "視頻", "軟件", "網絡", "信息", "默認", "質量", "程序", "用戶", "激活",
        ];
        for key in R::ALL {
            let (zh, en) = key.pair();
            assert!(
                !simplified.chars().any(|c| zh.contains(c)),
                "{key:?} simplified"
            );
            assert!(
                !mainland.iter().any(|w| zh.contains(w)),
                "{key:?} mainland term"
            );
            for text in [zh, en] {
                assert!(
                    !text.contains('！') && !text.contains('!') && !text.contains("**"),
                    "{key:?}"
                );
            }
        }
    }

    /// The engine only sorts and explains: none of its texts may say that something is approved or suggest a dose.
    #[test]
    fn engine_texts_never_approve_or_dose() {
        for key in [
            R::SummaryReview,
            R::SummaryInPerson,
            R::SummaryUrgentStaff,
            R::SummaryExcluded,
            R::ReasonControlled,
            R::ReasonUnknownDrug,
            R::ReasonPhysicianOnly,
            R::ReasonNoProtocol,
            R::ReasonNotSame,
            R::ReasonUnanswered,
            R::ReasonRedFlagText,
            R::ReasonFillsLeft,
        ] {
            let (zh, en) = key.pair();
            for word in ["核准", "同意", "劑量", "毫克", "加藥", "減藥", "換藥"] {
                assert!(!zh.contains(word), "{key:?} says {word}");
            }
            for word in ["approve", "dose", " mg", "increase", "switch"] {
                assert!(!en.to_lowercase().contains(word), "{key:?} says {word}");
            }
        }
        assert!(rt(R::SummaryReady, Locale::ZhTw).contains("不代表核准"));
        assert!(rt(R::SummaryReady, Locale::En).contains("not an approval"));
    }

    #[test]
    fn placeholders_are_filled() {
        assert_eq!(
            rf(R::EvFillRecorded, Locale::ZhTw, &[("n", "2")]),
            "已記錄第 2 次領藥"
        );
    }
}
