import { describe, expect, it, vi } from 'vitest';

import { resolveReactiveSessionWatchdogSec } from '../src/lib/session-orchestrator';

describe('resolveReactiveSessionWatchdogSec', () => {
  it('returns undefined when unset so the session default remains 600s', () => {
    expect(resolveReactiveSessionWatchdogSec(undefined)).toBeUndefined();
    expect(resolveReactiveSessionWatchdogSec('')).toBeUndefined();
    expect(resolveReactiveSessionWatchdogSec('   ')).toBeUndefined();
  });

  it('accepts 0..600 integer seconds for incident tests', () => {
    expect(resolveReactiveSessionWatchdogSec('0')).toBe(0);
    expect(resolveReactiveSessionWatchdogSec('1')).toBe(1);
    expect(resolveReactiveSessionWatchdogSec('600')).toBe(600);
  });

  it('rejects invalid values and falls back to default behavior', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveReactiveSessionWatchdogSec('-1')).toBeUndefined();
      expect(resolveReactiveSessionWatchdogSec('601')).toBeUndefined();
      expect(resolveReactiveSessionWatchdogSec('1.5')).toBeUndefined();
      expect(resolveReactiveSessionWatchdogSec('abc')).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(4);
    } finally {
      spy.mockRestore();
    }
  });
});
