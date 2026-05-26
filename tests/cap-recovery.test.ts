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
  RECOVERY_MAX_TOOL_CALLS,
  RECOVERY_WALL_TIMEOUT_MS,
  RECOVERY_PROMPT,
  runCapRecovery,
  createRejectingToolDispatcher,
  type CapRecoveryLogger,
  type CapRecoveryStreamExecutor,
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

// ============================================================================
// runCapRecovery — Python `run_cap_recovery` (cma_lib.py l.3100) parity
// ============================================================================

describe('recovery constants byte-equivalent to Python', () => {
  it('RECOVERY_MAX_TOOL_CALLS matches Python (_RECOVERY_MAX_TOOL_CALLS = 3)', () => {
    expect(RECOVERY_MAX_TOOL_CALLS).toBe(3);
  });

  it('RECOVERY_WALL_TIMEOUT_MS matches Python (_RECOVERY_WALL_TIMEOUT_SEC = 150 → 150_000ms)', () => {
    expect(RECOVERY_WALL_TIMEOUT_MS).toBe(150_000);
  });

  it('RECOVERY_PROMPT is byte-equivalent to Python _RECOVERY_PROMPT', () => {
    // Python cma_lib.py l.95-103 と同一文字列 (連結後)。
    // 改行・読点・記号いずれかが食い違うと parity 崩壊。
    const expected =
      '【ツール使用が上限に達しました】これ以上ツール (bash / read / grep 等) は' +
      '使用できません。新たな調査・ファイル読み込みは一切行わず、ここまでで既に' +
      '収集・把握した情報だけを使って、最初に依頼された内容を *今すぐ完成形で* ' +
      '出力してください。情報が取得できなかった項目は「取得未完了」と明記して' +
      '構いません。ツールは呼ばず、本文テキストのみで回答してください。' +
      'EMAIL_SEND / CHAT_POST / SCHEDULE_ACTION 等の出力マーカーは一切付けず、' +
      'ユーザーに見せる本文だけを書いてください。';
    expect(RECOVERY_PROMPT).toBe(expected);
  });
});

describe('createRejectingToolDispatcher', () => {
  it('records observed tool names and returns is_error envelope', async () => {
    const observed: string[] = [];
    const dispatcher = createRejectingToolDispatcher(observed);

    const r1 = await dispatcher('drive_search', { q: 'foo' });
    expect(r1.ok).toBe(false);
    expect((r1.payload as { error: string }).error).toBe('recovery_tool_disabled');
    expect((r1.payload as { tool: string }).tool).toBe('drive_search');

    const r2 = await dispatcher('sheets_read', {});
    expect(r2.ok).toBe(false);

    expect(observed).toEqual(['drive_search', 'sheets_read']);
  });

  it('does not throw — guarantees event loop continues', async () => {
    const observed: string[] = [];
    const dispatcher = createRejectingToolDispatcher(observed);
    await expect(dispatcher('anything', null)).resolves.toBeDefined();
  });
});

describe('runCapRecovery', () => {
  it('returns outcome="recovered" with trimmed text when executor yields text', async () => {
    const executor: CapRecoveryStreamExecutor = async (input) => {
      // executor が渡された引数を verify
      expect(input.sessionId).toBe('sess-abc');
      expect(input.recoveryPrompt).toBe(RECOVERY_PROMPT);
      expect(input.maxToolCalls).toBe(RECOVERY_MAX_TOOL_CALLS);
      return {
        text: '  完成本文です。  ',
        stopReason: 'session.status_idle',
      };
    };

    const r = await runCapRecovery({ sessionId: 'sess-abc', executor });
    expect(r.outcome).toBe('recovered');
    expect(r.text).toBe('完成本文です。'); // trim 済
    expect(r.stopReason).toBe('session.status_idle');
    expect(r.toolNames).toEqual([]);
    expect(r.error).toBe('');
  });

  it('returns outcome="empty" when executor yields empty/whitespace text', async () => {
    const executor: CapRecoveryStreamExecutor = async () => ({
      text: '   ',
      stopReason: 'session.status_idle',
    });

    const r = await runCapRecovery({ sessionId: 's', executor });
    expect(r.outcome).toBe('empty');
    expect(r.text).toBe('');
    expect(r.stopReason).toBe('session.status_idle');
  });

  it('returns outcome="timeout" when executor exceeds wallTimeoutMs', async () => {
    const executor: CapRecoveryStreamExecutor = () =>
      new Promise((resolve) => {
        // 実時間 50ms を返すが、timeout は 10ms なので timeout 側が勝つ
        setTimeout(() => resolve({ text: 'late', stopReason: 'idle' }), 50);
      });

    const r = await runCapRecovery({
      sessionId: 's',
      executor,
      wallTimeoutMs: 10,
    });
    expect(r.outcome).toBe('timeout');
    expect(r.text).toBe('');
    expect(r.stopReason).toBe('');
    expect(r.error).toMatch(/recovery wall timeout >10ms/);
  });

  it('returns outcome="failed" with error detail when executor throws', async () => {
    const executor: CapRecoveryStreamExecutor = async () => {
      throw new TypeError('session not resumable');
    };

    const r = await runCapRecovery({ sessionId: 's', executor });
    expect(r.outcome).toBe('failed');
    expect(r.text).toBe('');
    expect(r.stopReason).toBe('');
    expect(r.error).toMatch(/TypeError: session not resumable/);
  });

  it('captures observed tool names from rejecting dispatcher', async () => {
    const executor: CapRecoveryStreamExecutor = async (input) => {
      // executor 内で recovery 用 dispatcher が叩かれるシナリオ
      await input.toolDispatcher('drive_search', {});
      await input.toolDispatcher('gmail_send', {});
      return { text: '部分本文', stopReason: 'limit.custom_tool_calls' };
    };

    const r = await runCapRecovery({ sessionId: 's', executor });
    expect(r.outcome).toBe('recovered');
    expect(r.toolNames).toEqual(['drive_search', 'gmail_send']);
    expect(r.stopReason).toBe('limit.custom_tool_calls');
  });

  it('uses caller-provided recoveryPrompt / maxToolCalls when supplied', async () => {
    const seen: { prompt?: string; max?: number } = {};
    const executor: CapRecoveryStreamExecutor = async (input) => {
      seen.prompt = input.recoveryPrompt;
      seen.max = input.maxToolCalls;
      return { text: 'ok', stopReason: 'idle' };
    };

    await runCapRecovery({
      sessionId: 's',
      executor,
      recoveryPrompt: 'custom prompt',
      maxToolCalls: 7,
    });
    expect(seen.prompt).toBe('custom prompt');
    expect(seen.max).toBe(7);
  });

  it('tolerates executor returning undefined-ish fields', async () => {
    const executor: CapRecoveryStreamExecutor = async () =>
      ({ text: undefined, stopReason: undefined } as unknown as {
        text: string;
        stopReason: string;
      });

    const r = await runCapRecovery({ sessionId: 's', executor });
    expect(r.outcome).toBe('empty');
    expect(r.text).toBe('');
    expect(r.stopReason).toBe('');
    expect(r.error).toBe('');
  });

  it('integrates with shouldAttemptCapRecovery gate (cap reason + flag enabled)', async () => {
    // 呼出側 flow を模擬: cap 検知 → recovery 実行 → 結果で cap notice 抑止
    const cfg = resolveCapRecoveryConfig({});
    const stopReason = 'tool_call_cap';
    expect(shouldAttemptCapRecovery(stopReason, cfg)).toBe(true);

    const executor: CapRecoveryStreamExecutor = async () => ({
      text: 'recovered body',
      stopReason: 'session.status_idle',
    });
    const r = await runCapRecovery({ sessionId: 's', executor });
    expect(r.outcome).toBe('recovered');
    // suppressed cap notice 判定の根拠 (= 呼出側で見る Python `_recovery_suppressed_cap_notice`)
    const suppressedCapNotice = r.outcome === 'recovered' && r.text.length > 0;
    expect(suppressedCapNotice).toBe(true);
  });
});
