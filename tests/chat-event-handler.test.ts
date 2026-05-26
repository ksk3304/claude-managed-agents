/**
 * Integration tests for `src/queue/chat-event-handler.ts` — Phase B
 * (= Google Chat reactive bot Queue consumer).
 *
 * Mirrors the agentmail-dispatch.test.ts pattern: fake Anthropic SDK
 * (scriptable event stream), fake KV/D1, AgentMail fetch mock, and a
 * module-mocked `postChatMessage` so we can assert on Chat投稿 content
 * without going through SA JWT exchange.
 *
 * Covers (per task brief §test 設計):
 *   1. DM + EMAIL_SEND → AgentMail send + sent_messages row + current
 *      space 投稿 + session-log append + commitDone
 *   2. shared space + bot mention あり → 同上
 *   3. shared space + bot mention なし → skip + commitDone
 *   4. BOT sender → skip + commitDone
 *   5. body 空 + thread あり → mention-only 指示文で agent に渡し継続
 *   6. body 空 + thread なし → 「（空メッセージ）」を current space に投稿 + commit
 *   7. CHAT_POST marker → 別 space に投稿 + current space に clean 後本文
 *   8. EMAIL_SEND + CHAT_POST 両方 → 両方 dispatch
 *   9. 内部状態漏洩語 → scrubInternalStateForChat で redaction + WARN
 *   10. 既存 session 解決 (KV hit) → sessions.create skip
 *   11. confirmOwner 失敗 → skip + AgentMail/Chat 投稿なし
 *   12. LLM stream throw → release_and_retry
 *   13. session-log attachment 不在 → skip + commit
 *   14. user_mapping 不在 → unknown_sender skip + commit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

import { handleChatEvent } from '../src/queue/chat-event-handler';
import type { ChatQueueMessage } from '../src/webhooks/google-chat';
import { makeFetchMock, makeKv, makeMakotoDb } from './makoto-helpers';

// ---------------------------------------------------------------------------
// Module mocks (same pattern as agentmail-dispatch.test.ts)
// ---------------------------------------------------------------------------

// Mock buildAnthropicClient to return our injected fake.
vi.mock('../src/lib/session-orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/session-orchestrator')>();
  return {
    ...actual,
    buildAnthropicClient: (_env: Env) =>
      (globalThis as unknown as { __makotoFakeAnth: Anthropic | null }).__makotoFakeAnth,
  };
});

// Capture postChatMessage calls.
const chatApiMock = {
  posts: [] as Array<{ spaceName: string; text: string; opts: unknown }>,
};
vi.mock('../src/lib/chat-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/chat-api')>();
  return {
    ...actual,
    postChatMessage: async (
      _deps: unknown,
      spaceName: string,
      text: string,
      opts: unknown = {},
    ) => {
      chatApiMock.posts.push({ spaceName, text, opts });
      return { name: `${spaceName}/messages/m_${chatApiMock.posts.length}` };
    },
  };
});

// Stub dispatchMakotoTool so tool calls (if any agent emits one) don't
// hit real workspace-oauth. The reactive tests don't drive tool use;
// this is defensive.
vi.mock('../src/dispatch/makoto-tool-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/dispatch/makoto-tool-dispatcher')>();
  return {
    ...actual,
    dispatchMakotoTool: async () => ({ ok: false, payload: { error: 'mocked' } }),
  };
});

// SCHEDULE_ACTION dispatch — Cloud Scheduler REST client は本 spec の
// scope 外 (= cloud-scheduler-client.test.ts で個別に検証する)。ここでは
// `createCloudSchedulerManager` を mock し、各 manager method 呼出を
// capture して assert する。throwManager オプションで失敗系も flip 可。
interface SchedulerMockState {
  capturedCalls: Array<{ method: string; args: unknown[] }>;
  /** true なら manager の create_job が throw して dispatch failure 経路を発火させる。 */
  shouldThrow: boolean;
}
const schedulerMock: SchedulerMockState = {
  capturedCalls: [],
  shouldThrow: false,
};
vi.mock('../src/lib/cloud-scheduler-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/cloud-scheduler-client')>();
  return {
    ...actual,
    createCloudSchedulerManager: (_deps: unknown) => {
      const record = (method: string) => (...args: unknown[]) => {
        schedulerMock.capturedCalls.push({ method, args });
        if (schedulerMock.shouldThrow && method === 'create_job') {
          throw new Error('mock scheduler create_job failure');
        }
        return undefined as unknown;
      };
      return {
        list_jobs: async () => {
          schedulerMock.capturedCalls.push({ method: 'list_jobs', args: [] });
          return [];
        },
        format_job_list: () => '(empty)',
        get_job: async (jobId: string) => {
          schedulerMock.capturedCalls.push({ method: 'get_job', args: [jobId] });
          return null;
        },
        create_job: record('create_job'),
        pause_job: record('pause_job'),
        resume_job: record('resume_job'),
        delete_job: record('delete_job'),
        run_job_once: record('run_job_once'),
        update_job: record('update_job'),
      };
    },
  };
});

// ---------------------------------------------------------------------------
// Fake Anthropic SDK
// ---------------------------------------------------------------------------

interface FakeAnthOpts {
  events: Array<Record<string, unknown>>;
  sessionId?: string;
  createCapture?: Array<unknown>;
  streamThrow?: Error;
  // Track which sessionId was used for events.send (continuation vs new)
  sendCaptureSessionIds?: string[];
  // Capture memory store list/retrieve/create/update calls for session-log
  memoryListReturns?: AsyncIterable<Record<string, unknown>>;
  memoryRetrieveContent?: string;
  memoryCreateCapture?: Array<{ memoryStoreId: string; input: unknown }>;
  memoryUpdateCapture?: Array<unknown>;
}

function makeFakeAnthropic(opts: FakeAnthOpts): Anthropic {
  async function* stream(): AsyncIterable<Record<string, unknown>> {
    for (const ev of opts.events) yield ev;
  }
  async function* emptyMemList(): AsyncIterable<Record<string, unknown>> {
    // nothing
  }
  return {
    beta: {
      sessions: {
        async create(args: unknown) {
          opts.createCapture?.push(args);
          return { id: opts.sessionId ?? 'sesn_new' };
        },
        events: {
          async send(sessionId: string, _payload: unknown): Promise<void> {
            opts.sendCaptureSessionIds?.push(sessionId);
          },
          async stream(
            _sessionId: string,
            _o: unknown,
          ): Promise<AsyncIterable<Record<string, unknown>>> {
            if (opts.streamThrow) throw opts.streamThrow;
            return stream();
          },
        },
      },
      memoryStores: {
        memories: {
          async list(_storeId: string) {
            return opts.memoryListReturns ?? emptyMemList();
          },
          async retrieve(_memId: string, _o: unknown) {
            return { content: opts.memoryRetrieveContent ?? '' };
          },
          async create(memoryStoreId: string, input: unknown) {
            opts.memoryCreateCapture?.push({ memoryStoreId, input });
            return { id: 'mem_new' };
          },
          async update(_memId: string, input: unknown) {
            opts.memoryUpdateCapture?.push(input);
            return { id: 'mem_upd' };
          },
        },
      },
    },
  } as unknown as Anthropic;
}

function installFakeAnthropic(opts: FakeAnthOpts | null): void {
  (globalThis as unknown as { __makotoFakeAnth: Anthropic | null }).__makotoFakeAnth =
    opts === null ? null : makeFakeAnthropic(opts);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BuildEnvOpts {
  envOverrides?: Partial<Env>;
}

function buildEnv(opts: BuildEnvOpts = {}): Env {
  return {
    DB: makeMakotoDb(),
    MAKOTO_KV: makeKv(),
    ANTHROPIC_API_KEY: 'anth',
    ENVIRONMENT_ID: 'env_test',
    AGENTMAIL_API_KEY: 'am-key',
    AGENTMAIL_DEFAULT_INBOX_ID: 'inbox_main',
    CHAT_SA_KEY_JSON: '{"client_email":"x","private_key":"y"}',
    MAKOTO_BOT_DISPLAY_NAME: 'MAKOTOくん',
    ...opts.envOverrides,
  } as unknown as Env;
}

function buildQueueMsg(overrides: {
  spaceType?: string;
  spaceName?: string;
  threadName?: string | null;
  text?: string;
  senderEmail?: string;
  senderType?: string;
}): ChatQueueMessage {
  const spaceName = overrides.spaceName ?? 'spaces/AAA';
  return {
    eventKey: 'chat:msgname:spaces/AAA/messages/M1',
    receivedAtMs: Date.now(),
    claim: { owner: 'w1-uuid', version: 1 },
    payload: {
      type: 'MESSAGE',
      eventTime: '2026-05-26T08:00:00Z',
      message: {
        name: 'spaces/AAA/messages/M1',
        sender: {
          name: 'users/U1',
          ...(overrides.senderEmail !== undefined
            ? { email: overrides.senderEmail }
            : { email: 'alice@example.com' }),
          ...(overrides.senderType ? { type: overrides.senderType } : {}),
        } as { name: string; email?: string; type?: string },
        text: overrides.text ?? 'お疲れさまです',
        ...(overrides.threadName !== undefined && overrides.threadName !== null
          ? { thread: { name: overrides.threadName } }
          : {}),
      },
      space: {
        name: spaceName,
        type: overrides.spaceType ?? 'DM',
        displayName: 'Test Space',
      },
    },
  };
}

async function preClaim(env: Env, eventKey: string, owner: string): Promise<void> {
  await env.DB
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

async function putMapping(env: Env, email: string, opts: { withSessionLog?: boolean } = {}): Promise<void> {
  const attachments = opts.withSessionLog
    ? [
        {
          memory_store_id: 'memstore_dm',
          access: 'read_write' as const,
          store_name: 'session_log_dm_store',
        },
        {
          memory_store_id: 'memstore_shared',
          access: 'read_write' as const,
          store_name: 'session_log_shared_store',
        },
      ]
    : [];
  await env.MAKOTO_KV.put(
    `user_mapping:${email}`,
    JSON.stringify({
      user_slug: 'alice',
      agent_id: 'agent_001',
      memory_attachments: attachments,
    }),
  );
}

beforeEach(() => {
  chatApiMock.posts.length = 0;
  schedulerMock.capturedCalls.length = 0;
  schedulerMock.shouldThrow = false;
  installFakeAnthropic(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleChatEvent', () => {
  it('Case 1: DM + EMAIL_SEND marker → AgentMail send + sent_messages + current space 投稿 + commit', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_1',
      events: [
        {
          type: 'agent.message.text',
          text:
            '了解しました。\nEMAIL_SEND:{"to":"alice@example.com","subject":"Re","body":"返信本文"}',
        },
        { type: 'session.status_idle' },
      ],
    });

    const amCalls: unknown[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async (url, init) => {
      amCalls.push({ url, body: init.body });
      return new Response(
        JSON.stringify({ message_id: 'msg_out_1', rfc822_message_id: '<out-1@example.com>' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    try {
      const result = await handleChatEvent(env, {} as ExecutionContext, msg);
      expect(result.kind).toBe('committed');
      expect(amCalls).toHaveLength(1);
      // current space 投稿 (本文 = marker strip 後)。
      const postsToSpace = chatApiMock.posts.filter((p) => p.spaceName === 'spaces/AAA');
      expect(postsToSpace).toHaveLength(1);
      expect(postsToSpace[0]!.text).toContain('了解しました');
      // sent_messages 行
      const sent = (env.DB as unknown as { _tables: { sent_messages: Map<string, unknown> } })
        ._tables.sent_messages;
      expect(sent.size).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('Case 2: shared space + bot mention あり → 同経路で committed', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({
      spaceType: 'ROOM',
      spaceName: 'spaces/ROOM1',
      text: '@MAKOTOくん 簡単な質問です',
      threadName: 'spaces/ROOM1/threads/T1',
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_2',
      events: [
        { type: 'agent.message.text', text: 'ご質問への回答です。' },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    const postsToSpace = chatApiMock.posts.filter((p) => p.spaceName === 'spaces/ROOM1');
    expect(postsToSpace).toHaveLength(1);
    expect(postsToSpace[0]!.text).toBe('ご質問への回答です。');
    expect((postsToSpace[0]!.opts as { threadName?: string }).threadName).toBe(
      'spaces/ROOM1/threads/T1',
    );
  });

  it('Case 3: shared space + bot mention なし → skip + commit', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({
      spaceType: 'ROOM',
      spaceName: 'spaces/ROOM1',
      text: '雑談だけ、bot 関係なし',
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({ events: [] });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') expect(result.reason).toBe('not_for_bot');
    expect(chatApiMock.posts).toHaveLength(0);
  });

  it('Case 4: BOT sender → skip + commit', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({ senderType: 'BOT' });
    await preClaim(env, msg.eventKey, msg.claim.owner);

    installFakeAnthropic({ events: [] });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') expect(result.reason).toBe('bot_sender');
    expect(chatApiMock.posts).toHaveLength(0);
  });

  it('Case 5: body 空 + thread あり → mention-only 指示文で agent に渡し継続', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({
      spaceType: 'ROOM',
      spaceName: 'spaces/ROOM1',
      text: '@MAKOTOくん',
      threadName: 'spaces/ROOM1/threads/T1',
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    const sends: string[] = [];
    installFakeAnthropic({
      sessionId: 'sesn_5',
      sendCaptureSessionIds: sends,
      events: [
        { type: 'agent.message.text', text: '直前の文脈に応答します。' },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(sends).toHaveLength(1); // events.send called
    expect(chatApiMock.posts).toHaveLength(1);
  });

  it('Case 6: body 空 + thread なし → 「（空メッセージ）」投稿 + commit', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({ text: '' });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({ events: [] });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(chatApiMock.posts).toHaveLength(1);
    expect(chatApiMock.posts[0]!.text).toBe('（空メッセージ）');
  });

  it('Case 7: CHAT_POST marker → 別 space に投稿 + current space に clean 後本文', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_7',
      events: [
        {
          type: 'agent.message.text',
          text:
            '了解しました。投稿します。\nCHAT_POST:{"space":"spaces/OTHER","text":"別スペースへの本文"}',
        },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    // 2 投稿: spaces/OTHER + spaces/AAA (current)
    const otherPosts = chatApiMock.posts.filter((p) => p.spaceName === 'spaces/OTHER');
    const currentPosts = chatApiMock.posts.filter((p) => p.spaceName === 'spaces/AAA');
    expect(otherPosts).toHaveLength(1);
    expect(otherPosts[0]!.text).toBe('別スペースへの本文');
    expect(currentPosts).toHaveLength(1);
    expect(currentPosts[0]!.text).toContain('了解しました');
    expect(currentPosts[0]!.text).not.toContain('CHAT_POST:');
  });

  it('Case 8: EMAIL_SEND + CHAT_POST 両方 → 両方 dispatch', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_8',
      events: [
        {
          type: 'agent.message.text',
          text:
            '両方やります。\nEMAIL_SEND:{"to":"a@example.com","subject":"s","body":"b"}\nCHAT_POST:{"space":"spaces/OTHER","text":"別投稿"}',
        },
        { type: 'session.status_idle' },
      ],
    });

    const amCalls: unknown[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async () => {
      amCalls.push(1);
      return new Response(
        JSON.stringify({ message_id: 'msg_x', rfc822_message_id: '<x@example.com>' }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    try {
      const result = await handleChatEvent(env, {} as ExecutionContext, msg);
      expect(result.kind).toBe('committed');
      expect(amCalls).toHaveLength(1);
      expect(chatApiMock.posts.filter((p) => p.spaceName === 'spaces/OTHER')).toHaveLength(1);
      expect(chatApiMock.posts.filter((p) => p.spaceName === 'spaces/AAA')).toHaveLength(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('Case 9: 内部状態漏洩語 → scrubInternalStateForChat で redaction', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_9',
      events: [
        {
          // 「memory store が未 attach」は internal_state_patterns.json の literal HIT
          type: 'agent.message.text',
          text: 'memory store が未 attach のため対応できません',
        },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    const post = chatApiMock.posts.find((p) => p.spaceName === 'spaces/AAA');
    expect(post).toBeDefined();
    expect(post!.text).toContain('今回のタスクは完了できませんでした');
    expect(post!.text).not.toContain('memory store');
  });

  it('Case 10: 既存 session 解決 (KV hit) → sessions.create skip', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({
      spaceType: 'ROOM',
      spaceName: 'spaces/ROOM10',
      text: '@MAKOTOくん 続きの質問',
      threadName: 'spaces/ROOM10/threads/T10',
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');
    // pre-populate KV with existing session for this thread.
    const sessionKey =
      'chat_thread_session:alice@example.com:spaces/ROOM10:spaces/ROOM10/threads/T10';
    await env.MAKOTO_KV.put(sessionKey, 'sesn_existing');

    const created: unknown[] = [];
    const sends: string[] = [];
    installFakeAnthropic({
      sessionId: 'sesn_should_not_be_used',
      createCapture: created,
      sendCaptureSessionIds: sends,
      events: [
        { type: 'agent.message.text', text: '続きへの応答です。' },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(created).toHaveLength(0); // sessions.create skipped
    expect(sends).toEqual(['sesn_existing']);
  });

  it('Case 11: confirmOwner 失敗 (successor TAKEOVER) → skip', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');
    // simulate successor
    const dedupe = (env.DB as unknown as { _tables: { dedupe: Map<string, Record<string, unknown>> } })
      ._tables.dedupe;
    const row = dedupe.get(msg.eventKey)!;
    row.claim_owner = 'successor';
    row.lease_version = 2;

    installFakeAnthropic({ events: [] });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') expect(result.reason).toBe('lost_claim');
    expect(chatApiMock.posts).toHaveLength(0);
  });

  it('Case 12: LLM stream throw → release_and_retry', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_12',
      events: [],
      streamThrow: new Error('stream connection reset'),
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('release_and_retry');
    if (result.kind === 'release_and_retry') {
      expect(result.reason).toBe('stream_failed');
    }
    // claim was released (= lease_expires_at_ms = 0)
    const dedupe = (env.DB as unknown as { _tables: { dedupe: Map<string, Record<string, unknown>> } })
      ._tables.dedupe;
    const row = dedupe.get(msg.eventKey);
    expect(Number(row?.lease_expires_at_ms)).toBe(0);
    expect(chatApiMock.posts).toHaveLength(0);
  });

  it('Case 13: session-log attachment 不在 → skip + event committed', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    // no session_log_dm_store attachment
    await putMapping(env, 'alice@example.com', { withSessionLog: false });

    const memCreate: Array<{ memoryStoreId: string; input: unknown }> = [];
    installFakeAnthropic({
      sessionId: 'sesn_13',
      memoryCreateCapture: memCreate,
      events: [
        { type: 'agent.message.text', text: '応答です。' },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(memCreate).toHaveLength(0); // session-log skipped
    expect(chatApiMock.posts).toHaveLength(1); // current space 投稿は行われた
  });

  it('Case 14: user_mapping 不在 → unknown_sender skip + commit', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({ senderEmail: 'unknown@example.com' });
    await preClaim(env, msg.eventKey, msg.claim.owner);

    installFakeAnthropic({ events: [] });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') expect(result.reason).toBe('unknown_sender');
    expect(chatApiMock.posts).toHaveLength(0);
  });

  it('Case 14b: user_mapping 不在 + DEFAULT_USER_SLUG 設定済 + default mapping 存在 → default で resolve + committed (#186 follow-up #8)', async () => {
    const env = buildEnv({
      envOverrides: { DEFAULT_USER_SLUG: 'guest' } as Partial<Env>,
    });
    const msg = buildQueueMsg({ senderEmail: 'stranger@example.com' });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    // Write the default mapping under `user_mapping:<slug>` (Python keeps
    // `default` inside the same JSON file; KV port flattens to a
    // dedicated key — see memory-attach.ts:readUserMappingWithDefault).
    await env.MAKOTO_KV.put(
      'user_mapping:guest',
      JSON.stringify({
        user_slug: 'guest',
        agent_id: 'agent_default',
        memory_attachments: [],
      }),
    );

    installFakeAnthropic({
      sessionId: 'sesn_default_1',
      events: [
        { type: 'agent.message.text', text: 'ゲストモードで応答します。' },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    // 既存版 (= placeholder POST 未実装の baseline) と placeholder 版の双方で
    // 動くよう、Chat 投稿の最終本文に "ゲストモード" が含まれていれば PASS と
    // する。placeholder 経路では PATCH 経由、baseline では直接 POST。
    const allTexts = [
      ...chatApiMock.posts.map((p) => p.text),
      // placeholder 版 (= updateChatMessage の patches array) も拾う。型は
      // 動的に存在チェック (baseline では undefined)。
      ...(((chatApiMock as unknown as { patches?: Array<{ text: string }> }).patches) ?? []).map(
        (p) => p.text,
      ),
    ];
    expect(allTexts.some((t) => t.includes('ゲストモード'))).toBe(true);
  });

  it('Case 14c: user_mapping 不在 + DEFAULT_USER_SLUG 未設定 → 従来の unknown_sender skip (回帰防止)', async () => {
    const env = buildEnv(); // DEFAULT_USER_SLUG 未設定
    const msg = buildQueueMsg({ senderEmail: 'stranger2@example.com' });
    await preClaim(env, msg.eventKey, msg.claim.owner);

    installFakeAnthropic({ events: [] });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') expect(result.reason).toBe('unknown_sender');
    expect(chatApiMock.posts).toHaveLength(0);
  });

  it('SCHEDULE_ACTION marker: env (GCP_SCHEDULER_PROJECT) 設定済 → manager.create_job が呼ばれ "予定登録" 結果が current space に流れる', async () => {
    const env = buildEnv({
      envOverrides: {
        GCP_SCHEDULER_PROJECT: 'test-proj',
        GCP_SCHEDULER_LOCATION: 'asia-northeast1',
        SCHEDULER_HANDLER_TOPIC_PREFIX: 'cma-scheduler-',
      } as Partial<Env>,
    });
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_sched_1',
      events: [
        {
          type: 'agent.message.text',
          text:
            '了解しました、登録します。\n' +
            'SCHEDULE_ACTION:{"action":"create","job_id":"daily-x","cron":"0 10 * * *","handler":"cma_session","payload":{"prompt":"朝のレポート"},"description":"朝レポ"}',
        },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    // manager.create_job が 1 回呼ばれた (get_job が先行する Python l.1119 等価)
    expect(schedulerMock.capturedCalls.some((c) => c.method === 'create_job')).toBe(true);
    expect(schedulerMock.capturedCalls.some((c) => c.method === 'get_job')).toBe(true);
    // current space 投稿に「✅ `daily-x` 登録」が含まれる (Python l.1122 byte 等価)
    const post = chatApiMock.posts.find((p) => p.spaceName === 'spaces/AAA');
    expect(post).toBeDefined();
    expect(post!.text).toContain('登録');
    expect(post!.text).toContain('daily-x');
    expect(post!.text).not.toContain('SCHEDULE_ACTION:');
  });

  it('SCHEDULE_ACTION marker: env (GCP_SCHEDULER_PROJECT) 未設定 → dispatch skip + 既存 chat 投稿のみ', async () => {
    const env = buildEnv(); // env 未設定 (= 既存挙動)
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_sched_skip',
      events: [
        {
          type: 'agent.message.text',
          text:
            '応答です。\n' +
            'SCHEDULE_ACTION:{"action":"list"}',
        },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    // manager は呼ばれない
    expect(schedulerMock.capturedCalls).toHaveLength(0);
    // current space 投稿はある (= 旧挙動完全互換)。SCHEDULE_ACTION 文字列は本文に残る可能性。
    expect(chatApiMock.posts.find((p) => p.spaceName === 'spaces/AAA')).toBeDefined();
  });

  it('SCHEDULE_ACTION marker: manager throw → WARN log + 元 cleanedText で投稿継続', async () => {
    const env = buildEnv({
      envOverrides: {
        GCP_SCHEDULER_PROJECT: 'test-proj',
        GCP_SCHEDULER_LOCATION: 'asia-northeast1',
      } as Partial<Env>,
    });
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');
    // 注: handleScheduleActionMarker 内部の execScheduleAction は manager の
    // throw を **catch して result.combinedText の `❌` メッセージ** に変換する
    // (Python l.1149-1150 と等価)。したがって chat-event-handler 側の WARN
    // path (= 全体 throw) を発火させるには、manager 取得自体は成功させつつ
    // create_job が throw する shape にする → 内部 catch で `❌ \`...\`:
    // Error: ...` が combinedText に乗る。
    schedulerMock.shouldThrow = true;

    installFakeAnthropic({
      sessionId: 'sesn_sched_throw',
      events: [
        {
          type: 'agent.message.text',
          text:
            '登録します。\n' +
            'SCHEDULE_ACTION:{"action":"create","job_id":"will-fail","cron":"0 10 * * *","payload":{}}',
        },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    const post = chatApiMock.posts.find((p) => p.spaceName === 'spaces/AAA');
    expect(post).toBeDefined();
    // failure isolation: 投稿は行われ、❌ メッセージが本文に含まれる。
    expect(post!.text).toContain('will-fail');
    expect(post!.text).toContain('❌');
  });

  it('session-log: DM mapping ありなら memory create が呼ばれる', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com', { withSessionLog: true });

    const memCreate: Array<{ memoryStoreId: string; input: unknown }> = [];
    installFakeAnthropic({
      sessionId: 'sesn_log',
      memoryCreateCapture: memCreate,
      events: [
        { type: 'agent.message.text', text: '応答テキスト。' },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(memCreate).toHaveLength(1);
    expect(memCreate[0]!.memoryStoreId).toBe('memstore_dm');
  });
});
