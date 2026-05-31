/**
 * Unit tests for `src/lib/cost-guard.ts` — KV-backed cost guard.
 *
 * Covers:
 *   - `incrementCounter`: KV key shape, increment, month-bucket vs day-bucket,
 *     non-finite / negative `by` guard, KV failure fail-open
 *   - month/day rollover (= 月跨ぎ・日跨ぎで別 key に書き、過去 key の値が
 *     新 bucket を汚さない)
 *   - `checkBudget`: limit override, exceeded axis detection, KV miss = 0
 *   - `wrapChatSender`: 予算内通過 + chat_post カウンタ +1、予算超過で
 *     sender 非呼出 + operator 警告 1 回、operatorSpace 未設定で警告 no-op、
 *     warning 重複抑止フラグ、bypassGuard 経路
 */

import { describe, it, expect } from 'vitest';
import {
  incrementCounter,
  readCounter,
  checkBudget,
  wrapChatSender,
  evaluateSessionCostAfterTurn,
  handlePendingSessionApproval,
  projectSessionCostForPdfPreflight,
  usdFromUsage,
  DEFAULT_LIMITS,
  _internals,
  type CostGuardDeps,
  type ChatSender,
} from '../src/lib/cost-guard';
import { makeKv } from './makoto-helpers';

const {
  KIND_ANTHROPIC_CALL,
  KIND_ANTHROPIC_COST_USD,
  KIND_CHAT_POST,
  KIND_EXTERNAL_API_CALL,
  PREFIX,
  resetCostGuardConfigCacheForTest,
} = _internals;

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

function makeDeps(overrides: Partial<CostGuardDeps> = {}): CostGuardDeps {
  return {
    kv: makeKv(),
    now: fixedNow('2026-05-15T12:00:00Z'),
    ...overrides,
  };
}

function makeCostGuardDb(): D1Database & {
  _rows: Map<string, { kind: string; bucket: string; value: number }>;
  _config: Map<string, Record<string, unknown>>;
} {
  const rows = new Map<string, { kind: string; bucket: string; value: number }>();
  const config = new Map<string, Record<string, unknown>>();
  const keyFor = (kind: string, bucket: string) => `${kind}:${bucket}`;
  return {
    _rows: rows,
    _config: config,
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...bound: unknown[]) {
          params = bound;
          return stmt;
        },
        async first<T>() {
          if (/^SELECT enabled, paused_until_ms, limits_json/i.test(sql.trim())) {
            const [id] = params as [string];
            return (config.get(id) as T) ?? null;
          }
          if (/^SELECT value FROM cost_guard_counters/i.test(sql.trim())) {
            const [kind, bucket] = params as [string, string];
            const row = rows.get(keyFor(kind, bucket));
            return (row ? { value: row.value } : null) as T | null;
          }
          if (/^INSERT INTO cost_guard_counters/i.test(sql.trim())) {
            const [kind, bucket, by] = params as [string, string, number];
            const key = keyFor(kind, bucket);
            const prev = rows.get(key);
            const value = (prev?.value ?? 0) + by;
            rows.set(key, { kind, bucket, value });
            return { value } as T;
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
        async run() {
          return { success: true, meta: {}, results: [] };
        },
        async all<T>() {
          return { success: true, meta: {}, results: [] as T[] };
        },
        raw: async () => [],
      };
      return stmt;
    },
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database & {
    _rows: Map<string, { kind: string; bucket: string; value: number }>;
    _config: Map<string, Record<string, unknown>>;
  };
}

describe('incrementCounter — basic increment and key shape', () => {
  it('writes a monthly bucket key for anthropic_call', async () => {
    const deps = makeDeps();
    const next = await incrementCounter(deps, KIND_ANTHROPIC_CALL, 3);
    expect(next).toBe(3);
    const raw = await deps.kv.get(`${PREFIX}:anthropic_call:2026-05`);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ v: 3 });
  });

  it('writes a daily bucket key for chat_post', async () => {
    const deps = makeDeps();
    const next = await incrementCounter(deps, KIND_CHAT_POST, 1);
    expect(next).toBe(1);
    const raw = await deps.kv.get(`${PREFIX}:chat_post:2026-05-15`);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ v: 1 });
  });

  it('uses D1 counters first when DB is provided', async () => {
    const db = makeCostGuardDb();
    const deps = makeDeps({ db });
    await incrementCounter(deps, KIND_EXTERNAL_API_CALL, 2);
    await incrementCounter(deps, KIND_EXTERNAL_API_CALL, 3);
    expect(await readCounter(deps, KIND_EXTERNAL_API_CALL)).toBe(5);
    expect(db._rows.get('external_api_call:2026-05-15')?.value).toBe(5);
    expect(await deps.kv.get(`${PREFIX}:external_api_call:2026-05-15`)).toBeNull();
  });

  it('sums repeated increments into the same bucket', async () => {
    const deps = makeDeps();
    await incrementCounter(deps, KIND_ANTHROPIC_CALL, 2);
    await incrementCounter(deps, KIND_ANTHROPIC_CALL, 5);
    const total = await readCounter(deps, KIND_ANTHROPIC_CALL);
    expect(total).toBe(7);
  });

  it('preserves fractional USD increments for anthropic_cost_usd', async () => {
    const deps = makeDeps();
    await incrementCounter(deps, KIND_ANTHROPIC_COST_USD, 0.0125);
    await incrementCounter(deps, KIND_ANTHROPIC_COST_USD, 0.05);
    const total = await readCounter(deps, KIND_ANTHROPIC_COST_USD);
    expect(total).toBeCloseTo(0.0625, 6);
  });

  it('rejects non-finite / negative `by`', async () => {
    const deps = makeDeps();
    await expect(
      incrementCounter(deps, KIND_CHAT_POST, -1),
    ).rejects.toThrow(/non-negative/);
    await expect(
      incrementCounter(deps, KIND_CHAT_POST, Number.NaN),
    ).rejects.toThrow(/non-negative/);
    await expect(
      incrementCounter(deps, KIND_CHAT_POST, Number.POSITIVE_INFINITY),
    ).rejects.toThrow(/non-negative/);
  });

  it('returns the current value when by === 0 (no-op write)', async () => {
    const deps = makeDeps();
    await incrementCounter(deps, KIND_CHAT_POST, 4);
    const r = await incrementCounter(deps, KIND_CHAT_POST, 0);
    expect(r).toBe(4);
    // Key should still contain v=4 (no overwrite to a different value)
    const raw = await deps.kv.get(`${PREFIX}:chat_post:2026-05-15`);
    expect(JSON.parse(raw!)).toEqual({ v: 4 });
  });
});

describe('month / day rollover', () => {
  it('writes to a different key when the month changes', async () => {
    const kv = makeKv();
    const may = makeDeps({ kv, now: fixedNow('2026-05-31T23:00:00Z') });
    const june = makeDeps({ kv, now: fixedNow('2026-06-01T00:30:00Z') });
    await incrementCounter(may, KIND_ANTHROPIC_COST_USD, 10);
    await incrementCounter(june, KIND_ANTHROPIC_COST_USD, 3);
    // 5月 / 6月 は別 key
    expect(await readCounter(may, KIND_ANTHROPIC_COST_USD)).toBe(10);
    expect(await readCounter(june, KIND_ANTHROPIC_COST_USD)).toBe(3);
    // KV にも別 key で並存
    expect(await kv.get(`${PREFIX}:anthropic_cost_usd:2026-05`)).not.toBeNull();
    expect(await kv.get(`${PREFIX}:anthropic_cost_usd:2026-06`)).not.toBeNull();
  });

  it('writes to a different key when the day changes (chat_post)', async () => {
    const kv = makeKv();
    const d1 = makeDeps({ kv, now: fixedNow('2026-05-15T23:50:00Z') });
    const d2 = makeDeps({ kv, now: fixedNow('2026-05-16T00:10:00Z') });
    await incrementCounter(d1, KIND_CHAT_POST, 5);
    await incrementCounter(d2, KIND_CHAT_POST, 1);
    expect(await readCounter(d1, KIND_CHAT_POST)).toBe(5);
    expect(await readCounter(d2, KIND_CHAT_POST)).toBe(1);
  });
});

describe('KV failure — fail-open semantics', () => {
  it('incrementCounter returns NaN (no throw) when KV.put rejects', async () => {
    const kv = makeKv();
    // Replace put with a rejecting impl after warmup
    (kv as unknown as { put: () => Promise<never> }).put = async () => {
      throw new Error('simulated KV outage');
    };
    const deps = makeDeps({ kv });
    const r = await incrementCounter(deps, KIND_CHAT_POST, 1);
    expect(Number.isNaN(r)).toBe(true);
  });

  it('readCounter returns 0 when KV.get rejects', async () => {
    const kv = makeKv();
    (kv as unknown as { get: () => Promise<never> }).get = async () => {
      throw new Error('simulated KV outage');
    };
    const deps = makeDeps({ kv });
    expect(await readCounter(deps, KIND_CHAT_POST)).toBe(0);
  });

  it('readCounter returns 0 when the stored value is malformed', async () => {
    const deps = makeDeps();
    await deps.kv.put(`${PREFIX}:chat_post:2026-05-15`, 'not-json');
    expect(await readCounter(deps, KIND_CHAT_POST)).toBe(0);
  });
});

describe('checkBudget', () => {
  it('reports current=0 and exceeded=[] on a cold KV', async () => {
    const deps = makeDeps();
    const status = await checkBudget(deps);
    expect(status.current).toEqual({
      anthropicMonthlyCalls: 0,
      anthropicMonthlyUsd: 0,
      chatDailyCount: 0,
      externalApiDailyCount: 0,
    });
    expect(status.exceeded).toEqual([]);
    expect(status.limit).toEqual(DEFAULT_LIMITS);
  });

  it('flags anthropicMonthlyUsd as exceeded when current >= limit', async () => {
    const deps = makeDeps({ limits: { anthropicMonthlyUsd: 1.0 } });
    await incrementCounter(deps, KIND_ANTHROPIC_COST_USD, 1.5);
    const status = await checkBudget(deps);
    expect(status.current.anthropicMonthlyUsd).toBeCloseTo(1.5, 6);
    expect(status.exceeded).toContain('anthropicMonthlyUsd');
    expect(status.exceeded).not.toContain('chatDailyCount');
  });

  it('flags anthropicMonthlyCalls as exceeded when current >= limit', async () => {
    const deps = makeDeps({ limits: { anthropicMonthlyCalls: 2 } });
    await incrementCounter(deps, KIND_ANTHROPIC_CALL, 2);
    const status = await checkBudget(deps);
    expect(status.current.anthropicMonthlyCalls).toBe(2);
    expect(status.exceeded).toContain('anthropicMonthlyCalls');
  });

  it('flags chatDailyCount as exceeded at the boundary (>= limit)', async () => {
    const deps = makeDeps({ limits: { chatDailyCount: 3 } });
    await incrementCounter(deps, KIND_CHAT_POST, 3);
    const status = await checkBudget(deps);
    expect(status.exceeded).toEqual(['chatDailyCount']);
  });

  it('respects partial limit override (uses default for unspecified axis)', async () => {
    const deps = makeDeps({ limits: { chatDailyCount: 1 } });
    const status = await checkBudget(deps);
    expect(status.limit.chatDailyCount).toBe(1);
    expect(status.limit.anthropicMonthlyUsd).toBe(
      DEFAULT_LIMITS.anthropicMonthlyUsd,
    );
  });

  it('can flag both axes at once', async () => {
    const deps = makeDeps({
      limits: { anthropicMonthlyUsd: 0.1, chatDailyCount: 1 },
    });
    await incrementCounter(deps, KIND_ANTHROPIC_COST_USD, 0.5);
    await incrementCounter(deps, KIND_CHAT_POST, 5);
    const status = await checkBudget(deps);
    expect(status.exceeded.sort()).toEqual([
      'anthropicMonthlyUsd',
      'chatDailyCount',
    ]);
  });

  it('flags externalApiDailyCount as exceeded when current >= limit', async () => {
    const deps = makeDeps({ limits: { externalApiDailyCount: 1 } });
    await incrementCounter(deps, KIND_EXTERNAL_API_CALL, 1);
    const status = await checkBudget(deps);
    expect(status.current.externalApiDailyCount).toBe(1);
    expect(status.exceeded).toContain('externalApiDailyCount');
  });

  it('applies D1 config hard-cap overlay and disabled state', async () => {
    const db = makeCostGuardDb();
    db._config.set('global', {
      enabled: 0,
      paused_until_ms: null,
      limits_json: JSON.stringify({ chatDailyCount: 1 }),
      updated_by: 'admin@example.com',
      updated_at_ms: 123,
      change_seq: 4,
    });
    const deps = makeDeps({ db });
    await incrementCounter(deps, KIND_CHAT_POST, 2);
    const status = await checkBudget(deps);
    expect(status.limit.chatDailyCount).toBe(1);
    expect(status.config.enabled).toBe(false);
    expect(status.config.changeSeq).toBe(4);
    expect(status.exceeded).toEqual([]);
  });

  it('falls back to KV/defaults when D1 tables are unavailable', async () => {
    resetCostGuardConfigCacheForTest();
    const kv = makeKv();
    await kv.put(`${PREFIX}:chat_post:2026-05-15`, JSON.stringify({ v: 7 }));
    const db = {
      prepare() {
        throw new Error('no such table');
      },
    } as unknown as D1Database;
    const status = await checkBudget(makeDeps({ db, kv }));
    expect(status.current.chatDailyCount).toBe(7);
    expect(status.limit.chatDailyCount).toBe(DEFAULT_LIMITS.chatDailyCount);
    expect(status.config.source).toBe('default');
  });

  it('does not honor stale disabled/pause/raised limits after D1 read failure', async () => {
    resetCostGuardConfigCacheForTest();
    const kv = makeKv();
    await kv.put(`${PREFIX}:chat_post:2026-05-15`, JSON.stringify({ v: 1 }));
    const db = makeCostGuardDb();
    db._config.set('global', {
      enabled: 0,
      paused_until_ms: Date.parse('2026-05-15T13:00:00Z'),
      limits_json: JSON.stringify({ chatDailyCount: 999 }),
      updated_by: 'admin@example.com',
      updated_at_ms: 123,
      change_seq: 4,
    });
    await checkBudget(makeDeps({ db, kv, limits: { chatDailyCount: 1 } }));

    (db as unknown as { prepare: D1Database['prepare'] }).prepare = () => {
      throw new Error('temporary d1 outage');
    };
    const status = await checkBudget(makeDeps({ db, kv, limits: { chatDailyCount: 1 } }));
    expect(status.config.source).toBe('stale');
    expect(status.config.enabled).toBe(true);
    expect(status.config.paused).toBe(false);
    expect(status.limit.chatDailyCount).toBe(1);
    expect(status.exceeded).toEqual(['chatDailyCount']);
  });
});

describe('wrapChatSender', () => {
  function trackingSender(): ChatSender & {
    calls: Array<{ space: string; text: string }>;
  } {
    const calls: Array<{ space: string; text: string }> = [];
    const fn = (async (space: string, text: string) => {
      calls.push({ space, text });
    }) as ChatSender & { calls: typeof calls };
    fn.calls = calls;
    return fn;
  }

  it('delegates to the original sender when under budget and bumps chat_post', async () => {
    const deps = makeDeps({
      operatorSpace: 'spaces/OPS',
      limits: { chatDailyCount: 10, anthropicMonthlyUsd: 100 },
    });
    const sender = trackingSender();
    const wrapped = wrapChatSender(deps, sender);
    await wrapped('spaces/USER', 'hello');
    expect(sender.calls).toEqual([{ space: 'spaces/USER', text: 'hello' }]);
    expect(await readCounter(deps, KIND_CHAT_POST)).toBe(1);
  });

  it('does not bump chat_post if the original sender throws', async () => {
    const deps = makeDeps({
      operatorSpace: 'spaces/OPS',
      limits: { chatDailyCount: 10, anthropicMonthlyUsd: 100 },
    });
    const sender: ChatSender = async () => {
      throw new Error('boom');
    };
    const wrapped = wrapChatSender(deps, sender);
    await expect(wrapped('spaces/USER', 'hello')).rejects.toThrow(/boom/);
    expect(await readCounter(deps, KIND_CHAT_POST)).toBe(0);
  });

  it('skips the original sender when budget is exceeded (chat axis)', async () => {
    const deps = makeDeps({
      operatorSpace: 'spaces/OPS',
      limits: { chatDailyCount: 1, anthropicMonthlyUsd: 100 },
    });
    await incrementCounter(deps, KIND_CHAT_POST, 1); // 上限到達
    const sender = trackingSender();
    const wrapped = wrapChatSender(deps, sender);
    await wrapped('spaces/USER', 'this should be suppressed');
    // user 投稿は no-op、operator への警告のみ届く
    expect(sender.calls.map((c) => c.space)).toEqual(['spaces/OPS']);
    expect(sender.calls[0]!.text).toContain('Cost Guard 予算超過');
    expect(sender.calls[0]!.text).toContain('Chat 投稿 (日次)');
  });

  it('skips the original sender when budget is exceeded (anthropic USD axis)', async () => {
    const deps = makeDeps({
      operatorSpace: 'spaces/OPS',
      limits: { chatDailyCount: 100, anthropicMonthlyUsd: 1.0 },
    });
    await incrementCounter(deps, KIND_ANTHROPIC_COST_USD, 1.5);
    const sender = trackingSender();
    const wrapped = wrapChatSender(deps, sender);
    await wrapped('spaces/USER', 'msg');
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]!.space).toBe('spaces/OPS');
    expect(sender.calls[0]!.text).toContain('Anthropic 月累計');
  });

  it('emits the warning only once per day (KV flag dedupe)', async () => {
    const deps = makeDeps({
      operatorSpace: 'spaces/OPS',
      limits: { chatDailyCount: 1, anthropicMonthlyUsd: 100 },
    });
    await incrementCounter(deps, KIND_CHAT_POST, 1);
    const sender = trackingSender();
    const wrapped = wrapChatSender(deps, sender);
    await wrapped('spaces/USER', 'first attempt');
    await wrapped('spaces/USER', 'second attempt');
    await wrapped('spaces/USER', 'third attempt');
    // operator への警告は 1 回だけ
    expect(sender.calls.filter((c) => c.space === 'spaces/OPS')).toHaveLength(1);
    // user 投稿は一度も呼ばれていない
    expect(sender.calls.filter((c) => c.space === 'spaces/USER')).toHaveLength(0);
  });

  it('skips the warning when operatorSpace is not configured', async () => {
    const deps = makeDeps({
      // operatorSpace undefined
      limits: { chatDailyCount: 1, anthropicMonthlyUsd: 100 },
    });
    await incrementCounter(deps, KIND_CHAT_POST, 1);
    const sender = trackingSender();
    const wrapped = wrapChatSender(deps, sender);
    await wrapped('spaces/USER', 'msg');
    expect(sender.calls).toEqual([]); // 通常投稿も警告投稿も無し
  });

  it('skips the warning when operatorSpace is empty / whitespace', async () => {
    const deps = makeDeps({
      operatorSpace: '   ',
      limits: { chatDailyCount: 1, anthropicMonthlyUsd: 100 },
    });
    await incrementCounter(deps, KIND_CHAT_POST, 1);
    const sender = trackingSender();
    const wrapped = wrapChatSender(deps, sender);
    await wrapped('spaces/USER', 'msg');
    expect(sender.calls).toEqual([]);
  });

  it('bypassGuard=true sends without budget check or chat_post bump', async () => {
    const deps = makeDeps({
      operatorSpace: 'spaces/OPS',
      limits: { chatDailyCount: 1, anthropicMonthlyUsd: 100 },
    });
    await incrementCounter(deps, KIND_CHAT_POST, 5); // 既に超過
    const sender = trackingSender();
    const wrapped = wrapChatSender(deps, sender);
    await wrapped('spaces/OPS', 'urgent', true);
    expect(sender.calls).toEqual([{ space: 'spaces/OPS', text: 'urgent' }]);
    // chat_post カウンタは 5 のまま (bypass は数えない)
    expect(await readCounter(deps, KIND_CHAT_POST)).toBe(5);
  });

  it('warning text does not contain any 危険語句 (makoto-kun-verification §1.1)', async () => {
    const deps = makeDeps({
      operatorSpace: 'spaces/OPS',
      limits: { chatDailyCount: 1, anthropicMonthlyUsd: 100 },
    });
    await incrementCounter(deps, KIND_CHAT_POST, 1);
    const sender = trackingSender();
    const wrapped = wrapChatSender(deps, sender);
    await wrapped('spaces/USER', 'msg');
    const opsText = sender.calls.find((c) => c.space === 'spaces/OPS')!.text;
    const forbidden = [
      '未 attach',
      'attach されていません',
      '参照できず',
      '参照できません',
      '見つかりません',
      '一時的に',
      'memory store',
      'memory が無効',
      'エラーが発生しました',
      '内部エラー',
      'デフォルト値で',
      '仮の値で',
    ];
    for (const phrase of forbidden) {
      expect(opsText.includes(phrase)).toBe(false);
    }
  });

  it('proceeds normally when the warning KV put fails (= flag drop is non-fatal)', async () => {
    const kv = makeKv();
    const deps = makeDeps({
      kv,
      operatorSpace: 'spaces/OPS',
      limits: { chatDailyCount: 1, anthropicMonthlyUsd: 100 },
    });
    await incrementCounter(deps, KIND_CHAT_POST, 1);
    // 警告投稿後の flag put を意図的に失敗させる
    const origPut = kv.put.bind(kv);
    let putCallCount = 0;
    (kv as unknown as { put: typeof kv.put }).put = (async (
      key: string,
      value: string,
      options?: unknown,
    ) => {
      putCallCount++;
      if (key.includes('warning_emitted')) {
        throw new Error('simulated put failure');
      }
      return origPut(key, value, options as Parameters<typeof origPut>[2]);
    }) as typeof kv.put;
    const sender = trackingSender();
    const wrapped = wrapChatSender(deps, sender);
    await expect(wrapped('spaces/USER', 'msg')).resolves.toBeUndefined();
    // operator への警告は届いている
    expect(sender.calls.filter((c) => c.space === 'spaces/OPS')).toHaveLength(1);
    expect(putCallCount).toBeGreaterThan(0);
  });
});

describe('per-session staged approval', () => {
  const sessionConfig = {
    thresholdsUsd: [8, 12, 16],
    stepUsd: 4,
    usdToJpy: 155,
    fallbackModel: 'claude-opus-4-7',
  };

  it('calculates usage USD including cache tokens', () => {
    const usd = usdFromUsage(
      {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 10_000,
          ephemeral_1h_input_tokens: 20_000,
        },
        cache_read_input_tokens: 30_000,
      },
      'claude-sonnet-4-6',
      sessionConfig,
    );
    expect(usd).toBeCloseTo(4.6665, 6);
  });

  it('asks at $8 then allows yes until the $12 stage', async () => {
    const kv = makeKv();
    const threadSessionKey = 'chat_thread_session:user:spaces/A:threads/T';
    const deps = {
      kv,
      now: fixedNow('2026-05-15T12:00:00Z'),
      config: sessionConfig,
    };
    const snapshot = {
      model: 'claude-opus-4-7',
      usage: { input_tokens: 1_600_000, output_tokens: 0 },
    };

    const first = await evaluateSessionCostAfterTurn(deps, {
      threadSessionKey,
      sessionId: 'ses_1',
      snapshot,
    });
    expect(first?.thresholdUsd).toBe(8);
    expect(first?.promptText).toContain('この session の対話を続けますか？');
    expect(first?.promptText).toContain('$12 到達時');

    const yes = await handlePendingSessionApproval(deps, {
      threadSessionKey,
      text: 'はい',
    });
    expect(yes.kind).toBe('reply');
    if (yes.kind === 'reply') {
      expect(yes.closeSession).toBe(false);
      expect(yes.text).toContain('$12');
    }

    const stillUnderNextStage = await evaluateSessionCostAfterTurn(deps, {
      threadSessionKey,
      sessionId: 'ses_1',
      snapshot: {
        model: 'claude-opus-4-7',
        usage: { input_tokens: 2_000_000, output_tokens: 0 },
      },
    });
    expect(stillUnderNextStage).toBeNull();

    const next = await evaluateSessionCostAfterTurn(deps, {
      threadSessionKey,
      sessionId: 'ses_1',
      snapshot: {
        model: 'claude-opus-4-7',
        usage: { input_tokens: 2_400_000, output_tokens: 0 },
      },
    });
    expect(next?.thresholdUsd).toBe(12);
    expect(next?.promptText).toContain('$16 到達時');
  });

  it('projects PDF cost against the current session threshold before sending it to the LLM', async () => {
    const kv = makeKv();
    const threadSessionKey = 'chat_thread_session:user:spaces/A:threads/T';
    await kv.put(threadSessionKey, 'ses_pdf');
    const deps = {
      kv,
      now: fixedNow('2026-05-15T12:00:00Z'),
      config: sessionConfig,
    };
    await evaluateSessionCostAfterTurn(deps, {
      threadSessionKey,
      sessionId: 'ses_pdf',
      snapshot: {
        model: 'claude-opus-4-7',
        usage: { input_tokens: 1_580_000, output_tokens: 0 },
      },
    });

    const projection = await projectSessionCostForPdfPreflight(deps, {
      threadSessionKey,
      totalPages: 12,
      estimatedTokensLow: 74_300,
      estimatedTokensHigh: 98_600,
      estimatedCostLowUsd: 0.3715,
      estimatedCostHighUsd: 0.493,
    });

    expect(projection?.currentSessionUsd).toBeCloseTo(7.9, 6);
    expect(projection?.crossedThresholdUsd).toBe(8);
    expect(projection?.projectedHighUsd).toBeCloseTo(8.393, 6);
    expect(projection?.promptText).toContain('PDF事前確認');
    expect(projection?.promptText).toContain('次の確認ライン: $8');
  });

  it('does not project a PDF prompt when the read stays below the next threshold', async () => {
    const kv = makeKv();
    const threadSessionKey = 'chat_thread_session:user:spaces/A:threads/T';
    await kv.put(threadSessionKey, 'ses_pdf_low');
    const deps = {
      kv,
      now: fixedNow('2026-05-15T12:00:00Z'),
      config: sessionConfig,
    };
    await evaluateSessionCostAfterTurn(deps, {
      threadSessionKey,
      sessionId: 'ses_pdf_low',
      snapshot: {
        model: 'claude-opus-4-7',
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      },
    });

    const projection = await projectSessionCostForPdfPreflight(deps, {
      threadSessionKey,
      totalPages: 2,
      estimatedTokensLow: 54_050,
      estimatedTokensHigh: 58_100,
      estimatedCostLowUsd: 0.27025,
      estimatedCostHighUsd: 0.2905,
    });

    expect(projection?.currentSessionUsd).toBeCloseTo(5, 6);
    expect(projection?.crossedThresholdUsd).toBeNull();
    expect(projection?.nextThresholdUsd).toBe(8);
    expect(projection?.promptText).toBeNull();
  });

  it('does not make one yes unlimited; jumps approve the highest crossed stage only', async () => {
    const kv = makeKv();
    const threadSessionKey = 'chat_thread_session:user:spaces/A:threads/T';
    const deps = { kv, config: sessionConfig };

    const prompt = await evaluateSessionCostAfterTurn(deps, {
      threadSessionKey,
      sessionId: 'ses_jump',
      snapshot: {
        model: 'claude-opus-4-7',
        usage: { input_tokens: 2_600_000, output_tokens: 0 },
      },
    });
    expect(prompt?.thresholdUsd).toBe(12);
    expect(prompt?.nextThresholdUsd).toBe(16);

    await handlePendingSessionApproval(deps, {
      threadSessionKey,
      text: 'はい、続けて',
    });

    const next = await evaluateSessionCostAfterTurn(deps, {
      threadSessionKey,
      sessionId: 'ses_jump',
      snapshot: {
        model: 'claude-opus-4-7',
        usage: { input_tokens: 3_200_000, output_tokens: 0 },
      },
    });
    expect(next?.thresholdUsd).toBe(16);
    expect(next?.nextThresholdUsd).toBe(20);
  });

  it('いいえ clears the thread session binding so another turn starts fresh', async () => {
    const kv = makeKv();
    const threadSessionKey = 'chat_thread_session:user:spaces/A:threads/T';
    await kv.put(threadSessionKey, 'ses_old');
    const deps = { kv, config: sessionConfig };
    await evaluateSessionCostAfterTurn(deps, {
      threadSessionKey,
      sessionId: 'ses_old',
      snapshot: {
        model: 'claude-opus-4-7',
        usage: { input_tokens: 1_600_000, output_tokens: 0 },
      },
    });

    const no = await handlePendingSessionApproval(deps, {
      threadSessionKey,
      text: 'いいえ',
    });
    expect(no.kind).toBe('reply');
    if (no.kind === 'reply') {
      expect(no.closeSession).toBe(true);
    }
    expect(await kv.get(threadSessionKey)).toBeNull();
  });
});
