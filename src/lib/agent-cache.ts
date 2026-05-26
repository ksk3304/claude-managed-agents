/**
 * Agent cache — Cloud Run の `scripts/cma_lib.py:_load_agent_cache` (l.379) /
 * `_save_agent_cache_entry` (l.409) / `get_or_create_resources` (l.511) の
 * Cloudflare Worker (TS) port。
 *
 * 目的: Anthropic agent_id / environment_id を永続化し、Worker cold start /
 *       multi-instance fan-out で重複 `agents.create` が走らないようにする。
 *       Python 側 (Issue #184) は Firestore document `cma_agent_cache/
 *       lifelog-cma` に書いているが、CF Worker 環境では Firestore が使えない
 *       ため D1 (Cloudflare の SQLite) を一次層、KV を fallback 層として
 *       採用する (= agent rotate / 新規 user bootstrap でも auto-create +
 *       永続化が成立する)。
 *
 * 層の順序:
 *   1. D1 (`agent_cache` table — migrations/0005_agent_cache.sql)
 *      → 構造化された行 single-source-of-truth、worker instance を跨いで共有
 *   2. D1 失敗時 → KV (`agent_cache:<key>`) に縮退
 *      → D1 メンテ / unavailable 時も bot が落ちず動き続けるため
 *
 * 各層で例外が出た場合は WARN ログを残して次層へ落ちる (Python 側
 * `_firestore_fallback_exc_types` と同じ「障害 = fallback / データエラー =
 * raise」思想)。両方 unavailable なら呼出側に投げ返す (= 新規作成は
 * 続行できるが、cache が効かないので注意ログを残す)。
 *
 * cache key 形式 (Python と完全一致 — Issue #1149 で tools_hash、Issue #100
 * で skills_hash を加味、構成変更で自動 invalidate される):
 *   `${agentName}::${environmentName}::tools-${toolsHash}::skills-${skillsHash}`
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 L)
 * Source:
 *   scripts/cma_lib.py l.305-359  (_load_cache / _resolve_agent_cache_backend)
 *   scripts/cma_lib.py l.379-445  (_load_agent_cache / _save_agent_cache_entry)
 *   scripts/cma_lib.py l.482-595  (_tools_hash / _skills_hash / get_or_create_resources)
 */

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** KV fallback key prefix。`agent_cache:<cache_key>` に JSON で保存。 */
const KV_PREFIX = 'agent_cache:';

/**
 * default tools (Python `_DEFAULT_TOOLS = [{"type": "agent_toolset_20260401"}]`
 * と同形)。`tools` 引数未指定の getOrCreateResources 呼出で使われる。
 */
export const DEFAULT_TOOLS: Array<Record<string, unknown>> = [
  { type: 'agent_toolset_20260401' },
];

/**
 * default system prompt — Python `DEFAULT_SYSTEM_PROMPT` (cma_lib.py l.450)
 * と一致しない縮約版 (CF 側 spec bundle で system prompt は別注入される
 * 設計のため)。明示指定推奨。
 */
export const DEFAULT_SYSTEM_PROMPT = '';

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** cache に保存される 1 entry の構造。Python `new_entry` と同形 + memory_store_id。 */
export interface AgentCacheEntry {
  agent_id: string;
  environment_id: string;
  memory_store_id?: string | null;
  tools_hash: string;
  skills_hash: string;
}

/** cache 取得結果。`source` で実際に値を返した backend を可視化する (Python と同思想)。 */
export interface AgentCacheLoadResult {
  entry: AgentCacheEntry | null;
  source: 'd1' | 'kv' | 'none';
}

/** ログ出力先 (テストでキャプチャ可能にする)。 */
export interface AgentCacheLogger {
  warn(event: string, fields: Record<string, unknown>): void;
  info(event: string, fields: Record<string, unknown>): void;
}

/** 既定 logger — `console.warn` / `console.info` に JSON 1 行で出す (cap-recovery.ts と同形)。 */
export const defaultAgentCacheLogger: AgentCacheLogger = {
  warn(event, fields) {
    console.warn(JSON.stringify({ event, level: 'WARN', ...fields }));
  },
  info(event, fields) {
    console.info(JSON.stringify({ event, level: 'INFO', ...fields }));
  },
};

/** D1 / KV を渡すための env 縮約 (Worker env から必要分だけ抽出)。 */
export interface AgentCacheBindings {
  /** D1 primary 層。null / undefined 許容 = test 環境で D1 不在ケースを再現できる。 */
  DB?: D1Database;
  /** KV fallback 層。null / undefined 許容 = 同上。 */
  MAKOTO_KV?: KVNamespace;
}

// ---------------------------------------------------------------------------
// hash helpers — Python `_tools_hash` / `_skills_hash` の TS port
// ---------------------------------------------------------------------------

/**
 * tools 定義 (agent.create に渡す list[dict]) を 8 文字 hex hash 化する。
 * Python `_tools_hash` (cma_lib.py l.482) と同等。
 *
 * 決定性: JSON.stringify はキー順を保証しないため、key を sorted で stringify
 *         する。Python `json.dumps(tools, sort_keys=True, ensure_ascii=False)`
 *         と同じ byte 列を作る (← 同じ hash になることが invariant)。
 */
export async function toolsHash(
  tools: Array<Record<string, unknown>>,
): Promise<string> {
  return sha256Hex8(stringifySorted(tools));
}

/**
 * skills 定義を 8 文字 hex hash 化する。null / 空配列 → `'none'`。
 * Python `_skills_hash` (cma_lib.py l.494) と同等。
 *
 * `'none'` 戻し: skills 未付与 rollback 時に cache key が変化して
 * skill なし agent が自動再作成されるため (Python 同実装、Issue #100 MF1)。
 */
export async function skillsHash(
  skills: Array<Record<string, unknown>> | null | undefined,
): Promise<string> {
  if (!skills || skills.length === 0) return 'none';
  return sha256Hex8(stringifySorted(skills));
}

/**
 * cache key を組み立てる (`${agent}::${env}::tools-${th}::skills-${sh}`)。
 * Python `get_or_create_resources` 中の key 構築 (l.548) と同形。
 */
export function buildCacheKey(params: {
  agentName: string;
  environmentName: string;
  toolsHash: string;
  skillsHash: string;
}): string {
  return `${params.agentName}::${params.environmentName}::tools-${params.toolsHash}::skills-${params.skillsHash}`;
}

// ---------------------------------------------------------------------------
// D1 / KV CRUD
// ---------------------------------------------------------------------------

/**
 * D1 + KV 2 層から cache entry を取得する。
 *
 * 優先順位:
 *   1. D1 `agent_cache` table を SELECT
 *   2. D1 失敗 / 該当行なし → KV `agent_cache:<key>` を取得
 *   3. KV も失敗 / なし → `{ entry: null, source: 'none' }`
 *
 * D1 / KV 例外は WARN ログにして握り潰す (Python `_firestore_fallback_exc_
 * types` と同思想 — 障害で bot が落ちないようにする)。データそのものが破損
 * していた場合 (JSON parse 失敗等) は `null` を返して新規作成に進ませる。
 */
export async function loadAgentCache(
  env: AgentCacheBindings,
  cacheKey: string,
  logger: AgentCacheLogger = defaultAgentCacheLogger,
): Promise<AgentCacheLoadResult> {
  // === 1. D1 ===
  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        `SELECT agent_id, environment_id, memory_store_id, tools_hash, skills_hash
           FROM agent_cache WHERE cache_key = ?`,
      )
        .bind(cacheKey)
        .first<{
          agent_id: string;
          environment_id: string;
          memory_store_id: string | null;
          tools_hash: string;
          skills_hash: string;
        }>();
      if (row) {
        return {
          entry: {
            agent_id: row.agent_id,
            environment_id: row.environment_id,
            memory_store_id: row.memory_store_id,
            tools_hash: row.tools_hash,
            skills_hash: row.skills_hash,
          },
          source: 'd1',
        };
      }
    } catch (e) {
      logger.warn('agent_cache_load_d1_failed', {
        message: 'd1 agent_cache load failed, falling back to KV',
        cache_key: cacheKey,
        error: errorToString(e),
      });
    }
  }

  // === 2. KV fallback ===
  if (env.MAKOTO_KV) {
    try {
      const raw = await env.MAKOTO_KV.get(`${KV_PREFIX}${cacheKey}`, 'text');
      if (raw) {
        const parsed = safeJsonParse<AgentCacheEntry>(raw);
        if (parsed && parsed.agent_id && parsed.environment_id) {
          return { entry: parsed, source: 'kv' };
        }
        // 破損 JSON は cache miss 扱い (= 新規作成へ進む)
        logger.warn('agent_cache_kv_corrupted', {
          message: 'kv agent_cache entry corrupted, treating as miss',
          cache_key: cacheKey,
        });
      }
    } catch (e) {
      logger.warn('agent_cache_load_kv_failed', {
        message: 'kv agent_cache load failed, treating as miss',
        cache_key: cacheKey,
        error: errorToString(e),
      });
    }
  }

  return { entry: null, source: 'none' };
}

/**
 * cache entry を保存する。D1 を一次層、KV を fallback として並書きする
 * (両方書ければ後段 read が D1 経由でも KV 経由でも成立する)。
 *
 * - D1: `INSERT OR REPLACE` で row 単位 atomic 上書き (Python `set(merge=True)`
 *   の per-key 書込みと等価)
 * - KV: D1 書込み成功時のみ並書きする (D1 が正で、KV は速攻 fallback 用)。
 *   D1 失敗時は KV だけに書く (= D1 復旧後の lazy migration はせず、次回
 *   getOrCreate 時に新規作成された agent_id を D1 にも書く)
 *
 * 戻り値: 実際に書き込めた backend のリスト (空 = 全層失敗)。
 */
export async function saveAgentCacheEntry(
  env: AgentCacheBindings,
  cacheKey: string,
  entry: AgentCacheEntry,
  options: {
    userSlug?: string;
    logger?: AgentCacheLogger;
    nowMs?: number;
  } = {},
): Promise<Array<'d1' | 'kv'>> {
  const logger = options.logger ?? defaultAgentCacheLogger;
  const userSlug = options.userSlug ?? 'default';
  const now = options.nowMs ?? Date.now();
  const written: Array<'d1' | 'kv'> = [];

  // === 1. D1 ===
  let d1Ok = false;
  if (env.DB) {
    try {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO agent_cache
           (cache_key, user_slug, agent_id, environment_id, memory_store_id,
            tools_hash, skills_hash, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
        .bind(
          cacheKey,
          userSlug,
          entry.agent_id,
          entry.environment_id,
          entry.memory_store_id ?? null,
          entry.tools_hash,
          entry.skills_hash,
          now,
        )
        .run();
      d1Ok = true;
      written.push('d1');
    } catch (e) {
      logger.warn('agent_cache_save_d1_failed', {
        message: 'd1 agent_cache save failed, falling back to KV only',
        cache_key: cacheKey,
        error: errorToString(e),
      });
    }
  }

  // === 2. KV (並書き or 単独書き) ===
  if (env.MAKOTO_KV) {
    try {
      await env.MAKOTO_KV.put(
        `${KV_PREFIX}${cacheKey}`,
        JSON.stringify(entry),
      );
      written.push('kv');
    } catch (e) {
      logger.warn('agent_cache_save_kv_failed', {
        message: 'kv agent_cache save failed',
        cache_key: cacheKey,
        d1_ok: d1Ok,
        error: errorToString(e),
      });
    }
  }

  if (written.length === 0) {
    logger.warn('agent_cache_save_all_failed', {
      message: 'agent_cache save failed in all backends — agent will be re-created next cold start',
      cache_key: cacheKey,
    });
  }
  return written;
}

// ---------------------------------------------------------------------------
// get_or_create_resources port
// ---------------------------------------------------------------------------

/** Python `Resources` dataclass の TS 等価 (cma_lib.py l.470)。 */
export interface AgentResources {
  agent_id: string;
  environment_id: string;
  model: string;
  /** cache HIT 時の backend (テスト + 観測用)。 */
  source: 'd1' | 'kv' | 'created';
}

/**
 * agent + environment 作成 callback。
 *
 * 本 lib は Anthropic SDK の具体 import を持たない (CF Worker でも、Python で
 * cmaクライアント を渡しているのと同じ責務分離)。呼出側が `(env) =>
 * client.beta.agents.create(...) + client.beta.environments.create(...)` を
 * 1 つの関数にまとめて渡す。
 *
 * 戻り値: `(agent_id, environment_id)` の tuple。
 */
export type CreateResourcesFn = (createOpts: {
  agentName: string;
  environmentName: string;
  model: string;
  system: string;
  tools: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown>> | null;
}) => Promise<{ agent_id: string; environment_id: string }>;

export interface GetOrCreateResourcesOptions {
  agentName?: string;
  environmentName?: string;
  /** Python と同 default — Issue #193 で Sonnet 4.6 に追随済 (cma_lib.py l.476)。 */
  model?: string;
  /** system prompt。CF 側は spec bundle 側で別注入が多いので明示渡し推奨。 */
  system?: string;
  /** `null` / 未指定なら DEFAULT_TOOLS。 */
  tools?: Array<Record<string, unknown>>;
  /** `null` / 空配列なら cache key の skills 部は `'none'` (rollback で自動再作成)。 */
  skills?: Array<Record<string, unknown>> | null;
  /** True で cache を bypass し新規作成 (Python `recreate=True` 相当)。 */
  recreate?: boolean;
  /** per-user bootstrap 時に row へ user_slug を埋める。default は `'default'`。 */
  userSlug?: string;
  logger?: AgentCacheLogger;
  nowMs?: number;
}

/**
 * cache 取得 → miss / recreate なら新規作成 → cache 保存。Python
 * `get_or_create_resources` (cma_lib.py l.511) の TS port。
 *
 * 並行 read race (#184 同思想): D1 `INSERT OR REPLACE` は per-key atomic で
 * 後勝ち。同時 cold start で 2 worker が別 agent を作って両方 write すると、
 * 後勝ち agent_id が cache に残り、先勝ち agent は Anthropic 側に残置する
 * (lost cache 但しコスト累積はある = Python と同振舞、許容)。
 */
export async function getOrCreateResources(
  env: AgentCacheBindings,
  createFn: CreateResourcesFn,
  opts: GetOrCreateResourcesOptions = {},
): Promise<AgentResources> {
  const agentName = opts.agentName ?? 'lifelog-cma-default';
  const environmentName = opts.environmentName ?? 'lifelog-cma-default';
  const model = opts.model ?? 'claude-sonnet-4-6';
  const system = opts.system ?? DEFAULT_SYSTEM_PROMPT;
  const tools = opts.tools ?? DEFAULT_TOOLS;
  const skills = opts.skills ?? null;
  const userSlug = opts.userSlug ?? 'default';
  const logger = opts.logger ?? defaultAgentCacheLogger;
  const recreate = opts.recreate ?? false;

  const th = await toolsHash(tools);
  const sh = await skillsHash(skills);
  const cacheKey = buildCacheKey({
    agentName,
    environmentName,
    toolsHash: th,
    skillsHash: sh,
  });

  // === cache lookup ===
  if (!recreate) {
    const { entry, source } = await loadAgentCache(env, cacheKey, logger);
    if (entry && entry.agent_id && entry.environment_id && source !== 'none') {
      logger.info('agent_cache_hit', {
        cache_key: cacheKey,
        agent_id: entry.agent_id,
        environment_id: entry.environment_id,
        backend: source,
      });
      return {
        agent_id: entry.agent_id,
        environment_id: entry.environment_id,
        model,
        source,
      };
    }
  }

  // === miss / recreate → 新規作成 ===
  const created = await createFn({
    agentName,
    environmentName,
    model,
    system,
    tools,
    skills,
  });

  const newEntry: AgentCacheEntry = {
    agent_id: created.agent_id,
    environment_id: created.environment_id,
    memory_store_id: null,
    tools_hash: th,
    skills_hash: sh,
  };

  const written = await saveAgentCacheEntry(env, cacheKey, newEntry, {
    userSlug,
    logger,
    nowMs: opts.nowMs,
  });
  logger.info('agent_cache_created', {
    cache_key: cacheKey,
    agent_id: created.agent_id,
    environment_id: created.environment_id,
    tools_hash: th,
    skills_hash: sh,
    user_slug: userSlug,
    written_backends: written,
  });

  return {
    agent_id: created.agent_id,
    environment_id: created.environment_id,
    model,
    source: 'created',
  };
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

/** sorted-key JSON.stringify。Python `json.dumps(..., sort_keys=True, ensure_ascii=False)` と等価。 */
function stringifySorted(value: unknown): string {
  return JSON.stringify(value, replacerSorted);
}

function replacerSorted(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = obj[k];
    }
    return sorted;
  }
  return value;
}

/** SHA-256 hex の先頭 8 文字。Python `hashlib.sha256(...).hexdigest()[:8]` と等価。 */
async function sha256Hex8(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const arr = Array.from(new Uint8Array(buf));
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function errorToString(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
