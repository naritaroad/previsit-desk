---
title: Security
summary: How accounts, permissions, transport, containers and secrets are protected, the known gaps, and how to report a weakness.
version: "2.0"
effective: 2026-11-25
owner: naritaroad (project author)
reviewer: No external clinical review
next_review: 2027-02-25
---

## Accounts and sessions

Passwords are stored as Argon2id hashes. When the username does not exist, the same amount of work is done anyway, so response time does not reveal accounts. A sign-in issues a 256-bit random token of which the database keeps only the SHA-256 hash. The cookie is HttpOnly and SameSite=Lax, plus Secure in production (C-29; evidence: `backend/src/auth.rs`, `COOKIE_SECURE` in `deploy/compose.prod.yaml`). Each client may try to sign in 10 times in ten minutes. People can see their signed-in devices and revoke them one by one; administrators can disable accounts, reset passwords and revoke all sign-ins. <!-- verify: V-36 device list, revocation, immediate effect of disabling (backend/src/auth.rs) -->

There is no two-factor authentication, and no password-reset email because the system does not collect email addresses. A forgotten password can be reset only by an administrator, who issues a one-time password. <!-- verify: V-37 reset issues a one-time password and forces a change -->

## Roles and authorisation

There are five roles: patient, physician, pharmacist, care coordinator and administrator. Every endpoint declares the permission it needs. One table in `backend/src/perm.rs` maps roles to permissions, and the admin site shows the whole matrix. Patients read only their own data, and staff reads are logged. Administrators have no permission that reads patient content. <!-- verify: V-38 permission per endpoint and cross-role tests -->

Coordinators and physicians currently see every patient in the clinic, not just those assigned to them. Whether a real clinic should allow that is for the clinic to decide.

## Transport and web headers

Public traffic goes through a Cloudflare Tunnel, with HTTPS terminated at Cloudflare. The link from Cloudflare to the container on the host is encrypted, and containers talk over the host's internal network. The back-end port is bound to 127.0.0.1 on the host and the database publishes no port. Every response carries a `Content-Security-Policy` that limits scripts and connections to this site and permits only one inline script, by hash, along with `X-Content-Type-Options` and `Referrer-Policy` (C-30; evidence: the test `csp_allows_only_the_inline_script_that_is_in_the_page` in `backend/src/routes.rs`). Inline styles are still allowed. The application does not send HSTS, and we have not confirmed whether Cloudflare does.

## Limits and abuse

Sending messages, creating visits, signing in and other actions each have rate limits. Model calls have three limits (per day, per client and per visit), and failed calls count. Client addresses are kept in memory only as salted hashes, IPv6 by /64 network, with at most 20,000 entries (C-32; evidence: `backend/src/limits.rs`). Counts reset on restart and are not shared between hosts; there is only one host.

## Containers and host

Production runs three containers under Docker Compose: the database, the back end and the Cloudflare tunnel. The back end runs with a read-only file system, all Linux capabilities dropped, no privilege escalation, limits on memory, CPU and processes, and a non-root user in the image (C-31; evidence: `deploy/compose.prod.yaml`, `Dockerfile`). The database container has a memory limit and no privilege escalation, but its file system is writable. The host is shared with another of the author's projects; the two use separate Compose projects and tunnels.

## Secrets

The model key, database password and tunnel token are in a `.env` file on the host that only its owner can read. They are not in git or in the image. Error messages have keys removed and are truncated before logging. The back-end container is given an empty tunnel token, so it cannot obtain it. The deployment script stops if a required secret is empty or still `CHANGE_ME`.

## Audit

Administrative actions, sign-ins and renewal decisions go to `audit_log`, and reads of patient data go to `access_log`. Neither stores message text, passwords or tokens. If an audit entry fails to write, the action is not undone and only an error is logged. If an access entry fails to write, the data are not returned. <!-- verify: V-39 audit rows for rx decisions, signing, account changes -->

A database administrator can alter both tables. There is no tamper protection.

## Known gaps

- No two-factor authentication, leaked-password check or alert for unusual sign-ins.
- No external penetration test. One internal review before launch on 25 November 2026 was done by another AI agent in the development process. It read the code and compared a rewritten version of the rules, and did not attack the live site.
- Database files and backups are not separately encrypted and rely on the host's disk. Backups are cleaned up by hand.
- The GitHub Pages workflow does not pin third-party actions to a hash; the CI workflow does.
- Against prompt injection there are only pattern rules and data marking, which stop common wording but not a determined person.
- There is a single back end. If the host or Cloudflare fails, the whole service stops.

## How to report

Please report privately through GitHub as described in [SECURITY.md](https://github.com/naritaroad/previsit-desk/blob/main/SECURITY.md), with the endpoint or file, steps to reproduce and the impact. While testing, do not read or change other visitors' data and do not generate heavy traffic. There is no bounty. Response times are in "Incidents and corrections".
