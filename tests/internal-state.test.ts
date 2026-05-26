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
  it('exposes a non-empty list of pattern names', () => {
    expect(INTERNAL_STATE_PATTERNS.length).toBeGreaterThan(0);
  });
  it('includes the headline literals', () => {
    // These are the most-visible internal-state phrases — sanity check.
    expect(INTERNAL_STATE_PATTERNS).toContain('memory store');
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
  it('replaces with the neutral template + jobId on any HIT', () => {
    const r = scrubInternalStateForChat('memory store にアクセス', 'job-X');
    expect(r.text).toBe('[job-X] 今回のタスクは完了できませんでした。担当者が確認します。');
    expect(r.hits).toEqual(['memory store']);
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
