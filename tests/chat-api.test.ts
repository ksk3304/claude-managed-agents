/**
 * Unit tests for `src/lib/chat-api.ts` — Google Chat REST client.
 *
 * Covers:
 *   - parseSaKey error paths (invalid JSON / missing fields)
 *   - getChatAccessToken: cache hit, cache miss, expiry refresh, scope
 *     change miss, Google token endpoint failure
 *   - postChatMessage: URL construction (thread vs new), messageId
 *     query param, threadFallback option, error mapping, empty text
 *     guard, non-`spaces/` guard
 *   - egress guard wiring (denial on tampered URL is enforced
 *     transitively via assertBridgeEgressAllowed)
 *
 * Real Google API calls + the JWT signature verification are exercised
 * in the Day 3 实机 E2E (`.claude/rules/makoto-kun-verification.md`)
 * — these unit tests intercept `fetch` before the network so we never
 * call Google in CI.
 *
 * The RSA-2048 PKCS#8 private key below is a throwaway fixture
 * generated solely for these tests (`openssl genpkey -algorithm RSA
 * -pkeyopt rsa_keygen_bits:2048`). It is not registered with Google
 * and grants no privileges.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  postChatMessage,
  getChatAccessToken,
  ChatApiError,
  CHAT_BOT_SCOPE,
  _resetChatTokenCacheForTests,
} from '../src/lib/chat-api';
import { makeFetchMock } from './makoto-helpers';

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

function fixtureSaKeyJson(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'cma-bot-mp-20260501',
    private_key_id: 'fixture-kid',
    private_key: TEST_PRIVATE_KEY_PEM,
    client_email: 'cma-chat-bot@cma-bot-mp-20260501.iam.gserviceaccount.com',
    ...overrides,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function tokenResponse(access_token = 'test-access-token', expires_in = 3600): Response {
  return jsonResponse(200, { access_token, expires_in, token_type: 'Bearer' });
}

beforeEach(() => {
  _resetChatTokenCacheForTests();
});

describe('parseSaKey (via getChatAccessToken)', () => {
  it('throws on invalid JSON', async () => {
    const fetchImpl = makeFetchMock(async () => tokenResponse());
    await expect(
      getChatAccessToken({ saKeyJson: 'not-json', fetchImpl }, [CHAT_BOT_SCOPE]),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('throws when client_email is missing', async () => {
    const fetchImpl = makeFetchMock(async () => tokenResponse());
    await expect(
      getChatAccessToken(
        { saKeyJson: JSON.stringify({ private_key: TEST_PRIVATE_KEY_PEM }), fetchImpl },
        [CHAT_BOT_SCOPE],
      ),
    ).rejects.toThrow(/client_email/);
  });

  it('throws when private_key is missing', async () => {
    const fetchImpl = makeFetchMock(async () => tokenResponse());
    await expect(
      getChatAccessToken(
        { saKeyJson: JSON.stringify({ client_email: 'x@y.iam' }), fetchImpl },
        [CHAT_BOT_SCOPE],
      ),
    ).rejects.toThrow(/private_key/);
  });

  it('throws when SA JSON is not an object', async () => {
    const fetchImpl = makeFetchMock(async () => tokenResponse());
    await expect(
      getChatAccessToken({ saKeyJson: '"plain string"', fetchImpl }, [CHAT_BOT_SCOPE]),
    ).rejects.toThrow(/JSON object/);
  });
});

describe('getChatAccessToken', () => {
  it('mints a token via the Google token endpoint on first call', async () => {
    const fetchMock = makeFetchMock(async (url, init) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      expect(init.method).toBe('POST');
      const body = (init.body as URLSearchParams).toString();
      expect(body).toContain('grant_type=urn');
      expect(body).toContain('assertion=');
      return tokenResponse('first-token', 3600);
    });
    const token = await getChatAccessToken(
      { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
      [CHAT_BOT_SCOPE],
    );
    expect(token).toBe('first-token');
    expect(fetchMock.calls).toHaveLength(1);
  });

  it('reuses the cached token on the second call', async () => {
    const fetchMock = makeFetchMock(async () => tokenResponse('cached-token', 3600));
    const deps = { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock };
    const t1 = await getChatAccessToken(deps, [CHAT_BOT_SCOPE]);
    const t2 = await getChatAccessToken(deps, [CHAT_BOT_SCOPE]);
    expect(t1).toBe('cached-token');
    expect(t2).toBe('cached-token');
    // Only the first call hits the network; cache absorbs the second.
    expect(fetchMock.calls).toHaveLength(1);
  });

  it('re-mints when the cached token is close to expiry', async () => {
    let issued = 0;
    const fetchMock = makeFetchMock(async () => {
      issued++;
      // 1-second TTL — every call is "close to expiry" (< 5 min margin).
      return tokenResponse(`issue-${issued}`, 1);
    });
    const deps = { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock };
    const t1 = await getChatAccessToken(deps, [CHAT_BOT_SCOPE]);
    const t2 = await getChatAccessToken(deps, [CHAT_BOT_SCOPE]);
    expect(t1).toBe('issue-1');
    expect(t2).toBe('issue-2');
    expect(fetchMock.calls).toHaveLength(2);
  });

  it('re-mints when called with a different scope set', async () => {
    let issued = 0;
    const fetchMock = makeFetchMock(async () => {
      issued++;
      return tokenResponse(`token-${issued}`, 3600);
    });
    const deps = { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock };
    await getChatAccessToken(deps, [CHAT_BOT_SCOPE]);
    await getChatAccessToken(deps, [CHAT_BOT_SCOPE, 'https://www.googleapis.com/auth/chat.messages.readonly']);
    expect(fetchMock.calls).toHaveLength(2);
  });

  it('wraps non-2xx token endpoint responses in ChatApiError', async () => {
    const fetchMock = makeFetchMock(async () =>
      new Response('invalid_grant', { status: 400 }),
    );
    try {
      await getChatAccessToken(
        { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
        [CHAT_BOT_SCOPE],
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ChatApiError);
      const e = err as ChatApiError;
      expect(e.status).toBe(400);
      expect(e.responseBody).toContain('invalid_grant');
    }
  });

  it('throws when token endpoint omits access_token', async () => {
    const fetchMock = makeFetchMock(async () =>
      jsonResponse(200, { expires_in: 3600 } /* no access_token */),
    );
    await expect(
      getChatAccessToken(
        { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
        [CHAT_BOT_SCOPE],
      ),
    ).rejects.toThrow(/malformed response/);
  });
});

describe('postChatMessage', () => {
  it('POSTs to spaces/{space}/messages with the right body when no thread', async () => {
    const fetchMock = makeFetchMock(async (url, init) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return tokenResponse('access-tok', 3600);
      }
      expect(url).toBe('https://chat.googleapis.com/v1/spaces/AAA/messages');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer access-tok',
      );
      const body = JSON.parse(init.body as string);
      expect(body.text).toBe('hello');
      expect(body.thread).toBeUndefined();
      return jsonResponse(200, {
        name: 'spaces/AAA/messages/MID.MID',
        thread: { name: 'spaces/AAA/threads/TID' },
      });
    });
    const r = await postChatMessage(
      { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
      'spaces/AAA',
      'hello',
    );
    expect(r.name).toBe('spaces/AAA/messages/MID.MID');
    expect(r.threadName).toBe('spaces/AAA/threads/TID');
  });

  it('includes thread.name in body when threadName is supplied', async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchMock = makeFetchMock(async (url, init) => {
      if (url === 'https://oauth2.googleapis.com/token') return tokenResponse();
      captured = JSON.parse(init.body as string);
      return jsonResponse(200, { name: 'spaces/AAA/messages/X' });
    });
    await postChatMessage(
      { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
      'spaces/AAA',
      'reply',
      { threadName: 'spaces/AAA/threads/TID' },
    );
    expect(captured!.thread).toEqual({ name: 'spaces/AAA/threads/TID' });
  });

  it('appends messageId query param when supplied', async () => {
    let chatUrl = '';
    const fetchMock = makeFetchMock(async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') return tokenResponse();
      chatUrl = url;
      return jsonResponse(200, { name: 'spaces/AAA/messages/X' });
    });
    await postChatMessage(
      { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
      'spaces/AAA',
      'idempotent',
      { messageId: 'client-1' },
    );
    expect(chatUrl).toBe(
      'https://chat.googleapis.com/v1/spaces/AAA/messages?messageId=client-1',
    );
  });

  it('appends messageReplyOption when threadFallback is supplied', async () => {
    let chatUrl = '';
    const fetchMock = makeFetchMock(async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') return tokenResponse();
      chatUrl = url;
      return jsonResponse(200, { name: 'spaces/AAA/messages/X' });
    });
    await postChatMessage(
      { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
      'spaces/AAA',
      'maybe-thread',
      {
        threadName: 'spaces/AAA/threads/TID',
        threadFallback: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
      },
    );
    expect(chatUrl).toContain('messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
  });

  it('throws when spaceName does not start with spaces/', async () => {
    const fetchMock = makeFetchMock(async () => tokenResponse());
    await expect(
      postChatMessage(
        { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
        'AAA',
        'hi',
      ),
    ).rejects.toThrow(/must start with 'spaces\//);
  });

  it('throws on empty text', async () => {
    const fetchMock = makeFetchMock(async () => tokenResponse());
    await expect(
      postChatMessage(
        { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
        'spaces/AAA',
        '',
      ),
    ).rejects.toThrow(/non-empty/);
  });

  it('wraps non-2xx Chat REST responses in ChatApiError', async () => {
    const fetchMock = makeFetchMock(async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') return tokenResponse();
      return new Response('permission denied', { status: 403 });
    });
    try {
      await postChatMessage(
        { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
        'spaces/AAA',
        'hi',
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ChatApiError);
      const e = err as ChatApiError;
      expect(e.status).toBe(403);
      expect(e.responseBody).toContain('permission denied');
    }
  });

  it('throws ChatApiError when Chat REST omits the name field', async () => {
    const fetchMock = makeFetchMock(async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') return tokenResponse();
      return jsonResponse(200, { thread: { name: 'spaces/AAA/threads/X' } });
    });
    await expect(
      postChatMessage(
        { saKeyJson: fixtureSaKeyJson(), fetchImpl: fetchMock },
        'spaces/AAA',
        'hi',
      ),
    ).rejects.toThrow(/no 'name' field/);
  });
});
