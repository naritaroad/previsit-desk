# Security policy

PreVisit Desk is a course demonstration of a pre-visit assistant. It is **not** a medical device and must not receive real patient records or personal data. The public demo stores only fictional visits and deletes them after `RETENTION_DAYS` (14 by default).

## Reporting a vulnerability

Please open a private report through GitHub: **Security → Report a vulnerability** on this repository. Do not file public issues for security problems. Include the affected endpoint or file, steps to reproduce, and the impact you observed. Reports are read by the maintainer, who replies as time allows; this is a student project without a support SLA.

## In scope

- Authentication or session handling for the clinician pages
- Bypassing the red-flag precheck, the scope precheck, or the output guard
- Leaking the system prompt, API keys, or other visits' data
- Injection (SQL, prompt, header) and request-forgery issues
- Abuse of the public demo limits (rate limit, daily call cap)

## Out of scope

- Findings that need real patient data (none is accepted by design)
- Model answers that are merely unhelpful or imperfect Chinese
- Denial of service through sheer traffic volume

## Handling of secrets

`.env`, API keys, tunnel tokens and passwords never belong in git, container images or logs. If you find one in this repository, report it privately and treat it as already compromised.
