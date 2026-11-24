# NOTICE

PreVisit Desk 診前助理 is released under the MIT License (see [LICENSE](LICENSE)).

## Provenance

The service skeleton (Rust axum API, SQLx/PostgreSQL storage, the `genai` model gateway, the bounded agent loop, the SSE stream, the i18n tooling and the eval runner) is adapted from the author's own course project **tracen-aas-tsr**, a midterm repository for a different course. Only the generic engineering parts were carried over. No characters, artwork, 3D models, motion data, brand marks or fictional-world content from that project are included here; the git history was started fresh.

## Design references (ideas only, no code or text copied)

- Google AMIE pre-visit research, arXiv:2603.08448 — state-aware, staged history taking before a visit.
- Doctronic (Utah regulatory sandbox) — scope-limited prescription *renewal*, with human review.
- Taiwan Ministry of Health and Welfare, *Guidelines for the Use of Generative AI in Medical Institutions* (2026-05-29, 衛部醫字第 1151663164 號) — the service is built to stay on the "assistive" side of that guidance.

## Health content

Patient-education text in `data/rag/` is paraphrased from official or authoritative Taiwan sources. Each section carries its source URL and the date it was checked. The text is not medical advice.

## Third-party software

Dependencies are listed in `backend/Cargo.toml` and `web/package.json` and keep their own licenses.
