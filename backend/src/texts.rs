//! Every fixed text a patient or clinician can read. zh-TW (Taiwan usage) and en are declared side by side,
//! so a key can never exist in one language only. Placeholders look like `{name}` and must match in both.
//!
//! Voice: a calm clinic intake nurse. Action first, short sentences, 您 throughout, no cheer, no apology boilerplate.

use crate::types::{Locale, RedFlagCategory};

macro_rules! texts {
    ($($key:ident => ($zh:literal, $en:literal)),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum T {
            $($key),+
        }

        impl T {
            #[allow(dead_code)]
            pub const ALL: &'static [T] = &[$(T::$key),+];

            pub(crate) fn pair(self) -> (&'static str, &'static str) {
                match self {
                    $(T::$key => ($zh, $en)),+
                }
            }
        }
    };
}

texts! {
    // ---- the opening disclosure (first assistant message of every visit) ----
    Opening => (
        "您好，我是 AI 預問診助理，不是醫師。我會先問幾個問題，把您的狀況整理成摘要交給醫師；不做診斷，也不開藥。請不要在這裡輸入真實的病歷或個人資料。如果現在有胸痛、喘不過氣這類緊急狀況，請直接撥 119。\n\n請先說說，您今天哪裡不舒服？",
        "Hello, I am an AI pre-visit assistant, not a doctor. I will ask a few questions and turn your answers into a summary for your doctor. I do not diagnose or prescribe. Please do not enter real medical records or personal details here. If you have an emergency right now, such as chest pain or trouble breathing, call 119.\n\nTo start: what is bothering you today?"
    ),

    // ---- fixed replies that never reach the model ----
    RedFlagPhysical => (
        "您描述的狀況可能很緊急。請現在就撥 119，或請身邊的人陪您到最近的急診，不要自己開車。我已通知醫療團隊，這次問診先暫停。",
        "What you describe may be an emergency. Call 119 now, or ask someone nearby to take you to the closest emergency department. Do not drive yourself. I have alerted the care team and paused this pre-visit."
    ),
    RedFlagExtraStroke => (
        "請記下症狀開始的時間，到院時告訴醫護人員。",
        "Note the time the symptoms started and tell the staff when you arrive."
    ),
    RedFlagExtraConsciousness => (
        "如果是身邊的人叫不醒，請先撥 119，照接線人員的指示處理。",
        "If it is someone next to you who will not wake, call 119 first and follow the dispatcher's instructions."
    ),
    RedFlagExtraAnaphylaxis => (
        "到院時請告訴醫護人員，您剛吃了什麼、用了什麼藥或打了什麼針。",
        "When you arrive, tell the staff what you just ate, took or were injected with."
    ),
    RedFlagExtraSeizure => (
        "如果是身邊的人正在抽搐，請移開周圍的硬物，不要把東西放進他嘴裡。",
        "If someone next to you is having the seizure, move hard objects away and do not put anything in their mouth."
    ),
    RedFlagSuicide => (
        "聽起來您現在很辛苦。請先撥 1925 安心專線（24 小時、免費），會有人陪您談。如果您已經有傷害自己的行動，或身邊有立即的危險，請撥 119。如果已經吃了過量的藥，或喝了不該喝的東西，請立刻撥 119，不要等。我已通知醫療團隊。",
        "It sounds like you are going through a lot right now. Please call the 1925 hotline first (free, 24 hours); someone will talk with you. If you have already hurt yourself, or you are in immediate danger, call 119. If you have already taken too much medicine or swallowed something you should not have, call 119 right away and do not wait. I have alerted the care team."
    ),
    RedFlagReminder => (
        "這次問診已經因為您先前描述的症狀暫停。請先就醫，或撥 119；1925 安心專線隨時有人接聽。如果要為別的事重新問診，請按「開始新的預問診」。",
        "This pre-visit was paused because of the symptoms you described earlier. Please get care first, or call 119; the 1925 hotline always answers. To start over for something else, choose \"Start a new pre-visit\"."
    ),
    RefusalPrescription => (
        "開藥和調整劑量要由醫師決定，我這邊不能處理。我已把您的需求轉給醫師。您也可以繼續跟我說目前的症狀，我整理給醫師看。",
        "A doctor has to decide on prescriptions and doses, so I cannot handle this. I have passed your request to the doctor. You can keep telling me your symptoms and I will organise them for the doctor."
    ),
    RefusalControlled => (
        "安眠藥、鎮靜劑這類管制藥品，我不能處理，慢箋也不能續開，要由醫師當面評估。我已把您的需求轉給醫師。您也可以繼續跟我說最近的睡眠和症狀，我整理給醫師看。",
        "I cannot handle controlled medicines such as sleeping pills or sedatives, and they cannot be refilled on a chronic prescription. A doctor has to assess you in person. I have passed your request to the doctor. You can keep telling me about your sleep and symptoms and I will organise them for the doctor."
    ),
    RefusalInjection => (
        "這部分我無法提供。我只負責看診前的問診整理和慢箋檢核。",
        "I cannot do that. I only organise pre-visit history and check chronic-prescription refills."
    ),
    NoticePii => (
        "剛才的內容有疑似個人資料（身分證字號、電話、電子郵件或長串數字），系統已遮蔽。請不要在這裡輸入個人資料。",
        "Your last message looked like it contained personal data (an ID number, phone number, email or a long number), so it was masked. Please do not enter personal data here."
    ),

    // ---- notices saved when a model run cannot answer ----
    NoticeDailyBudget => (
        "今天的 AI 對話額度用完了，明天才能再用。紅旗警示和「慢箋檢核」表單不受影響。如果身體不舒服，請直接就醫。",
        "Today's AI chat quota is used up and resets tomorrow. Red-flag screening and the refill check form still work. If you feel unwell, seek care directly."
    ),
    NoticeNotConfigured => (
        "AI 對話功能還沒設定好，目前不能回覆。「慢箋檢核」表單可以照常使用。如果身體不舒服，請直接就醫。",
        "The AI chat is not set up yet, so it cannot reply. The refill check form still works. If you feel unwell, seek care directly."
    ),
    NoticeTimeout => (
        "這次回覆等太久，已經中止。請再傳一次，或稍後再試。",
        "That reply took too long and was stopped. Send it again, or try later."
    ),
    NoticeModelError => (
        "AI 服務暫時沒有回應。您剛才輸入的內容已儲存，請稍後再傳一次。",
        "The AI service is not responding. What you typed is saved. Please send it again in a moment."
    ),
    NoticeMaxSteps => (
        "這個問題一次處理不完，我先停下來。請換個方式再說一次。",
        "That took too many steps, so I stopped. Please say it again in a different way."
    ),
    NoticeVisitLimit => (
        "這次預問診的對話已經很長，我先停在這裡。請按「結束並送出」，把目前整理好的內容交給醫師；要補充別的事，請開始新的預問診。",
        "This pre-visit conversation has become very long, so I will stop here. Choose \"Finish and submit\" to hand what is collected to the doctor, or start a new pre-visit to add something else."
    ),
    TransferSummaryFallback => (
        "病人請醫師留意，詳細內容請見對話紀錄。",
        "The patient asked the clinician to take a look. See the conversation for details."
    ),
    SubmittedThanks => (
        "摘要已送出，醫師看診前會看到。如果之後出現胸痛、喘不過氣這類緊急狀況，請直接撥 119。",
        "Your summary has been sent and the doctor will see it before your visit. If chest pain, trouble breathing or another emergency comes up later, call 119."
    ),

    // ---- output guard rewrites ----
    GuardDiagnosis => (
        "病名要由醫師判斷，我不能回答，請在看診時直接問醫師。",
        "Only a doctor can name a condition, so I cannot answer. Please ask the doctor at your visit."
    ),
    GuardDosage => (
        "用藥和劑量要由醫師或藥師說明，我不能建議。",
        "A doctor or pharmacist has to explain medicines and doses. I cannot advise on them."
    ),
    GuardPrescribing => (
        "要不要開藥、開什麼藥，由醫師決定，我不能建議。",
        "Whether to prescribe, and what, is the doctor's decision. I cannot advise on it."
    ),
    GuardOther => (
        "這部分要由醫師或藥師判斷，我不能回答。",
        "A doctor or pharmacist has to judge this part. I cannot answer it."
    ),
    GuardReplace => (
        "這部分要由醫師或藥師判斷，我不能回答。我們先繼續整理您的狀況。",
        "A doctor or pharmacist has to judge this part. I cannot answer it. Let us keep going with your history."
    ),

    // ---- API error messages ----
    ErrInvalidRequest => ("資料格式不對，請檢查後再送出。", "The request is not valid. Check it and send it again."),
    ErrUnauthorized => ("請先登入。", "Sign in first."),
    ErrInvalidCredentials => ("帳號或密碼不對。", "Wrong username or password."),
    ErrForbidden => ("這個帳號沒有權限。", "This account is not allowed to do that."),
    ErrNotFound => ("找不到這筆資料，可能已超過保留期限。", "Not found. It may be past the retention period."),
    ErrVisitClosed => ("這次預問診已經送出，不能再傳訊息。需要的話請開始新的預問診。", "This pre-visit has been submitted and takes no more messages. Start a new one if you need to."),
    ErrRateLimited => ("操作太頻繁，請稍等幾分鐘再試。", "Too many requests. Wait a few minutes and try again."),
    ErrPayloadTooLarge => ("內容太長，請縮短後再送。", "The request is too large. Shorten it and send again."),
    ErrInternal => ("系統出了問題，請稍後再試。", "Something went wrong on our side. Try again later."),
    ErrConflict => ("上一則訊息還在處理，請等它完成再傳。", "The previous message is still being processed. Wait for it to finish."),
    ErrInvalidState => ("目前的狀態不能做這個操作。", "This action is not possible in the current state."),
    ErrUnsupportedMediaType => ("只接受 application/json。", "Only application/json is accepted."),
    ErrFieldRequired => ("必填，或格式不對。", "Required, or in the wrong format."),
    FieldErrDate => ("日期請寫成 YYYY-MM-DD。", "Write the date as YYYY-MM-DD."),
    FieldErrPositive => ("要是大於 0 的整數。", "Must be a whole number above 0."),
    FieldErrRange => ("要在 {min} 到 {max} 之間。", "Must be between {min} and {max}."),
    FieldErrFuture => ("不能晚於今天。", "Cannot be later than today."),
    FieldErrOrder => ("不能晚於上次領藥日。", "Cannot be later than the last fill date."),
    FieldErrChoice => ("選項不對。", "Not one of the allowed choices."),
    FieldErrUnknown => ("這個欄位不能傳。", "This field is not accepted."),

    // ---- refill check: titles and messages ----
    RefillTitleEligible => ("可以領藥", "You can collect your refill"),
    RefillTitleTooEarly => ("還沒到可領藥的日子", "Too early for the next refill"),
    RefillTitleRevisit => ("需要回診", "A new visit is needed"),
    RefillTitleConsult => ("請洽藥師或醫師", "Ask the pharmacist or doctor"),
    RefillMsgEligible => (
        "依您填的資料，現在可以憑這張慢箋到藥局領下一次的藥。實際調劑由藥師最後確認。",
        "Based on what you entered, you can collect the next supply at a pharmacy with this prescription now. The pharmacist makes the final check."
    ),
    RefillMsgTooEarly => (
        "依您填的資料，最早 {date} 才能領下一次的藥。",
        "Based on what you entered, the earliest you can collect the next supply is {date}."
    ),
    RefillMsgRevisit => (
        "這張慢箋已經不能再領，需要回診，由醫師重新開立。",
        "This prescription can no longer be refilled. You need a new visit so the doctor can write a new one."
    ),
    RefillMsgConsult => (
        "您的情況需要藥師或醫師確認。我已通知醫療團隊，領藥或看診時請一併說明。",
        "Your situation needs the pharmacist or doctor to confirm. I have alerted the care team. Mention it when you collect the medicine or at your visit."
    ),
    // ---- refill check: reasons ----
    RefillReasonControlled => ("處方含第一、二級管制藥品，不能用連續處方箋領藥。", "The prescription contains a level 1 or 2 controlled drug, which cannot be dispensed on a chronic prescription."),
    RefillReasonControlledUnsure => ("不確定處方是否含管制藥品，請藥師確認。", "You are not sure whether the prescription has a controlled drug. Ask the pharmacist to check."),
    RefillReasonSymptomChanged => ("最近症狀有變化，需要醫師重新評估。", "Your symptoms have changed recently, so a doctor needs to reassess."),
    RefillReasonSideEffects => ("服藥後有不舒服或疑似副作用，需要醫師或藥師評估。", "You feel unwell or suspect side effects from the medicine, which a doctor or pharmacist needs to assess."),
    RefillReasonSpecialStatus => (
        "您的身分可以切結一次領完全部藥量，請帶證明文件，由藥師確認。",
        "Your status allows a sworn one-time collection of the whole supply. Bring supporting documents for the pharmacist to confirm."
    ),
    RefillReasonDaysTotal => (
        "處方總日數 {total} 天，超過上限 {max} 天，請向醫師或藥師確認。",
        "The prescription covers {total} days in total, over the limit of {max}. Confirm with the doctor or pharmacist."
    ),
    RefillReasonDaysPerFill => (
        "每次調劑 {per} 天，超過上限 {max} 天，請向醫師或藥師確認。",
        "Each fill covers {per} days, over the limit of {max}. Confirm with the doctor or pharmacist."
    ),
    RefillReasonDaysShort => (
        "每次 {per} 天、最多 {fills} 次，只夠 {cap} 天，不到處方的 {total} 天，請向醫師或藥師確認。",
        "{per} days per fill and at most {fills} fills cover {cap} days, short of the {total} prescribed. Confirm with the doctor or pharmacist."
    ),
    RefillReasonFillsExhausted => ("這張慢箋可領的 {fills} 次都領完了。", "All {fills} permitted fills of this prescription have been collected."),
    RefillReasonExpired => ("慢箋已超過有效期限（{date}）。", "The prescription is past its validity date ({date})."),
    RefillReasonTooEarly => (
        "上次的藥預計在 {supply_end} 前用完，最早 {date} 可以領（用完前 {window} 天）。",
        "The last supply runs out before {supply_end}. The earliest refill date is {date}, {window} days before that."
    ),
    RefillReasonInWindow => (
        "今天在可領藥的期間內，從 {earliest} 到慢箋有效期限 {latest}。",
        "Today is inside the refill window, from {earliest} to the prescription's expiry on {latest}."
    ),
    RefillReasonSupplyGap => (
        "上次的藥預計在 {supply_end} 前就用完了。這段時間如果有斷藥，領藥時請告訴藥師。",
        "The last supply should have run out before {supply_end}. If you went without medicine in between, tell the pharmacist when you collect."
    ),
    // ---- refill rule descriptions (fallback when refill_rules.csv has no text columns) ----
    RuleMaxTotalDays => ("慢性病連續處方箋依醫師實際給藥的日數計算，總用藥量最多 {value} 天。", "A chronic prescription covers the days the doctor actually prescribed, at most {value} days."),
    RuleMaxDaysPerFill => ("分次調劑，每次的用藥量在 {value} 天以內。", "It is dispensed in parts, each covering at most {value} days."),
    RuleEarlyWindow => ("第二、三次領藥，要在上次給藥期間屆滿前 {value} 天內才能領。", "The second and third fills can be collected within {value} days before the previous supply ends."),
    RuleMaxFills => ("同一張慢箋最多分 {value} 次調劑。", "One chronic prescription is dispensed in at most {value} fills."),
    RuleControlled => ("第一、二級管制藥品不能開在連續處方箋上。", "Level 1 and 2 controlled drugs cannot be written on a chronic prescription."),
    RuleSpecialStatus => (
        "預定出國、返回離島、遠洋漁船船員、國際航線船員和罕見疾病病人，可以切結一次領取總藥量，由藥師確認。",
        "People going abroad, returning to an outlying island, ocean-fishing or international crew, and rare-disease patients may swear to collect the whole supply at once, subject to the pharmacist's check."
    ),

    // ---- summary and ticket text for the clinician ----
    Disclaimer => (
        "這份摘要由 AI 預問診助理依病人自己的說法整理，沒有經過診斷，只供醫師參考。最後判斷由醫師和藥師決定。",
        "An AI pre-visit assistant organised this summary from the patient's own words. It is not a diagnosis and is for the clinician's reference. The doctor and pharmacist make the final judgement."
    ),
    RedFlagNoteClear => (
        "每則病人訊息都先經過紅旗規則檢查，沒有命中。",
        "Every patient message was screened by the red-flag rules first. None matched."
    ),
    RedFlagNoteHit => (
        "病人訊息曾命中紅旗規則，請先確認病人現況。",
        "A patient message matched a red-flag rule. Check on the patient first."
    ),
    TicketRedFlag => (
        "病人訊息命中紅旗規則「{label}」（規則 {rule}）。系統已回覆固定的緊急提醒，沒有呼叫模型。請盡快確認病人狀況。",
        "A patient message matched the red-flag rule \"{label}\" (rule {rule}). The system sent the fixed emergency reply and did not call the model. Check on the patient promptly."
    ),
    TicketPrescription => (
        "病人要求開藥或詢問劑量。系統已固定回覆不能處理，沒有呼叫模型。請在看診時直接和病人討論。",
        "The patient asked for a prescription or a dose. The system gave the fixed reply that it cannot help and did not call the model. Please discuss it with the patient at the visit."
    ),
    TicketControlled => (
        "病人要求開立或領取管制藥品（例如安眠藥、鎮靜劑）。系統已固定回覆不能處理，沒有呼叫模型。請由醫師當面評估。",
        "The patient asked for a controlled drug (for example sleeping pills or sedatives). The system gave the fixed reply that it cannot help and did not call the model. Please assess in person."
    ),
    TicketPatientRequest => ("病人按了「請醫師聯絡我」。", "The patient asked the clinician to get in touch."),
    TicketNote => ("備註：{note}", "Note: {note}"),
    TicketRefillConsult => (
        "慢箋檢核結果是「請洽藥師或醫師」。原因：{reasons}",
        "The refill check result is \"ask the pharmacist or doctor\". Reasons: {reasons}"
    ),
    PatientQuestionsLabel => ("病人想問醫師", "Questions for the doctor"),
    NotCollectedLabel => ("未取得", "Not collected"),
    NotApplicable => ("不適用", "N/A"),
    NoneLabel => ("無", "none"),
    SeverityOutOf => ("{n} 分（0–10）", "{n}/10"),
    NarrativeEmpty => ("病人尚未提供任何問診內容。", "The patient has not given any history yet."),

    // ---- field labels (also used in the prompt and in not-collected lists) ----
    FieldChiefComplaint => ("主訴", "Chief complaint"),
    FieldOnset => ("發作時間", "Onset"),
    FieldCourse => ("病程變化", "Course"),
    FieldLocation => ("部位", "Location"),
    FieldCharacter => ("性質", "Character"),
    FieldSeverity => ("嚴重程度", "Severity"),
    FieldModifiers => ("加重或緩解因素", "Aggravating or relieving factors"),
    FieldAssociated => ("伴隨症狀", "Associated symptoms"),
    FieldPastHistory => ("過去病史", "Past history"),
    FieldMedications => ("目前用藥", "Current medicines"),
    FieldAllergies => ("藥物或食物過敏", "Allergies"),

    // ---- red flag category labels (used when a rule label is unavailable) ----
    CatChestPain => ("胸痛或胸悶", "Chest pain or tightness"),
    CatDyspnea => ("呼吸困難", "Difficulty breathing"),
    CatStroke => ("疑似中風徵兆", "Possible stroke signs"),
    CatConsciousness => ("意識不清或昏倒", "Altered consciousness or fainting"),
    CatGiBleeding => ("吐血或解黑便", "Vomiting blood or black stool"),
    CatAnaphylaxis => ("疑似嚴重過敏", "Possible severe allergic reaction"),
    CatSeizure => ("抽搐或癲癇發作", "Seizure"),
    CatSuicide => ("自殺或自傷念頭", "Suicidal thoughts or self-harm"),

    // ---- v2: errors and field messages ----
    ErrStale => (
        "這筆資料已經在別處更新過。請看過最新內容，再決定要保留哪一份。",
        "This was changed somewhere else. Look at the latest version and choose which one to keep."
    ),
    FieldErrUsername => (
        "帳號要 3 到 32 個字元，只能用英文小寫、數字、底線、句點和連字號，開頭要是英文或數字。",
        "Use 3 to 32 characters: lowercase letters, digits, underscore, dot or hyphen, starting with a letter or digit."
    ),
    FieldErrPassword => ("密碼要 8 到 128 個字元。", "Passwords have 8 to 128 characters."),
    FieldErrLength => ("長度要在 {min} 到 {max} 個字之間。", "Write between {min} and {max} characters."),
    FieldErrPersonal => ("看起來有個人資料，請改用暱稱。", "That looks like personal data. Use a nickname instead."),
    FieldErrTaken => ("這個帳號名稱已經有人使用。", "That username is already taken."),
    FieldErrConfirm => ("請輸入 {word} 確認。", "Type {word} to confirm."),
    FieldErrSlot => ("這個時段不能預約，可能剛被約走。請重新整理後再選。", "That slot cannot be booked; someone may have just taken it. Refresh and choose again."),
    FieldErrSignature => ("簽署前要先寫評估與計畫。", "Write the assessment and the plan before signing."),
    FieldErrDiastolic => ("舒張壓要比收縮壓低。", "The lower number must be below the upper one."),
    MeasureBp => ("血壓", "Blood pressure"),
    MeasureGlucose => ("血糖", "Glucose"),
    MeasureWeight => ("體重", "Weight"),
    MeasurePulse => ("脈搏", "Pulse"),
    SourcePatient => ("自述", "self-reported"),
    SourceClinic => ("診所", "clinic"),
    FieldErrAdult => ("本服務只給年滿 18 歲的人使用，請先確認。", "This service is for people aged 18 or older. Please confirm first."),
    FieldErrRolePatient => ("病人帳號和工作人員帳號不能互換。", "A patient account cannot become a staff account, or the other way round."),
    SystemLabel => ("系統", "System"),
    TaskRedFlag => ("有緊急提醒，請先就醫", "Emergency reminder: get care first"),
    TaskPrevisit => ("完成看診前的預問診", "Finish the pre-visit before your appointment"),
    TaskRxMoreInfo => ("醫師需要您補充：申請 {no}", "The doctor needs more on request {no}"),
    TaskRxReady => ("可以去領藥：{drugs}", "Ready to collect: {drugs}"),
    TaskRxDraft => ("有一份還沒送出的申請：{drugs}", "A request you have not sent yet: {drugs}"),
    TaskRefill => ("可以預約領藥：{drug}", "You can book a refill: {drug}"),
    TaskRenewal => ("「{drug}」的處方已用完，可以申請續開", "Your prescription for {drug} has run out; you can ask for a renewal"),
    TaskConsent => ("看過 AI 使用說明並選擇是否同意", "Read how AI is used and choose whether to agree"),
    ActSubmitted => ("{patient}送出預問診", "{patient} submitted a pre-visit"),
    ActSigned => ("{actor}簽署了{patient}的看診筆記", "{actor} signed the note for {patient}"),
    ActRedFlag => ("{patient}的訊息命中紅旗「{label}」", "A message from {patient} matched the red flag \"{label}\""),
    ActRx => ("{patient}的申請：{status}", "Request from {patient}: {status}"),
    ActContact => ("{actor}聯絡了{patient}", "{actor} contacted {patient}"),
    TlVisitCreated => ("開始預問診「{title}」", "Started the pre-visit \"{title}\""),
    TlVisitSubmitted => ("送出預問診「{title}」", "Submitted the pre-visit \"{title}\""),
    TlVisitReviewed => ("審閱完成「{title}」", "Reviewed \"{title}\""),
    TlAppointment => ("{department}約診：{status}", "Appointment, {department}: {status}"),
    TlTicket => ("轉交單 {no}：{reason}", "Ticket {no}: {reason}"),
    TlRx => ("{kind} {no} 目前{status}", "{kind} {no}: {status}"),
    TlPhone => ("電話紀錄：{text}", "Phone note: {text}"),
    TlMessage => ("站內訊息：{text}", "Message: {text}"),
    ApptBooked => ("已預約", "Booked"),
    ApptCheckedIn => ("已報到", "Checked in"),
    ApptCompleted => ("已完成", "Completed"),
    ApptCancelled => ("已取消", "Cancelled"),
    UnknownPatient => ("未具名病人", "Unnamed patient"),
    SomeoneLabel => ("醫療團隊", "The care team"),

    // ---- v2: visits ----
    DefaultVisitTitle => ("新的預問診", "New pre-visit"),
    CareThreadTitle => ("醫療團隊訊息", "Message from the care team"),
    FollowUpMissing => ("未取得：{fields}", "Not collected: {fields}"),
    NoticeAiDisabled => (
        "AI 問答目前停用。您剛才的內容已儲存，醫療團隊看得到。要找真人，請按「請醫師聯絡我」。紅旗警示和「慢箋檢核」表單不受影響。",
        "AI chat is switched off right now. What you typed is saved and the care team can see it. To reach a person, choose \"Ask the clinic to contact me\". Red-flag screening and the refill check form still work."
    ),
    NoticeMonthlyBudget => (
        "這個月的 AI 額度用完了，下個月才能再用。紅旗警示和「慢箋檢核」表單不受影響。要找真人，請按「請醫師聯絡我」。",
        "This month's AI quota is used up and resets next month. Red-flag screening and the refill check form still work. To reach a person, choose \"Ask the clinic to contact me\"."
    ),
    NoticeInterrupted => (
        "上一則沒有完成，請按「重試」。",
        "The last reply did not finish. Choose \"Retry\"."
    ),
    HandoffTaken => (
        "{name}接手這段對話，接下來由真人回覆。AI 暫停回覆；緊急警示照常運作。",
        "{name} has taken over this conversation and a person will reply from here. The AI is paused; emergency screening keeps running."
    ),
    HandoffReleased => (
        "{name}把對話交回 AI 預問診助理。",
        "{name} has handed the conversation back to the AI assistant."
    ),
    StaffContactOpening => (
        "這裡是醫療團隊和您的對話。請不要輸入真實的病歷或個人資料；緊急狀況請直接撥 119。",
        "This is your conversation with the care team. Please do not enter real medical records or personal details; in an emergency call 119."
    ),

    // ---- v2: permission names for the matrix ----
    PermVisitOwn => ("自己的預問診", "Own pre-visits"),
    PermVisitOwnDesc => ("建立、填寫和送出自己的預問診。", "Start, fill in and submit their own pre-visits."),
    PermRxOwn => ("自己的用藥與申請", "Own medicines and requests"),
    PermRxOwnDesc => ("看自己的用藥、預約領藥和申請續開。", "See their medicines, book refills and ask for renewals."),
    PermProfileOwn => ("自己的健康檔案", "Own health record"),
    PermProfileOwnDesc => ("編輯自己的病史、過敏和量測，匯出或刪除資料。", "Edit their history, allergies and measurements; export or delete their data."),
    PermApptOwn => ("自己的約診", "Own appointments"),
    PermApptOwnDesc => ("預約和取消自己的約診。", "Book and cancel their own appointments."),
    PermVisitRead => ("看預問診", "Read pre-visits"),
    PermVisitReadDesc => ("看病人的預問診對話和摘要，每次都留下讀取紀錄。", "Read patients' conversations and summaries. Every read is logged."),
    PermVisitReview => ("審閱預問診", "Review pre-visits"),
    PermVisitReviewDesc => ("指派預問診、撰寫看診筆記草稿。", "Assign pre-visits and draft clinical notes."),
    PermNoteSign => ("簽署筆記", "Sign notes"),
    PermNoteSignDesc => ("簽署看診筆記和補記，簽署後病人會看到給他的話。", "Sign notes and addenda. The patient sees the message to them after signing."),
    PermThreadReply => ("回覆病人", "Reply to patients"),
    PermThreadReplyDesc => ("接手對話並回覆病人；藥師只限申請的訊息。", "Take over a conversation and reply; pharmacists only in request threads."),
    PermTicketHandle => ("處理轉交單", "Handle tickets"),
    PermTicketHandleDesc => ("看轉交單並結案。", "See tickets and close them."),
    PermPatientRead => ("看病人資料", "Read patient records"),
    PermPatientReadDesc => ("看健康檔案和紀錄；藥師只看用藥、過敏和申請。", "Read records; pharmacists see medicines, allergies and requests only."),
    PermPatientManage => ("管理病人", "Manage patients"),
    PermPatientManageDesc => ("標籤、追蹤狀態、負責人、內部備註和聯絡紀錄。", "Tags, follow-up status, responsible staff, internal notes and contact log."),
    PermApptManage => ("看門診表", "Clinic schedule"),
    PermApptManageDesc => ("看每天的門診時段和預約。", "See each day's slots and bookings."),
    PermRxRead => ("看申請", "Read requests"),
    PermRxReadDesc => ("看領藥預約和續開申請，可以指派。", "See refill and renewal requests and assign them."),
    PermRxDecide => ("決定續開", "Decide renewals"),
    PermRxDecideDesc => ("逐項決定續開申請。", "Decide each item of a renewal request."),
    PermRxDispense => ("調劑", "Dispense"),
    PermRxDispenseDesc => ("核對、備藥、交付，或退回申請。", "Check, prepare and hand over medicines, or return a request."),
    PermAccountManage => ("管理帳號", "Manage accounts"),
    PermAccountManageDesc => ("新增、停用、改角色、重設密碼和登出所有裝置。", "Create, disable, change roles, reset passwords and end sessions."),
    PermSettingsManage => ("管理設定", "Manage settings"),
    PermSettingsManageDesc => ("AI 模型、用量上限、預算、停用開關和保留天數。", "AI models, limits, budget, the off switch and retention."),
    PermAuditRead => ("看稽核紀錄", "Read the audit log"),
    PermAuditReadDesc => ("看操作紀錄、讀取紀錄和執行紀錄，不含病人文字。", "See changes, reads and runs, without patient text."),
    PermOversightRead => ("看監督指標", "Read oversight figures"),
    PermOversightReadDesc => ("引擎與醫師一致率、處理時間和退回率。", "Engine and physician agreement, turnaround and return rate."),
    PermRulesRead => ("看規則", "Read the rules"),
    PermRulesReadDesc => ("紅旗、越界、慢箋、協定和藥品範圍。", "Red flags, scope, refill rules, protocols and formulary."),
    PermDemoReset => ("重設示範資料", "Reset demo data"),
    PermDemoResetDesc => ("重建示範資料，不動其他帳號。", "Rebuild the demo data without touching other accounts."),

    // ---- v2: notifications ----
    NtfVisitReviewed => ("醫師看過您的預問診了", "Your pre-visit has been reviewed"),
    NtfVisitReviewedBody => ("{actor}已審閱「{title}」。點開可以看給您的話。", "{actor} reviewed \"{title}\". Open it to read the message for you."),
    NtfStaffMessage => ("醫療團隊回覆您", "The care team replied"),
    NtfStaffMessageBody => ("{actor}在「{title}」留了訊息。", "{actor} left a message in \"{title}\"."),
    NtfRxStatus => ("申請 {no} 有新進度", "Update on request {no}"),
    NtfRxStatusBody => ("目前狀態：{status}。", "Current status: {status}."),
    NtfRxMoreInfo => ("醫師需要您補充資料", "The doctor needs more from you"),
    NtfRxMoreInfoBody => ("申請 {no} 有問題要請您回答。", "Request {no} has questions for you."),
    NtfRxReady => ("藥備好了", "Your medicine is ready"),
    NtfRxReadyBody => ("申請 {no} 可以到{pharmacy}領藥。", "Request {no} can be collected at {pharmacy}."),
    NtfRxMessage => ("申請 {no} 有新訊息", "New message on request {no}"),
    NtfRxMessageBody => ("{actor}留了訊息。", "{actor} left a message."),
    NtfApptReminder => ("約診提醒", "Appointment reminder"),
    NtfApptReminderBody => ("{at}，{physician}，{department}。報到前可以先完成預問診。", "{at}, {physician}, {department}. You can finish the pre-visit before you check in."),
    NtfRefillWindow => ("可以領下一次的藥了", "Your next refill can be collected"),
    NtfRefillWindowBody => ("「{drug}」從 {date} 起可以領。", "{drug} can be collected from {date}."),
    NtfTicketNew => ("新的轉交單 {no}", "New ticket {no}"),
    NtfTicketNewBody => ("{patient}的轉交單：{reason}。", "Ticket for {patient}: {reason}."),
    NtfRxNew => ("新的申請 {no}", "New request {no}"),
    NtfRxNewBody => ("{patient}送出{rx_kind}。", "{patient} sent a request: {rx_kind}."),
    NtfRxOverdue => ("申請 {no} 超過處理時限", "Request {no} is overdue"),
    NtfRxOverdueBody => ("{patient}的申請還沒處理完。", "The request from {patient} is still open."),
    NtfVisitSubmitted => ("新的預問診待審", "New pre-visit to review"),
    NtfVisitSubmittedBody => ("{patient}送出了預問診。", "{patient} submitted a pre-visit."),
    NtfRedFlag => ("紅旗警示", "Red flag"),
    NtfRedFlagBody => ("{patient}的訊息命中「{label}」，請先確認病人狀況。", "A message from {patient} matched \"{label}\". Check on the patient first."),

    // ---- v2: labels for codes ----
    RxKindRefill => ("領藥預約", "Refill"),
    RxKindRenewal => ("續開申請", "Renewal"),
    RxStDraft => ("草稿", "Draft"),
    RxStSubmitted => ("已送出", "Submitted"),
    RxStInReview => ("醫師審閱中", "In review"),
    RxStMoreInfo => ("等您補充", "Waiting for your reply"),
    RxStApproved => ("醫師同意", "Approved"),
    RxStPartial => ("部分同意", "Partly approved"),
    RxStDeclined => ("醫師未同意", "Declined"),
    RxStVisitRequired => ("需要看診", "Visit required"),
    RxStAtPharmacy => ("藥局處理中", "At the pharmacy"),
    RxStReturned => ("藥局退回", "Returned by the pharmacy"),
    RxStReady => ("備藥完成", "Ready to collect"),
    RxStDispensed => ("已領取", "Collected"),
    RxStCancelled => ("已取消", "Cancelled"),
    ReasonRedFlag => ("紅旗警示", "Red flag"),
    ReasonPrescription => ("要求開藥", "Prescription request"),
    ReasonControlled => ("管制藥品", "Controlled drug"),
    ReasonSymptom => ("症狀變化", "Symptom change"),
    ReasonSideEffects => ("疑似副作用", "Possible side effects"),
    ReasonSpecial => ("特殊身分領藥", "Special refill status"),
    ReasonMedical => ("醫療問題", "Medical question"),
    ReasonPatient => ("病人請醫師聯絡", "Patient asked for contact"),
    ReasonOther => ("其他", "Other"),
}

/// The text for `key` in `locale` (placeholders untouched).
pub fn t(key: T, locale: Locale) -> &'static str {
    let (zh, en) = key.pair();
    if locale.is_en() { en } else { zh }
}

/// The text with `{name}` placeholders replaced.
pub fn fmt(key: T, locale: Locale, args: &[(&str, &str)]) -> String {
    let mut out = t(key, locale).to_string();
    for (name, value) in args {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

/// The fixed emergency reply for a red-flag category: the shared body plus a one-line extra where it helps.
pub fn red_flag_reply(category: RedFlagCategory, locale: Locale) -> String {
    let extra = match category {
        RedFlagCategory::Suicide => return t(T::RedFlagSuicide, locale).to_string(),
        RedFlagCategory::Stroke => Some(T::RedFlagExtraStroke),
        RedFlagCategory::Consciousness => Some(T::RedFlagExtraConsciousness),
        RedFlagCategory::Anaphylaxis => Some(T::RedFlagExtraAnaphylaxis),
        RedFlagCategory::Seizure => Some(T::RedFlagExtraSeizure),
        RedFlagCategory::ChestPain | RedFlagCategory::Dyspnea | RedFlagCategory::GiBleeding => None,
    };
    let body = t(T::RedFlagPhysical, locale);
    match extra {
        Some(key) => format!("{body}\n\n{}", t(key, locale)),
        None => body.to_string(),
    }
}

pub fn category_label(category: RedFlagCategory, locale: Locale) -> &'static str {
    t(
        match category {
            RedFlagCategory::ChestPain => T::CatChestPain,
            RedFlagCategory::Dyspnea => T::CatDyspnea,
            RedFlagCategory::Stroke => T::CatStroke,
            RedFlagCategory::Consciousness => T::CatConsciousness,
            RedFlagCategory::GiBleeding => T::CatGiBleeding,
            RedFlagCategory::Anaphylaxis => T::CatAnaphylaxis,
            RedFlagCategory::Seizure => T::CatSeizure,
            RedFlagCategory::Suicide => T::CatSuicide,
        },
        locale,
    )
}

/// Label for an intake field key such as `hpi.onset` or `allergies`.
pub fn field_label(key: &str, locale: Locale) -> &'static str {
    t(
        match key {
            "chief_complaint" => T::FieldChiefComplaint,
            "hpi.onset" => T::FieldOnset,
            "hpi.course" => T::FieldCourse,
            "hpi.location" => T::FieldLocation,
            "hpi.character" => T::FieldCharacter,
            "hpi.severity" => T::FieldSeverity,
            "hpi.modifiers" => T::FieldModifiers,
            "hpi.associated" => T::FieldAssociated,
            "past_history" => T::FieldPastHistory,
            "medications" => T::FieldMedications,
            "allergies" => T::FieldAllergies,
            _ => T::ErrInvalidRequest,
        },
        locale,
    )
}

pub fn rx_status_label(status: &str, locale: Locale) -> &'static str {
    t(
        match status {
            "draft" => T::RxStDraft,
            "submitted" => T::RxStSubmitted,
            "in_review" => T::RxStInReview,
            "more_info" => T::RxStMoreInfo,
            "approved" => T::RxStApproved,
            "partially_approved" => T::RxStPartial,
            "declined" => T::RxStDeclined,
            "visit_required" => T::RxStVisitRequired,
            "at_pharmacy" => T::RxStAtPharmacy,
            "returned" => T::RxStReturned,
            "ready" => T::RxStReady,
            "dispensed" => T::RxStDispensed,
            _ => T::RxStCancelled,
        },
        locale,
    )
}

pub fn rx_kind_label(kind: &str, locale: Locale) -> &'static str {
    t(
        if kind == "refill" {
            T::RxKindRefill
        } else {
            T::RxKindRenewal
        },
        locale,
    )
}

pub fn appt_status_label(status: &str, locale: Locale) -> &'static str {
    t(
        match status {
            "booked" => T::ApptBooked,
            "checked_in" => T::ApptCheckedIn,
            "completed" => T::ApptCompleted,
            _ => T::ApptCancelled,
        },
        locale,
    )
}

pub fn ticket_reason_label(reason: &str, locale: Locale) -> &'static str {
    t(
        match reason {
            "red_flag" => T::ReasonRedFlag,
            "prescription_request" => T::ReasonPrescription,
            "controlled_drug" => T::ReasonControlled,
            "symptom_change" => T::ReasonSymptom,
            "side_effects" => T::ReasonSideEffects,
            "special_status" => T::ReasonSpecial,
            "out_of_scope_medical" => T::ReasonMedical,
            "patient_request" => T::ReasonPatient,
            _ => T::ReasonOther,
        },
        locale,
    )
}

pub fn error_message(code: &str, locale: Locale) -> &'static str {
    t(
        match code {
            "unauthorized" => T::ErrUnauthorized,
            "invalid_credentials" => T::ErrInvalidCredentials,
            "forbidden" => T::ErrForbidden,
            "not_found" => T::ErrNotFound,
            "visit_closed" => T::ErrVisitClosed,
            "rate_limited" => T::ErrRateLimited,
            "payload_too_large" => T::ErrPayloadTooLarge,
            "internal" => T::ErrInternal,
            "conflict" => T::ErrConflict,
            "invalid_state" => T::ErrInvalidState,
            "unsupported_media_type" => T::ErrUnsupportedMediaType,
            _ => T::ErrInvalidRequest,
        },
        locale,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn placeholders(text: &str) -> BTreeSet<String> {
        let mut found = BTreeSet::new();
        let mut rest = text;
        while let Some(start) = rest.find('{') {
            let Some(end) = rest[start..].find('}') else {
                break;
            };
            found.insert(rest[start + 1..start + end].to_string());
            rest = &rest[start + end + 1..];
        }
        found
    }

    #[test]
    fn every_key_has_both_languages_with_the_same_placeholders() {
        for key in T::ALL {
            let (zh, en) = key.pair();
            assert!(!zh.trim().is_empty(), "{key:?} has no zh-TW text");
            assert!(!en.trim().is_empty(), "{key:?} has no en text");
            assert_eq!(
                placeholders(zh),
                placeholders(en),
                "{key:?} placeholders differ"
            );
            assert!(
                zh.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
                "{key:?} zh text has no Chinese"
            );
        }
    }

    #[test]
    fn zh_texts_use_taiwan_characters_and_terms() {
        // Characters that exist only in Simplified Chinese, and common mainland terms.
        let simplified = "这们说时来还与实务该请问药医烧疗诊热无么发过对为";
        let mainland = [
            "視頻", "軟件", "網絡", "信息", "默認", "質量", "程序", "用戶", "打印", "屏幕", "鼠標",
            "激活",
        ];
        for key in T::ALL {
            let zh = key.pair().0;
            for c in simplified.chars() {
                assert!(!zh.contains(c), "{key:?} contains simplified character {c}");
            }
            for term in mainland {
                assert!(!zh.contains(term), "{key:?} contains mainland term {term}");
            }
        }
    }

    #[test]
    fn fixed_texts_have_no_cheer_markdown_or_emoji() {
        for key in T::ALL {
            let (zh, en) = key.pair();
            for text in [zh, en] {
                assert!(
                    !text.contains('！') && !text.contains('!'),
                    "{key:?} has an exclamation mark"
                );
                assert!(
                    !text.contains("**") && !text.contains("##"),
                    "{key:?} has markdown"
                );
                assert!(
                    !text
                        .chars()
                        .any(|c| ('\u{1F300}'..='\u{1FAFF}').contains(&c)
                            || ('\u{2600}'..='\u{27BF}').contains(&c)),
                    "{key:?} has an emoji"
                );
            }
            assert!(
                !zh.contains("抱歉") && !zh.contains("很遺憾") && !zh.contains("感謝您"),
                "{key:?} has apology or thanks boilerplate"
            );
        }
    }

    #[test]
    fn opening_discloses_ai_and_not_a_doctor() {
        assert!(t(T::Opening, Locale::ZhTw).contains("我是 AI 預問診助理，不是醫師"));
        assert!(t(T::Opening, Locale::En).contains("not a doctor"));
        assert!(t(T::Opening, Locale::ZhTw).contains("請不要在這裡輸入真實的病歷或個人資料"));
        assert!(t(T::Opening, Locale::ZhTw).contains("119"));
    }

    #[test]
    fn every_refusal_keeps_a_refusal_word() {
        for key in [
            T::RefusalPrescription,
            T::RefusalControlled,
            T::RefusalInjection,
        ] {
            let zh = t(key, Locale::ZhTw);
            assert!(
                ["醫師", "不能", "無法"].iter().any(|w| zh.contains(w)),
                "{key:?}"
            );
        }
    }

    #[test]
    fn emergency_texts_name_the_right_numbers() {
        for category in RedFlagCategory::ALL {
            for locale in [Locale::ZhTw, Locale::En] {
                let text = red_flag_reply(*category, locale);
                assert!(
                    text.contains("119"),
                    "{category:?} {locale:?} must name 119"
                );
                if *category == RedFlagCategory::Suicide {
                    assert!(text.contains("1925"));
                }
            }
        }
        assert!(red_flag_reply(RedFlagCategory::Stroke, Locale::ZhTw).contains("症狀開始的時間"));
        assert!(
            !red_flag_reply(RedFlagCategory::ChestPain, Locale::ZhTw).contains("症狀開始的時間")
        );
    }

    #[test]
    fn fmt_replaces_named_placeholders() {
        assert_eq!(
            fmt(
                T::RefillMsgTooEarly,
                Locale::ZhTw,
                &[("date", "2026-12-01")]
            ),
            "依您填的資料，最早 2026-12-01 才能領下一次的藥。"
        );
    }

    #[test]
    fn labels_resolve_for_every_field_key() {
        for key in crate::intake::FIELD_KEYS {
            assert_ne!(
                field_label(key, Locale::ZhTw),
                t(T::ErrInvalidRequest, Locale::ZhTw),
                "{key}"
            );
        }
    }
}
