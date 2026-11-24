# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). Both specification versions were checked on 2026-11-25; Keep a Changelog 2.0.0 was still marked as a draft.

## [Unreleased]

## [0.1.0] - 2026-11-25

First public release, built for a class demonstration. The service skeleton is adapted from the author's earlier course project `tracen-aas-tsr` (see [NOTICE.md](NOTICE.md)); the git history starts here.

### Added

- Staged pre-visit intake: chief complaint, history of present illness, background and a confirmed read-back. Code tracks the collected fields and the model only asks about what is missing.
- Red-flag precheck driven by `data/seed/red_flags.csv` (Chinese and English rules, clause-scoped negation). A hit returns fixed 119 / 1925 text, opens an urgent ticket and never calls the model.
- Scope precheck driven by `data/seed/scope_rules.csv`: requests for prescriptions, controlled drugs and prompt injection get a fixed refusal; prescription requests also open a ticket.
- Output guard that rewrites or replaces replies containing diagnoses, prescribing or doses, plus a style clean-up for markdown and emoji.
- Personal-data masking (ID numbers, phone numbers, e-mail addresses, long digit runs) before storage and before any model call.
- Chronic-prescription refill check as a pure Rust function with four outcomes, cited to articles 14 and 22–25 of the National Health Insurance medical-care regulation. Any controlled drug, symptom change or side effect becomes a handoff ticket.
- Health-education handbook (`data/rag/`) with a source URL and check date per section, searched in process.
- Tools: `search_health_education`, `check_chronic_refill`, `transfer_to_clinician`, `save_previsit_summary`, and an internal `record_intake`.
- Patient page with chat, tool trace, live summary and refill form; clinician login, queue, visit detail, tickets and review; safety page.
- Public-demo protections: per-client rate limits, a daily model-call cap, automatic deletion after `RETENTION_DAYS` (default 14).
- Gemini through the `genai` crate with a primary and a fallback model, both set by environment variables, and an offline mock model for tests.
- Evaluation runner (`cargo run -- eval`) with 38 cases in five categories; results are written to `data/eval/results/`.
- zh-TW and English interface, light and dark themes checked against WCAG AA, mobile layout.
- Three-stage Docker image, production compose stack with its own Cloudflare Tunnel container, deploy scripts, and continuous integration.
- Bilingual README, deployment guide, demo script and a GitHub Pages project page.

### Security

- The model API key stays on the server. Containers run as a non-root user with a read-only root file system and memory limits.

[Unreleased]: https://github.com/naritaroad/previsit-desk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/naritaroad/previsit-desk/releases/tag/v0.1.0
