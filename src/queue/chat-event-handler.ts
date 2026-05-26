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
 *   - 画像 / PDF / Office 添付処理 (= `_build_image_attachments`)
 *   - `/costguard` command の決定論短絡ハンドラ
 *   - cap-recovery 完全実装 (cap 超過後の memory snapshot 経路)
 *   - intent-detector 統合 (intent ベース dispatch 分岐)
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
  ChatApiError,
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
} from '../lib/chat-history';
import {
  fetchSpaceMemberRoster,
  buildSpaceContextBlock,
  type RosterFetchResult,
} from '../lib/space-roster';
import { applyChatPostGateToText } from '../lib/speaker-gate';
import { createCloudSchedulerManager } from '../lib/cloud-scheduler-client';
import { confirmOwner, commitDone, releaseClaim } from '../lib/dedupe';
import {
  resolveCapRecoveryConfig,
  runCapRecovery,
  shouldAttemptCapRecovery,
  type CapRecoveryStreamExecutor,
} from '../lib/cap-recovery';
import { parseAssistantText } from '../lib/email-send-marker';
import { readUserMappingWithDefault } from '../lib/memory-attach';
import { handleScheduleActionMarker } from '../lib/schedule-action-marker';
import {
  buildAnthropicClient,
  orchestrateChatTurn,
  OrchestratorFailure,
} from '../lib/session-orchestrator';
import {
  appendSessionLogMemory,
  isSharedSpace,
} from '../lib/session-log';
import { dispatchSlashCommand } from '../lib/slash-skill';
import type { SlashSkillHandlers } from '../lib/slash-skill';
import type { SkillsData } from '../lib/intent-detector';
import { sendAndStreamWithToolDispatch } from '../lib/session';
import { scrubInternalStateForChat } from '../redact/internal-state';
import { redactPiiInText } from '../redact/pii';
import { recordSentMessage } from '../storage';
import type { ChatEventPayload, ChatQueueMessage } from '../webhooks/google-chat';
import { dispatchMakotoTool } from '../dispatch/makoto-tool-dispatcher';
import { PERSONA_SPEC } from '../data/persona-spec';
import { TOOLS_SPEC } from '../data/tools-spec';
import { isMentioningBot, stripMentions } from '../lib/mention-detection';
import type { EmailSendMarker } from '../types/agentmail';

/**
 * Placeholder text — Cloud Run `cma_lib.py:send_placeholder:l.3718` /
 * `cma_gchat_bot.py:l.3921` で hard-coded された `"... MAKOTOくんが入力中"`
 * を byte 等価で port (env / config 由来ではない hard-coded literal)。
 *
 * 役割: session.create + LLM stream (= 24-45 秒) の前に短い ack を Chat
 * に POST し、Google Chat client の「MAKOTOくん から応答ありません」
 * timeout 表示を抑止する。完了後に `updateChatMessage` で書き換え、
 * 失敗時に `deleteChatMessage` で残骸 cleanup する (#186 UX 致命傷)。
 */
const PLACEHOLDER_TEXT = '... MAKOTOくんが入力中';

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

/**
 * Queue consumer entry point。`src/index.ts` の `queue` handler から
 * `makoto-chat-queue` 分岐で呼ばれる。batch 中 1 message ずつ呼び出すこと。
 */
export async function handleChatEvent(
  env: Env,
  ctx: ExecutionContext,
  body: ChatQueueMessage,
): Promise<ChatEventOutcome> {
  void ctx; // 中間版では使わない。完全 port (waitUntil 経路) で利用余地

  const { eventKey, claim, payload } = body;

  // ---- 1. claim 維持確認 ----
  const stillOwner = await confirmOwner(env.DB, eventKey, claim.owner, claim.version);
  if (!stillOwner) {
    console.warn(
      `[chat-event] lost_claim eventKey=${eventKey} owner=${claim.owner} version=${claim.version}`,
    );
    return { kind: 'skipped', reason: 'lost_claim' };
  }

  // ---- 2. payload extract ----
  const message = payload.message;
  if (!message) {
    console.warn(`[chat-event] no message field eventKey=${eventKey}`);
    await safeCommit(env, eventKey, claim);
    return { kind: 'skipped', reason: 'no_message' };
  }
  const space = payload.space ?? { name: '' };
  const sender = message.sender ?? { name: '' };
  const senderType = (sender as { type?: string }).type;
  if (senderType === 'BOT') {
    // bot 自身の投稿 (= echo 防止)
    console.log(`[chat-event] skip BOT sender eventKey=${eventKey}`);
    await safeCommit(env, eventKey, claim);
    return { kind: 'skipped', reason: 'bot_sender' };
  }

  const spaceName = space.name || '';
  const spaceType = space.type || 'UNKNOWN';
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
    await safeCommit(env, eventKey, claim);
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
      await safePost(env, spaceName, '（空メッセージ）', threadName, eventKey);
      await safeCommit(env, eventKey, claim);
      return { kind: 'committed' };
    }
  }

  // ---- 5. sender email + user_mapping resolve ----
  const senderEmail = ((sender as { email?: string }).email || '').trim().toLowerCase();
  if (!senderEmail) {
    console.warn(`[chat-event] no sender email eventKey=${eventKey}`);
    await safeCommit(env, eventKey, claim);
    return { kind: 'skipped', reason: 'no_sender_email' };
  }
  // Mapping resolve with optional default fallback (Issue #186
  // follow-up #8). When `env.DEFAULT_USER_SLUG` is set and the direct
  // lookup misses, fall back to `user_mapping:<DEFAULT_USER_SLUG>` (TS
  // port of `cma_session_resolver.py:resolve` l.435-446 `default`
  // entry). Unset / blank / absent default → original
  // `unknown_sender` skip is preserved (回帰防止).
  const mappingResolution = await readUserMappingWithDefault(
    env.MAKOTO_KV,
    senderEmail,
    env.DEFAULT_USER_SLUG,
  );
  if (!mappingResolution) {
    // Scrub sender email through PII redactor before logging — Cloudflare
    // Logs retains warn lines long-term (Issue #186 D コンプラ対応).
    console.warn(
      `[chat-event] unknown_sender eventKey=${eventKey} email=${redactPiiInText(senderEmail)}`,
    );
    await safeCommit(env, eventKey, claim);
    return { kind: 'skipped', reason: 'unknown_sender' };
  }
  const userMapping = mappingResolution.mapping;
  if (mappingResolution.isDefault) {
    console.info(
      `[chat-event] mapping_default_fallback eventKey=${eventKey} ` +
        `email=${redactPiiInText(senderEmail)} default_slug=${userMapping.user_slug}`,
    );
  }

  // ---- 5a. slash-skill 決定論短絡 (#186 既知 #2 hook + /help) ----
  // Cloud Run `_handle_event` の以下と等価:
  //   - l.3949-3956 `/costguard` pre-branch (継続セッション・添付処理・LLM より前)
  //   - l.4033-4035 `/help` 即返信 (skills 一覧をユーザーに返す)
  //
  // bodyText 先頭が `/<cmd>` のとき、agent を呼ばずに決定論で返答する。
  // skillsData は本中間版では空 (= cma_skills.json TS port が別 follow-up
  // 待ち)。空でも `/help` は「スキルが登録されていません。」を返せる ので
  // bot 全体は落ちない (= follow-up で skillsData 配線時に自然に拡張)。
  // `/costguard` handler 未配線時は fallthrough = 旧経路 (agent) へ。
  if (bodyText.startsWith('/')) {
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
      await safePost(env, spaceName, slashOutcome.text, threadName, eventKey);
      await safeCommit(env, eventKey, claim);
      return { kind: 'committed' };
    }
    // 'run' / 'fallthrough' はどちらも agent 経路に流す (orchestrator に委譲)。
    // 'run' のとき `slashOutcome.prompt` / title は本中間版では未利用
    // (= 既存 orchestrator が user_mapping / persona / tools spec から組立、
    // skill 個別 system_prompt 上書き経路は follow-up で配線)。ログだけ残す。
    if (slashOutcome.kind === 'run') {
      console.log(
        `[chat-event] slash run eventKey=${eventKey} command=${slashOutcome.command} ` +
          `attach_memory=${slashOutcome.attachMemory} (agent path)`,
      );
    }
  }

  // ---- 5b. shared space thread history prepend (Issue #186 A 業務影響大) ----
  // shared space + thread reply 時のみ thread の過去 message を fetch して
  // agent prompt の先頭に挿入する。DM では skip (= 1 対 1 session memory で
  // カバー)。fetch failure は WARN + 空 fallback で従来挙動を破壊しない。
  // permanent failure (= 連続 3 回失敗) 後は KV mark で skip。
  //
  // Issue #186 既知 #6 (speaker-gate 完全実装): 履歴に未登録 chat_user_id が
  // 存在した場合は `hasUnresolvedSpeakers=true` を立て、後段 7b の
  // CHAT_POST dispatch を gate する (= Python `_compute_chat_post_gate` +
  // `_strip_chat_post_on_unresolved` 等価)。fetch 失敗時は false を維持し
  // 旧挙動 (= 履歴なし → gate しない) を破壊しない。DM では shared space
  // 履歴自体存在しないため、初期値 false のまま CHAT_POST も自然に通る。
  let hasUnresolvedSpeakers = false;
  if (!isDm && threadName && env.CHAT_SA_KEY_JSON) {
    const isPermFail = await isHistoryPermanentlyFailed(env.MAKOTO_KV, threadName);
    if (!isPermFail) {
      try {
        const history = await fetchThreadMessages(
          { saKeyJson: env.CHAT_SA_KEY_JSON },
          spaceName,
          threadName,
        );
        const historyResult = formatThreadHistoryWithMeta(history, {
          currentMessageName: message.name ?? '',
        });
        if (historyResult.text) {
          bodyText = `${historyResult.text}\n\n${bodyText}`;
        }
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
        const failure = await recordHistoryFailure(env.MAKOTO_KV, threadName);
        console.warn(
          `[chat-event] history fetch fail eventKey=${eventKey} thread=${threadName} count=${failure.count}: ${err instanceof Error ? err.message : String(err)}`,
        );
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

  // ---- 5c. Space context + roster prepend (Issue #186 C 業務影響大) ----
  // shared space + chat-api key 有り時、「ここは何の space で、誰がいる、
  // どの thread か」を内部メモブロックとして bodyText 先頭に追加する。
  // DM は skip (= 1 対 1 文脈)。Python `cma_gchat_bot.py:_build_space_context_block`
  // (l.3667) + `_build_space_roster_block` (l.3321) を 1 ブロックに連結
  // (Python wire-up l.4241-4253 / l.4269-4272 と同形)。
  // History block と並ぶときの順序: [context+roster] → [history] → [user text]
  // (= Python `prompt = f"{space_context_block}\n\n{prompt}"` で context が
  // history より前に来る、l.4271-4272)。
  // fetch / build failure は WARN + skip で従来挙動を破壊しない (failure
  // isolation、placeholder POST と同思想)。
  //
  // Issue #186 既知 #6: roster fetch が `kind: 'failure'` を返した場合も
  // CHAT_POST gate のシグナルとして hasUnresolvedSpeakers を立てる。bot
  // が space member を一切識別できない状態で別 space に CHAT_POST するのは
  // 履歴 latch と同じ権限事故源 (= unknown member 混在 thread からの横展開)
  // のため、保守的に gate 側へ倒す (= 「分からない時は止める」)。
  if (!isDm && env.CHAT_SA_KEY_JSON) {
    try {
      const rosterResult: RosterFetchResult = await fetchSpaceMemberRoster(
        { saKeyJson: env.CHAT_SA_KEY_JSON },
        spaceName,
      );
      const contextBlock = buildSpaceContextBlock(
        space as { name?: string; displayName?: string; type?: string },
        { name: sender.name, displayName: (sender as { displayName?: string }).displayName },
        { threadName, roster: rosterResult },
      );
      if (contextBlock) {
        bodyText = `${contextBlock}\n\n${bodyText}`;
        if (rosterResult.kind === 'roster') {
          console.log(
            `[chat-event] space_context+roster injected eventKey=${eventKey} ` +
              `space=${spaceName} member_count=${rosterResult.members.size}`,
          );
        } else {
          console.warn(
            `[chat-event] space_context injected without roster eventKey=${eventKey} ` +
              `space=${spaceName} roster_failure=${rosterResult.reason}`,
          );
          // Issue #186 既知 #6: roster 取得失敗 = bot が member を識別不能
          // → CHAT_POST gate を発動 (保守的 fail-safe)。
          if (!hasUnresolvedSpeakers) {
            hasUnresolvedSpeakers = true;
            console.warn(
              `[chat-event] unresolved_speakers from roster failure eventKey=${eventKey} ` +
                `space=${spaceName} reason=${rosterResult.reason} — CHAT_POST will be gated`,
            );
          }
        }
      }
    } catch (err) {
      // 想定外 throw (= egress-guard reject 等)。bot 全体は落とさず警告だけ
      // (= 従来 bodyText で orchestrate 継続、failure isolation)。
      console.warn(
        `[chat-event] space_context build fail eventKey=${eventKey} space=${spaceName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---- 6. orchestrate session ----
  const client = buildAnthropicClient(env);
  if (client === null) {
    console.error(`[chat-event] no Anthropic API key eventKey=${eventKey}`);
    await safeCommit(env, eventKey, claim);
    return { kind: 'skipped', reason: 'no_anthropic_api_key' };
  }
  // ---- 6a. placeholder POST (#186 UX 致命傷) ----
  // session.create + LLM stream (24-45 秒) 前に短い ack を Chat に POST
  // し、Chat client の「MAKOTOくん から応答ありません」timeout 表示を
  // 抑止する。POST に成功すれば `placeholderName` を保持し、後で PATCH
  // 書き換え (= safeUpdateOrPost) または DELETE cleanup に使う。POST 自体
  // が失敗した場合は placeholderName 空のまま継続 = 旧経路 (POST 新規) に
  // fallback する (= UX 縮退するが bot 全体は落とさない、failure isolation)。
  const placeholderName = await safePostPlaceholder(env, spaceName, threadName, eventKey);
  // Per-event session id holder. tool dispatcher が agent.custom_tool_use
  // 受信時に参照する。orchestrator が sessions.create or KV lookup を解決した
  // 直後に書き込まれる前にも tool は来うる (= sessions.create 完了 → 最初の
  // stream event より前) ため、box で参照を共有する。
  const sessionIdRef: { current: string } = { current: '' };
  let sessionId: string;
  let assistantText: string;
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
      toolDispatcher: (toolName, toolInput) =>
        dispatchMakotoTool(toolName, toolInput, {
          env,
          userSlug: userMapping.user_slug,
          boundMessageId: '',
          callerSessionId: sessionIdRef.current,
        }),
    });
    sessionId = orchestrated.sessionId;
    sessionIdRef.current = sessionId;
    assistantText = orchestrated.assistantText;

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
      if (recoveryResult.outcome === 'recovered' && recoveryResult.text) {
        // 収集済み部分テキストを recovered 本文で置換。
        // Python `collected[:] = [_rec["text"]]` + `_recovery_suppressed_cap_notice`
        // と同等の効果 (TS 中間版では cap notice 自体が未実装なので「置換」だけ
        // 行えば cap notice 抑止 = no-op で済む)。
        assistantText = recoveryResult.text;
      }
    }
  } catch (err) {
    // 失敗経路 → placeholder 残骸を cleanup (Python `_delete_chat_message`
    // 等価)。404 は内部で正常扱い、その他失敗は WARN log で吸収して bot
    // 全体は落とさない (= 上流 retry/skip 経路を優先)。
    if (placeholderName) {
      await safeDeletePlaceholder(env, placeholderName, eventKey);
    }
    if (err instanceof OrchestratorFailure) {
      if (err.reason === 'sessions_create_failed' || err.reason === 'stream_failed') {
        // transient → release & retry
        console.error(
          `[chat-event] orchestrator transient eventKey=${eventKey} reason=${err.reason}: ${err.message}`,
        );
        await safeRelease(env, eventKey, claim);
        return { kind: 'release_and_retry', reason: err.reason };
      }
      // no_anthropic_client = misconfigured deploy, skip + commit (Queue 暴走防止)
      console.error(`[chat-event] orchestrator fatal eventKey=${eventKey}: ${err.message}`);
      await safeCommit(env, eventKey, claim);
      return { kind: 'skipped', reason: err.reason };
    }
    // Unknown throw — defensive: release & retry
    console.error(
      `[chat-event] orchestrator threw eventKey=${eventKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
    await safeRelease(env, eventKey, claim);
    return { kind: 'release_and_retry', reason: 'unknown_orchestrator_throw' };
  }

  // ---- 7. parse markers + dispatch ----
  // 7a. EMAIL_SEND markers
  const emailParsed = parseAssistantText(assistantText);
  for (const f of emailParsed.failures) {
    console.warn(
      `[chat-event] EMAIL_SEND parse failure eventKey=${eventKey} reason=${f.reason} raw=${f.raw.slice(0, 200)}`,
    );
  }
  await dispatchEmailMarkers(
    env,
    eventKey,
    emailParsed.markers,
    sessionId,
    userMapping.agent_id,
  );

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
  const chatPostGateApplication = applyChatPostGateToText(
    emailParsed.cleanedText,
    hasUnresolvedSpeakers,
  );
  if (chatPostGateApplication.decision.gate) {
    console.log(
      `[chat-event] CHAT_POST gated eventKey=${eventKey} ` +
        `reason=${chatPostGateApplication.decision.reason} ` +
        `(unresolved speakers in history)`,
    );
  }
  const chatPostResult = await dispatchChatPostMarkers(
    env,
    eventKey,
    chatPostGateApplication.text,
    spaceName,
    threadName,
  );

  // 7c. SCHEDULE_ACTION markers (Issue #186 #5 follow-up = 実 dispatch)。
  //     env (CHAT_SA_KEY_JSON + GCP_SCHEDULER_PROJECT + GCP_SCHEDULER_LOCATION)
  //     が揃っているときだけ activate する (= 既存挙動破壊しない、deploy
  //     gradual rollout の余地を残す)。失敗は WARN log + 元 cleanedText
  //     で投稿継続 (failure isolation)。
  const scheduleResult = await dispatchScheduleActionMarkers(
    env,
    eventKey,
    chatPostResult.cleanedText,
  );

  // 7d. current space 投稿 (clean 後本文)
  // 7d-1. internal-state redaction を最終ガード (= safety net)。
  const scrubbed = scrubInternalStateForChat(scheduleResult.cleanedText, `chat:${sessionId}`);
  if (scrubbed.hits.length > 0) {
    console.warn(
      `[chat-event] internal-state redactor scrubbed eventKey=${eventKey} hits=${scrubbed.hits.join(',')}`,
    );
  }
  const finalText = scrubbed.text;
  if (finalText.trim().length > 0) {
    // placeholder POST 済なら PATCH 書き換え (Python `_placeholder_reply`
    // = `_update_chat_message` 経路、l.3926-3942 等価)。PATCH 失敗時は
    // WARN log + safePost に fallback (= bot 全体は落とさない、Python
    // l.3940-3942 等価)。placeholder 無し (POST 自体が失敗していたケース)
    // は従来通り新規 POST。
    if (placeholderName) {
      await safeUpdateOrPost(env, placeholderName, spaceName, finalText, threadName, eventKey);
    } else {
      await safePost(env, spaceName, finalText, threadName, eventKey);
    }
  } else {
    console.log(
      `[chat-event] empty clean text after marker strip eventKey=${eventKey} session=${sessionId}`,
    );
    // 本文空 = 投稿すべきテキスト無し。placeholder 残骸を消す
    // (Python では placeholder のまま残るが、TS では `_delete_chat_message`
    // 経路で残骸を出さない方が UX 上素直 = #186 の主旨に沿う)。
    if (placeholderName) {
      await safeDeletePlaceholder(env, placeholderName, eventKey);
    }
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
    finalText,
    sessionId,
    messageId: message.name,
  });

  // ---- 9. commit ----
  await safeCommit(env, eventKey, claim);
  return { kind: 'committed' };
}

// ---------------------------------------------------------------------------
// helper: dispatch EMAIL_SEND markers
// ---------------------------------------------------------------------------

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
): Promise<void> {
  if (markers.length === 0) return;
  const apiKey = env.AGENTMAIL_API_KEY;
  const inboxId = env.AGENTMAIL_DEFAULT_INBOX_ID;
  if (!apiKey) {
    console.warn(
      `[chat-event] EMAIL_SEND skipped eventKey=${eventKey}: AGENTMAIL_API_KEY missing (${markers.length} marker(s))`,
    );
    return;
  }
  if (!inboxId) {
    console.warn(
      `[chat-event] EMAIL_SEND skipped eventKey=${eventKey}: AGENTMAIL_DEFAULT_INBOX_ID missing (${markers.length} marker(s))`,
    );
    return;
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
      let sendResult;
      if (m.in_reply_to_message_id) {
        sendResult = await client.replyMessage({
          ...baseInput,
          parentMessageId: m.in_reply_to_message_id,
        });
      } else {
        sendResult = await client.sendMessage(baseInput);
      }
      if (sendResult.message_id) {
        await recordSentMessage(
          env.DB,
          sendResult.message_id,
          sessionId,
          agentId,
          m.to,
          sendResult.rfc822_message_id || undefined,
        );
      }
      console.log(
        `[chat-event] EMAIL_SEND ok eventKey=${eventKey} to=${redactPiiInText(m.to)} subject_chars=${m.subject.length}`,
      );
    } catch (err) {
      if (err instanceof AgentMailError) {
        console.warn(
          `[chat-event] EMAIL_SEND fail eventKey=${eventKey} to=${redactPiiInText(m.to)} status=${err.status} transient=${err.transient}: ${redactPiiInText(err.message)}`,
        );
      } else {
        console.warn(
          `[chat-event] EMAIL_SEND threw eventKey=${eventKey} to=${redactPiiInText(m.to)}: ${redactPiiInText(err instanceof Error ? err.message : String(err))}`,
        );
      }
      // 1 marker 失敗で全体落とさない (failure isolation)。
    }
  }
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
          await postChatMessage(
            { saKeyJson: saKey },
            targetSpace,
            m.text,
            threadOpt ?? {},
          );
          console.log(
            `[chat-event] CHAT_POST posted eventKey=${eventKey} space=${targetSpace} text_chars=${m.text.length}`,
          );
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
  inputText: string,
): Promise<ScheduleDispatchResult> {
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
    if (env.SCHEDULER_HANDLER_TOPIC_PREFIX) {
      managerDeps.handlerTopicPrefix = env.SCHEDULER_HANDLER_TOPIC_PREFIX;
    }
    const manager = createCloudSchedulerManager(managerDeps);
    const result = await handleScheduleActionMarker(inputText, manager);
    if (result.markerCount > 0) {
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


// ---------------------------------------------------------------------------
// helper: safe wrappers (never throw)
// ---------------------------------------------------------------------------

async function safePost(
  env: Env,
  spaceName: string,
  text: string,
  threadName: string | null,
  eventKey: string,
): Promise<void> {
  const saKey = env.CHAT_SA_KEY_JSON;
  if (!saKey) {
    console.warn(
      `[chat-event] safePost skipped eventKey=${eventKey} CHAT_SA_KEY_JSON missing`,
    );
    return;
  }
  if (!spaceName || !text) {
    console.warn(
      `[chat-event] safePost skipped eventKey=${eventKey} empty space or text`,
    );
    return;
  }
  try {
    // Python `_reply_to_chat:l.1247-1249` と等価: thread 指定時は
    // `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD` を必須で
    // 付ける。これがないと Chat REST API のデフォルト動作で「新規 thread
    // として post」される (= 2026-05-26 reactive bot 実機検証で表示崩れ
    // 確認、Python と等価合わせ)。
    await postChatMessage(
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
  }
}

/**
 * placeholder POST helper (#186 UX 致命傷 fix)。Cloud Run
 * `cma_lib.py:send_placeholder:l.3674-3720` の Worker port (Firestore 連動
 * の dedupe state commit は省略 — Workers 側 dedupe は `confirmOwner` /
 * `commitDone` が別軸で担保するため、placeholder POST 結果の `name` だけ
 * 取れれば PATCH update / DELETE cleanup には十分)。
 *
 * 戻り値: 成功時 message resource name (`spaces/.../messages/...`)、失敗時
 * 空文字。caller 側は空文字なら従来の新規 POST 経路に fallback する。
 */
async function safePostPlaceholder(
  env: Env,
  spaceName: string,
  threadName: string | null,
  eventKey: string,
): Promise<string> {
  const saKey = env.CHAT_SA_KEY_JSON;
  if (!saKey) {
    console.warn(
      `[chat-event] placeholder POST skipped eventKey=${eventKey} CHAT_SA_KEY_JSON missing`,
    );
    return '';
  }
  if (!spaceName) {
    console.warn(`[chat-event] placeholder POST skipped eventKey=${eventKey} empty space`);
    return '';
  }
  try {
    // thread reply 時は `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`
    // を必須付与 (= safePost と同様、Python `_reply_to_chat:l.1247-1249` 等価)。
    const res = await postChatMessage(
      { saKeyJson: saKey },
      spaceName,
      PLACEHOLDER_TEXT,
      threadName
        ? {
            threadName,
            threadFallback: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
          }
        : {},
    );
    return res.name;
  } catch (err) {
    const reason =
      err instanceof ChatApiError
        ? `chat_api_${err.status}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.warn(
      `[chat-event] placeholder POST fail eventKey=${eventKey} space=${spaceName}: ${reason}`,
    );
    return '';
  }
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

async function safeCommit(
  env: Env,
  eventKey: string,
  claim: { owner: string; version: number },
): Promise<void> {
  try {
    const ok = await commitDone(env.DB, eventKey, claim.owner, claim.version);
    if (!ok) {
      console.warn(
        `[chat-event] commit-fence-drift eventKey=${eventKey} owner=${claim.owner} version=${claim.version}`,
      );
    }
  } catch (err) {
    console.warn(
      `[chat-event] commitDone threw eventKey=${eventKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
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
 * cma_skills.json の TS port は本中間版では未配線 (= `cma_skills.json` を
 * Worker bundle に焼く配線は別 follow-up)。`/help` 短絡経路用に空 skillsData
 * を返す stub。env に skill 定義注入経路ができたら、ここで JSON parse して
 * SkillsData 型を返す形に差替する (= 関数境界は維持されるので caller 影響なし)。
 *
 * 現状の動作:
 *   - `/help` → 「スキルが登録されていません。」を返す (= 最小だが安全)
 *   - `/costguard` → handler 経路で短絡 (本関数の skillsData は無関係)
 *   - その他 `/cmd` → resolveSkillRun が 「未登録」 reply を返す
 *
 * Issue #186 follow-up で cma_skills.json TS port + env 配線が完了したら、
 * 本関数を `JSON.parse(env.CMA_SKILLS_JSON || '{}')` 等に差替する。
 */
function loadSlashSkillsData(env: Env): SkillsData {
  void env; // 中間版では env 未参照 (= 配線完了後に CMA_SKILLS_JSON / KV 経由読み)
  return { skills: {} };
}

// ---------------------------------------------------------------------------
// follow-up scope notes (= 中間版で省略した機能、別 Issue で対応)
// ---------------------------------------------------------------------------
//
// TODO(#186 follow-up): 画像 / PDF / Office 添付処理 (= `_build_image_attachments`)
// TODO(#186 follow-up): /costguard 本体 handler 配線 (cost-guard.ts handle 関数 + slashHandlers.costguard 注入)
// TODO(#186 follow-up): cma_skills.json TS port + loadSlashSkillsData env 配線
// TODO(#186 follow-up): cap-recovery 完全実装 (cap 超過後の memory snapshot)
// TODO(#186 follow-up): intent-detector 統合 (intent ベース dispatch 分岐)
// TODO(#186 follow-up): Cold continuation の SignalB 経由 thread-self-scan
// ✅ DONE (Issue #186 既知 #6): 未解決 speaker gate (= shared space で
//    history fetch 結果に未登録 chat_user_id が居るとき CHAT_POST 全 marker
//    を `applyChatPostGateToText` で strip。speaker-resolver.ts pure 関数群
//    + speaker-gate.ts wire-up 経路。external tool gate は actor 駆動軸で
//    別途 #186 follow-up)。
// TODO(#186 follow-up): CHAT_POST alias resolver port (= cma_gchat_send.resolve_space)
// TODO(#186 follow-up): user_mapping default fallback (= 既知ユーザ以外の処理)
// TODO(#186 follow-up): annotation-based mention detection (= _is_for_bot 完全 port)
// TODO(#186 follow-up): _strip_mention の annotations ベース完全実装
// TODO(#186 follow-up): user_message envelope の cap-recovery / intent / speaker prefix
