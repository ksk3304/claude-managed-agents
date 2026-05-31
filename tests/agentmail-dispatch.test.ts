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
  /** Capture the session id passed to events.send. */
  sendSessionCapture?: Array<string>;
  /** Capture sessions.create calls. */
  createCapture?: Array<unknown>;
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
          opts.createCapture?.push(_args);
          return { id: opts.sessionId ?? 'sesn_new' };
        },
        events: {
          async send(_sessionId: string, payload: unknown): Promise<void> {
            opts.sendSessionCapture?.push(_sessionId);
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

// Stub postChatMessage so dispatch tests can assert on Chat notification
// content without going through the SA JWT exchange (= a real RSA key
// fixture would only verify chat-api.ts's parser, which is already
// covered by its own unit tests). Capture calls on `chatApiMock.posts`.
const chatApiMock = {
  posts: [] as Array<{ deps: unknown; spaceName: string; text: string }>,
};
vi.mock('../src/lib/chat-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/chat-api')>();
  return {
    ...actual,
    postChatMessage: async (
      deps: unknown,
      spaceName: string,
      text: string,
    ) => {
      chatApiMock.posts.push({ deps, spaceName, text });
      return { name: `${spaceName}/messages/m_${chatApiMock.posts.length}` };
    },
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
    if (result.kind === 'skipped') expect(result.reason).toBe('no_mail_owner_mapping');
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
      expect(
        (Array.from(sent.values())[0] as { auto_reply_policy?: string }).auto_reply_policy,
      ).toBe('agentmail_auto_reply');
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

  // ---------------------------------------------------------------------------
  // #186 #2 cold inbound notify-only path
  // ---------------------------------------------------------------------------
  it('cold inbound with MAKOTO_NOTIFY_SPACE + CHAT_SA_KEY_JSON → notify only + committed (no bot run)', async () => {
    chatApiMock.posts.length = 0;
    const ctx = makeDispatchContext({
      env: {
        MAKOTO_NOTIFY_SPACE: 'spaces/ABCNotify',
        // Content doesn't matter — chat-api.ts is mocked at the module
        // boundary above. Production needs a real SA JSON; tests don't.
        CHAT_SA_KEY_JSON: '{"client_email":"x","private_key":"y"}',
      },
    });
    await ctx.env.MAKOTO_KV.put(
      'user_mapping:alice@example.com',
      JSON.stringify({ user_slug: 'alice', agent_id: 'agent_001', memory_attachments: [] }),
    );
    await preClaim(ctx.env, ctx.eventKey, ctx.claim.owner);

    installFakeAnthropic({ events: [] });

    const result = await agentmailDispatch(ctx);
    expect(result.kind).toBe('committed');
    expect(chatApiMock.posts).toHaveLength(1);
    const post = chatApiMock.posts[0]!;
    expect(post.spaceName).toBe('spaces/ABCNotify');
    expect(post.text).toContain('📨 新規問い合わせ (cold inbound)');
    expect(post.text).toContain('From: alice@example.com');
    expect(post.text).toContain('件名: こんにちは');
    // No AgentMail send and no sent_messages row (= bot didn't run).
    const sent = (
      ctx.env.DB as unknown as { _tables: { sent_messages: Map<string, unknown> } }
    )._tables.sent_messages;
    expect(sent.size).toBe(0);
  });

  it('cold inbound notify-only does not require sender user_mapping', async () => {
    chatApiMock.posts.length = 0;
    const ctx = makeDispatchContext({
      env: {
        MAKOTO_NOTIFY_SPACE: 'spaces/ABCNotify',
        CHAT_SA_KEY_JSON: '{"client_email":"x","private_key":"y"}',
      },
      message: {
        ...INBOUND_MSG,
        from: 'external@example.net',
        subject: '新規問い合わせ',
        in_reply_to: undefined,
        references: undefined,
      },
    });
    await preClaim(ctx.env, ctx.eventKey, ctx.claim.owner);
    installFakeAnthropic({ events: [] });

    const result = await agentmailDispatch(ctx);
    expect(result.kind).toBe('committed');
    expect(chatApiMock.posts).toHaveLength(1);
    expect(chatApiMock.posts[0]!.text).toContain('📨 新規問い合わせ (cold inbound)');
  });

  // ---------------------------------------------------------------------------
  // #186 #4 continuation auto-reply notification path
  // ---------------------------------------------------------------------------
  it('continuation success with notify env → 📤 autoreply notification posted', async () => {
    chatApiMock.posts.length = 0;
    const ctx = makeDispatchContext({
      env: {
        MAKOTO_NOTIFY_SPACE: 'spaces/ABCNotify',
        CHAT_SA_KEY_JSON: '{"client_email":"x","private_key":"y"}',
      },
      message: {
        ...INBOUND_MSG,
        subject: 'Re: こんにちは', // → reChainDepth >= 1 → continuation path
      },
    });
    await ctx.env.MAKOTO_KV.put(
      'user_mapping:alice@example.com',
      JSON.stringify({ user_slug: 'alice', agent_id: 'agent_001', memory_attachments: [] }),
    );
    await preClaim(ctx.env, ctx.eventKey, ctx.claim.owner);

    const replyBody = 'ご連絡ありがとうございます。';
    installFakeAnthropic({
      sessionId: 'sesn_new_2',
      events: [
        {
          type: 'agent.message.text',
          text:
            `了解しました。\nEMAIL_SEND:{"to":"alice@example.com","subject":"Re: こんにちは","body":"${replyBody}"}`,
        },
        { type: 'session.status_idle' },
      ],
    });

    // Mock AgentMail REST send (kept as fetch mock; AgentMail isn't
    // module-mocked).
    const amCalls: unknown[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async (url, init) => {
      amCalls.push({ url, body: init.body });
      return new Response(
        JSON.stringify({ message_id: 'msg_out_2', rfc822_message_id: '<out-2@example.com>' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    try {
      const result = await agentmailDispatch(ctx);
      expect(result.kind).toBe('committed');

      // 📤 autoreply notification posted exactly once with the sent
      // body inlined.
      expect(chatApiMock.posts).toHaveLength(1);
      const post = chatApiMock.posts[0]!;
      expect(post.spaceName).toBe('spaces/ABCNotify');
      expect(post.text).toContain('📤 continuation 自動返信を送信しました');
      expect(post.text).toContain('宛先: alice@example.com');
      expect(post.text).toContain('件名: Re: こんにちは');
      expect(post.text).toContain(replyBody);

      // AgentMail send happened + sent_messages row created.
      expect(amCalls.length).toBeGreaterThan(0);
      const sent = (
        ctx.env.DB as unknown as { _tables: { sent_messages: Map<string, unknown> } }
      )._tables.sent_messages;
      expect(sent.size).toBe(1);
      expect(
        (Array.from(sent.values())[0] as { auto_reply_policy?: string }).auto_reply_policy,
      ).toBe('agentmail_auto_reply');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('continuation via sent_messages does not require counterparty user_mapping', async () => {
    chatApiMock.posts.length = 0;
    const sendSessionCapture: string[] = [];
    const createCapture: unknown[] = [];
    const ctx = makeDispatchContext({
      message: {
        ...INBOUND_MSG,
        id: 'msg_external_reply',
        from: 'external@example.net',
        subject: 'Re: こんにちは',
        in_reply_to: '<outbound-rfc822@example.com>',
        references: ['<outbound-rfc822@example.com>'],
        message_id: '<external-reply@example.net>',
      },
      event: {
        id: 'evt_external_reply',
        event_type: 'message.received',
        timestamp: 'x',
        message: {
          ...INBOUND_MSG,
          id: 'msg_external_reply',
          from: 'external@example.net',
          subject: 'Re: こんにちは',
          in_reply_to: '<outbound-rfc822@example.com>',
          references: ['<outbound-rfc822@example.com>'],
          message_id: '<external-reply@example.net>',
          inbox_id: 'inbox_main',
        },
      },
    });
    await ctx.env.MAKOTO_KV.put(
      'user_mapping:k.seto@makotoprime.com',
      JSON.stringify({ user_slug: 'k-seto', agent_id: 'agent_001', memory_attachments: [] }),
    );
    await preClaim(ctx.env, ctx.eventKey, ctx.claim.owner);
    await ctx.env.DB.prepare(
      `INSERT OR REPLACE INTO sent_messages
         (message_id, session_id, agent_id, to_addr, sent_at_ms, rfc822_msgid, auto_reply_policy)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(
        'msg_out_original',
        'sesn_existing_mail',
        'agent_001',
        'external@example.net',
        Date.now(),
        'outbound-rfc822@example.com',
        'chat_user_requested',
      )
      .run();

    const replyBody = '外部返信にも自動返信します。';
    installFakeAnthropic({
      sendSessionCapture,
      createCapture,
      events: [
        {
          type: 'agent.message.text',
          text:
            `EMAIL_SEND:{"to":"external@example.net","subject":"Re: こんにちは","body":"${replyBody}"}`,
        },
        { type: 'session.status_idle' },
      ],
    });

    const amCalls: unknown[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async (url, init) => {
      amCalls.push({ url, body: init.body });
      return new Response(
        JSON.stringify({
          message_id: 'msg_external_auto_reply',
          rfc822_message_id: '<auto-reply@example.com>',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    try {
      const result = await agentmailDispatch(ctx);
      expect(result.kind).toBe('committed');
      expect(createCapture).toHaveLength(0);
      expect(sendSessionCapture).toEqual(['sesn_existing_mail']);
      expect(amCalls).toHaveLength(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('SignalB thread self-scan: no Re/header match but thread has bot mail → continuation path', async () => {
    chatApiMock.posts.length = 0;
    const sendCapture: unknown[] = [];
    const ctx = makeDispatchContext({
      env: {
        MAKOTO_NOTIFY_SPACE: 'spaces/ABCNotify',
        CHAT_SA_KEY_JSON: '{"client_email":"x","private_key":"y"}',
      },
      message: {
        ...INBOUND_MSG,
        subject: 'こんにちは',
        thread_id: 'thr_signal_b',
      },
      event: {
        id: 'evt_1',
        event_type: 'message.received',
        timestamp: 'x',
        message: {
          ...INBOUND_MSG,
          subject: 'こんにちは',
          thread_id: 'thr_signal_b',
          inbox_id: 'makoto@agentmail.to',
        },
      },
    });
    await ctx.env.MAKOTO_KV.put(
      'user_mapping:alice@example.com',
      JSON.stringify({ user_slug: 'alice', agent_id: 'agent_001', memory_attachments: [] }),
    );
    await preClaim(ctx.env, ctx.eventKey, ctx.claim.owner);

    const replyBody = 'SignalB 継続返信です。';
    installFakeAnthropic({
      sessionId: 'sesn_signal_b',
      sendCapture,
      events: [
        {
          type: 'agent.message.text',
          text:
            `了解しました。\nEMAIL_SEND:{"to":"alice@example.com","subject":"Re: こんにちは","body":"${replyBody}"}`,
        },
        { type: 'session.status_idle' },
      ],
    });

    const amCalls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async (url, init) => {
      amCalls.push({ url, method: init.method, body: init.body });
      if (url.includes('/threads/thr_signal_b')) {
        return new Response(
          JSON.stringify({
            messages: [
              { from: 'alice@example.com', extracted_text: '最初の問い合わせ' },
              { from: 'MAKOTO <makoto@agentmail.to>', extracted_text: '前回返信' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ message_id: 'msg_signal_b_out', rfc822_message_id: '<out-signal-b@example.com>' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    try {
      const result = await agentmailDispatch(ctx);
      expect(result.kind).toBe('committed');

      expect(amCalls.some((c) => c.url.includes('/threads/thr_signal_b'))).toBe(true);
      expect(amCalls.some((c) => c.url.includes('/messages/msg_inbound/reply'))).toBe(true);
      expect(chatApiMock.posts).toHaveLength(1);
      expect(chatApiMock.posts[0]!.text).toContain('📤 continuation 自動返信を送信しました');

      expect(JSON.stringify(sendCapture)).toContain('前回返信');
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
