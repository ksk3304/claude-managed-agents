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
import { _resetChatOAuthCacheForTests } from '../src/lib/chat-oauth';
import { buildSideEffectKey } from '../src/lib/three-stage-precheck';
import {
  makeFakeThreadLockNamespace,
  makeFetchMock,
  makeKv,
  makeMakotoDb,
  TEST_VAULT_KEY_B64,
} from './makoto-helpers';
import { getThreadLock } from '../src/durable-objects/thread-lock';
import { RECOVERY_PROMPT } from '../src/lib/cap-recovery';

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
      return { name: `${spaceName}/messages/m_${chatApiMock.posts.length}` };
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
          async send(sessionId: string, _payload: unknown): Promise<void> {
            opts.sendCaptureSessionIds?.push(sessionId);
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
  spaceType?: string;
  spaceName?: string;
  threadName?: string | null;
  text?: string;
  senderEmail?: string;
  senderType?: string;
  annotations?: Array<{
    type?: string;
    startIndex?: number;
    length?: number;
    userMention?: { user?: { name?: string; type?: string } };
  }>;
  attachment?: ChatQueueMessage['payload']['message']['attachment'];
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
  installFakeAnthropic(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleChatEvent', () => {
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
      expect(fetchMock.calls.map((c) => c.url)).toEqual([
        'https://oauth2.googleapis.com/token',
        'https://chat.googleapis.com/v1/media/spaces/AAA/messages/M1/attachments/A1?alt=media',
      ]);
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
    // placeholder POST 1 件 → 最終 redaction 結果は PATCH で書き換え。
    const post = chatApiMock.posts.find((p) => p.spaceName === 'spaces/AAA');
    expect(post).toBeDefined();
    expect(post!.text).toBe('... MAKOTOくんが入力中');
    expect(chatApiMock.patches).toHaveLength(1);
    expect(chatApiMock.patches[0]!.text).toContain('今回のタスクは完了できませんでした');
    expect(chatApiMock.patches[0]!.text).not.toContain('memory store');
  });

  it('Case 9b: action marker leakage without a parsed marker is replaced with a user-facing failure', async () => {
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
    expect(chatApiMock.patches[0]!.text).toBe(
      '送信処理の状態を確認できませんでした。担当者がログを確認します。',
    );
    expect(chatApiMock.patches[0]!.text).not.toContain('EMAIL_SEND');
    expect(chatApiMock.patches[0]!.text).not.toContain('bot');
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
    // pre-populate KV with existing session for this sender + space + thread.
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
    expect(
      await env.MAKOTO_KV.get(
        'chat_thread_session:alice@example.com:spaces/ROOM10:spaces/ROOM10/threads/T11',
      ),
    ).toBe('sesn_new_thread');
  });

  it('attachment turn follows Chat thread session and ignores broad DM scope session', async () => {
    const env = buildEnv({
      envOverrides: {
        CHAT_SA_KEY_JSON: undefined,
      } as Partial<Env>,
    });
    const scopeKey = 'chat_scope_session:agent_001:dm:alice@example.com';
    const threadKey =
      'chat_thread_session:alice@example.com:spaces/AAA:spaces/AAA/threads/TATT';
    await env.MAKOTO_KV.put(scopeKey, 'sesn_existing');
    await env.MAKOTO_KV.put(threadKey, 'sesn_thread_existing');
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
    expect(await env.MAKOTO_KV.get(threadKey)).toBe('sesn_thread_existing');
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
    // placeholder POST は走った (= ack 表示) が、stream throw 後に DELETE で
    // 残骸 cleanup される (Python `_delete_chat_message` 等価)。
    expect(chatApiMock.posts).toHaveLength(1);
    expect(chatApiMock.posts[0]!.text).toBe('... MAKOTOくんが入力中');
    expect(chatApiMock.deletes).toHaveLength(1);
    expect(chatApiMock.patches).toHaveLength(0); // 最終 reply は無い
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
  });

  it('placeholder cleanup: sessions.create throw → placeholder DELETE が呼ばれる', async () => {
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
    // placeholder POST 1 件 + DELETE 1 件 (= 残骸 cleanup)
    expect(chatApiMock.posts).toHaveLength(1);
    expect(chatApiMock.posts[0]!.text).toBe('... MAKOTOくんが入力中');
    expect(chatApiMock.deletes).toHaveLength(1);
    expect(chatApiMock.deletes[0]).toBe('spaces/AAA/messages/m_1');
    // PATCH は呼ばれない (= 最終応答は無い)
    expect(chatApiMock.patches).toHaveLength(0);
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
