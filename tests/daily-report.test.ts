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
      'ツールは使わず、Memory Store やファイルへの書き込みも行わず、日報本文だけを返してください。\n' +
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
    expect(pairs).toEqual([{
      label: 'shared',
      sourceStoreId: 'memstore_shared_log',
      targetStoreId: 'memstore_shared_report',
      agentId: 'agent_a',
    }]);
  });

  it('DM route returns per-user tuples sorted by email', () => {
    const mapping = new Map<string, UserMappingValue>([
      ['bob@example.com', bobMapping],
      ['alice@example.com', aliceMapping],
    ]);
    const pairs = routeStorePairs(mapping, REPORT_ROUTES[0]); // dm
    expect(pairs).toEqual([
      {
        label: 'alice',
        sourceStoreId: 'memstore_alice_dm_log',
        targetStoreId: 'memstore_alice_dm_report',
        agentId: 'agent_a',
      },
      {
        label: 'bob',
        sourceStoreId: 'memstore_bob_dm_log',
        targetStoreId: 'memstore_bob_dm_report',
        agentId: 'agent_b',
      },
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
      {
        label: 'alice',
        sourceStoreId: 'memstore_alice_dm_log',
        targetStoreId: 'memstore_alice_dm_report',
        agentId: 'agent_a',
      },
    ]);
  });

  it('uses known active employee agent fallback for legacy mappings', () => {
    const legacySeto: UserMappingValue = {
      ...aliceMapping,
      user_slug: 'k-seto',
      agent_id: '',
    };
    const mapping = new Map<string, UserMappingValue>([
      ['k.seto@makotoprime.com', legacySeto],
    ]);
    const pairs = routeStorePairs(mapping, REPORT_ROUTES[0]);
    expect(pairs[0]?.agentId).toBe('agent_015g2g4SKACdzaPyQ8QiSi2o');
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
  agent_id: string;
  environment_id: string;
  user_prompt: string;
}

/**
 * In-memory Anthropic SDK shim. Models the surface
 * `generateDailyReports` uses: `beta.memoryStores.memories.{list,
 * retrieve, create, update}` + `beta.sessions.{create,events.send,events.stream}`.
 */
function makeMockClient(
  perStore: Record<string, MemoryItem[]> = {},
  options: {
    summarizeText?: (capture: CapturedCall) => string;
    throwOnMessages?: Set<string>;
    emitToolUse?: boolean;
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
  const calls = { list: 0, retrieve: 0, create: 0, update: 0, sessions: 0 };

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

  const sessionPrompts = new Map<string, string>();
  const sessionCaptures = new Map<string, CapturedCall>();

  function asyncEvents(items: Array<Record<string, unknown>>) {
    return {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          next() {
            if (i < items.length) return Promise.resolve({ value: items[i++], done: false });
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  const sessions = {
    create(params: { agent: string; environment_id: string }) {
      calls.sessions += 1;
      const id = `ses_${nextId++}`;
      sessionCaptures.set(id, {
        agent_id: params.agent,
        environment_id: params.environment_id,
        user_prompt: '',
      });
      return Promise.resolve({ id });
    },
    events: {
      send(sessionId: string, params: { events: Array<{ content: Array<{ text?: string }> }> }) {
        const prompt = params.events[0]?.content?.map((b) => b.text ?? '').join('') ?? '';
        sessionPrompts.set(sessionId, prompt);
        const cap = sessionCaptures.get(sessionId);
        if (cap) cap.user_prompt = prompt;
        return Promise.resolve({});
      },
      stream(sessionId: string) {
        const prompt = sessionPrompts.get(sessionId) ?? '';
        if (options.throwOnMessages) {
          for (const needle of options.throwOnMessages) {
            if (prompt.includes(needle)) {
              return Promise.reject(new Error('session stream injected failure'));
            }
          }
        }
        const cap = sessionCaptures.get(sessionId)!;
        captured.push(cap);
        const text = options.summarizeText ? options.summarizeText(cap) : '# 要約\n\nダミー要約本文';
        const events: Array<Record<string, unknown>> = [];
        if (options.emitToolUse) events.push({ type: 'agent.tool_use', name: 'bash' });
        events.push(
          { type: 'agent.text_delta', delta: text },
          { type: 'session.status_idle' },
        );
        return Promise.resolve(asyncEvents(events));
      },
    },
  };

  const client = {
    beta: { memoryStores: { memories }, sessions },
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
      environmentId: 'env_test',
      dryRun: false,
    });

    expect(Object.keys(result).sort()).toEqual(['dm:alice', 'dm:bob', 'shared']);
    expect(result['dm:alice'].log_count).toBe(1);
    expect(result['dm:bob'].log_count).toBe(1);
    expect(result['shared'].log_count).toBe(1);
    expect(result['dm:alice'].session_id).toBeDefined();
    expect(result['dm:bob'].session_id).toBeDefined();
    expect(result['shared'].session_id).toBeDefined();
    expect(result['dm:alice'].tool_use_count).toBe(0);
    expect(mock.calls.sessions).toBe(3);
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
      environmentId: 'env_test',
      dryRun: false,
    });

    expect(mock.calls.sessions).toBe(0);
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
      environmentId: 'env_test',
      dryRun: false,
    });
    const written = mock.stores.get(DM_REPORT_ALICE)?.get('/2026-05-25.md');
    // Python: `"".join(chunks).strip() + "\n"`.
    expect(written?.content).toBe('# 2026-05-25 日報\n\n## 主な話題\n- 進捗共有\n');
  });

  it('forbids managed session tool use and does not write that route', async () => {
    const kv = makeKv();
    await seedMapping(kv);
    const mock = makeMockClient(
      {
        [DM_LOG_ALICE]: [{ type: 'memory', id: 'a1', path: '/2026-05-25/x.md', content: 'alice本文' }],
      },
      { emitToolUse: true },
    );

    const result = await generateDailyReports({
      kv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: mock.client as any,
      dateLabel: '2026-05-25',
      model: 'claude-haiku-4-5',
      environmentId: 'env_test',
      dryRun: false,
    });

    expect(result['dm:alice'].session_id).toMatch(/^ses_/);
    expect(result['dm:alice'].error).toMatch(/tool use forbidden/);
    expect(result['dm:alice'].tool_use_count).toBe(0);
    expect(mock.stores.get(DM_REPORT_ALICE)?.get('/2026-05-25.md')).toBeUndefined();
  });

  it('requires explicit or known mapping agent_id even when logs are empty', async () => {
    const kv = makeKv();
    const noAgent: UserMappingValue = {
      ...aliceMapping,
      agent_id: '',
    };
    await kv.put('user_mapping:alice@example.com', JSON.stringify(noAgent));
    const mock = makeMockClient({});

    const result = await generateDailyReports({
      kv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: mock.client as any,
      dateLabel: '2026-05-25',
      model: 'claude-haiku-4-5',
      environmentId: 'env_test',
      dryRun: false,
    });

    expect(result['dm:alice'].error).toMatch(/daily-report agent_id missing/);
    expect(result['shared'].error).toMatch(/daily-report agent_id missing/);
    expect(mock.calls.sessions).toBe(0);
    expect(mock.calls.create).toBe(0);
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
      environmentId: 'env_test',
      dryRun: false,
    });
    const written = mock.stores.get(DM_REPORT_ALICE)?.get('/2026-05-25.md');
    expect(written?.id).toBe('r1'); // same id = update path
    expect(written?.content).toBe('新日報\n');
    // alice DM report was updated, bob's was created (no preseed).
    expect(mock.calls.update).toBeGreaterThanOrEqual(1);
  });

  it('passes the byte-equivalent prompt to the mapped managed agent', async () => {
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
      environmentId: 'env_test',
      dryRun: false,
    });
    // The shared-route managed session call is the one we want to inspect.
    const sharedCapture = mock.captured.find((c) => c.user_prompt.includes('共有スペース日報'));
    expect(sharedCapture).toBeDefined();
    expect(sharedCapture!.agent_id).toBe('agent_a');
    expect(sharedCapture!.environment_id).toBe('env_test');
    expect(sharedCapture!.user_prompt).toBe(
        '2026-05-25 の 共有スペース日報 を作成してください。\n' +
        '入力ログだけを根拠にし、推測で補完しないでください。\n' +
        '個人DMと共有スペースの内容を混在させないでください。\n' +
        'ツールは使わず、Memory Store やファイルへの書き込みも行わず、日報本文だけを返してください。\n' +
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

  it('isolates managed session failure to one user', async () => {
    const kv = makeKv();
    await seedMapping(kv);
    // Alice session stream throws (prompt starts with '2026-05-25 の DM');
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
      environmentId: 'env_test',
      dryRun: false,
    });
    expect(result['dm:alice'].error).toMatch(/session stream injected failure/);
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
      environmentId: 'env_test',
      dryRun: true,
    });
    expect(mock.calls.create).toBe(0);
    expect(mock.calls.update).toBe(0);
    // LLM still ran (we only skip the write).
    expect(mock.calls.sessions).toBeGreaterThan(0);
  });
});
