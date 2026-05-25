/**
 * AgentMail inbound webhook handler.
 *
 * Receives a single AgentMail webhook delivery (svix protocol), verifies
 * the signature against the primary/secondary secret pair, transport-
 * dedupes by svix-id, enqueues the event to Cloudflare Queues for the
 * Queue consumer to do the heavy work, and returns 200.
 *
 * Design constraints driving this split (Codex 1 周目 must-fix #2 解決,
 * plan-draft v3 R6):
 *   - Workers HTTP request CPU budget caps at ~30 s with paid plans and
 *     `waitUntil` cancels its tail at 30 s. A 60-120 s agent run cannot
 *     live in this handler.
 *   - Cloudflare Queues consumers have a 15-minute wall budget and a
 *     5-minute CPU budget — exactly the window we need for an agent
 *     session, EMAIL_SEND parsing, AgentMail REST send, and the dedupe
 *     commit dance.
 * So this handler stays small: verify, transport-dedupe, enqueue.
 *
 * Header contract (different from `src/webhooks.ts`, which serves the
 * Anthropic Standard Webhooks path):
 *   - `svix-id`         — unique delivery id; also dedupe key.
 *   - `svix-timestamp`  — unix seconds; rejected if older than 5 minutes.
 *   - `svix-signature`  — space-separated `v1,<base64-hmac>` entries.
 * Signed string is `${svix-id}.${svix-timestamp}.${rawBody}` HMAC-SHA256.
 *
 * Secret rotation is supported via the primary/secondary fallback —
 * matches the Python `verify_webhook` behaviour in
 * `scripts/cma_agentmail_inbound.py:2165-2201`.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 7 — 層 5)
 * Spec: plan-draft.md §step 7 + completion-conditions C1
 */

import { bytesToBase64 } from '../helpers';
import { markAgentMailWebhookSeen } from '../storage';
import type { AgentMailWebhookEvent } from '../types/agentmail';

const TOLERANCE_SECONDS = 300;

/**
 * Cloudflare Queue payload — what the webhook handler enqueues for the
 * consumer to pick up. Kept JSON-serializable (Queues uses structured
 * cloning under the hood).
 */
export interface AgentMailQueueMessage {
  svix_id: string;
  received_at_ms: number;
  event: AgentMailWebhookEvent<unknown>;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Decode a webhook signing secret.
 *   - `whsec_<base64>`: svix-issued form — strip the prefix, base64-decode.
 *   - Bare base64 (no prefix): try base64-decode first.
 *   - Anything else: treat as raw UTF-8 bytes.
 *
 * Matches `verifyStandardWebhook` in `src/webhooks.ts` so secrets can be
 * managed the same way across both webhook paths.
 */
function decodeSecret(secret: string): Uint8Array {
  if (secret.startsWith('whsec_')) {
    return base64ToBytes(secret.slice('whsec_'.length));
  }
  try {
    return base64ToBytes(secret);
  } catch {
    return new TextEncoder().encode(secret);
  }
}

/**
 * Verify the svix signature against any of the candidate secrets. Used
 * to support primary→secondary rotation: list `[primary, secondary]` and
 * accept on first match.
 *
 * Returns false on:
 *   - non-numeric `svix-timestamp`,
 *   - timestamp skew > 5 minutes (replay defence),
 *   - no `v1,*` entry in the signature header matching any secret.
 */
export async function verifySvixSignature(
  signatureHeader: string,
  svixId: string,
  svixTimestamp: string,
  rawBody: ArrayBuffer,
  secrets: string[],
): Promise<boolean> {
  const ts = Number.parseInt(svixTimestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) return false;

  const encoder = new TextEncoder();
  const prefix = encoder.encode(`${svixId}.${svixTimestamp}.`);
  const body = new Uint8Array(rawBody);
  const signedInput = new Uint8Array(prefix.length + body.length);
  signedInput.set(prefix, 0);
  signedInput.set(body, prefix.length);

  for (const secret of secrets) {
    if (!secret) continue;
    let keyBytes: Uint8Array;
    try {
      keyBytes = decodeSecret(secret);
    } catch {
      continue;
    }
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, signedInput);
    const expected = bytesToBase64(new Uint8Array(mac));
    for (const sig of signatureHeader.split(' ')) {
      const [ver, mac64] = sig.split(',', 2);
      if (ver !== 'v1' || !mac64) continue;
      if (constantTimeEq(mac64, expected)) return true;
    }
  }
  return false;
}

/**
 * Public entrypoint — wired into `src/index.ts` for the
 * `POST /webhooks/agentmail` route.
 *
 * State machine (numbered in the same order as the response branches
 * below so they line up with logs):
 *   1. Missing headers       → 401 (no body read)
 *   2. Misconfigured server  → 500 (no primary secret)
 *   3. Invalid signature     → 401 (after body read for HMAC)
 *   4. Stale timestamp (>5m) → 401 (rejected inside `verifySvixSignature`)
 *   5. Duplicate svix-id     → 200 + `{status: "duplicate"}` (ack to stop
 *                                    AgentMail's retry loop; consumer
 *                                    already processed this event)
 *   6. JSON parse failure    → 400 (won't help to retry)
 *   7. Queue enqueue OK      → 200 + `{status: "enqueued"}` (consumer
 *                                    takes over from here)
 *   8. Queue enqueue fails   → 500 (AgentMail will retry; transport
 *                                    seen-flag may or may not have been
 *                                    written — see notes below).
 */
export async function handleAgentMailWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const cfRay = request.headers.get('cf-ray') || 'unknown';
  const svixId = request.headers.get('svix-id');
  const svixTimestamp = request.headers.get('svix-timestamp');
  const svixSignature = request.headers.get('svix-signature');

  // 1. Missing headers
  if (!svixId || !svixTimestamp || !svixSignature) {
    const headerNames = Array.from(request.headers.keys()).join(',');
    console.warn(
      `[agentmail-webhook] reject missing-svix-headers cfRay=${cfRay} headers=${headerNames}`,
    );
    return Response.json(
      { error: 'missing svix signature headers' },
      { status: 401 },
    );
  }

  // 2. Server misconfigured (no primary secret)
  const primary = env.WEBHOOK_SECRET_AGENTMAIL_PRIMARY;
  const secondary = env.WEBHOOK_SECRET_AGENTMAIL_SECONDARY;
  const secrets = [primary, secondary].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  if (secrets.length === 0) {
    console.error(
      `[agentmail-webhook] reject no-primary-secret cfRay=${cfRay} svixId=${svixId}`,
    );
    return Response.json(
      { error: 'webhook secret not configured' },
      { status: 500 },
    );
  }

  const rawBody = await request.arrayBuffer();

  // 3. + 4. Verify signature (also rejects stale timestamps)
  const valid = await verifySvixSignature(
    svixSignature,
    svixId,
    svixTimestamp,
    rawBody,
    secrets,
  );
  if (!valid) {
    console.warn(
      `[agentmail-webhook] reject invalid-signature cfRay=${cfRay} svixId=${svixId} bytes=${rawBody.byteLength}`,
    );
    return Response.json({ error: 'invalid signature' }, { status: 401 });
  }

  // 6. Parse body (verified content; JSON failure means malformed payload
  //    that retrying won't fix).
  let event: AgentMailWebhookEvent<unknown>;
  try {
    event = JSON.parse(new TextDecoder().decode(rawBody)) as AgentMailWebhookEvent<unknown>;
  } catch {
    console.warn(
      `[agentmail-webhook] reject invalid-json cfRay=${cfRay} svixId=${svixId}`,
    );
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }

  // 5. Transport-level dedupe. Doing this AFTER signature verification
  //    keeps unsigned probes from polluting the seen-set. INSERT-OR-IGNORE
  //    is atomic so parallel deliveries to two Workers cannot both treat
  //    themselves as first-sight.
  const firstSight = await markAgentMailWebhookSeen(env.DB, svixId);
  if (!firstSight) {
    console.log(
      `[agentmail-webhook] transport-dedupe-duplicate svixId=${svixId} cfRay=${cfRay}`,
    );
    return Response.json({ status: 'duplicate' });
  }

  // 7. + 8. Enqueue for the consumer. If enqueue throws we return 500 so
  //    AgentMail retries; the consumer-side dedupe (`tryClaim` on the
  //    RFC 822 Message-ID) catches any duplicates that result from a
  //    retry landing on the same RFC 822 message via a different svix-id.
  const message: AgentMailQueueMessage = {
    svix_id: svixId,
    received_at_ms: Date.now(),
    event,
  };
  try {
    await env.MAKOTO_QUEUE.send(message);
  } catch (error) {
    console.error(
      `[agentmail-webhook] enqueue-failed svixId=${svixId} cfRay=${cfRay}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return Response.json({ error: 'enqueue failed' }, { status: 500 });
  }

  console.log(
    `[agentmail-webhook] enqueued svixId=${svixId} type=${event?.type} cfRay=${cfRay} bytes=${rawBody.byteLength}`,
  );
  return Response.json({ status: 'enqueued' });
}
