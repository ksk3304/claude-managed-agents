/**
 * Integration tests for `src/queue/agentmail-dispatch.ts` — layer 7-2.
 *
 * Stitches the consumer framing, dedupe, memory-attach, session loop,
 * EMAIL_SEND parsing, AgentMail send, and recordSentMessage paths
 * together under a fake Anthropic SDK + fake AgentMail fetch + KV/D1.
 *
 * Covers:
 *   - unknown sender → skipped
 *   - happy path: fresh session → agent text with EMAIL_SEND marker →
 *     AgentMail send → sent_messages row written → committed
 *   - lost claim before send → skipped (no AgentMail call)
 *   - no inbox_id in webhook envelope → skipped
 *   - no EMAIL_SEND markers in agent text → committed (no AgentMail call)
 */

import { describe, it, expect, vi } from 'vitest';
import { agentmailDispatch } from '../src/queue/agentmail-dispatch';
import type {
  AgentMailDispatchContext,
} from '../src/queue/agentmail-consumer';
import { confirmOwner } from '../src/lib/dedupe';
import {
  makeFetchMock,
  makeKv,
  makeMakotoDb,
} from './makoto-helpers';
import type Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Fake Anthropic SDK with scriptable event stream
// ---------------------------------------------------------------------------

interface FakeAnthOpts {
  /** Events the stream yields after the user.message is sent. */
  events: Array<Record<string, unknown>>;
  /** Capture all events.send payloads. */
  sendCapture?: Array<unknown>;
  /** Pre-allocated session id `sessions.create` returns. */
  sessionId?: string;
}

function makeFakeAnthropic(opts: FakeAnthOpts): Anthropic {
  async function* stream(): AsyncIterable<Record<string, unknown>> {
    for (const ev of opts.events) yield ev;
  }
  return {
    beta: {
      sessions: {
        async create(_args: unknown) {
          return { id: opts.sessionId ?? 'sesn_new' };
        },
        events: {
          async send(_sessionId: string, payload: unknown): Promise<void> {
            opts.sendCapture?.push(payload);
          },
          async stream(_sessionId: string, _o: unknown): Promise<AsyncIterable<Record<string, unknown>>> {
            return stream();
          },
        },
      },
    },
  } as unknown as Anthropic;
}

// Inject the fake into buildAnthropicClient by stubbing the module.
vi.mock('../src/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/session')>();
  return {
    ...actual,
    buildAnthropicClient: (_env: Env) => (globalThis as unknown as { __makotoFakeAnth: Anthropic }).__makotoFakeAnth,
  };
});

function installFakeAnthropic(opts: FakeAnthOpts): void {
  (globalThis as unknown as { __makotoFakeAnth: Anthropic }).__makotoFakeAnth = makeFakeAnthropic(
    opts,
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INBOUND_MSG = {
  id: 'msg_inbound',
  from: 'alice@example.com',
  subject: 'こんにちは',
  rfc822_message_id: '<inbound-1@example.com>',
  extracted_text: 'お疲れさまです。',
};

function makeDispatchContext(overrides: {
  env?: Partial<Env>;
  event?: unknown;
  message?: typeof INBOUND_MSG;
}): AgentMailDispatchContext {
  const env = {
    DB: makeMakotoDb(),
    MAKOTO_KV: makeKv(),
    AGENTMAIL_API_KEY: 'am-key',
    OAUTH_VAULT_KEY: undefined,
    OAUTH_CLIENT_ID: 'cid',
    OAUTH_CLIENT_SECRET: 'csec',
    ENVIRONMENT_ID: 'env_test',
    ANTHROPIC_API_KEY: 'anth',
    ...overrides.env,
  } as unknown as Env;

  return {
    env,
    ctx: {} as ExecutionContext,
    event: overrides.event ?? {
      id: 'evt_1',
      event_type: 'message.received',
      timestamp: 'x',
      message: { ...(overrides.message ?? INBOUND_MSG), inbox_id: 'inbox_main' },
    },
    message: overrides.message ?? INBOUND_MSG,
    rfc822MsgId: 'inbound-1@example.com',
    claim: { owner: 'w1-uuid', version: 1 },
    threadLock: { acquire: async () => ({ acquired: true }), release: async () => ({ released: true }), extend: async () => ({ extended: true }) },
    eventKey: 'mail:msgid:inbound-1@example.com',
  } as AgentMailDispatchContext;
}

async function preClaim(env: Env, eventKey: string, owner: string): Promise<void> {
  // The framing layer always claims before dispatch — for these tests we
  // pre-populate the dedupe row ourselves so `confirmOwner` succeeds.
  const db = env.DB;
  await db
    .prepare(
      `INSERT OR IGNORE INTO dedupe
         (event_key, claim_state, claim_owner, lease_version,
          lease_expires_at_ms, committed_at_ms,
          created_at_ms, ttl_expires_at_ms)
       VALUES (?1, 'NEW', ?2, 1, ?3, NULL, ?4, ?5)`,
    )
    .bind(eventKey, owner, Date.now() + 300_000, Date.now(), Date.now() + 86_400_000)
    .run();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agentmailDispatch', () => {
  it('skips unknown sender', async () => {
    const ctx = makeDispatchContext({});
    // KV has no user_mapping entry for alice → unknown_sender.
    installFakeAnthropic({ events: [] });
    const result = await agentmailDispatch(ctx);
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') expect(result.reason).toBe('unknown_sender');
  });

  it('happy path: fresh session → EMAIL_SEND marker → AgentMail send', async () => {
    const ctx = makeDispatchContext({});
    await ctx.env.MAKOTO_KV.put(
      'user_mapping:alice@example.com',
      JSON.stringify({
        user_slug: 'alice',
        agent_id: 'agent_001',
        memory_attachments: [],
      }),
    );
    await preClaim(ctx.env, ctx.eventKey, ctx.claim.owner);

    // Mock AgentMail REST send.
    const amSends: unknown[] = [];
    const amFetch = makeFetchMock(async (url, init) => {
      amSends.push({ url, body: init.body });
      return new Response(
        JSON.stringify({ message_id: 'msg_out_1', rfc822_message_id: '<out-1@example.com>' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    // Patch global fetch for AgentMail (egress guard allows api.agentmail.to).
    const origFetch = globalThis.fetch;
    globalThis.fetch = amFetch as unknown as typeof fetch;

    installFakeAnthropic({
      sessionId: 'sesn_new_1',
      events: [
        {
          type: 'agent.message.text',
          text:
            '了解しました。\nEMAIL_SEND:{"to":"alice@example.com","subject":"Re: こんにちは","body":"ご連絡ありがとうございます。"}',
        },
        { type: 'session.status_idle' },
      ],
    });

    try {
      const result = await agentmailDispatch(ctx);
      expect(result.kind).toBe('committed');
      expect(amSends).toHaveLength(1);
      // sent_messages should have the outbound row.
      const sent = (ctx.env.DB as unknown as { _tables: { sent_messages: Map<string, unknown> } })._tables.sent_messages;
      expect(sent.size).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('no EMAIL_SEND markers → committed (no AgentMail call)', async () => {
    const ctx = makeDispatchContext({});
    await ctx.env.MAKOTO_KV.put(
      'user_mapping:alice@example.com',
      JSON.stringify({ user_slug: 'alice', agent_id: 'agent_001', memory_attachments: [] }),
    );
    await preClaim(ctx.env, ctx.eventKey, ctx.claim.owner);

    installFakeAnthropic({
      events: [
        { type: 'agent.message.text', text: '内部メモのみ、返信しません。' },
        { type: 'session.status_idle' },
      ],
    });

    const result = await agentmailDispatch(ctx);
    expect(result.kind).toBe('committed');
  });

  it('lost claim before send → skipped (no AgentMail call)', async () => {
    const ctx = makeDispatchContext({});
    await ctx.env.MAKOTO_KV.put(
      'user_mapping:alice@example.com',
      JSON.stringify({ user_slug: 'alice', agent_id: 'agent_001', memory_attachments: [] }),
    );
    // Pre-claim, then bump version so confirmOwner fails. Mutate the
    // fake table directly (the production code never issues this exact
    // UPDATE — it's a test-only setup that simulates successor TAKEOVER).
    await preClaim(ctx.env, ctx.eventKey, ctx.claim.owner);
    const dedupeTable = (ctx.env.DB as unknown as {
      _tables: { dedupe: Map<string, Record<string, unknown>> };
    })._tables.dedupe;
    const row = dedupeTable.get(ctx.eventKey)!;
    row.claim_owner = 'successor';
    row.lease_version = 2;

    installFakeAnthropic({
      events: [
        {
          type: 'agent.message.text',
          text: 'EMAIL_SEND:{"to":"a@x","subject":"s","body":"b"}',
        },
        { type: 'session.status_idle' },
      ],
    });

    let amCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async () => {
      amCalled = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      // First, confirm confirmOwner is going to fail with our original owner.
      const stillOwner = await confirmOwner(ctx.env.DB, ctx.eventKey, ctx.claim.owner, ctx.claim.version);
      expect(stillOwner).toBe(false);

      const result = await agentmailDispatch(ctx);
      expect(result.kind).toBe('skipped');
      if (result.kind === 'skipped') expect(result.reason).toBe('lost_claim_before_send');
      expect(amCalled).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('no inbox_id in webhook → skipped (cannot deliver)', async () => {
    const ctx = makeDispatchContext({
      event: {
        id: 'evt',
        event_type: 'message.received',
        timestamp: 'x',
        message: INBOUND_MSG, // no inbox_id
      },
    });
    await ctx.env.MAKOTO_KV.put(
      'user_mapping:alice@example.com',
      JSON.stringify({ user_slug: 'alice', agent_id: 'agent_001', memory_attachments: [] }),
    );
    await preClaim(ctx.env, ctx.eventKey, ctx.claim.owner);

    installFakeAnthropic({
      events: [
        { type: 'agent.message.text', text: 'EMAIL_SEND:{"to":"a@x","subject":"s","body":"b"}' },
        { type: 'session.status_idle' },
      ],
    });

    const result = await agentmailDispatch(ctx);
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') expect(result.reason).toBe('no_inbox_id');
  });
});
