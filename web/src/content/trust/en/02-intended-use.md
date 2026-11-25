---
title: Intended use
summary: Who may use it and where, which uses are ruled out, and why each kind of medical work is in or out of scope.
version: "2.0"
effective: 2026-11-25
owner: naritaroad (project author)
reviewer: No external clinical review
next_review: 2027-02-25
---

## Users and setting

Patients are adults of 18 or over who can type in Traditional Chinese or English and whose problem is not urgent. The age limit comes from the model provider: the Gemini API terms require users to be at least 18 and forbid applications directed at people under 18 (C-03, [ref. 14][r14]). The system does not check age; it only states the limit in the documents and on the sign-up screen. <!-- verify: V-03 sign-up and guest screens state the 18+ limit -->

Staff users are physicians, pharmacists, care coordinators and administrators, each with their own site and permissions. <!-- verify: V-04 four sites and role permissions are live (docs/v2/product.md §2–§3, backend/src/perm.rs) --> The setting is a browser on a connected computer or phone. It is text only, with no voice, images or physical examination. For now it may be used only with fictional data, for demonstration.

## Suitable situations

It suits a booked outpatient visit with stable symptoms; typical complaints are a cough, stomach pain, knee pain or a blood-pressure follow-up. It also suits someone who wants to know when the next fill of a refillable prescription can be collected. A renewal request fits a chronic medicine the patient already takes, with a stable condition and a drug on the in-scope list. <!-- verify: V-05 renewal scope follows data/seed/formulary.csv -->

## Uses that are ruled out

Please do not use it for the following. Where it can, the system stops or hands over to a person.

- Emergencies, thoughts of self-harm, overdose or poisoning.
- People under 18, pregnancy and postnatal care, or describing symptoms for someone who is unconscious or cannot speak.
- Requests for a new prescription, a dose change, a switch, stopping a medicine, or any controlled drug.
- Using the output as a diagnosis or for sick leave, insurance or legal purposes.
- Entering real records, lab reports or someone else's personal data.
- Real clinical work. The Gemini API terms say the services may not be used in clinical practice or to provide medical advice ([ref. 14][r14]). Until the model plan is replaced, even a trial in a clinic is out of the question.

## Why some things are in and others are out

The World Health Organization groups the health uses of large multi-modal models into five: diagnosis and clinical care, patient-guided use, clerical and administrative tasks, medical and nursing education, and research and drug development. It warns of wrong or biased answers, automation bias and cybersecurity risks, among others ([ref. 13][r13]). We use that grouping to check what we do.

### Health education: in scope, but only retold

The system looks up sections in `data/rag/health_education.zh-TW.md`. Each has a source and a date checked, and when nothing matches the system says the handbook does not cover it. Doing more, such as education tailored to a person's history, would need content reviewed by clinicians, someone to keep it current, and evidence that readers understand it. We have none of these.

### Administration: in scope

Bookings, collection dates, request status and task lists can be checked with rules and tests. An error means a wasted trip or a gap in treatment, so code does all the date arithmetic, and controlled drugs, changed symptoms and side effects always go to a person.

### Emotional support: out of scope

When thoughts of self-harm are detected the system gives fixed text with 1925 and 119 and stops the conversation (C-04; evidence: the `suicide` category in `data/seed/red_flags.csv`, `backend/src/texts.rs`). Conversational support would need clinical studies, supervision and people ready to take over in a crisis. Google's clinic study excluded patients whose main complaint was mental health ([ref. 1][r1]). We have no reason to go further than that.

### Triage: a small part only

The system recognises a limited set of descriptions that call for immediate care, and stops when it sees one. It never tells a patient that something is not urgent or can wait three days. To say that, we would first have to measure sensitivity and specificity on real patients and find out what happened to the ones it missed. On the staff side, order depends on ticket urgency and time, never on the model's opinion.

### Diagnosis and treatment: not done

Diagnosis, prescribing and dosing belong to physicians, and dispensing to pharmacists. Article 11 of the Physicians Act takes examination in person as the rule ([ref. 11][r11]). Even where a system like AMIE offers possible diagnoses in a study, a physician watches live and the management plan is not shown to the patient ([ref. 1][r1]). Bringing treatment into scope takes clinical trials, regulatory approval and an institution willing to be liable. Writing more code does not get there.

### What it would take to widen the scope

| Area | Today | Evidence missing | Who would be responsible |
|---|---|---|---|
| Health education | Retells sourced sections | Reader comprehension, update schedule | Clinicians who review the content |
| Administration | Rule-based, hands over | Comparison with actual NHI outcomes | Clinic and pharmacy |
| Emotional support | Fixed text and hotlines | Clinical studies, crisis outcomes | A mental-health team |
| Triage | A few red flags, stop on match | Miss rate and consequences in real patients | Medical institution and named physicians |
| Diagnosis and treatment | Not done | Clinical trials and market approval | Physicians, manufacturer, regulator |

[r1]: https://doi.org/10.48550/arXiv.2603.08448
[r11]: https://laws.gov.taipei/law/LawSearch/LawPrint/FL013514?type=0
[r13]: https://www.who.int/publications/i/item/9789240084759
[r14]: https://aistudio.google.com/docs/terms
