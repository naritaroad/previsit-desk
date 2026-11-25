//! Two tools for the chat engine: read the patient's own medicine list, and open a draft request for them to finish.
//! Both act as the signed-in patient only. Neither submits anything, and no dose text leaves this module.
//!
//! The chat engine registers [`specs`] and calls [`dispatch`] with the visit's `patient_id`.

use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::medications;
use super::store;
use super::texts::{R, rt};
use super::{RxKind, wire_enum};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::types::Locale;

wire_enum!(Tool {
    ListMyPrescriptions => "list_my_prescriptions",
    StartRxDraft => "start_rx_draft",
});

#[allow(dead_code)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: Value,
}

/// Name, description and JSON schema of both tools.
#[allow(dead_code)]
pub fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: Tool::ListMyPrescriptions.as_str(),
            description: "Read the patient's own medicine list: names, supply end dates, refill windows, and whether a renewal can be requested. Read only. Never use it to comment on a dose.",
            schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        ToolSpec {
            name: Tool::StartRxDraft.as_str(),
            description: "Open a draft refill booking or renewal request for the patient to finish on the request page. Use only after the patient asked for it, with prescription ids from list_my_prescriptions. It does not submit anything; a physician or pharmacist decides. Give the patient the returned link.",
            schema: json!({
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["refill", "renewal"] },
                    "prescription_ids": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": store::MAX_ITEMS }
                },
                "required": ["kind", "prescription_ids"],
                "additionalProperties": false
            }),
        },
    ]
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartArgs {
    kind: String,
    prescription_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoArgs {}

/// Runs one of the tools for `patient`. `Ok(Err(reason))` is a rejected call the model can correct; `Err` is a failure.
#[allow(dead_code)]
pub async fn dispatch(
    state: &AppState,
    patient: Uuid,
    locale: Locale,
    name: &str,
    args: &Value,
) -> AppResult<Result<Value, String>> {
    match Tool::parse(name) {
        Some(Tool::ListMyPrescriptions) => {
            if let Err(e) = serde_json::from_value::<NoArgs>(args.clone()) {
                return Ok(Err(e.to_string()));
            }
            Ok(Ok(list_my_prescriptions(state, patient, locale).await?))
        }
        Some(Tool::StartRxDraft) => match serde_json::from_value::<StartArgs>(args.clone()) {
            Ok(a) => start_rx_draft(state, patient, locale, &a.kind, &a.prescription_ids).await,
            Err(e) => Ok(Err(e.to_string())),
        },
        None => Ok(Err(format!("unknown tool {name}"))),
    }
}

pub async fn list_my_prescriptions(
    state: &AppState,
    patient: Uuid,
    locale: Locale,
) -> AppResult<Value> {
    let items: Vec<Value> = store::cards(state, patient, locale)
        .await?
        .iter()
        .map(|c| medications::summary_line(c, locale))
        .collect();
    Ok(json!({ "items": items, "link": "/app/medications" }))
}

pub async fn start_rx_draft(
    state: &AppState,
    patient: Uuid,
    locale: Locale,
    kind: &str,
    prescription_ids: &[String],
) -> AppResult<Result<Value, String>> {
    let Some(kind) = RxKind::parse(kind) else {
        return Ok(Err("kind must be refill or renewal".into()));
    };
    let mut ids = Vec::new();
    for id in prescription_ids {
        match Uuid::parse_str(id) {
            Ok(id) => ids.push(id),
            Err(_) => {
                return Ok(Err(
                    "prescription_ids must come from list_my_prescriptions".into()
                ));
            }
        }
    }
    let link = |id: &str| format!("/app/rx/{id}");
    match store::create_draft(state, patient, locale, kind, &ids).await {
        Ok(id) => Ok(Ok(json!({
            "id": id,
            "kind": kind.as_str(),
            "link": link(&id.to_string()),
            "submitted": false,
            "note": rt(R::ChatDraftNote, locale),
        }))),
        // There is one already: point at it instead of opening a second one.
        Err(AppError::UnprocessableWith(_, current)) => {
            let id = current["open_request_id"]
                .as_str()
                .unwrap_or("")
                .to_string();
            Ok(Ok(json!({
                "id": id,
                "kind": kind.as_str(),
                "link": link(&id),
                "already_open": true,
                "note": rt(R::ErrOpenRequest, locale),
            })))
        }
        Err(AppError::NotFound) => Ok(Err(
            "that prescription is not one of this patient's; call list_my_prescriptions first"
                .into(),
        )),
        Err(AppError::Unprocessable(fields)) => {
            Ok(Err(fields.into_values().collect::<Vec<_>>().join(" ")))
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schemas_are_closed_and_cover_both_tools() {
        let specs = specs();
        assert_eq!(specs.len(), Tool::ALL.len());
        for (spec, tool) in specs.iter().zip(Tool::ALL) {
            assert_eq!(spec.name, tool.as_str());
            assert_eq!(spec.schema["additionalProperties"], false);
        }
    }

    #[test]
    fn extra_arguments_are_refused() {
        assert!(serde_json::from_value::<NoArgs>(json!({"patient_id": "x"})).is_err());
        assert!(
            serde_json::from_value::<StartArgs>(
                json!({"kind": "renewal", "prescription_ids": ["x"], "patient_id": "y"})
            )
            .is_err(),
            "the model cannot act for another patient"
        );
        assert!(
            serde_json::from_value::<StartArgs>(
                json!({"kind": "renewal", "prescription_ids": ["x"], "submit": true})
            )
            .is_err()
        );
    }
}
