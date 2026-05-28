/**
 * Unit tests for `src/scheduled/daily-report.ts` — Cloud Run の
 * `scripts/cma_daily_report.py` の TS port が byte 等価で動くことを担保する.
 *
 * 純関数 (storeIdFromEntry / dailyReportPrompt / defaultDateLabel /
 * routeStorePairs) と SDK-driven (`generateDailyReports`) の 2 群に分け、
 * 後者は `Anthropic` SDK 互換の mock を注入する.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  REPORT_ROUTES,
  dailyReportPrompt,
  defaultDateLabel,
  generateDailyReports,
  loadAllUserMappings,
  routeStorePairs,
  storeIdFromEntry,
} from '../src/scheduled/daily-report';
import type { UserMappingValue } from '../src/lib/memory-attach';
import { makeKv } from './helpers';

// ============================================================================
// Pure helpers
// ============================================================================

describe('storeIdFromEntry', () => {
  it('matches by store_name first', () => {
    const entry: UserMappingValue = {
      user_slug: 'alice',
      agent_id: 'agent_x',
      memory_attachments: [
        { memory_store_id: 'memstore_dm_log', access: 'read_write', store_name: 'session_log_dm_store' },
        { memory_store_id: 'memstore_shared_log', access: 'read_write', store_name: 'session_log_shared_store' },
      ],
    };
    expect(storeIdFromEntry(entry, 'session_log_dm_store')).toBe('memstore_dm_log');
    expect(storeIdFromEntry(entry, 'session_log_shared_store')).toBe('memstore_shared_log');
  });

  it('falls back to instructions substring match when store_name missing (legacy mapping)', () => {
    const entry: UserMappingValue = {
      user_slug: 'alice',
      agent_id: 'agent_x',
      memory_attachments: [
        {
          memory_store_id: 'memstore_legacy_dm_log',
          access: 'read_write',
          instructions: 'DM (個人 1:1) のセッションログを記録',
        },
        {
          memory_store_id: 'memstore_legacy_dm_report',
          access: 'read_write',
          instructions: 'DM 軸の日報を保存',
        },
      ],
    };
    expect(storeIdFromEntry(entry, 'session_log_dm_store')).toBe('memstore_legacy_dm_log');
    expect(storeIdFromEntry(entry, 'daily_report_dm_store')).toBe('memstore_legacy_dm_report');
  });

  it('returns null when no candidate matches', () => {
    const entry: UserMappingValue = {
      user_slug: 'alice',
      agent_id: 'agent_x',
      memory_attachments: [
        { memory_store_id: 'memstore_other', access: 'read_only', store_name: 'persona_memory' },
      ],
    };
    expect(storeIdFromEntry(entry, 'session_log_dm_store')).toBeNull();
  });

  it('store_name match takes priority over instructions fallback', () => {
    const entry: UserMappingValue = {
      user_slug: 'alice',
      agent_id: 'agent_x',
      memory_attachments: [
        { memory_store_id: 'fallback_id', access: 'read_write', instructions: 'DM (個人 1:1) のセッションログ' },
        { memory_store_id: 'exact_id', access: 'read_write', store_name: 'session_log_dm_store' },
      ],
    };
    expect(storeIdFromEntry(entry, 'session_log_dm_store')).toBe('exact_id');
  });
});

// ============================================================================
// dailyReportPrompt — byte 等価検証
// ============================================================================

describe('dailyReportPrompt', () => {
  it('produces byte-equivalent prompt to Python _daily_report_prompt', () => {
    const route = REPORT_ROUTES[1]; // shared
    const logs: Array<[string, string]> = [
      ['/2026-05-25/dm-keisuke-seto.md', 'こんにちは'],
      ['/2026-05-25/it-dev.md', 'プロジェクト議論'],
    ];
    const expected =
      '2026-05-25 の 共有スペース日報 を作成してください。\n' +
      '入力ログだけを根拠にし、推測で補完しないでください。\n' +
      '個人DMと共有スペースの内容を混在させないでください。\n' +
      '形式:\n' +
      '# YYYY-MM-DD 日報\n' +
      '## 主な話題\n' +
      '## 決定事項\n' +
      '## 未完了・次アクション\n' +
      '## 注意点\n\n' +
      '## Source: /2026-05-25/dm-keisuke-seto.md\n\n' +
      'こんにちは\n\n' +
      '## Source: /2026-05-25/it-dev.md\n\n' +
      'プロジェクト議論';
    expect(dailyReportPrompt(route, '2026-05-25', logs)).toBe(expected);
  });

  it('filters out empty (whitespace-only) log content (Python `content.strip()`)', () => {
    const route = REPORT_ROUTES[0]; // dm
    const logs: Array<[string, string]> = [
      ['/2026-05-25/a.md', '   \n  '],
      ['/2026-05-25/b.md', '本文あり'],
    ];
    const prompt = dailyReportPrompt(route, '2026-05-25', logs);
    expect(prompt).not.toContain('Source: /2026-05-25/a.md');
    expect(prompt).toContain('## Source: /2026-05-25/b.md\n\n本文あり');
  });

  it('uses the route.title verbatim', () => {
    const dm = dailyReportPrompt(REPORT_ROUTES[0], '2026-05-25', [['/2026-05-25/x.md', 'x']]);
    expect(dm.startsWith('2026-05-25 の DM 日報 を作成してください。\n')).toBe(true);
  });
});

// ============================================================================
// defaultDateLabel
// ============================================================================

describe('defaultDateLabel', () => {
  it('returns the previous JST day before the JST day has ended', () => {
    // 2026-05-26 14:00 UTC = 2026-05-26 23:00 JST → 前日 = 2026-05-25.
    const tick = new Date('2026-05-26T14:00:00.000Z');
    expect(defaultDateLabel(tick)).toBe('2026-05-25');
  });
  it('matches the Cloudflare daily-report cron at 00:30 JST', () => {
    // 2026-05-26 15:30 UTC = 2026-05-27 00:30 JST → 前日 = 2026-05-26.
    const tick = new Date('2026-05-26T15:30:00.000Z');
    expect(defaultDateLabel(tick)).toBe('2026-05-26');
  });
});

// ============================================================================
// routeStorePairs
// ============================================================================

const aliceMapping: UserMappingValue = {
  user_slug: 'alice',
  agent_id: 'agent_a',
  memory_attachments: [
    { memory_store_id: 'memstore_alice_dm_log', access: 'read_write', store_name: 'session_log_dm_store' },
    { memory_store_id: 'memstore_alice_dm_report', access: 'read_write', store_name: 'daily_report_dm_store' },
    { memory_store_id: 'memstore_shared_log', access: 'read_write', store_name: 'session_log_shared_store' },
    { memory_store_id: 'memstore_shared_report', access: 'read_write', store_name: 'daily_report_shared_store' },
  ],
};
const bobMapping: UserMappingValue = {
  user_slug: 'bob',
  agent_id: 'agent_b',
  memory_attachments: [
    { memory_store_id: 'memstore_bob_dm_log', access: 'read_write', store_name: 'session_log_dm_store' },
    { memory_store_id: 'memstore_bob_dm_report', access: 'read_write', store_name: 'daily_report_dm_store' },
    { memory_store_id: 'memstore_shared_log', access: 'read_write', store_name: 'session_log_shared_store' },
    { memory_store_id: 'memstore_shared_report', access: 'read_write', store_name: 'daily_report_shared_store' },
  ],
};

describe('routeStorePairs', () => {
  it('shared route returns one singleton tuple', () => {
    const mapping = new Map<string, UserMappingValue>([
      ['alice@example.com', aliceMapping],
      ['bob@example.com', bobMapping],
    ]);
    const pairs = routeStorePairs(mapping, REPORT_ROUTES[1]); // shared
    expect(pairs).toEqual([['shared', 'memstore_shared_log', 'memstore_shared_report']]);
  });

  it('DM route returns per-user tuples sorted by email', () => {
    const mapping = new Map<string, UserMappingValue>([
      ['bob@example.com', bobMapping],
      ['alice@example.com', aliceMapping],
    ]);
    const pairs = routeStorePairs(mapping, REPORT_ROUTES[0]); // dm
    expect(pairs).toEqual([
      ['alice', 'memstore_alice_dm_log', 'memstore_alice_dm_report'],
      ['bob', 'memstore_bob_dm_log', 'memstore_bob_dm_report'],
    ]);
  });

  it('DM route skips users with incomplete attachment set', () => {
    const incomplete: UserMappingValue = {
      user_slug: 'carol',
      agent_id: 'agent_c',
      memory_attachments: [
        { memory_store_id: 'only_log', access: 'read_write', store_name: 'session_log_dm_store' },
        // daily_report_dm_store missing.
      ],
    };
    const mapping = new Map<string, UserMappingValue>([
      ['alice@example.com', aliceMapping],
      ['carol@example.com', incomplete],
    ]);
    const pairs = routeStorePairs(mapping, REPORT_ROUTES[0]);
    expect(pairs).toEqual([
      ['alice', 'memstore_alice_dm_log', 'memstore_alice_dm_report'],
    ]);
  });

  it('throws when no user-scoped DM pair is found', () => {
    const mapping = new Map<string, UserMappingValue>([
      [
        'alice@example.com',
        {
          user_slug: 'alice',
          agent_id: 'agent_a',
          memory_attachments: [],
        },
      ],
    ]);
    expect(() => routeStorePairs(mapping, REPORT_ROUTES[0])).toThrow(/no user-scoped DM daily-report stores/);
  });
});

// ============================================================================
// loadAllUserMappings — KV paging
// ============================================================================

describe('loadAllUserMappings', () => {
  it('returns an empty map when no entries are present', async () => {
    const kv = makeKv();
    const result = await loadAllUserMappings(kv);
    expect(result.size).toBe(0);
  });

  it('reads all `user_mapping:*` entries', async () => {
    const kv = makeKv();
    await kv.put('user_mapping:alice@example.com', JSON.stringify(aliceMapping));
    await kv.put('user_mapping:bob@example.com', JSON.stringify(bobMapping));
    await kv.put('not_a_mapping:xxx', JSON.stringify({ noise: true }));
    const result = await loadAllUserMappings(kv);
    expect(result.size).toBe(2);
    expect(result.get('alice@example.com')?.user_slug).toBe('alice');
    expect(result.get('bob@example.com')?.user_slug).toBe('bob');
  });
});

// ============================================================================
// generateDailyReports — SDK-driven flow with mock client
// ============================================================================

interface MemoryItem {
  type: 'memory';
  id: string;
  path: string;
  content: string;
}

interface CapturedCall {
  model: string;
  max_tokens: number;
  system: string;
  user_prompt: string;
}

/**
 * In-memory Anthropic SDK shim. Models the surface
 * `generateDailyReports` uses: `beta.memoryStores.memories.{list,
 * retrieve, create, update}` + `messages.create`.
 */
function makeMockClient(
  perStore: Record<string, MemoryItem[]> = {},
  options: {
    summarizeText?: (capture: CapturedCall) => string;
    throwOnMessages?: Set<string>;
  } = {},
) {
  const stores = new Map<string, Map<string, MemoryItem>>();
  for (const [storeId, items] of Object.entries(perStore)) {
    const m = new Map<string, MemoryItem>();
    for (const it of items) m.set(it.path, { ...it });
    stores.set(storeId, m);
  }
  function getStore(storeId: string): Map<string, MemoryItem> {
    let s = stores.get(storeId);
    if (!s) {
      s = new Map();
      stores.set(storeId, s);
    }
    return s;
  }

  const captured: CapturedCall[] = [];
  let nextId = 1;
  const calls = { list: 0, retrieve: 0, create: 0, update: 0, messages: 0 };

  const memories = {
    list(storeId: string) {
      calls.list += 1;
      const snapshot = Array.from(getStore(storeId).values()).map((m) => ({ ...m }));
      return Promise.resolve({
        [Symbol.asyncIterator]: () => {
          let i = 0;
          return {
            next() {
              if (i < snapshot.length) return Promise.resolve({ value: snapshot[i++], done: false });
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      });
    },
    retrieve(memoryId: string, params: { memory_store_id: string }) {
      calls.retrieve += 1;
      const s = getStore(params.memory_store_id);
      for (const m of s.values()) {
        if (m.id === memoryId) return Promise.resolve({ ...m });
      }
      return Promise.reject(new Error(`memory not found: ${memoryId}`));
    },
    create(storeId: string, params: { content: string; path: string }) {
      calls.create += 1;
      const s = getStore(storeId);
      const id = `mem_${nextId++}`;
      const item: MemoryItem = { type: 'memory', id, path: params.path, content: params.content };
      s.set(params.path, item);
      return Promise.resolve({ ...item });
    },
    update(memoryId: string, params: { memory_store_id: string; content?: string | null }) {
      calls.update += 1;
      const s = getStore(params.memory_store_id);
      for (const m of s.values()) {
        if (m.id === memoryId) {
          if (params.content !== undefined && params.content !== null) m.content = params.content;
          return Promise.resolve({ ...m });
        }
      }
      return Promise.reject(new Error(`memory not found: ${memoryId}`));
    },
  };

  const messages = {
    create(params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: string; content: string }>;
    }) {
      calls.messages += 1;
      const userPrompt = params.messages[0]?.content ?? '';
      const capture: CapturedCall = {
        model: params.model,
        max_tokens: params.max_tokens,
        system: params.system,
        user_prompt: userPrompt,
      };
      captured.push(capture);
      if (options.throwOnMessages) {
        for (const needle of options.throwOnMessages) {
          if (userPrompt.includes(needle)) {
            return Promise.reject(new Error('messages.create injected failure'));
          }
        }
      }
      const text = options.summarizeText ? options.summarizeText(capture) : '# 要約\n\nダミー要約本文';
      return Promise.resolve({
        id: `msg_${nextId++}`,
        role: 'assistant',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
      });
    },
  };

  const client = {
    beta: { memoryStores: { memories } },
    messages,
  };
  return { client, stores, captured, calls };
}

const DM_LOG_ALICE = 'memstore_alice_dm_log';
const DM_REPORT_ALICE = 'memstore_alice_dm_report';
const DM_LOG_BOB = 'memstore_bob_dm_log';
const DM_REPORT_BOB = 'memstore_bob_dm_report';
const SHARED_LOG = 'memstore_shared_log';
const SHARED_REPORT = 'memstore_shared_report';

async function seedMapping(kv: ReturnType<typeof makeKv>) {
  await kv.put('user_mapping:alice@example.com', JSON.stringify(aliceMapping));
  await kv.put('user_mapping:bob@example.com', JSON.stringify(bobMapping));
}

describe('generateDailyReports', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('iterates DM per-user + shared singleton in one tick', async () => {
    const kv = makeKv();
    await seedMapping(kv);
    const mock = makeMockClient({
      [DM_LOG_ALICE]: [{ type: 'memory', id: 'mem_a1', path: '/2026-05-25/x.md', content: 'alice log' }],
      [DM_LOG_BOB]: [{ type: 'memory', id: 'mem_b1', path: '/2026-05-25/x.md', content: 'bob log' }],
      [SHARED_LOG]: [{ type: 'memory', id: 'mem_s1', path: '/2026-05-25/x.md', content: 'shared log' }],
    });

    const result = await generateDailyReports({
      kv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: mock.client as any,
      dateLabel: '2026-05-25',
      model: 'claude-haiku-4-5',
      dryRun: false,
    });

    expect(Object.keys(result).sort()).toEqual(['dm:alice', 'dm:bob', 'shared']);
    expect(result['dm:alice'].log_count).toBe(1);
    expect(result['dm:bob'].log_count).toBe(1);
    expect(result['shared'].log_count).toBe(1);
    expect(mock.calls.messages).toBe(3);
    expect(mock.calls.create).toBe(3); // 3 reports written.
  });

  it('emits the empty-log fallback string verbatim when logs are 0 (no LLM call)', async () => {
    const kv = makeKv();
    await seedMapping(kv);
    // No memories in any store → all routes hit logs-empty path.
    const mock = makeMockClient({});

    await generateDailyReports({
      kv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: mock.client as any,
      dateLabel: '2026-05-25',
      model: 'claude-haiku-4-5',
      dryRun: false,
    });

    expect(mock.calls.messages).toBe(0);
    // 3 writes (alice/bob DM + shared) with the empty-log marker.
    expect(mock.calls.create).toBe(3);
    const written = mock.stores.get(DM_REPORT_ALICE)?.get('/2026-05-25.md');
    expect(written?.content).toBe('# 2026-05-25 DM 日報\n\n新着セッションなし。\n');
    const sharedWritten = mock.stores.get(SHARED_REPORT)?.get('/2026-05-25.md');
    expect(sharedWritten?.content).toBe('# 2026-05-25 共有スペース日報\n\n新着セッションなし。\n');
  });

  it('writes the response content[0].text + newline when logs are present', async () => {
    const kv = makeKv();
    await seedMapping(kv);
    const mock = makeMockClient(
      {
        [DM_LOG_ALICE]: [{ type: 'memory', id: 'a1', path: '/2026-05-25/x.md', content: 'alice本文' }],
      },
      { summarizeText: () => '# 2026-05-25 日報\n\n## 主な話題\n- 進捗共有' },
    );
    await generateDailyReports({
      kv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: mock.client as any,
      dateLabel: '2026-05-25',
      model: 'claude-haiku-4-5',
      dryRun: false,
    });
    const written = mock.stores.get(DM_REPORT_ALICE)?.get('/2026-05-25.md');
    // Python: `"".join(chunks).strip() + "\n"`.
    expect(written?.content).toBe('# 2026-05-25 日報\n\n## 主な話題\n- 進捗共有\n');
  });

  it('updates an existing /<date>.md memory in-place', async () => {
    const kv = makeKv();
    await seedMapping(kv);
    const mock = makeMockClient(
      {
        [DM_LOG_ALICE]: [{ type: 'memory', id: 'a1', path: '/2026-05-25/x.md', content: 'log' }],
        [DM_REPORT_ALICE]: [{ type: 'memory', id: 'r1', path: '/2026-05-25.md', content: '旧日報' }],
      },
      { summarizeText: () => '新日報' },
    );
    await generateDailyReports({
      kv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: mock.client as any,
      dateLabel: '2026-05-25',
      model: 'claude-haiku-4-5',
      dryRun: false,
    });
    const written = mock.stores.get(DM_REPORT_ALICE)?.get('/2026-05-25.md');
    expect(written?.id).toBe('r1'); // same id = update path
    expect(written?.content).toBe('新日報\n');
    // alice DM report was updated, bob's was created (no preseed).
    expect(mock.calls.update).toBeGreaterThanOrEqual(1);
  });

  it('passes the byte-equivalent prompt + system prompt to messages.create', async () => {
    const kv = makeKv();
    await seedMapping(kv);
    const mock = makeMockClient({
      [SHARED_LOG]: [{ type: 'memory', id: 's1', path: '/2026-05-25/it-dev.md', content: 'プロジェクト議論' }],
    });
    await generateDailyReports({
      kv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: mock.client as any,
      dateLabel: '2026-05-25',
      model: 'claude-haiku-4-5',
      dryRun: false,
    });
    // The shared-route messages.create call is the one we want to inspect.
    const sharedCapture = mock.captured.find((c) => c.user_prompt.includes('共有スペース日報'));
    expect(sharedCapture).toBeDefined();
    expect(sharedCapture!.model).toBe('claude-haiku-4-5');
    expect(sharedCapture!.max_tokens).toBe(8192);
    expect(sharedCapture!.system).toBe(
      'あなたは MAKOTOくんの日報生成バッチです。' +
        '渡されたセッションログだけを要約し、DM と共有スペースを絶対に混在させません。',
    );
    expect(sharedCapture!.user_prompt).toBe(
      '2026-05-25 の 共有スペース日報 を作成してください。\n' +
        '入力ログだけを根拠にし、推測で補完しないでください。\n' +
        '個人DMと共有スペースの内容を混在させないでください。\n' +
        '形式:\n' +
        '# YYYY-MM-DD 日報\n' +
        '## 主な話題\n' +
        '## 決定事項\n' +
        '## 未完了・次アクション\n' +
        '## 注意点\n\n' +
        '## Source: /2026-05-25/it-dev.md\n\n' +
        'プロジェクト議論',
    );
  });

  it('isolates messages.create failure to one user', async () => {
    const kv = makeKv();
    await seedMapping(kv);
    // Alice messages.create throws (prompt starts with '2026-05-25 の DM');
    // Bob and shared continue to succeed.
    const mock = makeMockClient(
      {
        [DM_LOG_ALICE]: [{ type: 'memory', id: 'a1', path: '/2026-05-25/x.md', content: 'alice本文' }],
        [DM_LOG_BOB]: [{ type: 'memory', id: 'b1', path: '/2026-05-25/x.md', content: 'bob本文' }],
        [SHARED_LOG]: [{ type: 'memory', id: 's1', path: '/2026-05-25/x.md', content: 'shared本文' }],
      },
      {
        // Inject failure only on alice's call by matching her log content.
        throwOnMessages: new Set(['alice本文']),
      },
    );

    const result = await generateDailyReports({
      kv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: mock.client as any,
      dateLabel: '2026-05-25',
      model: 'claude-haiku-4-5',
      dryRun: false,
    });
    expect(result['dm:alice'].error).toMatch(/messages.create injected failure/);
    expect(result['dm:bob'].error).toBeUndefined();
    expect(result['shared'].error).toBeUndefined();
    // Bob + shared still wrote (alice did not).
    expect(mock.calls.create).toBe(2);
  });

  it('does not write when dryRun is true', async () => {
    const kv = makeKv();
    await seedMapping(kv);
    const mock = makeMockClient({
      [DM_LOG_ALICE]: [{ type: 'memory', id: 'a1', path: '/2026-05-25/x.md', content: 'alice本文' }],
    });
    await generateDailyReports({
      kv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: mock.client as any,
      dateLabel: '2026-05-25',
      model: 'claude-haiku-4-5',
      dryRun: true,
    });
    expect(mock.calls.create).toBe(0);
    expect(mock.calls.update).toBe(0);
    // LLM still ran (we only skip the write).
    expect(mock.calls.messages).toBeGreaterThan(0);
  });
});
