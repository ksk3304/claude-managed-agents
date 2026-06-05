/**
 * Session-log memory append — agent bot が 1 ターン応答した後、
 * 応答内容を Memory Store (Anthropic Managed Agents) の
 * `/YYYY/MM/DD.md` に append する lib.
 *
 * Cloud Run の `_append_session_log_memory`
 * (`scripts/cma_gchat_bot.py:417-490`) の TS port. byte 等価で動作する
 * よう、slug 化 / path 構築 / entry markdown / suffix loop / max_bytes
 * 上限は厳密に踏襲する.
 *
 * 機能の役割:
 *   1. agent 番号単位の `session_log` attachment を保存先にする。
 *   2. JST date label (`YYYY-MM-DD`) から agent 番号 store 内の
 *      日次 base path を構築 (`sessionLogBasePath`).
 *   3. 1 entry の markdown を組み立てる (`buildSessionLogEntry`) — header
 *      に `space_type` / `space` / `thread` / `session_id` / `message_id`、
 *      本文に User / Agent の発話.
 *   4. 既存 memory を list → 該当 path が無ければ create、有れば retrieve
 *      → entry append → `<= max_bytes` なら update / 超過なら suffix を
 *      `-2 / -3 / ...` と進めて再試行 (`appendSessionLogMemory`).
 *
 * 純関数 (`slugForMemoryPath` / `sessionLogBasePath` /
 * `buildSessionLogEntry` / `sanitizeInlineValue` / `slugFromEmail` /
 * `isSharedSpace`) を export して test しやすくする. SDK 呼出は
 * `appendSessionLogMemory` の `deps.client` 経由のみで、test では mock
 * 注入できる.
 *
 * Cloud Run 側 `cma_lib.py` で `SESSION_LOG_MAX_BYTES = 100 * 1024`
 * (cma_gchat_bot.py:273) と等価.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — port mapping v1 §1 row #24
 *                                  "Session log memory append")
 * Source of truth (Python):
 *   - scripts/cma_gchat_bot.py l.273 (SESSION_LOG_MAX_BYTES)
 *   - scripts/cma_gchat_bot.py l.277-310 (resolver + attachment select)
 *   - scripts/cma_gchat_bot.py l.313-318 (_slug_for_memory_path)
 *   - scripts/cma_gchat_bot.py l.321-340 (_session_log_base_path)
 *   - scripts/cma_gchat_bot.py l.343-377 (memory item + list)
 *   - scripts/cma_gchat_bot.py l.380-414 (_session_log_entry)
 *   - scripts/cma_gchat_bot.py l.417-490 (_append_session_log_memory)
 *   - scripts/cma_session_resolver.py l.194-199 (is_shared_space)
 *   - scripts/cma_session_resolver.py l.509-512 (slug_from_email)
 *   - scripts/cma_gchat_send.py l.48-64 (sanitize_inline_value)
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { MemoryAttachment } from '../types/memory';

// ============================================================================
// Constants
// ============================================================================

/**
 * Memory 1 file の最大 byte 数. 超過すると suffix loop が `-2.md` /
 * `-3.md` ... に進む. Anthropic Memory Store の 100 kB 上限と等価で、
 * Python の `SESSION_LOG_MAX_BYTES = 100 * 1024` (cma_gchat_bot.py:273)
 * と同じ.
 */
export const SESSION_LOG_MAX_BYTES = 100 * 1024;

/** DM 扱いの space_type 集合. これ以外は shared space と判定する. */
const DM_SPACE_TYPES = new Set(['DM', 'DIRECT_MESSAGE']);

// ============================================================================
// Pure helpers (byte-equivalent ports)
// ============================================================================

/**
 * DM / DIRECT_MESSAGE 以外を共有スペース (ROOM / SPACE / GROUP_CHAT /
 * 未知タイプ) と判定する. `cma_session_resolver.py:is_shared_space`
 * (l.194-199) と byte 等価.
 */
export function isSharedSpace(spaceType: string | null | undefined): boolean {
  return !DM_SPACE_TYPES.has((spaceType || '').toUpperCase());
}

/**
 * email から user_slug を生成 (local part の `.` を `-` に変換 + lowercase).
 * `cma_session_resolver.py:slug_from_email` (l.509-512) と byte 等価.
 */
export function slugFromEmail(email: string): string {
  const at = email.indexOf('@');
  const local = at === -1 ? email : email.slice(0, at);
  return local.replace(/\./g, '-').toLowerCase();
}

/**
 * payload 由来の文字列を「内部メモ」1行に埋め込む前のサニタイズ.
 * `cma_gchat_send.py:sanitize_inline_value` (l.48-64) の TS port.
 *
 * 仕様 (byte 等価):
 *   - 改行・制御文字 (Cc) / Format 文字 (Cf) を半角空白に置換
 *   - 連続する空白文字 (`\s+`) を 1 個に圧縮
 *   - 前後を strip
 *
 * Python は `unicodedata.category(ch)` で Cc / Cf を判定するが、TS は
 * 標準 lib に Unicode category がないため、ASCII 制御文字 +
 * `\p{C}` (Other Unicode category: Cc/Cf/Cs/Co/Cn) を半角空白に置換
 * する近似を取る (Cs/Co/Cn も巻き込むが session-log 用途では誤検出
 * リスクは無視できる). `\s` は JS / Python とも空白文字を含むため
 * 圧縮挙動は等価.
 */
export function sanitizeInlineValue(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  // Replace control / format chars with single space. `\p{C}` covers
  // Cc/Cf/Cs/Co/Cn — the practical superset of Python's `Cc/Cf` check
  // for our payload shapes (display names / thread titles).
  const cleaned = value.replace(/\p{C}/gu, ' ');
  return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * NFKC normalize + lowercase + non-alphanum を `-` 連続置換 + strip して
 * slug 化する. 空になった場合は `fallbackSeed` の sha256 から `space-<8hex>`
 * を生成. 最大 80 文字 (Python `slug[:80]` 等価).
 *
 * `cma_gchat_bot.py:_slug_for_memory_path` (l.313-318) の TS port.
 *
 * 非同期なのは `crypto.subtle.digest` の API 都合 (Workers でも Node でも
 * 利用可). fallback hash を踏まない通常パス (slug が空でない) でも
 * 結果一貫性のため Promise を返す.
 */
export async function slugForMemoryPath(
  value: string | null | undefined,
  fallbackSeed: string,
): Promise<string> {
  const normalized = (value || '').normalize('NFKC').toLowerCase();
  const slug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > 0) {
    return slug.slice(0, 80);
  }
  const buf = new TextEncoder().encode(fallbackSeed);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  let hex = '';
  for (const b of new Uint8Array(hash)) {
    hex += b.toString(16).padStart(2, '0');
  }
  return 'space-' + hex.slice(0, 8);
}

// ============================================================================
// Path / entry builders
// ============================================================================

/**
 * Google Chat space dict — 必要な field のみ structural typing で定義する.
 * Python の `space: dict[str, Any]` に対応.
 */
export interface SessionLogSpace {
  /** `spaces/XXXX` resource name. */
  name?: string;
  /** UI 表示名. */
  displayName?: string;
  /** 'DM' / 'ROOM' / 'GROUP_CHAT' / 'SPACE' 等. */
  type?: string;
  /** Chat API v1 で旧 field 名 (互換維持). */
  spaceType?: string;
}

/** sender dict — 必要な field のみ. Python の `sender: dict[str, Any]` 対応. */
export interface SessionLogSender {
  /** `users/xxx` resource name. */
  name?: string;
  /** mapping 解決後の email. */
  email?: string;
}

export interface SessionLogBasePathParams {
  /** `YYYY-MM-DD` (JST). caller が日付計算した結果を渡す. */
  dateLabel: string;
  /** shared/dm を判定する space_type. */
  spaceType: string;
  /** DM 用の user_slug (resolver が生成した値). */
  userSlug: string;
  /** mapping 解決後の sender_email (slug fallback seed). */
  senderEmail: string;
  space: SessionLogSpace;
  sender: SessionLogSender;
  /**
   * space alias 逆引き関数 (= `cma_gchat_send.reverse_resolve_alias`).
   * 未指定なら逆引き無し (displayName / name へ fallback).
   */
  reverseResolveAlias?: (spaceId: string) => string | null;
}

/**
 * `/YYYY/MM/DD` を構築する。store 自体が owner agent 単位なので、
 * DM / shared space / sender slug では path を分けない。
 *
 * `cma_gchat_bot.py:_session_log_base_path` (l.321-340) の TS port.
 */
export async function sessionLogBasePath(
  params: SessionLogBasePathParams,
): Promise<string> {
  void params.spaceType;
  void params.space;
  void params.reverseResolveAlias;
  void params.userSlug;
  void params.senderEmail;
  void params.sender;
  return dateLabelToMemoryPath(params.dateLabel);
}

export function dateLabelToMemoryPath(dateLabel: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateLabel);
  if (!match) {
    throw new Error(`invalid dateLabel: ${JSON.stringify(dateLabel)}`);
  }
  return `/${match[1]}/${match[2]}/${match[3]}`;
}

export interface SessionLogEntryParams {
  /** ISO8601 (`YYYY-MM-DDTHH:MM:SS+09:00` 等). caller 算出. */
  eventTime: string;
  space: SessionLogSpace;
  sender: SessionLogSender;
  threadName?: string | null;
  userText: string;
  finalText: string;
  sessionId?: string | null;
  messageId?: string | null;
}

/**
 * Memory Store markdown 1 entry を生成する.
 *
 * ★Issue #96 (OPEN-002): session_id / message_id をヘッダに含め、GCS JSONL の
 * agent_session_complete event と相関させる (4 項目横断検索の主キー).
 *
 * `cma_gchat_bot.py:_session_log_entry` (l.380-414) の TS port. 行末改行 /
 * 空欄プレースホルダ `（空）` まで含めて byte 等価.
 */
export function buildSessionLogEntry(params: SessionLogEntryParams): string {
  const senderSlug = slugFromEmail(
    params.sender.email || params.sender.name || '',
  );
  const spaceType = params.space.type || params.space.spaceType || 'UNKNOWN';
  const safeThread =
    sanitizeInlineValue(params.threadName ?? '') || '(no-thread)';
  const safeSpace = sanitizeInlineValue(params.space.name ?? '') || '(no-space)';
  const safeSessionId = sanitizeInlineValue(params.sessionId ?? '') || 'n/a';
  const safeMessageId = sanitizeInlineValue(params.messageId ?? '') || 'n/a';

  // Python: `user_text.strip() or '（空）'`. JS の trim() は Python str.strip()
  // と空白集合がわずかに違うが、user 入力は基本 ASCII / 日本語空白で実用差分なし.
  const userBody = params.userText.trim() || '（空）';
  const finalBody = params.finalText.trim() || '（空）';

  return (
    `\n---\n` +
    `## ${params.eventTime} ${senderSlug}\n\n` +
    `- space_type: ${spaceType}\n` +
    `- space: ${safeSpace}\n` +
    `- thread: ${safeThread}\n` +
    `- session_id: ${safeSessionId}\n` +
    `- message_id: ${safeMessageId}\n\n` +
    `### User\n\n${userBody}\n\n` +
    `### Agent\n\n${finalBody}\n`
  );
}

// ============================================================================
// Attachment selection
// ============================================================================

/**
 * `cma_gchat_bot.py:_select_session_log_attachment` (l.293-310) の TS port.
 *
 * 新 mapping では `MAKOTO_Prime_000X_session_log` を選ぶ。
 * 後方互換として旧 mapping では space type に応じた
 * `session_log_shared_store` / `session_log_dm_store` も許容する.
 */
export function selectSessionLogAttachment(
  spaceType: string,
  attachments: MemoryAttachment[],
): MemoryAttachment | null {
  const target = 'session_log';
  for (const att of attachments) {
    const name = att.store_name ?? '';
    if (name === target || isCompanyNumberedStore(name, 'session_log')) return att;
  }
  const legacyTarget = isSharedSpace(spaceType)
    ? 'session_log_shared_store'
    : 'session_log_dm_store';
  for (const att of attachments) {
    if (att.store_name === legacyTarget) return att;
  }
  // Backward compatibility: instructions 文字列で判定。DM legacy を先に見る。
  const instructionNeedles = ['agent', 'DM (個人 1:1)', '共有スペース'];
  for (const needle of instructionNeedles) {
    for (const att of attachments) {
      const ins = att.instructions ?? '';
      if (ins.includes(needle) && ins.includes('セッションログ')) return att;
    }
  }
  for (const att of attachments) {
    const name = att.store_name ?? '';
    if (name.includes('session') && name.includes('log')) return att;
  }
  return null;
}

function isCompanyNumberedStore(storeName: string, suffix: string): boolean {
  const normalized = storeName.trim().toLowerCase().replace(/[-\s]+/g, '_');
  return new RegExp(`^[a-z0-9]+(?:_[a-z0-9]+)*_\\d{4}_${suffix}$`).test(normalized);
}

// ============================================================================
// SDK-driven side effects
// ============================================================================

/**
 * `appendSessionLogMemory` の依存. SDK client を注入することで test が
 * mock を差し込みやすくする (Python 側は `client: Anthropic` 直渡し).
 */
export interface AppendSessionLogDeps {
  client: Anthropic;
  /** space alias 逆引き. 未指定なら逆引きしない. */
  reverseResolveAlias?: (spaceId: string) => string | null;
  /**
   * Date 生成器 (test 用). 未指定なら `new Date()`. JST 変換は内部で行う.
   */
  now?: () => Date;
  /** SESSION_LOG_MAX_BYTES の override (test 用). */
  maxBytes?: number;
}

export interface AppendSessionLogParams {
  /** mapping 解決後の sender_email. */
  senderEmail: string;
  /** Google Chat の space.type (DM / ROOM / GROUP_CHAT / 等). */
  spaceType: string;
  /** mapping 解決後の user_slug. */
  userSlug: string;
  /**
   * 保存先 attachment 候補. caller (= resolver の結果) が渡し、
   * 内部で `selectSessionLogAttachment` で絞り込む.
   */
  memoryAttachments: MemoryAttachment[];
  space: SessionLogSpace;
  sender: SessionLogSender;
  threadName?: string | null;
  userText: string;
  finalText: string;
  sessionId?: string | null;
  messageId?: string | null;
}

export interface AppendSessionLogResult {
  /**
   * `true` = create / update いずれかが成功. `false` = attachment 未解決
   * 等で skip.
   */
  appended: boolean;
  /** 書き込んだ memory の path (skip 時 null). */
  path?: string;
  /** 書き込み action (skip / create / update). */
  action?: 'create' | 'update';
  /** 試した suffix 数 (1 = `<slug>.md`, 2 = `<slug>-2.md`, ...). */
  suffix?: number;
}

/**
 * 1 entry を Memory Store に append する.
 *
 * 流れ:
 *   1. attachment を `selectSessionLogAttachment` で絞り込む. 見つからな
 *      ければ `{appended:false}` で早期 return.
 *   2. JST 変換した `dateLabel` / `eventTime` を作る.
 *   3. `sessionLogBasePath` + `buildSessionLogEntry` で path と entry を構築.
 *   4. `memoryStores.memories.list` で既存 path のマップを作り、suffix
 *      `1, 2, 3, ...` の順に試す:
 *      - 既存 memory があれば `retrieve` で content を取得、entry を append
 *        後 `<= maxBytes` なら `update`、超過なら次の suffix へ.
 *      - 既存 memory が無ければ `create` (entry のみが content となる).
 *
 * `cma_gchat_bot.py:_append_session_log_memory` (l.417-490) と挙動等価.
 * Python の `client.beta.memory_stores.memories.{list, retrieve, create, update}`
 * は SDK が snake_case / camelCase 両方を受け付ける (= TS は camelCase の
 * `client.beta.memoryStores.memories.*`).
 */
export async function appendSessionLogMemory(
  deps: AppendSessionLogDeps,
  params: AppendSessionLogParams,
): Promise<AppendSessionLogResult> {
  const attachment = selectSessionLogAttachment(
    params.spaceType,
    params.memoryAttachments,
  );
  if (attachment === null) {
    console.log(
      `[gchat] session log skipped: no target store space_type=${JSON.stringify(
        params.spaceType,
      )} slug=${params.userSlug}`,
    );
    return { appended: false };
  }

  const now = (deps.now ? deps.now() : new Date());
  const { dateLabel, eventTime } = formatJstDateAndTime(now);
  const maxBytes = deps.maxBytes ?? SESSION_LOG_MAX_BYTES;

  const base = await sessionLogBasePath({
    dateLabel,
    spaceType: params.spaceType,
    userSlug: params.userSlug,
    senderEmail: params.senderEmail,
    space: params.space,
    sender: params.sender,
    reverseResolveAlias: deps.reverseResolveAlias,
  });

  const entry = buildSessionLogEntry({
    eventTime,
    space: params.space,
    sender: params.sender,
    threadName: params.threadName,
    userText: params.userText,
    finalText: params.finalText,
    sessionId: params.sessionId,
    messageId: params.messageId,
  });

  const existing = await listMemoryFiles(deps.client, attachment.memory_store_id);

  for (let suffix = 1; ; suffix += 1) {
    const path = suffix === 1 ? `${base}.md` : `${base}-${suffix}.md`;
    const cur = existing.get(path);
    let curContent = '';
    if (cur) {
      curContent = await retrieveMemoryContent(
        deps.client,
        attachment.memory_store_id,
        cur.id,
      );
    }
    // Python: `(cur_content.rstrip() + "\n" + entry).lstrip()`. byte 等価.
    const newContent = (curContent.replace(/\s+$/, '') + '\n' + entry).replace(
      /^\s+/,
      '',
    );
    const bytes = byteLength(newContent);

    if (bytes <= maxBytes || cur === undefined) {
      if (cur) {
        await deps.client.beta.memoryStores.memories.update(cur.id, {
          memory_store_id: attachment.memory_store_id,
          content: newContent,
        });
        console.log(
          `[gchat] session log written path=${JSON.stringify(path)} ` +
            `space_type=${JSON.stringify(params.spaceType)}`,
        );
        return { appended: true, path, action: 'update', suffix };
      }
      await deps.client.beta.memoryStores.memories.create(
        attachment.memory_store_id,
        {
          content: newContent,
          path,
        },
      );
      console.log(
        `[gchat] session log written path=${JSON.stringify(path)} ` +
          `space_type=${JSON.stringify(params.spaceType)}`,
      );
      return { appended: true, path, action: 'create', suffix };
    }
    // suffix loop continues — current memory overflowed, try next.
  }
}

// ============================================================================
// SDK adapters (kept internal — tests inject a mock `deps.client`)
// ============================================================================

interface ExistingMemoryRef {
  id: string;
  sha256: string;
}

/**
 * `_list_memory_files` の TS port. memory_store に格納された memory 一覧から
 * `{path: {id, sha256}}` map を作る. `memory_prefix` rollup マーカー
 * (`type === 'memory_prefix'`) は無視する.
 */
async function listMemoryFiles(
  client: Anthropic,
  memoryStoreId: string,
): Promise<Map<string, ExistingMemoryRef>> {
  const out = new Map<string, ExistingMemoryRef>();
  // SDK の `list` は async iterator (PagePromise) を返す.
  const page = await client.beta.memoryStores.memories.list(memoryStoreId);
  for await (const item of page as unknown as AsyncIterable<Record<string, unknown>>) {
    if (item.type !== 'memory') continue;
    const path = typeof item.path === 'string' ? item.path : '';
    const id = typeof item.id === 'string' ? item.id : '';
    if (!path || !id) continue;
    const sha = typeof item.content_sha256 === 'string' ? item.content_sha256 : '';
    out.set(path, { id, sha256: sha });
  }
  return out;
}

/**
 * `_retrieve_memory_content` + `_memory_item_content` の TS port.
 * SDK の `retrieve` は `content` を string で返すのが現状の正規挙動
 * だが、Python は安全側に `list[str | dict | obj]` を join する fallback を
 * 持つので等価実装する.
 */
async function retrieveMemoryContent(
  client: Anthropic,
  memoryStoreId: string,
  memoryId: string,
): Promise<string> {
  const item = await client.beta.memoryStores.memories.retrieve(memoryId, {
    memory_store_id: memoryStoreId,
  });
  const content = (item as { content?: unknown }).content;
  return extractMemoryItemContent(content);
}

/**
 * `_memory_item_content` の TS port. 文字列 / list / `.text` を持つ block
 * 等を吸収して 1 文字列に畳む.
 */
export function extractMemoryItemContent(content: unknown): string {
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

// ============================================================================
// Internal utilities
// ============================================================================

/**
 * UTC `Date` を JST に変換し、`{dateLabel: 'YYYY-MM-DD', eventTime:
 * 'YYYY-MM-DDTHH:MM:SS+09:00'}` を返す純関数. Python の
 * `now.astimezone(JST).date().isoformat()` / `.isoformat(timespec='seconds')`
 * と等価.
 */
function formatJstDateAndTime(now: Date): { dateLabel: string; eventTime: string } {
  // JST = UTC+9. `getTime()` は UTC ms なので 9h ずらした「擬似 JST UTC」を
  // 計算してから getUTC* で抽出する (タイムゾーン依存の env に左右されない).
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = jst.getUTCFullYear().toString().padStart(4, '0');
  const mm = (jst.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = jst.getUTCDate().toString().padStart(2, '0');
  const hh = jst.getUTCHours().toString().padStart(2, '0');
  const mi = jst.getUTCMinutes().toString().padStart(2, '0');
  const ss = jst.getUTCSeconds().toString().padStart(2, '0');
  return {
    dateLabel: `${yyyy}-${mm}-${dd}`,
    eventTime: `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+09:00`,
  };
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
