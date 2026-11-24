# NOTICE

PreVisit Desk 診前助理 is released under the MIT License (see [LICENSE](LICENSE)).

## Provenance

The service skeleton (Rust axum API, SQLx/PostgreSQL storage, the `genai` model gateway, the bounded agent loop, the SSE stream, the i18n tooling and the eval runner) is adapted from the author's own course project **tracen-aas-tsr**, a midterm repository for a different course. Only the generic engineering parts were carried over. No characters, artwork, 3D models, motion data, brand marks or fictional-world content from that project are included here; the git history was started fresh.

## Design references (ideas only, no code or text copied)

- Brodeur et al., *A prospective clinical feasibility study of a conversational diagnostic AI in an ambulatory primary care clinic*, arXiv:2603.08448 (2026) — research on an AI that takes a history from patients before a clinic visit. The staged flow used here (chief complaint, history of present illness, background, confirmation) is this project's own design, inspired by that idea; the paper is not a specification for it.
- Doctronic and the Utah Office of Artificial Intelligence Policy regulatory mitigation agreement (announced 2026-01-06) — an AI limited to renewing existing prescriptions, with no new prescriptions, controlled or addictive drugs excluded, and physician review in stages. The pilot term listed there was October 2025 to October 2026; its current status was not verified.
- Taiwan Ministry of Health and Welfare, *醫療機構應用生成式人工智慧指引* (2026-05-29, 衛部醫字第 1151663164 號) — a non-binding guideline. This project does not claim compliance with or certification under it; it is built to stay assistive (a clinician or pharmacist decides) and to tell users they are talking to an AI.
- Taiwan *全民健康保險醫療辦法* (the National Health Insurance medical-care regulation), articles 14 and 22–25, for the continuous-prescription rules in `data/seed/refill_rules.csv`.

## Health content

Patient-education text in `data/rag/` is paraphrased from official or authoritative Taiwan sources. Each section carries its source URL and the date it was checked. The text is not medical advice.

## Third-party software

Dependencies are listed in `backend/Cargo.toml` and `web/package.json` and keep their own licenses.
