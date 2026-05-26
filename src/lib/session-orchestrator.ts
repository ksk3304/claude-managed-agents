/**
 * Session orchestrator — Google Chat reactive event 1 件分の
 * **session 構築 + LLM 呼出 + stream consume** をまとめる lib.
 *
 * Cloud Run の `cma_gchat_bot.py:_handle_event` (l.3784, ~1,668 行) のうち
 * 「sessions.create or 既存 thread session 検索 → user message 組み立て →
 *  sendAndStreamWithToolDispatch」核心部分のみ TS port。本 lib では
 * marker parse / AgentMail send / current space 投稿 / session-log append
 * は扱わない (= `chat-event-handler.ts` の責務)。
 *
 * envelope 完全版 (cap-recovery + intent + speaker prefix + history + roster)
 * は `src/lib/user-message-envelope.ts` の `buildUserMessageEnvelope` に集約済。
 * 本 orchestrator は input から opts を構築して helper に委譲するだけ。
 * 全層 opt-in 設計のため、未指定層は 0 bytes として落ちる = 中間版互換
 * (最小 envelope) は維持されたまま、caller が段階的に層を有効化できる。
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 #5 — Google Chat reactive bot, Phase B)
 * Spec: Day 3 subagent G task brief §設計確定事項 1
 * Source of truth (Python):
 *   - scripts/cma_gchat_bot.py l.494-512 (_session_key_for_thread)
 *   - scripts/cma_gchat_bot.py l.3784-       (_handle_event)
 */

import type Anthropic from '@anthropic-ai/sdk';

import type { UserMappingValue } from './memory-attach';
import {
  buildAnthropicClient,
  createSessionWithResources,
  sendAndStreamWithToolDispatch,
  type SendAndStreamResult,
  type ToolDispatcher,
  type UserMessageContentBlock,
} from './session';
import {
  buildMakotoSystemPrompt,
  logPromptSource,
  type SystemPromptResult,
} from './persona-builder';
import { toResourceParam } from '../types/memory';
import type { MemoryStoreResourceParam } from '../types/memory';
import {
  buildUserMessageEnvelope,
  type IntentEnvelopeOption,
  type SpeakerEnvelopeOption,
  type CapEnvelopeOption,
} from './user-message-envelope';

/** KV key prefix for thread → session lookup. TTL 24h. */
export const KV_CHAT_THREAD_SESSION_PREFIX = 'chat_thread_session';
const KV_CHAT_THREAD_SESSION_TTL_SEC = 24 * 60 * 60;

/** Session stream wall-time cap. Workers Queue consumer = 15 min budget. */
const SESSION_STREAM_TIMEOUT_MS = 110_000;

/**
 * `_session_key_for_thread` (Python l.494-512) と byte 等価な KV key を
 * 組み立てる純関数。sender_email + space + thread の三つ組で per-user per-thread
 * に振り分ける (issue #1119 = per-user 化)。いずれかが空なら null を返し、
 * 毎回新規 session として扱わせる (fail-closed)。
 */
export function chatThreadSessionKey(
  senderEmail: string,
  spaceName: string,
  threadName: string | null | undefined,
): string | null {
  const email = (senderEmail || '').trim().toLowerCase();
  const space = (spaceName || '').trim();
  const thread = (threadName || '').trim();
  if (!email || !space || !thread) return null;
  return `${KV_CHAT_THREAD_SESSION_PREFIX}:${email}:${space}:${thread}`;
}

/**
 * orchestrator が必要とする per-event 入力一式。
 * - `senderEmail` は正規化済 (lowercase) を渡すこと。
 * - `userMapping` は `readUserMapping` の戻り値 (= user_slug / agent_id /
 *   memory_attachments を保有)。
 * - `personaSpec` / `toolsSpec` は静的 import 済の文字列 (caller が
 *   `src/data/persona-spec.ts` 等から渡す。orchestrator は持たない)。
 * - `toolDispatcher` は MAKOTOくん 10 tool dispatcher を bind 済の関数。
 *   caller (chat-event-handler) が `dispatchMakotoTool` を bind して渡す。
 */
export interface OrchestrateChatTurnInput {
  env: Env;
  /** Pre-built Anthropic client. Falsy when ANTHROPIC_API_KEY missing. */
  client: Anthropic | null;
  senderEmail: string;
  spaceName: string;
  spaceType: string;
  threadName: string | null;
  bodyText: string;
  userMapping: UserMappingValue;
  personaSpec: string;
  toolsSpec: string;
  toolDispatcher: ToolDispatcher;
  /**
   * 追加 content blocks (= image / document / 追加 text)。Cloud Run の
   * `_build_user_message` 経路相当 — 添付処理 helper が組み立てた blocks
   * をここに渡すと最小 envelope の text block の後ろに連結される。空配列
   * または未指定なら従来通り text-only。
   */
  extraContentBlocks?: UserMessageContentBlock[];
  /** Override KV (test 用)。未指定なら env.MAKOTO_KV を使う. */
  kv?: KVNamespace;
  /** Stream timeout override (test 用)。 */
  timeoutMs?: number;
  /**
   * Action skill (= attach_memory=false) 起動時に true で渡す (Issue #186
   * 既知 #4 intent-detector 統合)。
   *
   * true のとき:
   *   - KV thread session lookup を skip (= 既存 session を再利用しない)
   *   - sessions.create で生成した新 sessionId を KV put しない
   *     (= 次ターン以降も ephemeral 経路を踏ませる)
   *
   * 効果: Cloud Run `cma_gchat_bot.py:_handle_event:l.4002-4013` 等価。
   * 「スレッド 2 通目以降の "メールして" が前セッションの memory + bash
   * 前提で暴走する」(incident 2026-05-08 同根) を防ぐ。
   */
  forceFreshSession?: boolean;
  /**
   * Python `history_md` (cma_gchat_bot.py l.4194) と byte 等価の thread
   * history block。非空時のみ envelope の body 直前に `\n\n## 今回のメンション\n`
   * を挟んで連結される。caller (chat-event-handler) が `formatThreadHistory`
   * の結果をそのまま渡す責務。未指定 = history なし (旧挙動互換).
   */
  historyBlock?: string;
  /**
   * 検出済 intent label (= `detectActionSkillIntent` の結果)。未指定なら
   * envelope に何も挿入しない (= 旧挙動互換)。指定時は `<intent>` tag で
   * agent context に hint として注入される (TS port 拡張点).
   */
  intent?: IntentEnvelopeOption;
  /**
   * speaker context block の Python 完成形 (= `_build_space_context_block`
   * の出力)。未指定 / 空文字なら最小 `<context>space_type=... sender=...</context>`
   * のみ (= 旧挙動互換).
   */
  speakerContextBlock?: string;
  /**
   * roster block (Python `_build_space_roster_block` 出力)。未指定 / 空文字
   * なら envelope に 0 bytes (= 旧挙動互換).
   */
  rosterBlock?: string;
  /**
   * cap-recovery turn opt-in。`{recovery: true}` 時 body は RECOVERY_PROMPT
   * で完全差し替え (Python recovery semantics)。未指定 = 通常 turn (旧挙動互換).
   */
  cap?: CapEnvelopeOption;
}

export interface OrchestrateChatTurnResult {
  sessionId: string;
  /** 新規 sessions.create したか (= true なら KV put 済)。 */
  isNewSession: boolean;
  /** stream の最終 assistantText (marker 含む raw 文字列). */
  assistantText: string;
  /** stream 終端 event type (`session.status_idle` / `session.status_terminated` / etc.). */
  terminalEventType?: string;
  /**
   * `sendAndStreamWithToolDispatch` が返した stop reason (= Python
   * `_stop_reason_type` 等価)。cap 超過判定 (cap-recovery wire up #186 既知 #3)
   * で caller が参照する。値は session.ts 側の決定 = `'end_turn'` /
   * `'tool_call_cap'` / `'custom_tool_call_cap'` / `'session_watchdog'` /
   * `'stream_terminated'` / `'events_send_failed'` 等。
   */
  stopReason?: string;
  /** 起動ログ用に取得した system prompt sha 等。caller が必要なら参照. */
  systemPromptInfo: SystemPromptResult;
}

/**
 * orchestrator の致命的エラー型。caller (chat-event-handler) が
 * msg.retry() か commit か判定する。
 *   - `no_anthropic_client`     — ANTHROPIC_API_KEY 未設定 / buildAnthropicClient null
 *   - `sessions_create_failed`  — sessions.create 失敗 (transient = retry 推奨)
 *   - `stream_failed`           — sendAndStreamWithToolDispatch throw (timeout / SDK error)
 */
export type OrchestratorFailureReason =
  | 'no_anthropic_client'
  | 'sessions_create_failed'
  | 'stream_failed';

export class OrchestratorFailure extends Error {
  readonly reason: OrchestratorFailureReason;
  readonly cause?: unknown;
  constructor(reason: OrchestratorFailureReason, message: string, cause?: unknown) {
    super(message);
    this.name = 'OrchestratorFailure';
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * 1 reactive turn を駆動する。
 *
 * 流れ:
 *   1. `client` が null なら `OrchestratorFailure('no_anthropic_client')` を throw
 *   2. thread session key を組み立て KV を引く (key が null = 必ず新規)
 *   3. KV hit なら既存 sessionId を再利用、miss なら sessions.create + KV put
 *   4. system prompt 起動ログを 1 回出力 (drift 検出用)
 *   5. user message envelope を組み立てて `sendAndStreamWithToolDispatch` で
 *      stream consume
 *   6. assistantText + sessionId を返す (marker parse は caller 責務)
 *
 * 注意: `systemPromptInfo` は **session.create には渡していない**
 * (= persona は Anthropic Console 側で agent に紐付け済の前提)。
 * 本 lib は drift 監視のための sha ログを吐く責務を担うのみ。
 * caller が persona を per-session で差し込みたい (= 動的 system prompt
 * addendum) なら `// TODO(#186 follow-up): system prompt addendum` 経路を
 * 起こす。
 */
export async function orchestrateChatTurn(
  input: OrchestrateChatTurnInput,
): Promise<OrchestrateChatTurnResult> {
  if (input.client === null) {
    throw new OrchestratorFailure(
      'no_anthropic_client',
      'ANTHROPIC_API_KEY missing — cannot drive session',
    );
  }
  const client = input.client;
  const kv = input.kv ?? input.env.MAKOTO_KV;

  // ---- system prompt sha ログ (drift 監視) ----
  let systemPromptInfo: SystemPromptResult;
  try {
    systemPromptInfo = await buildMakotoSystemPrompt(input.personaSpec, input.toolsSpec);
    logPromptSource(systemPromptInfo, { stage: 'reactive' });
  } catch (err) {
    // persona/tools spec の build 失敗は致命ではないが警告は出す。
    // Cloud Run と同じく persona-only fallback で動かす (= 旧挙動)。
    console.warn(
      `[chat-event] system prompt build failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    systemPromptInfo = {
      systemPrompt: input.personaSpec || '',
      personaBytes: 0,
      personaSha256: 'failed',
      toolsBytes: 0,
      toolsSha256: 'failed',
      toolsSectionFound: false,
    };
  }

  // ---- thread session 解決 ----
  // `forceFreshSession=true` のときは KV lookup を skip (= 既存 session を
  // 再利用しない、Issue #186 既知 #4 intent-detector 統合)。Cloud Run
  // `_handle_event:l.4002-4013` 等価で「スレッド 2 通目以降の メールして」
  // が前セッションの memory + bash 前提で暴走する」を防ぐ。
  const sessionKey = chatThreadSessionKey(
    input.senderEmail,
    input.spaceName,
    input.threadName,
  );
  let sessionId: string | null = null;
  if (sessionKey !== null && !input.forceFreshSession) {
    try {
      sessionId = await kv.get(sessionKey);
    } catch (err) {
      console.warn(
        `[chat-event] KV get failed key=${sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // KV 失敗は致命ではない — 新規 session で続行
      sessionId = null;
    }
  }

  let isNewSession = false;
  if (sessionId === null) {
    const resources: MemoryStoreResourceParam[] =
      input.userMapping.memory_attachments.map(toResourceParam);
    try {
      sessionId = await createSessionWithResources(client, {
        agentId: input.userMapping.agent_id,
        environmentId: input.env.ENVIRONMENT_ID,
        resources,
      });
    } catch (err) {
      throw new OrchestratorFailure(
        'sessions_create_failed',
        `sessions.create failed for agent=${input.userMapping.agent_id}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    isNewSession = true;
    console.log(
      `[chat-event] created session=${sessionId} agent=${input.userMapping.agent_id} ` +
        `user=${input.userMapping.user_slug} space=${input.spaceName}` +
        (input.forceFreshSession ? ' ephemeral=true' : ''),
    );
    // `forceFreshSession=true` のときは KV put も skip (= 次ターン以降も
    // 毎回 ephemeral 経路を踏ませる)。Cloud Run `_handle_event:l.4010-4013`
    // 「session_key = None で thread_sessions に保存しない」と等価。
    if (sessionKey !== null && !input.forceFreshSession) {
      try {
        await kv.put(sessionKey, sessionId, {
          expirationTtl: KV_CHAT_THREAD_SESSION_TTL_SEC,
        });
      } catch (err) {
        // KV put 失敗は次回が新規 session になるだけ — 致命ではない
        console.warn(
          `[chat-event] KV put failed key=${sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } else {
    console.log(
      `[chat-event] continuing session=${sessionId} agent=${input.userMapping.agent_id} ` +
        `user=${input.userMapping.user_slug} space=${input.spaceName}`,
    );
  }

  // ---- user message envelope ----
  // 完全版 envelope: cap-recovery + intent + speaker prefix + history + roster
  // を `buildUserMessageEnvelope` 純関数で組み立てる (Python と byte 等価層は
  // history / mention header / speaker context block / RECOVERY_PROMPT)。
  // 全層 opt-in 設計で、caller が未指定の層は 0 bytes として落ちるため、
  // 中間版互換 (最小 envelope) は opts なしで同形に保たれる (= 回帰なし).
  const speakerOpt: SpeakerEnvelopeOption = {
    spaceType: input.spaceType || 'UNKNOWN',
    senderEmail: input.senderEmail,
  };
  if (input.speakerContextBlock) {
    speakerOpt.contextBlock = input.speakerContextBlock;
  }
  const envelopeOpts: Parameters<typeof buildUserMessageEnvelope>[1] = {
    speaker: speakerOpt,
  };
  if (input.historyBlock) envelopeOpts.history = input.historyBlock;
  if (input.intent) envelopeOpts.intent = input.intent;
  if (input.rosterBlock) envelopeOpts.roster = input.rosterBlock;
  if (input.cap) envelopeOpts.cap = input.cap;
  const userMessageText = buildUserMessageEnvelope(input.bodyText, envelopeOpts);

  // 添付処理 (Issue #186 既知 #1 + O) で組み立てた image / document / text blocks
  // があれば text の後ろに連結する。Cloud Run `cma_gchat_bot.py` では
  // `messages.create(messages=[{"role":"user","content":[text, image, document...]}])`
  // と並ぶ形式を取っており、Workers 側も同じ並び順を踏襲する (= 文書内容を
  // 読ませる前に user 意図 text を提示)。
  const extraBlocks = input.extraContentBlocks ?? [];
  const userMessage: string | UserMessageContentBlock[] =
    extraBlocks.length === 0
      ? userMessageText
      : [{ type: 'text', text: userMessageText }, ...extraBlocks];

  // ---- stream consume ----
  let streamResult: SendAndStreamResult;
  try {
    streamResult = await sendAndStreamWithToolDispatch(client, {
      sessionId,
      userMessage,
      toolDispatcher: input.toolDispatcher,
      timeoutMs: input.timeoutMs ?? SESSION_STREAM_TIMEOUT_MS,
    });
  } catch (err) {
    throw new OrchestratorFailure(
      'stream_failed',
      `sendAndStreamWithToolDispatch failed session=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const result: OrchestrateChatTurnResult = {
    sessionId,
    isNewSession,
    assistantText: streamResult.assistantText,
    systemPromptInfo,
  };
  if (streamResult.terminalEventType !== undefined) {
    result.terminalEventType = streamResult.terminalEventType;
  }
  if (streamResult.stopReason !== undefined) {
    result.stopReason = streamResult.stopReason;
  }
  return result;
}

/**
 * Re-export `buildAnthropicClient` so chat-event-handler can build the
 * client in one place. Kept here (= not re-exported from session.ts
 * twice) so the orchestrator boundary is the single import surface for
 * the consumer.
 */
export { buildAnthropicClient };
