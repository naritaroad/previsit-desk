---
title: Human oversight
summary: Who sees what and when, how signing and take-over work, the current oversight phase, and what research says about supervision.
version: "2.0"
effective: 2026-11-25
owner: naritaroad (project author)
reviewer: No external clinical review
next_review: 2027-02-25
---

## Who sees what

Every submitted intake has to be read and signed by a physician before it is closed. Care coordinators can organise, contact patients and assign work, but cannot sign notes or decide renewals. Pharmacists see only medicines, allergies and prescription requests. Administrators manage accounts, settings and audit; nothing in the permission table lets them read patient content. <!-- verify: V-19 role table matches backend/src/perm.rs -->

The AI always sits at the front: it takes the history and arranges it as subjective data (S) and measurements the patient reports (O). The assessment (A), the plan (P) and the message to the patient are written by the physician. Those fields start empty and the system does not fill them (C-15; evidence: `docs/v2/product.md` §6 and §10). <!-- verify: V-20 A/P empty, no generate button -->

## Review desk and signing

The review desk has three parts: the patient's profile and past records, the AI-arranged S and O with every line linked to the original message, and the physician's writing area. Drafts save automatically with versions. Signing locks the note. Corrections are made only as an addendum with a time and a name, and the original stays. The patient sees the physician's message only after signing. <!-- verify: V-21 signing lock, addenda, version history (clinical_notes, note_versions, note_addenda) -->

## Taking over a conversation

A ticket is created when the patient presses "Ask a doctor to contact me", when a rule fires, or when the model calls the hand-over tool. Once a physician or coordinator takes over, the AI stops and a person replies in the same thread, then closes it or hands it back. Tickets have an urgency, but no one is on shift watching them; see "Incidents and corrections". <!-- verify: V-22 take-over, release and close -->

## Oversight phase

We are in phase {{facts.oversight_phase}}: a physician reviews every renewal request, and the engine only sorts and flags (C-16; evidence: `docs/v2/product.md` §5). No button raises the phase, and there is no code for automatic approval. <!-- verify: V-23 oversight_phase read-only, no auto-approve code -->

Leaving phase 1 would need at least the following: 250 physician decisions per drug class; agreement between engine and physician above a threshold set and published in advance, with each disagreement examined; ethics review and the regulator's consent; an institution and named physicians who accept responsibility; and measured harm monitoring. The figure of 250 is borrowed from the Utah pilot, which later moved to 250 per medication group ([ref. 4][r4]). We have no statistical basis of our own for saying it is enough. Given what this project is, none of these conditions is met.

## What research says about supervision

"A doctor looked at it" is often offered as a guarantee of safety. The evidence is less comfortable.

In the clinic study by Google and BIDMC in Boston, 100 patients completed the conversation under live physician supervision. There were no safety stops, and supervisors spoke up three times. Chart review eight weeks later found the final diagnosis within the system's first seven suggestions in 90% of cases, but first on the list in only 56%. In the same study the physicians' management plans were better on practicality and cost-effectiveness (p=0.003 and p=0.004). Of the 60 physicians who answered the survey after the visit, 16 said they had not read the transcript or summary (C-17, [ref. 1][r1]). The material was in their hands, and more than a quarter did not open it.

A second study had physicians review AI intakes and drafts afterwards, with simulated scenarios and actors as patients. The share of red flags asked about was 64.2% for the AI and 40.0% and 51.7% for the two human comparison groups, so the best group still missed more than a third. Physicians judged that about 40% of sections needed clinically relevant edits. After editing, the diagnostic quality of the AI drafts failed to improve in 93.3% of scenarios and got worse in 21.7%. Supervising took about 40% less time than a physician conducting the text consultation, but slightly longer than reviewing notes written by people; the authors suggest that long summaries may have added to the burden (C-18, [ref. 2][r2]).

We read both as preprints. The numbers of patients and scenarios are modest, and Google also built the system. What we took away is specific: keep the review desk short, make everything traceable, offer ways to escalate, and do not assume that an edited draft is a better one.

## Against automation bias

The Ministry's guideline lists this as "user dependence risk": clinicians may exercise less independent judgement because they trust the system too much ([ref. 8][r8]). WHO names automation bias as well ([ref. 13][r13]). In the design we did several things. The system gives no list of diagnoses, so there is no ready answer to accept. The summary shows fields not collected and points to clarify. The renewal engine lists each rule that fired. Agreement between engine and physician appears by drug class on the oversight page. <!-- verify: V-24 oversight metrics page (docs/v2/contract.md §6) -->

The agreement rate can itself be biased. A physician who sees the engine's result before deciding will agree more often. Measuring true agreement would mean hiding the result for some cases, which we do not do.

## Workload

The system does not limit how many cases a physician reviews in a day, and it does not notice reviews that are too fast. Overdue items are marked and coordinators can reassign them. <!-- verify: V-25 overdue marks and assignment --> For real use, a clinic would have to set an hourly limit, spot checks on minimum review time, and a threshold at which intake pauses. This is a gap; no feature covers it.

[r1]: https://doi.org/10.48550/arXiv.2603.08448
[r2]: https://doi.org/10.48550/arXiv.2507.15743
[r4]: https://commerce.utah.gov/ai/agreements/doctronic/
[r8]: https://www.mohw.gov.tw/cp-18-86695-1.html
[r13]: https://www.who.int/publications/i/item/9789240084759
