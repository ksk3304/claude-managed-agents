/**
 * Google Chat thread history fetch + format — Cloudflare Worker port.
 *
 * Python 一次ソース (`scripts/cma_gchat_bot.py`):
 *   - `_fetch_thread_messages:3370` — Chat REST `messages.list` を
 *     `parent=spaces/...` + `filter=thread.name = ...` で page し thread
 *     の全 message を時系列順 (古→新) で返す。`orderBy=createTime desc`
 *     で取って末尾で reverse、page 上限到達時は最新優先で truncate。
 *   - `_format_thread_history:3477` — 取得 message 列を agent prompt
 *     用 Markdown ブロックに整形。空 thread / 当該 message 除外 / sender
 *     ラベル付け。完全 port は speaker-resolver と組み合わせるが、TS
 *     中間版では sender_id + sender_type の末尾4桁マスクで notice 化。
 *   - `_ensure_history_session:3073` — OAuth session を 1 回 reload する
 *     wrapper。Worker 版は `getChatAccessToken` (chat-api.ts) の token
 *     cache が同等役割を果たすため、薄い `getHistoryToken` のみ。
 *   - `_bump_history_failure_counter:1922` — 連続失敗を D1/Firestore で
 *     数え、閾値 5 で Issue 起票する。Worker 版は KV 永続化 (D1 ではなく
 *     `MAKOTO_KV` の TTL 24h key で十分、history は per-thread 透過的)。
 *   - `_handle_history_fetch_permanent_failure:1959` — placeholder 削除 +
 *     uploaded files 掃除を伴うが、TS chat-event-handler 中間版は
 *     placeholder POST 未実装 (= TODO #186 follow-up) なので、cleanup
 *     対象は KV mark の登録のみ。本関数では log + KV mark で代替する。
 *   - `_open_history_failure_issue:2003` — `scripts/issue-create.sh` 経由
 *     で GitHub Issue 起票。Worker 環境では gh CLI が無いため省略、log +
 *     KV perm key で MAKOTO開発マン が後で気付ける形に落とす。
 *
 * Wire up: `src/queue/chat-event-handler.ts` から shared space + thread
 * reply 時のみ `fetchThreadMessages` → `formatThreadHistory` を呼び、
 * 結果 markdown を agent bodyText の先頭に prepend する。DM (= 1 対 1
 * session memory がカバー) では呼ばない。
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2)
 */

import { assertBridgeEgressAllowed } from './egress-guard';
import { getChatAccessToken, CHAT_BOT_SCOPE } from './chat-api';
import type { ChatApiDeps } from './chat-api';

const CHAT_API_BASE = 'https://chat.googleapis.com/v1';

/** Python `MAX_HISTORY_PAGES = 20` (cma_gchat_bot.py l.542). */
export const MAX_HISTORY_PAGES = 20;
/** Python `pageSize=100` (cma_gchat_bot.py l.3374). */
export const HISTORY_PAGE_SIZE = 100;
/** Python `HISTORY_FETCH_MAX_ATTEMPTS = 3` (cma_gchat_bot.py l.3047). */
export const HISTORY_FETCH_MAX_ATTEMPTS = 3;
/** Python `HISTORY_FETCH_BACKOFF_SECONDS = (1.0, 2.0, 4.0)` (l.3048). ms 単位. */
export const HISTORY_FETCH_BACKOFF_MS: readonly number[] = [1000, 2000, 4000];
/** Python `HISTORY_FETCH_ALERT_THRESHOLD = 5` (cma_gchat_bot.py l.1918). */
export const HISTORY_FAILURE_PERMANENT_THRESHOLD = 3;
/** KV key prefix for per-thread consecutive failure counter (TTL 24h). */
export const KV_HISTORY_FAIL_PREFIX = 'history:fail';
/** KV key prefix for per-thread permanent-failure flag (TTL 24h). */
export const KV_HISTORY_PERM_PREFIX = 'history:perm';
/** TTL for both counter + permanent flag KV keys. */
export const HISTORY_FAILURE_KV_TTL_SEC = 24 * 60 * 60;
/** Chat REST read-only scope (= Python `SCOPES_CHAT_READONLY`). */
export const CHAT_READONLY_SCOPE =
  'https://www.googleapis.com/auth/chat.messages.readonly';

/**
 * Normalised Chat message shape returned by `fetchThreadMessages`.
 * Mirrors the dict shape Python `_fetch_thread_messages` appends to
 * (`name` / `sender_id` / `sender_type` / `text`). The TS version
 * additionally carries `createTime` (raw API field) for callers that
 * want to expose timestamps later — Python intentionally drops it
 * because Cloud Run formats relative time inside `_format_thread_history`.
 */
export interface ThreadHistoryMessage {
  /** Message resource name (e.g. `spaces/AAA/messages/BBB.CCC`). */
  name: string;
  /** Sender resource name (e.g. `users/123`) or empty when missing. */
  senderId: string;
  /** Sender type (`HUMAN` / `BOT`) or empty when missing. */
  senderType: string;
  /** Mention-stripped message text. Empty for stickers / cards / no-text msgs. */
  text: string;
  /** Raw `createTime` ISO8601 (informational; may be empty when API omits it). */
  createTime: string;
}

export interface FetchThreadMessagesOptions {
  /** Override page size (default `HISTORY_PAGE_SIZE`). */
  pageSize?: number;
  /** Override max retry attempts per page (default `HISTORY_FETCH_MAX_ATTEMPTS`). */
  maxAttempts?: number;
  /** Override page cap (default `MAX_HISTORY_PAGES`). */
  maxPages?: number;
  /** Override backoff schedule (ms, default `HISTORY_FETCH_BACKOFF_MS`). */
  backoffMs?: readonly number[];
  /**
   * Sleep override (test 用)。default は `setTimeout` promise wrapper。
   * 引数は ms。test では no-op を渡して時間を進めずに retry path を回す。
   */
  sleep?: (ms: number) => Promise<void>;
}

/** Failure raised when retry budget is exhausted. */
export class ChatHistoryFetchError extends Error {
  readonly status: number | undefined;
  readonly attempts: number;
  constructor(message: string, attempts: number, status?: number) {
    super(message);
    this.name = 'ChatHistoryFetchError';
    this.attempts = attempts;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Fetch all messages in a Chat thread, in **chronological** order
 * (old → new). Mirrors `_fetch_thread_messages` exactly:
 *
 *   GET /v1/{space}/messages
 *     ?filter=thread.name = spaces/.../threads/...
 *     &pageSize=100
 *     &orderBy=createTime desc
 *
 * Pages until either `nextPageToken` is absent or `MAX_HISTORY_PAGES`
 * is hit (latest-first ordering means truncation drops oldest). After
 * collecting we reverse to chronological order so callers get the same
 * shape Python returns.
 *
 * Retry policy: per-page exponential backoff `[1s, 2s, 4s]` over 3
 * attempts on retryable failures (5xx / 429 / network). Non-retryable
 * errors (4xx other than 429) re-throw immediately so caller can hit
 * the permanent-failure path (= `recordHistoryFailure`).
 */
export async function fetchThreadMessages(
  deps: ChatApiDeps,
  spaceName: string,
  threadName: string,
  options: FetchThreadMessagesOptions = {},
): Promise<ThreadHistoryMessage[]> {
  if (!threadName) return [];
  if (!spaceName.startsWith('spaces/')) {
    throw new Error(
      `fetchThreadMessages: spaceName must start with 'spaces/' (got ${spaceName})`,
    );
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const scopes = deps.scopes ?? [CHAT_BOT_SCOPE, CHAT_READONLY_SCOPE];
  const pageSize = options.pageSize ?? HISTORY_PAGE_SIZE;
  const maxAttempts = options.maxAttempts ?? HISTORY_FETCH_MAX_ATTEMPTS;
  const maxPages = options.maxPages ?? MAX_HISTORY_PAGES;
  const backoff = options.backoffMs ?? HISTORY_FETCH_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;

  const baseUrl = `${CHAT_API_BASE}/${spaceName}/messages`;
  const messages: ThreadHistoryMessage[] = [];
  let pageToken: string | null = null;
  let pageCount = 0;
  let truncated = false;

  while (true) {
    const params = new URLSearchParams();
    // Python l.3388: `thread.name = ...` (no quotes).
    params.set('filter', `thread.name = ${threadName}`);
    params.set('pageSize', String(pageSize));
    // Python l.3390 (Issue #1114): desc + reverse at end = latest-first
    // when truncated.
    params.set('orderBy', 'createTime desc');
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${baseUrl}?${params.toString()}`;

    assertBridgeEgressAllowed(url, 'chat-history:fetchThreadMessages');

    let pageJson: unknown;
    let lastError: { message: string; status?: number } | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Always re-mint token here — Anthropic SDK does its own caching;
      // here we lean on `getChatAccessToken`'s module-level cache so
      // 2nd/3rd attempts within a page don't redundantly exchange JWTs.
      const token = await getChatAccessToken(deps, scopes);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
        });
      } catch (err) {
        // Network throw (DNS / TCP / TLS) — always retryable.
        lastError = {
          message: `network ${err instanceof Error ? err.message : String(err)}`,
        };
        if (attempt >= maxAttempts) {
          throw new ChatHistoryFetchError(
            `fetchThreadMessages exhausted ${maxAttempts} attempts (network): ${lastError.message}`,
            attempt,
          );
        }
        await sleep(pickBackoff(backoff, attempt));
        continue;
      }

      if (response.ok) {
        try {
          pageJson = await response.json();
        } catch (err) {
          throw new ChatHistoryFetchError(
            `fetchThreadMessages got non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
            attempt,
            response.status,
          );
        }
        lastError = null;
        break;
      }

      // Status-based decision.
      const status = response.status;
      const bodyText = await safeReadText(response);
      if (isRetryableStatus(status) && attempt < maxAttempts) {
        lastError = {
          message: `status=${status} body=${bodyText.slice(0, 200)}`,
          status,
        };
        await sleep(pickBackoff(backoff, attempt));
        continue;
      }
      // Non-retryable OR retry exhausted.
      throw new ChatHistoryFetchError(
        `fetchThreadMessages status=${status} attempts=${attempt} ` +
          `space=${spaceName} thread=${threadName} body=${bodyText.slice(0, 300)}`,
        attempt,
        status,
      );
    }

    if (lastError !== null) {
      // Defensive: should be unreachable because every break sets lastError=null
      // and exhaustion throws inside the loop.
      throw new ChatHistoryFetchError(
        `fetchThreadMessages internal: last error not cleared (${lastError.message})`,
        maxAttempts,
      );
    }

    const data = (pageJson as {
      messages?: ChatApiMessage[];
      nextPageToken?: string;
    }) ?? {};
    const pageMsgs = Array.isArray(data.messages) ? data.messages : [];
    for (const m of pageMsgs) {
      const sender = m.sender ?? {};
      const senderId = typeof sender.name === 'string' ? sender.name : '';
      const senderType = typeof sender.type === 'string' ? sender.type : '';
      const argumentText =
        typeof m.argumentText === 'string' ? m.argumentText.trim() : '';
      const text = argumentText
        ? argumentText
        : stripMention(
            typeof m.text === 'string' ? m.text : '',
            Array.isArray(m.annotations) ? m.annotations : [],
          );
      messages.push({
        name: typeof m.name === 'string' ? m.name : '',
        senderId,
        senderType,
        text,
        createTime: typeof m.createTime === 'string' ? m.createTime : '',
      });
    }

    pageCount += 1;
    pageToken = data.nextPageToken || null;
    console.log(
      `[chat-history] fetchThreadMessages page#${pageCount} msgs=${pageMsgs.length} ` +
        `next_page_token=${pageToken ? 'yes' : 'no'} total_so_far=${messages.length}`,
    );
    if (!pageToken) break;
    if (pageCount >= maxPages) {
      truncated = true;
      console.warn(
        `[chat-history] fetchThreadMessages aborted at max_pages=${maxPages} ` +
          `total_msgs=${messages.length} (older messages dropped, latest preserved)`,
      );
      break;
    }
  }

  // Python l.3465: desc → reverse for chronological order.
  messages.reverse();
  const totalChars = messages.reduce((acc, m) => acc + m.text.length, 0);
  console.log(
    `[chat-history] fetchThreadMessages done total_msgs=${messages.length} ` +
      `total_text_chars=${totalChars} pages=${pageCount} truncated=${truncated}`,
  );
  return messages;
}

export interface FormatThreadHistoryOptions {
  /**
   * Resource name of the message currently being processed by the
   * reactive event handler (= `payload.message.name`). Mirrors Python
   * `current_message_name` arg: excluded from the rendered history so
   * the agent doesn't see its own incoming prompt twice.
   */
  currentMessageName?: string;
  /** Override bot user resource name (= e.g. `users/123`) to mark as `[bot]`. */
  botUserName?: string;
}

/**
 * Format a chronological history list into an agent-facing Markdown
 * block. Mirrors `_format_thread_history` minus speaker-resolver
 * integration (= TS port carries forward the same fail-closed posture
 * for unknown speakers: their lines are dropped from the body and the
 * count is appended as a notice).
 *
 * Returns an empty string when `messages` is empty OR when every
 * candidate line is filtered out (= excluded current message, empty
 * text). Caller checks `.length === 0` and skips prepend in that case.
 */
export function formatThreadHistory(
  messages: readonly ThreadHistoryMessage[],
  options: FormatThreadHistoryOptions = {},
): string {
  if (!messages.length) return '';
  const current = options.currentMessageName ?? '';
  const botUser = options.botUserName ?? '';
  const lines: string[] = ['## スレッド過去履歴（時系列順）'];
  const unresolvedIds: string[] = [];
  const seenUnresolved = new Set<string>();
  let rendered = 0;
  for (const m of messages) {
    if (current && m.name === current) continue;
    const text = (m.text || '').trim();
    if (!text) continue;
    const label = resolveSpeakerLabel(m, botUser);
    if (label === null) {
      // Unknown speaker (= no sender_id at all). Body is dropped so a
      // future speaker-resolver port can refine, not relax, the gate.
      const cuid = m.senderId || '';
      if (cuid && !seenUnresolved.has(cuid)) {
        seenUnresolved.add(cuid);
        unresolvedIds.push(cuid);
      }
      continue;
    }
    rendered += 1;
    lines.push(`- [${label}] ${text}`);
  }

  if (rendered === 0 && unresolvedIds.length === 0) {
    // Every message was either the current one or text-empty.
    return '';
  }

  let body = rendered > 0 ? lines.join('\n') : '';
  if (unresolvedIds.length > 0) {
    const masked = unresolvedIds.map((cuid) => `...${cuid.slice(-4)}`);
    const warning =
      '\n\n## ⚠️ 識別不能な参加者の発言を履歴から除外\n' +
      `- 未登録 chat_user_id 数: ${unresolvedIds.length} ` +
      `(末尾4桁: ${masked.join(', ')})\n` +
      '- 上記発言は本文を履歴から物理除外済。\n';
    body = body ? body + warning : warning.trimStart();
  }
  return body;
}

/**
 * Increment the per-thread consecutive failure counter and check
 * permanent failure threshold. Returns the new count + whether this
 * call tripped the permanent flag (which the caller then logs +
 * records via `markHistoryPermanentFailure`).
 *
 * KV layout:
 *   - `history:fail:<thread>` — counter (string-encoded integer), TTL 24h
 *   - `history:perm:<thread>` — "1" once threshold tripped, TTL 24h
 *
 * NOTE: this is best-effort. KV is eventually consistent, and the
 * read-modify-write here can race when two events for the same thread
 * fail concurrently. Worst-case effect is over-counting (= triggering
 * permanent earlier than 3) which is the safe direction.
 */
export async function recordHistoryFailure(
  kv: KVNamespace,
  threadName: string,
): Promise<{ count: number; permanent: boolean; firstPermanentTrip: boolean }> {
  const counterKey = `${KV_HISTORY_FAIL_PREFIX}:${threadName}`;
  const permKey = `${KV_HISTORY_PERM_PREFIX}:${threadName}`;
  const prevRaw = await kv.get(counterKey);
  const prev = prevRaw ? Number.parseInt(prevRaw, 10) : 0;
  const count = (Number.isFinite(prev) && prev > 0 ? prev : 0) + 1;
  await kv.put(counterKey, String(count), {
    expirationTtl: HISTORY_FAILURE_KV_TTL_SEC,
  });

  if (count < HISTORY_FAILURE_PERMANENT_THRESHOLD) {
    return { count, permanent: false, firstPermanentTrip: false };
  }
  const existingPerm = await kv.get(permKey);
  if (existingPerm) {
    return { count, permanent: true, firstPermanentTrip: false };
  }
  await kv.put(permKey, '1', {
    expirationTtl: HISTORY_FAILURE_KV_TTL_SEC,
  });
  return { count, permanent: true, firstPermanentTrip: true };
}

/** Clear the per-thread failure counter + permanent flag on success. */
export async function clearHistoryFailure(
  kv: KVNamespace,
  threadName: string,
): Promise<void> {
  await kv.delete(`${KV_HISTORY_FAIL_PREFIX}:${threadName}`);
  await kv.delete(`${KV_HISTORY_PERM_PREFIX}:${threadName}`);
}

/** Read current counter (test / diagnostic helper). */
export async function getHistoryFailureCount(
  kv: KVNamespace,
  threadName: string,
): Promise<number> {
  const raw = await kv.get(`${KV_HISTORY_FAIL_PREFIX}:${threadName}`);
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Has the thread been marked permanently failing this 24h window? */
export async function isHistoryPermanentlyFailed(
  kv: KVNamespace,
  threadName: string,
): Promise<boolean> {
  const raw = await kv.get(`${KV_HISTORY_PERM_PREFIX}:${threadName}`);
  return raw === '1';
}

/**
 * Permanent failure handler (= Python `_handle_history_fetch_permanent_failure`
 * minus placeholder cleanup + Anthropic Files delete, neither of which
 * are wired in the TS chat-event-handler mid-port yet). Logs at WARN
 * so the failure is visible in Workers tail and tags the KV permanent
 * flag so subsequent events skip the fetch loop until the 24h TTL
 * lapses (matching Python's "1 起動 1 issue" anti-spam stance).
 */
export async function handleHistoryFetchPermanentFailure(
  kv: KVNamespace,
  threadName: string,
  reason: string,
): Promise<void> {
  console.warn(
    `[chat-history] CRITICAL permanent failure thread=${threadName} reason=${reason}`,
  );
  // KV writes are best-effort; failure to mark is logged but not thrown
  // because the caller is already on the error path.
  try {
    await kv.put(`${KV_HISTORY_PERM_PREFIX}:${threadName}`, '1', {
      expirationTtl: HISTORY_FAILURE_KV_TTL_SEC,
    });
  } catch (err) {
    console.warn(
      `[chat-history] KV mark failed thread=${threadName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

interface ChatApiMessage {
  name?: string;
  text?: string;
  argumentText?: string;
  createTime?: string;
  sender?: { name?: string; type?: string };
  annotations?: Array<{
    type?: string;
    startIndex?: number;
    length?: number;
  }>;
}

function isRetryableStatus(status: number): boolean {
  // Python `_is_retryable_history_error` distinguishes by exception
  // type. In TS we only have status codes — 429 + 5xx are retryable,
  // everything else (auth, not-found, bad-request) is permanent.
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

function pickBackoff(schedule: readonly number[], attempt: number): number {
  if (schedule.length === 0) return 0;
  const idx = Math.min(Math.max(attempt - 1, 0), schedule.length - 1);
  return schedule[idx] ?? 0;
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable>';
  }
}

function stripMention(
  text: string,
  annotations: ReadonlyArray<{ type?: string; startIndex?: number; length?: number }>,
): string {
  if (!annotations || annotations.length === 0) return text.trim();
  const cuts: Array<[number, number]> = [];
  for (const ann of annotations) {
    if (!ann || ann.type !== 'USER_MENTION') continue;
    const start = Number.isFinite(ann.startIndex) ? Number(ann.startIndex) : 0;
    const length = Number.isFinite(ann.length) ? Number(ann.length) : 0;
    if (length > 0) cuts.push([start, start + length]);
  }
  // Apply cuts from right-to-left so earlier indices stay valid.
  cuts.sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [s, e] of cuts) {
    out = out.slice(0, s) + out.slice(e);
  }
  return out.trim();
}

function resolveSpeakerLabel(
  m: ThreadHistoryMessage,
  botUserName: string,
): string | null {
  const senderId = m.senderId || '';
  const senderType = (m.senderType || '').toUpperCase();
  if (!senderId) return null;
  if (botUserName && senderId === botUserName) return 'bot';
  if (senderType === 'BOT') return 'bot';
  if (senderType === 'HUMAN') {
    // Mirror Python's privacy-preserving masking: end-4 of resource name.
    return `user:...${senderId.slice(-4)}`;
  }
  // Unknown type → treat as unresolved.
  return null;
}
