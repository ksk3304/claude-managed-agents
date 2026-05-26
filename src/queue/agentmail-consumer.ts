/**
 * Cloudflare Queues consumer for the AgentMail bridge.
 *
 * Bound via `wrangler.jsonc` `queues.consumers[].queue = "<queue>"`.
 * The webhook handler verifies + transport-dedupes + enqueues each
 * delivery; this consumer does the long-running work that does not fit
 * in the Workers HTTP request budget (= session create, event-stream
 * drain, EMAIL_SEND parse, AgentMail send, dedupe commit).
 *
 * Per-message lifecycle:
 *
 *   1. Pull the `AgentMailMessage` out of the webhook envelope.
 *      No `message.received` payload (control events etc.) → ack-skip.
 *      No RFC 822 Message-ID → ack-skip (can't dedupe, can't thread).
 *
 *   2. `tryClaim` on `mail:msgid:<rfc822>`:
 *        DONE_DUPLICATE / LEASE_ALIVE → ack-skip (idempotent).
 *        NEW / TAKEOVER → caller becomes the owner with `version`.
 *
 *   3. Acquire the per-thread DO lock. The D1 fence guards double-
 *      commit; this lock guards in-flight overlap (two consumers
 *      racing to call `sessions.create` + `AgentMail.send` for the
 *      same RFC 822 message).
 *
 *   4. Hand off to `dispatchAgentMailEvent` (layer 7 — body lives in
 *      a separate module so the queue framing here stays thin). The
 *      dispatcher returns one of:
 *        - `committed`         → consumer calls `commitDone`.
 *        - `skipped`           → consumer calls `commitDone` so the
 *                                queue stops redelivering.
 *        - `release_and_retry` → consumer calls `releaseClaim` and
 *                                throws so Queues retries.
 *
 *   5. Release the DO lock (always — `finally`).
 *
 *   6. `msg.ack()` on success, `msg.retry()` on error.
 *
 * The dispatcher MUST `confirmOwner` immediately before any AgentMail
 * send — between the start of the run and the send call the lease may
 * have expired and a successor may have taken over. The dedupe module
 * exports `confirmOwner` exactly for that re-check.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 7 — 層 5)
 * Spec: plan-draft.md §step 7 + §step 9 (layer 7 dispatch body) + C10
 */

import {
  commitDone,
  eventKeyForRfc822,
  newClaimOwner,
  releaseClaim,
  tryClaim,
} from '../lib/dedupe';
import { redactPiiInText } from '../redact/pii';
import { extractInboundRfc822MessageId } from '../lib/email-thread';
import {
  classifyInboundMail,
  type InboundClassification,
} from '../lib/agentmail-classification';
import { getThreadLock, type ThreadLockStub } from '../durable-objects/thread-lock';
import type { AgentMailMessage, AgentMailWebhookEvent } from '../types/agentmail';
import type { AgentMailQueueMessage } from '../webhooks/agentmail';

const LEASE_TTL_MS = 5 * 60 * 1000;
const LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * Everything the dispatcher needs from the framing layer. Kept narrow
 * so layer 7 (the real session/tool dispatch) can stay independent of
 * how queue framing evolves.
 */
export interface AgentMailDispatchContext {
  env: Env;
  ctx: ExecutionContext;
  /** Raw webhook event JSON parsed at webhook time. */
  event: AgentMailWebhookEvent<unknown>;
  /** Extracted inbound message — never null when the dispatcher runs. */
  message: AgentMailMessage;
  /** Already-normalized RFC 822 message id (no angle brackets, lowercase). */
  rfc822MsgId: string;
  /** Claim handle — the dispatcher uses `confirmOwner` against these. */
  claim: { owner: string; version: number };
  /** DO lock stub — dispatchers can extend the lock if they need to. */
  threadLock: ThreadLockStub;
  /** Event key the framing layer uses for commit / release. */
  eventKey: string;
  /**
   * Header-only continuation / cold-inbound classification computed by
   * the framing layer (Issue #186 G). Dispatchers may **refine** this
   * verdict after a `findSessionByRfc822MessageId` D1 lookup — the
   * framing pass cannot reach D1, so a strong `continuation` result
   * from this field still requires a DB-confirmed match to advance to
   * the auto-reply path. A `cold` verdict from a `re_chain_exceeded`
   * demotion (`classification.demotedReason === 're_chain_exceeded'`)
   * should be treated as a hard veto on auto-reply even if D1
   * confirms the thread.
   */
  classification: InboundClassification;
}

export type AgentMailDispatchOutcome =
  | { kind: 'committed' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'release_and_retry'; reason: string };

/**
 * Pluggable dispatcher. Layer 7 will swap in the real implementation
 * (= session creation, event-stream drain, EMAIL_SEND, AgentMail send).
 * The framing layer uses this single seam so unit tests can inject a
 * fake dispatcher and the layer-5 commit pipeline can be verified
 * independent of the heavy session machinery.
 */
export type AgentMailDispatcher = (
  context: AgentMailDispatchContext,
) => Promise<AgentMailDispatchOutcome>;

/**
 * Default layer-5 stub. Marks the message as committed so we don't
 * loop while layer 7 is still being built. Pre-cutover this is safe —
 * no AgentMail send happens, the consumer just records that it saw
 * the event. Integration tests at layer 9 replace this with the real
 * dispatcher.
 */
export const defaultDispatcher: AgentMailDispatcher = async (_context) => {
  return { kind: 'committed' };
};

/**
 * Single-message handler. Public for tests; the queue() entrypoint
 * iterates a batch and calls this with one message at a time.
 */
export async function handleAgentMailMessage(
  env: Env,
  ctx: ExecutionContext,
  body: AgentMailQueueMessage,
  dispatcher: AgentMailDispatcher = defaultDispatcher,
): Promise<void> {
  const event = body.event;

  // Step 1. Pull the inbound message and its RFC 822 Message-ID.
  // AgentMail webhook payload format (verified 2026-05-25 against
  // https://docs.agentmail.to/events): `{ type: "event", event_type:
  // "message.received" | ..., event_id, message: {...}, thread: {...} }`
  // — `message` is at the event root, NOT under `data.message`. The
  // earlier `data.message` assumption was an unverified fixture
  // (Issue #186 cutover bug, fixed 2026-05-25).
  const eventObj = (event && typeof event === 'object' ? event : null) as
    | { event_type?: string; type?: string; message?: AgentMailMessage }
    | null;
  const eventType = eventObj?.event_type ?? eventObj?.type;
  const inboundMessage = eventObj?.message;
  if (!inboundMessage) {
    console.log(
      `[agentmail-consumer] skip svixId=${body.svix_id} type=${eventType} reason=no-message-payload`,
    );
    return;
  }
  const rfc822 = extractInboundRfc822MessageId(inboundMessage);
  if (!rfc822) {
    console.log(
      `[agentmail-consumer] skip svixId=${body.svix_id} type=${eventType} reason=no-rfc822-msgid`,
    );
    return;
  }

  const eventKey = eventKeyForRfc822(rfc822);
  const owner = newClaimOwner(env.WORKER_INSTANCE_ID ?? '');

  // Step 1b. Header-only continuation / cold classification (Issue
  // #186 G). The framing layer cannot reach D1, so we pass an empty
  // `knownOutboundMessageIds` set — the dispatcher can still upgrade a
  // `cold` verdict to `continuation` after its
  // `findSessionByRfc822MessageId` lookup. What this pass *does* catch
  // up front: `re_chain_exceeded` runaway threads (`Re:` chain >= 5
  // demotes to cold even if D1 would confirm the thread) and pure-
  // header signals that survive serialization to the dispatch context.
  const classification = classifyInboundMail(inboundMessage);
  console.log(
    `[agentmail-consumer] classify svixId=${body.svix_id} rfc822=${rfc822} kind=${classification.kind} confidence=${classification.confidence.toFixed(2)} signals=${classification.signals.join('|')}${
      classification.demotedReason ? ` demoted=${classification.demotedReason}` : ''
    }`,
  );

  // Step 2. Claim.
  const claim = await tryClaim(env.DB, eventKey, owner, {
    leaseTtlMs: LEASE_TTL_MS,
  });
  if (claim.state === 'DONE_DUPLICATE' || claim.state === 'LEASE_ALIVE') {
    console.log(
      `[agentmail-consumer] skip svixId=${body.svix_id} rfc822=${rfc822} reason=${claim.state}`,
    );
    return;
  }
  if (claim.state !== 'NEW' && claim.state !== 'TAKEOVER') {
    console.error(
      `[agentmail-consumer] unexpected-claim-state svixId=${body.svix_id} rfc822=${rfc822} state=${claim.state}`,
    );
    return;
  }
  // NEW / TAKEOVER both populate owner + version.
  const claimVersion = claim.version as number;

  // Step 3. DO lock.
  const threadLock = getThreadLock(env, eventKey);
  const acquireResult = await threadLock.acquire(eventKey, LOCK_TTL_MS);
  if (!acquireResult.acquired) {
    // Another consumer is in-flight on the same key. Release our claim
    // so the holder can commit cleanly, then signal Queues to retry
    // after the holder's lease (= worst case 5 min).
    console.log(
      `[agentmail-consumer] retry-lock-held svixId=${body.svix_id} rfc822=${rfc822} retry_after_ms=${acquireResult.retry_after_ms}`,
    );
    await releaseClaim(env.DB, eventKey, owner, claimVersion);
    throw new Error(
      `thread lock held for rfc822=${rfc822}; queue will retry`,
    );
  }

  // Step 4. Dispatch.
  try {
    const outcome = await dispatcher({
      env,
      ctx,
      event,
      message: inboundMessage,
      rfc822MsgId: rfc822,
      claim: { owner, version: claimVersion },
      threadLock,
      eventKey,
      classification,
    });

    if (outcome.kind === 'committed') {
      const ok = await commitDone(env.DB, eventKey, owner, claimVersion);
      if (!ok) {
        // Fence drift — our owner/version no longer matches. The
        // successor (TAKEOVER) will commit on its own run. Log loud.
        console.warn(
          `[agentmail-consumer] commit-fence-drift svixId=${body.svix_id} rfc822=${rfc822}`,
        );
      }
    } else if (outcome.kind === 'skipped') {
      console.log(
        `[agentmail-consumer] dispatch-skipped svixId=${body.svix_id} rfc822=${rfc822} reason=${outcome.reason}`,
      );
      // Even on skip we commit so AgentMail / Queues don't redeliver.
      // (If the skip reason is "transient please retry", the dispatcher
      // should return `release_and_retry` instead.)
      await commitDone(env.DB, eventKey, owner, claimVersion);
    } else {
      // release_and_retry — release the claim and throw so Queues
      // retries. The successor's `tryClaim` will hit TAKEOVER once
      // the lease we released has expired (`releaseClaim` zeroes it).
      console.warn(
        `[agentmail-consumer] release-and-retry svixId=${body.svix_id} rfc822=${rfc822} reason=${outcome.reason}`,
      );
      await releaseClaim(env.DB, eventKey, owner, claimVersion);
      throw new Error(`dispatch requested retry: ${outcome.reason}`);
    }
  } catch (error) {
    // Don't leave a poisoned lease — release on throw so a successor
    // can take over immediately. Re-throw so the queue framing retries.
    await releaseClaim(env.DB, eventKey, owner, claimVersion);
    throw error;
  } finally {
    // Step 5. Always release the in-memory DO lock.
    await threadLock.release(eventKey);
  }
}

/**
 * Cloudflare Queues consumer entrypoint. Wired through `src/index.ts`
 * → `queue()` export.
 *
 * On per-message error we call `msg.retry()` instead of `msg.ack()` so
 * Queues redelivers. The dedupe state machine (TAKEOVER on the same
 * event_key once our lease expires) catches the duplicate on the retry.
 */
export async function handleAgentMailQueue(
  batch: MessageBatch<AgentMailQueueMessage>,
  env: Env,
  ctx: ExecutionContext,
  dispatcher: AgentMailDispatcher = defaultDispatcher,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await handleAgentMailMessage(env, ctx, msg.body, dispatcher);
      msg.ack();
    } catch (error) {
      // Scrub PII from the error message before logging — downstream throws
      // can quote sender/recipient emails from upstream SDK errors
      // (Issue #186 D コンプラ対応).
      console.error(
        `[agentmail-consumer] retry svixId=${msg.body?.svix_id}: ${redactPiiInText(error instanceof Error ? error.message : String(error))}`,
      );
      msg.retry();
    }
  }
}
