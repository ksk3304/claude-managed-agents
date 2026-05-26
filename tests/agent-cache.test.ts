/**
 * Unit tests for `src/lib/agent-cache.ts` — Cloud Run の
 * `cma_lib.py:_load_agent_cache / _save_agent_cache_entry /
 * get_or_create_resources` (Issue #184) と等価動作を D1 + KV で確認する。
 *
 * テスト 5 ケース (タスク完了条件):
 *   1. cache hit (D1 既存 entry)
 *   2. cache miss → 新規作成 → 両層書込み
 *   3. D1 unavailable → KV fallback で読書きが成立
 *   4. 並行 read (同じ key を 2 回 load してどちらも同 entry を返す)
 *   5. overwrite (既存 entry を recreate=true で上書き)
 */

import { describe, it, expect } from 'vitest';
import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import {
  buildCacheKey,
  getOrCreateResources,
  loadAgentCache,
  saveAgentCacheEntry,
  skillsHash,
  toolsHash,
  type AgentCacheBindings,
  type AgentCacheLogger,
  type CreateResourcesFn,
} from '../src/lib/agent-cache';

// ---------------------------------------------------------------------------
// 軽量 fake D1: agent_cache 1 table 専用 (makoto-helpers.ts を汚さないため
// テスト localスコープ)。SELECT / INSERT OR REPLACE の 2 種類だけ実装する。
// ---------------------------------------------------------------------------

interface FakeAgentCacheRow {
  cache_key: string;
  user_slug: string;
  agent_id: string;
  environment_id: string;
  memory_store_id: string | null;
  tools_hash: string;
  skills_hash: string;
  updated_at_ms: number;
}

interface FakeAgentCacheDb extends D1Database {
  _rows: Map<string, FakeAgentCacheRow>;
  _calls: Array<{ sql: string; params: unknown[] }>;
}

function makeAgentCacheDb(options: { failOnAll?: boolean } = {}): FakeAgentCacheDb {
  const rows = new Map<string, FakeAgentCacheRow>();
  const calls: Array<{ sql: string; params: unknown[] }> = [];

  function exec(
    sql: string,
    params: unknown[],
  ): { results: FakeAgentCacheRow[]; meta?: { changes: number } } {
    if (options.failOnAll) {
      throw new Error('fake-d1: simulated D1 outage');
    }
    calls.push({ sql, params });
    const trimmed = sql.replace(/\s+/g, ' ').trim();

    if (
      /^SELECT agent_id, environment_id, memory_store_id, tools_hash, skills_hash FROM agent_cache WHERE cache_key = \?$/i.test(
        trimmed,
      )
    ) {
      const [key] = params as [string];
      const row = rows.get(key);
      return { results: row ? [row] : [] };
    }

    if (
      /^INSERT OR REPLACE INTO agent_cache \(cache_key, user_slug, agent_id, environment_id, memory_store_id, tools_hash, skills_hash, updated_at_ms\) VALUES \(\?1, \?2, \?3, \?4, \?5, \?6, \?7, \?8\)$/i.test(
        trimmed,
      )
    ) {
      const [
        cache_key,
        user_slug,
        agent_id,
        environment_id,
        memory_store_id,
        th,
        sh,
        updated_at_ms,
      ] = params as [
        string,
        string,
        string,
        string,
        string | null,
        string,
        string,
        number,
      ];
      rows.set(cache_key, {
        cache_key,
        user_slug,
        agent_id,
        environment_id,
        memory_store_id,
        tools_hash: th,
        skills_hash: sh,
        updated_at_ms,
      });
      return { results: [], meta: { changes: 1 } };
    }

    throw new Error(`fake-agent-cache-db: unrecognised SQL: ${trimmed}`);
  }

  const db = {
    prepare(sql: string) {
      const params: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          params.push(...args);
          return stmt;
        },
        async run() {
          return exec(sql, params);
        },
        async all<T>() {
          return exec(sql, params) as { results: T[] };
        },
        async first<T>() {
          const r = exec(sql, params);
          return (r.results[0] as T) ?? null;
        },
      };
      return stmt;
    },
    _rows: rows,
    _calls: calls,
  } as unknown as FakeAgentCacheDb;
  return db;
}

// ---------------------------------------------------------------------------
// 軽量 fake KV
// ---------------------------------------------------------------------------

function makeFakeKv(): KVNamespace & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    async get(key: string, _type?: 'text' | 'json') {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> };
  return kv;
}

// ---------------------------------------------------------------------------
// silent logger (テストでログ計数する用)
// ---------------------------------------------------------------------------

function makeLogger(): AgentCacheLogger & {
  warns: Array<[string, Record<string, unknown>]>;
  infos: Array<[string, Record<string, unknown>]>;
} {
  const warns: Array<[string, Record<string, unknown>]> = [];
  const infos: Array<[string, Record<string, unknown>]> = [];
  return {
    warns,
    infos,
    warn(event, fields) {
      warns.push([event, fields]);
    },
    info(event, fields) {
      infos.push([event, fields]);
    },
  };
}

// ---------------------------------------------------------------------------
// hash + cache key invariants — Python `_tools_hash` / `_skills_hash` と
// 同等の 8 文字 hex + skills=null は `'none'` を返すこと。
// ---------------------------------------------------------------------------

describe('toolsHash + skillsHash', () => {
  it('toolsHash returns 8 hex chars deterministically', async () => {
    const a = await toolsHash([{ type: 'agent_toolset_20260401' }]);
    const b = await toolsHash([{ type: 'agent_toolset_20260401' }]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it('toolsHash is sort-key stable (key order does not change hash)', async () => {
    const a = await toolsHash([{ type: 'x', name: 'a' }]);
    const b = await toolsHash([{ name: 'a', type: 'x' }]);
    expect(a).toBe(b);
  });

  it('skillsHash returns "none" for null / empty', async () => {
    expect(await skillsHash(null)).toBe('none');
    expect(await skillsHash(undefined)).toBe('none');
    expect(await skillsHash([])).toBe('none');
  });

  it('skillsHash returns 8 hex for non-empty', async () => {
    const h = await skillsHash([{ type: 'custom', skill_id: 'sk_xxx', version: '1' }]);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(h).not.toBe('none');
  });

  it('buildCacheKey matches Python format', () => {
    const k = buildCacheKey({
      agentName: 'lifelog-cma-default',
      environmentName: 'lifelog-cma-default',
      toolsHash: 'abcdef01',
      skillsHash: 'none',
    });
    expect(k).toBe('lifelog-cma-default::lifelog-cma-default::tools-abcdef01::skills-none');
  });
});

// ---------------------------------------------------------------------------
// 1. cache hit (D1)
// ---------------------------------------------------------------------------

describe('case 1: cache hit (D1)', () => {
  it('loadAgentCache returns entry from D1 with source="d1"', async () => {
    const db = makeAgentCacheDb();
    const kv = makeFakeKv();
    const env: AgentCacheBindings = { DB: db, MAKOTO_KV: kv };

    const cacheKey = 'lifelog-cma-default::lifelog-cma-default::tools-aaa11111::skills-none';
    await saveAgentCacheEntry(env, cacheKey, {
      agent_id: 'agent_existing',
      environment_id: 'env_existing',
      tools_hash: 'aaa11111',
      skills_hash: 'none',
    });

    const logger = makeLogger();
    const r = await loadAgentCache(env, cacheKey, logger);
    expect(r.source).toBe('d1');
    expect(r.entry?.agent_id).toBe('agent_existing');
    expect(r.entry?.environment_id).toBe('env_existing');
    expect(logger.warns).toHaveLength(0);
  });

  it('getOrCreateResources hits cache and does NOT call createFn', async () => {
    const db = makeAgentCacheDb();
    const kv = makeFakeKv();
    const env: AgentCacheBindings = { DB: db, MAKOTO_KV: kv };

    // pre-populate (こちらは getOrCreateResources 経由で createFn を呼ぶ
    // 形式の代わりに、saveAgentCacheEntry で直接 seed する)。
    const th = await toolsHash([{ type: 'agent_toolset_20260401' }]);
    const sh = await skillsHash(null);
    const cacheKey = buildCacheKey({
      agentName: 'lifelog-cma-default',
      environmentName: 'lifelog-cma-default',
      toolsHash: th,
      skillsHash: sh,
    });
    await saveAgentCacheEntry(env, cacheKey, {
      agent_id: 'agent_preseed',
      environment_id: 'env_preseed',
      tools_hash: th,
      skills_hash: sh,
    });

    let createCalls = 0;
    const createFn: CreateResourcesFn = async () => {
      createCalls += 1;
      return { agent_id: 'agent_should_not_be_used', environment_id: 'env_should_not_be_used' };
    };

    const res = await getOrCreateResources(env, createFn, { logger: makeLogger() });
    expect(createCalls).toBe(0);
    expect(res.agent_id).toBe('agent_preseed');
    expect(res.environment_id).toBe('env_preseed');
    expect(res.source).toBe('d1');
  });
});

// ---------------------------------------------------------------------------
// 2. cache miss → createFn 呼出 → 両層書込み
// ---------------------------------------------------------------------------

describe('case 2: cache miss → create', () => {
  it('getOrCreateResources calls createFn once and persists to both D1 and KV', async () => {
    const db = makeAgentCacheDb();
    const kv = makeFakeKv();
    const env: AgentCacheBindings = { DB: db, MAKOTO_KV: kv };

    let createCalls = 0;
    const createFn: CreateResourcesFn = async (opts) => {
      createCalls += 1;
      expect(opts.agentName).toBe('lifelog-cma-default');
      expect(opts.model).toBe('claude-sonnet-4-6');
      return { agent_id: 'agent_new_xyz', environment_id: 'env_new_xyz' };
    };

    const logger = makeLogger();
    const res = await getOrCreateResources(env, createFn, { logger });
    expect(createCalls).toBe(1);
    expect(res.agent_id).toBe('agent_new_xyz');
    expect(res.source).toBe('created');

    // D1 / KV 両層に persisted
    const th = await toolsHash([{ type: 'agent_toolset_20260401' }]);
    const sh = await skillsHash(null);
    const cacheKey = buildCacheKey({
      agentName: 'lifelog-cma-default',
      environmentName: 'lifelog-cma-default',
      toolsHash: th,
      skillsHash: sh,
    });
    expect(db._rows.get(cacheKey)?.agent_id).toBe('agent_new_xyz');
    expect(kv._store.get(`agent_cache:${cacheKey}`)).toContain('agent_new_xyz');

    // info log to confirm written_backends
    const createdLog = logger.infos.find(([ev]) => ev === 'agent_cache_created');
    expect(createdLog).toBeDefined();
    expect(createdLog?.[1].written_backends).toEqual(['d1', 'kv']);
  });
});

// ---------------------------------------------------------------------------
// 3. D1 unavailable → KV fallback
// ---------------------------------------------------------------------------

describe('case 3: D1 unavailable → KV fallback', () => {
  it('saveAgentCacheEntry falls back to KV only when D1 throws', async () => {
    const db = makeAgentCacheDb({ failOnAll: true });
    const kv = makeFakeKv();
    const env: AgentCacheBindings = { DB: db, MAKOTO_KV: kv };

    const logger = makeLogger();
    const written = await saveAgentCacheEntry(
      env,
      'cache::key',
      {
        agent_id: 'agent_kv_only',
        environment_id: 'env_kv_only',
        tools_hash: 'aaaa1111',
        skills_hash: 'none',
      },
      { logger },
    );
    expect(written).toEqual(['kv']);
    expect(kv._store.get('agent_cache:cache::key')).toContain('agent_kv_only');
    expect(logger.warns.some(([ev]) => ev === 'agent_cache_save_d1_failed')).toBe(true);
  });

  it('loadAgentCache reads from KV when D1 throws', async () => {
    const db = makeAgentCacheDb({ failOnAll: true });
    const kv = makeFakeKv();
    const env: AgentCacheBindings = { DB: db, MAKOTO_KV: kv };

    await kv.put(
      'agent_cache:cache::key',
      JSON.stringify({
        agent_id: 'agent_kv_seed',
        environment_id: 'env_kv_seed',
        tools_hash: 'aaaa1111',
        skills_hash: 'none',
      }),
    );

    const logger = makeLogger();
    const r = await loadAgentCache(env, 'cache::key', logger);
    expect(r.source).toBe('kv');
    expect(r.entry?.agent_id).toBe('agent_kv_seed');
    expect(logger.warns.some(([ev]) => ev === 'agent_cache_load_d1_failed')).toBe(true);
  });

  it('getOrCreateResources still creates + persists to KV alone when D1 is dead', async () => {
    const db = makeAgentCacheDb({ failOnAll: true });
    const kv = makeFakeKv();
    const env: AgentCacheBindings = { DB: db, MAKOTO_KV: kv };

    let createCalls = 0;
    const createFn: CreateResourcesFn = async () => {
      createCalls += 1;
      return { agent_id: 'agent_in_kv', environment_id: 'env_in_kv' };
    };

    const logger = makeLogger();
    const res = await getOrCreateResources(env, createFn, { logger });
    expect(createCalls).toBe(1);
    expect(res.agent_id).toBe('agent_in_kv');
    expect(res.source).toBe('created');

    const th = await toolsHash([{ type: 'agent_toolset_20260401' }]);
    const sh = await skillsHash(null);
    const cacheKey = buildCacheKey({
      agentName: 'lifelog-cma-default',
      environmentName: 'lifelog-cma-default',
      toolsHash: th,
      skillsHash: sh,
    });
    expect(kv._store.get(`agent_cache:${cacheKey}`)).toContain('agent_in_kv');
  });
});

// ---------------------------------------------------------------------------
// 4. 並行 read — 同じ key を 2 回 load して両方同じ entry を返す
// ---------------------------------------------------------------------------

describe('case 4: 並行 read', () => {
  it('concurrent loadAgentCache returns identical entry from D1', async () => {
    const db = makeAgentCacheDb();
    const kv = makeFakeKv();
    const env: AgentCacheBindings = { DB: db, MAKOTO_KV: kv };
    const cacheKey = 'concurrent::key';
    await saveAgentCacheEntry(env, cacheKey, {
      agent_id: 'agent_concurrent',
      environment_id: 'env_concurrent',
      tools_hash: 'bbbb2222',
      skills_hash: 'none',
    });

    const [r1, r2] = await Promise.all([
      loadAgentCache(env, cacheKey),
      loadAgentCache(env, cacheKey),
    ]);
    expect(r1.entry?.agent_id).toBe('agent_concurrent');
    expect(r2.entry?.agent_id).toBe('agent_concurrent');
    expect(r1.source).toBe('d1');
    expect(r2.source).toBe('d1');
  });

  it('concurrent getOrCreateResources on cached key never calls createFn', async () => {
    const db = makeAgentCacheDb();
    const kv = makeFakeKv();
    const env: AgentCacheBindings = { DB: db, MAKOTO_KV: kv };

    const th = await toolsHash([{ type: 'agent_toolset_20260401' }]);
    const sh = await skillsHash(null);
    const cacheKey = buildCacheKey({
      agentName: 'lifelog-cma-default',
      environmentName: 'lifelog-cma-default',
      toolsHash: th,
      skillsHash: sh,
    });
    await saveAgentCacheEntry(env, cacheKey, {
      agent_id: 'agent_warm',
      environment_id: 'env_warm',
      tools_hash: th,
      skills_hash: sh,
    });

    let createCalls = 0;
    const createFn: CreateResourcesFn = async () => {
      createCalls += 1;
      return { agent_id: 'should_not_create', environment_id: 'should_not_create' };
    };

    const results = await Promise.all([
      getOrCreateResources(env, createFn, { logger: makeLogger() }),
      getOrCreateResources(env, createFn, { logger: makeLogger() }),
      getOrCreateResources(env, createFn, { logger: makeLogger() }),
    ]);
    expect(createCalls).toBe(0);
    for (const r of results) {
      expect(r.agent_id).toBe('agent_warm');
      expect(r.source).toBe('d1');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. overwrite — recreate=true で既存 entry を上書き
// ---------------------------------------------------------------------------

describe('case 5: overwrite', () => {
  it('saveAgentCacheEntry INSERT OR REPLACE overrides existing row', async () => {
    const db = makeAgentCacheDb();
    const kv = makeFakeKv();
    const env: AgentCacheBindings = { DB: db, MAKOTO_KV: kv };

    await saveAgentCacheEntry(env, 'overwrite::key', {
      agent_id: 'agent_v1',
      environment_id: 'env_v1',
      tools_hash: 'cccc3333',
      skills_hash: 'none',
    });
    await saveAgentCacheEntry(env, 'overwrite::key', {
      agent_id: 'agent_v2',
      environment_id: 'env_v2',
      tools_hash: 'cccc3333',
      skills_hash: 'none',
    });

    const r = await loadAgentCache(env, 'overwrite::key');
    expect(r.entry?.agent_id).toBe('agent_v2');
    expect(r.entry?.environment_id).toBe('env_v2');
    // D1 row 1 件のみ (INSERT OR REPLACE = 上書き、複数行残らない)
    expect(db._rows.size).toBe(1);
  });

  it('getOrCreateResources with recreate=true bypasses cache and overwrites', async () => {
    const db = makeAgentCacheDb();
    const kv = makeFakeKv();
    const env: AgentCacheBindings = { DB: db, MAKOTO_KV: kv };

    const th = await toolsHash([{ type: 'agent_toolset_20260401' }]);
    const sh = await skillsHash(null);
    const cacheKey = buildCacheKey({
      agentName: 'lifelog-cma-default',
      environmentName: 'lifelog-cma-default',
      toolsHash: th,
      skillsHash: sh,
    });
    await saveAgentCacheEntry(env, cacheKey, {
      agent_id: 'agent_old',
      environment_id: 'env_old',
      tools_hash: th,
      skills_hash: sh,
    });

    let createCalls = 0;
    const createFn: CreateResourcesFn = async () => {
      createCalls += 1;
      return { agent_id: 'agent_recreated', environment_id: 'env_recreated' };
    };

    const res = await getOrCreateResources(env, createFn, {
      recreate: true,
      logger: makeLogger(),
    });
    expect(createCalls).toBe(1);
    expect(res.agent_id).toBe('agent_recreated');
    expect(res.source).toBe('created');

    // cache が上書きされていること
    const after = await loadAgentCache(env, cacheKey);
    expect(after.entry?.agent_id).toBe('agent_recreated');
  });
});
