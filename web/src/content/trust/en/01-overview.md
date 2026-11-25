---
title: Overview
summary: What PreVisit Desk does and does not do, who is responsible, and how to tell us about a problem.
version: "2.0"
effective: 2026-11-25
owner: naritaroad (project author)
reviewer: No external clinical review
next_review: 2027-02-25
---

PreVisit Desk is a clinic service built for a classroom demonstration. Before a visit, a patient answers a few questions by text and the system turns the answers into a summary. The physician reads both the original conversation and the summary, then writes the assessment and plan. Collection dates for refillable chronic prescriptions (慢箋) are worked out by code, and every renewal request is decided by a physician. One person builds and maintains the whole service. All patients, clinicians and pharmacies are fictional.

These twelve documents explain how it works, where it can go wrong, and who answers for it. We took the idea from two NHS clinical risk standards for health IT: DCB0129 covers manufacturers, DCB0160 covers the organisations that deploy and use the system ([ref. 15][r15], [ref. 16][r16]). We borrowed the kinds of document they call for, such as a hazard log. This project has no clinical safety officer, has not been submitted for review, and does not claim to meet either standard.

## What it is for

In the waiting room, or in the days before an appointment, the system goes through the main complaint, its course, past history, medicines and allergies, so that the physician starts the visit with a record that can be checked. For refillable prescriptions it answers a question about dates, "can I collect today?", and passes anything that needs judgement to a pharmacist or physician. For renewals it gathers what a physician needs to see first. <!-- verify: V-01 renewal flow is live and every request is decided by a physician (docs/v2/product.md §5) -->

## What it does not do

The system does not diagnose, prescribe, give doses, suggest changing or stopping a medicine, or name a disease (C-01; evidence: the limits section of `backend/src/prompt.rs`, `backend/src/guard.rs`, `docs/v2/product.md` §10). It does not replace a visit or an ambulance, and nobody watches it around the clock. In an emergency in Taiwan, call 119. If you are thinking about harming yourself, call the 1925 hotline.

It is not connected to the NHI app, My Health Bank, the cloud medication record or any hospital record. It knows only what the patient typed and the fictional records in the demo data.

## Who is responsible

The author, naritaroad, is responsible for the documents, the code and the data. No physician, pharmacist or outside body has reviewed any of it (C-02; evidence: the reviewer field on this page and `approved_by_note` in `data/seed/renewal_protocols.json`). In the demo, the "physician", "pharmacist" and "care coordinator" are played by demo accounts. Pressing Approve produces no real prescription and dispenses nothing.

If someone wanted to use this with real patients, responsibility would have to be arranged quite differently. A medical institution would have to take it on, licensed people would have to check the rules and protocols, the model plan would have to be replaced because its current terms forbid clinical use, and the evaluation would have to be redone. "Intended use" and "Regulation" list these conditions.

## How to raise a concern

For content, rules or wording, open an issue at [GitHub Issues](https://github.com/naritaroad/previsit-desk/issues) and quote the page name and claim number, for example C-05. For security problems, report privately as described in [SECURITY.md](https://github.com/naritaroad/previsit-desk/blob/main/SECURITY.md). Please do not paste real medical records, names or conversations into either. Response times are in "Incidents and corrections".

## How to read these documents

Each page opens with its version, effective date, owner and next review date. Statements that can be checked carry a number from C-01 to C-41, followed by a file path or a reference. The paths are in the public repository; the references are listed on the last page. Numbers that change, such as rule counts, evaluation results and model names, are filled in by the server. The current version is {{facts.app_version}}, with {{facts.red_flag_rules}} red-flag rules and an evaluation result of {{facts.eval_passed}} of {{facts.eval_total}} ({{facts.eval_date}}). <!-- verify: V-02 /trust/facts returns these fields (docs/v2/contract.md §7) -->

What we have not done is written down too. To see the weak points first, read the known misses in "Clinical safety", the known gaps in "Security", and what the numbers cannot show in "Evaluation and evidence".

[r15]: https://standards.nhs.uk/published-standards/clinical-risk-management-its-application-in-the-manufacture-of-health-it-systems
[r16]: https://standards.nhs.uk/published-standards/clinical-risk-management-its-application-in-the-deployment-and-use-of-health-it-systems
