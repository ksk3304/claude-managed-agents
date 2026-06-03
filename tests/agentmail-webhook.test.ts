/**
 * Unit tests for `src/webhooks/agentmail.ts` — svix verify + transport
 * dedupe + Queue enqueue.
 */

import { describe, it, expect } from 'vitest';
import {
  handleAgentMailWebhook,
  verifySvixSignature,
  type AgentMailQueueMessage,
} from '../src/webhooks/agentmail';
import {
  makeFakeQueue,
  makeMakotoDb,
  svixSign,
} from './makoto-helpers';

const PRIMARY = 'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function envWith(overrides: Partial<Env> = {}): Env {
  const db = makeMakotoDb();
  const queue = makeFakeQueue<AgentMailQueueMessage>();
  return {
    DB: db,
    MAKOTO_QUEUE: queue,
    WEBHOOK_SECRET_AGENTMAIL_PRIMARY: PRIMARY,
    ...overrides,
  } as unknown as Env;
}

function buildRequest(
  body: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
): Request {
  return new Request('https://test.workers.dev/webhooks/agentmail', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    },
  });
}

async function signedRequest(body: string, secret = PRIMARY) {
  const svixId = `msg_${crypto.randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const signature = await svixSign(secret, svixId, svixTimestamp, body);
  return { req: buildRequest(body, svixId, svixTimestamp, signature), svixId };
}

describe('verifySvixSignature', () => {
  it('returns true for a correctly signed payload', async () => {
    const body = '{"id":"x","type":"message.received","timestamp":"2026-01-01","data":{}}';
    const svixId = 'msg_1';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await svixSign(PRIMARY, svixId, ts, body);
    const ok = await verifySvixSignature(sig, svixId, ts, new TextEncoder().encode(body).buffer, [
      PRIMARY,
    ]);
    expect(ok).toBe(true);
  });

  it('returns false for a stale timestamp (> 5 minutes)', async () => {
    const body = '{}';
    const svixId = 'msg_1';
    const staleTs = String(Math.floor(Date.now() / 1000) - 1000);
    const sig = await svixSign(PRIMARY, svixId, staleTs, body);
    const ok = await verifySvixSignature(sig, svixId, staleTs, new TextEncoder().encode(body).buffer, [
      PRIMARY,
    ]);
    expect(ok).toBe(false);
  });

  it('returns false for an invalid signature', async () => {
    const body = '{}';
    const svixId = 'msg_1';
    const ts = String(Math.floor(Date.now() / 1000));
    const ok = await verifySvixSignature('v1,not-base64-mac', svixId, ts, new TextEncoder().encode(body).buffer, [
      PRIMARY,
    ]);
    expect(ok).toBe(false);
  });

  it('falls back to secondary secret', async () => {
    const SECONDARY = 'whsec_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=';
    const body = '{}';
    const svixId = 'msg_1';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await svixSign(SECONDARY, svixId, ts, body);
    const ok = await verifySvixSignature(sig, svixId, ts, new TextEncoder().encode(body).buffer, [
      PRIMARY,
      SECONDARY,
    ]);
    expect(ok).toBe(true);
  });
});

describe('handleAgentMailWebhook', () => {
  it('rejects 401 on missing svix headers', async () => {
    const env = envWith();
    const req = new Request('https://x/webhooks/agentmail', { method: 'POST', body: '{}' });
    const resp = await handleAgentMailWebhook(req, env);
    expect(resp.status).toBe(401);
  });

  it('rejects 500 when no primary secret is configured', async () => {
    const env = envWith({ WEBHOOK_SECRET_AGENTMAIL_PRIMARY: undefined as unknown as string });
    const { req } = await signedRequest('{}');
    const resp = await handleAgentMailWebhook(req, env);
    expect(resp.status).toBe(500);
  });

  it('rejects 401 on invalid signature', async () => {
    const env = envWith();
    const svixId = 'msg_1';
    const ts = String(Math.floor(Date.now() / 1000));
    const req = buildRequest('{"id":"x","type":"t","timestamp":"x","data":{}}', svixId, ts, 'v1,xxxx');
    const resp = await handleAgentMailWebhook(req, env);
    expect(resp.status).toBe(401);
  });

  it('200 + enqueues on signed body', async () => {
    const env = envWith();
    const body = '{"id":"evt-1","type":"message.received","timestamp":"x","data":{}}';
    const { req, svixId } = await signedRequest(body);
    const resp = await handleAgentMailWebhook(req, env);
    expect(resp.status).toBe(200);
    const sent = (env.MAKOTO_QUEUE as unknown as { _sent: AgentMailQueueMessage[] })._sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.svix_id).toBe(svixId);
  });

  it('200 + enqueues signed spam receive events', async () => {
    const env = envWith();
    const body = '{"id":"evt-spam","type":"event","event_type":"message.received.spam","timestamp":"x","message":{"id":"msg_spam","message_id":"<spam@example.com>"}}';
    const { req, svixId } = await signedRequest(body);
    const resp = await handleAgentMailWebhook(req, env);
    expect(resp.status).toBe(200);
    const sent = (env.MAKOTO_QUEUE as unknown as { _sent: AgentMailQueueMessage[] })._sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.svix_id).toBe(svixId);
    expect(
      (sent[0]!.event as unknown as { event_type?: string }).event_type,
    ).toBe('message.received.spam');
  });

  it('transport-dedupes by svix-id (second delivery is duplicate)', async () => {
    const env = envWith();
    const body = '{"id":"evt-1","type":"t","timestamp":"x","data":{}}';
    const { req } = await signedRequest(body);
    await handleAgentMailWebhook(req, env);

    // Second delivery with the same svix-id (rebuild the same request).
    const svixId = req.headers.get('svix-id')!;
    const ts = req.headers.get('svix-timestamp')!;
    const sig = req.headers.get('svix-signature')!;
    const req2 = buildRequest(body, svixId, ts, sig);
    const resp2 = await handleAgentMailWebhook(req2, env);
    expect(resp2.status).toBe(200);
    const json = (await resp2.json()) as { status: string };
    expect(json.status).toBe('duplicate');
    // Should not have enqueued a second time.
    const sent = (env.MAKOTO_QUEUE as unknown as { _sent: AgentMailQueueMessage[] })._sent;
    expect(sent).toHaveLength(1);
  });

  it('rejects 400 on invalid JSON body', async () => {
    const env = envWith();
    const { req } = await signedRequest('not json');
    const resp = await handleAgentMailWebhook(req, env);
    expect(resp.status).toBe(400);
  });
});
