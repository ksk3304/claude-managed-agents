/**
 * Google Chat reactive event Queue consumer — `makoto-chat-queue` から
 * Pull した `ChatQueueMessage` 1 件分の dispatcher。
 *
 * Cloud Run `cma_gchat_bot.py:_handle_event` (l.3784, ~1,668 行) の **中間版 port**
 * (= Day 3 subagent G の scope)。完全 port は別 Issue (= Day 4 cutover で
 * MAKOTOくん 機能損失を許容しない場合は #186 follow-up に切る) に分割する。
 *
 * 中間版 = 含むもの:
 *   1. claim 維持確認 (`confirmOwner`) — 既に successor が TAKEOVER 済なら skip
 *   2. payload parse: space / sender / text / thread / type 抽出
 *   3. bot 宛判定 (DM = 無条件, shared = `@<bot displayName>` mention 含む時のみ)
 *   4. mention strip (簡略: 先頭 `@<displayName> ` のみ)
 *   5. user_mapping resolve (= `readUserMapping`)
 *   6. session orchestrate (= `session-orchestrator.ts`)
 *      - thread session KV lookup or sessions.create
 *      - `sendAndStreamWithToolDispatch` で stream consume
 *   7. assistantText parse:
 *      - EMAIL_SEND markers → AgentMail send + redaction + sent_messages row
 *      - CHAT_POST markers → 別 space に postChatMessage
 *      - 残った clean text → current space (= 受信 space) に reply 投稿
 *   8. session-log memory append (DM/shared 自動振り分け)
 *   9. `commitDone` で dedupe commit
 *
 * 中間版 = **含まない** もの (Cloud Run 完全実装比、follow-up Issue で対応):
 *   - (済 #186 既知 #1 + O) 画像 / PDF / Office 添付処理 = `src/lib/attachment-processing.ts` で port 済
 *   - `/costguard` mutation 系 (status 以外、Phase 2 では `cost-guard-command.ts`
 *     で status のみ port 済 = LLM 経由ゼロで budget 状態を返す。enable /
 *     disable / pause / set / confirm / cancel は Worker 側 Firestore overlay
 *     永続層の未実装ゆえ 503 拒否)。
 *   - cap-recovery 完全実装 (cap 超過後の memory snapshot 経路)
 *   - Cold continuation の SignalB 経由 thread-self-scan
 *   - 外部ツール gate の actor 駆動完全実装 (= `_compute_external_tool_gate`
 *     wire-up。CHAT_POST gate = 未解決 speaker 軸は Issue #186 既知 #6 で完了)
 *
 * Failure isolation:
 *   - LLM stream throw   → msg.retry() 経由で event 再配送 (= claim を release
 *                          せず lease 期限切れ後 successor が TAKEOVER 可能)
 *   - marker dispatch fail (1 件) → WARN log + 他 marker 継続、event 全体は committed
 *   - current space 投稿 fail → WARN log + event 全体 committed (= session は完了済)
 *   - session-log append fail → WARN log + event 全体 committed
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 #5 — Google Chat reactive bot, Phase B)
 * Spec: Day 3 subagent G task brief
 */

import { AgentMailClient, AgentMailError } from '../lib/agentmail-api';
import {
  buildAllAttachmentBlocks,
  type ChatAttachment,
} from '../lib/attachment-processing';
import { SLASH_SKILLS_DATA } from '../data/skills-data';
import {
  ChatApiError,
  type ChatMessageResult,
  deleteChatMessage,
  postChatMessage,
  updateChatMessage,
} from '../lib/chat-api';
import {
  parseChatPostMarkerDetailed,
  CHAT_POST_MARKER_REGEX,
} from '../lib/chat-post-marker';
import { resolveChatAlias } from '../lib/chat-alias-resolver';
import {
  fetchThreadMessages,
  formatThreadHistoryWithMeta,
  recordHistoryFailure,
  clearHistoryFailure,
  handleHistoryFetchPermanentFailure,
  isHistoryPermanentlyFailed,
  type ChatHistoryDeps,
} from '../lib/chat-history';
import { getChatReadonlyAccessToken } from '../lib/chat-oauth';
import { applyChatPostGateToText } from '../lib/speaker-gate';
import { isMailSendApprovalText, isMailSendApprovalTurn } from '../lib/mail-confirmation';
import { createCloudSchedulerManager } from '../lib/cloud-scheduler-client';
import {
  parseCostGuardCommand,
  handleCostGuardCommand,
} from '../lib/cost-guard-command';
import { parseNaturalCostGuardCommand } from '../lib/cost-guard-natural-command';
import { extractFinalMarkerText, extractHeartbeatNothingText } from '../lib/final-marker';
import {
  evaluateSessionCostAfterTurn,
  handlePendingSessionApproval,
  projectSessionCostForPdfPreflight,
  recordChatPost,
  resolveSessionCostGuardConfig,
} from '../lib/cost-guard';
import { confirmOwner, commitDone, newClaimOwner, releaseClaim, tryClaim } from '../lib/dedupe';
import { getThreadLock } from '../durable-objects/thread-lock';
import {
  resolveCapRecoveryConfig,
  runCapRecovery,
  shouldAttemptCapRecovery,
  type CapRecoveryStreamExecutor,
} from '../lib/cap-recovery';
import { parseAssistantText } from '../lib/email-send-marker';
import {
  detectActionSkillIntent,
  type ActionSkillIntent,
  type SkillsData,
} from '../lib/intent-detector';
import { normalizeSenderEmail, readChatSenderMappingWithAutoPending } from '../lib/memory-attach';
import {
  handleScheduleActionMarker,
  parseScheduleActionMarkers,
  stripScheduleActionMarkers,
} from '../lib/schedule-action-marker';
import {
  handleNaturalScheduleCommand,
  isDeicticScheduleReference,
} from '../lib/schedule-natural-command';
import {
  buildAnthropicClient,
  chatThreadSessionKey,
  orchestrateChatTurn,
  OrchestratorFailure,
} from '../lib/session-orchestrator';
import {
  appendSessionLogMemory,
  isSharedSpace,
} from '../lib/session-log';
import { dispatchSlashCommand } from '../lib/slash-skill';
import type { SlashSkillHandlers } from '../lib/slash-skill';
import {
  retrieveSessionUsageSnapshot,
  sendAndStreamWithToolDispatch,
} from '../lib/session';
import {
  maskInternalStateForChat,
  scrubInternalStateForChat,
  softenBenignInternalReferencesForChat,
} from '../redact/internal-state';
import { redactPiiInText } from '../redact/pii';
import { recordSentMessage } from '../storage';
import { executeWithCommit, LeaseHeartbeat } from '../lib/three-stage-precheck';
import type { ChatEventPayload, ChatQueueMessage } from '../webhooks/google-chat';
import {
  dispatchMakotoTool,
  makeMakotoWorkspaceRefreshAccessToken,
  resolveMakotoWorkspaceAccessToken,
} from '../dispatch/makoto-tool-dispatcher';
import { deliverSessionOutputsToDrive } from '../lib/session-output-files';
import { PERSONA_SPEC } from '../data/persona-spec';
import { TOOLS_SPEC } from '../data/tools-spec';
import { isMentioningBot, stripMentions } from '../lib/mention-detection';
import type { EmailSendMarker } from '../types/agentmail';
import { recordRuntimeEvent, stableHash } from '../lib/observability';
import { postChatPlaceholderResult } from '../lib/chat-placeholder';

const CHAT_SCOPE_LOCK_TTL_MS = 10 * 60 * 1000;
const MORNING_BRIEF_EVENT_KEY_PREFIX = 'scheduled:morning_brief_seto:';
const MORNING_BRIEF_STREAM_TIMEOUT_MS = 10 * 60 * 1000;
const CHAT_EVENT_LEASE_TTL_MS = 15 * 60 * 1000;
const CHAT_EVENT_HEARTBEAT_INTERVAL_MS = 60 * 1000;
const AUTONOMOUS_EVENT_KEY_PREFIX = 'scheduled:';
const AUTONOMOUS_LONG_REPLY_THRESHOLD_CHARS = 320;
const AUTONOMOUS_REPLY_TITLE_MAX_CHARS = 34;
const CHAT_DM_SPACE_KV_PREFIX = 'chat_dm_space:';

/**
 * 最小 SkillsData = Python `scripts/cma_skills.json` の `attach_memory:
 * false` skill 集合を TS 側で持つ subset (Issue #186 既知 #4 intent-detector
 * 統合)。chat-event-handler は intent 判定 (= action skill 起動の有無) だけ
 * のために使うので、Python full SkillsData を移植する必要はなく、`/mail` と
 * `/schedule` の 2 件のみ持つ。
 *
 * Python 一次ソース: `scripts/cma_skills.json` (attach_memory: false の skill
 * のみ列挙)。Python `_detect_action_skill_intent` (l.1193) は `skill_def.get
 * ("attach_memory", True)` を見るので、未登録 skill (= ここに無い skill) は
 * `isActionSkill=false` 扱い (= 既存 session 継続) になり、Python と同等。
 *
 * 注: persona/tools の動的 spec とは独立した「intent 判定専用テーブル」。
 * skill を追加するときは Python 側 cma_skills.json と本テーブルを両方更新
 * する (= 同名 skill が登録されたら本テーブルに `attach_memory: false` で
 * 追加。drift 防止)。
 */
export const ACTION_SKILL_INTENT_TABLE: SkillsData = {
  skills: {
    '/mail': { attach_memory: false },
    '/schedule': { attach_memory: false },
    '/costguard': { attach_memory: false },
  },
};

/**
 * 1 reactive event を処理する。返り値は consumer (= `queue` handler) が
 * msg.ack() vs msg.retry() 判定に使う。
 *
 * - `committed` — 正常完了 (claim も commitDone 済)。caller は msg.ack()
 * - `skipped` — claim 失効 / 不適合 event。caller は msg.ack() (commitDone 済 or 不要)
 * - `release_and_retry` — transient 失敗。caller は releaseClaim 済の状態で
 *   msg.retry() を呼ぶ
 */
export type ChatEventOutcome =
  | { kind: 'committed' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'release_and_retry'; reason: string };

const PDF_PREFLIGHT_PENDING_TTL_SEC = 6 * 60 * 60;

interface PendingPdfPreflightApproval {
  attachments: ChatAttachment[];
  requestText: string;
  approvedThroughUsd: number;
  createdAtMs: number;
}

/**
 * Queue consumer entry point。`src/index.ts` の `queue` handler から
 * `makoto-chat-queue` 分岐で呼ばれる。batch 中 1 message ずつ呼び出すこと。
 */
export async function handleChatEvent(
  env: Env,
  ctx: ExecutionContext,
  body: ChatQueueMessage,
): Promise<ChatEventOutcome> {
  const { eventKey, claim, payload } = body;
  const ingressPlaceholderName = body.placeholderName ?? '';
  await recordRuntimeEvent(env, {
    eventKey,
    messageId: payload.message?.name ?? null,
    eventType: 'chat_queue_consumer_started',
    source: 'chat-event-handler',
    detail: { claim_owner: claim.owner, claim_version: claim.version },
  });

  // ---- 1. claim 維持確認 ----
  const stillOwner = await confirmOwner(env.DB, eventKey, claim.owner, claim.version);
  if (!stillOwner) {
    console.warn(
      `[chat-event] lost_claim eventKey=${eventKey} owner=${claim.owner} version=${claim.version}`,
    );
    if (ingressPlaceholderName) await safeDeletePlaceholder(env, ingressPlaceholderName, eventKey);
    await recordRuntimeEvent(env, {
      eventKey,
      messageId: payload.message?.name ?? null,
      eventType: 'chat_event_skipped',
      level: 'warn',
      source: 'chat-event-handler',
      detail: {
        reason: 'lost_claim',
        stage: 'claim_confirm',
        claim_owner: claim.owner,
        claim_version: claim.version,
      },
    });
    return { kind: 'skipped', reason: 'lost_claim' };
  }

  // ---- 2. payload extract ----
  const message = payload.message;
  if (!message) {
    console.warn(`[chat-event] no message field eventKey=${eventKey}`);
    if (ingressPlaceholderName) await safeDeletePlaceholder(env, ingressPlaceholderName, eventKey);
    await safeCommit(env, eventKey, claim, {
      reason: 'no_message',
      stage: 'payload_extract',
      outcome: 'skipped',
      level: 'warn',
    });
    return { kind: 'skipped', reason: 'no_message' };
  }
  const space = payload.space ?? { name: '' };
  const sender = message.sender ?? { name: '' };
  const spaceName = space.name || '';
  const spaceType = space.type || 'UNKNOWN';
  const senderType = (sender as { type?: string }).type;
  if (senderType === 'BOT') {
    // bot 自身の投稿 (= echo 防止)
    console.log(`[chat-event] skip BOT sender eventKey=${eventKey}`);
    if (ingressPlaceholderName) await safeDeletePlaceholder(env, ingressPlaceholderName, eventKey);
    await safeCommit(env, eventKey, claim, {
      messageId: message.name,
      reason: 'bot_sender',
      stage: 'sender_filter',
      outcome: 'skipped',
      detail: {
        sender_name_hash: stableHash(sender.name),
        space_type: spaceType,
      },
    });
    return { kind: 'skipped', reason: 'bot_sender' };
  }

  const threadName = message.thread?.name ?? null;
  const rawText = message.text ?? '';
  const annotations = message.annotations ?? [];

  // ---- 3. bot 宛判定 (annotations-based, Python `_is_for_bot` 等価) ----
  // 実判定は annotations の USER_MENTION (= `userMention.user.type === 'BOT'`
  // 優先 + `GCHAT_BOT_USER_NAME` fallback) で行う (Issue #186 既知 #9
  // substring false hit 解消)。
  const botUserName = (env.GCHAT_BOT_USER_NAME ?? '').trim();
  const isDm = isDmSpace(spaceType);
  const isForBot = isDm || isMentioningBot(annotations, botUserName);
  if (!isForBot) {
    console.log(
      `[chat-event] skip non-mention eventKey=${eventKey} space=${spaceName} type=${spaceType}`,
    );
    if (ingressPlaceholderName) await safeDeletePlaceholder(env, ingressPlaceholderName, eventKey);
    await safeCommit(env, eventKey, claim, {
      messageId: message.name,
      reason: 'not_for_bot',
      stage: 'bot_mention_filter',
      outcome: 'skipped',
      detail: {
        is_dm: isDm,
        space_type: spaceType,
        annotation_count: annotations.length,
        bot_user_name_configured: Boolean(botUserName),
      },
    });
    return { kind: 'skipped', reason: 'not_for_bot' };
  }

  // ---- 4. mention strip (annotations-based, Python `_strip_mention` 等価) ----
  // startIndex + length 範囲を正確に切り出す (= 先頭以外の mention や
  // 複数 mention も漏れなく除去、Issue #186 既知 #10 解消)。
  let bodyText = stripMentions(rawText, annotations);
  if (bodyText.length === 0) {
    if (threadName) {
      // Cloud Run l.3903-3906 と同等: mention のみのとき、文脈追従指示で agent に渡す
      bodyText =
        '（メンションのみで本文がありません。直前のスレッドの文脈に沿って応答してください）';
    } else {
      // Cloud Run l.3895-3902 同等: 空メッセージはその旨を投稿して終了
      await replyToCurrentSpace(env, ingressPlaceholderName, spaceName, '（空メッセージ）', threadName, eventKey);
      await safeCommit(env, eventKey, claim, {
        messageId: message.name,
        reason: 'empty_message_reply_posted',
        stage: 'mention_strip',
        outcome: 'committed',
        detail: {
          space_type: spaceType,
          thread_present: Boolean(threadName),
        },
      });
      return { kind: 'committed' };
    }
  }

  // ---- 5. sender identity + user_mapping resolve ----
  const senderEmail = ((sender as { email?: string }).email || '').trim().toLowerCase();
  const senderDisplayName =
    typeof (sender as { displayName?: unknown }).displayName === 'string'
      ? ((sender as { displayName?: string }).displayName ?? '').trim()
      : '';
  // Mapping resolve with optional default fallback and chat-only pending
  // auto registration. Pending mappings use `chat_pending_user_mapping:*`,
  // not `user_mapping:*`, so mail/daily-report/onboarding paths cannot
  // accidentally treat a first-time Chat participant as fully registered.
  const mappingResolution = await readChatSenderMappingWithAutoPending(
    env.MAKOTO_KV,
    {
      senderEmail,
      chatUserId: sender.name,
      displayName: senderDisplayName,
      spaceName,
    },
    env.DEFAULT_USER_SLUG,
    spaceType,
    env.CHAT_AUTO_PENDING_USER_MAPPING_ENABLED === '1',
  );
  if (!mappingResolution) {
    if (!senderEmail) {
      console.warn(`[chat-event] no sender email eventKey=${eventKey}`);
      if (ingressPlaceholderName) await safeDeletePlaceholder(env, ingressPlaceholderName, eventKey);
      await recordRuntimeEvent(env, {
        eventKey,
        messageId: message.name,
        eventType: 'chat_event_skipped',
        level: 'warn',
        source: 'chat-event-handler',
        detail: {
          reason: 'no_sender_email',
          sender_name_hash: stableHash(sender.name),
          sender_type: senderType ?? null,
          auto_pending_mapping_enabled:
            env.CHAT_AUTO_PENDING_USER_MAPPING_ENABLED === '1',
          default_user_slug_configured: Boolean(env.DEFAULT_USER_SLUG?.trim()),
          space_type: spaceType,
        },
      });
      await safeCommit(env, eventKey, claim, {
        messageId: message.name,
        reason: 'no_sender_email',
        stage: 'sender_mapping_resolve',
        outcome: 'skipped',
        level: 'warn',
        detail: {
          sender_name_hash: stableHash(sender.name),
          sender_type: senderType ?? null,
          auto_pending_mapping_enabled:
            env.CHAT_AUTO_PENDING_USER_MAPPING_ENABLED === '1',
          default_user_slug_configured: Boolean(env.DEFAULT_USER_SLUG?.trim()),
          space_type: spaceType,
        },
      });
      return { kind: 'skipped', reason: 'no_sender_email' };
    }
    // Scrub sender email through PII redactor before logging — Cloudflare
    // Logs retains warn lines long-term (Issue #186 D コンプラ対応).
    console.warn(
      `[chat-event] unknown_sender eventKey=${eventKey} email=${redactPiiInText(senderEmail)}`,
    );
    if (ingressPlaceholderName) await safeDeletePlaceholder(env, ingressPlaceholderName, eventKey);
    await recordRuntimeEvent(env, {
      eventKey,
      messageId: message.name,
      eventType: 'chat_event_skipped',
      level: 'warn',
      source: 'chat-event-handler',
      detail: {
        reason: 'unknown_sender',
        sender_email_hash: stableHash(senderEmail),
        default_user_slug_configured: Boolean(env.DEFAULT_USER_SLUG?.trim()),
        auto_pending_mapping_enabled:
          env.CHAT_AUTO_PENDING_USER_MAPPING_ENABLED === '1',
        space_type: spaceType,
      },
    });
    await safeCommit(env, eventKey, claim, {
      messageId: message.name,
      reason: 'unknown_sender',
      stage: 'sender_mapping_resolve',
      outcome: 'skipped',
      level: 'warn',
      detail: {
        sender_email_hash: stableHash(senderEmail),
        default_user_slug_configured: Boolean(env.DEFAULT_USER_SLUG?.trim()),
        auto_pending_mapping_enabled:
          env.CHAT_AUTO_PENDING_USER_MAPPING_ENABLED === '1',
        space_type: spaceType,
      },
    });
    return { kind: 'skipped', reason: 'unknown_sender' };
  }
  const userMapping = mappingResolution.mapping;
  const actorTrusted = mappingResolution.actorTrusted;
  await rememberSenderDmSpace(env.MAKOTO_KV, senderEmail, spaceName, spaceType);
  if (!actorTrusted) {
    console.info(
      `[chat-event] untrusted_actor_fallback eventKey=${eventKey} ` +
        `source=${mappingResolution.source} email=${redactPiiInText(senderEmail || '<no-email>')} ` +
        `default_slug=${userMapping.user_slug}`,
    );
    await recordRuntimeEvent(env, {
      eventKey,
      messageId: message.name,
      userSlug: userMapping.user_slug,
      eventType:
        mappingResolution.source === 'auto_pending'
          ? 'chat_auto_pending_user_mapping'
          : 'chat_default_user_fallback',
      source: 'chat-event-handler',
      detail: {
        sender_email_hash: senderEmail ? stableHash(senderEmail) : null,
        sender_name_hash: stableHash(sender.name),
        mapping_source: mappingResolution.source,
        default_slug: userMapping.user_slug,
        external_tools_allowed: false,
      },
    });
  }
  if ((userMapping.filtered_personal_store_count ?? 0) > 0) {
    console.log(
      `[chat-event] personal memory filtered eventKey=${eventKey} ` +
        `space_type=${spaceType} count=${userMapping.filtered_personal_store_count}`,
    );
  }

  const isAutonomousEvent = eventKey.startsWith(AUTONOMOUS_EVENT_KEY_PREFIX);

  // ---- 5a. slash 決定論短絡 (/costguard 専用早期 return + /help generic dispatcher) ----
  const cgCommand = isAutonomousEvent
    ? null
    : parseCostGuardCommand(bodyText) ?? parseNaturalCostGuardCommand(bodyText);
  if (cgCommand) {
    const cgText = await handleCostGuardCommand(
      env,
      cgCommand,
      {
        senderEmail,
        guardDeps: {
          db: env.DB,
          kv: env.MAKOTO_KV,
          operatorSpace: env.COST_GUARD_OPERATOR_SPACE,
          enabledEnv: env.COST_GUARD_ENABLED,
        },
      },
    );
    await replyToCurrentSpace(env, ingressPlaceholderName, spaceName, cgText, threadName, eventKey);
    await safeCommit(env, eventKey, claim, {
      messageId: message.name,
      userSlug: userMapping.user_slug,
      reason: 'costguard_command_handled',
      stage: 'deterministic_slash_command',
      outcome: 'committed',
      detail: { subcommand: cgCommand.subcommand },
    });
    console.log(
      `[chat-event] /costguard handled eventKey=${eventKey} sub=${cgCommand.subcommand}`,
    );
    return { kind: 'committed' };
  }
  if (!isAutonomousEvent && bodyText.startsWith('/')) {
    const slashSkillsData: SkillsData = loadSlashSkillsData(env);
    const slashHandlers: SlashSkillHandlers = {};
    const slashOutcome = await dispatchSlashCommand(bodyText, slashSkillsData, {
      senderEmail,
      handlers: slashHandlers,
    });
    if (slashOutcome.kind === 'decided') {
      console.log(
        `[chat-event] slash decided eventKey=${eventKey} source=${slashOutcome.source} chars=${slashOutcome.text.length}`,
      );
      await replyToCurrentSpace(env, ingressPlaceholderName, spaceName, slashOutcome.text, threadName, eventKey);
      await safeCommit(env, eventKey, claim, {
        messageId: message.name,
        userSlug: userMapping.user_slug,
        reason: 'slash_command_decided',
        stage: 'deterministic_slash_command',
        outcome: 'committed',
        detail: {
          source: slashOutcome.source,
          text_chars: slashOutcome.text.length,
        },
      });
      return { kind: 'committed' };
    }
    if (slashOutcome.kind === 'run') {
      console.log(
        `[chat-event] slash run eventKey=${eventKey} command=${slashOutcome.command} ` +
          `attach_memory=${slashOutcome.attachMemory} (agent path)`,
      );
    }
  }

  const naturalScheduleResult = isAutonomousEvent
    ? null
    : await dispatchNaturalScheduleCommand(
      env,
      bodyText,
      {
        eventKey,
        messageId: message.name,
        threadName,
      },
    );
  if (naturalScheduleResult !== null) {
    await safePost(env, spaceName, naturalScheduleResult, threadName, eventKey);
    await safeCommit(env, eventKey, claim);
    console.log(`[chat-event] natural schedule command handled eventKey=${eventKey}`);
    return { kind: 'committed' };
  }

  const threadSessionKey = chatThreadSessionKey(senderEmail, spaceName, threadName);
  const chatScopeKey = threadSessionKey ?? `chat_event_scope:${eventKey}`;
  const chatScopeLock = getThreadLock(env, chatScopeKey);
  const chatScopeLockResult = await chatScopeLock.acquire(
    chatScopeKey,
    CHAT_SCOPE_LOCK_TTL_MS,
  );
  if (!chatScopeLockResult.acquired) {
    await recordRuntimeEvent(env, {
      eventKey,
      messageId: message.name,
      eventType: 'chat_scope_lock_held',
      level: 'warn',
      source: 'chat-event-handler',
      detail: {
        scope_key_hash: stableHash(chatScopeKey),
        retry_after_ms: chatScopeLockResult.retry_after_ms ?? null,
      },
    });
    await safeRelease(env, eventKey, claim);
    return { kind: 'release_and_retry', reason: 'chat_scope_lock_held' };
  }

  let attachmentForProcessing = message.attachment ?? null;
  let pdfApprovedThroughUsdFloor: number | null = null;
  let pdfPreflightApprovalConsumed = false;
  let parentHeartbeat: LeaseHeartbeat | null = null;
  let turnProcessingClaim: { key: string; owner: string; version: number } | null = null;

  try {
    const turnClaim = await claimChatTurnProcessing(env, {
      eventKey,
      messageId: message.name,
    });
    if (turnClaim.kind === 'duplicate') {
      return { kind: 'skipped', reason: turnClaim.reason };
    }
    if (turnClaim.kind === 'failed') {
      await safeRelease(env, eventKey, claim);
      return { kind: 'release_and_retry', reason: 'chat_turn_processing_claim_failed' };
    }
    turnProcessingClaim = turnClaim.claim;

    parentHeartbeat = await startParentLeaseHeartbeat(env, ctx, {
      eventKey,
      messageId: message.name,
      owner: claim.owner,
      version: claim.version,
      eventType: eventKey.startsWith(MORNING_BRIEF_EVENT_KEY_PREFIX)
        ? 'morning_brief_parent_lease_heartbeat_started'
        : 'chat_parent_lease_heartbeat_started',
    });
    if (!parentHeartbeat) {
      return { kind: 'skipped', reason: 'lost_claim' };
    }

    const pdfApprovalDecision = parsePdfPreflightApprovalDecision(bodyText);
    const pendingPdfPreflight = threadSessionKey
      ? await readPendingPdfPreflightApproval(env.MAKOTO_KV, threadSessionKey)
      : null;
    if (pendingPdfPreflight && pdfApprovalDecision === 'no') {
      if (threadSessionKey) {
        await deletePendingPdfPreflightApproval(env.MAKOTO_KV, threadSessionKey);
      }
      await safePost(env, spaceName, '了解です。PDF全文読取は中止しました。', threadName, eventKey);
      await safeCommit(env, eventKey, claim, {
        messageId: message.name,
        userSlug: userMapping.user_slug,
        reason: 'pdf_preflight_rejected',
        stage: 'pdf_preflight_approval',
        outcome: 'committed',
      });
      return { kind: 'committed' };
    }
    if (pendingPdfPreflight && pdfApprovalDecision === 'yes') {
      attachmentForProcessing = attachmentForProcessing && attachmentForProcessing.length > 0
        ? attachmentForProcessing
        : pendingPdfPreflight.attachments;
      bodyText = pendingPdfPreflight.requestText || bodyText;
      pdfApprovedThroughUsdFloor = pendingPdfPreflight.approvedThroughUsd;
      pdfPreflightApprovalConsumed = true;
      if (threadSessionKey) {
        await deletePendingPdfPreflightApproval(env.MAKOTO_KV, threadSessionKey);
      }
      await recordRuntimeEvent(env, {
        eventKey,
        messageId: message.name,
        eventType: 'pdf_preflight_approval_consumed',
        source: 'chat-event-handler',
        detail: {
          attachment_count: attachmentForProcessing?.length ?? 0,
          approved_through_usd: pdfApprovedThroughUsdFloor,
        },
      });
    }

    const pendingCostApproval = await handlePendingSessionApproval(
      {
        kv: env.MAKOTO_KV,
        config: resolveSessionCostGuardConfig(env),
      },
      { threadSessionKey, text: bodyText },
    );
    if (pendingCostApproval.kind === 'reply') {
      await replyToCurrentSpace(env, ingressPlaceholderName, spaceName, pendingCostApproval.text, threadName, eventKey);
      await safeCommit(env, eventKey, claim, {
        messageId: message.name,
        userSlug: userMapping.user_slug,
        reason: 'cost_guard_session_approval_reply',
        stage: 'cost_guard_session_approval',
        outcome: 'committed',
        detail: {
          close_session: pendingCostApproval.closeSession,
          thread_key_present: Boolean(threadSessionKey),
          reply_chars: pendingCostApproval.text.length,
        },
      });
      console.log(
        `[chat-event] cost_guard_session_approval handled eventKey=${eventKey} ` +
          `decision=${pendingCostApproval.closeSession ? 'no' : 'yes_or_pending'} ` +
          `thread_key=${threadSessionKey ? 'present' : 'none'}`,
      );
      return { kind: 'committed' };
    }

  // ---- 5b. thread history prepend (Issue #186 A 業務影響大) ----
  // shared space / DM とも thread reply なら
  // thread の過去 message を fetch して
  // envelope の history 層に渡す (= mutating bodyText せず、orchestrator 側
  // `buildUserMessageEnvelope({history})` で Python l.4195 と byte 等価に連結)。
  // DM も人間からは同じ Chat thread として見えるため、CMA session 継続だけに
  // 頼らず、共有スペース同様に履歴を渡す。fetch failure は WARN + 空 fallback
  // で従来挙動を破壊しない。permanent failure (連続 3 回失敗) 後は KV mark で skip。
  //
  // Issue #186 既知 #6 (speaker-gate 完全実装): 履歴に未登録 chat_user_id が
  // 存在した場合は `hasUnresolvedSpeakers=true` を立て、後段 7b の
  // CHAT_POST dispatch を gate する (= Python `_compute_chat_post_gate` +
  // `_strip_chat_post_on_unresolved` 等価)。fetch 失敗時は false を維持し
  // 旧挙動 (= 履歴なし → gate しない) を破壊しない。
  let hasUnresolvedSpeakers = false;
  let historyBlock = '';
  const shouldFetchHistory =
    threadName !== null &&
    canFetchThreadHistory(env);
  if (shouldFetchHistory) {
    const isPermFail = await isHistoryPermanentlyFailed(env.MAKOTO_KV, threadName);
    if (!isPermFail) {
      try {
        const historyDeps = await resolveThreadHistoryDeps(env);
        const history = await fetchThreadMessages(
          historyDeps,
          spaceName,
          threadName,
        );
        const historyResult = formatThreadHistoryWithMeta(history, {
          currentMessageName: message.name ?? '',
        });
        historyBlock = historyResult.text;
        await recordRuntimeEvent(env, {
          eventKey,
          messageId: message.name,
          eventType: 'chat_history_fetch',
          source: 'chat-event-handler',
          detail: {
            ok: true,
            thread_hash_present: Boolean(threadName),
            history_chars: historyBlock.length,
            unresolved_count: historyResult.unresolvedCount,
          },
        });
        if (historyResult.unresolvedCount > 0) {
          hasUnresolvedSpeakers = true;
          console.warn(
            `[chat-event] unresolved_speakers detected eventKey=${eventKey} ` +
              `thread=${threadName} count=${historyResult.unresolvedCount} ` +
              `— CHAT_POST will be gated`,
          );
        }
        await clearHistoryFailure(env.MAKOTO_KV, threadName);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const failure = await recordHistoryFailure(
          env.MAKOTO_KV,
          threadName,
          reason,
        );
        console.warn(
          `[chat-event] history fetch fail eventKey=${eventKey} thread=${threadName} count=${failure.count}: ${reason}`,
        );
        await recordRuntimeEvent(env, {
          eventKey,
          messageId: message.name,
          eventType: 'chat_history_fetch',
          level: failure.permanent ? 'error' : 'warn',
          source: 'chat-event-handler',
          detail: {
            ok: false,
            failure_count: failure.count,
            permanent: failure.permanent,
            error: err instanceof Error ? err.message : String(err),
          },
        });
        if (failure.permanent) {
          await handleHistoryFetchPermanentFailure(
            env.MAKOTO_KV,
            threadName,
            'fetch_failure',
          );
        }
      }
    }
  }

  // ---- 5c. Google Chat roster/context is now on-demand (#246) ----
  // Worker no longer prefetches roster or prepends a space-context block
  // every turn. The CMA agent can call `chat_list_space_members` when it
  // actually needs roster context; Worker stays a thin control/execution
  // boundary instead of injecting speculative prompt context.
  // ---- 5d. intent detection (Issue #186 既知 #4 intent-detector 統合) ----
  // Cloud Run `cma_gchat_bot.py:_handle_event:l.4001-4031` 等価で、bodyText を
  // intent-detector に通して以下を決定:
  //   - `/mail` 以外の `isActionSkill=true` は orchestrator に
  //     `forceFreshSession=true` を渡し既存 thread session 継続を破棄
  //     (mail skill は既存社員 agent / session に統合する)
  //   - mail intent / schedule intent の log を出力 (Python l.4027/4031 等価)
  //   - intent 種別を user message envelope の <context> に prefix 注入
  //     (= context 質向上、agent が intent を考慮した応答を返しやすくする)
  // 危険語句 / 過剰 dispatch 防止:
  //   - intent 判定はあくまで「session 経路 + context prefix 注入」までで、
  //     ここで /mail や /schedule の skill 自体を invoke することはしない
  //     (= Python の `_resolve_skill_run` までは中間版で port していないため、
  //     intent 検出は session ephemeral 化と prefix log の効果に限定)。
  let intent = isAutonomousEvent
    ? null
    : detectActionSkillIntent(bodyText, ACTION_SKILL_INTENT_TABLE);
  if (!isAutonomousEvent && intent === null && isMailSendApprovalTurn(bodyText, historyBlock)) {
    intent = { command: '/mail', isActionSkill: true, source: 'mail_intent' };
    console.log(
      `[chat-event] mail confirmation approval detected eventKey=${eventKey}`,
    );
  }
  const forceFreshSession =
    intent?.isActionSkill === true && intent.command !== '/mail';
  if (intent !== null) {
    if (intent.source === 'mail_intent') {
      console.log(
        `[chat-event] mail intent detected eventKey=${eventKey} command=${intent.command}`,
      );
    } else if (intent.source === 'schedule_intent') {
      console.log(
        `[chat-event] schedule intent detected eventKey=${eventKey} command=${intent.command}`,
      );
    }
  }

  // ---- 6. orchestrate session ----
  const client = buildAnthropicClient(env);
  if (client === null) {
    console.error(`[chat-event] no Anthropic API key eventKey=${eventKey}`);
    await safeCommit(env, eventKey, claim, {
      messageId: message.name,
      userSlug: userMapping.user_slug,
      reason: 'no_anthropic_api_key',
      stage: 'anthropic_client_build',
      outcome: 'skipped',
      level: 'error',
    });
    return { kind: 'skipped', reason: 'no_anthropic_api_key' };
  }

  // ---- 6-pre. attachment processing (Issue #186 既知 #1 + O) ----
  // 画像 / PDF / Office 添付を Anthropic Sessions API の content block 群に
  // 変換する。env.CHAT_SA_KEY_JSON があるときだけ走らせ、空ならスキップ
  // (= 旧 path 完全互換、deploy 段階的 rollout 対応)。
  // 失敗で全体落とさないため try/catch で吸収し、cleanup は finally で必ず実行。
  let attachmentBlocks: Awaited<ReturnType<typeof buildAllAttachmentBlocks>> = {
    extraBlocks: [],
    notice: null,
    uploadedFileIds: [],
    pdfPreflight: null,
    deterministicReply: null,
    cleanup: async () => undefined,
  };
  let pdfPreflightChecked = false;
  if (env.CHAT_SA_KEY_JSON && attachmentForProcessing && attachmentForProcessing.length > 0) {
    const pdfAttachmentPresent = hasPdfAttachment(attachmentForProcessing);
    try {
      const sessionCostConfig = resolveSessionCostGuardConfig(env);
      attachmentBlocks = await buildAllAttachmentBlocks(
        { saKeyJson: env.CHAT_SA_KEY_JSON, anthropic: client },
        { attachment: attachmentForProcessing },
        {
          pdfPreflight: {
            model: sessionCostConfig.fallbackModel,
            sessionHardCapUsd: sessionCostConfig.thresholdsUsd[0] ?? 8,
          },
        },
      );
      await recordRuntimeEvent(env, {
        eventKey,
        messageId: message.name,
        eventType: 'attachment_build_result',
        source: 'chat-event-handler',
        detail: {
          attachment_count: attachmentForProcessing.length,
          has_pdf_attachment: pdfAttachmentPresent,
          pdf_preflight_present: Boolean(attachmentBlocks.pdfPreflight),
          deterministic_reply_present: Boolean(attachmentBlocks.deterministicReply),
          extra_blocks: attachmentBlocks.extraBlocks.length,
        },
      });
      if (
        pdfAttachmentPresent &&
        !attachmentBlocks.pdfPreflight &&
        !attachmentBlocks.deterministicReply
      ) {
        await recordRuntimeEvent(env, {
          eventKey,
          messageId: message.name,
          eventType: 'pdf_preflight_missing_fail_closed',
          level: 'error',
          source: 'chat-event-handler',
          detail: {
            attachment_count: attachmentForProcessing.length,
            extra_blocks: attachmentBlocks.extraBlocks.length,
          },
        });
        await postPdfPreflightFailClosed(
          env,
          {
            spaceName,
            threadName,
            eventKey,
            threadSessionKey,
            attachments: attachmentForProcessing,
            requestText: bodyText,
            approvedThroughUsd: sessionCostConfig.thresholdsUsd[0] ?? 8,
          },
        );
        await safeCommit(env, eventKey, claim, {
          messageId: message.name,
          userSlug: userMapping.user_slug,
          reason: 'pdf_preflight_missing_fail_closed',
          stage: 'attachment_processing',
          outcome: 'committed',
          level: 'error',
          detail: {
            attachment_count: attachmentForProcessing.length,
            extra_blocks: attachmentBlocks.extraBlocks.length,
          },
        });
        return { kind: 'committed' };
      }
      if (attachmentBlocks.pdfPreflight) {
        const pdfCostProjection = attachmentBlocks.pdfPreflight.result === 'allow'
          ? await projectSessionCostForPdfPreflight(
              {
                kv: env.MAKOTO_KV,
                config: sessionCostConfig,
              },
              {
                threadSessionKey,
                totalPages: attachmentBlocks.pdfPreflight.totalPages,
                estimatedTokensLow: attachmentBlocks.pdfPreflight.estimatedTokensLow,
                estimatedTokensHigh: attachmentBlocks.pdfPreflight.estimatedTokensHigh,
                estimatedCostLowUsd: attachmentBlocks.pdfPreflight.estimatedCostLowUsd,
                estimatedCostHighUsd: attachmentBlocks.pdfPreflight.estimatedCostHighUsd,
              },
            )
          : null;
        await recordRuntimeEvent(env, {
          eventKey,
          messageId: message.name,
          eventType: 'pdf_preflight_result',
          source: 'chat-event-handler',
          detail: {
            pdf_preflight_result: attachmentBlocks.pdfPreflight.result,
            pdf_page_count: attachmentBlocks.pdfPreflight.totalPages,
            pdf_total_bytes: attachmentBlocks.pdfPreflight.totalBytes,
            pdf_tier: attachmentBlocks.pdfPreflight.tier,
            estimated_tokens_low: attachmentBlocks.pdfPreflight.estimatedTokensLow,
            estimated_tokens_high: attachmentBlocks.pdfPreflight.estimatedTokensHigh,
            estimated_cost_low_usd: attachmentBlocks.pdfPreflight.estimatedCostLowUsd,
            estimated_cost_high_usd: attachmentBlocks.pdfPreflight.estimatedCostHighUsd,
            current_session_cost_usd: pdfCostProjection?.currentSessionUsd ?? null,
            projected_cost_low_usd: pdfCostProjection?.projectedLowUsd ?? null,
            projected_cost_high_usd: pdfCostProjection?.projectedHighUsd ?? null,
            next_threshold_usd: pdfCostProjection?.nextThresholdUsd ?? null,
            crossed_threshold_usd: pdfCostProjection?.crossedThresholdUsd ?? null,
            reasons: attachmentBlocks.pdfPreflight.reasons,
          },
        });
        pdfPreflightChecked = true;
        if (typeof pdfCostProjection?.crossedThresholdUsd === 'number') {
          pdfApprovedThroughUsdFloor = Math.max(
            pdfApprovedThroughUsdFloor ?? 0,
            pdfCostProjection.crossedThresholdUsd,
          );
        }
        if (
          pdfCostProjection?.promptText &&
          !pdfPreflightApprovalConsumed &&
          !isFullPdfReadOverride(bodyText)
        ) {
          if (threadSessionKey && pdfCostProjection.crossedThresholdUsd !== null) {
            await writePendingPdfPreflightApproval(
              env.MAKOTO_KV,
              threadSessionKey,
              {
                attachments: attachmentForProcessing,
                requestText: bodyText,
                approvedThroughUsd: pdfCostProjection.crossedThresholdUsd,
                createdAtMs: Date.now(),
              },
            );
          }
          await safePost(env, spaceName, pdfCostProjection.promptText, threadName, eventKey);
          await safeCommit(env, eventKey, claim, {
            messageId: message.name,
            userSlug: userMapping.user_slug,
            reason: 'pdf_preflight_prompt_posted',
            stage: 'attachment_processing',
            outcome: 'committed',
            detail: {
              crossed_threshold_usd: pdfCostProjection.crossedThresholdUsd,
              prompt_chars: pdfCostProjection.promptText.length,
            },
          });
          return { kind: 'committed' };
        }
      }
      if (attachmentBlocks.deterministicReply) {
        await safePost(env, spaceName, attachmentBlocks.deterministicReply, threadName, eventKey);
        await safeCommit(env, eventKey, claim, {
          messageId: message.name,
          userSlug: userMapping.user_slug,
          reason: 'attachment_deterministic_reply_posted',
          stage: 'attachment_processing',
          outcome: 'committed',
          detail: { reply_chars: attachmentBlocks.deterministicReply.length },
        });
        return { kind: 'committed' };
      }
      if (attachmentBlocks.extraBlocks.length > 0) {
        console.log(
          `[chat-event] attachments wired eventKey=${eventKey} ` +
            `blocks=${attachmentBlocks.extraBlocks.length} ` +
            `uploaded=${attachmentBlocks.uploadedFileIds.length}`,
        );
      }
    } catch (err) {
      console.warn(
        `[chat-event] attachment build failed eventKey=${eventKey}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      await recordRuntimeEvent(env, {
        eventKey,
        messageId: message.name,
        eventType: 'attachment_build_failed',
        level: 'error',
        source: 'chat-event-handler',
        detail: {
          has_pdf_attachment: pdfAttachmentPresent,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      if (pdfAttachmentPresent) {
        const sessionCostConfig = resolveSessionCostGuardConfig(env);
        await postPdfPreflightFailClosed(
          env,
          {
            spaceName,
            threadName,
            eventKey,
            threadSessionKey,
            attachments: attachmentForProcessing,
            requestText: bodyText,
            approvedThroughUsd: sessionCostConfig.thresholdsUsd[0] ?? 8,
          },
        );
        await safeCommit(env, eventKey, claim, {
          messageId: message.name,
          userSlug: userMapping.user_slug,
          reason: 'attachment_build_failed_pdf_fail_closed',
          stage: 'attachment_processing',
          outcome: 'committed',
          level: 'error',
          detail: { error: err instanceof Error ? err.message : String(err) },
        });
        return { kind: 'committed' };
      }
    }
  }
  if (
    env.CHAT_SA_KEY_JSON &&
    attachmentForProcessing &&
    hasPdfAttachment(attachmentForProcessing) &&
    !pdfPreflightChecked &&
    !pdfPreflightApprovalConsumed
  ) {
    const sessionCostConfig = resolveSessionCostGuardConfig(env);
    await recordRuntimeEvent(env, {
      eventKey,
      messageId: message.name,
      eventType: 'pdf_preflight_unchecked_fail_closed',
      level: 'error',
      source: 'chat-event-handler',
      detail: {
        attachment_count: attachmentForProcessing.length,
        extra_blocks: attachmentBlocks.extraBlocks.length,
        pdf_preflight_present: Boolean(attachmentBlocks.pdfPreflight),
      },
    });
    await postPdfPreflightFailClosed(
      env,
      {
        spaceName,
        threadName,
        eventKey,
        threadSessionKey,
        attachments: attachmentForProcessing,
        requestText: bodyText,
        approvedThroughUsd: sessionCostConfig.thresholdsUsd[0] ?? 8,
      },
    );
    await safeCommit(env, eventKey, claim, {
      messageId: message.name,
      userSlug: userMapping.user_slug,
      reason: 'pdf_preflight_unchecked_fail_closed',
      stage: 'attachment_processing',
      outcome: 'committed',
      level: 'error',
      detail: {
        attachment_count: attachmentForProcessing.length,
        extra_blocks: attachmentBlocks.extraBlocks.length,
      },
    });
    return { kind: 'committed' };
  }
  const attachmentNotice = attachmentBlocks.notice;
  const extraContentBlocks = attachmentBlocks.extraBlocks;

  if (eventKey.startsWith(MORNING_BRIEF_EVENT_KEY_PREFIX)) {
    await recordRuntimeEvent(env, {
      eventKey,
      messageId: message.name,
      eventType: 'morning_brief_long_turn_mode',
      source: 'chat-event-handler',
      detail: { stream_timeout_ms: MORNING_BRIEF_STREAM_TIMEOUT_MS },
    });
  }

  // ---- 6a. placeholder POST (#186 UX 致命傷) ----
  // session.create + LLM stream (24-45 秒) 前に短い ack を Chat に POST
  // し、Chat client の「MAKOTOくん から応答ありません」timeout 表示を
  // 抑止する。POST に成功すれば `placeholderName` を保持し、後で PATCH
  // 書き換え (= safeUpdateOrPost) または DELETE cleanup に使う。POST 自体
  // が失敗した場合は placeholderName 空のまま継続 = 旧経路 (POST 新規) に
  // fallback する (= UX 縮退するが bot 全体は落とさない、failure isolation)。
  const postedPlaceholder = ingressPlaceholderName
    ? null
    : await postChatPlaceholderResult(env, {
        spaceName,
        threadName,
        eventKey,
        messageId: message.name,
        claim,
        source: 'chat-event-handler',
      });
  const placeholderName = ingressPlaceholderName || postedPlaceholder?.name || '';
  const placeholderThreadName = postedPlaceholder?.threadName ?? null;
  // Per-event session id holder. orchestrator が sessions.create / KV lookup
  // を解決した直後、stream/tool dispatch の前に書き込む。
  const sessionIdRef: { current: string } = { current: '' };
  let sessionId: string;
  let assistantText: string;
  let sessionCostPrompt = '';
  const sessionOutputMinCreatedAtMs = Date.now() - 60_000;
  try {
    try {
      const orchestrated = await orchestrateChatTurn({
        env,
        client,
        senderEmail,
        spaceName,
        spaceType,
        threadName,
        bodyText,
        userMapping,
        personaSpec: PERSONA_SPEC,
        toolsSpec: TOOLS_SPEC,
        extraContentBlocks,
        ...(historyBlock ? { historyBlock } : {}),
        ...(intent
          ? {
              intent: {
                command: intent.command,
                ...(intent.source ? { source: intent.source } : {}),
                isActionSkill: intent.isActionSkill,
              },
            }
          : {}),
        toolDispatcher: (toolName, toolInput) =>
          actorTrusted
            ? dispatchMakotoTool(toolName, toolInput, {
                env,
                userSlug: userMapping.user_slug,
                boundMessageId: '',
                callerSessionId: sessionIdRef.current,
                currentSpaceName: spaceName,
                currentThreadName: threadName ?? undefined,
                anthropic: client,
              })
            : gateExternalToolCall(env, {
                eventKey,
                messageId: message.name,
                userSlug: userMapping.user_slug,
                toolName,
              }),
        eventKey,
        messageId: message.name,
        onSessionIdResolved: (resolvedSessionId) => {
          sessionIdRef.current = resolvedSessionId;
        },
        // Issue #208: mail skill は既存社員 agent / session へ統合するため
        // forceFreshSession しない。その他 action skill は従来通り bypass。
        forceFreshSession,
        timeoutMs: eventKey.startsWith(MORNING_BRIEF_EVENT_KEY_PREFIX)
          ? MORNING_BRIEF_STREAM_TIMEOUT_MS
          : parseReactiveStreamTimeoutMs(env.CMA_REACTIVE_STREAM_TIMEOUT_MS),
      });
      sessionId = orchestrated.sessionId;
      sessionIdRef.current = sessionId;
      assistantText = orchestrated.assistantText;
      if (orchestrated.stopReason === 'custom_tool_timeout') {
        await recordRuntimeEvent(env, {
          eventKey,
          sessionId,
          messageId: message.name,
          eventType: 'custom_tool_timeout_retry_no_notice',
          level: 'warn',
          source: 'chat-event-handler',
          detail: {
            tool_use_count: orchestrated.toolUseCount,
            tool_use_names: orchestrated.toolUseNames,
            placeholder_name_present: Boolean(placeholderName),
          },
        });
        await safeRelease(env, eventKey, claim);
        return { kind: 'release_and_retry', reason: 'custom_tool_timeout' };
      }

      // ---- 6b. cap-recovery (#186 既知 #3 配線) ----
      // Cloud Run の `cma_gchat_bot.py:_handle_event:l.4446-4494` 等価。
      // session.ts の `sendAndStreamWithToolDispatch` が cap (custom_tool_use /
      // built-in tool / session_watchdog) を踏むと `stopReason` を返す。
      // それが Python `_CAP_STOP_REASONS` 等価かを判定し、env flag が enable
      // なら recovery turn を 1 度だけ追撃し、得られた本文で assistantText を
      // 置換する。失敗/空/timeout/disabled は 既存挙動 (= 部分テキストの
      // まま) を温存する (= silent skip しない = 必ず構造化ログを残す)。
      //
      // session.ts の stopReason → Python `_CAP_STOP_REASONS` 用語 mapping:
      //   - `'custom_tool_call_cap'`  (TS, custom_tool_use 上限超過)
      //       → `'tool_call_cap'`     (Python `_CAP_STOP_REASONS[0]`)
      //   - `'tool_call_cap'`         (TS, built-in tool 上限超過)
      //       → `'tool_call_cap'`     (Python 同名)
      //   - `'session_watchdog'`      (TS, 壁時計超過)
      //       → `'session_watchdog'`  (Python 同名)
      //   - その他                    → mapping なし = recovery 対象外
      const capRecoveryConfig = resolveCapRecoveryConfig({
        ...(env.CMA_REACTIVE_MAX_TOOL_CALLS !== undefined
          ? { CMA_REACTIVE_MAX_TOOL_CALLS: env.CMA_REACTIVE_MAX_TOOL_CALLS }
          : {}),
        ...(env.CMA_REACTIVE_CAP_RECOVERY_ENABLED !== undefined
          ? {
              CMA_REACTIVE_CAP_RECOVERY_ENABLED:
                env.CMA_REACTIVE_CAP_RECOVERY_ENABLED,
            }
          : {}),
      });
      const pythonStopReason = mapToPythonCapStopReason(orchestrated.stopReason);
      if (
        pythonStopReason !== null &&
        shouldAttemptCapRecovery(pythonStopReason, capRecoveryConfig)
      ) {
        const executor: CapRecoveryStreamExecutor = async ({
          sessionId: sid,
          recoveryPrompt,
          maxToolCalls,
          toolDispatcher,
        }) => {
          const res = await sendAndStreamWithToolDispatch(client, {
            sessionId: sid,
            userMessage: recoveryPrompt,
            toolDispatcher,
            maxToolCalls,
            startAfterUserMessageEcho: true,
            payloadAudit: {
              kv: env.MAKOTO_KV,
              enabled: env.CMA_AUDIT_USER_MESSAGE_PAYLOADS,
              ttlDays: env.CMA_AUDIT_TTL_DAYS,
              maxTextChars: env.CMA_AUDIT_MAX_TEXT_CHARS,
              mode: 'chat-cap-recovery',
              context: {
                event_key: eventKey,
                space_name: spaceName,
                thread_name: threadName ?? '',
                sender_email: senderEmail,
              },
            },
          });
          return {
            text: res.assistantText,
            stopReason: res.stopReason ?? res.terminalEventType ?? '',
          };
        };
        const recoveryResult = await runCapRecovery({
          sessionId,
          executor,
        });
        const degraded =
          recoveryResult.toolNames.length > 0 ||
          (recoveryResult.stopReason !== '' &&
            mapToPythonCapStopReason(recoveryResult.stopReason) !== null);
        console.log(
          `[chat-event] cap_recovery outcome=${recoveryResult.outcome} ` +
            `eventKey=${eventKey} session=${sessionId} ` +
            `orig_stop=${pythonStopReason} rec_stop=${recoveryResult.stopReason || 'n/a'} ` +
            `rec_chars=${recoveryResult.text.length} ` +
            `rec_tools=${recoveryResult.toolNames.join(',') || 'n/a'} ` +
            `rec_degraded=${degraded} ` +
            `rec_error=${recoveryResult.error || 'n/a'}`,
        );
        await recordRuntimeEvent(env, {
          eventKey,
          sessionId,
          messageId: message.name,
          eventType: 'cap_recovery_result',
          level: recoveryResult.outcome === 'recovered' ? 'info' : 'warn',
          source: 'chat-event-handler',
          detail: {
            outcome: recoveryResult.outcome,
            original_stop_reason: pythonStopReason,
            recovery_stop_reason: recoveryResult.stopReason || null,
            recovery_text_chars: recoveryResult.text.length,
            recovery_tool_names: recoveryResult.toolNames,
            degraded,
            error: recoveryResult.error || null,
          },
        });
        if (recoveryResult.outcome === 'recovered' && recoveryResult.text) {
          // 収集済み部分テキストを recovered 本文で置換。
          // Python `collected[:] = [_rec["text"]]` + `_recovery_suppressed_cap_notice`
          // と同等の効果 (TS 中間版では cap notice 自体が未実装なので「置換」だけ
          // 行えば cap notice 抑止 = no-op で済む)。
          assistantText = recoveryResult.text;
        }
      }

      const usageSnapshot = await retrieveSessionUsageSnapshot(client, sessionId);
      if (usageSnapshot) {
        const costPrompt = await evaluateSessionCostAfterTurn(
          {
            kv: env.MAKOTO_KV,
            db: env.DB,
            config: resolveSessionCostGuardConfig(env),
          },
          {
            threadSessionKey,
            sessionId,
            snapshot: usageSnapshot,
            approvedThroughUsdFloor: pdfApprovedThroughUsdFloor,
          },
        );
        if (costPrompt) {
          sessionCostPrompt = costPrompt.promptText;
          console.log(
            `[chat-event] cost_guard_session_prompt eventKey=${eventKey} ` +
              `session=${sessionId} threshold=${costPrompt.thresholdUsd} ` +
              `current=${costPrompt.sessionUsd.toFixed(4)} ` +
              `next=${costPrompt.nextThresholdUsd}`,
          );
        }
      }
    } catch (err) {
      if (err instanceof OrchestratorFailure) {
        if (err.reason === 'sessions_create_failed' || err.reason === 'stream_failed') {
          console.error(
            `[chat-event] orchestrator transient eventKey=${eventKey} reason=${err.reason}: ${err.message}`,
          );
          await recordRuntimeEvent(env, {
            eventKey,
            messageId: message.name,
            userSlug: userMapping.user_slug,
            eventType: 'orchestrator_transient_retry_no_notice',
            level: 'warn',
            source: 'chat-event-handler',
            detail: {
              reason: err.reason,
              error: redactPiiInText(err.message).slice(0, 1000),
              placeholder_name_present: Boolean(placeholderName),
            },
          });
          await safeRelease(env, eventKey, claim);
          return { kind: 'release_and_retry', reason: err.reason };
        }
        if (placeholderName) {
          await safeDeletePlaceholder(env, placeholderName, eventKey);
        }
        // no_anthropic_client = misconfigured deploy, skip + commit (Queue 暴走防止)
        console.error(`[chat-event] orchestrator fatal eventKey=${eventKey}: ${err.message}`);
        await safeCommit(env, eventKey, claim, {
          messageId: message.name,
          userSlug: userMapping.user_slug,
          reason: err.reason,
          stage: 'orchestrator',
          outcome: 'skipped',
          level: 'error',
          detail: { error: err.message },
        });
        return { kind: 'skipped', reason: err.reason };
      }
      if (placeholderName) {
        await safeDeletePlaceholder(env, placeholderName, eventKey);
      }
      // Unknown throw — defensive: release & retry
      console.error(
        `[chat-event] orchestrator threw eventKey=${eventKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await safeRelease(env, eventKey, claim);
      return { kind: 'release_and_retry', reason: 'unknown_orchestrator_throw' };
    }
  } finally {
    // Anthropic Files API へ upload した file_id は 1 ターン使い切りで delete
    // する (= 500GB/org 枠を食わない使い捨て運用、Python `_delete_from_files_api`
    // 等価)。orchestrate の成否を問わず必ず実行。
    if (attachmentBlocks.uploadedFileIds.length > 0) {
      try {
        await attachmentBlocks.cleanup();
      } catch (cleanupErr) {
        console.warn(
          `[chat-event] attachment cleanup failed eventKey=${eventKey}: ` +
            `${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }
    }
  }

  // ---- 7. parse markers + dispatch ----
  const heartbeatEvent = isHeartbeatEventKey(eventKey);
  // 7a. EMAIL_SEND markers
  const emailParsed = parseAssistantText(assistantText);
  for (const f of emailParsed.failures) {
    console.warn(
      `[chat-event] EMAIL_SEND parse failure eventKey=${eventKey} reason=${f.reason} raw=${f.raw.slice(0, 200)}`,
    );
  }
  if (heartbeatEvent && emailParsed.markers.length > 0) {
    await recordHeartbeatExternalToolSuppressed(env, eventKey, message.name, userMapping.user_slug, {
      toolFamily: 'EMAIL_SEND',
      markerCount: emailParsed.markers.length,
    });
  }
  const emailDispatchSummaries = await dispatchEmailMarkers(
    env,
    eventKey,
    heartbeatEvent ? [] : emailParsed.markers,
    sessionId,
    userMapping.agent_id,
    claim,
    { actorTrusted, messageId: message.name, userSlug: userMapping.user_slug },
  );
  const asyncWaitRegistration = heartbeatEvent
    ? { text: '' }
    : await maybeRegisterMailReplyAsyncWait(env, {
        eventKey,
        messageId: message.name,
        userSlug: userMapping.user_slug,
        senderEmail,
        spaceName,
        spaceType,
        bodyText,
        emailDispatchSummaries,
      });

  // 7b. CHAT_POST markers (= 別 space 投稿)。本文中の全 marker を strip
  //     しつつ posting する。`parseChatPostMarker` は first-match のみ返す
  //     設計なので、本文を進めながら繰り返し parse する。
  //
  // Issue #186 既知 #6: shared space で未解決 speaker (= roster fetch 失敗 /
  // member 未識別) が居る場合、CHAT_POST 全 marker を `applyChatPostGateToText`
  // で先に strip し、`dispatchChatPostMarkers` には marker のない本文を渡す
  // (= Python `_strip_chat_post_on_unresolved` + `_handle_chat_post_marker`
  // のスキップ等価)。これにより未確認ユーザー混在 thread から別 space への
  // 横展開 (= 権限事故源) を機械的に塞ぐ。gate されなかった場合 (hasUnresolved=false
  // or DM) は素通し = 旧挙動温存。
  const heartbeatChatPostMarkerCount = heartbeatEvent
    ? countChatPostMarkers(emailParsed.cleanedText)
    : 0;
  if (heartbeatChatPostMarkerCount > 0) {
    await recordHeartbeatExternalToolSuppressed(env, eventKey, message.name, userMapping.user_slug, {
      toolFamily: 'CHAT_POST',
      markerCount: heartbeatChatPostMarkerCount,
    });
  }
  const chatPostResult = heartbeatEvent
    ? { cleanedText: stripChatPostMarkersForHeartbeat(emailParsed.cleanedText) }
    : await (async () => {
        const chatPostGateApplication = applyChatPostGateToText(
          emailParsed.cleanedText,
          hasUnresolvedSpeakers || !actorTrusted,
        );
        if (chatPostGateApplication.decision.gate) {
          console.log(
            `[chat-event] CHAT_POST gated eventKey=${eventKey} ` +
              `reason=${chatPostGateApplication.decision.reason} ` +
              (actorTrusted ? `(unresolved speakers in history)` : `(default actor fallback)`),
          );
          if (!actorTrusted) {
            await recordRuntimeEvent(env, {
              eventKey,
              messageId: message.name,
              userSlug: userMapping.user_slug,
              eventType: 'external_tool_gated',
              level: 'warn',
              source: 'chat-event-handler',
              detail: { tool_family: 'CHAT_POST', actor_source: 'default_user_fallback' },
            });
          }
        }
        return dispatchChatPostMarkers(
          env,
          eventKey,
          chatPostGateApplication.text,
          spaceName,
          threadName,
          claim,
        );
      })();

  // 7c. SCHEDULE_ACTION markers (Issue #186 #5 follow-up = 実 dispatch)。
  //     env (CHAT_SA_KEY_JSON + GCP_SCHEDULER_PROJECT + GCP_SCHEDULER_LOCATION)
  //     が揃っているときだけ activate する (= 既存挙動破壊しない、deploy
  //     gradual rollout の余地を残す)。失敗は WARN log + 元 cleanedText
  //     で投稿継続 (failure isolation)。
  const heartbeatScheduleMarkers = heartbeatEvent
    ? parseScheduleActionMarkers(chatPostResult.cleanedText)
    : [];
  if (heartbeatScheduleMarkers.length > 0) {
    await recordHeartbeatExternalToolSuppressed(env, eventKey, message.name, userMapping.user_slug, {
      toolFamily: 'SCHEDULE_ACTION',
      markerCount: heartbeatScheduleMarkers.length,
    });
  }
  const scheduleResult = heartbeatEvent
    ? { cleanedText: stripScheduleActionMarkers(chatPostResult.cleanedText).trim() }
    : await dispatchScheduleActionMarkers(
        env,
        eventKey,
        message.name,
        threadName,
        chatPostResult.cleanedText,
        { actorTrusted, messageId: message.name, userSlug: userMapping.user_slug },
      );

  // 7d. current space 投稿 (clean 後本文)
  // 7d-1. internal-state redaction を最終ガード (= safety net)。
  const finalMarkerExtraction = extractFinalMarkerText(scheduleResult.cleanedText);
  if (finalMarkerExtraction.markerFound) {
    console.log(`[chat-event] final marker extracted eventKey=${eventKey}`);
  }
  const heartbeatNothingExtraction = extractHeartbeatNothingText(finalMarkerExtraction.text);
  if (heartbeatNothingExtraction.suppress) {
    console.log(`[chat-event] heartbeat nothing marker suppressed eventKey=${eventKey}`);
    if (placeholderName) {
      await safeDeletePlaceholder(env, placeholderName, eventKey);
    }
    await safeCommit(env, eventKey, claim, {
      messageId: message.name,
      userSlug: userMapping.user_slug,
      reason: 'heartbeat_nothing_marker',
      stage: 'final_chat_reply',
      outcome: 'committed',
      detail: { marker: 'HEARTBEAT_NOTHING' },
    });
    return { kind: 'committed' };
  }
  const displayText = normalizeEmailPreviewEscapedNewlines(
    heartbeatNothingExtraction.text,
    emailParsed.markers.length,
  );
  const markerLeakScrubbed = scrubActionMarkerLeakForChat(
    displayText,
    emailParsed.markers.length,
  );
  if (markerLeakScrubbed.scrubbed) {
    console.warn(
      `[chat-event] action-marker leak scrubbed eventKey=${eventKey} ` +
        `reason=${markerLeakScrubbed.reason}`,
    );
  }
  const outputDelivery = await deliverSessionOutputsToDrive({
    env,
    sessionId,
    sourceText: markerLeakScrubbed.text,
    artifactHintText: bodyText,
    minCreatedAtMs: sessionOutputMinCreatedAtMs,
    eventKey,
    resolveDriveDeps: async () => {
      const ctx = {
        env,
        userSlug: userMapping.user_slug,
        boundMessageId: message.name,
        callerSessionId: sessionId,
      };
      const token = await resolveMakotoWorkspaceAccessToken(ctx);
      if (token.kind === 'fail') {
        throw new Error(token.error);
      }
      return {
        accessToken: token.access_token,
        refreshAccessToken: makeMakotoWorkspaceRefreshAccessToken(ctx),
      };
    },
  });
  if (
    outputDelivery.uploaded.length > 0 ||
    outputDelivery.failures.length > 0 ||
    outputDelivery.sanitizedPathCount > 0
  ) {
    console.log(
      `[chat-event] session_outputs delivered eventKey=${eventKey} session=${sessionId} ` +
        `uploaded=${outputDelivery.uploaded.length} failures=${outputDelivery.failures.length} ` +
        `skipped=${outputDelivery.skipped.length} sanitized_paths=${outputDelivery.sanitizedPathCount}`,
    );
  }
  const softened = softenBenignInternalReferencesForChat(outputDelivery.text);
  if (softened.replacements.length > 0) {
    console.warn(
      `[chat-event] benign internal references softened eventKey=${eventKey} ` +
        `replacements=${softened.replacements.join(',')}`,
    );
  }
  const masked = maskInternalStateForChat(softened.text);
  if (masked.hits.length > 0) {
    console.warn(
      `[chat-event] internal-state redactor masked eventKey=${eventKey} hits=${masked.hits.join(',')}`,
    );
  }
  const visibleText =
    masked.hits.length > 0
      ? `${masked.text}\n\n（内部運用表現を一部伏せました。回答本文は表示しています。）`
      : masked.text;
  // 添付処理の notice を本文末尾に追記 (Python では `_build_*_attachments` の
  // notice をそのまま投稿本文に concat していたのと等価)。本文空 + notice
  // のみのケースも次の `finalText.trim().length > 0` 判定で投稿される。
  const emailDispatchText = formatEmailDispatchSummaries(emailDispatchSummaries);
  const finalTextParts = [
    visibleText,
    emailDispatchText,
    asyncWaitRegistration.text,
    attachmentNotice,
    sessionCostPrompt,
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  const finalText = finalTextParts.join('\n\n').trim();
  const chatReplyText =
    finalText.trim().length > 0
      ? finalText
      : 'CMA は処理を完了しましたが、Chat に表示できる本文が空でした。副作用マーカーだけが出力された可能性があります。';
  if (finalText.trim().length === 0) {
    console.warn(
      `[chat-event] empty clean text after marker strip eventKey=${eventKey} session=${sessionId}; posting visible notice`,
    );
  }
  const autonomousLongReply = buildAutonomousLongReplyDelivery(eventKey, chatReplyText);
  // placeholder POST 済なら PATCH 書き換え (Python `_placeholder_reply`
  // = `_update_chat_message` 経路、l.3926-3942 等価)。PATCH 失敗時は
  // WARN log + safePost に fallback (= bot 全体は落とさない、Python
  // l.3940-3942 等価)。placeholder 無し (POST 自体が失敗していたケース)
  // は従来通り新規 POST。
  //
  // 3-stage precheck wrap (Python `cma_lib.py:send_chat_reply` 等価)。
  // 同一 (eventKey, kind='chat_reply', target=`${spaceName}:${threadName}`)
  // 既送信なら ALREADY → 二重 reply を構造的に防ぐ (life #1266 系再発防止)。
  const chatReplyOutcome = await executeWithCommit({
    env,
    parentEventKey: eventKey,
    parentOwner: claim.owner,
    kind: 'chat_reply',
    target: `${spaceName}:${threadName ?? ''}`,
    sendFn: async () => {
      if (autonomousLongReply) {
        let replyThreadName = threadName || placeholderThreadName;
        if (placeholderName) {
          await safeUpdateOrPost(
            env,
            placeholderName,
            spaceName,
            autonomousLongReply.title,
            replyThreadName,
            eventKey,
          );
        } else {
          const titlePost = await safePost(
            env,
            spaceName,
            autonomousLongReply.title,
            threadName,
            eventKey,
          );
          replyThreadName = replyThreadName || titlePost?.threadName || null;
        }
        await safePost(
          env,
          spaceName,
          autonomousLongReply.body,
          replyThreadName,
          eventKey,
        );
      } else if (placeholderName) {
        await safeUpdateOrPost(env, placeholderName, spaceName, chatReplyText, threadName, eventKey);
      } else {
        await safePost(env, spaceName, chatReplyText, threadName, eventKey);
      }
      // sendFn の戻り値は使わないが outcome.result 用 sentinel に void を入れる。
      return undefined as unknown as void;
    },
    options: parentHeartbeat ? { heartbeat: parentHeartbeat } : {},
  });
  if (chatReplyOutcome.outcome === 'already') {
    await recordRuntimeEvent(env, {
      eventKey,
      sessionId,
      messageId: message.name,
      eventType: 'final_chat_reply_result',
      source: 'chat-event-handler',
      detail: { outcome: 'already' },
    });
    console.log(
      `[chat-event] chat_reply already sent eventKey=${eventKey} space=${spaceName} — skipping duplicate`,
    );
  } else if (chatReplyOutcome.outcome === 'lease_alive') {
    await recordRuntimeEvent(env, {
      eventKey,
      sessionId,
      messageId: message.name,
      eventType: 'final_chat_reply_result',
      level: 'warn',
      source: 'chat-event-handler',
      detail: { outcome: 'lease_alive' },
    });
    console.warn(
      `[chat-event] chat_reply in-flight by another worker eventKey=${eventKey} space=${spaceName}`,
    );
    await safeRelease(env, eventKey, claim);
    return { kind: 'release_and_retry', reason: 'chat_reply_lease_alive' };
  } else if (chatReplyOutcome.outcome === 'lease_lost') {
    await recordRuntimeEvent(env, {
      eventKey,
      sessionId,
      messageId: message.name,
      eventType: 'final_chat_reply_result',
      level: 'warn',
      source: 'chat-event-handler',
      detail: { outcome: 'lease_lost' },
    });
    console.warn(
      `[chat-event] chat_reply lease lost eventKey=${eventKey} space=${spaceName}`,
    );
  } else if (chatReplyOutcome.outcome === 'sent') {
    await recordRuntimeEvent(env, {
      eventKey,
      sessionId,
      messageId: message.name,
      eventType: 'final_chat_reply_result',
      source: 'chat-event-handler',
      detail: {
        outcome: 'sent',
        mode: autonomousLongReply
          ? 'autonomous_long_reply_split'
          : placeholderName
            ? 'patch_or_post_fallback'
            : 'post',
        final_text_chars: chatReplyText.length,
        autonomous_split: Boolean(autonomousLongReply),
      },
    });
  }

  // ---- 8. session-log memory append ----
  await safeAppendSessionLog(env, {
    eventKey,
    client,
    senderEmail,
    spaceType,
    userSlug: userMapping.user_slug,
    memoryAttachments: userMapping.memory_attachments,
    space,
    sender,
    threadName,
    userText: bodyText,
    finalText: chatReplyText,
    sessionId,
    messageId: message.name,
  });

  // ---- 9. commit ----
  await safeCommit(env, eventKey, claim, {
    messageId: message.name,
    userSlug: userMapping.user_slug,
    reason: 'normal_chat_turn_completed',
    stage: 'final_commit',
    outcome: 'committed',
    detail: {
      session_id_present: Boolean(sessionId),
      final_text_chars: finalText.length,
    },
  });
  return { kind: 'committed' };
  } finally {
    if (parentHeartbeat) {
      await parentHeartbeat.stop();
    }
    if (turnProcessingClaim) {
      await safeReleaseChatTurnProcessing(env, turnProcessingClaim);
    }
    try {
      await chatScopeLock.release(chatScopeKey);
    } catch (err) {
      console.warn(
        `[chat-event] chat scope lock release failed eventKey=${eventKey}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// helper: dispatch EMAIL_SEND markers
// ---------------------------------------------------------------------------

interface ActorGateOptions {
  actorTrusted: boolean;
  messageId: string | null;
  userSlug: string;
}

async function gateExternalToolCall(
  env: Env,
  input: {
    eventKey: string;
    messageId: string | null;
    userSlug: string;
    toolName: string;
  },
): Promise<{ ok: false; payload: { error: string; tool: string; message: string } }> {
  await recordRuntimeEvent(env, {
    eventKey: input.eventKey,
    messageId: input.messageId,
    userSlug: input.userSlug,
    eventType: 'external_tool_gated',
    level: 'warn',
    source: 'chat-event-handler',
    detail: {
      tool_family: 'custom_tool',
      tool: input.toolName,
      actor_source: 'default_user_fallback',
    },
  });
  return {
    ok: false,
    payload: {
      error: 'external_tool_gated',
      tool: input.toolName,
      message: '外部連携操作は登録済みユーザーの現在発話でのみ実行します。',
    },
  };
}

/**
 * Inline 実装 (= agentmail-dispatch.ts と同等 logic だが import せず別実装)。
 * 理由: agentmail-dispatch.ts は AgentMail webhook 経路専用 (inbox_id を webhook
 * envelope から抽出する)。chat 経路は env.AGENTMAIL_DEFAULT_INBOX_ID 固定 inbox
 * を使うため flow が分離する。
 */
async function dispatchEmailMarkers(
  env: Env,
  eventKey: string,
  markers: EmailSendMarker[],
  sessionId: string,
  agentId: string,
  claim: { owner: string; version: number },
  gate: ActorGateOptions,
): Promise<EmailDispatchSummary[]> {
  if (markers.length === 0) return [];
  if (!gate.actorTrusted) {
    await recordRuntimeEvent(env, {
      eventKey,
      sessionId,
      messageId: gate.messageId,
      userSlug: gate.userSlug,
      eventType: 'external_tool_gated',
      level: 'warn',
      source: 'chat-event-handler',
      detail: {
        tool_family: 'EMAIL_SEND',
        marker_count: markers.length,
        actor_source: 'default_user_fallback',
      },
    });
    return markers.map((m) => ({
      status: 'failed',
      to: m.to,
      subject: m.subject,
      reason: '外部連携操作は登録済みユーザーの現在発話でのみ実行します',
    }));
  }
  const summaries: EmailDispatchSummary[] = [];
  const apiKey = env.AGENTMAIL_API_KEY;
  const inboxId = env.AGENTMAIL_DEFAULT_INBOX_ID;
  if (!apiKey) {
    console.warn(
      `[chat-event] EMAIL_SEND skipped eventKey=${eventKey}: AGENTMAIL_API_KEY missing (${markers.length} marker(s))`,
    );
    return markers.map((m) => ({
      status: 'failed',
      to: m.to,
      subject: m.subject,
      reason: 'メール送信設定が不足しています',
    }));
  }
  if (!inboxId) {
    console.warn(
      `[chat-event] EMAIL_SEND skipped eventKey=${eventKey}: AGENTMAIL_DEFAULT_INBOX_ID missing (${markers.length} marker(s))`,
    );
    return markers.map((m) => ({
      status: 'failed',
      to: m.to,
      subject: m.subject,
      reason: 'メール送信設定が不足しています',
    }));
  }
  const opts = env.AGENTMAIL_API_BASE_URL ? { baseUrl: env.AGENTMAIL_API_BASE_URL } : {};
  const client = new AgentMailClient(apiKey, opts);

  for (const m of markers) {
    try {
      const scrub = scrubInternalStateForChat(m.body, `mail-send/${sessionId}`);
      if (scrub.hits.length > 0) {
        console.warn(
          `[chat-event] EMAIL_SEND body redactor scrubbed eventKey=${eventKey} hits=${scrub.hits.join(',')}`,
        );
      }
      const baseInput = {
        inboxId,
        to: [m.to],
        subject: m.subject,
        body: scrub.text,
        ...(m.cc && m.cc.length > 0 ? { cc: m.cc } : {}),
        ...(m.bcc && m.bcc.length > 0 ? { bcc: m.bcc } : {}),
        ...(m.attachments && m.attachments.length > 0
          ? { attachments: m.attachments }
          : {}),
      };
      // 3-stage precheck wrap (Python `cma_lib.py:send_mail` 等価)。
      // 同一 (eventKey, kind='email_send', target=`${inboxId}:${to}:${in_reply_to_id}`)
      // 既送信なら ALREADY → AgentMail への二重送信を構造的に防ぐ。
      // target に in_reply_to_message_id を入れることで「同 inbox/同 to でも
      // 別 thread への返信は別 send」として扱う。
      const emailTarget = `${inboxId}:${m.to}:${m.in_reply_to_message_id ?? ''}`;
      const emOutcome = await executeWithCommit({
        env,
        parentEventKey: eventKey,
        parentOwner: claim.owner,
        kind: 'email_send',
        target: emailTarget,
        sendFn: async () => {
          if (m.in_reply_to_message_id) {
            return await client.replyMessage({
              ...baseInput,
              parentMessageId: m.in_reply_to_message_id,
            });
          }
          return await client.sendMessage(baseInput);
        },
      });
      if (emOutcome.outcome === 'already') {
        console.log(
          `[chat-event] EMAIL_SEND already sent eventKey=${eventKey} to=${redactPiiInText(m.to)} — skipping duplicate`,
        );
        summaries.push({ status: 'already', to: m.to, subject: m.subject });
        continue;
      }
      if (emOutcome.outcome === 'lease_alive') {
        console.warn(
          `[chat-event] EMAIL_SEND in-flight by another worker eventKey=${eventKey} to=${redactPiiInText(m.to)}`,
        );
        summaries.push({
          status: 'failed',
          to: m.to,
          subject: m.subject,
          reason: '別処理が送信中です',
        });
        continue;
      }
      if (emOutcome.outcome === 'lease_lost') {
        // sent_messages 記録は committed されない (= heartbeat dead or fence drift)
        console.warn(
          `[chat-event] EMAIL_SEND lease lost eventKey=${eventKey} to=${redactPiiInText(m.to)}`,
        );
        summaries.push({
          status: 'failed',
          to: m.to,
          subject: m.subject,
          reason: '送信確認が完了できませんでした',
        });
        continue;
      }
      if (emOutcome.outcome === 'precheck_failed') {
        console.warn(
          `[chat-event] EMAIL_SEND precheck failed eventKey=${eventKey} to=${redactPiiInText(m.to)} reason=${emOutcome.reason}`,
        );
        summaries.push({
          status: 'failed',
          to: m.to,
          subject: m.subject,
          reason: '送信前確認に失敗しました',
        });
        continue;
      }
      // outcome === 'sent'
      const sendResult = emOutcome.result;
      if (sendResult.message_id) {
        await recordSentMessage(
          env.DB,
          sendResult.message_id,
          sessionId,
          agentId,
          m.to,
          sendResult.rfc822_message_id || undefined,
          'chat_user_requested',
        );
      }
      console.log(
        `[chat-event] EMAIL_SEND ok eventKey=${eventKey} to=${redactPiiInText(m.to)} subject_chars=${m.subject.length}`,
      );
      summaries.push({ status: 'sent', to: m.to, subject: m.subject });
    } catch (err) {
      if (err instanceof AgentMailError) {
        console.warn(
          `[chat-event] EMAIL_SEND fail eventKey=${eventKey} to=${redactPiiInText(m.to)} status=${err.status} transient=${err.transient}: ${redactPiiInText(err.message)}`,
        );
        await recordEmailDispatchFailure(env, {
          eventKey,
          sessionId,
          to: m.to,
          subject: m.subject,
          status: err.status,
          transient: err.transient,
          message: err.message,
          body: err.body,
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[chat-event] EMAIL_SEND threw eventKey=${eventKey} to=${redactPiiInText(m.to)}: ${redactPiiInText(message)}`,
        );
        await recordEmailDispatchFailure(env, {
          eventKey,
          sessionId,
          to: m.to,
          subject: m.subject,
          status: 0,
          transient: true,
          message,
        });
      }
      // 1 marker 失敗で全体落とさない (failure isolation)。
      summaries.push({
        status: 'failed',
        to: m.to,
        subject: m.subject,
        reason: formatEmailDispatchErrorReason(err),
      });
    }
  }
  return summaries;
}

interface EmailDispatchSummary {
  status: 'sent' | 'already' | 'failed';
  to: string;
  subject: string;
  reason?: string;
}

interface MailReplyAsyncWaitInput {
  eventKey: string;
  messageId: string;
  userSlug: string;
  senderEmail: string;
  spaceName: string;
  spaceType: string;
  bodyText: string;
  emailDispatchSummaries: EmailDispatchSummary[];
}

async function maybeRegisterMailReplyAsyncWait(
  env: Env,
  input: MailReplyAsyncWaitInput,
): Promise<{ text: string }> {
  const sent = input.emailDispatchSummaries.filter((summary) => summary.status === 'sent');
  if (sent.length === 0) return { text: '' };
  if (!isMailReplyWaitRequest(input.bodyText)) return { text: '' };

  const target = await resolveAsyncWaitTargetSpace(env.MAKOTO_KV, input.senderEmail, input.spaceName, input.spaceType);
  if (!target.spaceName) {
    await recordRuntimeEvent(env, {
      eventKey: input.eventKey,
      messageId: input.messageId,
      userSlug: input.userSlug,
      eventType: 'heartbeat_async_wait_register_skipped',
      level: 'warn',
      source: 'chat-event-handler',
      detail: { reason: 'missing_sender_dm_space', space_type: input.spaceType },
    });
    return {
      text:
        '⚠️ メール送信は完了しましたが、返信待ち登録はできませんでした。\n' +
        '本人DMの宛先が未記録です。先にDMで一度話しかけてください。',
    };
  }

  const expectedFrom = uniqueStrings(sent.map((summary) => normalizeEmailAddress(summary.to)));
  if (expectedFrom.length === 0) return { text: '' };

  const subjects = uniqueStrings(sent.map((summary) => summary.subject.trim()).filter(Boolean));
  const nowMs = Date.now();
  const taskId = `async_mail_wait_${stableHash(input.eventKey) ?? String(nowMs)}`;
  const subjectContains = subjects.length === 1 ? subjects[0]!.slice(0, 160) : undefined;
  const threadRef = {
    expected_from: expectedFrom,
    since_ms: nowMs - 60_000,
    ...(subjectContains ? { subject_contains: subjectContains } : {}),
  };
  const prompt = buildMailReplyAsyncWaitPrompt(input.bodyText, sent);
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO heartbeat_tasks
        (task_id, owner_user_id, target_space_name, kind, prompt, interval_min,
         active_hours, target_scope, enabled, last_run_at, status, stage,
         waiting_for, next_check_at, last_progress_at, attempt_count, stop_reason,
         thread_ref, user_visible_status, created_at, updated_at)
       VALUES
        (?1, ?2, ?3, 'async_wait', ?4, ?5,
         NULL, 'dm', 1, NULL, 'waiting', 'mail_reply_wait',
         'mail_reply', ?6, ?7, 0, NULL,
         ?8, ?9, ?7, ?7)`,
    )
      .bind(
        taskId,
        input.senderEmail,
        target.spaceName,
        prompt,
        1,
        nowMs + 60_000,
        nowMs,
        JSON.stringify(threadRef),
        `waiting for mail replies (0/${expectedFrom.length})`,
      )
      .run();
    await recordRuntimeEvent(env, {
      eventKey: input.eventKey,
      messageId: input.messageId,
      userSlug: input.userSlug,
      eventType: 'heartbeat_async_wait_registered',
      source: 'chat-event-handler',
      detail: {
        task_id: taskId,
        expected_count: expectedFrom.length,
        subject_contains: subjectContains ?? null,
        target_route: target.route,
      },
    });
    return {
      text:
        `⏳ 返信待ちを登録しました\n` +
        `対象: ${expectedFrom.length}件\n` +
        (target.route === 'current_dm'
          ? `返信が揃ったら、このDMに集計して再開します。`
          : `返信が揃ったら、本人DMに集計して再開します。`),
    };
  } catch (error) {
    await recordRuntimeEvent(env, {
      eventKey: input.eventKey,
      messageId: input.messageId,
      userSlug: input.userSlug,
      eventType: 'heartbeat_async_wait_register_failed',
      level: 'error',
      source: 'chat-event-handler',
      detail: { error: error instanceof Error ? error.message : String(error) },
    });
    return { text: '⚠️ メール送信は完了しましたが、返信待ち登録に失敗しました。' };
  }
}

async function rememberSenderDmSpace(
  kv: KVNamespace,
  senderEmail: string,
  spaceName: string,
  spaceType: string,
): Promise<void> {
  if (spaceType !== 'DM' || !spaceName) return;
  const email = normalizeSenderEmail(senderEmail);
  if (!email) return;
  try {
    await kv.put(`${CHAT_DM_SPACE_KV_PREFIX}${email}`, spaceName);
  } catch (error) {
    console.warn(
      `[chat-event] remember dm space failed email_hash=${stableHash(email)}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function resolveAsyncWaitTargetSpace(
  kv: KVNamespace,
  senderEmail: string,
  currentSpaceName: string,
  spaceType: string,
): Promise<{ spaceName: string | null; route: 'current_dm' | 'sender_dm_kv' | 'missing_sender_dm_space' }> {
  if (spaceType === 'DM') return { spaceName: currentSpaceName, route: 'current_dm' };
  const email = normalizeSenderEmail(senderEmail);
  if (!email) return { spaceName: null, route: 'missing_sender_dm_space' };
  const dmSpaceName = await kv.get(`${CHAT_DM_SPACE_KV_PREFIX}${email}`);
  if (!dmSpaceName) return { spaceName: null, route: 'missing_sender_dm_space' };
  return { spaceName: dmSpaceName, route: 'sender_dm_kv' };
}

function isMailReplyWaitRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  return (
    /(返信|返事|回答).*(待|揃|そろ|集計|まとめ|再開)/.test(normalized) ||
    /(待|揃|そろ).*(返信|返事|回答)/.test(normalized) ||
    /(返信|返事|回答)(が|を)?(届いた|来た|きた|返ってきた|揃った|そろった)ら/.test(normalized)
  );
}

function buildMailReplyAsyncWaitPrompt(
  originalRequest: string,
  sent: EmailDispatchSummary[],
): string {
  const sentLines = sent.map((summary) => `- ${summary.to} / ${summary.subject}`).join('\n');
  return [
    'メール返信待ちの非同期継続です。',
    '以下の送信先からの返信が揃ったら、返信内容を短く集計し、次アクション案を本人DMに出してください。',
    '',
    '元の依頼:',
    originalRequest.trim().slice(0, 2000),
    '',
    '送信済みメール:',
    sentLines,
  ].join('\n');
}

function normalizeEmailAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  const raw = (match?.[1] ?? value).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw) ? raw : '';
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function formatEmailDispatchSummaries(summaries: EmailDispatchSummary[]): string {
  if (summaries.length === 0) return '';
  return summaries
    .map((summary) => {
      const header =
        summary.status === 'sent'
          ? '✅ メール送信完了'
          : summary.status === 'already'
            ? '✅ メール送信済み'
            : '❌ メール送信失敗';
      const lines = [
        header,
        `宛先: ${summary.to}`,
        `件名: ${summary.subject}`,
      ];
      if (summary.status === 'failed' && summary.reason) {
        lines.push(`理由: ${summary.reason}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

function scrubActionMarkerLeakForChat(
  text: string,
  parsedEmailMarkerCount: number,
): { text: string; scrubbed: boolean; reason: string } {
  if (parsedEmailMarkerCount > 0) {
    return { text, scrubbed: false, reason: '' };
  }
  const normalized = text.toLowerCase();
  const rawMarkerSyntax =
    /`?\b(email_send|chat_post|schedule_action)\b`?\s*:\s*\{/i.test(text);
  const processingStateTalk =
    text.includes('処理中') ||
    text.includes('処理しています') ||
    text.includes('すでに') ||
    text.includes('既に') ||
    text.includes('前のメッセージ') ||
    text.includes('already');
  const botProcessingMarkerTalk =
    (text.includes('bot 側') || text.includes('bot側')) &&
    processingStateTalk &&
    (normalized.includes('email_send') ||
      normalized.includes('chat_post') ||
      normalized.includes('schedule_action') ||
      text.includes('マーカー'));
  const leaks =
    rawMarkerSyntax || botProcessingMarkerTalk;
  if (!leaks) return { text, scrubbed: false, reason: '' };
  const redactedText = redactActionMarkerTermsForChat(text).trim();
  return {
    text: redactedText || '内部用の実行記法を伏せました。',
    scrubbed: true,
    reason: 'action_marker_terms',
  };
}

function redactActionMarkerTermsForChat(text: string): string {
  return text
    .replace(
      /`?\b(email_send|chat_post|schedule_action)\b`?\s*:\s*\{[\s\S]*?\}/gi,
      '（内部用の実行記法を伏せました）',
    )
    .replace(/`?\b(email_send|chat_post|schedule_action)\b`?/gi, '内部用マーカー')
    .replace(/bot\s*側/gi, '内部側')
    .replace(/bot側/gi, '内部側');
}

function normalizeEmailPreviewEscapedNewlines(
  text: string,
  parsedEmailMarkerCount: number,
): string {
  if (parsedEmailMarkerCount === 0) return text;
  return text.replace(/\\n/g, '\n');
}

function formatEmailDispatchErrorReason(err: unknown): string {
  if (err instanceof AgentMailError) {
    if (err.status === 0) return 'AgentMail API への接続に失敗しました';
    if (err.status === 401 || err.status === 403) {
      return `AgentMail 認証エラー (${err.status})`;
    }
    if (err.status === 404) return 'AgentMail inbox が見つかりません (404)';
    if (err.status === 429) return 'AgentMail API のレート制限です (429)';
    if (err.status >= 500) return `AgentMail API 側エラー (${err.status})`;
    return `AgentMail API エラー (${err.status})`;
  }
  return 'メール送信処理で例外が発生しました';
}

async function recordEmailDispatchFailure(
  env: Env,
  input: {
    eventKey: string;
    sessionId: string;
    to: string;
    subject: string;
    status: number;
    transient: boolean;
    message: string;
    body?: string;
  },
): Promise<void> {
  await recordRuntimeEvent(env, {
    eventKey: input.eventKey,
    sessionId: input.sessionId,
    eventType: 'email_dispatch_failed',
    level: 'warn',
    source: 'chat-event-handler',
    detail: {
      to: redactPiiInText(input.to),
      subject_chars: input.subject.length,
      status: input.status,
      transient: input.transient,
      message: redactPiiInText(input.message),
      body_preview: input.body ? redactPiiInText(input.body).slice(0, 1000) : undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// helper: dispatch CHAT_POST markers
// ---------------------------------------------------------------------------

interface ChatPostDispatchResult {
  /** 全 marker を strip した本文 (current space 投稿用)。 */
  cleanedText: string;
}

/**
 * CHAT_POST markers を見つけて別 space に投稿する。中間版では space alias 解決を
 * 行わず、`spaceAlias` が `spaces/...` 形式の resource name のときのみ投稿し、
 * alias 形式 (= `瀬戸DM` 等) は WARN + skip する。
 *
 * caller 側で `finalText` から marker 全件 strip した body を current space に
 * 投稿するため、本 helper は **本文の strip 結果のみ** を返す (= 投稿結果の
 * summary suffix は本中間版では付けない、cleanedText は raw strip)。
 */
async function dispatchChatPostMarkers(
  env: Env,
  eventKey: string,
  inputText: string,
  receivedSpaceName: string,
  receivedThreadName: string | null,
  claim: { owner: string; version: number },
): Promise<ChatPostDispatchResult> {
  let working = inputText;
  // first-match を繰り返し処理。parseChatPostMarkerDetailed は g flag 無しなので
  // 同じ文字列を繰り返し走らせると同じ marker が hit する → strip 後再 parse する。
  for (let safety = 0; safety < 16; safety += 1) {
    const parsed = parseChatPostMarkerDetailed(working);
    if (!parsed.marker && !parsed.failure) break;
    if (parsed.failure) {
      console.warn(
        `[chat-event] CHAT_POST parse failure eventKey=${eventKey} reason=${parsed.failure.reason} raw=${parsed.failure.raw.slice(0, 200)}`,
      );
      // raw を本文から strip
      working = working.replace(parsed.failure.raw, '').trim();
      continue;
    }
    const m = parsed.marker!;
    // alias 解決: `spaces/...` 形式はそのまま通し、alias は台帳から resolve。
    // 未登録 alias は throw → 従来の skip 動作と同等扱い (= marker strip + continue)。
    let targetSpace: string;
    try {
      targetSpace = resolveChatAlias(m.spaceAlias);
    } catch (err) {
      console.warn(
        `[chat-event] CHAT_POST alias resolve fail eventKey=${eventKey} alias=${JSON.stringify(m.spaceAlias)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      working = stripMarkerRange(working, m.range);
      continue;
    }
    const saKey = env.CHAT_SA_KEY_JSON;
    if (!saKey) {
      console.warn(
        `[chat-event] CHAT_POST skip eventKey=${eventKey} CHAT_SA_KEY_JSON missing`,
      );
    } else {
      // thread 解決: `current` は廃止 (system-prompt-tools の通り)。`spaces/.../threads/...`
      // の literal のみ受け付け、target_space と prefix 一致を要求する。
      let threadOpt: { threadName: string } | undefined;
      if (m.thread) {
        if (m.thread === 'current') {
          // 旧仕様。中間版ではログのみで投稿しない (Cloud Run も #1266 で廃止)。
          console.warn(
            `[chat-event] CHAT_POST 'current' thread is deprecated eventKey=${eventKey} — skipping`,
          );
          working = stripMarkerRange(working, m.range);
          continue;
        }
        if (!m.thread.startsWith(`${targetSpace}/threads/`)) {
          console.warn(
            `[chat-event] CHAT_POST thread/space mismatch eventKey=${eventKey} ` +
              `space=${targetSpace} thread=${m.thread}`,
          );
          working = stripMarkerRange(working, m.range);
          continue;
        }
        threadOpt = { threadName: m.thread };
      }
      // 投稿 — receivedSpace / receivedThread と一致するときは self-post (= 二重投稿)
      // 防止のため skip する (Cloud Run の `isSelfThread` 短絡)。
      const isSelfPost =
        targetSpace === receivedSpaceName &&
        threadOpt?.threadName === receivedThreadName;
      if (isSelfPost) {
        console.log(
          `[chat-event] CHAT_POST self-thread skip eventKey=${eventKey} space=${targetSpace}`,
        );
      } else {
        try {
          // 3-stage precheck wrap (Python `cma_lib.py:send_chat_post` 等価)。
          // 同一 (eventKey, kind='chat_post', target=`${targetSpace}:${thread}`)
          // 既送信なら ALREADY → 別 space への二重投稿を構造的に防ぐ。
          const cpOutcome = await executeWithCommit({
            env,
            parentEventKey: eventKey,
            parentOwner: claim.owner,
            kind: 'chat_post',
            target: `${targetSpace}:${threadOpt?.threadName ?? ''}`,
            sendFn: async () =>
              await postChatMessage(
                { saKeyJson: saKey },
                targetSpace,
                m.text,
                threadOpt ?? {},
              ),
          });
          if (cpOutcome.outcome === 'sent') {
            await recordChatPost({
              db: env.DB,
              kv: env.MAKOTO_KV,
              operatorSpace: env.COST_GUARD_OPERATOR_SPACE,
              enabledEnv: env.COST_GUARD_ENABLED,
            });
            console.log(
              `[chat-event] CHAT_POST posted eventKey=${eventKey} space=${targetSpace} text_chars=${m.text.length}`,
            );
          } else if (cpOutcome.outcome === 'already') {
            console.log(
              `[chat-event] CHAT_POST already sent eventKey=${eventKey} space=${targetSpace} — skipping duplicate`,
            );
          } else if (cpOutcome.outcome === 'lease_alive') {
            console.warn(
              `[chat-event] CHAT_POST in-flight by another worker eventKey=${eventKey} space=${targetSpace}`,
            );
          } else if (cpOutcome.outcome === 'lease_lost') {
            console.warn(
              `[chat-event] CHAT_POST lease lost eventKey=${eventKey} space=${targetSpace}`,
            );
          }
        } catch (err) {
          const reason =
            err instanceof ChatApiError
              ? `chat_api_${err.status}`
              : err instanceof Error
                ? err.message
                : String(err);
          console.warn(
            `[chat-event] CHAT_POST fail eventKey=${eventKey} space=${targetSpace}: ${reason}`,
          );
        }
      }
    }
    working = stripMarkerRange(working, m.range);
  }
  // 残った CHAT_POST raw marker があれば最終的に正規化のため g-flag strip。
  const cleanedText = working
    .replace(new RegExp(CHAT_POST_MARKER_REGEX.source, 'g'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { cleanedText };
}

function stripMarkerRange(
  text: string,
  range: { start: number; end: number },
): string {
  return (text.slice(0, range.start) + text.slice(range.end)).trim();
}

// ---------------------------------------------------------------------------
// helper: dispatch SCHEDULE_ACTION markers
// ---------------------------------------------------------------------------

interface ScheduleDispatchResult {
  /**
   * SCHEDULE_ACTION marker dispatch 後の本文。env 未設定 or dispatch
   * 失敗時は入力 inputText をそのまま返す (= 既存挙動を破壊しない)。
   * dispatch 成功時は `handleScheduleActionMarker` の `combinedText`
   * (= prefix + 実行結果集約) で置き換わる。
   */
  cleanedText: string;
}

async function dispatchScheduleActionMarkers(
  env: Env,
  eventKey: string,
  messageId: string,
  threadName: string | null,
  inputText: string,
  gate: ActorGateOptions,
): Promise<ScheduleDispatchResult> {
  const gatedMarkers = gate.actorTrusted ? [] : parseScheduleActionMarkers(inputText);
  if (!gate.actorTrusted && gatedMarkers.length > 0) {
    await recordRuntimeEvent(env, {
      eventKey,
      messageId: gate.messageId,
      userSlug: gate.userSlug,
      eventType: 'external_tool_gated',
      level: 'warn',
      source: 'chat-event-handler',
      detail: {
        tool_family: 'SCHEDULE_ACTION',
        marker_count: gatedMarkers.length,
        actor_source: 'default_user_fallback',
      },
    });
    const prefix = stripScheduleActionMarkers(inputText).trim();
    const notice = '外部連携操作は登録済みユーザーの現在発話でのみ実行します。';
    return { cleanedText: prefix ? `${prefix}\n${notice}` : notice };
  }
  const saKey = env.CHAT_SA_KEY_JSON;
  const project = env.GCP_SCHEDULER_PROJECT;
  const location = env.GCP_SCHEDULER_LOCATION;
  if (!saKey || !project || !location) {
    // env 未設定 = SCHEDULE_ACTION dispatch は skip (deploy gradual rollout)。
    // marker が本文に含まれていても strip せず scrub 層に任せる (= 旧 path 完全互換)。
    return { cleanedText: inputText };
  }
  try {
    const managerDeps: Parameters<typeof createCloudSchedulerManager>[0] = {
      saKeyJson: saKey,
      project,
      location,
    };
    if (env.SCHEDULER_TOPIC_NAME) {
      managerDeps.schedulerTopicName = env.SCHEDULER_TOPIC_NAME;
    }
    if (env.SCHEDULER_HANDLER_TOPIC_PREFIX) {
      managerDeps.handlerTopicPrefix = env.SCHEDULER_HANDLER_TOPIC_PREFIX;
    }
    const manager = createCloudSchedulerManager(managerDeps);
    const result = await handleScheduleActionMarker(inputText, manager);
    if (result.markerCount > 0) {
      await recordRuntimeEvent(env, {
        eventKey,
        messageId,
        eventType: 'schedule_action_marker_result',
        source: 'chat-event-handler',
        detail: {
          marker_count: result.markerCount,
          thread_name_hash: stableHash(threadName),
          executions: result.executions,
        },
      });
      for (const execution of result.executions) {
        if (execution.ok && execution.job_id && execution.action !== 'delete') {
          await recordScheduleCommandContext(env, {
            eventKey,
            messageId,
            threadName,
            source: 'schedule_action_marker',
            action: execution.action,
            jobId: execution.job_id,
          });
        }
      }
      console.log(
        `[chat-event] SCHEDULE_ACTION dispatched eventKey=${eventKey} markers=${result.markerCount}`,
      );
    }
    return { cleanedText: result.combinedText };
  } catch (err) {
    console.warn(
      `[chat-event] SCHEDULE_ACTION dispatch failed eventKey=${eventKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
    // 失敗時は元の cleanedText で投稿継続。
    return { cleanedText: inputText };
  }
}

async function dispatchNaturalScheduleCommand(
  env: Env,
  inputText: string,
  context: {
    eventKey: string;
    messageId: string;
    threadName: string | null;
  },
): Promise<string | null> {
  const manager = buildScheduleManager(env);
  if (!manager) return null;
  try {
    const fallbackJobId = isDeicticScheduleReference(inputText)
      ? await readLastScheduleCommandJobId(env, context.threadName)
      : null;
    const result = await handleNaturalScheduleCommand(inputText, manager, {
      fallbackJobId,
    });
    if (result.handled) {
      await recordRuntimeEvent(env, {
        eventKey: context.eventKey,
        messageId: context.messageId,
        eventType: 'natural_schedule_command_result',
        source: 'chat-event-handler',
        detail: {
          action: result.action ?? null,
          job_id: result.job_id ?? null,
          fallback_job_id: fallbackJobId,
          thread_name_hash: stableHash(context.threadName),
          text_chars: result.text.length,
        },
      });
      if (result.job_id && result.action !== 'delete') {
        await recordScheduleCommandContext(env, {
          eventKey: context.eventKey,
          messageId: context.messageId,
          threadName: context.threadName,
          source: 'natural_schedule_command',
          action: result.action ?? 'unknown',
          jobId: result.job_id,
        });
      }
    }
    return result.handled ? result.text : null;
  } catch (err) {
    return `❌ スケジュール操作失敗: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function recordScheduleCommandContext(
  env: Env,
  input: {
    eventKey: string;
    messageId: string;
    threadName: string | null;
    source: string;
    action: string;
    jobId: string;
  },
): Promise<void> {
  await recordRuntimeEvent(env, {
    eventKey: input.eventKey,
    messageId: input.messageId,
    eventType: 'schedule_command_context',
    source: 'chat-event-handler',
    detail: {
      thread_name_hash: stableHash(input.threadName),
      source: input.source,
      action: input.action,
      job_id: input.jobId,
    },
  });
}

async function readLastScheduleCommandJobId(
  env: Env,
  threadName: string | null,
): Promise<string | null> {
  const threadHash = stableHash(threadName);
  if (!threadHash) return null;
  const row = await env.DB.prepare(
    `SELECT detail_json FROM cma_worker_runtime_events
       WHERE event_type = ?1
         AND detail_json LIKE ?2
       ORDER BY created_at_ms DESC
       LIMIT 1`,
  )
    .bind('schedule_command_context', `%"thread_name_hash":"${threadHash}"%`)
    .first<{ detail_json: string }>();
  if (!row?.detail_json) return null;
  try {
    const detail = JSON.parse(row.detail_json) as { job_id?: unknown };
    return typeof detail.job_id === 'string' && detail.job_id ? detail.job_id : null;
  } catch {
    return null;
  }
}

function buildScheduleManager(env: Env): ReturnType<typeof createCloudSchedulerManager> | null {
  const saKey = env.CHAT_SA_KEY_JSON;
  const project = env.GCP_SCHEDULER_PROJECT;
  const location = env.GCP_SCHEDULER_LOCATION;
  if (!saKey || !project || !location) return null;
  const managerDeps: Parameters<typeof createCloudSchedulerManager>[0] = {
    saKeyJson: saKey,
    project,
    location,
  };
  if (env.SCHEDULER_TOPIC_NAME) {
    managerDeps.schedulerTopicName = env.SCHEDULER_TOPIC_NAME;
  }
  if (env.SCHEDULER_HANDLER_TOPIC_PREFIX) {
    managerDeps.handlerTopicPrefix = env.SCHEDULER_HANDLER_TOPIC_PREFIX;
  }
  return createCloudSchedulerManager(managerDeps);
}

// ---------------------------------------------------------------------------
// helper: DM space detection
// ---------------------------------------------------------------------------
//
// mention 判定 + strip は `src/lib/mention-detection.ts` に切り出し済
// (= annotations-based、Python `_is_for_bot` / `_strip_mention` と byte 等価
// port、Issue #186 既知 #9 + #10)。
//

function isDmSpace(spaceType: string): boolean {
  const up = (spaceType || '').toUpperCase();
  return up === 'DM' || up === 'DIRECT_MESSAGE';
}

/**
 * session.ts の `stopReason` を Python `_CAP_STOP_REASONS` 用語に正規化する。
 * Python 一次ソース (`scripts/cma_lib.py:l.59`):
 *   `_CAP_STOP_REASONS = ("tool_call_cap", "max_iter", "session_watchdog")`
 *
 * cap-recovery wire up (= #186 既知 #3) で session.ts の TS 独自命名
 * (`custom_tool_call_cap`) を Python `tool_call_cap` に正規化して
 * `shouldAttemptCapRecovery` に渡す。
 */
function mapToPythonCapStopReason(
  tsStopReason: string | undefined,
): 'tool_call_cap' | 'session_watchdog' | null {
  if (!tsStopReason) return null;
  switch (tsStopReason) {
    case 'custom_tool_call_cap':
    case 'tool_call_cap':
      return 'tool_call_cap';
    case 'session_watchdog':
      return 'session_watchdog';
    default:
      return null;
  }
}

function parseReactiveStreamTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 10 || n > 600_000) {
    console.warn(`[chat-event] invalid CMA_REACTIVE_STREAM_TIMEOUT_MS=${raw}; using default`);
    return undefined;
  }
  return n;
}

export function chatTurnProcessingKey(eventKey: string): string {
  return `chat_turn_processing:${eventKey}`;
}

type ChatTurnProcessingClaimResult =
  | { kind: 'claimed'; claim: { key: string; owner: string; version: number } }
  | { kind: 'duplicate'; reason: 'chat_turn_processing_alive' | 'chat_turn_processing_done' }
  | { kind: 'failed' };

async function claimChatTurnProcessing(
  env: Env,
  input: { eventKey: string; messageId: string },
): Promise<ChatTurnProcessingClaimResult> {
  const key = chatTurnProcessingKey(input.eventKey);
  const owner = newClaimOwner('chat-turn');
  try {
    const claim = await tryClaim(env.DB, key, owner, {
      leaseTtlMs: CHAT_EVENT_LEASE_TTL_MS,
    });
    if (claim.state === 'NEW' || claim.state === 'TAKEOVER') {
      if (claim.owner !== undefined && claim.version !== undefined) {
        await recordRuntimeEvent(env, {
          eventKey: input.eventKey,
          messageId: input.messageId,
          eventType: 'chat_turn_processing_claimed',
          source: 'chat-event-handler',
          detail: { claim_state: claim.state, lease_ttl_ms: CHAT_EVENT_LEASE_TTL_MS },
        });
        return { kind: 'claimed', claim: { key, owner: claim.owner, version: claim.version } };
      }
      return { kind: 'failed' };
    }
    const reason =
      claim.state === 'DONE_DUPLICATE'
        ? 'chat_turn_processing_done'
        : 'chat_turn_processing_alive';
    await recordRuntimeEvent(env, {
      eventKey: input.eventKey,
      messageId: input.messageId,
      eventType: 'chat_turn_processing_duplicate_suppressed',
      level: 'warn',
      source: 'chat-event-handler',
      detail: { reason, claim_state: claim.state },
    });
    return { kind: 'duplicate', reason };
  } catch (err) {
    await recordRuntimeEvent(env, {
      eventKey: input.eventKey,
      messageId: input.messageId,
      eventType: 'chat_turn_processing_claim_failed',
      level: 'error',
      source: 'chat-event-handler',
      detail: { error: err instanceof Error ? err.message : String(err) },
    });
    return { kind: 'failed' };
  }
}

async function safeReleaseChatTurnProcessing(
  env: Env,
  claim: { key: string; owner: string; version: number },
): Promise<void> {
  try {
    await releaseClaim(env.DB, claim.key, claim.owner, claim.version);
  } catch (err) {
    console.warn(
      `[chat-event] chat turn processing release failed key=${claim.key}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function startParentLeaseHeartbeat(
  env: Env,
  ctx: ExecutionContext,
  input: {
    eventKey: string;
    messageId: string;
    owner: string;
    version: number;
    eventType: string;
  },
): Promise<LeaseHeartbeat | null> {
  const heartbeat = new LeaseHeartbeat({
    env,
    eventKey: input.eventKey,
    owner: input.owner,
    version: input.version,
    leaseTtlMs: CHAT_EVENT_LEASE_TTL_MS,
    intervalMs: CHAT_EVENT_HEARTBEAT_INTERVAL_MS,
  });
  const renewed = await heartbeat.tick();
  if (!renewed) {
    await recordRuntimeEvent(env, {
      eventKey: input.eventKey,
      messageId: input.messageId,
      eventType: 'chat_parent_lease_renew_failed',
      level: 'warn',
      source: 'chat-event-handler',
      detail: { reason: heartbeat.lostBecause() ?? 'renew_failed' },
    });
    await heartbeat.stop();
    return null;
  }
  heartbeat.start();
  if (typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(heartbeat.completionPromise);
  }
  await recordRuntimeEvent(env, {
    eventKey: input.eventKey,
    messageId: input.messageId,
    eventType: input.eventType,
    source: 'chat-event-handler',
    detail: {
      lease_ttl_ms: CHAT_EVENT_LEASE_TTL_MS,
      interval_ms: CHAT_EVENT_HEARTBEAT_INTERVAL_MS,
    },
  });
  return heartbeat;
}

/**
 * intent-detector 結果から bodyText 先頭に注入する 1 行 hint を組み立てる
 * (Issue #186 既知 #4)。
 */
export function buildIntentPrefix(intent: ActionSkillIntent | null): string {
  if (intent === null) return '';
  if (intent.source === 'slash_command') {
    const kind = intent.isActionSkill ? 'action_skill' : 'command';
    return `[intent: ${kind} ${intent.command}]`;
  }
  if (!intent.isActionSkill) return '';
  if (intent.source === 'mail_intent') return `[intent: mail (implicit)]`;
  if (intent.source === 'schedule_intent') return `[intent: schedule (implicit)]`;
  return '';
}

interface AutonomousLongReplyDelivery {
  title: string;
  body: string;
}

function buildAutonomousLongReplyDelivery(
  eventKey: string,
  text: string,
): AutonomousLongReplyDelivery | null {
  const body = (text || '').trim();
  if (!eventKey.startsWith(AUTONOMOUS_EVENT_KEY_PREFIX)) return null;
  if (Array.from(body).length < AUTONOMOUS_LONG_REPLY_THRESHOLD_CHARS) return null;
  const title = buildAutonomousReplyTitle(body, eventKey);
  return { title, body };
}

function buildAutonomousReplyTitle(text: string, eventKey: string): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((line) => normalizeAutonomousTitleLine(line))
      .find((line) => line.length > 0) || defaultAutonomousReplyTitle(eventKey);
  const maxBodyChars = Math.max(
    8,
    AUTONOMOUS_REPLY_TITLE_MAX_CHARS - defaultAutonomousReplyPrefix(eventKey).length,
  );
  return `${defaultAutonomousReplyPrefix(eventKey)}${truncateDisplayChars(firstLine, maxBodyChars)}`;
}

function normalizeAutonomousTitleLine(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*]\s*/, '')
    .replace(/^===.*===$/, '')
    .trim();
}

function defaultAutonomousReplyPrefix(eventKey: string): string {
  return eventKey.startsWith(MORNING_BRIEF_EVENT_KEY_PREFIX)
    ? '朝ブリーフ: '
    : '定期実行: ';
}

function defaultAutonomousReplyTitle(eventKey: string): string {
  return eventKey.startsWith(MORNING_BRIEF_EVENT_KEY_PREFIX)
    ? '朝ブリーフをまとめました'
    : '結果をまとめました';
}

function truncateDisplayChars(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`;
}

// ---------------------------------------------------------------------------
// helper: safe wrappers (never throw)
// ---------------------------------------------------------------------------

async function safePost(
  env: Env,
  spaceName: string,
  text: string,
  threadName: string | null,
  eventKey: string,
): Promise<ChatMessageResult | null> {
  const saKey = env.CHAT_SA_KEY_JSON;
  if (!saKey) {
    console.warn(
      `[chat-event] safePost skipped eventKey=${eventKey} CHAT_SA_KEY_JSON missing`,
    );
    return null;
  }
  if (!spaceName || !text) {
    console.warn(
      `[chat-event] safePost skipped eventKey=${eventKey} empty space or text`,
    );
    return null;
  }
  try {
    // Python `_reply_to_chat:l.1247-1249` と等価: thread 指定時は
    // `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD` を必須で
    // 付ける。これがないと Chat REST API のデフォルト動作で「新規 thread
    // として post」される (= 2026-05-26 reactive bot 実機検証で表示崩れ
    // 確認、Python と等価合わせ)。
    const result = await postChatMessage(
      { saKeyJson: saKey },
      spaceName,
      text,
      threadName
        ? {
            threadName,
            threadFallback: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
          }
        : {},
    );
    await recordChatPost({
      db: env.DB,
      kv: env.MAKOTO_KV,
      operatorSpace: env.COST_GUARD_OPERATOR_SPACE,
      enabledEnv: env.COST_GUARD_ENABLED,
    });
    return result;
  } catch (err) {
    const reason =
      err instanceof ChatApiError
        ? `chat_api_${err.status}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.warn(
      `[chat-event] safePost fail eventKey=${eventKey} space=${spaceName}: ${reason}`,
    );
    return null;
  }
}

async function replyToCurrentSpace(
  env: Env,
  placeholderName: string,
  spaceName: string,
  text: string,
  threadName: string | null,
  eventKey: string,
): Promise<void> {
  if (placeholderName) {
    await safeUpdateOrPost(env, placeholderName, spaceName, text, threadName, eventKey);
    return;
  }
  await safePost(env, spaceName, text, threadName, eventKey);
}

/**
 * placeholder PATCH update helper。失敗時は WARN log + safePost に
 * fallback (Python `_placeholder_reply:l.3936-3942` legacy 経路と等価)。
 */
async function safeUpdateOrPost(
  env: Env,
  messageName: string,
  spaceName: string,
  text: string,
  threadName: string | null,
  eventKey: string,
): Promise<void> {
  const saKey = env.CHAT_SA_KEY_JSON;
  if (!saKey) {
    console.warn(
      `[chat-event] safeUpdateOrPost skipped eventKey=${eventKey} CHAT_SA_KEY_JSON missing`,
    );
    return;
  }
  try {
    await updateChatMessage({ saKeyJson: saKey }, messageName, text);
    await recordChatPost({
      db: env.DB,
      kv: env.MAKOTO_KV,
      operatorSpace: env.COST_GUARD_OPERATOR_SPACE,
      enabledEnv: env.COST_GUARD_ENABLED,
    });
    return;
  } catch (err) {
    const reason =
      err instanceof ChatApiError
        ? `chat_api_${err.status}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.warn(
      `[chat-event] PATCH fail eventKey=${eventKey} message=${messageName}: ${reason} — falling back to POST`,
    );
  }
  // PATCH 失敗時 fallback: 新規 POST (Python l.3942 等価)
  await safePost(env, spaceName, text, threadName, eventKey);
}

/**
 * placeholder DELETE helper (Python `_delete_chat_message:l.1879-1912`
 * 等価)。404 は内部で正常扱い、その他失敗は WARN log のみで吸収する
 * (bot 全体は落とさない、Python l.1888-1891 同思想)。
 */
async function safeDeletePlaceholder(
  env: Env,
  messageName: string,
  eventKey: string,
): Promise<void> {
  const saKey = env.CHAT_SA_KEY_JSON;
  if (!saKey) {
    console.warn(
      `[chat-event] placeholder DELETE skipped eventKey=${eventKey} CHAT_SA_KEY_JSON missing`,
    );
    return;
  }
  try {
    await deleteChatMessage({ saKeyJson: saKey }, messageName);
  } catch (err) {
    const reason =
      err instanceof ChatApiError
        ? `chat_api_${err.status}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.warn(
      `[chat-event] placeholder DELETE fail eventKey=${eventKey} message=${messageName}: ${reason}`,
    );
  }
}

function canFetchThreadHistory(env: Env): boolean {
  const missing = missingChatHistoryOAuthSecrets(env);
  if (missing.length > 0 && env.CHAT_SA_KEY_JSON) {
    console.warn(
      `[chat-event] history user OAuth incomplete; service-account fallback available missing=${missing.join(',')}`,
    );
  }
  return Boolean(
    missing.length === 0 ||
      env.CHAT_SA_KEY_JSON,
  );
}

async function resolveThreadHistoryDeps(env: Env): Promise<ChatHistoryDeps> {
  const missing = missingChatHistoryOAuthSecrets(env);
  if (missing.length === 0) {
    const vaultKeyB64 = env.OAUTH_VAULT_KEY!;
    const clientId = env.GCHAT_OAUTH_CLIENT_ID!;
    const clientSecret = env.GCHAT_OAUTH_CLIENT_SECRET!;
    const refreshTokenSeed = env.GCHAT_OAUTH_REFRESH_TOKEN_SEED!;
    const token = await getChatReadonlyAccessToken({
      kv: env.MAKOTO_KV,
      vaultKeyB64,
      clientId,
      clientSecret,
      refreshTokenSeed,
    });
    console.log(
      `[chat-event] history oauth token resolved source=${token.from_cache ? 'cache' : 'refresh'}`,
    );
    return { accessToken: token.access_token };
  }

  if (env.CHAT_SA_KEY_JSON) {
    console.warn(
      `[chat-event] history fetch using service-account fallback; user OAuth secrets incomplete missing=${missing.join(',')}`,
    );
    return { saKeyJson: env.CHAT_SA_KEY_JSON };
  }

  throw new Error('thread history fetch is not configured');
}

function missingChatHistoryOAuthSecrets(env: Env): string[] {
  const missing: string[] = [];
  if (!env.GCHAT_OAUTH_REFRESH_TOKEN_SEED) missing.push('GCHAT_OAUTH_REFRESH_TOKEN_SEED');
  if (!env.GCHAT_OAUTH_CLIENT_ID) missing.push('GCHAT_OAUTH_CLIENT_ID');
  if (!env.GCHAT_OAUTH_CLIENT_SECRET) missing.push('GCHAT_OAUTH_CLIENT_SECRET');
  if (!env.OAUTH_VAULT_KEY) missing.push('OAUTH_VAULT_KEY');
  return missing;
}

interface SafeCommitEvent {
  messageId?: string | null;
  userSlug?: string | null;
  reason: string;
  stage: string;
  outcome: 'committed' | 'skipped';
  level?: 'debug' | 'info' | 'warn' | 'error';
  detail?: Record<string, unknown>;
}

async function safeCommit(
  env: Env,
  eventKey: string,
  claim: { owner: string; version: number },
  commitEvent?: SafeCommitEvent,
): Promise<void> {
  let commitOk = false;
  let commitFenceDrift = false;
  let commitError: string | null = null;
  try {
    const ok = await commitDone(env.DB, eventKey, claim.owner, claim.version);
    if (!ok) {
      commitFenceDrift = true;
      console.warn(
        `[chat-event] commit-fence-drift eventKey=${eventKey} owner=${claim.owner} version=${claim.version}`,
      );
    } else {
      commitOk = true;
    }
  } catch (err) {
    commitError = err instanceof Error ? err.message : String(err);
    console.warn(
      `[chat-event] commitDone threw eventKey=${eventKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (commitEvent) {
    await recordRuntimeEvent(env, {
      eventKey,
      messageId: commitEvent.messageId ?? null,
      userSlug: commitEvent.userSlug ?? null,
      eventType: 'chat_event_commit_decision',
      level: commitEvent.level ?? (commitEvent.outcome === 'skipped' ? 'warn' : 'info'),
      source: 'chat-event-handler',
      detail: {
        reason: commitEvent.reason,
        stage: commitEvent.stage,
        outcome: commitEvent.outcome,
        commit_ok: commitOk,
        commit_fence_drift: commitFenceDrift,
        commit_error: commitError,
        ...(commitEvent.detail ?? {}),
      },
    });
  }
}

async function safeRelease(
  env: Env,
  eventKey: string,
  claim: { owner: string; version: number },
): Promise<void> {
  try {
    await releaseClaim(env.DB, eventKey, claim.owner, claim.version);
  } catch (err) {
    console.warn(
      `[chat-event] releaseClaim threw eventKey=${eventKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface SafeAppendSessionLogParams {
  eventKey: string;
  client: import('@anthropic-ai/sdk').default;
  senderEmail: string;
  spaceType: string;
  userSlug: string;
  memoryAttachments: import('../types/memory').MemoryAttachment[];
  space: NonNullable<ChatEventPayload['space']>;
  sender: NonNullable<NonNullable<ChatEventPayload['message']>['sender']>;
  threadName: string | null;
  userText: string;
  finalText: string;
  sessionId: string;
  messageId?: string;
}

async function safeAppendSessionLog(
  env: Env,
  params: SafeAppendSessionLogParams,
): Promise<void> {
  void env;
  try {
    const result = await appendSessionLogMemory(
      { client: params.client },
      {
        senderEmail: params.senderEmail,
        spaceType: params.spaceType,
        userSlug: params.userSlug,
        memoryAttachments: params.memoryAttachments,
        space: {
          ...(params.space.name ? { name: params.space.name } : {}),
          ...(params.space.displayName ? { displayName: params.space.displayName } : {}),
          ...(params.space.type ? { type: params.space.type } : {}),
        },
        sender: {
          ...(params.sender.name ? { name: params.sender.name } : {}),
          ...((params.sender as { email?: string }).email
            ? { email: (params.sender as { email?: string }).email! }
            : {}),
        },
        threadName: params.threadName,
        userText: params.userText,
        finalText: params.finalText,
        sessionId: params.sessionId,
        ...(params.messageId ? { messageId: params.messageId } : {}),
      },
    );
    if (!result.appended) {
      console.log(
        `[chat-event] session-log skipped eventKey=${params.eventKey} ` +
          `space_type=${params.spaceType} reason=no_target_attachment`,
      );
    }
  } catch (err) {
    console.warn(
      `[chat-event] session-log append failed eventKey=${params.eventKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Queue batch handler
// ---------------------------------------------------------------------------

/**
 * `makoto-chat-queue` の batch consumer。`src/index.ts` の `queue` handler
 * から呼ばれる。msg ごとに `handleChatEvent` を呼び outcome に応じて
 * ack/retry する (= agentmail-consumer の pattern と等価)。
 */
export async function handleChatQueue(
  batch: MessageBatch<ChatQueueMessage>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const outcome = await handleChatEvent(env, ctx, msg.body);
      if (outcome.kind === 'release_and_retry') {
        console.warn(
          `[chat-event] release_and_retry eventKey=${msg.body?.eventKey} reason=${outcome.reason}`,
        );
        msg.retry();
        continue;
      }
      msg.ack();
    } catch (err) {
      // handleChatEvent 自体は throw しない契約だが、防御的に retry
      console.error(
        `[chat-event] unexpected throw eventKey=${msg.body?.eventKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      msg.retry();
    }
  }
}

// ---------------------------------------------------------------------------
// helper: slash skills data loader
// ---------------------------------------------------------------------------

/**
 * cma_skills.json の TS port 縮約版。`/help` の決定論応答で空一覧を返さない
 * ため、Worker bundle に slash command metadata を焼く。
 *
 * 現状の動作:
 *   - `/help` → 登録済み slash command 一覧を返す
 *   - `/costguard` → handler 経路で短絡 (本関数の metadata は help 表示用)
 *   - その他 `/cmd` → resolveSkillRun が 「未登録」 reply を返す
 */
function loadSlashSkillsData(env: Env): SkillsData {
  void env;
  return SLASH_SKILLS_DATA;
}

function isFullPdfReadOverride(text: string): boolean {
  const normalised = text.trim().toLowerCase().replace(/[\s。、．.！!？?]+/g, '');
  return (
    normalised === 'はい' ||
    normalised === 'yes' ||
    normalised === 'y' ||
    normalised.startsWith('全文で進め') ||
    normalised.startsWith('全文で読') ||
    normalised.startsWith('全文解析') ||
    normalised.startsWith('全部読')
  );
}

function hasPdfAttachment(attachments: ChatAttachment[] | null | undefined): boolean {
  return (attachments ?? []).some((att) =>
    (att.contentType || '').toLowerCase() === 'application/pdf',
  );
}

function parsePdfPreflightApprovalDecision(text: string): 'yes' | 'no' | null {
  const normalised = text.trim().toLowerCase().replace(/[\s。、．.！!？?]+/g, '');
  if (!normalised) return null;
  if (
    normalised === 'はい' ||
    normalised === 'yes' ||
    normalised === 'y' ||
    normalised.startsWith('全文で進め') ||
    normalised.startsWith('全文で読') ||
    normalised.startsWith('全部読')
  ) {
    return 'yes';
  }
  if (
    normalised === 'いいえ' ||
    normalised === 'no' ||
    normalised === 'n' ||
    normalised.startsWith('やめ') ||
    normalised.startsWith('止め') ||
    normalised.startsWith('中止')
  ) {
    return 'no';
  }
  return null;
}

async function postPdfPreflightFailClosed(
  env: Env,
  input: {
    spaceName: string;
    threadName: string | null;
    eventKey: string;
    threadSessionKey: string | null;
    attachments: ChatAttachment[];
    requestText: string;
    approvedThroughUsd: number;
  },
): Promise<void> {
  if (input.threadSessionKey) {
    await writePendingPdfPreflightApproval(
      env.MAKOTO_KV,
      input.threadSessionKey,
      {
        attachments: input.attachments,
        requestText: input.requestText,
        approvedThroughUsd: input.approvedThroughUsd,
        createdAtMs: Date.now(),
      },
    );
  }
  await safePost(
    env,
    input.spaceName,
    [
      'PDF事前確認',
      'PDFの事前見積もりを取得できませんでした。',
      '',
      '読む場合は「はい」、やめる場合は「いいえ」と返信してください。',
    ].join('\n'),
    input.threadName,
    input.eventKey,
  );
}

function pendingPdfPreflightApprovalKey(threadSessionKey: string): string {
  return `cost_guard:pdf_preflight_pending:${threadSessionKey}`;
}

async function readPendingPdfPreflightApproval(
  kv: KVNamespace,
  threadSessionKey: string,
): Promise<PendingPdfPreflightApproval | null> {
  try {
    const raw = await kv.get(pendingPdfPreflightApprovalKey(threadSessionKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingPdfPreflightApproval>;
    if (!Array.isArray(parsed.attachments) || parsed.attachments.length === 0) return null;
    return {
      attachments: parsed.attachments as ChatAttachment[],
      requestText: typeof parsed.requestText === 'string' ? parsed.requestText : '',
      approvedThroughUsd: typeof parsed.approvedThroughUsd === 'number'
        && Number.isFinite(parsed.approvedThroughUsd)
        ? parsed.approvedThroughUsd
        : 0,
      createdAtMs: typeof parsed.createdAtMs === 'number' ? parsed.createdAtMs : 0,
    };
  } catch {
    return null;
  }
}

async function writePendingPdfPreflightApproval(
  kv: KVNamespace,
  threadSessionKey: string,
  pending: PendingPdfPreflightApproval,
): Promise<void> {
  await kv.put(
    pendingPdfPreflightApprovalKey(threadSessionKey),
    JSON.stringify(pending),
    { expirationTtl: PDF_PREFLIGHT_PENDING_TTL_SEC },
  );
}

async function deletePendingPdfPreflightApproval(
  kv: KVNamespace,
  threadSessionKey: string,
): Promise<void> {
  await kv.delete(pendingPdfPreflightApprovalKey(threadSessionKey));
}

function isHeartbeatEventKey(eventKey: string): boolean {
  return eventKey.startsWith('scheduled:heartbeat_tick:');
}

function countChatPostMarkers(text: string): number {
  const globalMarker = new RegExp(CHAT_POST_MARKER_REGEX.source, 'g');
  return [...text.matchAll(globalMarker)].length;
}

function stripChatPostMarkersForHeartbeat(text: string): string {
  const globalMarker = new RegExp(CHAT_POST_MARKER_REGEX.source, 'g');
  return text.replace(globalMarker, '').replace(/\n{3,}/g, '\n\n').trim();
}

async function recordHeartbeatExternalToolSuppressed(
  env: Env,
  eventKey: string,
  messageId: string,
  userSlug: string,
  input: { toolFamily: 'EMAIL_SEND' | 'CHAT_POST' | 'SCHEDULE_ACTION'; markerCount: number },
): Promise<void> {
  await recordRuntimeEvent(env, {
    eventKey,
    messageId,
    userSlug,
    eventType: 'external_tool_gated',
    level: 'warn',
    source: 'chat-event-handler',
    detail: {
      tool_family: input.toolFamily,
      marker_count: input.markerCount,
      actor_source: 'scheduled_heartbeat',
    },
  });
}

// ---------------------------------------------------------------------------
// follow-up scope notes (= 中間版で省略した機能、別 Issue で対応)
// ---------------------------------------------------------------------------
//
// (done #186 既知 #1 + O): 画像 / PDF / Office 添付処理 = `attachment-processing.ts`
// Done (#186): slash command metadata bundled for `/help` + minimal dispatch.
// TODO(#186 follow-up): /costguard mutation 系 (enable / disable / pause / set
//                       / confirm / cancel) port (Worker 側 Firestore overlay
//                       永続層が必要、Issue #186 follow-up)。Phase 2 では
//                       status のみ port 済 (= `cost-guard-command.ts`)。
// TODO(#186 follow-up): cap-recovery 完全実装 (cap 超過後の memory snapshot)
// Done (Issue #186 既知 #4): intent-detector 統合 (= bodyText intent prefix。
//   Grill Me 正本に合わせ /mail でも同じ社員 agent / session を継続)。
// Done (#198): Cold continuation の SignalB 経由 thread-self-scan.
// ✅ DONE (Issue #186 既知 #6): 未解決 speaker gate (= shared space で
//    history fetch 結果に未登録 chat_user_id が居るとき CHAT_POST 全 marker
//    を `applyChatPostGateToText` で strip。speaker-resolver.ts pure 関数群
//    + speaker-gate.ts wire-up 経路。external tool gate は actor 駆動軸で
//    別途 #186 follow-up)。
// Done (#198/#186): CHAT_POST alias resolver port (= `chat-alias-resolver.ts`).
// Done (#198/#186): user_mapping default fallback (= `readUserMappingWithDefault`).
// Done (#198/#186): annotation-based mention detection (= `isMentioningBot`).
// Done (#198/#186): _strip_mention annotations-based port (= `stripMentions`).
// NOTE(#186): user_message envelope の cap-recovery / intent / speaker prefix
//             は既知 #11 で `src/lib/user-message-envelope.ts` に実装済 (= 配線
//             は本 file の `intentResult` / `historyBlock` 経由)。残る完全化
//             (speaker context block 本体 / roster block fetch) は別 follow-up。
