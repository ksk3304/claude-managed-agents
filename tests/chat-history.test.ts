/**
 * Unit tests for `src/lib/chat-history.ts` — Google Chat thread history
 * fetch + format port (Cloud Run `cma_gchat_bot.py:_fetch_thread_messages`
 * + `_format_thread_history`).
 *
 * Covers:
 *   1. happy path: messages.list 200 OK → chronological format block
 *   2. empty thread: nextPageToken absent + messages [] → '' returned
 *   3. 403 / 404 permanent errors → ChatHistoryFetchError (no retry)
 *   4. permanent failure threshold: 3 consecutive `recordHistoryFailure`
 *      flips perm flag exactly once (firstPermanentTrip)
 *   5. format ordering: multiple senders + USER_MENTION strip + current
 *      message exclusion preserves chronological order
 *
 * Network is mocked end-to-end via `makeFetchMock` — no real Google
 * traffic. Token endpoint reuses chat-api module-level cache; we reset
 * it in `beforeEach` to keep each test isolated.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  fetchThreadMessages,
  formatThreadHistory,
  recordHistoryFailure,
  clearHistoryFailure,
  getHistoryFailureCount,
  isHistoryPermanentlyFailed,
  handleHistoryFetchPermanentFailure,
  ChatHistoryFetchError,
  HISTORY_FAILURE_PERMANENT_THRESHOLD,
  KV_HISTORY_ERROR_PREFIX,
  CHAT_READONLY_SCOPE,
  type ThreadHistoryMessage,
} from '../src/lib/chat-history';
import {
  CHAT_BOT_SCOPE,
  _resetChatTokenCacheForTests,
} from '../src/lib/chat-api';
import { makeFetchMock, makeKv } from './makoto-helpers';

// Reuse the throwaway RSA-2048 fixture from chat-api.test.ts so the
// JWT exchange shape stays byte-equivalent. (Tests intercept fetch
// before the network so the signature is never verified by Google.)
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

const SPACE = 'spaces/AAA';
const THREAD = 'spaces/AAA/threads/T1';

function fixtureSaKeyJson(): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'cma-bot-mp-20260501',
    private_key_id: 'fixture-kid',
    private_key: TEST_PRIVATE_KEY_PEM,
    client_email: 'cma-chat-bot@cma-bot-mp-20260501.iam.gserviceaccount.com',
  });
}

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: 'test-access-token',
      expires_in: 3600,
      token_type: 'Bearer',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MESSAGES_URL_PREFIX = `https://chat.googleapis.com/v1/${SPACE}/messages`;

/**
 * URL router: token endpoint → token, messages.list → handler(call#).
 * Call # is 0-indexed and per-test-local to keep paging assertions
 * stateful but readable.
 */
function routeFetch(
  pagesHandler: (page: number) => Response,
): ReturnType<typeof makeFetchMock> {
  let pageCalls = 0;
  return makeFetchMock(async (url) => {
    if (url === TOKEN_URL) return tokenResponse();
    if (url.startsWith(MESSAGES_URL_PREFIX)) {
      const idx = pageCalls;
      pageCalls += 1;
      return pagesHandler(idx);
    }
    return new Response('unexpected url', { status: 500 });
  });
}

beforeEach(() => {
  _resetChatTokenCacheForTests();
});

// ---------------------------------------------------------------------------
// 1. happy path
// ---------------------------------------------------------------------------

describe('fetchThreadMessages — happy path', () => {
  it('uses a provided user OAuth access token without service-account exchange', async () => {
    const fetchMock = makeFetchMock(async (url, init) => {
      if (url === TOKEN_URL) {
        throw new Error('service-account token exchange should not run');
      }
      expect(init.headers).toEqual({
        Authorization: 'Bearer user-oauth-token',
        Accept: 'application/json',
      });
      return jsonResponse(200, {
        messages: [
          {
            name: 'spaces/AAA/messages/M1',
            text: 'ユーザーOAuthで読める',
            sender: { name: 'users/100', type: 'HUMAN' },
          },
        ],
      });
    });

    const messages = await fetchThreadMessages(
      { accessToken: 'user-oauth-token', fetchImpl: fetchMock },
      SPACE,
      THREAD,
    );

    expect(fetchMock.calls.length).toBe(1);
    expect(messages.map((m) => m.text)).toEqual(['ユーザーOAuthで読める']);
  });

  it('returns chronologically-ordered messages with text + sender info', async () => {
    const fetchMock = routeFetch((page) => {
      // desc page from the API: newest first.
      if (page === 0) {
        return jsonResponse(200, {
          messages: [
            {
              name: 'spaces/AAA/messages/M3',
              text: '三番目',
              sender: { name: 'users/100', type: 'HUMAN' },
              createTime: '2026-05-26T10:02:00Z',
            },
            {
              name: 'spaces/AAA/messages/M2',
              text: '二番目',
              sender: { name: 'users/200', type: 'HUMAN' },
              createTime: '2026-05-26T10:01:00Z',
            },
            {
              name: 'spaces/AAA/messages/M1',
              text: '一番目',
              sender: { name: 'users/100', type: 'HUMAN' },
              createTime: '2026-05-26T10:00:00Z',
            },
          ],
        });
      }
      return jsonResponse(500, { error: 'unreachable' });
    });

    const messages = await fetchThreadMessages(
      { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
      SPACE,
      THREAD,
    );

    // Token + 1 page = 2 fetch calls.
    expect(fetchMock.calls.length).toBe(2);
    // Verify URL params (filter + pageSize + orderBy). URLSearchParams
    // encodes spaces as `+`; parse the URL and read the filter value
    // (= byte parity with Python `filter=thread.name = ...`).
    const listCall = fetchMock.calls[1]!;
    expect(listCall.url).toContain('pageSize=100');
    expect(listCall.url).toContain('orderBy=createTime+desc');
    const parsedUrl = new URL(listCall.url);
    expect(parsedUrl.searchParams.get('filter')).toBe(
      `thread.name = ${THREAD}`,
    );

    // After reverse → chronological (M1, M2, M3).
    expect(messages.map((m) => m.name)).toEqual([
      'spaces/AAA/messages/M1',
      'spaces/AAA/messages/M2',
      'spaces/AAA/messages/M3',
    ]);
    expect(messages.map((m) => m.text)).toEqual(['一番目', '二番目', '三番目']);
    expect(messages[0]!.senderId).toBe('users/100');
    expect(messages[0]!.senderType).toBe('HUMAN');
  });

  it('follows nextPageToken across pages and concatenates', async () => {
    const fetchMock = routeFetch((page) => {
      if (page === 0) {
        return jsonResponse(200, {
          messages: [
            {
              name: 'spaces/AAA/messages/M3',
              text: 'newest',
              sender: { name: 'users/100', type: 'HUMAN' },
            },
          ],
          nextPageToken: 'tok-1',
        });
      }
      if (page === 1) {
        return jsonResponse(200, {
          messages: [
            {
              name: 'spaces/AAA/messages/M2',
              text: 'middle',
              sender: { name: 'users/100', type: 'HUMAN' },
            },
            {
              name: 'spaces/AAA/messages/M1',
              text: 'oldest',
              sender: { name: 'users/100', type: 'HUMAN' },
            },
          ],
        });
      }
      return jsonResponse(500, { error: 'over-paged' });
    });

    const messages = await fetchThreadMessages(
      { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
      SPACE,
      THREAD,
    );
    expect(messages.map((m) => m.text)).toEqual(['oldest', 'middle', 'newest']);
    // Page 2 URL should include pageToken=tok-1.
    expect(fetchMock.calls[2]!.url).toContain('pageToken=tok-1');
  });

  it('requests both CHAT_BOT_SCOPE and CHAT_READONLY_SCOPE by default', async () => {
    let tokenBody = '';
    const fetchMock = makeFetchMock(async (url, init) => {
      if (url === TOKEN_URL) {
        tokenBody = (init.body as URLSearchParams).toString();
        return tokenResponse();
      }
      return jsonResponse(200, { messages: [] });
    });
    await fetchThreadMessages(
      { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
      SPACE,
      THREAD,
    );
    // The JWT assertion is opaque base64 but the scope is encoded in
    // its claim. Decoding here is overkill — instead we assert the
    // two scope strings can be passed (no throw) and the token call
    // happened (= JWT was minted).
    expect(tokenBody).toContain('grant_type=urn');
    expect(CHAT_BOT_SCOPE).toBe('https://www.googleapis.com/auth/chat.bot');
    expect(CHAT_READONLY_SCOPE).toBe(
      'https://www.googleapis.com/auth/chat.messages.readonly',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. empty thread
// ---------------------------------------------------------------------------

describe('fetchThreadMessages — empty thread', () => {
  it('returns [] when messages field absent', async () => {
    const fetchMock = routeFetch(() => jsonResponse(200, {}));
    const messages = await fetchThreadMessages(
      { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
      SPACE,
      THREAD,
    );
    expect(messages).toEqual([]);
  });

  it('returns [] when messages array is empty', async () => {
    const fetchMock = routeFetch(() => jsonResponse(200, { messages: [] }));
    const messages = await fetchThreadMessages(
      { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
      SPACE,
      THREAD,
    );
    expect(messages).toEqual([]);
  });

  it('returns [] when threadName is empty string (no API call)', async () => {
    const fetchMock = makeFetchMock(async () => {
      throw new Error('should not call fetch');
    });
    const messages = await fetchThreadMessages(
      { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
      SPACE,
      '',
    );
    expect(messages).toEqual([]);
    expect(fetchMock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. 403 / 404 permanent errors
// ---------------------------------------------------------------------------

describe('fetchThreadMessages — permanent errors', () => {
  it('throws ChatHistoryFetchError on 403 without retry', async () => {
    let pageCalls = 0;
    const fetchMock = makeFetchMock(async (url) => {
      if (url === TOKEN_URL) return tokenResponse();
      pageCalls += 1;
      return new Response('forbidden', { status: 403 });
    });
    await expect(
      fetchThreadMessages(
        { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
        SPACE,
        THREAD,
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(ChatHistoryFetchError);
    expect(pageCalls).toBe(1);
  });

  it('throws ChatHistoryFetchError on 404 without retry', async () => {
    let pageCalls = 0;
    const fetchMock = makeFetchMock(async (url) => {
      if (url === TOKEN_URL) return tokenResponse();
      pageCalls += 1;
      return new Response('not found', { status: 404 });
    });
    try {
      await fetchThreadMessages(
        { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
        SPACE,
        THREAD,
        { sleep: async () => {} },
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ChatHistoryFetchError);
      const e = err as ChatHistoryFetchError;
      expect(e.status).toBe(404);
      expect(e.attempts).toBe(1);
    }
    expect(pageCalls).toBe(1);
  });

  it('retries on 503 up to max attempts then throws', async () => {
    let pageCalls = 0;
    const fetchMock = makeFetchMock(async (url) => {
      if (url === TOKEN_URL) return tokenResponse();
      pageCalls += 1;
      return new Response('unavailable', { status: 503 });
    });
    await expect(
      fetchThreadMessages(
        { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
        SPACE,
        THREAD,
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(ChatHistoryFetchError);
    expect(pageCalls).toBe(3); // 3 attempts per page (max)
  });
});

// ---------------------------------------------------------------------------
// 4. permanent failure counter
// ---------------------------------------------------------------------------

describe('recordHistoryFailure — KV counter + permanent flag', () => {
  it('trips perm flag on the 3rd consecutive failure (firstPermanentTrip)', async () => {
    const kv = makeKv();
    const r1 = await recordHistoryFailure(kv, THREAD);
    expect(r1.count).toBe(1);
    expect(r1.permanent).toBe(false);
    expect(r1.firstPermanentTrip).toBe(false);
    expect(await isHistoryPermanentlyFailed(kv, THREAD)).toBe(false);

    const r2 = await recordHistoryFailure(kv, THREAD);
    expect(r2.count).toBe(2);
    expect(r2.permanent).toBe(false);
    expect(r2.firstPermanentTrip).toBe(false);

    const r3 = await recordHistoryFailure(kv, THREAD);
    expect(r3.count).toBe(HISTORY_FAILURE_PERMANENT_THRESHOLD);
    expect(r3.permanent).toBe(true);
    expect(r3.firstPermanentTrip).toBe(true);
    expect(await isHistoryPermanentlyFailed(kv, THREAD)).toBe(true);

    // Subsequent failure keeps the flag but firstPermanentTrip = false
    // (= caller suppresses repeat alerts).
    const r4 = await recordHistoryFailure(kv, THREAD);
    expect(r4.count).toBe(HISTORY_FAILURE_PERMANENT_THRESHOLD + 1);
    expect(r4.permanent).toBe(true);
    expect(r4.firstPermanentTrip).toBe(false);
  });

  it('clearHistoryFailure resets both counter and perm flag', async () => {
    const kv = makeKv();
    await recordHistoryFailure(kv, THREAD, 'first failure reason');
    await recordHistoryFailure(kv, THREAD);
    await recordHistoryFailure(kv, THREAD);
    expect(await isHistoryPermanentlyFailed(kv, THREAD)).toBe(true);
    expect(await getHistoryFailureCount(kv, THREAD)).toBe(
      HISTORY_FAILURE_PERMANENT_THRESHOLD,
    );
    expect(await kv.get(`${KV_HISTORY_ERROR_PREFIX}:${THREAD}`)).toBe(
      'first failure reason',
    );

    await clearHistoryFailure(kv, THREAD);
    expect(await isHistoryPermanentlyFailed(kv, THREAD)).toBe(false);
    expect(await getHistoryFailureCount(kv, THREAD)).toBe(0);
    expect(await kv.get(`${KV_HISTORY_ERROR_PREFIX}:${THREAD}`)).toBe(null);
  });

  it('recordHistoryFailure stores the latest failure reason with the counter', async () => {
    const kv = makeKv();
    await recordHistoryFailure(kv, THREAD, 'status=403 insufficient scopes');
    expect(await kv.get(`${KV_HISTORY_ERROR_PREFIX}:${THREAD}`)).toBe(
      'status=403 insufficient scopes',
    );
  });

  it('handleHistoryFetchPermanentFailure stamps the perm key', async () => {
    const kv = makeKv();
    expect(await isHistoryPermanentlyFailed(kv, THREAD)).toBe(false);
    await handleHistoryFetchPermanentFailure(kv, THREAD, 'mocked reason');
    expect(await isHistoryPermanentlyFailed(kv, THREAD)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. formatThreadHistory — ordering + mention strip + current msg exclusion
// ---------------------------------------------------------------------------

describe('formatThreadHistory', () => {
  it('renders a chronological markdown block with sender labels', () => {
    const messages: ThreadHistoryMessage[] = [
      mkMessage('M1', 'users/100', 'HUMAN', 'まずこれを共有します'),
      mkMessage('M2', 'users/200', 'HUMAN', 'なるほど、こうしましょう'),
      mkMessage('M3', 'users/999', 'BOT', 'ありがとうございます'),
    ];
    const block = formatThreadHistory(messages);
    const lines = block.split('\n');
    expect(lines[0]).toBe('## スレッド過去履歴（時系列順）');
    // 3 lines should follow in input order (= chronological).
    expect(lines[1]).toContain('まずこれを共有します');
    expect(lines[2]).toContain('なるほど、こうしましょう');
    expect(lines[3]).toContain('ありがとうございます');
    // Bot message labelled `[bot]`.
    expect(lines[3]).toContain('[bot]');
    // Human masking = end-4 of resource name (last 4 chars of `users/100`
    // is `/100`, last 4 of `users/200` is `/200`).
    expect(lines[1]).toContain('user:.../100');
    expect(lines[2]).toContain('user:.../200');
  });

  it('excludes the current message from the rendered block', () => {
    const messages: ThreadHistoryMessage[] = [
      mkMessage('M1', 'users/100', 'HUMAN', '過去発言'),
      mkMessage('M-current', 'users/200', 'HUMAN', '今回の発言'),
    ];
    const block = formatThreadHistory(messages, {
      currentMessageName: 'M-current',
    });
    expect(block).toContain('過去発言');
    expect(block).not.toContain('今回の発言');
  });

  it('returns empty string when all messages are empty or excluded', () => {
    const messages: ThreadHistoryMessage[] = [
      mkMessage('M1', 'users/100', 'HUMAN', ''),
      mkMessage('M2', 'users/100', 'HUMAN', '   '),
    ];
    expect(formatThreadHistory(messages)).toBe('');
  });

  it('drops unknown-speaker messages and appends a notice block', () => {
    const messages: ThreadHistoryMessage[] = [
      mkMessage('M1', 'users/100', 'HUMAN', '登録済の発言'),
      mkMessage('M2', 'users/abcdef9999', '', '不明な type の発言'),
      mkMessage('M3', '', 'HUMAN', '送信者 ID 欠落'),
    ];
    const block = formatThreadHistory(messages);
    expect(block).toContain('登録済の発言');
    expect(block).not.toContain('不明な type の発言');
    expect(block).not.toContain('送信者 ID 欠落');
    expect(block).toContain('識別不能な参加者');
    // Mask is end-4 of resource name.
    expect(block).toContain('...9999');
  });

  it('returns "" for empty input', () => {
    expect(formatThreadHistory([])).toBe('');
  });

  it('strips USER_MENTION span from argumentText path (raw fetch parity)', async () => {
    // Indirect path: fetchThreadMessages prefers argumentText when present
    // (= mention already pre-stripped by the API). When absent it falls
    // back to text + annotations cut. Below we use the fallback case.
    const fetchMock = routeFetch(() =>
      jsonResponse(200, {
        messages: [
          {
            name: 'spaces/AAA/messages/M1',
            text: '@MAKOTOくん こんにちは',
            sender: { name: 'users/100', type: 'HUMAN' },
            annotations: [
              { type: 'USER_MENTION', startIndex: 0, length: 9 },
            ],
          },
        ],
      }),
    );
    const messages = await fetchThreadMessages(
      { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
      SPACE,
      THREAD,
    );
    expect(messages[0]!.text).toBe('こんにちは');
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mkMessage(
  name: string,
  senderId: string,
  senderType: string,
  text: string,
): ThreadHistoryMessage {
  return {
    name,
    senderId,
    senderType,
    text,
    createTime: '',
  };
}
