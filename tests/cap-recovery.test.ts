/**
 * Unit tests for `src/lib/cap-recovery.ts` — Cloud Run の
 * `_resolve_reactive_max_tool_calls` + `_reactive_cap_recovery_enabled`
 * 等価動作を確認する。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  REACTIVE_DEFAULT_MAX_TOOL_CALLS,
  REACTIVE_MAX_TOOL_CALLS_CEIL,
  resolveReactiveMaxToolCalls,
  isReactiveCapRecoveryEnabled,
  resolveCapRecoveryConfig,
  shouldAttemptCapRecovery,
  isCapStopReason,
  CAP_STOP_REASONS_FOR_RECOVERY,
  type CapRecoveryLogger,
} from '../src/lib/cap-recovery';

function makeLogger(): CapRecoveryLogger & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    warn(event, fields) {
      calls.push([event, fields]);
    },
  };
}

describe('resolveReactiveMaxToolCalls', () => {
  it('returns default when env undefined', () => {
    const logger = makeLogger();
    expect(resolveReactiveMaxToolCalls(undefined, logger)).toBe(
      REACTIVE_DEFAULT_MAX_TOOL_CALLS,
    );
    expect(logger.calls).toHaveLength(0);
  });

  it('returns default when env is empty string', () => {
    expect(resolveReactiveMaxToolCalls('', makeLogger())).toBe(40);
  });

  it('returns parsed value when in [1, 60]', () => {
    expect(resolveReactiveMaxToolCalls('25', makeLogger())).toBe(25);
    expect(resolveReactiveMaxToolCalls('1', makeLogger())).toBe(1);
    expect(resolveReactiveMaxToolCalls('60', makeLogger())).toBe(60);
  });

  it('warns and falls back when not integer', () => {
    const logger = makeLogger();
    expect(resolveReactiveMaxToolCalls('not-a-number', logger)).toBe(40);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]![0]).toBe('reactive_config');
    expect(logger.calls[0]![1].message).toBe('cma_reactive_max_tool_calls_invalid');
    expect(logger.calls[0]![1].reactive_max_tool_calls_raw).toBe('not-a-number');
  });

  it('warns and falls back on decimal (Number.isInteger guards)', () => {
    const logger = makeLogger();
    expect(resolveReactiveMaxToolCalls('30.5', logger)).toBe(40);
    expect(logger.calls).toHaveLength(1);
  });

  it('warns and falls back when below 1', () => {
    const logger = makeLogger();
    expect(resolveReactiveMaxToolCalls('0', logger)).toBe(40);
    expect(logger.calls[0]![1].message).toBe('cma_reactive_max_tool_calls_out_of_range');
  });

  it('warns and falls back when above CEIL', () => {
    const logger = makeLogger();
    expect(resolveReactiveMaxToolCalls('61', logger)).toBe(40);
    expect(logger.calls[0]![1].message).toBe('cma_reactive_max_tool_calls_out_of_range');
  });

  it('strips whitespace before parsing', () => {
    expect(resolveReactiveMaxToolCalls('  25  ', makeLogger())).toBe(25);
  });
});

describe('isReactiveCapRecoveryEnabled', () => {
  it('returns true when env undefined (default enabled)', () => {
    expect(isReactiveCapRecoveryEnabled(undefined)).toBe(true);
  });

  it('returns true when env empty', () => {
    expect(isReactiveCapRecoveryEnabled('')).toBe(true);
  });

  it('returns false for "0"', () => {
    expect(isReactiveCapRecoveryEnabled('0')).toBe(false);
  });

  it('returns false for "false" / "FALSE" / "False" (case-insensitive)', () => {
    expect(isReactiveCapRecoveryEnabled('false')).toBe(false);
    expect(isReactiveCapRecoveryEnabled('FALSE')).toBe(false);
    expect(isReactiveCapRecoveryEnabled('False')).toBe(false);
  });

  it('returns false for "no" / "NO"', () => {
    expect(isReactiveCapRecoveryEnabled('no')).toBe(false);
    expect(isReactiveCapRecoveryEnabled('NO')).toBe(false);
  });

  it('returns true for other strings (e.g. "1" / "true" / "yes")', () => {
    expect(isReactiveCapRecoveryEnabled('1')).toBe(true);
    expect(isReactiveCapRecoveryEnabled('true')).toBe(true);
    expect(isReactiveCapRecoveryEnabled('yes')).toBe(true);
    expect(isReactiveCapRecoveryEnabled('whatever')).toBe(true);
  });
});

describe('resolveCapRecoveryConfig', () => {
  it('combines both helpers', () => {
    const cfg = resolveCapRecoveryConfig({
      CMA_REACTIVE_MAX_TOOL_CALLS: '25',
      CMA_REACTIVE_CAP_RECOVERY_ENABLED: '0',
    });
    expect(cfg).toEqual({ maxToolCalls: 25, recoveryEnabled: false });
  });

  it('uses defaults for missing env values', () => {
    const cfg = resolveCapRecoveryConfig({});
    expect(cfg).toEqual({ maxToolCalls: 40, recoveryEnabled: true });
  });
});

describe('isCapStopReason / shouldAttemptCapRecovery', () => {
  it('CAP_STOP_REASONS_FOR_RECOVERY matches Python tuple', () => {
    expect([...CAP_STOP_REASONS_FOR_RECOVERY]).toEqual([
      'tool_call_cap',
      'max_iter',
      'session_watchdog',
    ]);
  });

  it('isCapStopReason: true for each cap reason', () => {
    expect(isCapStopReason('tool_call_cap')).toBe(true);
    expect(isCapStopReason('max_iter')).toBe(true);
    expect(isCapStopReason('session_watchdog')).toBe(true);
  });

  it('isCapStopReason: false for non-cap reasons', () => {
    expect(isCapStopReason('end_turn')).toBe(false);
    expect(isCapStopReason('')).toBe(false);
    expect(isCapStopReason('TOOL_CALL_CAP')).toBe(false); // case-sensitive
  });

  it('shouldAttemptCapRecovery: true only when cap AND recovery enabled', () => {
    const enabled = { maxToolCalls: 40, recoveryEnabled: true };
    const disabled = { maxToolCalls: 40, recoveryEnabled: false };
    expect(shouldAttemptCapRecovery('tool_call_cap', enabled)).toBe(true);
    expect(shouldAttemptCapRecovery('end_turn', enabled)).toBe(false);
    expect(shouldAttemptCapRecovery('tool_call_cap', disabled)).toBe(false);
    expect(shouldAttemptCapRecovery('end_turn', disabled)).toBe(false);
  });
});

describe('constants', () => {
  it('REACTIVE_DEFAULT_MAX_TOOL_CALLS matches Python (40)', () => {
    expect(REACTIVE_DEFAULT_MAX_TOOL_CALLS).toBe(40);
  });
  it('REACTIVE_MAX_TOOL_CALLS_CEIL matches Python (60)', () => {
    expect(REACTIVE_MAX_TOOL_CALLS_CEIL).toBe(60);
  });
});

describe('defaultCapRecoveryLogger', () => {
  it('writes JSON-encoded WARN line to console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      resolveReactiveMaxToolCalls('not-a-number');
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(line);
      expect(parsed.event).toBe('reactive_config');
      expect(parsed.level).toBe('WARN');
      expect(parsed.message).toBe('cma_reactive_max_tool_calls_invalid');
    } finally {
      spy.mockRestore();
    }
  });
});
