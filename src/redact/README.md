# `src/redact/` — Output redaction guards

This module hosts the Cloudflare Worker side of MAKOTOくん's output
redaction layer. Two guards live here:

- `internal-state.ts` — internal-state leakage guard, port of Python
  `scripts/cma_log_redaction.py:scrub_internal_state_for_chat`.
- `pii.ts` — PII redaction.

## Internal-state pattern bundle

The internal-state guard runs in **two languages** (Python on Cloud
Run + TypeScript on Cloudflare Workers) and both runtimes must agree
on the same pattern set. The canonical pattern document is:

- `scripts/data/internal_state_patterns.json` in the upstream
  **makoto-prime** repo (Issue ksk3304/makoto-prime#177 Phase 1 中盤 B).

The shared parity test fixture is:

- `tests/data/internal_state_patterns_parity_cases.json` in
  makoto-prime.

This repo bundles snapshot copies so that `import patternsJson from
'./internal_state_patterns.json'` resolves at build time inside the
Worker:

- `src/redact/internal_state_patterns.json`
- `tests/data/internal_state_patterns_parity_cases.json`

### JSON 正本変更時のフロー

When a pattern is added/removed/edited (upstream JSON is the entry
point — never edit the bundled copy first):

1. Edit `scripts/data/internal_state_patterns.json` in the **makoto-prime**
   repo. If the change adds a regex, also extend
   `tests/data/internal_state_patterns_parity_cases.json` so the parity
   gate keeps both runtimes honest. The human-checklist mirror at
   `.claude/rules/makoto-kun-verification.md` §1.1 must be updated in
   the same commit (manual sync — JSON has no automated link to that
   rule file).
2. Copy both updated JSON files into this repo:
   ```
   cp ../makoto-prime/scripts/data/internal_state_patterns.json \
      src/redact/internal_state_patterns.json
   cp ../makoto-prime/tests/data/internal_state_patterns_parity_cases.json \
      tests/data/internal_state_patterns_parity_cases.json
   ```
3. Verify locally before committing:
   ```
   node scripts/check-patterns-drift.mjs   # exits 0 when in sync
   npm test -- tests/internal-state.test.ts
   ```
4. Commit + PR. The CI workflow
   `.github/workflows/check-patterns-drift.yml` (Issue
   ksk3304/makoto-prime#186 N) re-runs the sha256 comparison against
   the upstream `master` branch and blocks the merge on drift.

Skipping step 2 (= only editing upstream) is the failure mode this
gate exists to catch. Skipping step 1 (= editing the bundled copy
without upstream) drifts the Python runtime, which is caught at the
next upstream PR.
