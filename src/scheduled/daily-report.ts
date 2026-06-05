/**
 * Daily report runner — owner agent 単位の日報を Memory Store に書き込む
 * 定期実行バッチ.
 *
 * user / agent 番号単位で `MAKOTO_Prime_000X_session_log` から
 * `MAKOTO_Prime_000X_daily_report` を作る。DM / 共有スペースでは分けない。
 *
 * 入力ソース:
 *   - KV: `user_mapping:<email>` を全件 list (= Python の
 *     `cma_session_resolver.SessionCredentialResolver._mapping` を Cloudflare 版に置換)
 *   - Memory Store: `client.beta.memoryStores.memories.list(store_id)` で
 *     `/<date>/` prefix の memory を list + retrieve
 *
 * 出力:
 *   - target Memory Store の `/<date>.md` を update / create
 *
 * LLM 呼出: Python `cma_lib.run_session` と同じく Managed Agent 経由。
 * user_mapping の `agent_id` と Worker secret `ENVIRONMENT_ID` で session を作る。
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — Cloudflare 移行 Day 3)
 * Source of truth (Python):
 *   - scripts/cma_daily_report.py (全 248 行)
 *   - scripts/cma_session_resolver.py l.57-72 (_store_id_from_entry)
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { UserMappingValue } from '../lib/memory-attach';
import { createSessionWithResources, sendAndStream } from '../lib/session';
import { dateLabelToMemoryPath } from '../lib/session-log';

// ============================================================================
// Constants / route definitions
// ============================================================================

/**
 * agent 番号単位の session_log → daily_report を 1 cron tick で巡回する.
 */
export interface ReportRoute {
  kind: 'owner_agent';
  source_store_name: string;
  target_store_name: string;
  title: string;
}

export const REPORT_ROUTES: readonly ReportRoute[] = [
  {
    kind: 'owner_agent',
    source_store_name: 'session_log',
    target_store_name: 'daily_report',
    title: '日報',
  },
] as const;

/**
 * Python `_store_id_from_entry` (l.57-72) の `needles` table.
 * store_name の attachment が無いとき instructions 文字列 substring 逆引き fallback.
 */
const NEEDLES: Readonly<Record<string, readonly [string, string]>> = {
  session_log: ['セッションログ', 'agent'],
  daily_report: ['日報', 'agent'],
  // legacy fallback
  agent_session_log_store: ['セッションログ', ''],
  agent_daily_report_store: ['日報', ''],
  session_log_dm_store: ['DM (個人 1:1)', 'セッションログ'],
  session_log_shared_store: ['共有スペース', 'セッションログ'],
  daily_report_dm_store: ['DM 軸', '日報'],
  daily_report_shared_store: ['共有スペース軸', '日報'],
} as const;

/** KV key prefix (= `src/lib/memory-attach.ts` と同じ). */
const KV_USER_MAPPING_PREFIX = 'user_mapping:';

/** Existing employee agent IDs. Compatibility only; never creates agents. */
const KNOWN_ACTIVE_EMPLOYEE_AGENT_IDS: Readonly<Record<string, string>> = {
  'k.seto@makotoprime.com': 'agent_015g2g4SKACdzaPyQ8QiSi2o',
  'takei@makotoprime.com': 'agent_01Vtoq66KenhBQzR4vnHG33t',
};

const KNOWN_ACTIVE_EMPLOYEE_AGENT_IDS_BY_SLUG: Readonly<Record<string, string>> = {
  'k-seto': 'agent_015g2g4SKACdzaPyQ8QiSi2o',
  takei: 'agent_01Vtoq66KenhBQzR4vnHG33t',
};

/** Anthropic API default model (= scheduled handler の env override 可). */
const DEFAULT_MODEL = 'claude-haiku-4-5';

// ============================================================================
// Pure helpers (byte-equivalent ports)
// ============================================================================

/**
 * Python `_store_id_from_entry` (l.57-72) の TS port.
 * attachment 配列から `store_name` 一致を最優先、見つからなければ
 * `instructions` substring 逆引き fallback (legacy mapping 互換) を 1 件返す.
 */
export function storeIdFromEntry(
  entry: UserMappingValue,
  storeName: string,
): string | null {
  const aliasHit = storeIdFromAliases(entry, storeName);
  if (aliasHit) return aliasHit;
  const needles = NEEDLES[storeName];
  if (!needles) {
    // 未知 store_name は store_name 一致のみで返す (= Python の KeyError と
    // 同等の挙動だが、本 port は呼出側でガードする前提で null fallback).
    for (const att of entry.memory_attachments || []) {
      if (att.store_name === storeName) return att.memory_store_id;
    }
    return null;
  }
  const [needleA, needleB] = needles;
  let fallback: string | null = null;
  for (const att of entry.memory_attachments || []) {
    if (att.store_name === storeName) {
      return att.memory_store_id;
    }
    const instructions = att.instructions ?? '';
    if (
      fallback === null &&
      instructions.includes(needleA) &&
      (needleB === '' || instructions.includes(needleB))
    ) {
      fallback = att.memory_store_id;
    }
  }
  return fallback;
}

function storeIdFromAliases(entry: UserMappingValue, storeName: string): string | null {
  const aliases: Readonly<Record<string, readonly string[]>> = {
    session_log: [
      'session_log',
      'agent_session_log_store',
      'session_log_store',
      'session_log_dm_store',
      'session_log_shared_store',
    ],
    daily_report: [
      'daily_report',
      'agent_daily_report_store',
      'daily_report_store',
      'daily_report_dm_store',
      'daily_report_shared_store',
    ],
    agent_session_log_store: [
      'agent_session_log_store',
      'session_log_store',
      'session_log_dm_store',
      'session_log_shared_store',
    ],
    agent_daily_report_store: [
      'agent_daily_report_store',
      'daily_report_store',
      'daily_report_dm_store',
      'daily_report_shared_store',
    ],
  };
  const numberedHit = storeIdFromNumberedAlias(entry, storeName);
  if (numberedHit) return numberedHit;
  for (const alias of aliases[storeName] ?? [storeName]) {
    for (const att of entry.memory_attachments || []) {
      if (att.store_name === alias) return att.memory_store_id;
    }
  }
  return null;
}

function storeIdFromNumberedAlias(entry: UserMappingValue, storeName: string): string | null {
  const patternByStore: Readonly<Record<string, RegExp>> = {
    session_log: /^[a-z0-9]+(?:[\s_-]+[a-z0-9]+)*[\s_-]+\d{4}[\s_-]+session_log$/i,
    daily_report: /^[a-z0-9]+(?:[\s_-]+[a-z0-9]+)*[\s_-]+\d{4}[\s_-]+daily_report$/i,
    agent_session_log_store: /^[a-z0-9]+(?:[\s_-]+[a-z0-9]+)*[\s_-]+\d{4}[\s_-]+session_log_store$/i,
    agent_daily_report_store: /^[a-z0-9]+(?:[\s_-]+[a-z0-9]+)*[\s_-]+\d{4}[\s_-]+daily_report_store$/i,
  };
  const pattern = patternByStore[storeName];
  if (!pattern) return null;
  for (const att of entry.memory_attachments || []) {
    if (pattern.test(att.store_name ?? '')) return att.memory_store_id;
  }
  return null;
}

/**
 * Python `_daily_report_prompt` (l.135-150) の TS port — **byte 等価**.
 * 改行 / 句読点 / 形式見出しを 1 字違わず再現する.
 */
export function dailyReportPrompt(
  route: ReportRoute,
  dateLabel: string,
  logs: ReadonlyArray<[string, string]>,
): string {
  const source = logs
    .filter(([, content]) => content.trim().length > 0)
    .map(([path, content]) => `## Source: ${path}\n\n${content}`)
    .join('\n\n');
  return (
    `${dateLabel} の ${route.title} を作成してください。\n` +
    '入力ログだけを根拠にし、推測で補完しないでください。\n' +
    'この agent 番号の1日分として、DMと共有スペースを分けずに整理してください。\n' +
    'ただし、ログ中の space_type / space / thread は場所情報として残してください。\n' +
    'ツールは使わず、Memory Store やファイルへの書き込みも行わず、日報本文だけを返してください。\n' +
    '形式:\n' +
    '# YYYY-MM-DD 日報\n' +
    '## 主な話題\n' +
    '## 決定事項\n' +
    '## 未完了・次アクション\n' +
    '## 注意点\n\n' +
    `${source}`
  );
}

/**
 * Python `_default_date_label` (l.223-224) の TS port.
 * 現在時刻 (UTC) → JST 変換 → 前日 date を ISO 形式で返す.
 */
export function defaultDateLabel(now: Date): string {
  // JST = UTC+9. 24h 前 (= 前日) の JST date を取る.
  const jstYesterday = new Date(now.getTime() + 9 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
  const yyyy = jstYesterday.getUTCFullYear().toString().padStart(4, '0');
  const mm = (jstYesterday.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = jstYesterday.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ============================================================================
// KV mapping loader
// ============================================================================

/**
 * KV `user_mapping:*` を全件 list して `{email → UserMappingValue}` の Map を返す.
 * Python `cma_session_resolver.SessionCredentialResolver._mapping` を
 * Cloudflare KV 版に置換する集約処理.
 *
 * paging まで実装 (1000 keys/page、現状 user 数 << 1000 だが将来用).
 */
export async function loadAllUserMappings(
  kv: KVNamespace,
): Promise<Map<string, UserMappingValue>> {
  const out = new Map<string, UserMappingValue>();
  let cursor: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const listResult = await kv.list({
      prefix: KV_USER_MAPPING_PREFIX,
      cursor,
    });
    for (const entry of listResult.keys) {
      const email = entry.name.slice(KV_USER_MAPPING_PREFIX.length);
      const value = (await kv.get(entry.name, 'json')) as UserMappingValue | null;
      if (value !== null) {
        out.set(email, value);
      }
    }
    if (listResult.list_complete) break;
    cursor = listResult.cursor;
    if (!cursor) break;
  }
  return out;
}

// ============================================================================
// Memory Store ops (SDK-driven)
// ============================================================================

interface MemoryListItem {
  type?: unknown;
  id?: unknown;
  path?: unknown;
}

interface MemoryRetrieveItem {
  content?: unknown;
}

/**
 * Python `_memory_content` + `_retrieve_memory_content` (l.106-119) の TS port.
 * content は str / list[block] のどちらでもありうるので join する.
 */
function extractMemoryContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (block && typeof block === 'object') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * Python `_list_date_session_logs` (l.122-132) の TS port.
 * 指定 store の memory 一覧から新 `/<YYYY>/<MM>/<DD>` prefix と
 * 旧 `/<YYYY-MM-DD>/` prefix の memory を全件 retrieve し、
 * `[path, content]` の sorted tuple list を返す.
 */
export async function listDateSessionLogs(
  client: Anthropic,
  storeId: string,
  dateLabel: string,
): Promise<Array<[string, string]>> {
  const newPrefix = dateLabelToMemoryPath(dateLabel);
  const legacyPrefix = `/${dateLabel}/`;
  const out: Array<[string, string]> = [];
  const page = await client.beta.memoryStores.memories.list(storeId);
  for await (const rawItem of page as unknown as AsyncIterable<MemoryListItem>) {
    if (rawItem.type !== 'memory') continue;
    const path = typeof rawItem.path === 'string' ? rawItem.path : '';
    const id = typeof rawItem.id === 'string' ? rawItem.id : '';
    if (!path.startsWith(newPrefix) && !path.startsWith(legacyPrefix)) continue;
    if (!id) continue;
    const retrieved = (await client.beta.memoryStores.memories.retrieve(id, {
      memory_store_id: storeId,
    })) as MemoryRetrieveItem;
    out.push([path, extractMemoryContent(retrieved.content)]);
  }
  // Python `sorted(out)` (= tuple compare = path 昇順).
  out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/**
 * Python `_write_report` (l.178-193) の TS port.
 * 既存 `/<YYYY>/<MM>/<DD>.md` があれば update、なければ create.
 */
export async function writeReport(
  client: Anthropic,
  storeId: string,
  dateLabel: string,
  content: string,
): Promise<string> {
  const path = `${dateLabelToMemoryPath(dateLabel)}.md`;
  const page = await client.beta.memoryStores.memories.list(storeId);
  let existingId: string | null = null;
  for await (const rawItem of page as unknown as AsyncIterable<MemoryListItem>) {
    if (rawItem.type !== 'memory') continue;
    const itemPath = typeof rawItem.path === 'string' ? rawItem.path : '';
    const itemId = typeof rawItem.id === 'string' ? rawItem.id : '';
    if (itemPath === path && itemId) {
      existingId = itemId;
      break;
    }
  }
  if (existingId !== null) {
    await client.beta.memoryStores.memories.update(existingId, {
      memory_store_id: storeId,
      content,
    });
  } else {
    await client.beta.memoryStores.memories.create(storeId, {
      content,
      path,
    });
  }
  return path;
}

// ============================================================================
// Managed Agent summarize
// ============================================================================

export interface ReportStorePair {
  label: string;
  sourceStoreId: string;
  targetStoreId: string;
  agentId: string;
}

export interface SummarizeLogsResult {
  report: string;
  sessionId?: string;
  toolUseCount: number;
  toolUseNames: string[];
}

class DailyReportSessionError extends Error {
  readonly sessionId?: string;

  constructor(message: string, sessionId?: string) {
    super(message);
    this.name = 'DailyReportSessionError';
    this.sessionId = sessionId;
  }
}

function agentIdForEntry(email: string, entry: UserMappingValue): string {
  const raw = (entry as { agent_id?: unknown }).agent_id;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  const normalized = email.trim().toLowerCase();
  return (
    KNOWN_ACTIVE_EMPLOYEE_AGENT_IDS[normalized]
    ?? KNOWN_ACTIVE_EMPLOYEE_AGENT_IDS_BY_SLUG[entry.user_slug]
    ?? ''
  );
}

/**
 * Python `_summarize_logs` (l.153-175) の TS port.
 * user mapping の agent_id または既知社員 fallback が無い場合は logs 0 件でも fail-fast する。
 * logs 0 件時は `# {date_label} {route.title}\n\n新着セッションなし。\n` を
 * LLM 呼出なしで返す (byte 等価).
 *
 * logs ある時は user mapping の agent_id で Managed Agent session を作り、
 * Python `run_session` 同様、日報 prompt を `user.message` として送る。
 */
export async function summarizeLogs(
  client: Anthropic,
  route: ReportRoute,
  dateLabel: string,
  logs: ReadonlyArray<[string, string]>,
  _model: string,
  agentId: string,
  environmentId: string,
): Promise<SummarizeLogsResult> {
  if (!agentId) {
    throw new Error('daily-report agent_id missing');
  }
  if (logs.length === 0) {
    return {
      report: `# ${dateLabel} ${route.title}\n\n新着セッションなし。\n`,
      toolUseCount: 0,
      toolUseNames: [],
    };
  }
  const userPrompt = dailyReportPrompt(route, dateLabel, logs);
  let sessionId: string | undefined;
  sessionId = await createSessionWithResources(client, {
    agentId,
    environmentId,
    resources: [],
  });
  try {
    const streamed = await sendAndStream(client, {
      sessionId,
      userMessage: userPrompt,
    });
    if (streamed.toolUseCount > 0) {
      throw new Error(
        `daily-report tool use forbidden: count=${streamed.toolUseCount} names=${streamed.toolUseNames.join(',')}`,
      );
    }
    // Python: `"".join(chunks).strip() + "\n"` (l.175).
    return {
      report: streamed.assistantText.trim() + '\n',
      sessionId,
      toolUseCount: streamed.toolUseCount,
      toolUseNames: streamed.toolUseNames,
    };
  } catch (error) {
    throw new DailyReportSessionError(
      error instanceof Error ? error.message : String(error),
      sessionId,
    );
  }
}

// ============================================================================
// Route pair resolver
// ============================================================================

/**
 * 1 route ぶんの store pair 配列を作る.
 * 1 route ぶんの store pair 配列を作る。
 * owner agent 単位で email 昇順に iterate し、source/target 両方が
 * 揃った user のみ pair に含める。
 */
export function routeStorePairs(
  mapping: Map<string, UserMappingValue>,
  route: ReportRoute,
): ReportStorePair[] {
  const sortedEmails = Array.from(mapping.keys()).sort();
  const pairs: ReportStorePair[] = [];
  for (const email of sortedEmails) {
    const entry = mapping.get(email)!;
    const source = storeIdFromEntry(entry, route.source_store_name);
    const target = storeIdFromEntry(entry, route.target_store_name);
    if (source && target) {
      const label = entry.user_slug || slugFromEmail(email);
      pairs.push({
        label,
        sourceStoreId: source,
        targetStoreId: target,
        agentId: agentIdForEntry(email, entry),
      });
    }
  }
  if (pairs.length === 0) {
    throw new Error('no owner-agent daily-report stores found');
  }
  return pairs;
}

/**
 * Python `cma_session_resolver.slug_from_email` (l.509-512) の最小 TS port.
 * `src/lib/session-log.ts:slugFromEmail` と同等だが循環 import を避けて
 * 直接実装する.
 */
function slugFromEmail(email: string): string {
  const at = email.indexOf('@');
  const local = at === -1 ? email : email.slice(0, at);
  return local.replace(/\./g, '-').toLowerCase();
}

// ============================================================================
// Main entry (Cloudflare scheduled handler から呼ぶ)
// ============================================================================

export interface DailyReportRunInput {
  kv: KVNamespace;
  client: Anthropic;
  dateLabel: string;
  model: string;
  environmentId: string;
  dryRun: boolean;
}

export interface DailyReportRouteResult {
  source_store_id: string;
  target_store_id: string;
  log_count: number;
  output_path: string;
  chars: number;
  agent_id?: string;
  environment_id?: string;
  session_id?: string;
  tool_use_count?: number;
  tool_use_names?: string[];
  /** error 文字列 (route 単位 failure isolation で集約). 成功時は無し. */
  error?: string;
}

/**
 * Python `generate_daily_reports` (l.196-220) の TS port.
 * 全 route 全 user で逐次実行し、result を集約する.
 *
 * **failure isolation**: 1 user / 1 route のエラーで全体を落とさず、
 * その route だけ error 文字列を載せて次へ進む (= scheduled handler は
 * "best effort" バッチであるため).
 */
export async function generateDailyReports(
  input: DailyReportRunInput,
): Promise<Record<string, DailyReportRouteResult>> {
  const { kv, client, dateLabel, model, environmentId, dryRun } = input;
  const mapping = await loadAllUserMappings(kv);
  const result: Record<string, DailyReportRouteResult> = {};

  for (const route of REPORT_ROUTES) {
    let pairs: ReportStorePair[];
    try {
      pairs = routeStorePairs(mapping, route);
    } catch (error) {
      // mapping 不在 / store_name 不在は route 単位 fatal だが、他 route には
      // 影響させない. error を集約 result に載せる.
      const key = 'agent:_route_init';
      result[key] = {
        source_store_id: '',
        target_store_id: '',
        log_count: 0,
        output_path: '',
        chars: 0,
        error: error instanceof Error ? error.message : String(error),
      };
      continue;
    }

    for (const pair of pairs) {
      const key = `agent:${pair.label}`;
      try {
        const logs = await listDateSessionLogs(client, pair.sourceStoreId, dateLabel);
        const summary = await summarizeLogs(
          client,
          route,
          dateLabel,
          logs,
          model,
          pair.agentId,
          environmentId,
        );
        let outputPath = `${dateLabelToMemoryPath(dateLabel)}.md`;
        if (!dryRun) {
          outputPath = await writeReport(client, pair.targetStoreId, dateLabel, summary.report);
        }
        result[key] = {
          source_store_id: pair.sourceStoreId,
          target_store_id: pair.targetStoreId,
          log_count: logs.length,
          output_path: outputPath,
          chars: summary.report.length,
          agent_id: pair.agentId,
          environment_id: environmentId,
          session_id: summary.sessionId,
          tool_use_count: summary.toolUseCount,
          tool_use_names: summary.toolUseNames,
        };
      } catch (error) {
        const sessionId =
          error instanceof DailyReportSessionError ? error.sessionId : undefined;
        // 1 user の session / list / write 失敗で他 user を巻き込まない.
        result[key] = {
          source_store_id: pair.sourceStoreId,
          target_store_id: pair.targetStoreId,
          log_count: 0,
          output_path: '',
          chars: 0,
          agent_id: pair.agentId,
          environment_id: environmentId,
          session_id: sessionId,
          tool_use_count: 0,
          tool_use_names: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }
  return result;
}
