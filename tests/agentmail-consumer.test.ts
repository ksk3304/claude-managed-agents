/**
 * Unit tests for `src/queue/agentmail-consumer.ts` — layer 5 framing
 * (claim / DO lock / dispatch outcome / commit).
 *
 * Drives the consumer with a fake `AgentMailDispatcher` so we can
 * verify each `committed` / `skipped` / `release_and_retry` branch
 * independently of the heavy layer-7 body.
 */

import { describe, it, expect } from 'vitest';
import {
  handleAgentMailMessage,
  defaultDispatcher,
  type AgentMailDispatcher,
} from '../src/queue/agentmail-consumer';
import type { AgentMailQueueMessage } from '../src/webhooks/agentmail';
import { commitDone, eventKeyForRfc822, tryClaim } from '../src/lib/dedupe';
import {
  makeFakeThreadLockNamespace,
  makeMakotoDb,
} from './makoto-helpers';

const INBOUND = {
  id: 'msg_in',
  from: 'a@x',
  subject: 'hi',
  rfc822_message_id: '<inbound@example.com>',
};

function makeBody(): AgentMailQueueMessage {
  return {
    svix_id: 'svix_1',
    received_at_ms: Date.now(),
    event: {
      id: 'evt_1',
      event_type: 'message.received',
      timestamp: 'x',
      message: INBOUND,
    },
  };
}

function envWith(db: ReturnType<typeof makeMakotoDb>): Env {
  return {
    DB: db,
    MAKOTO_THREAD_LOCK: makeFakeThreadLockNamespace(),
    WORKER_INSTANCE_ID: 'test-worker',
  } as unknown as Env;
}

const ctx = {} as ExecutionContext;

describe('handleAgentMailMessage', () => {
  it('committed outcome → commitDone marks the dedupe row', async () => {
    const db = makeMakotoDb();
    const env = envWith(db);
    const dispatcher: AgentMailDispatcher = async () => ({ kind: 'committed' });
    await handleAgentMailMessage(env, ctx, makeBody(), dispatcher);
    const key = eventKeyForRfc822('<inbound@example.com>');
    const row = db._tables.dedupe.get(key)!;
    expect(row.committed_at_ms).not.toBeNull();
  });

  it('dispatches spam receive events like normal inbound replies', async () => {
    const db = makeMakotoDb();
    const env = envWith(db);
    let seenType = '';
    const body = makeBody();
    body.event.event_type = 'message.received.spam';
    const dispatcher: AgentMailDispatcher = async (context) => {
      seenType = (context.event as unknown as { event_type?: string }).event_type ?? '';
      return { kind: 'committed' };
    };
    await handleAgentMailMessage(env, ctx, body, dispatcher);
    expect(seenType).toBe('message.received.spam');
    const key = eventKeyForRfc822('<inbound@example.com>');
    expect(db._tables.dedupe.get(key)!.committed_at_ms).not.toBeNull();
  });

  it('skipped outcome also commits (so the queue stops redelivering)', async () => {
    const db = makeMakotoDb();
    const env = envWith(db);
    const dispatcher: AgentMailDispatcher = async () => ({ kind: 'skipped', reason: 'x' });
    await handleAgentMailMessage(env, ctx, makeBody(), dispatcher);
    const key = eventKeyForRfc822('<inbound@example.com>');
    expect(db._tables.dedupe.get(key)!.committed_at_ms).not.toBeNull();
  });

  it('release_and_retry outcome releases the claim and throws', async () => {
    const db = makeMakotoDb();
    const env = envWith(db);
    const dispatcher: AgentMailDispatcher = async () => ({ kind: 'release_and_retry', reason: 'flake' });
    await expect(handleAgentMailMessage(env, ctx, makeBody(), dispatcher)).rejects.toThrow();
    const key = eventKeyForRfc822('<inbound@example.com>');
    const row = db._tables.dedupe.get(key)!;
    expect(row.lease_expires_at_ms).toBe(0);
    expect(row.committed_at_ms).toBeNull();
  });

  it('thrown dispatcher releases the claim and re-throws', async () => {
    const db = makeMakotoDb();
    const env = envWith(db);
    const dispatcher: AgentMailDispatcher = async () => {
      throw new Error('dispatcher boom');
    };
    await expect(handleAgentMailMessage(env, ctx, makeBody(), dispatcher)).rejects.toThrow('dispatcher boom');
    const key = eventKeyForRfc822('<inbound@example.com>');
    expect(db._tables.dedupe.get(key)!.lease_expires_at_ms).toBe(0);
  });

  it('skip-without-claim when no message payload', async () => {
    const db = makeMakotoDb();
    const env = envWith(db);
    const dispatcher: AgentMailDispatcher = async () => ({ kind: 'committed' });
    const body: AgentMailQueueMessage = {
      svix_id: 'svix_1',
      received_at_ms: 0,
      event: { id: 'e', event_type: 'message.received', timestamp: 'x' },
    };
    await handleAgentMailMessage(env, ctx, body, dispatcher);
    expect(db._tables.dedupe.size).toBe(0);
  });

  it('skip-without-claim when no rfc822_message_id', async () => {
    const db = makeMakotoDb();
    const env = envWith(db);
    const dispatcher: AgentMailDispatcher = async () => ({ kind: 'committed' });
    const body: AgentMailQueueMessage = {
      svix_id: 'svix_1',
      received_at_ms: 0,
      event: {
        id: 'e',
        event_type: 'message.received',
        timestamp: 'x',
        message: { id: 'm', from: 'a@x' },
      },
    };
    await handleAgentMailMessage(env, ctx, body, dispatcher);
    expect(db._tables.dedupe.size).toBe(0);
  });

  it('DONE_DUPLICATE pre-existing → skip without invoking dispatcher', async () => {
    const db = makeMakotoDb();
    const env = envWith(db);
    // Pre-populate the dedupe row as committed.
    const key = eventKeyForRfc822('<inbound@example.com>');
    await tryClaim(db, key, 'prev-owner', { leaseTtlMs: 60_000 });
    await commitDone(db, key, 'prev-owner', 1);
    let called = false;
    const dispatcher: AgentMailDispatcher = async () => {
      called = true;
      return { kind: 'committed' };
    };
    await handleAgentMailMessage(env, ctx, makeBody(), dispatcher);
    expect(called).toBe(false);
  });
});

describe('defaultDispatcher', () => {
  it('returns committed (the stub layer-5 default)', async () => {
    const result = await defaultDispatcher({} as Parameters<typeof defaultDispatcher>[0]);
    expect(result.kind).toBe('committed');
  });
});
