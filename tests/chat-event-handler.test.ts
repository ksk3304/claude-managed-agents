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

import { chatTurnProcessingKey, handleChatEvent } from '../src/queue/chat-event-handler';
import {
  buildChatCapabilitySessionKey,
  chatThreadSessionKey,
} from '../src/lib/session-orchestrator';
import type { ChatQueueMessage } from '../src/webhooks/google-chat';
import { _resetChatOAuthCacheForTests } from '../src/lib/chat-oauth';
import { buildSideEffectKey } from '../src/lib/three-stage-precheck';
import {
  makeFakeThreadLockNamespace,
  makeFakeOAuthLeaseNamespace,
  makeFetchMock,
  makeKv,
  makeMakotoDb,
  TEST_VAULT_KEY_B64,
} from './makoto-helpers';
import { putRefreshToken } from '../src/lib/oauth-vault';
import { getThreadLock } from '../src/durable-objects/thread-lock';
import { RECOVERY_PROMPT } from '../src/lib/cap-recovery';
import { readCounter, _internals as costGuardInternals } from '../src/lib/cost-guard';

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

// Capture postChatMessage / updateChatMessage / deleteChatMessage calls.
// `updateThrow` / `deleteThrow` で個別 test ケースから fail 経路を発火可能。
interface ChatApiMockState {
  posts: Array<{ spaceName: string; text: string; opts: unknown }>;
  patches: Array<{ messageName: string; text: string }>;
  deletes: string[];
  postThrow: Error | null;
  updateThrow: Error | null;
  deleteThrow: Error | null;
}
const chatApiMock: ChatApiMockState = {
  posts: [],
  patches: [],
  deletes: [],
  postThrow: null,
  updateThrow: null,
  deleteThrow: null,
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
      if (chatApiMock.postThrow) throw chatApiMock.postThrow;
      chatApiMock.posts.push({ spaceName, text, opts });
      const threadName =
        typeof opts === 'object' &&
        opts !== null &&
        'threadName' in opts &&
        typeof (opts as { threadName?: unknown }).threadName === 'string'
          ? (opts as { threadName: string }).threadName
          : `${spaceName}/threads/t_${chatApiMock.posts.length}`;
      return { name: `${spaceName}/messages/m_${chatApiMock.posts.length}`, threadName };
    },
    updateChatMessage: async (
      _deps: unknown,
      messageName: string,
      text: string,
    ) => {
      if (chatApiMock.updateThrow) throw chatApiMock.updateThrow;
      chatApiMock.patches.push({ messageName, text });
    },
    deleteChatMessage: async (_deps: unknown, messageName: string) => {
      if (chatApiMock.deleteThrow) throw chatApiMock.deleteThrow;
      chatApiMock.deletes.push(messageName);
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
    dispatchMakotoTool: async (name: string, input: unknown, ctx: unknown) => {
      const override = (globalThis as unknown as {
        __makotoToolDispatch?: (
          name: string,
          input: unknown,
          ctx: unknown,
        ) => Promise<{ ok: boolean; payload: unknown }>;
      }).__makotoToolDispatch;
      if (override) return override(name, input, ctx);
      return { ok: false, payload: { error: 'mocked' } };
    },
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
  jobs: Array<{
    job_id: string;
    cron: string;
    handler: string;
    description?: string;
    payload?: Record<string, unknown>;
    paused?: boolean;
  }>;
}
const schedulerMock: SchedulerMockState = {
  capturedCalls: [],
  shouldThrow: false,
  jobs: [],
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
          return schedulerMock.jobs;
        },
        format_job_list: (jobs: typeof schedulerMock.jobs) =>
          jobs.length === 0
            ? '(empty)'
            : jobs.map((j) => `・${j.job_id} ${j.cron} ${j.description ?? ''}`).join('\n'),
        get_job: async (jobId: string) => {
          schedulerMock.capturedCalls.push({ method: 'get_job', args: [jobId] });
          return schedulerMock.jobs.find((j) => j.job_id === jobId) ?? null;
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
  /** sessions.create を呼んだときに throw する error。orchestrator 内で
   *  `sessions_create_failed` reason に分類される (#186 placeholder DELETE
   *  経路の発火条件)。 */
  createThrow?: Error;
  // Track which sessionId was used for events.send (continuation vs new)
  sendCaptureSessionIds?: string[];
  retrieveUsage?: Record<string, unknown>;
  retrieveModel?: string;
  sendCapturePayloads?: unknown[];
  listEvents?: Array<Record<string, unknown>>;
  // Capture memory store list/retrieve/create/update calls for session-log
  memoryListReturns?: AsyncIterable<Record<string, unknown>>;
  memoryRetrieveContent?: string;
  memoryCreateCapture?: Array<{ memoryStoreId: string; input: unknown }>;
  memoryUpdateCapture?: Array<unknown>;
  /**
   * cap-recovery wire up テスト用。`stream()` の N 回目以降の呼出で再生
   * する追加 event 列。指定なしなら従来通り `events` を毎回再生する。
   * 配列の index N-1 が N 回目 (= 1-based) の stream に対応する。
   */
  followupEventBatches?: Array<Array<Record<string, unknown>>>;
}

function makeFakeAnthropic(opts: FakeAnthOpts): Anthropic {
  let streamCallCount = 0;
  async function* streamForCall(
    callIndex: number,
  ): AsyncIterable<Record<string, unknown>> {
    // callIndex は 0-based。0 = 初回 = opts.events、1 以降は
    // followupEventBatches[callIndex - 1] を優先、無ければ events fallback。
    if (callIndex === 0) {
      for (const ev of opts.events) yield ev;
      return;
    }
    const batchIdx = callIndex - 1;
    const followup = opts.followupEventBatches?.[batchIdx];
    if (followup) {
      for (const ev of followup) yield ev;
      return;
    }
    for (const ev of opts.events) yield ev;
  }
  async function* emptyMemList(): AsyncIterable<Record<string, unknown>> {
    // nothing
  }
  async function* sessionEventList(): AsyncIterable<Record<string, unknown>> {
    for (const ev of opts.listEvents ?? []) yield ev;
  }
  return {
    beta: {
      sessions: {
        async create(args: unknown) {
          opts.createCapture?.push(args);
          if (opts.createThrow) throw opts.createThrow;
          return { id: opts.sessionId ?? 'sesn_new' };
        },
        async retrieve(_sessionId: string) {
          return {
            usage: opts.retrieveUsage ?? null,
            model: opts.retrieveModel ?? 'claude-opus-4-7',
          };
        },
        events: {
          async send(sessionId: string, payload: unknown): Promise<void> {
            opts.sendCaptureSessionIds?.push(sessionId);
            opts.sendCapturePayloads?.push(payload);
          },
          async stream(
            _sessionId: string,
            _o: unknown,
          ): Promise<AsyncIterable<Record<string, unknown>>> {
            if (opts.streamThrow) throw opts.streamThrow;
            const callIndex = streamCallCount;
            streamCallCount += 1;
            return streamForCall(callIndex);
          },
          list(_sessionId: string, _o: unknown) {
            return sessionEventList();
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

const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDMg3c8BYnUyuKy
/sE+hpSWDkzGpCSp4jkU7PEzl7z0ik36HN8m8wAv7OAjepJzMbi+hIOI+KYS7u8u
kKzH9R6qat3XtumMJJ/7C4azj9vvqlt0+hpfm/udtmqSvXq4szThcE5AlbD4sU1O
Up7qlgnaUsflxlyJ4Y+/ZKacFkNTJqYoxfM7rMwxgBc5zqrCCZp76Pypj+JIQ4O3
ZIewxBMVuyd5LDxrsNamXl7ENTga+1bBFQxdE6Zum6/oTLomhx94lwcgmTJX2GLx
q3HpxEpAaM29Og4sekRzYn/LYShN89mlwMai1kKtUwUZZnIDO0IW05rhtkxxUMsp
l9mAbJZvAgMBAAECggEABqKODL5CDkt8XVt5TRw0PkYKfmtQd5gYsZgaUmOUd5T0
TXszgvthQMZjlmMUoae16BOhtm2ytzlVoy7oaOuH6il7ajmYWO0BqU7JBcXscb/j
v02Z63FcRKECOVTr+7zWQcLqyjRqptB09jSLmVRZNeJEcyzwHAnbjjvat+rbYxtc
1juUqCPR568edUDfkMuZDBzJ3fRUhlYZDRwckeNpDiu83a6Gbyk8/lnn2HjUccvG
zcs2tOQTbVjZQB+7aeKqlvXR3nItIH03SFFR94M1nvsmmBlgoaDxIDsFrZQDion8
ad8SC6PFGHR1ZACc2iLD2IKoRvKUEnQsobtTxXSKqQKBgQDsbCD+g7kgP0ZhMStB
tYkhZBtLOP0Yxf6xkEqbWF7dypjn2aiSo/pFZkzvxyYDDY9vOlERAgxlIQQeDvVL
zmAiRqKH/P0dTTlQpfBa7D2UMXGLc3tEsDAnh6wr0Q8dAK8eVFPKLvmXKOdzo96s
3uI2hQkSchVbAyGxzJpUAxiBqwKBgQDdcuhe4AM45qn1FHIv/mtNFafv9aqwh4QC
ez46IBjzs06Tipbju0dkoV2Tl/XWH7hcLRBBwSHA5ysirCsni6ahfkoG8f+WDpn+
b/i/9ZtIr5YY1uifj4JMXNlHpgcRLuM8Qyjx0d7YU//yZmIgLCwET+sjtObSh/4i
EU9oKV7CTQKBgHBY5cjsgYGAcAppmhusj5CtiIbTevpVxDVO0xVFBjexOb4bYY7l
m111QqRC555VyE5b0QAbEBbSfKloBErUtDw1grDKmOFevBjF8hTS5GRSpplU9EPs
0cVHJJrhyqPGmnD4M6UFc5fQWURLn9pYQ/kSeQAp9Fn+f/mEt+WqXu/nAoGANPxm
jzTocHf4mJSA0ez9PZ995FOSuNRkCLf2ZrABaGYx2emiOvE3nuNhYYxNnSNP2HZL
2n/clKx7TLuHQ9oNT7zI96p1rjDmNdQS39NjiVvB/UWGuY777UuWDaezLzBZ3LRx
GpNNz9MhfZ1zwyDuk0WQDKYfSKaTbxFXP6QOcU0CgYBDS4hD1GHV+zMoJ/syRbeY
nm5ZxWUfP2OnCKT+sj+54DLHS53KwbquJRSNJBB4t/6IODAoStHfPpTLt18IfeQo
cmhs1W5d46A9bnEMLf/uZ/thauX8b771QGYLTDQMkgTlfTLsbnKcb4/XQ4iR4n/A
jFFa+31v/gSYzRUQMeyhUg==
-----END PRIVATE KEY-----`;

function fixtureSaKeyJson(): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'cma-bot-mp-20260501',
    private_key_id: 'fixture-kid',
    private_key: TEST_PRIVATE_KEY_PEM,
    client_email: 'cma-chat-bot@cma-bot-mp-20260501.iam.gserviceaccount.com',
  });
}

function makeMinimalPdf(pageCount: number): Uint8Array {
  const pages = Array.from({ length: pageCount }, (_, i) => `${3 + i} 0 R`).join(' ');
  const pageObjects = Array.from(
    { length: pageCount },
    (_, i) =>
      `${3 + i} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] ` +
      `/Contents ${3 + pageCount} 0 R >> endobj`,
  ).join('\n');
  const body =
    `%PDF-1.4\n` +
    `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
    `2 0 obj << /Type /Pages /Count ${pageCount} /Kids [${pages}] >> endobj\n` +
    `${pageObjects}\n` +
    `${3 + pageCount} 0 obj << /Length 57 >> stream\n` +
    `BT /F1 12 Tf 36 100 Td (Issue 214 PDF preflight small PASS) Tj ET\n` +
    `endstream endobj\n` +
    `xref\n0 ${4 + pageCount}\n0000000000 65535 f \n` +
    `trailer << /Root 1 0 R /Size ${4 + pageCount} >>\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

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
    MAKOTO_THREAD_LOCK: makeFakeThreadLockNamespace(),
    ...opts.envOverrides,
  } as unknown as Env;
}

function buildQueueMsg(overrides: {
  eventKey?: string;
  spaceType?: string;
  spaceName?: string;
  threadName?: string | null;
  text?: string;
  senderEmail?: string;
  senderName?: string;
  senderDisplayName?: string;
  senderType?: string;
  annotations?: Array<{
    type?: string;
    startIndex?: number;
    length?: number;
    userMention?: { user?: { name?: string; type?: string } };
  }>;
  attachment?: ChatQueueMessage['payload']['message']['attachment'];
  placeholderName?: string;
}): ChatQueueMessage {
  const spaceName = overrides.spaceName ?? 'spaces/AAA';
  return {
    eventKey: overrides.eventKey ?? 'chat:msgname:spaces/AAA/messages/M1',
    receivedAtMs: Date.now(),
    claim: { owner: 'w1-uuid', version: 1 },
    ...(overrides.placeholderName ? { placeholderName: overrides.placeholderName } : {}),
    payload: {
      type: 'MESSAGE',
      eventTime: '2026-05-26T08:00:00Z',
      message: {
        name: 'spaces/AAA/messages/M1',
        sender: {
          name: overrides.senderName ?? 'users/U1',
          ...(overrides.senderEmail !== undefined
            ? { email: overrides.senderEmail }
            : { email: 'alice@example.com' }),
          ...(overrides.senderDisplayName ? { displayName: overrides.senderDisplayName } : {}),
          ...(overrides.senderType ? { type: overrides.senderType } : {}),
        } as { name: string; email?: string; displayName?: string; type?: string },
        text: overrides.text ?? 'お疲れさまです',
        ...(overrides.threadName !== undefined && overrides.threadName !== null
          ? { thread: { name: overrides.threadName } }
          : {}),
        ...(overrides.annotations ? { annotations: overrides.annotations } : {}),
        ...(overrides.attachment ? { attachment: overrides.attachment } : {}),
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

function runtimeEvents(env: Env): Array<Record<string, unknown>> {
  return (env.DB as unknown as {
    _tables: { cma_worker_runtime_events: Array<Record<string, unknown>> };
  })._tables.cma_worker_runtime_events;
}

function commitDecision(env: Env, reason: string): Record<string, unknown> | undefined {
  return runtimeEvents(env).find((row) => {
    if (row.event_type !== 'chat_event_commit_decision') return false;
    const detail = JSON.parse(String(row.detail_json));
    return detail.reason === reason;
  });
}

beforeEach(() => {
  _resetChatOAuthCacheForTests();
  chatApiMock.posts.length = 0;
  chatApiMock.patches.length = 0;
  chatApiMock.deletes.length = 0;
  chatApiMock.postThrow = null;
  chatApiMock.updateThrow = null;
  chatApiMock.deleteThrow = null;
  schedulerMock.capturedCalls.length = 0;
  schedulerMock.shouldThrow = false;
  schedulerMock.jobs = [];
  delete (globalThis as unknown as { __makotoToolDispatch?: unknown }).__makotoToolDispatch;
  installFakeAnthropic(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleChatEvent', () => {
  it('/costguard status reply increments chat daily counter', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({ text: '/costguard status' });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);

    expect(result.kind).toBe('committed');
    expect(chatApiMock.posts).toHaveLength(1);
    expect(chatApiMock.posts[0]!.text).toContain('Cost Guard 状態');
    await expect(
      readCounter(
        { db: env.DB, kv: env.MAKOTO_KV },
        costGuardInternals.KIND_CHAT_POST,
      ),
    ).resolves.toBe(1);
  });

  it('natural Cost Guard wording short-circuits to deterministic status handler', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({ text: '安全装置どうなってる？' });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);

    expect(result.kind).toBe('committed');
    expect(chatApiMock.posts).toHaveLength(1);
    expect(chatApiMock.posts[0]!.text).toContain('Cost Guard 状態');
    await expect(
      readCounter(
        { db: env.DB, kv: env.MAKOTO_KV },
        costGuardInternals.KIND_CHAT_POST,
      ),
    ).resolves.toBe(1);
  });

  it('normal Chat turn renews the parent claim so Queue redelivery cannot replay the user message mid-turn', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({ text: '130秒待ってから返答して' });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');
    const dedupe = (env.DB as unknown as { _tables: { dedupe: Map<string, Record<string, unknown>> } })
      ._tables.dedupe;
    const leaseBefore = Number(dedupe.get(msg.eventKey)!.lease_expires_at_ms);

    installFakeAnthropic({
      sessionId: 'sesn_parent_lease_heartbeat',
      events: [
        { type: 'agent.message.text', text: '通常応答です。' },
        { type: 'session.status_idle', stop_reason: 'end_turn' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);

    expect(result.kind).toBe('committed');
    expect(Number(dedupe.get(msg.eventKey)!.lease_expires_at_ms)).toBeGreaterThan(
      leaseBefore + 500_000,
    );
    const heartbeatEvent = runtimeEvents(env).find(
      (row) => row.event_type === 'chat_parent_lease_heartbeat_started',
    );
    expect(heartbeatEvent).toBeDefined();
    expect(JSON.parse(String(heartbeatEvent!.detail_json))).toMatchObject({
      lease_ttl_ms: 900_000,
      interval_ms: 60_000,
    });
    expect(chatApiMock.patches.at(-1)?.text).toContain('通常応答です。');
  });

  it('duplicate Queue redelivery waits without sending another user.message while CMA session is still running', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({ text: '130秒待ってから返答して' });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await preClaim(env, chatTurnProcessingKey(msg.eventKey), 'other-consumer');
    await putMapping(env, 'alice@example.com');
    const createCapture: unknown[] = [];

    installFakeAnthropic({
      sessionId: 'sesn_should_not_start',
      createCapture,
      events: [
        { type: 'agent.message.text', text: '二重実行してはいけない' },
        { type: 'session.status_idle', stop_reason: 'end_turn' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);

    expect(result).toEqual({
      kind: 'retry_later',
      reason: 'cma_session_bind_missing',
      delaySeconds: 60,
    });
    expect(createCapture).toEqual([]);
    expect(chatApiMock.posts).toHaveLength(0);
    expect(chatApiMock.patches).toHaveLength(0);
    const duplicateEvent = runtimeEvents(env).find(
      (row) => row.event_type === 'chat_turn_processing_duplicate_suppressed',
    );
    expect(duplicateEvent).toBeDefined();
  });

  it('duplicate Queue redelivery recovers a completed CMA session and posts the final answer', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({ text: '130秒待ってから返答して' });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await preClaim(env, chatTurnProcessingKey(msg.eventKey), 'other-consumer');
    await putMapping(env, 'alice@example.com');
    await env.DB
      .prepare(
        `INSERT INTO cma_session_binds
         (created_at_ms, expire_at_ms, session_key_hash, session_id, event_key,
          message_id, user_slug, thread_name_hash, is_new_session)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(
        Date.now(),
        Date.now() + 86_400_000,
        'hash',
        'sesn_recover_done',
        msg.eventKey,
        msg.payload.message.name,
        'alice',
        'thread_hash',
        1,
      )
      .run();
    const createCapture: unknown[] = [];

    installFakeAnthropic({
      sessionId: 'sesn_should_not_start',
      createCapture,
      events: [
        { type: 'agent.message.text', text: '二重実行してはいけない' },
        { type: 'session.status_idle', stop_reason: 'end_turn' },
      ],
      listEvents: [
        {
          type: 'user.message',
          content: [{ type: 'text', text: `前置き\n${msg.payload.message.text}\n後続` }],
        },
        {
          type: 'agent.message',
          content: [{ type: 'text', text: 'CMA完了済みの最終回答です。' }],
        },
        { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);

    expect(result.kind).toBe('committed');
    expect(createCapture).toEqual([]);
    expect(chatApiMock.patches.at(-1)?.text).toContain('CMA完了済みの最終回答です。');
    expect(runtimeEvents(env).map((row) => row.event_type)).toContain(
      'cma_completed_session_recovered',
    );
  });

  it('PDF preflight prompts before Anthropic when projected PDF read crosses the session threshold', async () => {
    const env = buildEnv({
      envOverrides: {
        CHAT_SA_KEY_JSON: fixtureSaKeyJson(),
        COST_GUARD_SESSION_THRESHOLDS_USD: '0.1,8,12,16',
      },
    });
    const msg = buildQueueMsg({
      text: 'このPDFを短く説明してください。',
      threadName: 'spaces/AAA/threads/T1',
      attachment: [
        {
          contentType: 'application/pdf',
          contentName: 'issue214-small.pdf',
          source: 'UPLOADED_CONTENT',
          attachmentDataRef: { resourceName: 'spaces/AAA/messages/M1/attachments/A1' },
        },
      ],
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    const createCapture: unknown[] = [];
    const sendCaptureSessionIds: string[] = [];
    installFakeAnthropic({
      sessionId: 'sesn_should_not_be_created',
      createCapture,
      sendCaptureSessionIds,
      events: [{ type: 'session.status_idle' }],
    });

    const fakePdf = makeMinimalPdf(1);
    const origFetch = globalThis.fetch;
    const fetchMock = makeFetchMock(async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(
          JSON.stringify({ access_token: 'test-token', expires_in: 3600, token_type: 'Bearer' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith('https://chat.googleapis.com/v1/spaces/AAA/messages')) {
        return new Response(JSON.stringify({ messages: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('https://chat.googleapis.com/v1/media/')) {
        return new Response(fakePdf, {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-length': String(fakePdf.byteLength),
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await handleChatEvent(env, {} as ExecutionContext, msg);
      expect(result.kind).toBe('committed');
      expect(chatApiMock.posts).toHaveLength(1);
      expect(chatApiMock.posts[0]!.text).toContain('PDF事前確認');
      expect(chatApiMock.posts[0]!.text).toContain('Cost Guard確認ライン');
      expect(chatApiMock.posts[0]!.text).toContain('読む場合は「はい」');
      expect(chatApiMock.posts[0]!.text).not.toContain('全文で進めて');
      expect(createCapture).toEqual([]);
      expect(sendCaptureSessionIds).toEqual([]);
      expect(chatApiMock.patches).toEqual([]);
      const runtimeEvents = (env.DB as unknown as {
        _tables: { cma_worker_runtime_events: Array<{ event_type?: string }> };
      })._tables.cma_worker_runtime_events.map((row) => row.event_type);
      expect(runtimeEvents).toContain('pdf_preflight_result');
      expect(runtimeEvents).not.toContain('prompt_envelope_built');
      expect(runtimeEvents).not.toContain('cma_session_created');
      expect(fetchMock.calls.map((c) => c.url)).toContain(
        'https://chat.googleapis.com/v1/media/spaces/AAA/messages/M1/attachments/A1?alt=media',
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('PDF preflight approval reuses the pending attachment without requiring reattachment', async () => {
    const env = buildEnv({
      envOverrides: {
        CHAT_SA_KEY_JSON: fixtureSaKeyJson(),
        COST_GUARD_SESSION_THRESHOLDS_USD: '0.1,0.2,8,12,16',
      },
    });
    const first = buildQueueMsg({
      text: 'このPDFを短く説明してください。',
      threadName: 'spaces/AAA/threads/T1',
      attachment: [
        {
          contentType: 'application/pdf',
          contentName: 'issue214-small.pdf',
          source: 'UPLOADED_CONTENT',
          attachmentDataRef: { resourceName: 'spaces/AAA/messages/M1/attachments/A1' },
        },
      ],
    });
    const second = buildQueueMsg({
      text: 'はい',
      threadName: 'spaces/AAA/threads/T1',
    });
    second.eventKey = 'chat:msgname:spaces/AAA/messages/M2';
    second.payload.message.name = 'spaces/AAA/messages/M2';
    await preClaim(env, first.eventKey, first.claim.owner);
    await preClaim(env, second.eventKey, second.claim.owner);
    await putMapping(env, 'alice@example.com');

    const createCapture: unknown[] = [];
    const sendCaptureSessionIds: string[] = [];
    installFakeAnthropic({
      sessionId: 'sesn_pdf_approved',
      createCapture,
      sendCaptureSessionIds,
      retrieveUsage: { input_tokens: 52_000, output_tokens: 0 },
      retrieveModel: 'claude-opus-4-7',
      events: [
        { type: 'agent.message.text', text: 'PDF summary ok' },
        { type: 'session.status_idle' },
      ],
    });

    const fakePdf = makeMinimalPdf(1);
    const origFetch = globalThis.fetch;
    const fetchMock = makeFetchMock(async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(
          JSON.stringify({ access_token: 'test-token', expires_in: 3600, token_type: 'Bearer' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith('https://chat.googleapis.com/v1/spaces/AAA/messages')) {
        return new Response(JSON.stringify({ messages: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('https://chat.googleapis.com/v1/media/')) {
        return new Response(fakePdf, {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-length': String(fakePdf.byteLength),
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const firstResult = await handleChatEvent(env, {} as ExecutionContext, first);
      expect(firstResult.kind).toBe('committed');
      expect(chatApiMock.posts[0]!.text).toContain('PDF事前確認');
      expect(chatApiMock.posts[0]!.text).toContain('読む場合は「はい」');
      expect(createCapture).toEqual([]);

      const secondResult = await handleChatEvent(env, {} as ExecutionContext, second);
      expect(secondResult.kind).toBe('committed');
      expect(createCapture).toHaveLength(1);
      expect(sendCaptureSessionIds).toEqual(['sesn_pdf_approved']);
      expect(chatApiMock.patches.at(-1)!.text).toContain('PDF summary ok');
      expect(chatApiMock.patches.at(-1)!.text).not.toContain('Cost Guard 確認');
      const runtimeEvents = (env.DB as unknown as {
        _tables: { cma_worker_runtime_events: Array<{ event_type?: string }> };
      })._tables.cma_worker_runtime_events.map((row) => row.event_type);
      expect(runtimeEvents).toContain('pdf_preflight_approval_consumed');
      expect(runtimeEvents).toContain('prompt_envelope_built');
      expect(fetchMock.calls.filter((c) => c.url.startsWith('https://chat.googleapis.com/v1/media/')))
        .toHaveLength(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

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
      // placeholder POST + PATCH update (= #186 UX 致命傷 fix)。
      const postsToSpace = chatApiMock.posts.filter((p) => p.spaceName === 'spaces/AAA');
      expect(postsToSpace).toHaveLength(1);
      expect(postsToSpace[0]!.text).toBe('... MAKOTOくんが入力中');
      // 最終 reply は PATCH 経由で placeholder を書き換える。
      expect(chatApiMock.patches).toHaveLength(1);
      expect(chatApiMock.patches[0]!.text).toContain('了解しました');
      expect(chatApiMock.patches[0]!.text).toContain('✅ メール送信完了');
      expect(chatApiMock.patches[0]!.text).toContain('宛先: alice@example.com');
      expect(chatApiMock.patches[0]!.text).toContain('件名: Re');
      expect(chatApiMock.patches[0]!.text).not.toContain('EMAIL_SEND');
      expect(chatApiMock.patches[0]!.messageName).toBe('spaces/AAA/messages/m_1');
      // sent_messages 行
      const sent = (env.DB as unknown as { _tables: { sent_messages: Map<string, unknown> } })
        ._tables.sent_messages;
      expect(sent.size).toBe(1);
      expect(
        (Array.from(sent.values())[0] as { auto_reply_policy?: string }).auto_reply_policy,
      ).toBe('chat_user_requested');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('Case 1-async-wait: mail send + reply-wait request registers heartbeat async_wait task', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({
      text:
        'alice@example.com と bob@example.com に確認メールを送って、返信が揃ったら集計して再開してください。',
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_async_wait_register',
      events: [
        {
          type: 'agent.message.text',
          text:
            '送信します。\n' +
            'EMAIL_SEND:{"to":"alice@example.com","subject":"#245 async wait","body":"返信してください"}\n' +
            'EMAIL_SEND:{"to":"bob@example.com","subject":"#245 async wait","body":"返信してください"}',
        },
        { type: 'session.status_idle' },
      ],
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async () =>
      new Response(JSON.stringify({ message_id: `msg_out_${Math.random()}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    try {
      const result = await handleChatEvent(env, {} as ExecutionContext, msg);
      expect(result.kind).toBe('committed');
      const tasks = (env.DB as unknown as { _tables: { heartbeat_tasks: Map<string, Record<string, unknown>> } })
        ._tables.heartbeat_tasks;
      expect(tasks.size).toBe(1);
      const task = Array.from(tasks.values())[0]!;
      expect(task.kind).toBe('async_wait');
      expect(task.status).toBe('waiting');
      expect(task.waiting_for).toBe('mail_reply');
      expect(task.target_space_name).toBe('spaces/AAA');
      expect(JSON.parse(String(task.thread_ref))).toMatchObject({
        expected_from: ['alice@example.com', 'bob@example.com'],
        subject_contains: '#245 async wait',
      });
      expect(chatApiMock.patches.at(-1)?.text).toContain('⏳ 返信待ちを登録しました');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('Case 1-mail-intent: short content mail request injects scoped mail instructions', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({
      text: 'k.seto@makotoprime.com にこんにちはメールを送って',
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    const payloads: unknown[] = [];
    installFakeAnthropic({
      sessionId: 'sesn_mail_intent',
      sendCapturePayloads: payloads,
      events: [
        {
          type: 'agent.message.text',
          text:
            '送信します。\nEMAIL_SEND:{"to":"k.seto@makotoprime.com","subject":"こんにちは","body":"こんにちは"}',
        },
        { type: 'session.status_idle' },
      ],
    });

    const amCalls: unknown[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async (url, init) => {
      amCalls.push({ url, body: init.body });
      return new Response(JSON.stringify({ message_id: 'msg_out_mail' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      const result = await handleChatEvent(env, {} as ExecutionContext, msg);
      expect(result.kind).toBe('committed');
      expect(payloads).toHaveLength(1);
      const payloadText = JSON.stringify(payloads[0]);
      expect(payloadText).toContain('<intent>command=/mail source=mail_intent action_skill=true</intent>');
      expect(payloadText).toContain('<mail_intent_instructions>');
      expect(payloadText).toContain('「こんにちはメール」は件名「こんにちは」、本文「こんにちは」で足りる');
      expect(amCalls).toHaveLength(1);
      expect(chatApiMock.patches.at(-1)?.text).toContain('✅ メール送信完了');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('DM thread history is fetched and included like shared space history', async () => {
    const env = buildEnv({
      envOverrides: {
        GCHAT_OAUTH_REFRESH_TOKEN_SEED: 'seed-refresh-token',
        GCHAT_OAUTH_CLIENT_ID: 'chat-client-id.apps.googleusercontent.com',
        GCHAT_OAUTH_CLIENT_SECRET: 'chat-client-secret',
        OAUTH_VAULT_KEY: TEST_VAULT_KEY_B64,
      },
    });
    const msg = buildQueueMsg({
      spaceType: 'DM',
      spaceName: 'spaces/DM1',
      threadName: 'spaces/DM1/threads/T1',
      text: '適当に返しといて',
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    const payloads: unknown[] = [];
    installFakeAnthropic({
      sessionId: 'sesn_dm_history',
      sendCapturePayloads: payloads,
      events: [
        { type: 'agent.message.text', text: '履歴を見て返信します。' },
        { type: 'session.status_idle' },
      ],
    });

    const calls: Array<{ url: string; auth?: string; body?: string }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async (url, init) => {
      calls.push({
        url,
        auth: (init.headers as Record<string, string> | undefined)?.Authorization,
        body: typeof init.body === 'string' ? init.body : undefined,
      });
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(
          JSON.stringify({
            access_token: 'user-oauth-access-token',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith('https://chat.googleapis.com/v1/spaces/DM1/messages')) {
        return new Response(
          JSON.stringify({
            messages: [
              {
                name: 'spaces/DM1/messages/BOT_NOTICE',
                text: '📨 新規問い合わせ (cold inbound)\nFrom: Keisuke Seto <k.seto@makotoprime.com>\n件名: test06010820\n本文 preview:\ntest',
                sender: { name: 'users/BOT', type: 'BOT' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch;

    try {
      const result = await handleChatEvent(env, {} as ExecutionContext, msg);
      expect(result.kind).toBe('committed');
      const historyCall = calls.find((c) =>
        c.url.startsWith('https://chat.googleapis.com/v1/spaces/DM1/messages'),
      );
      expect(historyCall?.auth).toBe('Bearer user-oauth-access-token');
      expect(payloads).toHaveLength(1);
      const payloadText = JSON.stringify(payloads[0]);
      expect(payloadText).toContain('## スレッド過去履歴');
      expect(payloadText).toContain('📨 新規問い合わせ (cold inbound)');
      expect(payloadText).toContain('test06010820');
      expect(payloadText).toContain('適当に返しといて');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('Case 1b: AgentMail API failure → status-aware failure is shown', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_1b',
      events: [
        {
          type: 'agent.message.text',
          text:
            '送ります。\nEMAIL_SEND:{"to":"alice@example.com","subject":"Re","body":"返信本文"}',
        },
        { type: 'session.status_idle' },
      ],
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async () =>
      new Response('unauthorized', { status: 401 }),
    ) as unknown as typeof fetch;

    try {
      const result = await handleChatEvent(env, {} as ExecutionContext, msg);
      expect(result.kind).toBe('committed');
      expect(chatApiMock.patches).toHaveLength(1);
      expect(chatApiMock.patches[0]!.text).toContain('❌ メール送信失敗');
      expect(chatApiMock.patches[0]!.text).toContain('理由: AgentMail 認証エラー (401)');
      const sent = (env.DB as unknown as { _tables: { sent_messages: Map<string, unknown> } })
        ._tables.sent_messages;
      expect(sent.size).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('Case 1c: EMAIL_SEND preview text renders escaped newlines as real newlines', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_1c',
      events: [
        {
          type: 'agent.message.text',
          text:
            '以下の内容で送ります。\n\n宛先: alice@example.com\n件名: Re\n本文: 1行目\\n2行目\nEMAIL_SEND:{"to":"alice@example.com","subject":"Re","body":"1行目\\n2行目"}',
        },
        { type: 'session.status_idle' },
      ],
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async () =>
      new Response(JSON.stringify({ message_id: 'msg_preview' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    try {
      const result = await handleChatEvent(env, {} as ExecutionContext, msg);
      expect(result.kind).toBe('committed');
      expect(chatApiMock.patches).toHaveLength(1);
      expect(chatApiMock.patches[0]!.text).toContain('本文: 1行目\n2行目');
      expect(chatApiMock.patches[0]!.text).not.toContain('1行目\\n2行目');
      expect(chatApiMock.patches[0]!.text).toContain('✅ メール送信完了');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('Case 1b: AgentMail API failure → status-aware failure is shown', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_1b',
      events: [
        {
          type: 'agent.message.text',
          text:
            '送ります。\nEMAIL_SEND:{"to":"alice@example.com","subject":"Re","body":"返信本文"}',
        },
        { type: 'session.status_idle' },
      ],
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async () =>
      new Response('unauthorized', { status: 401 }),
    ) as unknown as typeof fetch;

    try {
      const result = await handleChatEvent(env, {} as ExecutionContext, msg);
      expect(result.kind).toBe('committed');
      expect(chatApiMock.patches).toHaveLength(1);
      expect(chatApiMock.patches[0]!.text).toContain('❌ メール送信失敗');
      expect(chatApiMock.patches[0]!.text).toContain('理由: AgentMail 認証エラー (401)');
      const sent = (env.DB as unknown as { _tables: { sent_messages: Map<string, unknown> } })
        ._tables.sent_messages;
      expect(sent.size).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('Case 1c: EMAIL_SEND preview text renders escaped newlines as real newlines', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_1c',
      events: [
        {
          type: 'agent.message.text',
          text:
            '以下の内容で送ります。\n\n宛先: alice@example.com\n件名: Re\n本文: 1行目\\n2行目\nEMAIL_SEND:{"to":"alice@example.com","subject":"Re","body":"1行目\\n2行目"}',
        },
        { type: 'session.status_idle' },
      ],
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async () =>
      new Response(JSON.stringify({ message_id: 'msg_preview' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    try {
      const result = await handleChatEvent(env, {} as ExecutionContext, msg);
      expect(result.kind).toBe('committed');
      expect(chatApiMock.patches).toHaveLength(1);
      expect(chatApiMock.patches[0]!.text).toContain('本文: 1行目\n2行目');
      expect(chatApiMock.patches[0]!.text).not.toContain('1行目\\n2行目');
      expect(chatApiMock.patches[0]!.text).toContain('✅ メール送信完了');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('Case 2: shared space + bot mention あり → 同経路で committed', async () => {
    const env = buildEnv();
    // annotations-based 厳密 mention (= Python `_is_for_bot` 等価)。
    // `@MAKOTOくん` (= 9 UTF-16 code units) を範囲とする USER_MENTION。
    // strip 後は ' 簡単な質問です' → trim → '簡単な質問です'。
    const msg = buildQueueMsg({
      spaceType: 'ROOM',
      spaceName: 'spaces/ROOM1',
      text: '@MAKOTOくん 簡単な質問です',
      threadName: 'spaces/ROOM1/threads/T1',
      annotations: [
        {
          type: 'USER_MENTION',
          startIndex: 0,
          length: 9,
          userMention: { user: { type: 'BOT', name: 'users/123' } },
        },
      ],
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
    // placeholder POST 1 件 + 最終 reply は PATCH。
    const postsToSpace = chatApiMock.posts.filter((p) => p.spaceName === 'spaces/ROOM1');
    expect(postsToSpace).toHaveLength(1);
    expect(postsToSpace[0]!.text).toBe('... MAKOTOくんが入力中');
    expect((postsToSpace[0]!.opts as { threadName?: string }).threadName).toBe(
      'spaces/ROOM1/threads/T1',
    );
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toBe('ご質問への回答です。');
  });

  it('uploads session output xlsx to Drive and removes sandbox path from Chat reply', async () => {
    const env = buildEnv({
      envOverrides: {
        OAUTH_VAULT_KEY: TEST_VAULT_KEY_B64,
        OAUTH_CLIENT_ID: 'cid',
        OAUTH_CLIENT_SECRET: 'csec',
        MAKOTO_OAUTH_LEASE: makeFakeOAuthLeaseNamespace(),
      },
    });
    await putRefreshToken(env.MAKOTO_KV, TEST_VAULT_KEY_B64, 'alice', 'refresh-token');
    const msg = buildQueueMsg({
      text: 'xlsx skillで issue247.xlsx を作って',
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_output_xlsx',
      events: [
        {
          type: 'agent.message.text',
          text:
            'できました。\n出力先: /mnt/session/outputs/issue247.xlsx',
        },
        { type: 'session.status_idle' },
      ],
    });

    const uploadCalls: Array<{ auth: string | null; body: string }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async (url, init) => {
      if (url === 'https://api.anthropic.com/v1/files?scope_id=sesn_output_xlsx&limit=20') {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'file_xlsx_1',
                filename: 'issue247.xlsx',
                mime_type:
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                size_bytes: 4830,
                downloadable: true,
                created_at: new Date().toISOString(),
                scope: { type: 'session', id: 'sesn_output_xlsx' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'drive-access', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://api.anthropic.com/v1/files/file_xlsx_1/content') {
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200 });
      }
      if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
        const body = init.body as Blob;
        uploadCalls.push({
          auth: (init.headers as Headers).get('Authorization'),
          body: await body.text(),
        });
        return new Response(
          JSON.stringify({
            id: 'drive-file-1',
            name: 'issue247.xlsx',
            webViewLink: 'https://docs.google.com/spreadsheets/d/drive-file-1/edit',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch;

    try {
      const result = await handleChatEvent(env, {} as ExecutionContext, msg);
      expect(result.kind).toBe('committed');
      expect(uploadCalls).toHaveLength(1);
      expect(uploadCalls[0]!.auth).toBe('Bearer drive-access');
      expect(uploadCalls[0]!.body).toContain('issue247.xlsx');
      const finalReply = chatApiMock.patches.at(-1)?.text ?? chatApiMock.posts.at(-1)?.text ?? '';
      expect(finalReply).toContain('*Driveに保存しました*');
      expect(finalReply).toContain('https://docs.google.com/spreadsheets/d/drive-file-1/edit');
      expect(finalReply).toContain('issue247.xlsx');
      expect(finalReply).not.toContain('/mnt/session/outputs');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('uploads session output xlsx when only the user prompt names the file', async () => {
    const env = buildEnv({
      envOverrides: {
        OAUTH_VAULT_KEY: TEST_VAULT_KEY_B64,
        OAUTH_CLIENT_ID: 'cid',
        OAUTH_CLIENT_SECRET: 'csec',
        MAKOTO_OAUTH_LEASE: makeFakeOAuthLeaseNamespace(),
      },
    });
    await putRefreshToken(env.MAKOTO_KV, TEST_VAULT_KEY_B64, 'alice', 'refresh-token');
    const msg = buildQueueMsg({
      text:
        'xlsx skill を使って A1 に「issue-247 drive ok」と入った最小の Excel を作ってください。ファイル名は issue247-drive-e2e.xlsx。',
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_output_xlsx_hint',
      events: [
        {
          type: 'agent.message.text',
          text: 'できました。',
        },
        { type: 'session.status_idle' },
      ],
    });

    const uploadCalls: Array<{ auth: string | null; body: string }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async (url, init) => {
      if (url === 'https://api.anthropic.com/v1/files?scope_id=sesn_output_xlsx_hint&limit=20') {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'file_xlsx_hint_1',
                filename: 'issue247-drive-e2e.xlsx',
                mime_type:
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                size_bytes: 4830,
                downloadable: true,
                created_at: new Date().toISOString(),
                scope: { type: 'session', id: 'sesn_output_xlsx_hint' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'drive-access', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://api.anthropic.com/v1/files/file_xlsx_hint_1/content') {
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200 });
      }
      if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
        const body = init.body as Blob;
        uploadCalls.push({
          auth: (init.headers as Headers).get('Authorization'),
          body: await body.text(),
        });
        return new Response(
          JSON.stringify({
            id: 'drive-file-hint-1',
            name: 'issue247-drive-e2e.xlsx',
            webViewLink: 'https://docs.google.com/spreadsheets/d/drive-file-hint-1/edit',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch;

    try {
      const result = await handleChatEvent(env, {} as ExecutionContext, msg);
      expect(result.kind).toBe('committed');
      expect(uploadCalls).toHaveLength(1);
      expect(uploadCalls[0]!.auth).toBe('Bearer drive-access');
      expect(uploadCalls[0]!.body).toContain('issue247-drive-e2e.xlsx');
      const finalReply = chatApiMock.patches.at(-1)?.text ?? chatApiMock.posts.at(-1)?.text ?? '';
      expect(finalReply).toContain('*Driveに保存しました*');
      expect(finalReply).toContain('https://docs.google.com/spreadsheets/d/drive-file-hint-1/edit');
      expect(finalReply).toContain('issue247-drive-e2e.xlsx');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('Case 2b: shared thread history uses User OAuth token instead of service account', async () => {
    const env = buildEnv({
      envOverrides: {
        GCHAT_OAUTH_REFRESH_TOKEN_SEED: 'seed-refresh-token',
        GCHAT_OAUTH_CLIENT_ID: 'chat-client-id.apps.googleusercontent.com',
        GCHAT_OAUTH_CLIENT_SECRET: 'chat-client-secret',
        OAUTH_VAULT_KEY: TEST_VAULT_KEY_B64,
      },
    });
    const msg = buildQueueMsg({
      spaceType: 'ROOM',
      spaceName: 'spaces/ROOM2',
      text: '@MAKOTOくん 続きお願い',
      threadName: 'spaces/ROOM2/threads/T2',
      annotations: [
        {
          type: 'USER_MENTION',
          startIndex: 0,
          length: 9,
          userMention: { user: { type: 'BOT', name: 'users/123' } },
        },
      ],
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_2b',
      events: [
        { type: 'agent.message.text', text: '履歴を踏まえた回答です。' },
        { type: 'session.status_idle' },
      ],
    });

    const calls: Array<{ url: string; auth?: string; body?: string }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async (url, init) => {
      calls.push({
        url,
        auth: (init.headers as Record<string, string> | undefined)?.Authorization,
        body: typeof init.body === 'string' ? init.body : undefined,
      });
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(
          JSON.stringify({
            access_token: 'user-oauth-access-token',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith('https://chat.googleapis.com/v1/spaces/ROOM2/messages')) {
        return new Response(
          JSON.stringify({
            messages: [
              {
                name: 'spaces/ROOM2/messages/M0',
                text: '前の発言',
                sender: { name: 'users/456', type: 'HUMAN' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch;

    try {
      const result = await handleChatEvent(env, {} as ExecutionContext, msg);
      expect(result.kind).toBe('committed');
      const tokenCall = calls.find((c) => c.url === 'https://oauth2.googleapis.com/token');
      expect(tokenCall?.body).toContain('grant_type=refresh_token');
      const historyCall = calls.find((c) =>
        c.url.startsWith('https://chat.googleapis.com/v1/spaces/ROOM2/messages'),
      );
      expect(historyCall?.auth).toBe('Bearer user-oauth-access-token');
    } finally {
      globalThis.fetch = origFetch;
    }
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
    const decision = commitDecision(env, 'not_for_bot');
    expect(decision).toBeDefined();
    expect(JSON.parse(String(decision!.detail_json))).toMatchObject({
      stage: 'bot_mention_filter',
      outcome: 'skipped',
      commit_ok: true,
    });
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
    const decision = commitDecision(env, 'bot_sender');
    expect(decision).toBeDefined();
    expect(JSON.parse(String(decision!.detail_json))).toMatchObject({
      stage: 'sender_filter',
      outcome: 'skipped',
      commit_ok: true,
    });
  });

  it('message field 不在 → no_message skip + commit 理由を D1 に残す', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    (msg.payload as { message?: unknown }).message = undefined;
    await preClaim(env, msg.eventKey, msg.claim.owner);

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') expect(result.reason).toBe('no_message');
    const decision = commitDecision(env, 'no_message');
    expect(decision).toBeDefined();
    expect(JSON.parse(String(decision!.detail_json))).toMatchObject({
      stage: 'payload_extract',
      outcome: 'skipped',
      commit_ok: true,
    });
  });

  it('Case 5: body 空 + thread あり → mention-only 指示文で agent に渡し継続', async () => {
    const env = buildEnv();
    // annotations-based 厳密 mention のみ (本文無し)。strip 後 bodyText が
    // 空になり、thread 有 → mention-only 指示文へ。
    const msg = buildQueueMsg({
      spaceType: 'ROOM',
      spaceName: 'spaces/ROOM1',
      text: '@MAKOTOくん',
      threadName: 'spaces/ROOM1/threads/T1',
      annotations: [
        {
          type: 'USER_MENTION',
          startIndex: 0,
          length: 9,
          userMention: { user: { type: 'BOT', name: 'users/123' } },
        },
      ],
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
    // placeholder POST 1 件 + 最終 reply は PATCH (= #186 UX 致命傷 fix)。
    expect(chatApiMock.posts).toHaveLength(1);
    expect(chatApiMock.posts[0]!.text).toBe('... MAKOTOくんが入力中');
    expect(chatApiMock.patches).toHaveLength(1);
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
    const decision = commitDecision(env, 'empty_message_reply_posted');
    expect(decision).toBeDefined();
    expect(JSON.parse(String(decision!.detail_json))).toMatchObject({
      stage: 'mention_strip',
      outcome: 'committed',
      commit_ok: true,
    });
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
    // CHAT_POST 投稿 1 件 + placeholder POST 1 件 (current space)
    // 最終 reply (= "了解しました...") は PATCH 経由で placeholder を書き換え。
    const otherPosts = chatApiMock.posts.filter((p) => p.spaceName === 'spaces/OTHER');
    const currentPosts = chatApiMock.posts.filter((p) => p.spaceName === 'spaces/AAA');
    expect(otherPosts).toHaveLength(1);
    expect(otherPosts[0]!.text).toBe('別スペースへの本文');
    expect(currentPosts).toHaveLength(1);
    expect(currentPosts[0]!.text).toBe('... MAKOTOくんが入力中');
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toContain('了解しました');
    expect(chatApiMock.patches[0]!.text).not.toContain('CHAT_POST:');
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
      // placeholder POST 1 件 (= "...MAKOTOくんが入力中") + 最終 reply は PATCH。
      expect(chatApiMock.posts.filter((p) => p.spaceName === 'spaces/AAA')).toHaveLength(1);
      expect(chatApiMock.patches).toHaveLength(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('heartbeat event: external action markers are stripped without dispatch', async () => {
    const env = buildEnv({
      envOverrides: {
        GCP_SCHEDULER_PROJECT: 'test-project',
        GCP_SCHEDULER_LOCATION: 'asia-northeast1',
      },
    });
    const msg = buildQueueMsg({
      eventKey: 'scheduled:heartbeat_tick:news_check_seto:987654',
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_heartbeat_action_markers',
      events: [
        {
          type: 'agent.message.text',
          text:
            '報告があります。\n' +
            'EMAIL_SEND:{"to":"a@example.com","subject":"s","body":"b"}\n' +
            'CHAT_POST:{"space":"spaces/OTHER","text":"別投稿"}\n' +
            'SCHEDULE_ACTION:{"action":"list"}',
        },
        { type: 'session.status_idle' },
      ],
    });

    const amCalls: unknown[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock(async (_url, init) => {
      amCalls.push(init);
      return new Response(JSON.stringify({ message_id: 'should-not-send' }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const result = await handleChatEvent(env, {} as ExecutionContext, msg);
      expect(result.kind).toBe('committed');
      expect(amCalls).toHaveLength(0);
      expect(schedulerMock.capturedCalls).toHaveLength(0);
      expect(chatApiMock.posts.filter((p) => p.spaceName === 'spaces/OTHER')).toHaveLength(0);
      expect(chatApiMock.posts.filter((p) => p.spaceName === 'spaces/AAA')).toHaveLength(1);
      expect(chatApiMock.patches).toHaveLength(1);
      expect(chatApiMock.patches[0]!.text).toContain('報告があります。');
      expect(chatApiMock.patches[0]!.text).not.toContain('EMAIL_SEND');
      expect(chatApiMock.patches[0]!.text).not.toContain('CHAT_POST');
      expect(chatApiMock.patches[0]!.text).not.toContain('SCHEDULE_ACTION');

      const gated = runtimeEvents(env)
        .filter((row) => row.event_type === 'external_tool_gated')
        .map((row) => JSON.parse(String(row.detail_json)) as { tool_family: string });
      expect(gated.map((row) => row.tool_family).sort()).toEqual([
        'CHAT_POST',
        'EMAIL_SEND',
        'SCHEDULE_ACTION',
      ]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('Case 9: 内部状態漏洩語 → maskInternalStateForChat で本文を保持', async () => {
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
    // placeholder POST 1 件 → 最終回答は固定エラー化せず、該当語だけ伏せて PATCH。
    const post = chatApiMock.posts.find((p) => p.spaceName === 'spaces/AAA');
    expect(post).toBeDefined();
    expect(post!.text).toBe('... MAKOTOくんが入力中');
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toContain('対応できません');
    expect(chatApiMock.patches[0]!.text).toContain('内部運用表現を一部伏せました');
    expect(chatApiMock.patches[0]!.text).not.toContain('今回のタスクは完了できませんでした');
    expect(chatApiMock.patches[0]!.text).not.toContain('memory store');
  });

  it('Case 9b: action marker leakage without a parsed marker redacts internal terms without failure text', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_9b',
      events: [
        {
          type: 'agent.message.text',
          text: '前のメッセージですでに `EMAIL_SEND` マーカーを出しています。bot 側で処理中です。',
        },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toContain('前のメッセージ');
    expect(chatApiMock.patches[0]!.text).toContain('内部用マーカー');
    expect(chatApiMock.patches[0]!.text).not.toContain('EMAIL_SEND');
    expect(chatApiMock.patches[0]!.text).not.toContain('bot');
    expect(chatApiMock.patches[0]!.text).not.toContain('担当者がログ');
  });

  it('Case 9c: architecture explanation may mention marker names without being replaced', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_9c',
      events: [
        {
          type: 'agent.message.text',
          text:
            'わかります！system prompt と memory から答えます。\n\n' +
            '*僕のアーキテクチャ*\n' +
            '- `/mnt/memory/` 配下に記憶があります\n' +
            '- CHAT_POST マーカー（別スペースへの投稿）\n' +
            '- SCHEDULE_ACTION マーカー（ジョブ登録）',
        },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toContain('僕のアーキテクチャ');
    expect(chatApiMock.patches[0]!.text).toContain('CHAT_POST マーカー');
    expect(chatApiMock.patches[0]!.text).toContain('SCHEDULE_ACTION マーカー');
    expect(chatApiMock.patches[0]!.text).toContain('社内記憶');
    expect(chatApiMock.patches[0]!.text).not.toContain('/mnt/memory');
    expect(chatApiMock.patches[0]!.text).not.toContain(
      '送信処理の状態を確認できませんでした',
    );
  });

  it('Case 9d: tool inventory may say action markers are executed bot-side', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_9d',
      events: [
        {
          type: 'agent.message.text',
          text:
            '*▼ 使えるツール*\n\n' +
            '*アクションマーカー（bot 側が実行）*\n' +
            '- `EMAIL_SEND`: AgentMail 送信\n' +
            '- `CHAT_POST`: 別スペース投稿\n' +
            '- `SCHEDULE_ACTION`: Cloud Scheduler ジョブ管理',
        },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toContain('アクションマーカー');
    expect(chatApiMock.patches[0]!.text).toContain('EMAIL_SEND');
    expect(chatApiMock.patches[0]!.text).not.toContain(
      '送信処理の状態を確認できませんでした',
    );
  });

  it('Case 9e: tool inventory may describe marker names with colons', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_9e',
      events: [
        {
          type: 'agent.message.text',
          text:
            '*アクションマーカー（bot 側で実行）*\n\n' +
            '- EMAIL_SEND: 送信（live 確認済み）\n' +
            '- CHAT_POST: 別スペース投稿（live 確認済み）\n' +
            '- SCHEDULE_ACTION: ジョブ管理',
        },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toContain('EMAIL_SEND: 送信');
    expect(chatApiMock.patches[0]!.text).toContain('CHAT_POST: 別スペース投稿');
    expect(chatApiMock.patches[0]!.text).not.toContain(
      '送信処理の状態を確認できませんでした',
    );
  });

  it('Case 10: 既存 session 解決 (KV hit) → sessions.create skip', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({
      spaceType: 'ROOM',
      spaceName: 'spaces/ROOM10',
      text: '@MAKOTOくん 続きの質問',
      threadName: 'spaces/ROOM10/threads/T10',
      annotations: [
        {
          type: 'USER_MENTION',
          startIndex: 0,
          length: 9,
          userMention: { user: { type: 'BOT', name: 'users/123' } },
        },
      ],
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');
    // pre-populate KV with existing session for this thread + current skills set.
    const sessionKey = chatThreadSessionKey(
      'alice@example.com',
      'spaces/ROOM10',
      'spaces/ROOM10/threads/T10',
      await buildChatCapabilitySessionKey(env),
    );
    expect(sessionKey).not.toBeNull();
    await env.MAKOTO_KV.put(sessionKey!, 'sesn_existing');

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

  it('Case 10b: broad scope KV hit は無視し、新しい Chat thread は新規 session', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({
      spaceType: 'ROOM',
      spaceName: 'spaces/ROOM10',
      text: '@MAKOTOくん 続きの質問',
      threadName: 'spaces/ROOM10/threads/T11',
      annotations: [
        {
          type: 'USER_MENTION',
          startIndex: 0,
          length: 9,
          userMention: { user: { type: 'BOT', name: 'users/123' } },
        },
      ],
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');
    const scopeKey = 'chat_scope_session:agent_001:space:spaces/ROOM10';
    await env.MAKOTO_KV.put(scopeKey, 'sesn_old_scope');

    const created: unknown[] = [];
    const sends: string[] = [];
    installFakeAnthropic({
      sessionId: 'sesn_new_thread',
      createCapture: created,
      sendCaptureSessionIds: sends,
      events: [
        { type: 'agent.message.text', text: '続きへの応答です。' },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(created).toHaveLength(1);
    expect(sends).toEqual(['sesn_new_thread']);
    expect(await env.MAKOTO_KV.get(scopeKey)).toBe('sesn_old_scope');
    const threadKey = chatThreadSessionKey(
      'alice@example.com',
      'spaces/ROOM10',
      'spaces/ROOM10/threads/T11',
      await buildChatCapabilitySessionKey(env),
    );
    expect(threadKey).not.toBeNull();
    expect(await env.MAKOTO_KV.get(threadKey!)).toBe('sesn_new_thread');
  });

  it('attachment turn follows Chat thread session and ignores broad DM scope session', async () => {
    const env = buildEnv({
      envOverrides: {
        CHAT_SA_KEY_JSON: undefined,
      } as Partial<Env>,
    });
    const scopeKey = 'chat_scope_session:agent_001:dm:alice@example.com';
    const threadKey = chatThreadSessionKey(
      'alice@example.com',
      'spaces/AAA',
      'spaces/AAA/threads/TATT',
      await buildChatCapabilitySessionKey(env),
    );
    expect(threadKey).not.toBeNull();
    await env.MAKOTO_KV.put(scopeKey, 'sesn_existing');
    await env.MAKOTO_KV.put(threadKey!, 'sesn_thread_existing');
    const msg = buildQueueMsg({
      threadName: 'spaces/AAA/threads/TATT',
      attachment: [
        {
          contentName: 'issue198-small-pdf-test.pdf',
          contentType: 'application/pdf',
          attachmentDataRef: { resourceName: 'spaces/AAA/messages/M1/attachments/A1' },
        },
      ],
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    const created: unknown[] = [];
    const sends: string[] = [];
    installFakeAnthropic({
      sessionId: 'sesn_attachment_new',
      createCapture: created,
      sendCaptureSessionIds: sends,
      events: [
        { type: 'agent.message.text', text: '添付を読みました。' },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);

    expect(result.kind).toBe('committed');
    expect(created).toHaveLength(0);
    expect(sends).toEqual(['sesn_thread_existing']);
    expect(await env.MAKOTO_KV.get(scopeKey)).toBe('sesn_existing');
    expect(await env.MAKOTO_KV.get(threadKey!)).toBe('sesn_thread_existing');
  });

  it('same Chat thread lock held → releases claim and retries without posting placeholder', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({ threadName: 'spaces/AAA/threads/TLOCK' });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    const scopeKey =
      'chat_thread_session:alice@example.com:spaces/AAA:spaces/AAA/threads/TLOCK';
    const lock = getThreadLock(env, scopeKey);
    const held = await lock.acquire(scopeKey, 60_000);
    expect(held.acquired).toBe(true);

    installFakeAnthropic({
      sessionId: 'sesn_should_not_be_used',
      events: [{ type: 'agent.message.text', text: 'should not run' }],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);

    expect(result.kind).toBe('release_and_retry');
    if (result.kind === 'release_and_retry') {
      expect(result.reason).toBe('chat_scope_lock_held');
    }
    expect(chatApiMock.posts).toHaveLength(0);
    expect(chatApiMock.patches).toHaveLength(0);
    const dedupe = (env.DB as unknown as { _tables: { dedupe: Map<string, Record<string, unknown>> } })
      ._tables.dedupe;
    const row = dedupe.get(msg.eventKey);
    expect(row?.claim_state).toBe('NEW');
    expect(Number(row?.lease_expires_at_ms)).toBe(0);
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

  it('Case 12: LLM stream throw → release_and_retry without visible notice', async () => {
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
    const dedupe = (env.DB as unknown as { _tables: { dedupe: Map<string, Record<string, unknown>> } })
      ._tables.dedupe;
    const row = dedupe.get(msg.eventKey);
    expect(row?.claim_state).toBe('NEW');
    expect(Number(row?.lease_expires_at_ms)).toBe(0);
    expect(chatApiMock.posts).toHaveLength(1);
    expect(chatApiMock.posts[0]!.text).toBe('... MAKOTOくんが入力中');
    expect(chatApiMock.deletes).toHaveLength(0);
    expect(chatApiMock.patches).toHaveLength(0);
    const runtimeEvents = (env.DB as unknown as {
      _tables: { cma_worker_runtime_events: Array<{ event_type?: string; detail_json?: string }> };
    })._tables.cma_worker_runtime_events;
    expect(runtimeEvents.map((row) => row.event_type)).toContain('orchestrator_transient_retry_no_notice');
    const noticeEvent = runtimeEvents.find(
      (row) => row.event_type === 'orchestrator_transient_retry_no_notice',
    );
    expect(noticeEvent?.detail_json).toContain('stream_failed');
    expect(noticeEvent?.detail_json).toContain('stream connection reset');
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
    // placeholder POST 1 件 + 最終 reply は PATCH (= #186 UX 致命傷 fix)。
    expect(chatApiMock.posts).toHaveLength(1);
    expect(chatApiMock.posts[0]!.text).toBe('... MAKOTOくんが入力中');
    expect(chatApiMock.patches).toHaveLength(1);
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
    const runtimeEvents = (env.DB as unknown as {
      _tables: { cma_worker_runtime_events: Array<Record<string, unknown>> };
    })._tables.cma_worker_runtime_events;
    const skipped = runtimeEvents.find((row) => row.event_type === 'chat_event_skipped');
    expect(skipped).toBeDefined();
    expect(JSON.parse(String(skipped!.detail_json))).toMatchObject({
      reason: 'unknown_sender',
      default_user_slug_configured: false,
    });
    const decision = commitDecision(env, 'unknown_sender');
    expect(decision).toBeDefined();
    expect(JSON.parse(String(decision!.detail_json))).toMatchObject({
      stage: 'sender_mapping_resolve',
      outcome: 'skipped',
      commit_ok: true,
    });
  });

  it('sender email 不在 → no_sender_email skip を D1 runtime event に残す', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({ senderEmail: '' });
    await preClaim(env, msg.eventKey, msg.claim.owner);

    installFakeAnthropic({ events: [] });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') expect(result.reason).toBe('no_sender_email');
    expect(chatApiMock.posts).toHaveLength(0);
    const runtimeEvents = (env.DB as unknown as {
      _tables: { cma_worker_runtime_events: Array<Record<string, unknown>> };
    })._tables.cma_worker_runtime_events;
    const skipped = runtimeEvents.find((row) => row.event_type === 'chat_event_skipped');
    expect(skipped).toBeDefined();
    expect(JSON.parse(String(skipped!.detail_json))).toMatchObject({
      reason: 'no_sender_email',
    });
    const decision = commitDecision(env, 'no_sender_email');
    expect(decision).toBeDefined();
    expect(JSON.parse(String(decision!.detail_json))).toMatchObject({
      stage: 'sender_mapping_resolve',
      outcome: 'skipped',
      commit_ok: true,
    });
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

  it('default fallback actor は応答のみ許可し EMAIL/SCHEDULE/CHAT_POST を gate する', async () => {
    const env = buildEnv({
      envOverrides: {
        DEFAULT_USER_SLUG: 'guest',
        GCP_SCHEDULER_PROJECT: 'test-proj',
        GCP_SCHEDULER_LOCATION: 'asia-northeast1',
      } as Partial<Env>,
    });
    const msg = buildQueueMsg({ senderEmail: 'guest-person@example.com' });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await env.MAKOTO_KV.put(
      'user_mapping:guest',
      JSON.stringify({
        user_slug: 'guest',
        agent_id: 'agent_default',
        memory_attachments: [],
      }),
    );

    installFakeAnthropic({
      sessionId: 'sesn_default_gate',
      events: [
        {
          type: 'agent.message.text',
          text:
            '外部操作します。\n' +
            'EMAIL_SEND:{"to":"a@example.com","subject":"s","body":"b"}\n' +
            'CHAT_POST:{"space":"spaces/OTHER","text":"別投稿"}\n' +
            'SCHEDULE_ACTION:{"action":"list"}',
        },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(chatApiMock.posts.some((p) => p.spaceName === 'spaces/OTHER')).toBe(false);
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toContain('メール送信失敗');
    expect(chatApiMock.patches[0]!.text).toContain(
      '外部連携操作は登録済みユーザーの現在発話でのみ実行します',
    );

    const runtimeEvents = (env.DB as unknown as {
      _tables: { cma_worker_runtime_events: Array<Record<string, unknown>> };
    })._tables.cma_worker_runtime_events;
    const families = runtimeEvents
      .filter((row) => row.event_type === 'external_tool_gated')
      .map((row) => JSON.parse(String(row.detail_json)).tool_family)
      .sort();
    expect(families).toEqual(['CHAT_POST', 'EMAIL_SEND', 'SCHEDULE_ACTION']);
  });

  it('auto pending sender mapping は chat 専用 prefix に作成し外部ツールを gate する', async () => {
    const env = buildEnv({
      envOverrides: {
        DEFAULT_USER_SLUG: 'guest',
        CHAT_AUTO_PENDING_USER_MAPPING_ENABLED: '1',
        GCP_SCHEDULER_PROJECT: 'test-proj',
        GCP_SCHEDULER_LOCATION: 'asia-northeast1',
      } as Partial<Env>,
    });
    const msg = buildQueueMsg({
      senderEmail: 'Intern@Example.com',
      senderName: 'users/777',
      senderDisplayName: 'Intern User',
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await env.MAKOTO_KV.put(
      'user_mapping:guest',
      JSON.stringify({
        user_slug: 'guest',
        agent_id: 'agent_default',
        memory_attachments: [],
      }),
    );

    installFakeAnthropic({
      sessionId: 'sesn_auto_pending',
      events: [
        {
          type: 'agent.message.text',
          text:
            '初回ユーザーにも応答します。\n' +
            'EMAIL_SEND:{"to":"a@example.com","subject":"s","body":"b"}\n' +
            'CHAT_POST:{"space":"spaces/OTHER","text":"別投稿"}',
        },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    const kv = env.MAKOTO_KV as unknown as {
      _store: Map<string, { value: string; metadata?: unknown }>;
    };
    expect(kv._store.has('user_mapping:intern@example.com')).toBe(false);
    expect(kv._store.has('chat_pending_user_mapping:email:intern@example.com')).toBe(true);
    expect(kv._store.has('chat_pending_user_mapping:user:users%2F777')).toBe(true);
    const pending = JSON.parse(
      kv._store.get('chat_pending_user_mapping:email:intern@example.com')!.value,
    );
    expect(pending).toMatchObject({
      user_slug: 'guest',
      agent_id: 'agent_default',
      auto_registered: true,
      actor_trusted: false,
      chat_user_id: 'users/777',
      display_name: 'Intern User',
      mapping_source: 'chat_auto_pending',
    });
    expect(chatApiMock.posts.some((p) => p.spaceName === 'spaces/OTHER')).toBe(false);
    expect(chatApiMock.patches[0]!.text).toContain('初回ユーザーにも応答します');
    expect(chatApiMock.patches[0]!.text).toContain('メール送信失敗');

    const runtimeEvents = (env.DB as unknown as {
      _tables: { cma_worker_runtime_events: Array<Record<string, unknown>> };
    })._tables.cma_worker_runtime_events;
    expect(runtimeEvents.some((row) => row.event_type === 'chat_auto_pending_user_mapping')).toBe(
      true,
    );
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
    // placeholder POST 1 件 → 最終応答は PATCH に「✅ `daily-x` 登録」が含まれる。
    const post = chatApiMock.posts.find((p) => p.spaceName === 'spaces/AAA');
    expect(post).toBeDefined();
    expect(post!.text).toBe('... MAKOTOくんが入力中');
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toContain('登録');
    expect(chatApiMock.patches[0]!.text).toContain('daily-x');
    expect(chatApiMock.patches[0]!.text).not.toContain('SCHEDULE_ACTION:');
  });

  it('natural schedule command: 削除は agent を待たず delete_job に直行する', async () => {
    const env = buildEnv({
      envOverrides: {
        GCP_SCHEDULER_PROJECT: 'test-proj',
        GCP_SCHEDULER_LOCATION: 'asia-northeast1',
      } as Partial<Env>,
    });
    schedulerMock.jobs = [
      {
        job_id: 'morning_ai_news_seto_dm',
        cron: '20 5 * * *',
        handler: 'cma_session',
        description: '毎朝5:20 AIニュース3本 → 瀬戸さんDM',
      },
    ];
    const msg = buildQueueMsg({
      text: '毎朝5時20分のAIニュースの定期実行を削除してください',
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_should_not_run',
      events: [{ type: 'agent.message.text', text: 'should not run' }],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(schedulerMock.capturedCalls).toContainEqual({
      method: 'delete_job',
      args: ['morning_ai_news_seto_dm'],
    });
    expect(schedulerMock.capturedCalls.some((c) => c.method === 'create_job')).toBe(false);
    expect(chatApiMock.posts).toHaveLength(1);
    expect(chatApiMock.posts[0]!.text).toBe('✅ `morning_ai_news_seto_dm` 削除');
    expect(chatApiMock.patches).toHaveLength(0);
  });

  it('natural schedule command: 停止は delete ではなく pause_job', async () => {
    const env = buildEnv({
      envOverrides: {
        GCP_SCHEDULER_PROJECT: 'test-proj',
        GCP_SCHEDULER_LOCATION: 'asia-northeast1',
      } as Partial<Env>,
    });
    schedulerMock.jobs = [
      {
        job_id: 'morning_ai_news_seto',
        cron: '45 5 * * *',
        handler: 'cma_session',
        description: '毎朝5:45 AIニュース',
      },
    ];
    const msg = buildQueueMsg({
      text: 'morning_ai_news_seto の定期実行を停止して',
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(schedulerMock.capturedCalls).toContainEqual({
      method: 'pause_job',
      args: ['morning_ai_news_seto'],
    });
    expect(schedulerMock.capturedCalls.some((c) => c.method === 'delete_job')).toBe(false);
    expect(chatApiMock.posts[0]!.text).toBe('✅ `morning_ai_news_seto` 一時停止');
  });

  it('natural schedule command: 更新は update_job に cron patch を渡す', async () => {
    const env = buildEnv({
      envOverrides: {
        GCP_SCHEDULER_PROJECT: 'test-proj',
        GCP_SCHEDULER_LOCATION: 'asia-northeast1',
      } as Partial<Env>,
    });
    schedulerMock.jobs = [
      {
        job_id: 'morning_ai_news_seto',
        cron: '45 5 * * *',
        handler: 'cma_session',
        description: '毎朝5:45 AIニュース',
      },
    ];
    const msg = buildQueueMsg({
      text: 'morning_ai_news_seto の定期実行を6時10分に変更して',
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(schedulerMock.capturedCalls).toContainEqual({
      method: 'update_job',
      args: ['morning_ai_news_seto', { cron: '10 6 * * *' }],
    });
    expect(chatApiMock.posts[0]!.text).toBe('✅ `morning_ai_news_seto` 更新 (cron=10 6 * * *)');
  });

  it('natural schedule command: このスケジュール削除は同一threadの直前job_idを使う', async () => {
    const env = buildEnv({
      envOverrides: {
        GCP_SCHEDULER_PROJECT: 'test-proj',
        GCP_SCHEDULER_LOCATION: 'asia-northeast1',
      } as Partial<Env>,
    });
    schedulerMock.jobs = [
      {
        job_id: 'morning_ai_news_seto',
        cron: '45 5 * * 1-5',
        handler: 'cma_session',
        description: '毎朝5:45 AIニュース3本 (瀬戸さんDM、平日のみ)',
      },
    ];
    const threadName = 'spaces/AAA/threads/T1';
    const previous = buildQueueMsg({
      text: 'morning_ai_news_seto の定期実行を6時10分に変更して',
      threadName,
    });
    await preClaim(env, previous.eventKey, previous.claim.owner);
    await putMapping(env, 'alice@example.com');
    await handleChatEvent(env, {} as ExecutionContext, previous);
    schedulerMock.capturedCalls.length = 0;
    chatApiMock.posts.length = 0;

    const msg = buildQueueMsg({
      text: 'このスケジュール自体いらなくなったので削除して',
      threadName,
    });
    msg.eventKey = 'chat:msgname:spaces/AAA/messages/M2';
    msg.payload.message!.name = 'spaces/AAA/messages/M2';
    await preClaim(env, msg.eventKey, msg.claim.owner);

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(schedulerMock.capturedCalls).toContainEqual({
      method: 'delete_job',
      args: ['morning_ai_news_seto'],
    });
    expect(chatApiMock.posts[0]!.text).toBe('✅ `morning_ai_news_seto` 削除');
    expect(
      (env.DB as unknown as ReturnType<typeof makeMakotoDb>)._tables.cma_session_binds,
    ).toHaveLength(0);
    const runtimeEvents = (env.DB as unknown as ReturnType<typeof makeMakotoDb>)
      ._tables.cma_worker_runtime_events;
    expect(runtimeEvents.some((e) => e.event_type === 'natural_schedule_command_result')).toBe(true);
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
    // current space 投稿はある = placeholder POST 1 件 + 最終 reply は PATCH。
    expect(chatApiMock.posts.find((p) => p.spaceName === 'spaces/AAA')).toBeDefined();
    expect(chatApiMock.patches).toHaveLength(1);
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
    // placeholder POST 1 件 → 最終応答 (❌ メッセージ) は PATCH に乗る。
    const post = chatApiMock.posts.find((p) => p.spaceName === 'spaces/AAA');
    expect(post).toBeDefined();
    expect(post!.text).toBe('... MAKOTOくんが入力中');
    // failure isolation: PATCH に ❌ メッセージが含まれる。
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toContain('will-fail');
    expect(chatApiMock.patches[0]!.text).toContain('❌');
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

  // -------------------------------------------------------------------------
  // #186 placeholder POST + PATCH update + DELETE cleanup flow (UX 致命傷 fix)
  // -------------------------------------------------------------------------

  it('placeholder happy path: POST → stream OK → PATCH update (= Python _placeholder_reply 等価)', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_ph_ok',
      events: [
        { type: 'agent.message.text', text: '応答完了テキスト' },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    // POST が 1 件で text が placeholder literal。
    expect(chatApiMock.posts).toHaveLength(1);
    expect(chatApiMock.posts[0]!.spaceName).toBe('spaces/AAA');
    expect(chatApiMock.posts[0]!.text).toBe('... MAKOTOくんが入力中');
    // PATCH 1 件で text が最終応答。messageName が placeholder POST の戻り
    // resource name と一致 (= Python `_update_chat_message` 経路と等価)。
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toBe('応答完了テキスト');
    expect(chatApiMock.patches[0]!.messageName).toBe('spaces/AAA/messages/m_1');
    // DELETE は呼ばれない (失敗経路ではない)
    expect(chatApiMock.deletes).toHaveLength(0);
    await expect(
      readCounter(
        { db: env.DB, kv: env.MAKOTO_KV },
        costGuardInternals.KIND_CHAT_POST,
      ),
    ).resolves.toBe(1);
  });

  it('ingress placeholder reuse: queue skips duplicate POST and PATCHes supplied message', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({ placeholderName: 'spaces/AAA/messages/ingress_1' });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_ph_ingress',
      events: [
        { type: 'agent.message.text', text: '先行プレースホルダー再利用OK' },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(chatApiMock.posts).toHaveLength(0);
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.messageName).toBe('spaces/AAA/messages/ingress_1');
    expect(chatApiMock.patches[0]!.text).toBe('先行プレースホルダー再利用OK');
    expect(chatApiMock.deletes).toHaveLength(0);
  });

  it('placeholder empty final text: DELETEせず見える説明へPATCHする', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_empty_text',
      events: [
        { type: 'agent.message.text', text: '' },
        { type: 'session.status_idle' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(chatApiMock.posts).toHaveLength(1);
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toContain('Chat に表示できる本文が空でした');
    expect(chatApiMock.deletes).toHaveLength(0);
  });

  it('drive_stage_file custom tool receives resolved session id before streaming dispatch', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({
      text: 'Drive上のExcelテンプレートを使ってB2を更新して',
      placeholderName: 'spaces/AAA/messages/ingress_stage',
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    const capturedCalls: Array<{ name: string; input: unknown; ctx: Record<string, unknown> }> = [];
    (globalThis as unknown as {
      __makotoToolDispatch?: (
        name: string,
        input: unknown,
        ctx: unknown,
      ) => Promise<{ ok: boolean; payload: unknown }>;
    }).__makotoToolDispatch = async (name, input, ctx) => {
      capturedCalls.push({ name, input, ctx: ctx as Record<string, unknown> });
      return {
        ok: true,
        payload: { mount_path: '/mnt/session/uploads/template.xlsx' },
      };
    };

    installFakeAnthropic({
      sessionId: 'sesn_stage_before_stream',
      events: [
        {
          type: 'agent.custom_tool_use',
          id: 'tu_stage',
          name: 'drive_stage_file',
          input: { file_id: '1WaqevWkTHVDbDizf7YhS7Y7Q7ENt1FjJ', name: 'template.xlsx' },
        },
        {
          type: 'session.status_idle',
          stop_reason: { type: 'requires_action', event_ids: ['tu_stage'] },
        },
        {
          type: 'agent.message.text',
          text: 'https://drive.google.com/file/d/mock-drive-file/view',
        },
        { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);

    expect(result.kind).toBe('committed');
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.name).toBe('drive_stage_file');
    expect(capturedCalls[0]!.ctx.callerSessionId).toBe('sesn_stage_before_stream');
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toContain('https://drive.google.com/file/d/mock-drive-file/view');
  });

  it('custom tool timeout: retries without visible failure text', async () => {
    const env = buildEnv({
      envOverrides: { CMA_REACTIVE_STREAM_TIMEOUT_MS: '10' },
    });
    const msg = buildQueueMsg({
      text: '原稿を書いてDrive保存して',
      placeholderName: 'spaces/AAA/messages/ingress_timeout',
    });
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');
    (globalThis as unknown as {
      __makotoToolDispatch?: () => Promise<{ ok: boolean; payload: unknown }>;
    }).__makotoToolDispatch = async () => new Promise(() => undefined);

    installFakeAnthropic({
      sessionId: 'sesn_custom_tool_timeout',
      events: [
        {
          type: 'agent.message',
          content: [{ type: 'text', text: 'まず原稿を書いてDriveに上げます。' }],
        },
        { type: 'agent.custom_tool_use', id: 'tu_drive', name: 'drive_create_file', input: {} },
        {
          type: 'session.status_idle',
          stop_reason: { type: 'requires_action', event_ids: ['tu_drive'] },
        },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);

    expect(result.kind).toBe('release_and_retry');
    if (result.kind === 'release_and_retry') {
      expect(result.reason).toBe('custom_tool_timeout');
    }
    expect(chatApiMock.posts).toHaveLength(0);
    expect(chatApiMock.patches).toHaveLength(0);
    expect(chatApiMock.deletes).toHaveLength(0);
    const runtimeEvents = (env.DB as unknown as {
      _tables: { cma_worker_runtime_events: Array<{ event_type?: string; detail_json?: string }> };
    })._tables.cma_worker_runtime_events;
    const noticeEvent = runtimeEvents.find(
      (row) => row.event_type === 'custom_tool_timeout_retry_no_notice',
    );
    expect(noticeEvent?.detail_json).toContain('drive_create_file');
    const dedupe = (env.DB as unknown as { _tables: { dedupe: Map<string, Record<string, unknown>> } })
      ._tables.dedupe;
    const row = dedupe.get(msg.eventKey);
    expect(row?.claim_state).toBe('NEW');
    expect(Number(row?.lease_expires_at_ms)).toBe(0);
  });

  it('sessions.create throw → release_and_retry without visible notice', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_ph_create_fail',
      events: [],
      // orchestrator は sessions.create 失敗を OrchestratorFailure
      // (reason='sessions_create_failed') に詰めて throw する。
      createThrow: new Error('sessions.create upstream 503'),
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('release_and_retry');
    if (result.kind === 'release_and_retry') {
      expect(result.reason).toBe('sessions_create_failed');
    }
    expect(chatApiMock.posts).toHaveLength(1);
    expect(chatApiMock.posts[0]!.text).toBe('... MAKOTOくんが入力中');
    expect(chatApiMock.deletes).toHaveLength(0);
    expect(chatApiMock.patches).toHaveLength(0);
    const runtimeEvents = (env.DB as unknown as {
      _tables: { cma_worker_runtime_events: Array<{ event_type?: string; detail_json?: string }> };
    })._tables.cma_worker_runtime_events;
    const noticeEvent = runtimeEvents.find(
      (row) => row.event_type === 'orchestrator_transient_retry_no_notice',
    );
    expect(noticeEvent?.detail_json).toContain('sessions_create_failed');
    expect(noticeEvent?.detail_json).toContain('sessions.create upstream 503');
    const dedupe = (env.DB as unknown as { _tables: { dedupe: Map<string, Record<string, unknown>> } })
      ._tables.dedupe;
    const row = dedupe.get(msg.eventKey);
    expect(row?.claim_state).toBe('NEW');
    expect(Number(row?.lease_expires_at_ms)).toBe(0);
  });

  it('placeholder PATCH 失敗: WARN log + safePost (新規 POST) に fallback、bot 全体は落とさない', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_ph_patch_fail',
      events: [
        { type: 'agent.message.text', text: '応答テキスト patch fallback' },
        { type: 'session.status_idle' },
      ],
    });
    // PATCH を 1 回 throw させる。fallback で safePost が走り新規 POST 1 件追加。
    chatApiMock.updateThrow = new Error('PATCH 500 simulated');

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed'); // PATCH 失敗で event 全体は落とさない
    // POST 2 件: placeholder + fallback 新規 POST (= 最終応答)。
    expect(chatApiMock.posts).toHaveLength(2);
    expect(chatApiMock.posts[0]!.text).toBe('... MAKOTOくんが入力中');
    expect(chatApiMock.posts[1]!.text).toBe('応答テキスト patch fallback');
    // PATCH は 1 回試行された (= updateThrow が発火)。
    // mock は throw する経路で patches に push しないため patches.length === 0。
    expect(chatApiMock.patches).toHaveLength(0);
    // DELETE は呼ばれない (= 失敗経路ではなく fallback POST で完結)
    expect(chatApiMock.deletes).toHaveLength(0);
  });

  it('passes CMA_REACTIVE_SESSION_WATCHDOG_SEC through to the stream layer', async () => {
    const env = buildEnv({
      envOverrides: { CMA_REACTIVE_SESSION_WATCHDOG_SEC: '1' } as Partial<Env>,
    });
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_watchdog_cfg',
      events: [
        { type: 'agent.message.text', text: '通常応答です。' },
        { type: 'session.status_idle', stop_reason: 'end_turn' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');

    const runtimeEvents = (env.DB as unknown as {
      _tables: { cma_worker_runtime_events: Array<Record<string, unknown>> };
    })._tables.cma_worker_runtime_events;
    const streamEvent = runtimeEvents.find(
      (row) => row.event_type === 'cma_events_send_completed',
    );
    expect(streamEvent).toBeDefined();
    expect(JSON.parse(String(streamEvent!.detail_json))).toMatchObject({
      stop_reason: 'end_turn',
      session_watchdog_sec: 1,
    });
  });

  // -------------------------------------------------------------------------
  // #186 既知 #3 配線: cap-recovery wire up (= chat-event-handler.ts の
  // orchestrator return 後の cap 超過判定 + runCapRecovery 起動)。
  // -------------------------------------------------------------------------
  //
  // session.ts の `sendAndStreamWithToolDispatch` は built-in tool 上限
  // (`DEFAULT_MAX_BUILTIN_TOOL_CALLS=15`) を超えた `agent.tool_use` event を
  // 受信すると `user.interrupt` を送信し、`stopReason='tool_call_cap'` /
  // `terminalEventType='limit.builtin_tool_calls'` を返して loop を break する。
  // test では 16 件の `agent.tool_use` event を流して cap を踏ませる。

  /** 16 件の `agent.tool_use` event を生成 (= built-in cap 発火条件)。 */
  function makeBuiltinCapEvents(): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [
      // 初回 partial text を 1 件流し、後で recovery 後の text と差別化する。
      {
        type: 'agent.message',
        content: [{ type: 'text', text: '途中まで作りました…' }],
      },
    ];
    // 16 件の built-in tool_use event (= bash 等) を生成。
    // DEFAULT_MAX_BUILTIN_TOOL_CALLS=15 なので 16 件目で `> max` で break。
    for (let i = 0; i < 16; i += 1) {
      events.push({ type: 'agent.tool_use', id: `bt_${i}`, name: 'bash' });
    }
    // 終端 event は不要 (cap 検知が break するため到達しない)。
    return events;
  }

  it('cap-recovery: built-in tool cap 超過 → recovery turn 起動 → recovered 本文で置換 + commit', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_cap_1',
      events: makeBuiltinCapEvents(),
      // 2 回目 stream = recovery turn の応答。完成本文を text として返す。
      followupEventBatches: [
        [
          { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
          { type: 'session.status_running' },
          {
            type: 'user.message',
            content: [{ type: 'text', text: RECOVERY_PROMPT }],
          },
          {
            type: 'agent.message',
            content: [
              { type: 'text', text: '収集済み情報で完成版を作成しました。' },
            ],
          },
          { type: 'session.status_idle', stop_reason: 'end_turn' },
        ],
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    // 最終応答 (= recovery 後の本文) が placeholder の PATCH 経由で出る。
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toContain(
      '収集済み情報で完成版を作成しました。',
    );
    // 元の部分テキスト「途中まで作りました…」は置換されているため含まれない。
    expect(chatApiMock.patches[0]!.text).not.toContain('途中まで作りました');
    const runtimeEvents = (env.DB as unknown as { _tables: { cma_worker_runtime_events: Array<Record<string, unknown>> } })
      ._tables.cma_worker_runtime_events;
    const capEvent = runtimeEvents.find((row) => row.event_type === 'cap_recovery_result');
    expect(capEvent).toBeDefined();
    expect(JSON.parse(String(capEvent!.detail_json))).toMatchObject({
      outcome: 'recovered',
      original_stop_reason: 'tool_call_cap',
      recovery_text_chars: 18,
    });
  });

  it('cap-recovery: env CMA_REACTIVE_CAP_RECOVERY_ENABLED=0 で cap 超過 → recovery 起動せず部分テキストのまま', async () => {
    const env = buildEnv({
      envOverrides: { CMA_REACTIVE_CAP_RECOVERY_ENABLED: '0' } as Partial<Env>,
    });
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_cap_2',
      events: makeBuiltinCapEvents(),
      // 2 回目 stream を仕込んでおく (= もし誤って recovery が起動した
      // 場合に確実に検知できるよう、recovery 本文を flag 文字列に)
      followupEventBatches: [
        [
          {
            type: 'agent.message',
            content: [
              { type: 'text', text: 'RECOVERY_RAN_ERRONEOUSLY' },
            ],
          },
          { type: 'session.status_idle' },
        ],
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    // 部分テキストがそのまま PATCH に出る (= recovery 起動しなかった証拠)。
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toContain('途中まで作りました');
    expect(chatApiMock.patches[0]!.text).not.toContain('RECOVERY_RAN_ERRONEOUSLY');
  });

  it('cap-recovery: outcome=empty (recovery 本文が空) → 部分テキストのまま温存 (= 既存挙動 fallback)', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_cap_3',
      events: makeBuiltinCapEvents(),
      // 2 回目 stream が空応答 (= recovery が text を生成できなかった)
      followupEventBatches: [
        [{ type: 'session.status_idle', stop_reason: 'end_turn' }],
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    // 部分テキストがそのまま PATCH に出る (= recovery empty で置換しない)。
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toContain('途中まで作りました');
  });

  it('cap-recovery: 非 cap 終端 (end_turn) → recovery 起動しない (= 通常完了経路、未起動証跡)', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    installFakeAnthropic({
      sessionId: 'sesn_cap_4',
      events: [
        {
          type: 'agent.message',
          content: [{ type: 'text', text: '通常完了テキスト' }],
        },
        { type: 'session.status_idle', stop_reason: 'end_turn' },
      ],
      // 2 回目用 events を仕込んでおき、もし起動されたら検知できるように。
      followupEventBatches: [
        [
          {
            type: 'agent.message',
            content: [{ type: 'text', text: 'RECOVERY_ERRONEOUSLY_RAN' }],
          },
          { type: 'session.status_idle' },
        ],
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toContain('通常完了テキスト');
    expect(chatApiMock.patches[0]!.text).not.toContain('RECOVERY_ERRONEOUSLY_RAN');
  });

  it('autonomous scheduled long reply: first message is short title and full body is thread reply', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    msg.eventKey = 'scheduled:morning_brief_seto:2026-06-02:test';
    msg.claim.owner = 'cron-morning-brief-seto:test-owner';
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    const longBody =
      '直近3日分の朝ブリーフです\n' +
      Array.from({ length: 24 }, (_, i) => `- 重要項目${i + 1}: 対応内容を整理しました。`).join('\n');

    installFakeAnthropic({
      sessionId: 'sesn_morning_split',
      events: [
        {
          type: 'agent.message',
          content: [{ type: 'text', text: `===BRIEF_FINAL===\n${longBody}` }],
        },
        { type: 'session.status_idle', stop_reason: 'end_turn' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');

    expect(chatApiMock.posts).toHaveLength(2);
    expect(chatApiMock.posts[0]!.text).toBe('... MAKOTOくんが入力中');
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.messageName).toBe('spaces/AAA/messages/m_1');
    expect(chatApiMock.patches[0]!.text).toBe('朝ブリーフ: 直近3日分の朝ブリーフです');
    expect(chatApiMock.patches[0]!.text.length).toBeLessThan(40);

    expect(chatApiMock.posts[1]!.text).toBe(longBody);
    expect((chatApiMock.posts[1]!.opts as { threadName?: string }).threadName).toBe(
      'spaces/AAA/threads/t_1',
    );
  });

  it('autonomous scheduled prompt bypasses reactive schedule-command short circuit', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({
      text: 'スケジュール一覧も確認して、瀬戸さん向けの朝ブリーフを長文でまとめてください。',
    });
    msg.eventKey = 'scheduled:morning_brief_seto:2026-06-02:schedule-word';
    msg.claim.owner = 'cron-morning-brief-seto:test-owner';
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    const longBody =
      '朝ブリーフです\n' +
      Array.from({ length: 24 }, (_, i) => `- 確認項目${i + 1}: スケジュール語を含む自律起動です。`).join('\n');

    installFakeAnthropic({
      sessionId: 'sesn_morning_schedule_word',
      events: [
        {
          type: 'agent.message',
          content: [{ type: 'text', text: `===BRIEF_FINAL===\n${longBody}` }],
        },
        { type: 'session.status_idle', stop_reason: 'end_turn' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');

    expect(schedulerMock.capturedCalls).toHaveLength(0);
    expect(runtimeEvents(env).some((row) => row.event_type === 'natural_schedule_command_result')).toBe(false);
    expect(chatApiMock.patches[0]!.text).toBe('朝ブリーフ: 朝ブリーフです');
    expect(chatApiMock.posts[1]!.text).toBe(longBody);
  });

  it('reactive long reply: human-triggered long body stays in the first message', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    const longBody =
      '通常返信の長文です\n' +
      Array.from({ length: 24 }, (_, i) => `- 項目${i + 1}: 人間が依頼した通常返信です。`).join('\n');

    installFakeAnthropic({
      sessionId: 'sesn_reactive_long_reply',
      events: [
        {
          type: 'agent.message',
          content: [{ type: 'text', text: longBody }],
        },
        { type: 'session.status_idle', stop_reason: 'end_turn' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);
    expect(result.kind).toBe('committed');

    expect(chatApiMock.posts).toHaveLength(1);
    expect(chatApiMock.posts[0]!.text).toBe('... MAKOTOくんが入力中');
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.messageName).toBe('spaces/AAA/messages/m_1');
    expect(chatApiMock.patches[0]!.text).toBe(longBody);
  });

  it('morning brief: final reply lease_alive は parent を commit せず retry に戻す', async () => {
    const env = buildEnv();
    const msg = buildQueueMsg({});
    msg.eventKey = 'scheduled:morning_brief_seto:2026-05-29:test';
    msg.claim.owner = 'cron-morning-brief-seto:test-owner';
    await preClaim(env, msg.eventKey, msg.claim.owner);
    await putMapping(env, 'alice@example.com');

    const chatReplyKey = await buildSideEffectKey(
      msg.eventKey,
      'chat_reply',
      'spaces/AAA:',
    );
    await preClaim(env, chatReplyKey, 'other-worker#chat_reply');

    installFakeAnthropic({
      sessionId: 'sesn_morning_reply_lease_alive',
      events: [
        {
          type: 'agent.message',
          content: [{ type: 'text', text: '朝ブリーフ本文' }],
        },
        { type: 'session.status_idle', stop_reason: 'end_turn' },
      ],
    });

    const result = await handleChatEvent(env, {} as ExecutionContext, msg);

    expect(result).toEqual({
      kind: 'release_and_retry',
      reason: 'chat_reply_lease_alive',
    });
    expect(chatApiMock.patches).toEqual([]);
    const parent = (env.DB as unknown as {
      _tables: {
        dedupe: Map<string, {
          event_key: string;
          committed_at_ms: number | null;
          lease_expires_at_ms: number;
        }>;
      };
    })._tables.dedupe.get(msg.eventKey);
    expect(parent?.committed_at_ms).toBeNull();
    expect(parent?.lease_expires_at_ms).toBe(0);
  });
});
