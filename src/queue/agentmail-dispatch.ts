/**
 * AgentMail layer-7 dispatcher — wires the consumer framing (layer 5)
 * to the per-user session loop + Google Workspace tool dispatcher
 * (layer 7-4) + EMAIL_SEND marker delivery via AgentMail REST.
 *
 * Replaces `defaultDispatcher` from `agentmail-consumer.ts`. The
 * consumer entrypoint in `src/index.ts` swaps in this implementation
 * at layer 7-3 (= once this file lands).
 *
 * Flow per inbound message (already claimed by the framing layer):
 *
 *   1. Resolve sender → user_slug + agent_id + Memory Store resources.
 *      Unknown sender → skipped (mail dropped).
 *
 *   2. Look up an existing session via In-Reply-To / References →
 *      `findSessionByRfc822MessageId`. Match wins only when the
 *      session's agent_id equals the resolved agent_id.
 *
 *   3. Branch on continuation vs first-contact:
 *      - existing sessionId  → buildContinuationPrompt(...) + sendAndStream
 *      - no sessionId        → createSessionWithResources + initial prompt
 *
 *   4. Drive the SDK event stream with `sendAndStreamWithToolDispatch`.
 *      The TS event loop self-services `agent.custom_tool_use` events
 *      (= MAKOTO's 10 tools) via `dispatchMakotoTool` and posts the
 *      result back as `user.custom_tool_result` (mirrors Python
 *      cma_lib.py:2563-2729).
 *
 *   5. Parse EMAIL_SEND markers from the accumulated assistant text.
 *
 *   6. Re-fence with `confirmOwner` before any external write — if
 *      the lease passed to a successor we skip the send and let the
 *      successor handle it (no double-reply).
 *
 *   7. For each marker, run the body through the internal-state
 *      redactor (parity with Python `scrub_internal_state_for_chat`),
 *      then deliver via AgentMail REST. Reply vs. new send chooses
 *      between `replyMessage` and `sendMessage` based on whether the
 *      inbound message id is known.
 *
 *   8. Record each sent message into `sent_messages` (with the
 *      outbound RFC 822 Message-ID) so future inbound replies can
 *      thread back via `findSessionByRfc822MessageId`.
 *
 *   9. Outcome:
 *      - `committed`            — happy path, framing layer commits the dedupe row.
 *      - `skipped`              — sender unknown / no API key / no inbox / lost claim.
 *        The framing layer commits anyway so the queue stops redelivering.
 *      - `release_and_retry`    — transient AgentMail or Anthropic failure that
 *        the queue should retry; framing layer releases the lease so a
 *        successor can take over.
 *
 * Thread history fetching (= prior messages on the same thread, used
 * to seed `buildContinuationPrompt`) is implemented on continuation
 * paths. SignalB thread self-scan also reuses the fetched AgentMail
 * thread when RFC 822 headers do not map to a known D1 row.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 — 層 7-2 dispatch body + 層 7-3 wire-up)
 * Spec: plan-draft.md §step 9 dispatch + impl-mid-3 §3.2 案 B
 */

import { AgentMailClient, AgentMailError } from '../lib/agentmail-api';
import { threadSelfScan, type AgentMailThread } from '../lib/agentmail-signal-b';
import { ChatApiError, postChatMessage } from '../lib/chat-api';
import {
  buildAutoreplyNotificationText,
  buildInboundNotificationText,
} from '../lib/agentmail-notification';
import { confirmOwner } from '../lib/dedupe';
import {
  buildContinuationPrompt,
  CONTINUATION_REPLY_SYSTEM_ADDENDUM,
} from '../lib/continuation';
import { extractBody, extractThreadRefs, reChainDepth } from '../lib/email-thread';
import { parseAssistantText } from '../lib/email-send-marker';
import { fetchMailThreadMessages } from '../lib/mail-history';
import {
  readUserMappingWithDefault,
  readUserMappingByAgentId,
  resolveSenderToResources,
} from '../lib/memory-attach';
import { toResourceParam, type MemoryStoreResourceParam } from '../types/memory';
import {
  buildAnthropicClient,
  createSessionWithResources,
  sendAndStreamWithToolDispatch,
} from '../lib/session';
import { scrubInternalStateForChat } from '../redact/internal-state';
import { redactPiiInText } from '../redact/pii';
import { findSessionByRfc822MessageId, recordSentMessage } from '../storage';
import { executeWithCommit } from '../lib/three-stage-precheck';
import { assertBridgeEgressAllowed } from '../lib/egress-guard';
import type { AgentMailMessage, EmailSendMarker } from '../types/agentmail';
import { dispatchMakotoTool } from '../dispatch/makoto-tool-dispatcher';
import type {
  AgentMailDispatcher,
  AgentMailDispatchContext,
  AgentMailDispatchOutcome,
} from './agentmail-consumer';

/** Soft cap on `sendAndStreamWithToolDispatch` wall time. */
const SESSION_STREAM_TIMEOUT_MS = 110_000;

/**
 * Layer-7 dispatcher. Bound from `src/index.ts` as
 * `agentmailDispatcher`; called from `handleAgentMailMessage` after
 * the claim + DO lock are acquired.
 */
export const agentmailDispatch: AgentMailDispatcher = async (context) => {
  // 1. Sender + thread identity.
  const { env, event, message, rfc822MsgId, claim, eventKey } = context;
  const sender = typeof message.from === 'string' ? message.from : '';
  if (!sender) {
    return { kind: 'skipped', reason: 'no_sender' };
  }

  // RFC 822 thread resolve must run before sender mapping. External
  // counterparties replying to MAKOTO-sent mail are often absent from
  // `user_mapping:<email>`; the sent_messages row is the authority for
  // continuation routing.
  const refs = extractThreadRefs(message);
  let sessionId: string | null = null;
  let sessionAgentId: string | null = null;
  for (let i = refs.references.length - 1; i >= 0; i--) {
    const candidate = refs.references[i];
    if (!candidate) continue;
    const found = await findSessionByRfc822MessageId(env.DB, candidate);
    if (found) {
      sessionId = found.sessionId;
      sessionAgentId = found.agentId;
      break;
    }
  }

  // 2. Anthropic client.
  const client = buildAnthropicClient(env);
  if (!client) {
    // No API key — the bridge is in a misconfigured deploy. Skip
    // (committing the claim) so the queue doesn't loop forever.
    console.warn(
      `[agentmail-dispatch] skip eventKey=${eventKey} reason=no_anthropic_api_key`,
    );
    return { kind: 'skipped', reason: 'no_anthropic_api_key' };
  }

  const inboxIdForThread = extractInboxId(event);
  const threadId =
    typeof message.thread_id === 'string' && message.thread_id.length > 0
      ? message.thread_id
      : '';

  // 4. Continuation vs first-contact branch.
  // SignalB: when RFC 822 headers do not map to D1 but the AgentMail
  // thread itself contains a bot-authored message, keep the inbound on
  // the continuation path. This mirrors Python `_thread_self_scan`.
  let signalBHistory: AgentMailMessage[] = [];
  let signalBHasSelf = false;
  if (sessionId === null && inboxIdForThread && threadId) {
    const scan = await threadSelfScan(
      (inboxId, tid) => fetchAgentMailThread(env, inboxId, tid),
      inboxIdForThread,
      threadId,
      {
        warn: (msg) =>
          console.warn(
            `[agentmail-dispatch] signalB eventKey=${eventKey} ${msg}`,
          ),
      },
    );
    signalBHasSelf = scan.selfPresent;
    signalBHistory = scan.messages;
    console.log(
      `[agentmail-dispatch] signalB eventKey=${eventKey} thread_id=${threadId} self=${scan.selfPresent} messages=${scan.messages.length} senders_self=${scan.sendersSelf}`,
    );
    if (scan.selfPresent && sessionId === null) {
      const recovered = await findSessionInThreadHistory(env.DB, scan.messages);
      if (recovered) {
        sessionId = recovered.sessionId;
        sessionAgentId = recovered.agentId;
      }
    }
  }
  const isContinuation =
    sessionId !== null || signalBHasSelf || reChainDepth(message.subject) >= 1;

  // 4a. Cold inbound notify-only path (Issue #186 #2). When the
  // operator has wired a notify space + Chat SA key, defer cold
  // inbound (= no continuation match) to a human decision: post a
  // `📨 新規問い合わせ` to the notify space and commit without
  // running the bot. Mirrors Cloud Run
  // `cma_agentmail_inbound.py:_notify_only(is_continuation=False)`
  // at l.1755.
  //
  // Env unset = legacy "always run the bot" behaviour preserved so
  // existing dispatch tests + deployments without a notify space
  // configured don't change.
  if (
    !isContinuation &&
    env.MAKOTO_NOTIFY_SPACE &&
    env.CHAT_SA_KEY_JSON
  ) {
    await tryNotifyInbound(env, message, false, eventKey);
    return { kind: 'committed' };
  }

  const senderResolution = await resolveSenderToResources(env.MAKOTO_KV, sender);
  let userSlug = senderResolution?.user_slug ?? '';
  let agentId = senderResolution?.agent_id ?? '';
  let resources: MemoryStoreResourceParam[] = senderResolution?.resources ?? [];

  if (sessionId !== null && sessionAgentId) {
    const owner = await readUserMappingByAgentId(env.MAKOTO_KV, sessionAgentId);
    agentId = sessionAgentId;
    userSlug = owner?.mapping.user_slug ?? userSlug;
    if (!userSlug) {
      userSlug = `agent-${sessionAgentId.slice(-8)}`;
      console.warn(
        `[agentmail-dispatch] continuation owner mapping missing eventKey=${eventKey} agent=${sessionAgentId}`,
      );
    } else if (senderResolution && senderResolution.agent_id !== sessionAgentId) {
      console.warn(
        `[agentmail-dispatch] continuation sender mapping differs eventKey=${eventKey} sender_agent=${senderResolution.agent_id} owner_agent=${sessionAgentId}`,
      );
    }
  } else if (!senderResolution) {
    const fallback = await resolveDefaultMailOwner(env);
    if (!fallback) {
      return { kind: 'skipped', reason: 'no_mail_owner_mapping' };
    }
    userSlug = fallback.userSlug;
    agentId = fallback.agentId;
    resources = fallback.resources;
  }

  let userMessage: string;
  if (sessionId === null) {
    try {
      sessionId = await createSessionWithResources(client, {
        agentId,
        environmentId: env.ENVIRONMENT_ID,
        resources,
      });
    } catch (err) {
      console.error(
        `[agentmail-dispatch] sessions.create failed eventKey=${eventKey} agent=${agentId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // sessions.create failures are usually transient (quota / 5xx)
      // — let the queue retry so a fresh attempt picks up after the
      // current lease expires.
      return { kind: 'release_and_retry', reason: 'sessions_create_failed' };
    }
    console.log(
      `[agentmail-dispatch] created session=${sessionId} agent=${agentId} user=${userSlug} eventKey=${eventKey}`,
    );
    if (isContinuation) {
      userMessage = `${CONTINUATION_REPLY_SYSTEM_ADDENDUM}\n\n${buildContinuationPrompt(message, signalBHistory)}`;
    } else {
      userMessage = buildInitialUserMessage(message, false);
    }
  } else {
    // Existing session — fetch prior thread messages so the
    // continuation prompt carries full context into the agent. Mirrors
    // Python `cma_agentmail_inbound.py:_fetch_thread_messages` (l.2027)
    // + `build_continuation_prompt` (l.2090).
    //
    // Failure mode: `fetchMailThreadMessages` returns `[]` on every
    // error (no API key / missing inbox / 4xx / 5xx / network). The
    // continuation flow stays usable with an empty history (= same as
    // pre-fetch behaviour). We deliberately don't gate the reply on
    // this fetch — a stuck threads endpoint should never block the
    // agent from at least responding to the latest inbound.
    let history: AgentMailMessage[] = [];
    if (inboxIdForThread && threadId) {
      try {
        history = await fetchMailThreadMessages(env, inboxIdForThread, threadId);
      } catch (err) {
        // Defensive: `fetchMailThreadMessages` is documented to swallow
        // every error, but if a future change ever bubbles one we still
        // want the dispatcher to proceed with empty history rather than
        // dropping the inbound entirely.
        console.warn(
          `[agentmail-dispatch] mail history fetch threw eventKey=${eventKey} thread_id=${threadId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        history = [];
      }
    } else {
      console.warn(
        `[agentmail-dispatch] mail history skipped eventKey=${eventKey} reason=${
          !inboxIdForThread ? 'no_inbox_id' : 'no_thread_id'
        }`,
      );
    }
    userMessage = `${CONTINUATION_REPLY_SYSTEM_ADDENDUM}\n\n${buildContinuationPrompt(message, history)}`;
    console.log(
      `[agentmail-dispatch] continuing session=${sessionId} agent=${agentId} user=${userSlug} eventKey=${eventKey} history=${history.length}`,
    );
  }

  // 5. Drive the SDK event loop.
  let streamResult;
  try {
    streamResult = await sendAndStreamWithToolDispatch(client, {
      sessionId,
      userMessage,
      toolDispatcher: (toolName, toolInput) =>
        dispatchMakotoTool(toolName, toolInput, {
          env,
          userSlug,
          boundMessageId: rfc822MsgId,
          callerSessionId: sessionId!,
        }),
      timeoutMs: SESSION_STREAM_TIMEOUT_MS,
      payloadAudit: {
        kv: env.MAKOTO_KV,
        enabled: env.CMA_AUDIT_USER_MESSAGE_PAYLOADS,
        ttlDays: env.CMA_AUDIT_TTL_DAYS,
        maxTextChars: env.CMA_AUDIT_MAX_TEXT_CHARS,
        mode: 'agentmail',
        context: {
          event_key: eventKey,
          sender_email: sender,
          user_slug: userSlug,
          agent_id: agentId,
        },
      },
    });
  } catch (err) {
    console.error(
      `[agentmail-dispatch] stream failed eventKey=${eventKey} session=${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Stream timeout / SDK error → let the queue retry. Successor
    // (TAKEOVER) will pick up after our lease expires.
    return { kind: 'release_and_retry', reason: 'stream_failed' };
  }

  // 6. Parse EMAIL_SEND markers + log any failures.
  const parsedAssistant = parseAssistantText(streamResult.assistantText);
  let { markers } = parsedAssistant;
  const { failures, cleanedText } = parsedAssistant;
  if (failures.length > 0) {
    for (const f of failures) {
      console.warn(
        `[agentmail-dispatch] EMAIL_SEND parse failure eventKey=${eventKey} reason=${f.reason} raw=${f.raw.slice(0, 200)}`,
      );
    }
  }
  if (markers.length === 0 && isContinuation && cleanedText.trim().length > 0) {
    const continuationReply = buildContinuationReplyMarker(message, cleanedText);
    if (continuationReply) {
      markers = [continuationReply];
    }
  }
  if (markers.length === 0) {
    // Agent chose not to reply this turn (e.g. cleanedText is an
    // internal note). Committed — we processed the inbound; the
    // dedupe row stops further redeliveries.
    console.log(
      `[agentmail-dispatch] no EMAIL_SEND markers eventKey=${eventKey} session=${sessionId} cleanedLen=${cleanedText.length}`,
    );
    return { kind: 'committed' };
  }

  // 7. Re-fence: confirm we still own the claim before any AgentMail send.
  const stillOwner = await confirmOwner(env.DB, eventKey, claim.owner, claim.version);
  if (!stillOwner) {
    console.warn(
      `[agentmail-dispatch] lost_claim_before_send eventKey=${eventKey} owner=${claim.owner} version=${claim.version}`,
    );
    return { kind: 'skipped', reason: 'lost_claim_before_send' };
  }

  // 8. Resolve the AgentMail inbox id from the webhook envelope. Some
  // event shapes carry it on `data.inbox_id`; others don't. Without
  // it we can't address the outbound — skip with a loud warn (the
  // dedupe row still commits so we don't loop).
  const inboxId = extractInboxId(event);
  if (!inboxId) {
    console.warn(
      `[agentmail-dispatch] no_inbox_id eventKey=${eventKey} — cannot deliver ${markers.length} marker(s)`,
    );
    return { kind: 'skipped', reason: 'no_inbox_id' };
  }

  // 9. Deliver each marker.
  if (!env.AGENTMAIL_API_KEY) {
    console.warn(
      `[agentmail-dispatch] no_api_key eventKey=${eventKey} — cannot deliver ${markers.length} marker(s)`,
    );
    return { kind: 'skipped', reason: 'no_agentmail_api_key' };
  }
  const amClientOpts = env.AGENTMAIL_API_BASE_URL ? { baseUrl: env.AGENTMAIL_API_BASE_URL } : {};
  const amClient = new AgentMailClient(env.AGENTMAIL_API_KEY, amClientOpts);
  const parentMessageId =
    typeof message.id === 'string' && message.id.length > 0
      ? message.id
      : typeof message.message_id === 'string' && message.message_id.length > 0
        ? message.message_id
        : '';

  const successfullySentBodies: string[] = [];
  for (const m of markers) {
    try {
      // 3-stage precheck wrap (Python `cma_lib.py:send_mail` 等価)。
      // 同一 (eventKey, kind='email_send', target=`${inboxId}:${to}:${reply_id}`)
      // 既送信なら ALREADY → AgentMail への二重送信を構造的に防ぐ。
      // target は webhook 発火源 (= rfc822 in_reply_to) を含めることで
      // 「同 inbox/同 to でも別 thread への返信は別 send」として扱う。
      const replyIdForTarget = m.in_reply_to_message_id ?? parentMessageId ?? '';
      const emTarget = `${inboxId}:${m.to}:${replyIdForTarget}`;
      const emOutcome = await executeWithCommit({
        env,
        parentEventKey: eventKey,
        parentOwner: claim.owner,
        kind: 'email_send',
        target: emTarget,
        sendFn: async () =>
          await deliverMarker(amClient, m, {
            inboxId,
            parentMessageIdFallback: parentMessageId,
            agentId,
            sessionId,
            jobId: `mail-send/${sessionId}`,
          }),
      });
      if (emOutcome.outcome === 'already') {
        console.log(
          `[agentmail-dispatch] EMAIL_SEND already sent eventKey=${eventKey} to=${redactPiiInText(m.to)} — skipping duplicate`,
        );
        // 既送信 = "成功扱い" として後続の continuation 通知に body を含める。
        // (= 既に届いている = ユーザー視点は通知に出すべき = Python 等価挙動)
        successfullySentBodies.push(m.body);
        continue;
      }
      if (emOutcome.outcome === 'lease_alive') {
        console.warn(
          `[agentmail-dispatch] EMAIL_SEND in-flight by another worker eventKey=${eventKey} to=${redactPiiInText(m.to)}`,
        );
        continue;
      }
      if (emOutcome.outcome === 'lease_lost') {
        console.warn(
          `[agentmail-dispatch] EMAIL_SEND lease lost eventKey=${eventKey} to=${redactPiiInText(m.to)}`,
        );
        continue;
      }
      if (emOutcome.outcome === 'precheck_failed') {
        console.warn(
          `[agentmail-dispatch] EMAIL_SEND precheck failed eventKey=${eventKey} to=${redactPiiInText(m.to)} reason=${emOutcome.reason}`,
        );
        continue;
      }
      // outcome === 'sent'
      const sendResult = emOutcome.result;
      successfullySentBodies.push(m.body);
      // Record outbound so future inbound replies can thread back.
      // `rfc822_message_id` may be empty if AgentMail didn't return one
      // — we still record the AgentMail-opaque id so the row exists.
      if (sendResult.message_id) {
        await recordSentMessage(
          env.DB,
          sendResult.message_id,
          sessionId,
          agentId,
          m.to,
          sendResult.rfc822_message_id || undefined,
          'agentmail_auto_reply',
        );
      }
    } catch (err) {
      if (err instanceof AgentMailError && err.transient) {
        // Scrub PII (= marker.to email + any email/phone in error message) before
        // logging — Cloudflare Logs retains error lines long-term (Issue #186 D コンプラ対応).
        console.error(
          `[agentmail-dispatch] AgentMail transient eventKey=${eventKey} marker_to=${redactPiiInText(m.to)}: ${redactPiiInText(err.message)}`,
        );
        return { kind: 'release_and_retry', reason: 'agentmail_transient' };
      }
      console.error(
        `[agentmail-dispatch] AgentMail send failed eventKey=${eventKey} marker_to=${redactPiiInText(m.to)}: ${redactPiiInText(
          err instanceof Error ? err.message : String(err),
        )}`,
      );
      // Non-transient send failure: skip rather than loop. The dedupe
      // row commits so the queue stops redelivering. Manual audit
      // recovers anything we couldn't deliver.
      return { kind: 'skipped', reason: 'agentmail_permanent_failure' };
    }
  }

  // 10. Continuation auto-reply notification (Issue #186 #4). When
  // AgentMail accepted every marker, post a `📤 continuation 自動返信を
  // 送信しました` to the notify space so the operator gets an FYI of
  // exactly what got auto-replied. Mirrors Cloud Run
  // `_auto_reply_continuation` post-send block at
  // `cma_agentmail_inbound.py:l.2019-2024`. Failure is non-fatal — the
  // outbound mail is already accepted so we keep `committed` (mirrors
  // the `AUTO_REPLIED` terminal state from Python l.2025).
  if (
    isContinuation &&
    env.MAKOTO_NOTIFY_SPACE &&
    env.CHAT_SA_KEY_JSON &&
    successfullySentBodies.length > 0
  ) {
    const replyTextForNotify = successfullySentBodies.join('\n---\n');
    await tryNotifyAutoreplyForInbound(
      env,
      message,
      replyTextForNotify,
      eventKey,
    );
  }

  return { kind: 'committed' };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DeliverMarkerCtx {
  inboxId: string;
  parentMessageIdFallback: string;
  agentId: string;
  sessionId: string;
  jobId: string;
}

/**
 * Wrap the AgentMail send. Picks reply vs send based on
 * `marker.in_reply_to_message_id` (with fallback to the inbound
 * message id when the marker omits it). Always scrubs the body
 * through the internal-state redactor first — `scrubInternalStateForChat`
 * is the same JSON-backed pattern set Python uses.
 */
async function deliverMarker(
  client: AgentMailClient,
  marker: EmailSendMarker,
  ctx: DeliverMarkerCtx,
): Promise<{ message_id: string; rfc822_message_id: string }> {
  const scrubbed = scrubInternalStateForChat(marker.body, ctx.jobId);
  if (scrubbed.hits.length > 0) {
    console.warn(
      `[agentmail-dispatch] redactor scrubbed eventKey=${ctx.sessionId} hits=${scrubbed.hits.join(',')}`,
    );
  }
  const baseInput = {
    inboxId: ctx.inboxId,
    to: [marker.to],
    subject: marker.subject,
    body: scrubbed.text,
    ...(marker.cc && marker.cc.length > 0 ? { cc: marker.cc } : {}),
    ...(marker.bcc && marker.bcc.length > 0 ? { bcc: marker.bcc } : {}),
    ...(marker.attachments && marker.attachments.length > 0
      ? { attachments: marker.attachments }
      : {}),
  };
  const parentId = marker.in_reply_to_message_id ?? ctx.parentMessageIdFallback;
  if (parentId) {
    return await client.replyMessage({
      ...baseInput,
      parentMessageId: parentId,
    });
  }
  return await client.sendMessage(baseInput);
}

/**
 * Compose the user.message body for a first-contact mail. Inlines the
 * inbound headers + body so the agent has full context in one event
 * (parity with the Python inbound path, which posts the full mail
 * rather than a "call email_read" pointer). For continuation replies
 * we route through `buildContinuationPrompt` instead — this helper
 * only runs on fresh sessions.
 */
function buildInitialUserMessage(msg: AgentMailMessage, isContinuationByDepth: boolean): string {
  const from = msg.from ?? '';
  const subject = msg.subject ?? '(no subject)';
  const body = extractBody(msg);
  const header = isContinuationByDepth
    ? 'メールが届きました (継続スレッド扱い。bot 側で送信するので EMAIL_SEND マーカーで返信本文を出してください)。'
    : 'メールが届きました。返信する場合は EMAIL_SEND マーカーで本文を出してください (bot 側で送信)。';
  return [
    header,
    `From: ${from}`,
    `Subject: ${subject}`,
    '',
    '本文:',
    body || '(本文なし)',
  ].join('\n');
}

function buildContinuationReplyMarker(
  msg: AgentMailMessage,
  body: string,
): EmailSendMarker | null {
  const to = extractEmailAddress(msg.from);
  if (!to) return null;
  const subject = normalizeReplySubject(typeof msg.subject === 'string' ? msg.subject : '');
  const parent =
    typeof msg.id === 'string' && msg.id.length > 0
      ? msg.id
      : typeof msg.message_id === 'string' && msg.message_id.length > 0
        ? msg.message_id
        : undefined;
  return {
    to,
    subject,
    body: body.trim(),
    ...(parent ? { in_reply_to_message_id: parent } : {}),
  };
}

function extractEmailAddress(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const m = raw.match(/<([^>]+)>/);
  const candidate = (m ? m[1] : raw).trim();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(candidate) ? candidate : '';
}

function normalizeReplySubject(subject: string): string {
  const s = subject.trim() || '(no subject)';
  return /^\s*re\s*:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * Pull `inbox_id` out of the webhook envelope. AgentMail payload format
 * (https://docs.agentmail.to/events): `inbox_id` lives at
 * `event.message.inbox_id`, not `event.data.inbox_id` (earlier code was
 * an unverified fixture, fixed 2026-05-25 with the consumer drift).
 * Accepts both snake_case and camelCase since serialization can vary.
 */
function extractInboxId(event: AgentMailDispatchContext['event']): string {
  const eventObj = (event && typeof event === 'object' ? event : null) as
    | { message?: { inbox_id?: unknown; inboxId?: unknown } }
    | null;
  const msg = eventObj?.message;
  if (!msg) return '';
  for (const k of ['inbox_id', 'inboxId'] as const) {
    const v = (msg as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

async function fetchAgentMailThread(
  env: AgentMailDispatchContext['env'],
  inboxId: string,
  threadId: string,
): Promise<AgentMailThread> {
  if (!env.AGENTMAIL_API_KEY) {
    throw new Error('no_agentmail_api_key');
  }
  const baseUrl = (env.AGENTMAIL_API_BASE_URL ?? 'https://api.agentmail.to/v0').replace(/\/$/, '');
  const url = `${baseUrl}/inboxes/${encodeURIComponent(inboxId)}/threads/${encodeURIComponent(threadId)}`;
  assertBridgeEgressAllowed(url, 'agentmail-dispatch:signalB');
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${env.AGENTMAIL_API_KEY}`,
      accept: 'application/json',
    },
  });
  if (!resp.ok) {
    throw new Error(`AgentMail thread fetch failed: ${resp.status}`);
  }
  const text = await resp.text();
  return text.length === 0 ? {} : (JSON.parse(text) as AgentMailThread);
}

async function findSessionInThreadHistory(
  db: D1Database,
  messages: AgentMailMessage[],
): Promise<{ sessionId: string; agentId: string } | null> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    const refs = extractThreadRefs(msg);
    const candidates = [
      ...(typeof msg.message_id === 'string' ? [msg.message_id] : []),
      ...(typeof msg.rfc822_message_id === 'string' ? [msg.rfc822_message_id] : []),
      ...refs.references,
    ];
    for (const candidate of candidates) {
      const found = await findSessionByRfc822MessageId(db, envNormalizeMessageId(candidate));
      if (found) return found;
    }
  }
  return null;
}

async function resolveDefaultMailOwner(
  env: AgentMailDispatchContext['env'],
): Promise<{
  userSlug: string;
  agentId: string;
  resources: MemoryStoreResourceParam[];
} | null> {
  const r = await readUserMappingWithDefault(env.MAKOTO_KV, '', env.DEFAULT_USER_SLUG);
  if (!r) return null;
  return {
    userSlug: r.mapping.user_slug,
    agentId: r.mapping.agent_id,
    resources: r.mapping.memory_attachments.map(toResourceParam),
  };
}

function envNormalizeMessageId(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  return s.toLowerCase();
}

/**
 * Post an inbound `📨` notification to `env.MAKOTO_NOTIFY_SPACE`. Used
 * by the cold-inbound notify-only path (#186 #2). Failure is logged
 * but never bubbled — the inbound is already committed at this point
 * and we don't want a transient Chat outage to retry the bridge.
 */
async function tryNotifyInbound(
  env: AgentMailDispatchContext['env'],
  message: AgentMailMessage,
  isContinuation: boolean,
  eventKey: string,
): Promise<void> {
  const notifySpace = env.MAKOTO_NOTIFY_SPACE;
  const saKeyJson = env.CHAT_SA_KEY_JSON;
  if (!notifySpace || !saKeyJson) return; // gated by caller, but be safe.
  const text = buildInboundNotificationText(
    {
      from: typeof message.from === 'string' ? message.from : '',
      subject: typeof message.subject === 'string' ? message.subject : '',
      body: extractBody(message),
    },
    isContinuation,
  );
  try {
    await postChatMessage({ saKeyJson }, notifySpace, text);
    console.log(
      `[agentmail-dispatch] notify_posted eventKey=${eventKey} kind=${isContinuation ? 'continuation' : 'cold'}`,
    );
  } catch (err) {
    const reason =
      err instanceof ChatApiError
        ? `chat_api_${err.status}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.warn(
      `[agentmail-dispatch] notify_failed eventKey=${eventKey} kind=${isContinuation ? 'continuation' : 'cold'} reason=${reason}`,
    );
  }
}

/**
 * Post a continuation auto-reply `📤` confirmation to
 * `env.MAKOTO_NOTIFY_SPACE` after the outbound mail was accepted by
 * AgentMail. Failure is logged but never bubbled — the outbound mail
 * already shipped, so we keep `committed` (= mirrors Cloud Run
 * `AUTO_REPLIED` terminal state, l.2025).
 */
async function tryNotifyAutoreplyForInbound(
  env: AgentMailDispatchContext['env'],
  message: AgentMailMessage,
  replyText: string,
  eventKey: string,
): Promise<void> {
  const notifySpace = env.MAKOTO_NOTIFY_SPACE;
  const saKeyJson = env.CHAT_SA_KEY_JSON;
  if (!notifySpace || !saKeyJson) return; // gated by caller, but be safe.
  const text = buildAutoreplyNotificationText(
    {
      from: typeof message.from === 'string' ? message.from : '',
      subject: typeof message.subject === 'string' ? message.subject : '',
      body: extractBody(message),
    },
    replyText,
  );
  try {
    await postChatMessage({ saKeyJson }, notifySpace, text);
    console.log(
      `[agentmail-dispatch] autoreply_notify_posted eventKey=${eventKey}`,
    );
  } catch (err) {
    const reason =
      err instanceof ChatApiError
        ? `chat_api_${err.status}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.warn(
      `[agentmail-dispatch] autoreply_notify_failed eventKey=${eventKey} reason=${reason}`,
    );
  }
}

// Re-export the outcome type so callers can stay narrow.
export type { AgentMailDispatchOutcome };
