---
title: Renewals and refills
summary: Why a renewal request is not a prescription, how the protocol engine works, which drugs are excluded, and how this differs from the Utah pilot.
version: "2.0"
effective: 2026-11-25
owner: naritaroad (project author)
reviewer: No external clinical review
next_review: 2027-02-25
---

## Two kinds of request

A **refill booking** is for the second or later collection on an existing refillable prescription. The physician has already prescribed; only the date and the pharmacy are open. The code follows the National Health Insurance medical care regulations: at most 90 days in total per prescription and 30 days per fill (Article 22), the next fill only within the 10 days before the previous supply runs out (Article 24), and no refillable prescription for Schedule 1 or 2 controlled drugs (Article 14) (C-24, [ref. 10][r10]; `data/seed/refill_rules.csv`). "At most three fills" is derived from 90 divided by 30; the text does not state a number. The system is stricter than the regulation: any controlled drug, or an unsure answer, goes to a pharmacist or physician.

Two differences in the dates are known. Article 23 sets validity at the last day of use of the final fill and extends it when that falls on a holiday. The code adds the total days to the issue date, which may be one day more than the NHI would allow, and it does not handle holidays. When the result says a fill can be collected, the pharmacy's card reader still decides.

A **renewal request** is for when the refillable prescription is nearly used up.

## Why a renewal request is not a prescription

In Taiwan, prescriptions are issued by physicians. Article 11 of the Physicians Act says a physician may not prescribe without examining the patient in person, with telemedicine as the exception. Article 13 sets out what a prescription must contain, with the physician's signature or seal (C-19, [ref. 11][r11]). When telemedicine may include a prescription is set by Article 16 of the telemedicine regulations: for groups such as patients enrolled in chronic care plans, only stable follow-up patients, and in principle no controlled drugs. Article 18 requires an approved plan from the medical institution, and Article 19 requires identity verification and encryption in the information system ([ref. 9][r9]).

This system has no medical institution, no approved plan and no identity verification. Sending a renewal request only means "please look at this". If the physician agrees, the prescription itself still has to be issued at a visit or a compliant telemedicine consultation. An approval here lets the demo pharmacy create a record marked "demo", which has no effect. <!-- verify: V-26 completed renewals are marked as demo (docs/v2/contract.md §4) -->

## The protocol engine

The engine is plain Rust. It reads `data/seed/renewal_protocols.json` (version {{facts.protocol_version}}), does not use the model, and always gives the same result for the same answers (C-20). <!-- verify: V-27 engine in backend/src/rx is a pure function with tests --> Each item gets one of five results:

| Result | Meaning | Next |
|---|---|---|
| ready | No rule fired | Normal queue; the physician still decides |
| review | An answer needs attention, or data are missing | Normal queue, with reasons listed |
| in_person | Pregnancy, a hospital stay, changed symptoms and so on | A visit is suggested; the physician decides |
| urgent | Dangerous symptoms right now | Emergency instructions shown at once, urgent ticket opened |
| excluded | A drug we do not accept | Cannot be submitted |

The result affects only what the physician sees and where it is queued. It never becomes an approval.

The protocol file says of itself that it is not clinically validated and not approved by any physician or pharmacist (C-22). On 25 November 2026, 30 of its 103 disposition rules cited a public source. The other 73 had an empty source field and were set conservatively by the author. <!-- verify: V-28 recount rules and sources at freeze -->

## Drug scope

`data/seed/formulary.csv` lists {{facts.formulary_in_scope}} drugs that can be requested online, {{facts.formulary_physician_only}} that need individual physician assessment, and {{facts.formulary_excluded}} that are not accepted (C-21). Not accepted are controlled drugs (zolpidem, alprazolam, tramadol and others), injections (insulin, semaglutide), systemic steroids, drugs with severe birth-defect risk, and chemotherapy. Drugs that need blood monitoring or have a narrow therapeutic range, such as warfarin, digoxin, lithium and carbamazepine, need individual assessment, and the list tells the patient to contact the physician directly. A drug that is not on the list is treated as not accepted. <!-- verify: V-29 how physician_only and unlisted drugs are handled in the flow -->

## Pharmacist checks

The pharmacy has to complete four checks (identity, allergy, interaction, quantity) before marking an item as dispensed. On any doubt it can return the item with a reason or ask the physician. The Pharmacists Act as published in 1979 already required checking the prescription on receipt and clarifying doubts with the prescriber before dispensing ([ref. 19][r19]; we could not open the current text). Return and query follow that order. <!-- verify: V-30 four checks, return and ask physician -->

## How this differs from the Utah pilot

Doctronic's pilot in Utah is one of the few AI renewal programmes with a published agreement. It requires identity verification, an upload of the earlier prescription, a check of dispensing records and an intake, after which the AI judges whether to renew. Physicians review the first 250 patients before anything reaches the pharmacy and the next 1,000 retrospectively, then 5% to 10% of renewals each month. Controlled drugs are excluded, and patients and pharmacists can ask for physician review ([ref. 3][r3]). The state's web page later described moving to phase two once 250 have been filled in a medication group ([ref. 4][r4]).

Figures published by the state in May 2026: the AI recommended renewal in 72% of cases and physicians agreed with 91% of those, asking for more information in the other 9%. Counting a second physician's view, at least one found the renewal appropriate in 97%. The AI escalated 28%, and physicians thought 31% of the escalations were overly cautious. The report also says that patient numbers were limited, the data came from Doctronic's physicians, and the state was running a separate independent review (C-23, [ref. 5][r5]).

Criticism came from two places. On 20 April 2026 the Utah Medical Licensing Board wrote that it learned of the programme only after it went live, that every refill needs reassessment for side effects and interactions, and that it strongly recommended immediate suspension ([ref. 6][r6]). The state's policy memorandum of 6 May did not recommend stopping, but granted that chronic renewals are where incomplete information matters most and that comparison with emergency or pharmacist refills is "not a complete defense". It proposed deleting terms that disclaim malpractice liability, removing antiarrhythmics, and adding stricter questions and visits for drugs including apixaban, clopidogrel, steroids and chlorthalidone ([ref. 7][r7]). The pilot was due to end in October 2026. On 25 November we could not find out whether it was extended.

We differ in that nothing is approved automatically, there is no second phase, the model does not judge whether to renew, no prescription is issued, and anticoagulants, antiarrhythmics and systemic steroids are not accepted.

Some weaknesses are the same. We cannot see the full record either, and a wrong or forgotten answer changes the result. Clopidogrel and diuretics are in our scope. The antiplatelet questions ask about black stools, bleeding and planned procedures, and the general questions ask about one-sided weakness or slurred speech right now. We do not ask specifically about recent anti-inflammatory painkillers, and there is no mandatory visit at day 90. That is why a physician looks at every request.

[r3]: https://commerce.utah.gov/wp-content/uploads/2026/01/Doctronic-Final-Agreement.pdf
[r4]: https://commerce.utah.gov/ai/agreements/doctronic/
[r5]: https://commerce.utah.gov/wp-content/uploads/2026/05/Doctronic-Outcomes-May-2026.pdf
[r6]: https://commerce.utah.gov/wp-content/uploads/2026/04/doctronic-letter-from-medical-board.pdf
[r7]: https://commerce.utah.gov/wp-content/uploads/2026/05/Policy-Memorandum-.pdf
[r9]: https://www.mohw.gov.tw/dl-86975-40690d3a-b8e0-4a5c-b435-d660e48e73e7.html
[r10]: https://www.mohw.gov.tw/dl-93633-3bde2ef4-420d-4498-b056-e54019bab357.html
[r11]: https://laws.gov.taipei/law/LawSearch/LawPrint/FL013514?type=0
[r19]: https://www.president.gov.tw/Page/294/38057
