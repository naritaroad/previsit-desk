---
title: How it works
summary: The steps a message goes through, what the model can and cannot see, and which decisions are made by code.
version: "2.0"
effective: 2026-11-25
owner: naritaroad (project author)
reviewer: No external clinical review
next_review: 2027-02-25
---

## The path of one message

Suppose a patient sends "I've had a cough for three days, my phone is 0912345678, is it pneumonia?" The following happens in this order, which is fixed in `backend/src/engine.rs` (C-05).

1. **Receipt.** The server checks the sign-in, the length and the sending rate. Too fast, and the patient is asked to wait. Each message carries a unique ID, so a resend after a dropped connection does not become two messages. <!-- verify: V-06 client_id de-duplication and sign-in required (docs/v2/contract.md §3) -->
2. **Masking.** Code finds national ID numbers, mobile and landline numbers, email addresses and runs of eight or more digits, and replaces them with 【已遮蔽】 ("masked"). Every later step, the database and the model see only the masked text. Names cannot be detected reliably and are not masked.
3. **Red-flag check.** The text is normalised and compared with each rule. On a match the patient gets fixed text, an urgent ticket is opened, the visit stops, and the model is not called at all. This runs first in every mode and status, including after a visit has been submitted.
4. **Scope check.** There are {{facts.scope_rules}} rules here. Messages that ask for prescriptions, doses or controlled drugs, or that try to rewrite the system's rules, get a fixed refusal here. The first three kinds also notify the physician.
5. **Budget check.** There are limits per day, per client and per visit. Past a limit the patient sees a fixed explanation. Red flags and the refill check are unaffected.
6. **Model turn.** Code assembles the prompt. The model may ask for five tools: record history, search the handbook, check a refill, hand over to a physician, save the summary. Anything else is refused, and the number of steps is capped (C-08; evidence: the test `specs_cover_exactly_the_whitelist` in `backend/src/tools.rs`).
7. **Output check.** The reply is stripped of formatting and then checked for diagnoses, medication advice and numbers with units. Offending sentences are rewritten or removed, and the result is checked again. If it still fails, the whole reply is replaced with fixed text (C-09; evidence: `sanitize_reply` in `backend/src/guard.rs`).
8. **Saving and sending.** Only text that passed is stored and shown. Every step is written to `tool_calls`, `runs`, `guard_events` and related tables.

For the message above, the phone number is masked, no red flag matches, the pneumonia question is not answered but is recorded under "questions for the doctor", and the model asks about the next missing field.

## What the model sees and does not see

The model receives five things: fixed instructions about its role and limits, the current stage, the fields already collected and those still missing, the history, medicine and allergy entries from the health profile, and the last 24 patient and assistant messages of this visit (C-06; evidence: `backend/src/prompt.rs` and `HISTORY_LIMIT` in `backend/src/engine.rs`). Collected fields and the health profile each sit behind a line saying they are data, and the prompt tells the model not to follow instructions found in them. The profile is there so the assistant can ask "is this still the same?"; nothing from it enters this visit's history until the patient confirms.

The model does not see account names, sign-in details, other patients, other visits, physicians' notes, internal notes or the patient's IP address. The primary model is {{facts.model_primary}}; if it fails, {{facts.model_fallback}} is used. We have not trained or fine-tuned it, and it has no web search. <!-- verify: V-07 recheck health-profile fields in the prompt at freeze (known_block in backend/src/prompt.rs; now conditions, medicines, allergies) -->

## What code decides

Which stage the intake has reached, which fields are missing and when a summary may be saved are computed in `backend/src/intake.rs` and `tools.rs`. Whether a fill can be collected is computed in `backend/src/refill.rs`. Red flags, scope, masking, output checks, limits and retention are all code (C-07). The model's job is to phrase the next question like a person and to put what the patient said into the right field.

The model cannot open an urgent ticket or declare a red flag; only rules can. It also cannot record the last field and save the summary in the same turn. It has to read the summary back, the patient has to say clearly that it is right, and saving is allowed only in the following turn.

## Disconnects, restarts and retries

In v2 a turn runs in the background on the server, separate from the browser connection. Events are numbered and stored, so after a reload or on another device the page picks up from the last number. If the server restarts, an unfinished turn is marked "interrupted", and the patient can see this and retry. <!-- verify: V-08 event stream, resume and interrupted marking are live (docs/v2/product.md §8, table visit_events) --> When a physician or care coordinator takes over, the AI stops replying until the conversation is handed back. The red-flag check keeps running throughout. <!-- verify: V-09 no AI when mode=human, red flags still run (docs/v2/contract.md §3, §5) -->

## On "agents"

The model can use several tools in one turn, which is technically close to what people call an AI agent. The Ministry of Health and Welfare guideline defines an AI agent system as one that can carry out medical tasks autonomously or semi-autonomously, and says such systems are outside its scope for now ([ref. 8][r8]). We limit the tools to recording, looking up and notifying; none can change a prescription or a dispensing record. Whether this counts as an agent system under that definition is not something we are able to judge, and we make no claim either way.

[r8]: https://www.mohw.gov.tw/cp-18-86695-1.html
