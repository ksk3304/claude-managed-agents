/**
 * Internal-state leakage guard — TypeScript bridge port of
 * `scripts/cma_log_redaction.py:scrub_internal_state_for_chat` (Python).
 *
 * Single source of truth = `scripts/data/internal_state_patterns.json`
 * in the makoto-prime repo (Issue #177 Phase 1 中盤 B). The JSON in
 * this directory is a snapshot copy; drift between the two is caught
 * pre-merge by `scripts/check-patterns-drift.mjs` (CI workflow
 * `.github/workflows/check-patterns-drift.yml`, Issue #186 N).
 *
 * Contract (parity with Python — verified by
 * `tests/data/internal_state_patterns_parity_cases.json` consumed
 * from `tests/internal_state.test.ts` at layer 9 集約):
 *
 *   scrubInternalStateForChat(text, jobId)
 *     → { text, hits }
 *
 * - Non-string / empty → passthrough.
 * - Any literal/regex HIT → text replaced with the neutral template
 *   `[<jobId>] 今回のタスクは完了できませんでした。担当者が確認します。`
 *   and hits returned in canonical order = literals array → regexes
 *   array order (NOT body-occurrence order). Two-stage loop guarantees
 *   the two languages produce identical hit sequences.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 — 層 7 redactor)
 */

import patternsJson from './internal_state_patterns.json';

interface PatternsJson {
  schema_version: number;
  literals?: unknown;
  regexes?: unknown;
}

interface RegexEntry {
  name: string;
  pattern: RegExp;
}

function loadPatterns(): {
  literals: readonly string[];
  regexes: readonly RegexEntry[];
} {
  const data = patternsJson as PatternsJson;
  if (data.schema_version !== 1) {
    throw new Error(
      `internal_state_patterns: unsupported schema_version=${String(
        data.schema_version,
      )}, expected 1`,
    );
  }

  const literalsRaw = data.literals;
  if (!Array.isArray(literalsRaw)) {
    throw new Error("internal_state_patterns: 'literals' must be an array");
  }
  const literals: string[] = [];
  for (const lit of literalsRaw) {
    if (typeof lit !== 'string') {
      throw new Error(
        `internal_state_patterns: literals contain non-string: ${String(lit)}`,
      );
    }
    literals.push(lit);
  }

  const regexesRaw = data.regexes;
  if (!Array.isArray(regexesRaw)) {
    throw new Error("internal_state_patterns: 'regexes' must be an array");
  }
  const regexes: RegexEntry[] = [];
  for (const entry of regexesRaw) {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(
        `internal_state_patterns: regex entry must be object: ${String(entry)}`,
      );
    }
    const obj = entry as { name?: unknown; pattern?: unknown };
    if (typeof obj.name !== 'string' || obj.name.length === 0) {
      throw new Error(
        `internal_state_patterns: regex entry missing 'name': ${JSON.stringify(
          entry,
        )}`,
      );
    }
    if (typeof obj.pattern !== 'string') {
      throw new Error(
        `internal_state_patterns: regex entry missing 'pattern': ${JSON.stringify(
          entry,
        )}`,
      );
    }
    let compiled: RegExp;
    try {
      compiled = new RegExp(obj.pattern);
    } catch (err) {
      throw new Error(
        `internal_state_patterns: regex compile failed name=${obj.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    regexes.push({ name: obj.name, pattern: compiled });
  }

  return { literals, regexes };
}

const { literals: INTERNAL_STATE_LITERALS, regexes: INTERNAL_STATE_REGEXES } =
  loadPatterns();

// Load-time observation log — visible in Cloudflare Worker logs at
// startup, mirrors Python `[cma_log_redaction] internal_state_patterns
// loaded: ...` line.
console.log(
  `[internal-state] patterns loaded: literals=${INTERNAL_STATE_LITERALS.length} regexes=${INTERNAL_STATE_REGEXES.length}`,
);

const neutralReplacement = (jobId: string): string =>
  `[${jobId}] 今回のタスクは完了できませんでした。担当者が確認します。`;

/**
 * Canonical, ordered pattern-name registry — literals followed by
 * regex names. Parity with Python `INTERNAL_STATE_PATTERNS`.
 */
export const INTERNAL_STATE_PATTERNS: readonly string[] = [
  ...INTERNAL_STATE_LITERALS,
  ...INTERNAL_STATE_REGEXES.map((r) => r.name),
];

export interface ScrubResult {
  text: string;
  hits: string[];
}

export interface SoftenedInternalReferencesResult {
  text: string;
  replacements: string[];
}

const INTERNAL_STATE_MASK = '内部運用情報';
const INTERNAL_STATE_REGEX_MASK = '内部記憶ファイル';

const BENIGN_INTERNAL_REFERENCE_REPLACEMENTS: readonly {
  name: string;
  pattern: RegExp;
  replacement: string;
}[] = [
  {
    name: 'mnt_memory_path',
    pattern: /`?\/mnt\/memory(?:\/[^\s`"'）)]*)?`?/g,
    replacement: '社内記憶',
  },
];

/**
 * User-facing softener for benign implementation references.
 *
 * The hard redactor below intentionally turns risky failure text into a neutral
 * error. Before that final guard, this function rewrites harmless internal
 * paths that the agent may mention while explaining its work, so useful answers
 * are preserved without exposing local runtime details.
 */
export function softenBenignInternalReferencesForChat(
  text: unknown,
): SoftenedInternalReferencesResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: typeof text === 'string' ? text : '', replacements: [] };
  }

  let out = text;
  const replacements: string[] = [];
  for (const rule of BENIGN_INTERNAL_REFERENCE_REPLACEMENTS) {
    let changed = false;
    out = out.replace(rule.pattern, () => {
      changed = true;
      return rule.replacement;
    });
    if (changed) replacements.push(rule.name);
  }
  return { text: out, replacements };
}

/**
 * TS parity of `scrub_internal_state_for_chat(text, job_id) ->
 * (text, hits)`. See module docstring for the contract.
 */
export function scrubInternalStateForChat(
  text: unknown,
  jobId: string,
): ScrubResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: typeof text === 'string' ? text : '', hits: [] };
  }

  const hits: string[] = [];
  for (const lit of INTERNAL_STATE_LITERALS) {
    if (text.includes(lit)) {
      hits.push(lit);
    }
  }
  for (const { name, pattern } of INTERNAL_STATE_REGEXES) {
    if (pattern.test(text)) {
      hits.push(name);
    }
  }

  if (hits.length === 0) {
    return { text, hits: [] };
  }
  return { text: neutralReplacement(jobId), hits };
}

/**
 * Chat-facing sanitizer that preserves the CMA answer.
 *
 * `scrubInternalStateForChat` is still the legacy hard neutralizer. The Chat
 * bridge should not throw away an otherwise useful answer after CMA already
 * produced it, so this sanitizer masks only the matched internal terms and
 * returns the rest of the text intact.
 */
export function maskInternalStateForChat(text: unknown): ScrubResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: typeof text === 'string' ? text : '', hits: [] };
  }

  let out = text;
  const hits: string[] = [];
  for (const lit of INTERNAL_STATE_LITERALS) {
    if (out.includes(lit)) {
      hits.push(lit);
      out = out.split(lit).join(INTERNAL_STATE_MASK);
    }
  }
  for (const { name, pattern } of INTERNAL_STATE_REGEXES) {
    const globalPattern = new RegExp(pattern.source, 'g');
    if (globalPattern.test(out)) {
      hits.push(name);
      out = out.replace(globalPattern, INTERNAL_STATE_REGEX_MASK);
    }
  }
  return { text: out, hits };
}
