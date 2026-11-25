---
title: Clinical safety
summary: How red flags and output checks work, sentences known to be missed, stopping rules, and the full hazard log.
version: "2.0"
effective: 2026-11-25
owner: naritaroad (project author)
reviewer: No external clinical review
next_review: 2027-02-25
---

## Method

We list the harms the system could cause and, for each, the cause, the controls and the risk that remains. The result is the hazard log at the end of this page. Its columns follow the kind of hazard log that standards such as DCB0129 call for. The author rated each risk by judgement, as likelihood times consequence, using the worst reasonable case for the consequence. Identifiers are never reused, and closed hazards stay in the log. No clinical safety officer has signed it (see C-02). It shows only what one engineer could think of.

## How red flags are checked

The rules are in `data/seed/red_flags.csv`, currently {{facts.red_flag_rules}} of them in eight categories: chest pain, trouble breathing, signs of stroke, altered consciousness, bleeding in the digestive tract, severe allergy, seizure, and suicide or self-harm (including overdose and poisoning). If any rule is malformed the server refuses to start.

Before matching, the text is made uniform: full-width characters become half-width, invisible characters are removed, a fixed set of a hundred-odd Simplified characters is folded to Traditional, and the message is split into clauses at punctuation. A negation counts only if it governs the symptom directly, within the same clause. 「我沒有胸痛」 (I have no chest pain) does not trigger. 「沒睡好今天胸口很痛」 (slept badly, chest hurts today), 「沒多久就昏倒了」 (fainted soon after) and 「我沒有發燒，胸口很悶痛」 (no fever, tight painful chest) all do (C-11; evidence: the test `a_negator_of_another_verb_never_cancels_a_symptom` in `backend/src/precheck/mod.rs`). Past tense still triggers, because we prefer too many alerts to too few.

On a match the patient sees fixed text. For physical symptoms it says to call 119 or go to an emergency department. For thoughts of self-harm it gives 1925, and 119 if the person has already acted or is in danger. The system opens an urgent ticket, marks the visit and stops the conversation without calling the model (C-10; evidence: `respond` in `backend/src/engine.rs`; cases RF-01 to RF-24 check `model_called`). If a red flag fires after the summary was sent, the red-flag field in the summary is recalculated so that the physician sees the current state (C-13; evidence: `refresh_screen` in `backend/src/summary.rs`).

## Sentences known to be missed

The rules read one message at a time and recognise only what has been written into them. These get through (C-12; evidence: `split_clauses` and `negated_list` in `backend/src/precheck/mod.rs`):

- A symptom split over two messages, such as 「胸口」 (chest) followed by 「很痛」 (hurts a lot).
- Punctuation inside a word, such as 「胸，痛」 or 「胸.痛」.
- One negator covering two things: 「沒睡好和胸痛」 (slept badly, and chest pain) is read as neither.
- Misspellings, slang, written Taiwanese, phonetic spelling, or any language other than Traditional Chinese and English.
- Dangerous conditions with no rule, such as sudden severe abdominal pain, bleeding in pregnancy, or a stiff neck with high fever.

A missed message is handled like any other and goes to the model. The prompt tells the model not to judge urgency, and it cannot open an urgent ticket (C-14; evidence: the test `the_transfer_schema_excludes_red_flag_and_urgent` in `backend/src/tools.rs`). This gives "urgent" a single source, at the price of no second net when the rules miss. We accept that price only because the data are fictional. In a real setting it would have to be decided again.

The rules also fire when they should not. A patient whose visit was stopped by mistake can start another, and the physician can close the ticket with a note.

## The output check

The output check is a set of patterns. It recognises known forms of diagnosis, medication advice, and doses written as a number with a unit. Medicines and doses the patient mentioned may be repeated. It cannot stop wording it has not seen, and it may remove harmless sentences. If the patient types a dose first, the assistant may later say it. Text the model writes into history fields, hand-over summaries and the trace panel goes through the same check and the same masking.

## Stopping rules

The AMIE clinic study set four reasons to stop: immediate concern about harm to self or others, significant distress from talking to the AI, clinical harm as judged by the supervisor, and a patient's request to end ([ref. 1][r1]). In our system the first is handled by the red-flag rules. For the fourth, patients can leave at any time or press "Ask a doctor to contact me". The third is possible only while a physician or coordinator is online and takes over. The second is not detected. Administrators can turn the AI off with an emergency switch; red flags and the refill check continue to work. <!-- verify: V-10 emergency AI switch on the admin site (plan in backend/src/settings.rs, docs/v2/product.md §7) -->

## Hazard log

"Controlled" means the control is in code and tested. "Partly controlled" means the control has holes, or the v2 part has not been accepted yet. "Accepted" means we know and do nothing about it in the demo. "Uncontrolled" means there is no control at present.

| ID | Hazard | Cause | Effect | Controls | Code or data | Residual risk | Status |
|---|---|---|---|---|---|---|---|
| H-01 | An emergency description does not trigger a red flag | Wording not in the rules, misspelling, other languages | Delayed care | Rules, normalisation, Simplified folding, positive and negative tests | `precheck/mod.rs`, `red_flags.csv` | High | Partly controlled |
| H-02 | A symptom split over two messages or by punctuation is missed | Rules work per message and clause | Delayed care | None; listed as a known limit | `precheck/mod.rs` | Medium | Accepted |
| H-03 | 「沒睡好和胸痛」 read as a negation | Rule for negated lists | Delayed care | None; listed as a known limit | `precheck/mod.rs` | Medium | Accepted |
| H-04 | Unrelated text treated as a red flag | Loose matching, past tense counts | Visit interrupted, alert fatigue | New visit possible; ticket can be closed with a note | `engine.rs`, `tickets.rs` | Low | Controlled |
| H-05 | The assistant states a diagnosis | Model output is unpredictable | False belief, delay or alarm | Prompt limits, two output checks, scope check | `prompt.rs`, `guard.rs` | Medium | Partly controlled |
| H-06 | The assistant suggests a medicine or dose | Model output; patient typed a dose first | Medication harm | Scope check, dose detection, fixed refusal | `scope_rules.csv`, `guard.rs` | Medium | Partly controlled |
| H-07 | History recorded wrongly or invented | Model misreads speech | Physician reads a false history | Read-back, patient can edit, link to the original message <!-- verify: V-11 field-by-field editing, S/O lines link back --> | `tools.rs`, `summary.rs` | Medium | Partly controlled |
| H-08 | Physician sees an outdated red-flag field | Red flag fires after submission | Urgency underestimated | Recalculated on every read | `summary.rs` | Low | Controlled |
| H-09 | Physician relies on the summary too much | Automation bias, time pressure | Unwritten facts missed | A/P written by the physician, missing fields shown, transcript alongside <!-- verify: V-12 A/P not AI-generated (docs/v2/product.md §6) --> | `clinical_notes` | Medium | Partly controlled |
| H-10 | Patient takes the AI for a doctor | Human-like conversation | Does not see a doctor | Opening disclosure, permanent banner, diagnosis questions passed on | `texts.rs` | Medium | Partly controlled |
| H-11 | Nobody handles an urgent ticket | Demo service with no one on duty | Patient expects a call | Fixed text tells patients to call 119 or 1925; documents say no one is on duty | `texts.rs` | High | Accepted |
| H-12 | Prompt injection changes behaviour | Instructions in patient messages | Rules leaked, forbidden content | Scope check, data marking, output check, tool whitelist | `scope_rules.csv`, `prompt.rs` | Medium | Partly controlled |
| H-13 | Wrong collection date | Reading of the rule, holidays ignored, validity may be one day long | Wasted trip or gap in treatment | Pure function, boundary tests, cited articles | `refill.rs`, `refill_rules.csv` | Medium | Partly controlled |
| H-14 | Renewal engine marks an unsuitable request as ready | Protocols not clinically reviewed; wrong answers | Inappropriate renewal | Engine never approves, physician reviews all, missing values do not pass <!-- verify: V-13 renewal engine and 100% review (backend/src/rx) --> | `renewal_protocols.json` | High | Partly controlled |
| H-15 | Patient believes submitting means approval | Wording, long waits | Gap in treatment | Consent before sending, status page, overdue mark <!-- verify: V-14 consent page and SLA overdue mark --> | `rx_requests` | Medium | Partly controlled |
| H-16 | Error in the drug list | Compiled by the author; slow updates | Unsuitable drug enters the flow | Controlled drugs and injections excluded, physician reviews all | `formulary.csv` | Medium | Partly controlled |
| H-17 | Wrong medicine or wrong person | Demo pharmacy checks no physical item | Medication harm | Four checks required before "dispensed"; fictional data only <!-- verify: V-15 four checks on dispense (docs/v2/contract.md §4) --> | `rx_requests` | Low | Partly controlled |
| H-18 | Real personal data reaches the model provider | User ignores notices; names not detectable | Privacy breach | Masking, notices, retention limit | `pii.rs` | Medium | Partly controlled |
| H-19 | Staff read patients they should not | Broad permissions, curiosity | Privacy harm | Role permissions, access log, patient can see it <!-- verify: V-16 access_log and patient privacy page --> | `perm.rs`, `audit.rs` | Medium | Partly controlled |
| H-20 | Next person on a shared device sees data | Forgot to sign out; sandbox stays in the browser | Privacy breach | Sign-out, device revocation, sandbox expiry <!-- verify: V-17 device list and revocation --> | `auth.rs`, `demo.rs` | Medium | Partly controlled |
| H-21 | Model withdrawn or changed | Provider change | Outage, output drift | Fallback model, off switch; re-running the evaluation relies on memory | `llm/`, `eval.rs` | Medium | Partly controlled |
| H-22 | A few users consume the quota | Public URL, free tier | Others cannot use it | Limits per day, client and visit; red flags unaffected | `limits.rs` | Low | Controlled |
| H-23 | Two people edit the same record | Concurrency, offline drafts | Draft note overwritten | Revisions; on conflict a person chooses <!-- verify: V-18 revision conflict handling --> | `clinical_notes`, `drafts` | Low | Partly controlled |
| H-24 | Handbook content outdated or wrongly cited | Source changes, wrong section retrieved | Mistaken belief | Source and date per section, empty result below threshold | `health_edu.rs`, `data/rag/` | Low | Partly controlled |
| H-25 | People who cannot read, see or type are excluded | Text-only interface | Unequal care | Two languages, keyboard use; no voice | `web/` | Medium | Accepted |
| H-26 | Use by someone under 18 | No age check | Breach of provider terms; rules not designed for it | Documentation only | none | Medium | Uncontrolled |

There are 26 entries, three of them with high residual risk (H-01, H-11, H-14). Outside a demonstration, any one of the three would be enough to stop a launch.

[r1]: https://doi.org/10.48550/arXiv.2603.08448
