//! The tools the model can call: JSON specs, strict argument parsing, dispatch (a whitelist) and trace output.
//! Tools return data, never sentences. The model gets a rich result; the trace stores a compact one
//! (contract §7.5): the handbook text and the full intake state stay out of the stored rows.

use std::sync::LazyLock;
use std::time::Instant;

use regex::Regex;

use genai::chat::Tool;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::guard;
use crate::intake::{IntakePatch, IntakeState, contains_personal_data};
use crate::pii;
use crate::refill::{self, RefillInput};
use crate::state::AppState;
use crate::summary::{self, PrevisitSummary, SummaryInput};
use crate::texts::{T, field_label, t};
use crate::tickets::{self, NewTicket};
use crate::types::{
    CreatedBy, Locale, Stage, Ticket, TicketReason, ToolStatus, Urgency, VisitStatus,
};
use crate::visits;

pub const TOOL_NAMES: [&str; 5] = [
    "record_intake",
    "search_health_education",
    "check_chronic_refill",
    "transfer_to_clinician",
    "save_previsit_summary",
];

/// Reasons a model may use: everything except `red_flag` (only the program opens those).
const MODEL_TICKET_REASONS: [&str; 7] = [
    "patient_request",
    "out_of_scope_medical",
    "symptom_change",
    "side_effects",
    "prescription_request",
    "controlled_drug",
    "other",
];

/// The tool specs the model sees.
pub fn specs() -> Vec<Tool> {
    vec![
        Tool::new("record_intake")
            .with_description("把病人剛說的內容記進問診欄位。每當病人說了新資訊（包括「沒有」「不知道」）就先呼叫。只填這一輪新取得的欄位，其餘不要送。回傳 stage（目前階段）和 missing（還缺的欄位）。")
            .with_schema(json!({
                "type": "object",
                "properties": {
                    "chief_complaint": { "type": "string", "description": "主訴，病人最困擾的症狀，用病人自己的說法，200 字內" },
                    "onset": { "type": "string", "description": "O：什麼時候開始" },
                    "course": { "type": "string", "description": "T：開始後怎麼變化、持續多久" },
                    "location": { "type": "string", "description": "R：部位或放射到哪裡；不適用就填「不適用」" },
                    "character": { "type": "string", "description": "Q：性質，例如悶、刺、燒灼" },
                    "severity": { "type": "integer", "minimum": 0, "maximum": 10, "description": "S：嚴重度 0 到 10；病人無法評分時填 \"n/a\"" },
                    "modifiers": { "type": "string", "description": "P：什麼情況加重或緩解" },
                    "associated": { "type": "string", "description": "伴隨症狀；沒有就填「沒有」" },
                    "past_history": { "type": "array", "items": { "type": "string" }, "description": "病人提到的過去病史，每項 80 字內" },
                    "no_past_history": { "type": "boolean", "description": "病人說沒有過去病史時填 true" },
                    "medications": { "type": "array", "items": { "type": "string" }, "description": "目前在吃的藥，照病人說的原樣" },
                    "no_medications": { "type": "boolean", "description": "病人說沒有在吃藥時填 true" },
                    "allergies": { "type": "array", "items": { "type": "string" }, "description": "藥物或食物過敏" },
                    "no_allergies": { "type": "boolean", "description": "病人說沒有過敏時填 true" },
                    "patient_questions": { "type": "array", "items": { "type": "string" }, "description": "病人想問醫師的問題" }
                }
            })),
        Tool::new("search_health_education")
            .with_description("查衛教手冊：就醫時機、警訊、看診流程、慢箋領藥流程。只回傳手冊原文和來源；hits 為空代表手冊沒有這部分，不可自己編。")
            .with_schema(json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "病人的問題，用他自己的話" },
                    "top_k": { "type": "integer", "minimum": 1, "maximum": 3, "description": "要幾段，預設 2" }
                },
                "required": ["query"]
            })),
        Tool::new("check_chronic_refill")
            .with_description("檢核慢性病連續處方箋現在能不能領藥，由程式依規則計算。只在病人已經說清楚下列所有資料時才用，否則請他用「慢箋檢核」表單。日期用 YYYY-MM-DD。不要自己推算結果。")
            .with_schema(json!({
                "type": "object",
                "properties": {
                    "prescription_date": { "type": "string", "description": "慢箋開立日 YYYY-MM-DD" },
                    "total_days": { "type": "integer", "minimum": 1, "description": "醫師開立的總給藥日數" },
                    "days_per_fill": { "type": "integer", "minimum": 1, "description": "每次調劑日數" },
                    "fills_done": { "type": "integer", "minimum": 1, "maximum": 3, "description": "已經領過幾次（含第一次）" },
                    "last_fill_date": { "type": "string", "description": "上次領藥日 YYYY-MM-DD" },
                    "controlled": { "type": "string", "enum": ["no", "yes", "unsure"], "description": "處方是否含第一、二級管制藥品" },
                    "special_status": { "type": "string", "enum": ["none", "going_abroad", "returning_island", "ocean_fishing_crew", "international_crew", "rare_disease"] },
                    "symptom_changed": { "type": "boolean", "description": "最近症狀有沒有變化" },
                    "side_effects": { "type": "boolean", "description": "服藥後有沒有不舒服或疑似副作用" }
                },
                "required": ["prescription_date", "total_days", "days_per_fill", "fills_done", "last_fill_date", "controlled", "special_status", "symptom_changed", "side_effects"]
            })),
        Tool::new("transfer_to_clinician")
            .with_description("請醫師端留意或聯絡病人。只在病人要求醫師聯絡、提到症狀變化或藥物副作用、有需要醫師知道的醫療問題時用。紅旗、要求開藥、慢箋檢核需要洽詢這三種情況程式已自動通知，不要再呼叫。")
            .with_schema(json!({
                "type": "object",
                "properties": {
                    "reason": { "type": "string", "enum": MODEL_TICKET_REASONS },
                    "urgency": { "type": "string", "enum": ["routine", "soon"] },
                    "summary": { "type": "string", "description": "給醫師看的說明，300 字內，不含個人資料" }
                },
                "required": ["reason", "urgency", "summary"]
            })),
        Tool::new("save_previsit_summary")
            .with_description("病人確認摘要正確之後，儲存並送出預問診摘要。只在確認階段、病人明確說正確之後才呼叫。結構化欄位由程式從已記錄的內容產生，您只需提供 narrative。")
            .with_schema(json!({
                "type": "object",
                "properties": {
                    "confirmed_by_patient": { "type": "boolean", "description": "病人已明確確認摘要正確時填 true" },
                    "narrative": { "type": "string", "description": "給醫師看的一段摘要，300 字內，只寫病人說的，不含診斷或用藥建議" }
                },
                "required": ["confirmed_by_patient", "narrative"]
            })),
    ]
}

/// Everything a tool call may change besides its own result; the engine turns these into events.
#[derive(Default)]
pub struct Effects {
    pub intake_changed: bool,
    pub ticket: Option<Ticket>,
    pub summary: Option<PrevisitSummary>,
}

pub struct ToolOutcome {
    pub status: ToolStatus,
    /// What the model sees.
    pub model_result: Value,
    /// What the trace stores and the stream sends.
    pub stored_result: Value,
    pub duration_ms: i32,
    pub effects: Effects,
}

/// The live state of the visit during one model run.
pub struct ToolCtx<'a> {
    pub state: &'a AppState,
    pub visit_id: Uuid,
    pub locale: Locale,
    pub model: &'a str,
    pub intake: IntakeState,
    pub stage: Stage,
    /// A read-back was given and the intake has not changed since: only then may a summary be saved.
    pub confirm_offered: bool,
    pub status: VisitStatus,
    pub patient_text: String,
    /// The patient's message of this turn (masked), checked for a clear confirmation before a summary is saved.
    pub patient_message: String,
}

fn rejected(detail: impl Into<String>) -> (ToolStatus, Value, Value) {
    let body = json!({ "error": "invalid_arguments", "detail": detail.into() });
    (ToolStatus::Rejected, body.clone(), body)
}

fn parse<T: for<'de> Deserialize<'de>>(args: &Value) -> Result<T, String> {
    serde_json::from_value(args.clone()).map_err(|e| e.to_string())
}

pub async fn dispatch(ctx: &mut ToolCtx<'_>, name: &str, args: &Value) -> ToolOutcome {
    let started = Instant::now();
    let mut effects = Effects::default();
    let (status, model_result, stored_result) = match name {
        "record_intake" => record_intake(ctx, args, &mut effects).await,
        "search_health_education" => search_health_education(ctx, args),
        "check_chronic_refill" => check_chronic_refill(ctx, args, &mut effects).await,
        "transfer_to_clinician" => transfer_to_clinician(ctx, args, &mut effects).await,
        "save_previsit_summary" => save_previsit_summary(ctx, args, &mut effects).await,
        other => rejected(format!(
            "unknown tool {other}; use one of {}",
            TOOL_NAMES.join(", ")
        )),
    };
    ToolOutcome {
        status,
        model_result,
        stored_result,
        duration_ms: started.elapsed().as_millis().min(i32::MAX as u128) as i32,
        effects,
    }
}

fn db_error(e: &sqlx::Error) -> (ToolStatus, Value, Value) {
    tracing::error!(error = %e, "tool database error");
    let body = json!({ "error": "internal" });
    (ToolStatus::Error, body.clone(), body)
}

async fn record_intake(
    ctx: &mut ToolCtx<'_>,
    args: &Value,
    effects: &mut Effects,
) -> (ToolStatus, Value, Value) {
    let patch: IntakePatch = match parse(args) {
        Ok(p) => p,
        Err(e) => return rejected(e),
    };
    // Model-written values get the same guard as a reply: a diagnosis or a dose the patient never said
    // does not become part of the record.
    let mut patch = patch;
    let removed = guard_patch(&mut patch, ctx.locale, &ctx.patient_text);
    let mut outcome = ctx.intake.apply(&patch);
    outcome.rejected.extend(removed);
    if !outcome.applied.is_empty() {
        let new_stage = if ctx.stage == Stage::Done {
            Stage::Done
        } else {
            ctx.intake.stage()
        };
        if let Err(e) =
            visits::save_intake(&ctx.state.db, ctx.visit_id, &ctx.intake, new_stage).await
        {
            return db_error(&e);
        }
        ctx.stage = new_stage;
        effects.intake_changed = true;
        // Whatever was read back is out of date now; it has to be read back again.
        ctx.confirm_offered = false;
    }
    let rejected_list: Vec<Value> = outcome
        .rejected
        .iter()
        .map(|(field, reason)| json!({ "field": field, "reason": reason }))
        .collect();
    let stored = json!({ "applied": outcome.applied, "rejected": rejected_list });
    let missing = ctx.intake.missing();
    let model = json!({
        "applied": outcome.applied,
        "rejected": rejected_list,
        "stage": ctx.stage.as_str(),
        "missing": missing,
        "missing_labels": missing.iter().map(|k| field_label(k, Locale::ZhTw)).collect::<Vec<_>>(),
        "state": ctx.intake,
    });
    let status = if outcome.applied.is_empty() && !outcome.rejected.is_empty() {
        ToolStatus::Rejected
    } else {
        ToolStatus::Ok
    };
    (status, model, stored)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArgs {
    query: String,
    top_k: Option<usize>,
}

fn search_health_education(ctx: &ToolCtx<'_>, args: &Value) -> (ToolStatus, Value, Value) {
    let parsed: SearchArgs = match parse(args) {
        Ok(a) => a,
        Err(e) => return rejected(e),
    };
    let query = parsed.query.trim();
    if query.is_empty() || query.chars().count() > 300 {
        return rejected("query must be 1 to 300 characters");
    }
    let hits = ctx.state.handbook.search(query, parsed.top_k.unwrap_or(2));
    let stored: Vec<Value> = hits.iter().map(|h| json!({ "section": h.section, "title": h.title, "source_type": h.source_type, "source_name": h.source_name, "source_url": h.source_url, "verified_on": h.verified_on, "score": h.score })).collect();
    let model: Vec<Value> = hits.iter().map(|h| json!({ "section": h.section, "title": h.title, "text": h.text, "source_type": h.source_type, "source_name": h.source_name, "source_url": h.source_url, "verified_on": h.verified_on })).collect();
    let note = if hits.is_empty() {
        "手冊沒有這部分。請告訴病人手冊沒有，請他直接問醫師；不要自己編。"
    } else {
        "只依 text 回答，並說出 source_name。"
    };
    (
        ToolStatus::Ok,
        json!({ "hits": model, "note": note }),
        json!({ "hits": stored }),
    )
}

/// What `perform_refill_check` hands back: the result with its ticket, or the field errors.
pub struct RefillRun {
    pub result: refill::RefillResult,
    pub ticket: Option<Ticket>,
}

/// Validates, evaluates and records a refill check, opening a ticket for every `consult`.
/// Used by the form endpoint (`CreatedBy::Form`) and the model tool (`CreatedBy::Model`).
pub async fn perform_refill_check(
    state: &AppState,
    visit_id: Uuid,
    locale: Locale,
    input: &RefillInput,
    created_by: CreatedBy,
) -> Result<Result<RefillRun, refill::FieldErrors>, sqlx::Error> {
    let checked = match refill::validate(input, &state.rules.refill, state.clock.today(), locale) {
        Ok(c) => c,
        Err(errors) => return Ok(Err(errors)),
    };
    let evaluation = refill::check(&checked, &state.rules.refill, locale);
    let mut result = evaluation.result;
    let mut ticket = None;
    if let Some(plan) = evaluation.ticket {
        let created = tickets::create_or_get(
            &state.db,
            &state.clock,
            NewTicket {
                visit_id,
                reason: plan.reason,
                urgency: plan.urgency,
                summary: &plan.summary,
                created_by,
            },
        )
        .await?;
        result.ticket_no = Some(created.ticket.ticket_no.clone());
        if !created.deduped {
            ticket = Some(created.ticket);
        }
    }
    let input_json = serde_json::to_value(input).unwrap_or(Value::Null);
    let result_json = serde_json::to_value(&result).unwrap_or(Value::Null);
    sqlx::query("INSERT INTO refill_checks (visit_id, input, result) VALUES ($1, $2, $3)")
        .bind(visit_id)
        .bind(input_json)
        .bind(result_json)
        .execute(&state.db)
        .await?;
    visits::touch(&state.db, visit_id).await?;
    Ok(Ok(RefillRun { result, ticket }))
}

async fn check_chronic_refill(
    ctx: &mut ToolCtx<'_>,
    args: &Value,
    effects: &mut Effects,
) -> (ToolStatus, Value, Value) {
    // The model path never accepts `today`: the server date decides.
    let input = match RefillInput::from_json(args, false, ctx.locale) {
        Ok(i) => i,
        Err(fields) => {
            let body = json!({ "error": "invalid_arguments", "fields": fields });
            return (ToolStatus::Rejected, body.clone(), body);
        }
    };
    match perform_refill_check(
        ctx.state,
        ctx.visit_id,
        ctx.locale,
        &input,
        CreatedBy::Model,
    )
    .await
    {
        Err(e) => db_error(&e),
        Ok(Err(fields)) => {
            let body = json!({ "error": "invalid_arguments", "fields": fields });
            (ToolStatus::Rejected, body.clone(), body)
        }
        Ok(Ok(run)) => {
            effects.ticket = run.ticket;
            let body = serde_json::to_value(&run.result).unwrap_or(Value::Null);
            (ToolStatus::Ok, body.clone(), body)
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransferArgs {
    reason: String,
    urgency: String,
    summary: String,
}

async fn transfer_to_clinician(
    ctx: &mut ToolCtx<'_>,
    args: &Value,
    effects: &mut Effects,
) -> (ToolStatus, Value, Value) {
    let parsed: TransferArgs = match parse(args) {
        Ok(a) => a,
        Err(e) => return rejected(e),
    };
    if !MODEL_TICKET_REASONS.contains(&parsed.reason.as_str()) {
        return rejected(format!(
            "reason must be one of {}; red_flag is opened by the program only",
            MODEL_TICKET_REASONS.join(", ")
        ));
    }
    let urgency = match parsed.urgency.as_str() {
        "routine" => Urgency::Routine,
        "soon" => Urgency::Soon,
        _ => {
            return rejected(
                "urgency must be routine or soon; a model may not raise an urgent ticket",
            );
        }
    };
    let mut summary = pii::mask(parsed.summary.trim()).text;
    let length = summary.chars().count();
    if length == 0 || length > 300 {
        return rejected("summary must be 1 to 300 characters");
    }
    // The ticket text reaches the clinician and the patient's own view: no diagnosis or dose wording.
    if !guard::is_clean(&summary, ctx.locale, &ctx.patient_text) {
        summary = t(T::TransferSummaryFallback, ctx.locale).to_string();
    }
    let reason = TicketReason::parse(&parsed.reason).unwrap_or(TicketReason::Other);
    match tickets::create_or_get(
        &ctx.state.db,
        &ctx.state.clock,
        NewTicket {
            visit_id: ctx.visit_id,
            reason,
            urgency,
            summary: &summary,
            created_by: CreatedBy::Model,
        },
    )
    .await
    {
        Err(e) => db_error(&e),
        Ok(created) => {
            let body = json!({ "ticket_no": created.ticket.ticket_no, "deduped": created.deduped });
            if !created.deduped {
                effects.ticket = Some(created.ticket);
            }
            (ToolStatus::Ok, body.clone(), body)
        }
    }
}

const GUARD_REASON: &str =
    "wording that diagnoses or advises on medicine or doses; record only what the patient said";

fn guard_text(
    field: &str,
    slot: &mut Option<String>,
    locale: Locale,
    patient_text: &str,
    rejected: &mut Vec<(String, String)>,
) {
    if slot
        .as_deref()
        .is_some_and(|v| !guard::is_clean(v, locale, patient_text))
    {
        rejected.push((field.to_string(), GUARD_REASON.to_string()));
        *slot = None;
    }
}

fn guard_list(
    field: &str,
    items: &mut Option<Vec<String>>,
    locale: Locale,
    patient_text: &str,
    rejected: &mut Vec<(String, String)>,
) {
    if let Some(list) = items {
        let before = list.len();
        list.retain(|item| guard::is_clean(item, locale, patient_text));
        if list.len() != before {
            rejected.push((field.to_string(), GUARD_REASON.to_string()));
        }
    }
}

/// Removes the values of a `record_intake` patch that fail the output guard and reports each as rejected.
pub fn guard_patch(
    patch: &mut IntakePatch,
    locale: Locale,
    patient_text: &str,
) -> Vec<(String, String)> {
    let mut rejected = Vec::new();
    guard_text(
        "chief_complaint",
        &mut patch.chief_complaint,
        locale,
        patient_text,
        &mut rejected,
    );
    guard_text(
        "hpi.onset",
        &mut patch.onset,
        locale,
        patient_text,
        &mut rejected,
    );
    guard_text(
        "hpi.modifiers",
        &mut patch.modifiers,
        locale,
        patient_text,
        &mut rejected,
    );
    guard_text(
        "hpi.character",
        &mut patch.character,
        locale,
        patient_text,
        &mut rejected,
    );
    guard_text(
        "hpi.location",
        &mut patch.location,
        locale,
        patient_text,
        &mut rejected,
    );
    guard_text(
        "hpi.course",
        &mut patch.course,
        locale,
        patient_text,
        &mut rejected,
    );
    guard_text(
        "hpi.associated",
        &mut patch.associated,
        locale,
        patient_text,
        &mut rejected,
    );
    if let Some(hpi) = patch.hpi.as_mut() {
        guard_text(
            "hpi.onset",
            &mut hpi.onset,
            locale,
            patient_text,
            &mut rejected,
        );
        guard_text(
            "hpi.modifiers",
            &mut hpi.modifiers,
            locale,
            patient_text,
            &mut rejected,
        );
        guard_text(
            "hpi.character",
            &mut hpi.character,
            locale,
            patient_text,
            &mut rejected,
        );
        guard_text(
            "hpi.location",
            &mut hpi.location,
            locale,
            patient_text,
            &mut rejected,
        );
        guard_text(
            "hpi.course",
            &mut hpi.course,
            locale,
            patient_text,
            &mut rejected,
        );
        guard_text(
            "hpi.associated",
            &mut hpi.associated,
            locale,
            patient_text,
            &mut rejected,
        );
    }
    guard_list(
        "past_history",
        &mut patch.past_history,
        locale,
        patient_text,
        &mut rejected,
    );
    guard_list(
        "medications",
        &mut patch.medications,
        locale,
        patient_text,
        &mut rejected,
    );
    guard_list(
        "allergies",
        &mut patch.allergies,
        locale,
        patient_text,
        &mut rejected,
    );
    guard_list(
        "patient_questions",
        &mut patch.patient_questions,
        locale,
        patient_text,
        &mut rejected,
    );
    rejected
}

const REMOVED: &str = "【已移除】";

/// Tool arguments are model-written. Before they are stored or shown in the trace panel, mask personal data
/// and replace any string that fails the output guard.
pub fn sanitize_args(value: &Value, locale: Locale, patient_text: &str) -> Value {
    match value {
        Value::String(text) => {
            let masked = pii::mask(text).text;
            if guard::is_clean(&masked, locale, patient_text) {
                Value::String(masked)
            } else {
                Value::String(REMOVED.to_string())
            }
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| sanitize_args(v, locale, patient_text))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), sanitize_args(v, locale, patient_text)))
                .collect(),
        ),
        other => other.clone(),
    }
}

static AFFIRM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)對|正確|是的|確認|可以|沒錯|沒有錯|沒問題|沒有問題|\b(ok|okay|yes|yeah|correct|right|sure)\b").expect("regex")
});
static DISAGREE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)不對|不正確|不是|錯|更正|修改|改成|補充|但|不過|其實|\b(no|not|wrong|incorrect|actually|but|except)\b").expect("regex")
});

/// A clear "yes, that is right". "沒有了" (nothing to add) and "對，但是…" (a correction follows) do not count.
pub fn is_confirmation(message: &str) -> bool {
    let text = message.trim();
    let neutral = text
        .replace("沒有錯", "")
        .replace("沒錯", "")
        .replace("沒有問題", "")
        .replace("沒問題", "");
    AFFIRM.is_match(text) && !DISAGREE.is_match(&neutral)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveArgs {
    confirmed_by_patient: bool,
    narrative: String,
}

async fn save_previsit_summary(
    ctx: &mut ToolCtx<'_>,
    args: &Value,
    effects: &mut Effects,
) -> (ToolStatus, Value, Value) {
    let parsed: SaveArgs = match parse(args) {
        Ok(a) => a,
        Err(e) => return rejected(e),
    };
    if !parsed.confirmed_by_patient {
        return rejected(
            "ask the patient to confirm the read-back first; call again with confirmed_by_patient true only after they say it is correct",
        );
    }
    if !ctx.confirm_offered {
        let body = json!({ "error": "not_ready", "detail": "請先向病人念出摘要並等病人確認：這一輪先念給病人聽，等病人下一則訊息說正確，再呼叫一次" });
        return (ToolStatus::Rejected, body.clone(), body);
    }
    if !is_confirmation(&ctx.patient_message) {
        let body = json!({ "error": "not_confirmed", "detail": "病人的這則訊息還不算確認：請先問「這樣正確嗎？」，等病人明確說對或正確，再呼叫" });
        return (ToolStatus::Rejected, body.clone(), body);
    }
    if ctx.intake.stage() != Stage::Confirm {
        let missing: Vec<&str> = ctx
            .intake
            .missing()
            .into_iter()
            .filter(|k| {
                [
                    "chief_complaint",
                    "hpi.onset",
                    "hpi.course",
                    "hpi.severity",
                    "hpi.associated",
                    "past_history",
                    "medications",
                    "allergies",
                ]
                .contains(k)
            })
            .collect();
        let body = json!({ "error": "not_ready", "detail": "the required fields are not all collected yet", "missing": missing });
        return (ToolStatus::Rejected, body.clone(), body);
    }
    // The narrative is model prose: it must pass the same guard and personal-data checks as a reply.
    let narrative = parsed.narrative.trim().to_string();
    let usable = !narrative.is_empty()
        && narrative.chars().count() <= summary::NARRATIVE_MAX_CHARS
        && !pii::looks_personal(&narrative)
        && !contains_personal_data(&narrative)
        && guard::check(&narrative, ctx.locale, &ctx.patient_text).passed();
    let flags = match visits::triggered_flags(
        &ctx.state.db,
        &ctx.state.rules.red_flags,
        ctx.visit_id,
        ctx.locale,
    )
    .await
    {
        Ok(f) => f,
        Err(e) => return db_error(&e),
    };
    let refill = visits::latest_refill(&ctx.state.db, ctx.visit_id)
        .await
        .unwrap_or(None);
    let built = summary::build(SummaryInput {
        visit_id: ctx.visit_id,
        intake: &ctx.intake,
        locale: ctx.locale,
        flags,
        refill,
        narrative: usable.then_some(narrative),
        model: Some(ctx.model.to_string()),
        now: ctx.state.clock.now(),
    });
    if let Err(e) = summary::save(&ctx.state.db, &built).await {
        return db_error(&e);
    }
    if let Err(e) = visits::finalize_submit(&ctx.state.db, ctx.visit_id).await {
        return db_error(&e);
    }
    ctx.stage = Stage::Done;
    if ctx.status == VisitStatus::Active {
        ctx.status = VisitStatus::Submitted;
    }
    let body = json!({ "saved": true, "not_collected": built.not_collected, "narrative_from_model": usable });
    let stored = json!({ "saved": true, "not_collected": built.not_collected });
    effects.summary = Some(built);
    effects.intake_changed = true;
    (ToolStatus::Ok, body, stored)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_cover_exactly_the_whitelist() {
        let specs = specs();
        let names: Vec<String> = specs.iter().map(|t| t.name.to_string()).collect();
        assert_eq!(names, TOOL_NAMES.map(String::from).to_vec());
    }

    #[test]
    fn the_model_schema_for_refills_has_no_today() {
        let spec = specs()
            .into_iter()
            .find(|t| t.name.to_string() == "check_chronic_refill")
            .expect("spec");
        let schema = spec.schema.expect("schema");
        assert!(schema["properties"].get("today").is_none());
        assert_eq!(schema["required"].as_array().map(Vec::len), Some(9));
    }

    #[test]
    fn the_transfer_schema_excludes_red_flag_and_urgent() {
        let spec = specs()
            .into_iter()
            .find(|t| t.name.to_string() == "transfer_to_clinician")
            .expect("spec");
        let schema = spec.schema.expect("schema");
        let reasons: Vec<&str> = schema["properties"]["reason"]["enum"]
            .as_array()
            .expect("enum")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(!reasons.contains(&"red_flag"));
        assert_eq!(
            schema["properties"]["urgency"]["enum"],
            json!(["routine", "soon"])
        );
        assert_eq!(MODEL_TICKET_REASONS.len(), reasons.len());
    }

    fn patch(value: Value) -> IntakePatch {
        serde_json::from_value(value).expect("patch")
    }

    #[test]
    fn diagnosis_and_dose_wording_never_reaches_the_record() {
        let mut p = patch(json!({
            "chief_complaint": "疑似胃炎",
            "onset": "昨天",
            "associated": "建議吃兩顆止痛藥",
            "medications": ["降血壓藥 5mg", "每天加到 10mg"],
            "patient_questions": ["我是不是得了肺炎"],
            "hpi": { "course": "您可能是感冒" }
        }));
        let rejected = guard_patch(&mut p, Locale::ZhTw, "我吃降血壓藥 5mg，我是不是得了肺炎");
        let fields: Vec<&str> = rejected.iter().map(|(f, _)| f.as_str()).collect();
        assert!(
            fields.contains(&"chief_complaint")
                && fields.contains(&"hpi.associated")
                && fields.contains(&"medications")
                && fields.contains(&"hpi.course"),
            "{fields:?}"
        );
        assert_eq!(p.chief_complaint, None);
        assert_eq!(p.onset.as_deref(), Some("昨天"));
        assert_eq!(
            p.medications,
            Some(vec!["降血壓藥 5mg".to_string()]),
            "the patient's own dose stays"
        );
        assert_eq!(
            p.patient_questions,
            Some(vec!["我是不是得了肺炎".to_string()]),
            "the patient's own question stays"
        );
        assert_eq!(p.hpi.expect("hpi").course, None);
    }

    #[test]
    fn trace_arguments_are_masked_and_scrubbed() {
        let args = json!({ "summary": "病人電話 0912345678，請聯絡", "note": "建議每天吃兩顆", "n": 3, "list": ["沒問題", "您可能是胃炎"] });
        let shown = sanitize_args(&args, Locale::ZhTw, "");
        assert_eq!(shown["summary"], json!("病人電話 【已遮蔽】，請聯絡"));
        assert_eq!(shown["note"], json!("【已移除】"));
        assert_eq!(shown["n"], json!(3));
        assert_eq!(shown["list"], json!(["沒問題", "【已移除】"]));
    }

    #[test]
    fn only_a_clear_yes_confirms_the_read_back() {
        for yes in [
            "對",
            "對，沒錯",
            "對，以上正確",
            "正確",
            "沒問題",
            "是的",
            "可以",
            "OK",
            "yes that is right",
            "Correct",
            "沒有錯",
        ] {
            assert!(is_confirmation(yes), "{yes}");
        }
        for no in [
            "沒有了",
            "沒有",
            "不對",
            "不正確",
            "對，但是我還有過敏",
            "不是這樣",
            "我想補充一下",
            "no",
            "no that is wrong",
            "還有一點",
            "好像怪怪的",
            "",
        ] {
            assert!(!is_confirmation(no), "{no}");
        }
    }

    #[test]
    fn strict_argument_parsing_rejects_unknown_fields() {
        assert!(
            parse::<TransferArgs>(
                &json!({"reason": "other", "urgency": "soon", "summary": "x", "extra": 1})
            )
            .is_err()
        );
        assert!(
            parse::<SaveArgs>(&json!({"confirmed_by_patient": "yes", "narrative": "x"})).is_err()
        );
        assert!(parse::<SearchArgs>(&json!({"query": "發燒", "top_k": 2})).is_ok());
        assert!(parse::<SearchArgs>(&json!({"q": "發燒"})).is_err());
    }
}
