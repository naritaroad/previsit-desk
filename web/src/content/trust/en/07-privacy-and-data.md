---
title: Privacy and data
summary: What we collect and why, who can see it, how long it is kept, and what is sent to the model provider.
version: "2.0"
effective: 2026-11-25
owner: naritaroad (project author)
reviewer: No external clinical review
next_review: 2027-02-25
---

## The most important point first

Please do not enter real medical records, lab reports, names or contact details. The system is designed for fictional patients, and what is sent to the model currently goes through the free tier of the Gemini API. The provider's terms say that input and output of free services may be used to improve its products, that human reviewers may read them, and that users should not submit sensitive, confidential or personal information (C-26, [ref. 14][r14]). Paid plans have different terms, under which the provider says content is not used to improve products. We do not use a paid plan at present. What is sent includes the conversation of this visit, the fields collected, and the history, medicine and allergy entries from the health profile, without the account name. <!-- verify: V-31 author confirms free or paid Gemini project at launch -->

## Data inventory

| Data | Purpose | Who sees it | Where | Kept for |
|---|---|---|---|---|
| Username, nickname, password hash | Sign-in | The person; administrators see username and status, never the password | `accounts` | Until the account is deleted |
| Signed-in devices and last use | Lets the person revoke a sign-in | The person | `sessions` | Until sign-out, revocation or expiry |
| Intake conversation | Taking the history | The person, authorised staff | `messages`, `visit_events` | Deleted after {{facts.retention_days}} days without activity |
| Intake fields and summary | For the physician | The person, authorised staff | `visits`, `previsit_summaries` | As above |
| Health profile, measurements, self-reported medicines | Pre-filling, renewal checks | The person, authorised staff; pharmacists see medicines and allergies only | `patient_profiles`, `measurements`, `prescriptions` | Until the account is deleted |
| Renewal and refill requests, answers, events | Review and dispensing | The person, physicians, coordinators, pharmacists | `rx_requests`, `rx_events`, `rx_messages` | Until the account is deleted |
| Physician notes and addenda | Clinical record (demo) | Physicians, coordinators; the patient sees only the signed message | `clinical_notes`, `note_addenda` | Deleted with the visit |
| Internal notes, tags, contact log | Care coordination | Physicians, coordinators | `staff_notes`, `patient_care`, `contact_log` | Until the patient's account is deleted |
| Access log | Showing who read what | Patients see their own; administrators see all | `access_log` | Until the patient's account is deleted |
| Audit log | Showing who changed what | Administrators | `audit_log` | No automatic deletion at present |
| Consents | Showing which version was seen | The person | `consents` | Until the account is deleted |
| Red flags, output checks, tool calls, model use | Safety review | Staff see what belongs to the visit; usage goes to administrators | `red_flag_events`, `guard_events`, `tool_calls`, `runs` | Deleted with the visit; daily totals hold no content and are kept |
| Salted hash of the client address | Abuse limits | No one; memory only | Process memory | Gone on restart |

<!-- verify: V-32 inventory matches backend/migrations/0002_platform.sql and deletion has been tested -->

The database has no columns for national ID, NHI card number, phone, email or IP address. If a patient types them into a message, masking handles ID numbers, phone numbers, emails and runs of eight or more digits, before storage and before anything goes to the model (C-25; evidence: `backend/src/pii.rs`, `prepare` in `backend/src/engine.rs`). Masking has holes. It cannot detect names, it misses phone numbers separated by dots, and addresses are stopped only in intake fields, not in the conversation.

## Guest sandbox

"Try with a demo patient" creates an account that belongs to this browser only, loaded with a fictional patient's data and kept apart from other visitors. It expires and is then deleted entirely, or it can be turned into a permanent account by setting a username and password, with its data kept. The sign-in lives in a browser cookie, so on a shared device the next person can see it unless you sign out. <!-- verify: V-33 sandbox expiry and claiming (backend/src/demo.rs, docs/v2/contract.md §2) -->

## Who has looked at my data

Each time staff read a patient's data an entry is written with the time, name, role and the kind of data. If the entry cannot be written, the data are not returned. Reading the same thing again within a minute counts once (C-28; evidence: `log_access` in `backend/src/audit.rs`). Patients can see their own entries on the "Privacy and data" page. <!-- verify: V-34 privacy page shows access_log and every staff read endpoint calls log_access --> A database administrator can connect directly, and such reads do not appear in this table. At present that administrator is the author.

## Export and deletion

Patients can download their data as JSON and delete their account, which also removes the visits, requests, measurements and records that belong to them (C-27; evidence: `ON DELETE CASCADE` in `backend/migrations/0002_platform.sql`). <!-- verify: V-35 GET /me/export and DELETE /me --> Three things are out of reach: database backups, which people on the host keep and clean up by hand with no automatic expiry; content already sent to the model provider, which follows the provider's terms; and actions and operator names in the audit log.

Article 3 of the Personal Data Protection Act lists the rights to inquire, read, obtain copies, supplement or correct, stop use, and delete. Article 6 says medical records and similar data may in principle not be collected unless a listed exception applies ([ref. 12][r12]). We stay away from Article 6 by accepting fictional data only, and do not claim to have met the rest. Details are in "Regulation".

## What we do not do

We do not sell data, show advertising, or use conversations to train or fine-tune a model, and we use no third-party analytics. The back end initiates outbound connections only to the model provider. The front end's connections are limited to the same site by the content security policy (see "Security").

[r12]: https://laws.gov.taipei/law/LawSearch/LawExport/FL010627?type=0
[r14]: https://aistudio.google.com/docs/terms
