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

import { skillsHash, toolsHash } from './agent-cache';
import {
  buildAllManagedAgentSkills,
  ensureManagedAgentSkills,
  hasAttachedSkills,
} from './attached-skills';
import { MAKOTO_AGENT_TOOLS } from './makoto-capability-registry';
import { ensureManagedAgentTools } from './managed-agent-tools';
import {
  buildPlaywrightMcpConfig,
  ensureManagedAgentMcp,
  playwrightMcpHash,
} from './managed-agent-mcp';
import {
  routeMemoryAttachmentsForSession,
  type UserMappingValue,
} from './memory-attach';
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
import {
  recordPayloadAudit,
  recordRuntimeEvent,
  recordSessionBind,
  sessionKeyHash,
} from './observability';

/** Historical broad scope prefix. Do not use for Google Chat reactive session lookup. */
export const KV_CHAT_SCOPE_SESSION_PREFIX = 'chat_scope_session';
/** KV key prefix for sender + space + thread → session lookup. TTL 24h. */
export const KV_CHAT_THREAD_SESSION_PREFIX = 'chat_thread_session';
const KV_CHAT_THREAD_SESSION_TTL_SEC = 24 * 60 * 60;

/** Session stream wall-time cap. Workers Queue consumer = 15 min budget. */
const SESSION_STREAM_TIMEOUT_MS = 110_000;
const DEFAULT_SESSION_WATCHDOG_SEC = 600;

/**
 * Google Chat reactive turn の KV key を組み立てる純関数。
 * sender_email + space + thread の三つ組で per-user per-thread に振り分ける
 * (issue #1119 = per-user 化)。capabilityKey は tool / skill 構成変更時に
 * 旧 session を再利用しないための suffix。いずれかが空なら null を返し、
 * 毎回新規 session として扱わせる (fail-closed)。
 */
export function chatThreadSessionKey(
  senderEmail: string,
  spaceName: string,
  threadName: string | null | undefined,
  capabilityKey?: string | null,
): string | null {
  const email = (senderEmail || '').trim().toLowerCase();
  const space = (spaceName || '').trim();
  const thread = (threadName || '').trim();
  if (!email || !space || !thread) return null;
  const suffix = capabilityKey && capabilityKey !== 'none' ? `:${capabilityKey}` : '';
  return `${KV_CHAT_THREAD_SESSION_PREFIX}:${email}:${space}:${thread}${suffix}`;
}

export function buildChatCapabilitySessionKeyFromHashes(
  desiredAgentToolsHash: string,
  attachedSkillsHash: string,
  mcpHash = 'none',
): string {
  return `tools-${desiredAgentToolsHash}:skills-${attachedSkillsHash}:mcp-${mcpHash}`;
}

export async function buildChatCapabilitySessionKey(
  env: Env,
  resources: MemoryStoreResourceParam[] = [],
): Promise<string> {
  const desiredAgentToolsHash = await toolsHash([...MAKOTO_AGENT_TOOLS]);
  const attachedSkillsHash = await skillsHash(buildAllManagedAgentSkills(env));
  const desiredMcpHash = await playwrightMcpHash(buildPlaywrightMcpConfig(env));
  const memoryResourcesHash = await toolsHash(resources.map((resource) => ({ ...resource })));
  return (
    buildChatCapabilitySessionKeyFromHashes(
      desiredAgentToolsHash,
      attachedSkillsHash,
      desiredMcpHash,
    ) +
    `:memory-${memoryResourcesHash}`
  );
}

/**
 * Grill Me 正本の session key。社員 agent を owner とし、DM / space scope
 * 単位で継続する。DM の user_id は現入力では email までしか来ないため、
 * senderEmail を scope_id として使う。
 */
export function chatScopeSessionKey(
  agentId: string,
  spaceType: string,
  senderEmail: string,
  spaceName: string,
): string | null {
  const agent = (agentId || '').trim();
  const normalizedSpaceType = (spaceType || '').trim().toUpperCase();
  const email = (senderEmail || '').trim().toLowerCase();
  const space = (spaceName || '').trim();
  if (!agent) return null;

  if (normalizedSpaceType === 'DM') {
    if (!email) return null;
    return `${KV_CHAT_SCOPE_SESSION_PREFIX}:${agent}:dm:${email}`;
  }

  if (!space) return null;
  return `${KV_CHAT_SCOPE_SESSION_PREFIX}:${agent}:space:${space}`;
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
  /** Pre-built Anthropic client. Falsy when Anthropic API key secrets are missing. */
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
  /**
   * true のとき、thread KV の既存 session を読まず、作成した session も
   * thread KV に保存しない。Google Chat 通常経路では使わない。
   */
  forceFreshSession?: boolean;
  /** Override KV (test 用)。未指定なら env.MAKOTO_KV を使う. */
  kv?: KVNamespace;
  /** Stream timeout override (test 用)。 */
  timeoutMs?: number;
  /** Session watchdog override (test / incident-debug 用)。 */
  sessionWatchdogSec?: number;
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
  /** Observability correlation id: `chat:msgname:<message.name>`. */
  eventKey?: string;
  /** Google Chat message resource name. */
  messageId?: string;
  /**
   * Deprecated compatibility field. Attached skills must already live on the
   * employee agent (`userMapping.agent_id`); this orchestrator no longer creates
   * per-skill agents/environments.
   */
  attachedSkills?: Array<Record<string, unknown>> | null;
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
  /** stream 中に観測した tool-use event 件数。 */
  toolUseCount: number;
  /** stream 中に観測した tool 名。重複なし、観測順。 */
  toolUseNames: string[];
  /** 起動ログ用に取得した system prompt sha 等。caller が必要なら参照. */
  systemPromptInfo: SystemPromptResult;
}

/**
 * orchestrator の致命的エラー型。caller (chat-event-handler) が
 * msg.retry() か commit か判定する。
 *   - `no_anthropic_client`     — Anthropic API key 未設定 / buildAnthropicClient null
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

export function resolveReactiveSessionWatchdogSec(
  raw: string | undefined,
): number | undefined {
  const value = (raw ?? '').trim();
  if (value === '') return undefined;
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > DEFAULT_SESSION_WATCHDOG_SEC
  ) {
    console.warn(
      `[chat-event] invalid CMA_REACTIVE_SESSION_WATCHDOG_SEC=${JSON.stringify(value)} ` +
        `fallback=${DEFAULT_SESSION_WATCHDOG_SEC}`,
    );
    return undefined;
  }
  return parsed;
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
      'Anthropic API key missing — cannot drive session',
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

  // ---- custom tools ensure ----
  // Existing employee agents predate new Worker-side tools. Patch their tool
  // catalog in place before session reuse so model-visible tools and the
  // Worker dispatcher cannot drift.
  const desiredAgentTools = MAKOTO_AGENT_TOOLS;
  const desiredAgentToolsHash = await toolsHash([...desiredAgentTools]);
  try {
    const ensuredTools = await ensureManagedAgentTools(
      client,
      input.userMapping.agent_id,
      desiredAgentTools,
      {
        kv,
        desiredToolsHash: desiredAgentToolsHash,
      },
    );
    if (ensuredTools.reason !== 'ensured_cache_hit') {
      console.log(
        `[chat-event] managed tools ensure agent=${input.userMapping.agent_id} ` +
          `reason=${ensuredTools.reason} updated=${ensuredTools.updated} tools=${ensuredTools.finalTools.length}`,
      );
    }
  } catch (err) {
    console.warn(
      `[chat-event] managed tools ensure failed agent=${input.userMapping.agent_id}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ---- attached skills ensure ----
  // Anthropic pre-built document skills (xlsx / pptx / docx / pdf) are only
  // usable after they are attached to the employee agent. Keep the existing
  // agent/session design and patch the agent skill list in place.
  const desiredAttachedSkills = buildAllManagedAgentSkills(input.env);
  const attachedSkillsHash = await skillsHash(desiredAttachedSkills);
  try {
    const ensured = await ensureManagedAgentSkills(
      client,
      input.userMapping.agent_id,
      desiredAttachedSkills,
      {
        kv,
        desiredSkillsHash: attachedSkillsHash,
      },
    );
    if (ensured.reason !== 'ensured_cache_hit') {
      console.log(
        `[chat-event] attached skills ensure agent=${input.userMapping.agent_id} ` +
          `reason=${ensured.reason} updated=${ensured.updated} skills=${ensured.finalSkills.length}`,
      );
    }
  } catch (err) {
    console.warn(
      `[chat-event] attached skills ensure failed agent=${input.userMapping.agent_id}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ---- Playwright MCP ensure ----
  // URL-based MCP attach is fail-closed: unset / invalid / unauthenticated
  // configs do not alter the existing employee agent.
  const playwrightMcpConfig = buildPlaywrightMcpConfig(input.env);
  const desiredMcpHash = await playwrightMcpHash(playwrightMcpConfig);
  if (playwrightMcpConfig.attach) {
    try {
      const ensuredMcp = await ensureManagedAgentMcp(
        client,
        input.userMapping.agent_id,
        playwrightMcpConfig,
        {
          kv,
          desiredMcpHash,
        },
      );
      if (ensuredMcp.reason !== 'ensured_cache_hit') {
        console.log(
          `[chat-event] playwright mcp ensure agent=${input.userMapping.agent_id} ` +
            `reason=${ensuredMcp.reason} updated=${ensuredMcp.updated} ` +
            `servers=${ensuredMcp.finalMcpServers.length} tools=${ensuredMcp.finalTools.length}`,
        );
      }
    } catch (err) {
      console.warn(
        `[chat-event] playwright mcp ensure failed agent=${input.userMapping.agent_id}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (playwrightMcpConfig.status !== 'not_configured') {
    console.warn(
      `[chat-event] playwright mcp disabled status=${playwrightMcpConfig.status} ` +
        `reason=${playwrightMcpConfig.reason}`,
    );
  }

  // ---- Memory Store router ----
  // sessions.create の resources[] は caller 側が決める。1 session 最大
  // 8 Memory Store に収めるため、Cloudflare 側で選定してから session key
  // と resources の両方へ反映する。
  const routedMemory = routeMemoryAttachmentsForSession(
    input.userMapping.memory_attachments,
    { spaceType: input.spaceType },
  );
  const resources: MemoryStoreResourceParam[] = routedMemory.selected.map(toResourceParam);
  const memoryResourcesHash = await toolsHash(
    resources.map((resource) => ({ ...resource })),
  );

  // ---- thread session 解決 ----
  // Cloud Run 旧実装と同じく、Google Chat は sender + space + thread 単位で
  // CMA session を継続する。DM/space 全体へ広げると、新しい Chat thread が
  // 古い CMA session を継続してしまうため、scope key への fallback はしない。
  // capability hash を suffix に含め、tools / document skills / MCP 付与前の session を再利用しない。
  const capabilitySessionKey = buildChatCapabilitySessionKeyFromHashes(
    desiredAgentToolsHash,
    attachedSkillsHash,
    desiredMcpHash,
  ) + `:memory-${memoryResourcesHash}`;
  const forceFreshSession = input.forceFreshSession === true;
  const sessionKey = forceFreshSession
    ? null
    : chatThreadSessionKey(
        input.senderEmail,
        input.spaceName,
        input.threadName,
        capabilitySessionKey,
      );
  let sessionId: string | null = null;
  if (sessionKey !== null) {
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
    const agentId = input.userMapping.agent_id;
    const environmentId = input.env.ENVIRONMENT_ID;
    const attachedSkills = input.attachedSkills ?? null;
    if (hasAttachedSkills(attachedSkills)) {
      console.warn(
        `[chat-event] attachedSkills ignored user=${input.userMapping.user_slug}; ` +
          'using mapped employee agent/session',
      );
    }

    try {
      sessionId = await createSessionWithResources(client, {
        agentId,
        environmentId,
        resources,
      });
    } catch (err) {
      throw new OrchestratorFailure(
        'sessions_create_failed',
        `sessions.create failed for agent=${input.userMapping.agent_id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err,
      );
    }
    isNewSession = true;
    console.log(
      `[chat-event] created session=${sessionId} agent=${agentId} ` +
        `user=${input.userMapping.user_slug} space=${input.spaceName} ` +
        `memory_stores=${resources.length}/${routedMemory.max_stores}` +
        (input.forceFreshSession ? ' ephemeral=true' : ''),
    );
    if (sessionKey !== null) {
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
        `user=${input.userMapping.user_slug} space=${input.spaceName} ` +
        `memory_stores=${resources.length}/${routedMemory.max_stores}`,
    );
  }

  if (input.eventKey) {
    await recordSessionBind(input.env, {
      senderEmail: input.senderEmail,
      spaceName: input.spaceName,
      threadName: input.threadName,
      sessionId,
      eventKey: input.eventKey,
      messageId: input.messageId ?? null,
      userSlug: input.userMapping.user_slug,
      isNewSession,
    });
    await recordRuntimeEvent(input.env, {
      eventKey: input.eventKey,
      sessionId,
      messageId: input.messageId ?? null,
      userSlug: input.userMapping.user_slug,
      eventType: isNewSession ? 'cma_session_created' : 'cma_session_continued',
      source: 'session-orchestrator',
      detail: {
        force_fresh_session: forceFreshSession,
        session_key_kind: sessionKey === null ? 'none' : 'chat_thread',
        thread_name_present: Boolean(input.threadName),
        has_thread_session_key: sessionKey !== null,
        memory_router_strategy: routedMemory.strategy,
        memory_store_count: resources.length,
        memory_store_dropped_count: routedMemory.dropped.length,
        selected_memory_store_names: routedMemory.selected_store_names,
        dropped_memory_store_names: routedMemory.dropped_store_names,
        memory_resources_hash: memoryResourcesHash,
      },
    });
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

  if (input.eventKey) {
    const session_key_hash = sessionKeyHash(
      input.senderEmail,
      input.spaceName,
      input.threadName,
    );
    await recordRuntimeEvent(input.env, {
      eventKey: input.eventKey,
      sessionId,
      messageId: input.messageId ?? null,
      userSlug: input.userMapping.user_slug,
      eventType: 'prompt_envelope_built',
      source: 'session-orchestrator',
      detail: {
        body_chars: input.bodyText.length,
        history_chars: input.historyBlock?.length ?? 0,
        speaker_context_chars: input.speakerContextBlock?.length ?? 0,
        roster_chars: input.rosterBlock?.length ?? 0,
        extra_content_blocks: extraBlocks.length,
        envelope_chars: userMessageText.length,
        has_intent: Boolean(input.intent),
      },
    });
    await recordPayloadAudit(input.env, {
      sessionId,
      eventKey: input.eventKey,
      messageId: input.messageId ?? null,
      userSlug: input.userMapping.user_slug,
      sessionKeyHash: session_key_hash,
      payload: {
        user_message: userMessage,
        envelope_stats: {
          body_chars: input.bodyText.length,
          history_chars: input.historyBlock?.length ?? 0,
          speaker_context_chars: input.speakerContextBlock?.length ?? 0,
          envelope_chars: userMessageText.length,
          extra_content_blocks: extraBlocks.length,
        },
      },
    });
  }

  // ---- stream consume ----
  let streamResult: SendAndStreamResult;
  const sessionWatchdogSec =
    input.sessionWatchdogSec ??
    resolveReactiveSessionWatchdogSec(input.env.CMA_REACTIVE_SESSION_WATCHDOG_SEC);
  try {
    streamResult = await sendAndStreamWithToolDispatch(client, {
      sessionId,
      userMessage,
      toolDispatcher: input.toolDispatcher,
      timeoutMs: input.timeoutMs ?? SESSION_STREAM_TIMEOUT_MS,
      sessionWatchdogSec,
      payloadAudit: {
        kv,
        enabled: input.env.CMA_AUDIT_USER_MESSAGE_PAYLOADS,
        ttlDays: input.env.CMA_AUDIT_TTL_DAYS,
        maxTextChars: input.env.CMA_AUDIT_MAX_TEXT_CHARS,
        mode: 'chat',
        context: {
          sender_email: input.senderEmail,
          space_name: input.spaceName,
          space_type: input.spaceType,
          thread_name: input.threadName ?? '',
          agent_id: input.userMapping.agent_id,
        },
      },
    });
    if (input.eventKey) {
      await recordRuntimeEvent(input.env, {
        eventKey: input.eventKey,
        sessionId,
        messageId: input.messageId ?? null,
        userSlug: input.userMapping.user_slug,
        eventType: 'cma_events_send_completed',
        source: 'session-orchestrator',
        detail: {
          assistant_chars: streamResult.assistantText.length,
          terminal_event_type: streamResult.terminalEventType ?? null,
          stop_reason: streamResult.stopReason ?? null,
          session_watchdog_sec:
            sessionWatchdogSec ?? DEFAULT_SESSION_WATCHDOG_SEC,
        },
      });
    }
  } catch (err) {
    if (input.eventKey) {
      await recordRuntimeEvent(input.env, {
        eventKey: input.eventKey,
        sessionId,
        messageId: input.messageId ?? null,
        userSlug: input.userMapping.user_slug,
        eventType: 'cma_events_send_failed',
        level: 'error',
        source: 'session-orchestrator',
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
    }
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
    toolUseCount: streamResult.toolUseCount,
    toolUseNames: streamResult.toolUseNames,
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
