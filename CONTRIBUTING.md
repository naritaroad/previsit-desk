# Contributing

Thanks for looking. This is a small project with strict safety lines, so a few rules keep changes easy to review.

1. **Safety first.** The assistant must not diagnose, prescribe, or give doses. Changes that touch `data/seed/red_flags.csv`, `data/seed/scope_rules.csv`, the output guard, or the refill rules need matching tests and, where behavior changes, new cases in `data/eval/cases.jsonl`.
2. **One source of truth.** Numbers live in `data/seed/*.csv`, health-education text in `data/rag/`, UI text in `web/src/i18n/locales/`. Do not duplicate them in code.
3. **Language.** Interface text is Traditional Chinese (Taiwan wording) and English. No Simplified Chinese or Mainland terms in zh-TW strings.
4. **Checks before a pull request:**
   ```bash
   cd backend && cargo fmt --check && cargo clippy -- -D warnings && cargo test
   cd web && npm run build && npm test
   ```
5. **Commits.** Small, imperative subject lines. No generated trailers.
6. **Fictional data only** in examples, tests and screenshots.

See [docs/engineering/backend-spec.md](docs/engineering/backend-spec.md) and [docs/api/contract.md](docs/api/contract.md) for the technical contract.
