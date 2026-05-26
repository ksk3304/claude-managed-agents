#!/usr/bin/env node
//
// Drift detection for the internal-state pattern bundle (Issue
// ksk3304/makoto-prime#186 — N).
//
// MAKOTOくん's internal-state leakage guard runs in two languages:
//
//   - Python  : `scripts/cma_log_redaction.py` (Cloud Run bot)
//   - TS      : `src/redact/internal-state.ts`  (Cloudflare Worker)
//
// Both import the *same* JSON document — `scripts/data/internal_state_patterns.json`
// in the upstream makoto-prime repo — so that adding/removing a pattern
// is a one-file change with automatic propagation to both runtimes
// (= .claude/rules/makoto-kun-verification.md §1.1 "実行時フィルタとの同期").
//
// To ship the Cloudflare Worker we copy the JSON into this repo at
// `src/redact/internal_state_patterns.json` so `import patternsJson
// from './internal_state_patterns.json'` resolves inside the bundle.
// The same applies to the parity fixture at
// `tests/data/internal_state_patterns_parity_cases.json`.
//
// This script is a CI gate: it sha256-compares the bundled copies in
// this repo against the upstream canonical copies in makoto-prime and
// exits non-zero on drift. Failure mode:
//
//   - upstream repo missing entirely → WARN + exit 0 (matches the
//     `sync-makoto-spec.mjs` posture: CI runs without the sibling
//     checkout still succeed; deploy-time `git status` on the
//     committed copies catches stale bundles).
//   - bundle file missing in this repo → ERROR + exit 1
//   - sha256 mismatch                  → ERROR + exit 1 with diff hint
//
// Standard layout: upstream is checked out as a sibling repo at
// `../makoto-prime` from this repo root. Override with
// `MAKOTO_PRIME_DIR=/absolute/path` for non-standard checkouts (e.g.
// MAKOTO開発マン's `自分OS/` workspace layout).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const upstreamDir = resolve(
  root,
  process.env.MAKOTO_PRIME_DIR ?? '../makoto-prime',
);

/**
 * Pairs to compare: `[bundled-path-in-this-repo, upstream-path-in-makoto-prime, label]`.
 * Add a new tuple if a new shared JSON appears.
 */
const PAIRS = [
  [
    resolve(root, 'src/redact/internal_state_patterns.json'),
    resolve(upstreamDir, 'scripts/data/internal_state_patterns.json'),
    'internal_state_patterns.json (filter source)',
  ],
  [
    resolve(root, 'tests/data/internal_state_patterns_parity_cases.json'),
    resolve(upstreamDir, 'tests/data/internal_state_patterns_parity_cases.json'),
    'internal_state_patterns_parity_cases.json (Python ↔ TS parity fixture)',
  ],
];

function sha256(path) {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

function shortDiffSummary(localPath, upstreamPath) {
  try {
    const a = JSON.parse(readFileSync(localPath, 'utf-8'));
    const b = JSON.parse(readFileSync(upstreamPath, 'utf-8'));
    // Best-effort summary — only known schemas. Falls back silently.
    const out = [];
    if (Array.isArray(a.literals) && Array.isArray(b.literals)) {
      const aSet = new Set(a.literals);
      const bSet = new Set(b.literals);
      const onlyLocal = [...aSet].filter((x) => !bSet.has(x));
      const onlyUpstream = [...bSet].filter((x) => !aSet.has(x));
      if (onlyLocal.length || onlyUpstream.length) {
        out.push(`  literals: only-bundled=${JSON.stringify(onlyLocal)}, only-upstream=${JSON.stringify(onlyUpstream)}`);
      }
    }
    if (Array.isArray(a.regexes) && Array.isArray(b.regexes)) {
      const names = (xs) => xs.map((r) => r?.name ?? String(r)).sort();
      const al = names(a.regexes);
      const bl = names(b.regexes);
      if (JSON.stringify(al) !== JSON.stringify(bl)) {
        out.push(`  regexes: bundled=${JSON.stringify(al)} upstream=${JSON.stringify(bl)}`);
      }
    }
    if (Array.isArray(a.cases) && Array.isArray(b.cases)) {
      const names = (xs) => xs.map((c) => c?.name ?? '?').sort();
      const al = names(a.cases);
      const bl = names(b.cases);
      const onlyLocal = al.filter((x) => !bl.includes(x));
      const onlyUpstream = bl.filter((x) => !al.includes(x));
      if (onlyLocal.length || onlyUpstream.length) {
        out.push(`  parity cases: only-bundled=${JSON.stringify(onlyLocal)}, only-upstream=${JSON.stringify(onlyUpstream)}`);
      } else if (al.length === bl.length) {
        out.push(`  parity cases: same case names — content within a case must differ`);
      }
    }
    return out.length ? out.join('\n') : '  (no schema-aware summary available; inspect both files manually)';
  } catch (err) {
    return `  (could not summarise diff: ${err instanceof Error ? err.message : String(err)})`;
  }
}

if (!existsSync(upstreamDir)) {
  console.warn(
    `[check-patterns-drift] WARN upstream makoto-prime repo not found at ${upstreamDir} — skipping. ` +
      `Set MAKOTO_PRIME_DIR or check out makoto-prime as a sibling repo for full drift coverage.`,
  );
  process.exit(0);
}

let failed = false;
for (const [bundled, upstream, label] of PAIRS) {
  if (!existsSync(bundled)) {
    console.error(`[check-patterns-drift] ERROR bundled copy missing: ${bundled} (${label})`);
    failed = true;
    continue;
  }
  if (!existsSync(upstream)) {
    console.error(`[check-patterns-drift] ERROR upstream copy missing: ${upstream} (${label})`);
    failed = true;
    continue;
  }
  const a = sha256(bundled);
  const b = sha256(upstream);
  if (a !== b) {
    console.error(
      `[check-patterns-drift] DRIFT detected for ${label}\n` +
        `  bundled  ${bundled} sha256=${a.slice(0, 12)}\n` +
        `  upstream ${upstream} sha256=${b.slice(0, 12)}\n` +
        shortDiffSummary(bundled, upstream) +
        `\n  Fix: copy the upstream file over the bundled one and commit. e.g.\n` +
        `    cp ${upstream} ${bundled}`,
    );
    failed = true;
    continue;
  }
  console.log(`[check-patterns-drift] OK ${label} sha256=${a.slice(0, 12)}`);
}

if (failed) {
  console.error(
    '[check-patterns-drift] FAILED — bundled internal-state pattern data is out of sync with makoto-prime. See messages above.',
  );
  process.exit(1);
}
console.log('[check-patterns-drift] all pairs in sync.');
