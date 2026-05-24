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
 * to seed `buildContinuationPrompt`) is NOT implemented in this layer.
 * `buildContinuationPrompt(inbound, [])` is passed an empty history
 * for now — the agent gets only the most-recent inbound, plus the
 * persona's own memory. A follow-up issue tracks history population
 * from D1 / AgentMail `listMessages`.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 — 層 7-2 dispatch body + 層 7-3 wire-up)
 * Spec: plan-draft.md §step 9 dispatch + impl-mid-3 §3.2 案 B
 */

import { AgentMailClient, AgentMailError } from '../lib/agentmail-api';
import { confirmOwner } from '../lib/dedupe';
import {
  buildContinuationPrompt,
  CONTINUATION_REPLY_SYSTEM_ADDENDUM,
} from '../lib/continuation';
import { extractBody, extractThreadRefs, reChainDepth } from '../lib/email-thread';
import { parseAssistantText } from '../lib/email-send-marker';
import { resolveSenderToResources } from '../lib/memory-attach';
import {
  buildAnthropicClient,
  createSessionWithResources,
  sendAndStreamWithToolDispatch,
} from '../lib/session';
import { scrubInternalStateForChat } from '../redact/internal-state';
import { findSessionByRfc822MessageId, recordSentMessage } from '../storage';
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
  // 1. Sender resolution.
  const { env, event, message, rfc822MsgId, claim, eventKey } = context;
  const sender = typeof message.from === 'string' ? message.from : '';
  if (!sender) {
    return { kind: 'skipped', reason: 'no_sender' };
  }
  const resolution = await resolveSenderToResources(env.MAKOTO_KV, sender);
  if (!resolution) {
    return { kind: 'skipped', reason: 'unknown_sender' };
  }
  const { user_slug: userSlug, agent_id: agentId, resources } = resolution;

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

  // 3. Thread resolve via In-Reply-To / References. The references
  // array is oldest-first; we scan in reverse so the most-recent
  // ancestor matches first (= least chance of routing into a
  // long-stale session).
  const refs = extractThreadRefs(message);
  let sessionId: string | null = null;
  for (let i = refs.references.length - 1; i >= 0; i--) {
    const candidate = refs.references[i];
    if (!candidate) continue;
    const found = await findSessionByRfc822MessageId(env.DB, candidate);
    if (found && found.agentId === agentId) {
      sessionId = found.sessionId;
      break;
    }
  }

  // 4. Continuation vs first-contact branch.
  const isContinuation = sessionId !== null || reChainDepth(message.subject) >= 1;
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
    userMessage = buildInitialUserMessage(message, isContinuation);
  } else {
    // Existing session — use the continuation prompt with empty
    // history for now (thread-history fetch is a follow-up).
    userMessage = `${CONTINUATION_REPLY_SYSTEM_ADDENDUM}\n\n${buildContinuationPrompt(message, [])}`;
    console.log(
      `[agentmail-dispatch] continuing session=${sessionId} agent=${agentId} user=${userSlug} eventKey=${eventKey}`,
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
  const { markers, failures, cleanedText } = parseAssistantText(streamResult.assistantText);
  if (failures.length > 0) {
    for (const f of failures) {
      console.warn(
        `[agentmail-dispatch] EMAIL_SEND parse failure eventKey=${eventKey} reason=${f.reason} raw=${f.raw.slice(0, 200)}`,
      );
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
  const parentMessageId = typeof message.id === 'string' ? message.id : '';

  for (const m of markers) {
    try {
      const sendResult = await deliverMarker(amClient, m, {
        inboxId,
        parentMessageIdFallback: parentMessageId,
        agentId,
        sessionId,
        jobId: `mail-send/${sessionId}`,
      });
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
        );
      }
    } catch (err) {
      if (err instanceof AgentMailError && err.transient) {
        console.error(
          `[agentmail-dispatch] AgentMail transient eventKey=${eventKey} marker_to=${m.to}: ${err.message}`,
        );
        return { kind: 'release_and_retry', reason: 'agentmail_transient' };
      }
      console.error(
        `[agentmail-dispatch] AgentMail send failed eventKey=${eventKey} marker_to=${m.to}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Non-transient send failure: skip rather than loop. The dedupe
      // row commits so the queue stops redelivering. Manual audit
      // recovers anything we couldn't deliver.
      return { kind: 'skipped', reason: 'agentmail_permanent_failure' };
    }
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

/**
 * Pull `data.inbox_id` out of the webhook envelope, accepting both
 * snake_case and camelCase since AgentMail's serialization is not
 * always consistent. Returns empty string when absent.
 */
function extractInboxId(event: AgentMailDispatchContext['event']): string {
  const data = (event && typeof event === 'object' ? event.data : null) as
    | { inbox_id?: unknown; inboxId?: unknown }
    | null;
  if (!data) return '';
  for (const k of ['inbox_id', 'inboxId'] as const) {
    const v = data[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

// Re-export the outcome type so callers can stay narrow.
export type { AgentMailDispatchOutcome };
