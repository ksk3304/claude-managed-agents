/**
 * Unit tests for `src/redact/internal-state.ts` — internal-state leakage guard.
 *
 * Parity with Python `scripts/cma_log_redaction.py:scrub_internal_state_for_chat`,
 * verified by the shared parity fixture
 * `tests/data/internal_state_patterns_parity_cases.json` (= snapshot
 * copied from makoto-prime/tests/data; sha-diff CI gate against
 * upstream is enforced by `scripts/check-patterns-drift.mjs` via
 * `.github/workflows/check-patterns-drift.yml`, Issue #186 N).
 */

import { describe, it, expect } from 'vitest';
import {
  INTERNAL_STATE_PATTERNS,
  scrubInternalStateForChat,
  softenBenignInternalReferencesForChat,
} from '../src/redact/internal-state';
import parityCases from './data/internal_state_patterns_parity_cases.json';

interface ParityCase {
  name: string;
  input: string;
  expect_hits: string[];
  expect_output_type: 'passthrough' | 'neutral';
}

interface ParityFixture {
  schema_version: number;
  neutral_template_format: string;
  cases: ParityCase[];
}

describe('INTERNAL_STATE_PATTERNS canonical registry', () => {
  it('is empty until a specific blocker is intentionally reintroduced', () => {
    expect(INTERNAL_STATE_PATTERNS).toEqual([]);
  });
});

describe('scrubInternalStateForChat', () => {
  it('passes through non-string input', () => {
    expect(scrubInternalStateForChat(null, 'job-1')).toEqual({ text: '', hits: [] });
    expect(scrubInternalStateForChat(undefined, 'job-1')).toEqual({ text: '', hits: [] });
    expect(scrubInternalStateForChat(123, 'job-1')).toEqual({ text: '', hits: [] });
  });
  it('passes through clean text', () => {
    const r = scrubInternalStateForChat('Hello world', 'job-1');
    expect(r.text).toBe('Hello world');
    expect(r.hits).toEqual([]);
  });
  it('passes through legacy internal-state wording because no patterns are registered', () => {
    const r = scrubInternalStateForChat('memory store にアクセス', 'job-X');
    expect(r.text).toBe('memory store にアクセス');
    expect(r.hits).toEqual([]);
  });
});

describe('softenBenignInternalReferencesForChat', () => {
  it('currently passes memory runtime paths through unchanged', () => {
    const softened = softenBenignInternalReferencesForChat(
      'まず `/mnt/memory/` に格納されている記憶を確認しました。',
    );
    expect(softened.text).toBe('まず `/mnt/memory/` に格納されている記憶を確認しました。');
    expect(softened.replacements).toEqual([]);
    expect(scrubInternalStateForChat(softened.text, 'job-1').hits).toEqual([]);
  });

  it('does not neutralize legacy hard failure wording while the pattern list is empty', () => {
    const softened = softenBenignInternalReferencesForChat(
      'memory store が未 attach のため対応できません',
    );
    const scrubbed = scrubInternalStateForChat(softened.text, 'job-1');
    expect(scrubbed.hits).toEqual([]);
    expect(scrubbed.text).toBe('memory store が未 attach のため対応できません');
  });
});

describe('parity fixture: Python ↔ TS', () => {
  const fixture = parityCases as ParityFixture;
  expect(fixture.schema_version).toBe(1);

  for (const c of fixture.cases) {
    it(`case "${c.name}"`, () => {
      const result = scrubInternalStateForChat(c.input, 'parity-job');
      expect(result.hits).toEqual(c.expect_hits);

      if (c.expect_output_type === 'passthrough') {
        expect(result.text).toBe(c.input);
      } else {
        // Neutral path — exact string match against the template.
        const expected = fixture.neutral_template_format.replace(
          '{job_id}',
          'parity-job',
        );
        expect(result.text).toBe(expected);
      }
    });
  }
});
