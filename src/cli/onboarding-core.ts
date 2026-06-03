/**
 * Onboarding core logic (= dependency-injected pure functions for the CLI).
 *
 * Python 一次ソース (関数単位 1:1 port):
 *   - `init_user_memory_stores` : `scripts/cma_lib.py:l.4053`
 *   - `copy_agent`              : `scripts/cma_lib.py:l.4092`
 *   - `register_user_mapping`   : `scripts/cma_lib.py:l.4171`
 *
 * Cloudflare 単独運用化のため (= K 完了条件)、Python 版の以下を置換:
 *   - Python `~/.claude/lifelog-cma.json` (memstore_id cache) → KV key
 *     `memstore_id:<actual_store_name>` (= 冪等化に使う ensure_store 相当)
 *   - Python `~/.claude/cma-extra-users.json` + `cma-user-mapping.json` 再生成
 *     → KV key `user_mapping:<email-lower>` 1 件直接書込 (= R-Mail bridge
 *     `src/lib/memory-attach.ts:readUserMapping` が読む正本)
 *   - D1 `user_mapping_audit` に append-only audit を 1 行 insert (=
 *     `migrations/0002_makoto_phase2.sql` で定義済テーブル)
 *
 * 本ファイルは I/O bound な依存 (Anthropic SDK / KV / D1) を interface 越しに
 * 受け取る形にし、`onboarding.ts` の CLI 層と `tests/onboarding.test.ts` の
 * テスト層が同じ core を共有する (= 依存注入で fake を差し込む)。
 *
 * Issue: ksk3304/makoto-prime#186 (K)
 */

import type { MemoryAttachment } from '../types/memory';
import {
  AGENT_SCOPED_STORES,
  AGENT_SCOPED_STORE_SET,
  COMMON_STORES,
  STORES,
  actualStoreName,
  normalizeAgentNumber,
} from './store-config';
import { MAKOTO_AGENT_TOOLS } from '../lib/makoto-capability-registry';

// ---------------------------------------------------------------------------
// Interfaces (= dependency boundary)
// ---------------------------------------------------------------------------

/**
 * Anthropic Managed Agents API の最小 surface (= CLI が必要とするメソッドのみ).
 * 実装は `@anthropic-ai/sdk` の `client.beta` を直渡しすればよい
 * (`beta.memoryStores.create` / `beta.memoryStores.list` /
 *  `beta.agents.retrieve` / `beta.agents.create` が hit する)。
 */
export interface AnthropicClientLike {
  beta: {
    memoryStores: {
      create(params: { name: string; description?: string }): Promise<{ id: string; name: string }>;
      /**
       * Python 側は `ensure_store` が name 完全一致でキャッシュを引いてから
       * 不在時に create する。CF 側では「list で同名 store を探す」フォールバック
       * のみ提供 (KV cache が hit すれば API は叩かない)。
       */
      list(params?: { limit?: number }): AsyncIterable<{ id: string; name: string }>;
    };
    agents: {
      retrieve(agentId: string): Promise<{
        id: string;
        name: string;
        model: unknown;
        system: string | null;
        tools: unknown;
        skills: unknown;
      }>;
      create(params: {
        name: string;
        model: unknown;
        system: string;
        tools?: unknown;
        skills?: unknown;
      }): Promise<{ id: string; name: string }>;
    };
  };
}

/**
 * KV の最小 surface. Cloudflare `KVNamespace` も `wrangler kv key put` 経由の
 * subprocess 実装 (`src/cli/wrangler-kv.ts` 等) も両方同じ interface で扱える。
 */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/**
 * D1 audit insert の最小 surface. Worker 内 `D1Database` も `wrangler d1 execute`
 * subprocess 実装も同じ形で受けられる。
 */
export interface D1AuditWriter {
  insertUserMappingAudit(row: {
    email: string;
    user_slug: string;
    agent_id: string;
    event_type: 'register' | 're-register' | 'remove';
    registered_at_ms: number;
    notes?: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MEMSTORE_KV_PREFIX = 'memstore_id';
const USER_MAPPING_KV_PREFIX = 'user_mapping';

/** KV cache key for a memstore (= Python `cache[f"memstore::{actual_name}"]`). */
function memstoreCacheKey(actualName: string): string {
  return `${MEMSTORE_KV_PREFIX}:${actualName}`;
}

/** KV mapping key (lowercase email). Mirrors `src/lib/memory-attach.ts`. */
function userMappingKey(email: string): string {
  return `${USER_MAPPING_KV_PREFIX}:${email.trim().toLowerCase()}`;
}

/**
 * email 正規化 (= Python `email.strip().lower()`、N8 規定). `+tag` 除去は
 * R-Mail 側 `normalizeSenderEmail` の役目で、こちらは大小文字 / trim のみ。
 * (extras file の保存 key と R-Mail 側 lookup key を合わせる契約は #186 R-Mail
 *  ブリッジ仕様、Python 側 `register_user_mapping` の N8 と整合)
 */
export function normalizeMappingEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// init_user_memory_stores (= Python l.4053)
// ---------------------------------------------------------------------------

export interface InitMemoryStoresResult {
  /** `{physical_store_name: memstore_id}` = Python 戻り値と同形 */
  stores: Record<string, string>;
  created: string[]; // 新規 create した actual_name
  cached: string[]; // KV cache hit でスキップした actual_name
}

/**
 * 新規 agent 用 agent-scoped memory store を冪等に発行.
 *
 * 発行対象:
 *   - `Makoto Prime_0001_identity_memory`
 *   - `Makoto Prime_0001_support_memory`
 *   - `Makoto Prime_0001_daily_report_store`
 *   - `Makoto Prime_0001_session_log_store`
 *
 * 冪等性: KV `memstore_id:<actual_name>` に発行済 ID をキャッシュ。
 * cache hit 時は API を叩かない (= Python `ensure_store` 相当)。
 * cache miss 時は `beta.memoryStores.list()` で同名既存を探し、
 * あればそれを使う / なければ `create` で新規発行。
 *
 * dry_run=true なら API 呼出ゼロ + KV write ゼロ、stub ID
 * (`DRY_RUN_<actual_name>`) を返す。
 */
export async function initUserMemoryStores(opts: {
  anthropic: AnthropicClientLike;
  kv: KvLike;
  userSlug: string;
  agentNumber: string;
  companyName?: string;
  dryRun: boolean;
}): Promise<InitMemoryStoresResult> {
  void opts.userSlug;
  const agentNumber = normalizeAgentNumber(opts.agentNumber);
  const out: Record<string, string> = {};
  const created: string[] = [];
  const cached: string[] = [];

  for (const logicalName of AGENT_SCOPED_STORES) {
    if (!AGENT_SCOPED_STORE_SET.has(logicalName)) continue; // defensive
    const actualName = actualStoreName(logicalName, agentNumber, opts.companyName);
    const cacheKey = memstoreCacheKey(actualName);

    if (opts.dryRun) {
      out[actualName] = `DRY_RUN_${actualName}`;
      created.push(actualName);
      continue;
    }

    // 1. KV cache lookup
    const cachedId = await opts.kv.get(cacheKey);
    if (cachedId) {
      out[actualName] = cachedId;
      cached.push(actualName);
      continue;
    }

    // 2. Anthropic side: list で既存を探す (= 別経路で create された孤児 cache miss
    //    にも対応する。Python `ensure_store` も list ベースの同名探索を行う)。
    let foundExisting: string | null = null;
    for await (const store of opts.anthropic.beta.memoryStores.list({ limit: 100 })) {
      if (store.name === actualName) {
        foundExisting = store.id;
        break;
      }
    }

    let storeId: string;
    if (foundExisting) {
      storeId = foundExisting;
      cached.push(actualName);
    } else {
      const spec = STORES[logicalName];
      if (!spec) {
        throw new Error(
          `initUserMemoryStores: unknown logical store ${JSON.stringify(logicalName)} (store-config drift)`,
        );
      }
      const created_store = await opts.anthropic.beta.memoryStores.create({
        name: actualName,
        description: spec.description,
      });
      storeId = created_store.id;
      created.push(actualName);
    }

    // 3. KV cache write
    await opts.kv.put(cacheKey, storeId);
    out[actualName] = storeId;
  }

  return { stores: out, created, cached };
}

// ---------------------------------------------------------------------------
// copy_agent (= Python l.4092)
// ---------------------------------------------------------------------------

export interface CopyAgentResult {
  newAgentId: string;
  displayName: string;
  templateAgentId: string;
}

/**
 * 雛形 agent をコピーして新 user 用 agent を発行 (= Python l.4092).
 *
 * 手順:
 *   1. `client.beta.agents.retrieve(template_agent_id)` で雛形を取得
 *   2. system 文字列に addendum を concat
 *   3. `client.beta.agents.create({ name, model, system, tools, skills })`
 *      で新 agent 発行
 *
 * dry_run=true なら API 呼出ゼロ、stub ID (`DRY_RUN_agent_<slug>`) を返す。
 *
 * 例外:
 *   - retrieve() が system / model を返さない SDK version の場合 RuntimeError
 *     (= Python l.4140-4144 fail-fast)。
 */
export async function copyAgent(opts: {
  anthropic: AnthropicClientLike;
  templateAgentId: string;
  userSlug: string;
  displayName: string;
  addendum: string;
  dryRun: boolean;
}): Promise<CopyAgentResult> {
  if (opts.dryRun) {
    return {
      newAgentId: `DRY_RUN_agent_${opts.userSlug}`,
      displayName: opts.displayName,
      templateAgentId: opts.templateAgentId,
    };
  }

  // Step 1: retrieve
  const template = await opts.anthropic.beta.agents.retrieve(opts.templateAgentId);

  // Step 2: extract required fields (fail-fast on SDK shape drift)
  const templateSystem = template.system;
  const templateModel = template.model;
  if (templateSystem === null || templateSystem === undefined || templateModel === undefined) {
    throw new Error(
      `agents.retrieve(${JSON.stringify(opts.templateAgentId)}) did not return system/model ` +
        `(SDK 仕様変更の可能性、Python l.4140-4144 と同じ fail-fast)`,
    );
  }
  const templateTools = mergeMakotoAgentTools(template.tools);
  const templateSkills = template.skills;

  // Step 3: system + addendum
  const systemNew = `${templateSystem}\n\n${opts.addendum}`;

  // Step 4: create
  const createParams: {
    name: string;
    model: unknown;
    system: string;
    tools?: unknown;
    skills?: unknown;
  } = {
    name: `MAKOTOくん (${opts.displayName}用)`,
    model: templateModel,
    system: systemNew,
  };
  if (templateTools.length > 0) {
    createParams.tools = templateTools;
  }
  if (
    templateSkills !== undefined &&
    templateSkills !== null &&
    Array.isArray(templateSkills) &&
    templateSkills.length > 0
  ) {
    createParams.skills = templateSkills;
  }
  const newAgent = await opts.anthropic.beta.agents.create(createParams);

  return {
    newAgentId: newAgent.id,
    displayName: opts.displayName,
    templateAgentId: opts.templateAgentId,
  };
}

function mergeMakotoAgentTools(templateTools: unknown): Array<Record<string, unknown>> {
  const merged: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const add = (tool: unknown) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return;
    const record = tool as Record<string, unknown>;
    const key =
      record.type === 'custom' && typeof record.name === 'string'
        ? `custom:${record.name}`
        : typeof record.type === 'string'
          ? `type:${record.type}`
          : JSON.stringify(record);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(record);
  };

  if (Array.isArray(templateTools)) {
    for (const tool of templateTools) add(tool);
  }
  for (const tool of MAKOTO_AGENT_TOOLS) add(tool);
  return merged;
}

// ---------------------------------------------------------------------------
// register_user_mapping (= Python l.4171)
// ---------------------------------------------------------------------------

export interface UserMappingKvValue {
  user_slug: string;
  agent_number: string;
  agent_id: string;
  /** Memory Store の attach 仕様。R-Mail bridge `readUserMapping` が読む正本。 */
  memory_attachments: MemoryAttachment[];
  system_prompt_addendum: string;
  /** Audit 用メタ (R-Mail bridge は読まない、debug 用) */
  chat_user_id?: string;
  display_name?: string;
  updated_at: string;
}

export interface RegisterMappingResult {
  email: string; // 正規化後 lowercase
  kvKey: string;
  value: UserMappingKvValue;
  /** 'register' or 're-register' (既存 mapping を上書きした場合) */
  eventType: 'register' | 're-register';
}

/**
 * 新規 user mapping を KV (`user_mapping:<email-lower>`) に登録 +
 * D1 audit log に 1 行 insert (= Python `register_user_mapping` l.4171 の CF 版).
 *
 * Python 版が `~/.claude/cma-extra-users.json` + `cma-user-mapping.json`
 * 再生成だったのを、KV `user_mapping:<email>` 1 件の冪等書込 + D1 audit に置換
 * (CF 単独運用の前提下では JSON file 不要)。
 *
 * 冪等性:
 *   - 既存 KV entry の agent_id が同一 → no-op skip 同義の 're-register' (audit のみ)
 *   - 既存 KV entry の agent_id が異なる → 上書き ('re-register') + audit
 *   - 新規 → 'register'
 *
 * memory_attachments は store-config の COMMON_STORES から build。
 * actualStoreName で agent-scoped store は `<company>_0001_<purpose>` へ解決する。
 *
 * dry_run=true なら KV / D1 write ゼロ、戻り値だけ返す (確認用)。
 */
export async function registerUserMapping(opts: {
  kv: KvLike;
  audit: D1AuditWriter;
  storeIds: Record<string, string>; // actual_name → memstore_id (init の結果 + 既存共通)
  userEmail: string;
  userSlug: string;
  agentNumber: string;
  companyName?: string;
  agentId: string;
  displayName: string;
  chatUserId?: string;
  addendum: string;
  dryRun: boolean;
  /**
   * `Date.now()` injectable (= test reproducibility). Default は現在時刻。
   */
  nowMs?: number;
}): Promise<RegisterMappingResult> {
  const emailKey = normalizeMappingEmail(opts.userEmail);
  const kvKey = userMappingKey(emailKey);
  const agentNumber = normalizeAgentNumber(opts.agentNumber);
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // 1. memory_attachments を build (= Python build_user_mapping 相当の単体版).
  //    COMMON_STORES の各 logical_name について storeIds から actual_id を解決。
  //    agent-scoped store は <company>_<number>_<purpose>、共通 store は logical name で resolve。
  const attachments: MemoryAttachment[] = [];
  const missing: string[] = [];
  for (const logicalName of COMMON_STORES) {
    const actualName = actualStoreName(logicalName, agentNumber, opts.companyName);
    const id = opts.storeIds[actualName];
    if (!id) {
      missing.push(actualName);
      continue;
    }
    const spec = STORES[logicalName];
    if (!spec) {
      throw new Error(`registerUserMapping: unknown logical store ${logicalName}`);
    }
    attachments.push({
      memory_store_id: id,
      access: spec.access,
      instructions: spec.instructions,
      store_name: actualName,
    });
  }
  if (missing.length > 0 && !opts.dryRun) {
    // Python l.4323-4330 と同じ fail-fast (偽 ID 永続化防止)
    throw new Error(
      `registerUserMapping (real mode): store id missing for ${JSON.stringify(missing.sort())}. ` +
        `事前に init-user-memory-stores を実行するか、共通 store の memstore_id を ` +
        `--store-id "<actual_name>=<memstore_id>" で渡してください。`,
    );
  }

  const value: UserMappingKvValue = {
    user_slug: opts.userSlug,
    agent_number: agentNumber,
    agent_id: opts.agentId,
    memory_attachments: attachments,
    system_prompt_addendum: opts.addendum,
    chat_user_id: opts.chatUserId,
    display_name: opts.displayName,
    updated_at: nowIso,
  };

  // 2. 既存 KV 値を読んで eventType を決定 (= Python N16 互換).
  //    同 agent_id でも CF 側は memory_attachments が共通 store 差替で
  //    変わりうるため、KV write は常に実行 (再 register として扱う)。
  const existing = await opts.kv.get(kvKey);
  const eventType: 'register' | 're-register' = existing ? 're-register' : 'register';

  if (!opts.dryRun) {
    // 3. KV write
    await opts.kv.put(kvKey, JSON.stringify(value));

    // 4. D1 audit insert (append-only)
    await opts.audit.insertUserMappingAudit({
      email: emailKey,
      user_slug: opts.userSlug,
      agent_id: opts.agentId,
      event_type: eventType,
      registered_at_ms: nowMs,
      notes: opts.displayName ? `display_name=${opts.displayName}` : undefined,
    });
  }

  return { email: emailKey, kvKey, value, eventType };
}
