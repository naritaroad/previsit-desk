---
title: Incidents and corrections
summary: What counts as an incident, how we grade it, what we intend to do and by when, and how to report one.
version: "2.0"
effective: 2026-11-25
owner: naritaroad (project author)
reviewer: No external clinical review
next_review: 2027-02-25
---

## The limits first

This is a student's course project. There is no team, no shift and no round-the-clock support (C-36; evidence: `SECURITY.md`). The times below are the author's targets, counted from when the author sees the report. Nights, holidays and exam weeks may take longer. <!-- verify: V-41 author confirms these times --> Anyone with a physical or mental emergency should not wait for the system or for us: call 119, or 1925 for thoughts of self-harm.

The same goes for "urgent tickets" in the system. They only appear in a list on the physician's site. No one is woken by a phone call (C-37; evidence: `backend/src/tickets.rs`).

## What counts as an incident

Anything that causes harm, could cause harm, or gives reasonable doubt about safety or privacy. Common kinds:

- A red flag that should have fired did not, or the assistant gave a diagnosis, a dose or medication advice.
- The renewal engine gave a clearly unreasonable result, or a patient thought a request had been approved.
- Someone saw data that was not theirs.
- Personal data, a key or a password leaked.
- The service went down, or the evaluation got worse after a change.

Near misses count too, and are the most useful to report.

## Severity and targets

| Level | Examples | What we intend to do | Target |
|---|---|---|---|
| S1 | Someone may be physically harmed; patient data read by others; a key leaked | Turn off the AI or the whole site, replace keys, keep records, announce | Off the same day it is seen; first public note within three days |
| S2 | Missed red flag, diagnosis or dose given, permission error without data exposure | Add a rule or disable the feature, put the sentence into the cases, rerun the evaluation | Handled within three days; documents corrected within two weeks |
| S3 | Wrong refill date, handbook content or wording | Fix and note in the changelog | Within two weeks |
| S4 | Typos, layout, suggestions | Ordinary changes | No fixed time |

For S1 the first step is to turn things off; causes can be found later. The admin site has an emergency switch for the AI, and with it off red flags, the refill check and messages with staff still work. The whole site can be stopped by the author at the Cloudflare tunnel. <!-- verify: V-42 emergency switch and behaviour when off -->

Grading is done by the author alone. That is a weakness: the person who made the mistake also decides how serious it is. For S1 and S2 we will put the reason for the grade in the public note so that others can object.

## How to report

Security problems: privately, as described in [SECURITY.md](https://github.com/naritaroad/previsit-desk/blob/main/SECURITY.md).

Content and safety problems: open an issue at [GitHub Issues](https://github.com/naritaroad/previsit-desk/issues) with the page, the approximate time, the sentence you typed (changed to something fictional), the reply you saw, and what you think it should have been. Do not paste real conditions or personal data.

Signed-in patients can also press "Ask a doctor to contact me" in a visit. That reaches only the demo physician's site and never the author, so it is not a way to report an incident.

People without a GitHub account have no other channel at present. We have not solved this.

## After a report

We intend to do these in order: confirm and grade; turn things off if needed; keep the relevant run records; find the cause; fix it; turn a reproducible example into a test or an evaluation case; update the hazard log and these documents; and write in the changelog the date, what changed and why. Reporters who wish to be named will be listed there.

Visits are deleted automatically, so after {{facts.retention_days}} days the original conversation may be gone. If it should be kept, quote the visit ID. The author will export the run records needed before deletion and remove them when the matter is closed.

## Corrections

If the documents and the program disagree, what the program actually does is taken as true and the document as wrong. Errors are corrected in the sentence, and a row is added under "References and changelog" saying what was written before and why it was wrong. Nothing is changed silently. The note about AMIE in version 0.1.0 was corrected this way.

## Notifying others

The system takes no real patient data and is not a medical institution, so there is no process for reporting to an authority. Amendments to the Personal Data Protection Act published on 11 November 2025 added duties to report and respond to data incidents; when we looked, the effective date was undecided ([ref. 12][r12]). If real personal data were ever accepted, this section would have to be rewritten before opening.

As of the effective date of this version the author has received no incident reports. <!-- verify: V-43 author confirms number of reports -->

[r12]: https://laws.gov.taipei/law/LawSearch/LawExport/FL010627?type=0
