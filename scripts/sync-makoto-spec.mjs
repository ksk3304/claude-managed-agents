#!/usr/bin/env node
//
// Sync MAKOTOくん system prompt spec from the upstream makoto-prime
// repo into committed Worker bundle data (Issue #186 #20).
//
// Reads:
//   - <MAKOTO_SPEC_DIR>/system-prompt-persona.md
//   - <MAKOTO_SPEC_DIR>/system-prompt-tools.md
// Writes (regenerated on each build, committed to git):
//   - src/data/persona-spec.ts
//   - src/data/tools-spec.ts
//
// MAKOTO_SPEC_DIR defaults to `../makoto-prime/products/makoto-kun/specs`
// relative to this repo root (the sibling-clone layout we ship in).
// Set MAKOTO_SPEC_DIR explicitly in CI / non-standard checkouts.
//
// Failure modes:
//   - spec dir missing entirely → WARN + exit 0 (lets `npm run build`
//     succeed in CI runs that don't carry the makoto-prime checkout;
//     the previously committed src/data/*.ts continues to ship)
//   - spec file missing under an existing dir → ERROR + exit 1 (= a
//     repo half-sync would silently corrupt the bundle, that should
//     fail loudly)
//   - file unreadable → ERROR + exit 1
//
// Drift detection at deploy time is handled by `git status` on
// src/data/*.ts after build. The persona-builder caller compares
// sha256 prefixes at runtime against the canonical spec (logged once
// at Worker startup, then audited via `scripts/check-prod-prompt-drift.sh`
// in the makoto-prime repo, per .claude/rules/makoto-kun-verification.md
// §5.2 本番反映ゲート).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const specDir = resolve(
  root,
  process.env.MAKOTO_SPEC_DIR ??
    '../makoto-prime/products/makoto-kun/specs',
);
const personaSrc = resolve(specDir, 'system-prompt-persona.md');
const toolsSrc = resolve(specDir, 'system-prompt-tools.md');
const targetDir = resolve(root, 'src/data');
const personaTarget = resolve(targetDir, 'persona-spec.ts');
const toolsTarget = resolve(targetDir, 'tools-spec.ts');

if (!existsSync(specDir)) {
  console.warn(
    `[sync-makoto-spec] WARN spec dir not found at ${specDir} — keeping committed src/data/*.ts. Set MAKOTO_SPEC_DIR or check out makoto-prime as a sibling repo to refresh the bundle.`,
  );
  process.exit(0);
}

for (const [path, label] of [
  [personaSrc, 'system-prompt-persona.md'],
  [toolsSrc, 'system-prompt-tools.md'],
]) {
  if (!existsSync(path)) {
    console.error(
      `[sync-makoto-spec] ERROR ${label} missing under ${specDir}. ` +
        `Half-sync would corrupt the Worker bundle — aborting.`,
    );
    process.exit(1);
  }
}

const persona = readFileSync(personaSrc, 'utf-8');
const tools = readFileSync(toolsSrc, 'utf-8');

function sha256Hex12(s) {
  return createHash('sha256').update(s, 'utf-8').digest('hex').slice(0, 12);
}

function renderTs(specLabel, body) {
  const sha = sha256Hex12(body);
  const bytes = Buffer.byteLength(body, 'utf-8');
  return `// GENERATED FILE — do not edit by hand.
// Source: ../../../makoto-prime/products/makoto-kun/specs/${specLabel}
// Regenerate via: \`npm run build\` (= prebuild hook scripts/sync-makoto-spec.mjs)
//
// Source sha256 (first 12 hex): ${sha}
// Source bytes: ${bytes}
//
// Drift check at runtime: caller computes sha256 of this constant +
// logs at Worker startup, compared against canonical spec via
// scripts/check-prod-prompt-drift.sh in the makoto-prime repo.
// See .claude/rules/makoto-kun-verification.md §5.2 本番反映ゲート.

export const ${specLabel.includes('persona') ? 'PERSONA' : 'TOOLS'}_SPEC = ${JSON.stringify(body)};

export const ${specLabel.includes('persona') ? 'PERSONA' : 'TOOLS'}_SPEC_SHA256_HEX12 = ${JSON.stringify(sha)};

export const ${specLabel.includes('persona') ? 'PERSONA' : 'TOOLS'}_SPEC_BYTES = ${bytes};
`;
}

if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
writeFileSync(personaTarget, renderTs('system-prompt-persona.md', persona));
writeFileSync(toolsTarget, renderTs('system-prompt-tools.md', tools));

console.log(
  `[sync-makoto-spec] synced persona=${persona.length}B (sha=${sha256Hex12(persona)}) tools=${tools.length}B (sha=${sha256Hex12(tools)})`,
);
