//! Offline, deterministic stand-in for a model (`LLM_MODEL=mock`). It reads the state lines of the system prompt,
//! turns the patient's message into a `record_intake` patch, and writes short plain replies. It exists so the whole
//! flow (stages, tools, guard, tickets, summary) can be exercised without a key. It is a development aid, not a model.
//!
//! Intake rule: the message fills the first missing field(s). A message with `;` or `；` fills one missing field per
//! segment, in asking order, so a test can answer several questions in one message.
//! Hooks for tests: `[mock:diagnosis]` makes it break the no-diagnosis rule, `[mock:markdown]` makes it use markdown.

use std::sync::LazyLock;

use anyhow::Result;
use futures::future::BoxFuture;
use genai::chat::{ChatMessage, ChatRequest, ChatRole, ToolCall};
use regex::Regex;
use serde_json::{Value, json};

use super::{ModelGateway, ModelReply};
use crate::intake::IntakeState;
use crate::prompt::{LINE_COLLECTED, LINE_LOCALE, LINE_MISSING_KEYS, LINE_STAGE};
use crate::types::Locale;

pub struct MockGateway;

impl ModelGateway for MockGateway {
    fn model_name(&self) -> &str {
        "mock"
    }

    fn chat(&self, request: ChatRequest) -> BoxFuture<'_, Result<ModelReply>> {
        Box::pin(async move { Ok(reply(&request)) })
    }
}

struct Seen {
    locale: Locale,
    stage: String,
    missing: Vec<String>,
    collected: IntakeState,
}

fn read_state(request: &ChatRequest) -> Seen {
    let system = request.system.as_deref().unwrap_or("");
    let line = |label: &str| {
        system
            .lines()
            .find_map(|l| l.strip_prefix(label))
            .map(str::trim)
            .unwrap_or("")
    };
    Seen {
        locale: Locale::parse(line(LINE_LOCALE)).unwrap_or(Locale::ZhTw),
        stage: line(LINE_STAGE).to_string(),
        missing: line(LINE_MISSING_KEYS)
            .split(',')
            .filter(|k| !k.is_empty())
            .map(str::to_string)
            .collect(),
        collected: serde_json::from_str(line(LINE_COLLECTED)).unwrap_or_default(),
    }
}

fn tool_call(name: &str, args: Value) -> ModelReply {
    let call = ToolCall {
        call_id: format!("mock_{name}"),
        fn_name: name.to_string(),
        fn_arguments: args,
        thought_signatures: None,
    };
    ModelReply {
        text: None,
        assistant_message: Some(ChatMessage::from(vec![call.clone()])),
        tool_calls: vec![call],
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: None,
    }
}

fn text(content: impl Into<String>) -> ModelReply {
    ModelReply {
        text: Some(content.into()),
        tool_calls: Vec::new(),
        assistant_message: None,
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: None,
    }
}

fn pick(locale: Locale, zh: &str, en: &str) -> String {
    if locale.is_en() {
        en.to_string()
    } else {
        zh.to_string()
    }
}

fn has(text: &str, words: &[&str]) -> bool {
    let lower = text.to_lowercase();
    words.iter().any(|w| lower.contains(w))
}

static AFFIRM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^\s*(對|是的|正確|沒錯|沒問題|確認|可以|ok|okay|yes|correct|right|that'?s right)",
    )
    .expect("regex")
});
static DURATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d+|[一二兩三四五六七八九十]+)\s*(天|週|周|個月|年|小時|days?|weeks?|months?|hours?)|昨天|前天|今天|上週|最近").expect("regex")
});
static NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d{1,2}").expect("regex"));

fn reply(request: &ChatRequest) -> ModelReply {
    let seen = read_state(request);
    let Some(last) = request.messages.last() else {
        return text(pick(
            seen.locale,
            "請問您今天哪裡不舒服？",
            "What is bothering you today?",
        ));
    };
    if last.role == ChatRole::Tool {
        let start = request
            .messages
            .iter()
            .rposition(|m| m.role == ChatRole::User)
            .map_or(0, |i| i + 1);
        let results: Vec<(String, Value)> = request.messages[start..]
            .iter()
            .flat_map(|m| m.content.tool_responses())
            .map(|r| {
                (
                    r.fn_name.clone().unwrap_or_default(),
                    serde_json::from_str(&r.content).unwrap_or(Value::Null),
                )
            })
            .collect();
        return text(after_tools(&results, &seen));
    }
    let message = last.content.first_text().unwrap_or_default().to_string();
    route(&message, &seen)
}

fn route(message: &str, seen: &Seen) -> ModelReply {
    if message.contains("[mock:diagnosis]") {
        return text(pick(
            seen.locale,
            "您可能是胃炎，建議您每天吃兩顆止痛藥。那疼痛是從什麼時候開始的？",
            "You probably have gastritis, I recommend taking 500 mg of ibuprofen twice a day. When did the pain start?",
        ));
    }
    if message.contains("[mock:markdown]") {
        return text("**好的！** 😊\n- 咳嗽三天\n- 晚上比較嚴重\n希望這些資訊對您有幫助。");
    }
    if seen.stage == "confirm" && AFFIRM.is_match(message) {
        return tool_call(
            "save_previsit_summary",
            json!({ "confirmed_by_patient": true, "narrative": narrative(&seen.collected, seen.locale) }),
        );
    }
    if has(
        message,
        &[
            "什麼時候",
            "何時",
            "要不要",
            "該不該",
            "需不需要",
            "when should",
            "should i see",
        ],
    ) && has(
        message,
        &[
            "看醫",
            "就醫",
            "掛號",
            "急診",
            "醫院",
            "doctor",
            "emergency",
        ],
    ) || has(message, &["手冊", "衛教", "流程"])
    {
        return tool_call(
            "search_health_education",
            json!({ "query": message, "top_k": 2 }),
        );
    }
    if has(
        message,
        &["慢箋", "領藥", "連續處方", "refill", "prescription"],
    ) {
        return text(pick(
            seen.locale,
            "慢箋能不能領，請用畫面上的「慢箋檢核」表單填開立日、日數和領藥次數，結果由程式計算。要繼續問診的話，請告訴我您今天哪裡不舒服。",
            "For refills, please use the refill check form on screen. Enter the prescription date, days and fills collected, and the program works it out. To go on with the history, tell me what is bothering you today.",
        ));
    }
    if has(
        message,
        &[
            "天氣",
            "股票",
            "寫程式",
            "python",
            "笑話",
            "新聞",
            "食譜",
            "電影",
            "匯率",
            "彩券",
            "旅遊",
            "weather",
            "stock",
            "joke",
            "recipe",
        ],
    ) {
        return text(pick(
            seen.locale,
            "這個我幫不上忙，我只協助看診前的問診和慢箋檢核。您今天哪裡不舒服？",
            "I cannot help with that. I only handle pre-visit history and refill checks. What is bothering you today?",
        ));
    }
    if has(
        message,
        &[
            "是不是得了",
            "會不會是",
            "是不是癌",
            "得了什麼病",
            "do i have",
            "is it cancer",
        ],
    ) {
        return tool_call("record_intake", json!({ "patient_questions": [message] }));
    }
    intake_fill(message, seen)
}

fn parse_severity(segment: &str) -> Option<Value> {
    if has(segment, &["不適用", "n/a", "無法"]) {
        return Some(json!("n/a"));
    }
    if let Some(m) = NUMBER.find(segment) {
        return m
            .as_str()
            .parse::<u8>()
            .ok()
            .filter(|n| *n <= 10)
            .map(|n| json!(n));
    }
    const NUMERALS: [(&str, u8); 11] = [
        ("十", 10),
        ("九", 9),
        ("八", 8),
        ("七", 7),
        ("六", 6),
        ("五", 5),
        ("四", 4),
        ("三", 3),
        ("二", 2),
        ("一", 1),
        ("零", 0),
    ];
    NUMERALS
        .iter()
        .find(|(c, _)| segment.contains(c))
        .map(|(_, n)| json!(n))
}

fn is_none_answer(segment: &str) -> bool {
    matches!(
        segment
            .trim()
            .trim_end_matches(['。', '.'])
            .to_lowercase()
            .as_str(),
        "沒有" | "無" | "沒" | "都沒有" | "沒有特別的" | "none" | "no" | "nothing"
    )
}

fn intake_fill(message: &str, seen: &Seen) -> ModelReply {
    let segments: Vec<&str> = message
        .split([';', '；'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let keys: Vec<&str> = if seen.missing.is_empty() {
        vec!["patient_questions"]
    } else {
        seen.missing.iter().map(String::as_str).collect()
    };
    let mut patch = serde_json::Map::new();
    let mut unparsed_severity = false;
    for (segment, key) in segments.iter().zip(keys.iter()) {
        let truncated: String = segment.chars().take(180).collect();
        match *key {
            "chief_complaint" => {
                patch.insert("chief_complaint".into(), json!(truncated));
                if let Some(m) = DURATION.find(segment) {
                    patch.insert("onset".into(), json!(m.as_str()));
                }
            }
            "hpi.severity" => match parse_severity(segment) {
                Some(v) => {
                    patch.insert("severity".into(), v);
                }
                None => unparsed_severity = true,
            },
            "hpi.onset" => {
                patch.insert("onset".into(), json!(truncated));
            }
            "hpi.course" => {
                patch.insert("course".into(), json!(truncated));
            }
            "hpi.location" | "hpi.character" | "hpi.modifiers" | "hpi.associated" => {
                let field = key.trim_start_matches("hpi.");
                let value = if has(segment, &["不知道", "不清楚", "不適用"])
                    && field != "associated"
                {
                    "不適用".to_string()
                } else {
                    truncated
                };
                patch.insert(field.into(), json!(value));
            }
            "past_history" | "medications" | "allergies" => {
                if is_none_answer(segment) {
                    patch.insert(format!("no_{key}"), json!(true));
                } else {
                    patch.insert((*key).into(), json!([truncated]));
                }
            }
            _ => {
                patch.insert("patient_questions".into(), json!([truncated]));
            }
        }
    }
    if patch.is_empty() {
        let ask = if unparsed_severity {
            pick(
                seen.locale,
                "請用 0 到 10 的數字告訴我，0 是不痛，10 是最痛。",
                "Please give me a number from 0 to 10, where 0 is no pain and 10 is the worst.",
            )
        } else {
            question_for(
                seen.missing
                    .first()
                    .map_or("chief_complaint", String::as_str),
                seen.locale,
            )
        };
        return text(ask);
    }
    tool_call("record_intake", Value::Object(patch))
}

fn question_for(key: &str, locale: Locale) -> String {
    let (zh, en) = match key {
        "chief_complaint" => ("您今天哪裡不舒服？", "What is bothering you today?"),
        "hpi.onset" => ("這是什麼時候開始的？", "When did this start?"),
        "hpi.course" => (
            "開始之後有變化嗎？是越來越嚴重，還是差不多？",
            "Has it changed since it started? Is it getting worse or about the same?",
        ),
        "hpi.location" => ("是哪個部位不舒服？", "Where exactly do you feel it?"),
        "hpi.character" => ("是什麼樣的感覺？", "What does it feel like?"),
        "hpi.severity" => (
            "如果 0 分是不痛、10 分是最痛，大概幾分？",
            "On a scale of 0 to 10, where 10 is the worst, how bad is it?",
        ),
        "hpi.modifiers" => (
            "什麼情況會更嚴重，什麼情況會比較舒服？",
            "What makes it worse, and what makes it better?",
        ),
        "hpi.associated" => (
            "還有其他不舒服嗎，例如發燒、想吐？",
            "Anything else with it, such as fever or nausea?",
        ),
        "past_history" => (
            "過去有沒有慢性病，或開過刀？",
            "Any past illnesses or surgeries?",
        ),
        "medications" => (
            "平常有在吃什麼藥嗎？",
            "Do you take any medicines regularly?",
        ),
        "allergies" => (
            "對藥物或食物有過敏嗎？",
            "Any allergies to medicines or food?",
        ),
        _ => ("還有想補充的嗎？", "Anything else you want to add?"),
    };
    pick(locale, zh, en)
}

fn narrative(state: &IntakeState, locale: Locale) -> String {
    let na = "不適用";
    let hpi = &state.hpi;
    let list = |f: &crate::intake::ListField| {
        if f.items.is_empty() {
            pick(locale, "無", "none")
        } else {
            f.items.join("、")
        }
    };
    let text = pick(
        locale,
        &format!(
            "主訴：{}。發作時間：{}；病程：{}；伴隨症狀：{}。過去病史：{}；用藥：{}；過敏：{}。",
            state.chief_complaint.as_deref().unwrap_or(na),
            hpi.onset.as_deref().unwrap_or(na),
            hpi.course.as_deref().unwrap_or(na),
            hpi.associated.as_deref().unwrap_or(na),
            list(&state.past_history),
            list(&state.medications),
            list(&state.allergies),
        ),
        &format!(
            "Chief complaint: {}. Onset: {}; course: {}; associated: {}. Past history: {}; medicines: {}; allergies: {}.",
            state.chief_complaint.as_deref().unwrap_or("N/A"),
            hpi.onset.as_deref().unwrap_or("N/A"),
            hpi.course.as_deref().unwrap_or("N/A"),
            hpi.associated.as_deref().unwrap_or("N/A"),
            list(&state.past_history),
            list(&state.medications),
            list(&state.allergies),
        ),
    );
    text.chars().take(280).collect()
}

fn read_back(state: &IntakeState, locale: Locale) -> String {
    let head = pick(locale, "我把您說的整理一下：", "Here is what I have:");
    let tail = pick(locale, "這樣正確嗎？", "Is that right?");
    format!("{head}\n{}\n{tail}", narrative(state, locale))
}

fn after_tools(results: &[(String, Value)], seen: &Seen) -> String {
    let locale = seen.locale;
    for (name, result) in results {
        match name.as_str() {
            "save_previsit_summary" => {
                return if result["saved"].as_bool() == Some(true) {
                    pick(
                        locale,
                        "摘要已送出，醫師看診前會看到。",
                        "Your summary has been sent and the doctor will see it before the visit.",
                    )
                } else {
                    pick(
                        locale,
                        "摘要還不能送出，還有欄位沒問完。",
                        "The summary cannot be sent yet, some fields are still missing.",
                    )
                };
            }
            "search_health_education" => {
                let hits = result["hits"].as_array().cloned().unwrap_or_default();
                return match hits.first() {
                    Some(hit) => {
                        let title = hit["title"].as_str().unwrap_or("");
                        let source = hit["source_name"].as_str().unwrap_or("");
                        let body: String = hit["text"]
                            .as_str()
                            .unwrap_or("")
                            .chars()
                            .take(80)
                            .collect();
                        pick(
                            locale,
                            &format!("手冊「{title}」這一節提到：{body}（來源：{source}）。"),
                            &format!(
                                "The handbook section \"{title}\" says: {body} (Source: {source})."
                            ),
                        )
                    }
                    None => pick(
                        locale,
                        "手冊沒有這部分，這個請直接問醫師。",
                        "The handbook does not cover that. Please ask the doctor.",
                    ),
                };
            }
            "check_chronic_refill" => {
                let title = result["title"].as_str().unwrap_or("");
                let message = result["message"].as_str().unwrap_or("");
                return format!("{title}。{message}");
            }
            "transfer_to_clinician" => {
                return pick(
                    locale,
                    "我已通知醫師，請在看診時一併說明。",
                    "I have let the doctor know. Please mention it at your visit.",
                );
            }
            "record_intake" => {
                let applied: Vec<&str> = result["applied"]
                    .as_array()
                    .map(|a| a.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                let rejected = result["rejected"].as_array().is_some_and(|r| !r.is_empty());
                let stage = result["stage"].as_str().unwrap_or("");
                let missing: Vec<&str> = result["missing"]
                    .as_array()
                    .map(|a| a.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                let next = if stage == "confirm" {
                    let state = result["state"].clone();
                    let state: IntakeState =
                        serde_json::from_value(state).unwrap_or_else(|_| seen.collected.clone());
                    return read_back(&state, locale);
                } else {
                    let mut asked = missing
                        .first()
                        .map(|k| question_for(k, locale))
                        .unwrap_or_default();
                    if matches!(missing.first(), Some(&"past_history"))
                        && missing.get(1) == Some(&"medications")
                    {
                        asked.push_str(&pick(
                            locale,
                            "目前有在吃什麼藥嗎？",
                            " Do you take any medicines?",
                        ));
                    }
                    asked
                };
                if applied == ["patient_questions"] {
                    return pick(
                        locale,
                        &format!("這要請醫師判斷，我已記到想問醫師的問題。{next}"),
                        &format!(
                            "The doctor has to judge that, and I noted it as a question for them. {next}"
                        ),
                    );
                }
                if rejected && applied.is_empty() {
                    return pick(
                        locale,
                        &format!("這個我不能記錄，請不要輸入姓名、電話這類個人資料。{next}"),
                        &format!(
                            "I cannot record that, please do not enter names or phone numbers. {next}"
                        ),
                    );
                }
                return next;
            }
            _ => {}
        }
    }
    pick(locale, "好，我記下了。", "Noted.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use genai::chat::ChatMessage;

    fn seen_from(system: &str) -> ChatRequest {
        ChatRequest::new(vec![]).with_system(system.to_string())
    }

    fn system(stage: &str, missing: &str) -> String {
        format!(
            "{LINE_STAGE}{stage}\n{LINE_LOCALE}zh-TW\n{LINE_MISSING_KEYS}{missing}\n{LINE_COLLECTED}{{}}"
        )
    }

    fn user_turn(stage: &str, missing: &str, message: &str) -> ModelReply {
        let request = seen_from(&system(stage, missing))
            .append_message(ChatMessage::user(message.to_string()));
        reply(&request)
    }

    #[test]
    fn first_message_becomes_the_chief_complaint_with_an_onset_when_it_has_a_duration() {
        let r = user_turn(
            "chief_complaint",
            "chief_complaint,hpi.onset",
            "我咳嗽三天了",
        );
        assert_eq!(r.tool_calls[0].fn_name, "record_intake");
        assert_eq!(
            r.tool_calls[0].fn_arguments["chief_complaint"],
            "我咳嗽三天了"
        );
        assert_eq!(r.tool_calls[0].fn_arguments["onset"], "三天");
    }

    #[test]
    fn semicolons_fill_one_missing_field_per_segment_in_order() {
        let r = user_turn(
            "hpi",
            "hpi.course,hpi.severity,hpi.associated,past_history",
            "越來越嚴重;6;沒有發燒;沒有",
        );
        let args = &r.tool_calls[0].fn_arguments;
        assert_eq!(args["course"], "越來越嚴重");
        assert_eq!(args["severity"], 6);
        assert_eq!(args["associated"], "沒有發燒");
        assert_eq!(args["no_past_history"], true);
    }

    #[test]
    fn an_unparseable_severity_is_asked_again_without_a_tool_call() {
        let r = user_turn("hpi", "hpi.severity", "很痛");
        assert!(r.tool_calls.is_empty());
        assert!(r.text.expect("text").contains("0 到 10"));
    }

    #[test]
    fn confirmation_saves_the_summary_and_health_questions_search_the_handbook() {
        let r = user_turn("confirm", "hpi.location", "對，正確");
        assert_eq!(r.tool_calls[0].fn_name, "save_previsit_summary");
        assert_eq!(r.tool_calls[0].fn_arguments["confirmed_by_patient"], true);
        let r = user_turn("hpi", "hpi.onset", "發燒什麼時候要去看醫生");
        assert_eq!(r.tool_calls[0].fn_name, "search_health_education");
    }

    #[test]
    fn out_of_scope_gets_a_one_line_refusal_and_medical_judgement_goes_to_the_doctor() {
        let r = user_turn("hpi", "hpi.onset", "今天天氣怎麼樣");
        assert!(r.tool_calls.is_empty() && r.text.expect("text").contains("只協助看診前的問診"));
        let r = user_turn("hpi", "hpi.onset", "我是不是得了癌症");
        assert_eq!(
            r.tool_calls[0].fn_arguments["patient_questions"][0],
            "我是不是得了癌症"
        );
    }

    #[test]
    fn test_hooks_break_the_rules_on_purpose() {
        assert!(
            user_turn("hpi", "hpi.onset", "[mock:diagnosis]")
                .text
                .expect("text")
                .contains("您可能是胃炎")
        );
        assert!(
            user_turn("hpi", "hpi.onset", "[mock:markdown]")
                .text
                .expect("text")
                .contains("**")
        );
    }
}
