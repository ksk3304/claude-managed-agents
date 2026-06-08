/**
 * Unit tests for `src/webhooks/google-chat.ts` — Phase A ingress
 * (JWT verify + dedupe claim + Queue enqueue).
 *
 * Test fixture strategy (2026-05-26 update):
 *   - 本番 src は `importJWK` + JWKS endpoint (`oauth2/v3/certs`) を使う
 *     ので、test fixture は JWK Set 形式の response を返す。
 *   - jose の `generateKeyPair('RS256', { extractable: true })` で RSA key
 *     pair を生成し、`exportJWK(publicKey)` で JWK を取り出し、
 *     `{kid, alg, use}` を付与して fetch mock の response body
 *     `{keys: [...]}` に埋める。
 *   - issuer は本番が 3 候補 (`https://accounts.google.com` /
 *     `accounts.google.com` / `chat@system.gserviceaccount.com`) を accept
 *     するので、test は `'accounts.google.com'` (= 標準 OIDC) を既定で
 *     使う。issuer mismatch test は 3 候補以外 (`'attacker@example.com'`)
 *     を使って拒否されることを確認する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  type JWK,
} from 'jose';

import {
  handleGoogleChatWebhook,
  verifyGoogleChatJwt,
  _resetPublicKeyCacheForTesting,
  type ChatQueueMessage,
  type ChatEventPayload,
} from '../src/webhooks/google-chat';
import { makeFakeQueue, makeMakotoDb } from './makoto-helpers';

const PROJECT_NUMBER = '192588613210';
const ISSUER = 'accounts.google.com';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

const chatApiMock = {
  posts: [] as Array<{ spaceName: string; text: string; opts: unknown }>,
  deletes: [] as string[],
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
      return { name: `${spaceName}/messages/placeholder_${chatApiMock.posts.length}` };
    },
    deleteChatMessage: async (_deps: unknown, messageName: string) => {
      chatApiMock.deletes.push(messageName);
    },
  };
});

interface KeyFixture {
  kid: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** JWK object that the fetch mock returns under this kid. */
  jwk: JWK & { kid: string; alg: string; use: string };
}

async function makeKeyFixture(kid = 'k1'): Promise<KeyFixture> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  const baseJwk = await exportJWK(publicKey);
  const jwk = {
    ...baseJwk,
    kid,
    alg: 'RS256',
    use: 'sig',
  } as JWK & { kid: string; alg: string; use: string };
  return { kid, privateKey, publicKey, jwk };
}

interface SignedJwtOptions {
  iss?: string;
  aud?: string;
  exp?: number; // seconds-since-epoch absolute override
  expFromNowSec?: number;
}

async function signJwt(
  fixture: KeyFixture,
  opts: SignedJwtOptions = {},
): Promise<string> {
  const builder = new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: fixture.kid, typ: 'JWT' })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? PROJECT_NUMBER)
    .setIssuedAt();
  if (opts.exp !== undefined) {
    builder.setExpirationTime(opts.exp);
  } else {
    builder.setExpirationTime(`${opts.expFromNowSec ?? 300}s`);
  }
  return builder.sign(fixture.privateKey);
}

interface PublicKeyMockOptions {
  /** When set, fetch returns this status without the body. */
  status?: number;
  /** Override the body (e.g. invalid JSON). */
  body?: string;
}

function makePublicKeyFetchMock(
  fixtures: KeyFixture[],
  opts: PublicKeyMockOptions = {},
): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const mock = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push(url);
    if (url !== JWKS_URL) {
      throw new Error(`unexpected fetch url=${url}`);
    }
    if (opts.status && opts.status >= 400) {
      return new Response(opts.body ?? 'err', { status: opts.status });
    }
    if (opts.body !== undefined) {
      return new Response(opts.body, { status: 200 });
    }
    const jwks = { keys: fixtures.map((f) => f.jwk) };
    return new Response(JSON.stringify(jwks), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch & { calls: string[] };
  mock.calls = calls;
  return mock;
}

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    DB: makeMakotoDb(),
    MAKOTO_CHAT_QUEUE: makeFakeQueue<ChatQueueMessage>(),
    GCP_BOT_PROJECT_NUMBER: PROJECT_NUMBER,
    ...overrides,
  } as unknown as Env;
}

function makeMessageEvent(messageName: string): ChatEventPayload {
  return {
    type: 'MESSAGE',
    eventTime: '2026-05-26T10:00:00Z',
    message: {
      name: messageName,
      sender: {
        name: 'users/USER_X',
        displayName: 'Test User',
        email: 'test@example.com',
      },
      text: 'こんにちは',
      thread: { name: 'spaces/SPACE_X/threads/THREAD_X' },
    },
    space: { name: 'spaces/SPACE_X', type: 'ROOM', displayName: 'Test Space' },
    user: { name: 'users/USER_X', displayName: 'Test User' },
  };
}

function makeDmMessageEvent(messageName: string): ChatEventPayload {
  return {
    ...makeMessageEvent(messageName),
    space: { name: 'spaces/DM_X', type: 'DM', displayName: 'DM' },
    message: {
      ...makeMessageEvent(messageName).message,
      thread: { name: 'spaces/DM_X/threads/THREAD_X' },
    },
  };
}

function buildRequest(body: string, authzValue: string | null): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (authzValue !== null) headers['authorization'] = authzValue;
  return new Request('https://test.workers.dev/webhooks/google-chat', {
    method: 'POST',
    body,
    headers,
  });
}

describe('google-chat webhook handler', () => {
  let origFetch: typeof fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
    chatApiMock.posts.length = 0;
    chatApiMock.deletes.length = 0;
    _resetPublicKeyCacheForTesting();
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    _resetPublicKeyCacheForTesting();
  });

  it('200 + Queue enqueue on valid MESSAGE event', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const env = envWith();
    const jwt = await signJwt(fixture);
    const body = JSON.stringify(makeMessageEvent('spaces/A/messages/M1'));
    const req = buildRequest(body, `Bearer ${jwt}`);

    const resp = await handleGoogleChatWebhook(req, env);
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({});

    const sent = (env.MAKOTO_CHAT_QUEUE as unknown as { _sent: ChatQueueMessage[] })._sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.eventKey).toBe('chat:msgname:spaces/A/messages/M1');
    expect(sent[0]!.claim.owner).toBeTruthy();
    expect(sent[0]!.claim.version).toBe(1);
    expect(sent[0]!.payload.type).toBe('MESSAGE');

    // dedupe row exists with no committed_at_ms (= Phase B が confirmOwner で読む)
    const dedupe = (env.DB as unknown as { _tables: { dedupe: Map<string, unknown> } })._tables.dedupe;
    expect(dedupe.has('chat:msgname:spaces/A/messages/M1')).toBe(true);
  });

  it('posts ingress placeholder before Queue enqueue for DM and passes message name', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const env = envWith({ CHAT_SA_KEY_JSON: '{}' });
    const jwt = await signJwt(fixture);
    const body = JSON.stringify(makeDmMessageEvent('spaces/DM_X/messages/M1'));
    const req = buildRequest(body, `Bearer ${jwt}`);

    const resp = await handleGoogleChatWebhook(req, env);
    expect(resp.status).toBe(200);

    expect(chatApiMock.posts).toHaveLength(1);
    expect(chatApiMock.posts[0]!.spaceName).toBe('spaces/DM_X');
    expect(chatApiMock.posts[0]!.text).toBe('... MAKOTOくんが入力中');

    const sent = (env.MAKOTO_CHAT_QUEUE as unknown as { _sent: ChatQueueMessage[] })._sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.placeholderName).toBe('spaces/DM_X/messages/placeholder_1');
  });

  it('copies Workspace Add-on chat.user.email onto message.sender.email', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const env = envWith();
    const jwt = await signJwt(fixture);
    const body = JSON.stringify({
      chat: {
        user: {
          name: 'users/USER_X',
          displayName: 'Test User',
          email: 'test@example.com',
        },
        eventTime: '2026-05-26T10:00:00Z',
        messagePayload: {
          space: { name: 'spaces/DM_X', type: 'DM', displayName: 'DM' },
          message: {
            name: 'spaces/DM_X/messages/M_EMAIL',
            sender: {
              name: 'users/USER_X',
              displayName: 'Test User',
            },
            text: 'こんにちは',
            thread: { name: 'spaces/DM_X/threads/THREAD_X' },
          },
        },
      },
    });
    const req = buildRequest(body, `Bearer ${jwt}`);

    const resp = await handleGoogleChatWebhook(req, env);
    expect(resp.status).toBe(200);

    const sent = (env.MAKOTO_CHAT_QUEUE as unknown as { _sent: ChatQueueMessage[] })._sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.message!.sender.email).toBe('test@example.com');
  });

  it('200 + skipped on non-MESSAGE event (ADDED_TO_SPACE)', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const env = envWith();
    const jwt = await signJwt(fixture);
    const body = JSON.stringify({
      type: 'ADDED_TO_SPACE',
      eventTime: '2026-05-26T10:00:00Z',
      space: { name: 'spaces/A', type: 'ROOM' },
    });
    const req = buildRequest(body, `Bearer ${jwt}`);

    const resp = await handleGoogleChatWebhook(req, env);
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({});
    const sent = (env.MAKOTO_CHAT_QUEUE as unknown as { _sent: ChatQueueMessage[] })._sent;
    expect(sent).toHaveLength(0);
  });

  it('200 + duplicate on second delivery with same message.name', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const env = envWith();
    const body = JSON.stringify(makeMessageEvent('spaces/A/messages/DUP'));

    const jwt1 = await signJwt(fixture);
    const r1 = await handleGoogleChatWebhook(buildRequest(body, `Bearer ${jwt1}`), env);
    expect(r1.status).toBe(200);
    await expect(r1.json()).resolves.toEqual({});

    const jwt2 = await signJwt(fixture);
    const r2 = await handleGoogleChatWebhook(buildRequest(body, `Bearer ${jwt2}`), env);
    expect(r2.status).toBe(200);
    await expect(r2.json()).resolves.toEqual({});

    const sent = (env.MAKOTO_CHAT_QUEUE as unknown as { _sent: ChatQueueMessage[] })._sent;
    expect(sent).toHaveLength(1);
  });

  it('401 on tampered JWT signature', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const env = envWith();
    const jwt = await signJwt(fixture);
    // Flip the first character of the signature segment. The final base64url
    // character can contain padding bits, so changing it may not change the
    // decoded signature bytes for every random fixture.
    const parts = jwt.split('.');
    parts[2] =
      (parts[2]!.startsWith('A') ? 'B' : 'A') + parts[2]!.slice(1);
    const tampered = parts.join('.');
    const body = JSON.stringify(makeMessageEvent('spaces/A/messages/M1'));
    const resp = await handleGoogleChatWebhook(
      buildRequest(body, `Bearer ${tampered}`),
      env,
    );
    expect(resp.status).toBe(401);
  });

  it('401 on expired JWT (exp < now)', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const env = envWith();
    const nowSec = Math.floor(Date.now() / 1000);
    const jwt = await signJwt(fixture, { exp: nowSec - 60 });
    const body = JSON.stringify(makeMessageEvent('spaces/A/messages/M1'));
    const resp = await handleGoogleChatWebhook(
      buildRequest(body, `Bearer ${jwt}`),
      env,
    );
    expect(resp.status).toBe(401);
  });

  it('401 on audience mismatch', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const env = envWith();
    const jwt = await signJwt(fixture, { aud: 'not-the-project' });
    const body = JSON.stringify(makeMessageEvent('spaces/A/messages/M1'));
    const resp = await handleGoogleChatWebhook(
      buildRequest(body, `Bearer ${jwt}`),
      env,
    );
    expect(resp.status).toBe(401);
  });

  it('accepts HTTP endpoint URL audience when the UI has no Authentication Audience field', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const env = envWith();
    const endpointUrl = 'https://test.workers.dev/webhooks/google-chat';
    const jwt = await signJwt(fixture, { aud: endpointUrl });
    const body = JSON.stringify(makeMessageEvent('spaces/A/messages/M_ENDPOINT_AUD'));
    const resp = await handleGoogleChatWebhook(
      buildRequest(body, `Bearer ${jwt}`),
      env,
    );

    expect(resp.status).toBe(200);
    const sent = (env.MAKOTO_CHAT_QUEUE as unknown as { _sent: ChatQueueMessage[] })._sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.eventKey).toBe('chat:msgname:spaces/A/messages/M_ENDPOINT_AUD');
  });

  it('401 on issuer mismatch', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const env = envWith();
    // attacker@example.com は 3 候補 (https://accounts.google.com /
    // accounts.google.com / chat@system.gserviceaccount.com) いずれにも
    // 該当しないので拒否される。
    const jwt = await signJwt(fixture, { iss: 'attacker@example.com' });
    const body = JSON.stringify(makeMessageEvent('spaces/A/messages/M1'));
    const resp = await handleGoogleChatWebhook(
      buildRequest(body, `Bearer ${jwt}`),
      env,
    );
    expect(resp.status).toBe(401);
  });

  it('401 when Authorization header is missing', async () => {
    const env = envWith();
    const body = JSON.stringify(makeMessageEvent('spaces/A/messages/M1'));
    const resp = await handleGoogleChatWebhook(buildRequest(body, null), env);
    expect(resp.status).toBe(401);
  });

  it('400 on malformed JSON body', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const env = envWith();
    const jwt = await signJwt(fixture);
    const resp = await handleGoogleChatWebhook(
      buildRequest('not json {{{', `Bearer ${jwt}`),
      env,
    );
    expect(resp.status).toBe(400);
  });

  it('500 when Queue.send throws (claim is released)', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const failingQueue = {
      async send(): Promise<void> {
        throw new Error('queue down');
      },
      async sendBatch(): Promise<void> {
        throw new Error('queue down');
      },
    } as unknown as Queue<ChatQueueMessage>;
    const env = envWith({
      MAKOTO_CHAT_QUEUE: failingQueue,
    } as Partial<Env>);
    const jwt = await signJwt(fixture);
    const body = JSON.stringify(makeMessageEvent('spaces/A/messages/M1'));
    const resp = await handleGoogleChatWebhook(
      buildRequest(body, `Bearer ${jwt}`),
      env,
    );
    expect(resp.status).toBe(500);
    // claim was released → lease_expires_at_ms == 0
    const row = (env.DB as unknown as {
      _tables: { dedupe: Map<string, { lease_expires_at_ms: number }> };
    })._tables.dedupe.get('chat:msgname:spaces/A/messages/M1');
    expect(row?.lease_expires_at_ms).toBe(0);
  });

  it('deletes ingress placeholder when Queue enqueue fails', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const failingQueue = {
      async send(): Promise<void> {
        throw new Error('queue down');
      },
      async sendBatch(): Promise<void> {
        throw new Error('queue down');
      },
    } as unknown as Queue<ChatQueueMessage>;
    const env = envWith({
      CHAT_SA_KEY_JSON: '{}',
      MAKOTO_CHAT_QUEUE: failingQueue,
    } as Partial<Env>);
    const jwt = await signJwt(fixture);
    const body = JSON.stringify(makeDmMessageEvent('spaces/DM_X/messages/QFAIL'));

    const resp = await handleGoogleChatWebhook(
      buildRequest(body, `Bearer ${jwt}`),
      env,
    );

    expect(resp.status).toBe(500);
    expect(chatApiMock.posts).toHaveLength(1);
    expect(chatApiMock.deletes).toEqual(['spaces/DM_X/messages/placeholder_1']);
  });

  it('401 when JWT kid is not present in fetched key set', async () => {
    const fixture = await makeKeyFixture('k1');
    const otherFixture = await makeKeyFixture('k2'); // fetched
    globalThis.fetch = makePublicKeyFetchMock([otherFixture]) as unknown as typeof fetch;
    const env = envWith();
    // JWT signed with k1 but only k2 is in the keystore.
    const jwt = await signJwt(fixture);
    const body = JSON.stringify(makeMessageEvent('spaces/A/messages/M1'));
    const resp = await handleGoogleChatWebhook(
      buildRequest(body, `Bearer ${jwt}`),
      env,
    );
    expect(resp.status).toBe(401);
  });

  it('500 when public key fetch fails (caller should retry)', async () => {
    globalThis.fetch = makePublicKeyFetchMock([], {
      status: 503,
      body: 'unavailable',
    }) as unknown as typeof fetch;
    const env = envWith();
    // need a syntactically valid JWT to reach the key fetch path.
    const fixture = await makeKeyFixture('k1');
    const jwt = await signJwt(fixture);
    const body = JSON.stringify(makeMessageEvent('spaces/A/messages/M1'));
    const resp = await handleGoogleChatWebhook(
      buildRequest(body, `Bearer ${jwt}`),
      env,
    );
    expect(resp.status).toBe(500);
  });

  it('public key cache: second verify in same isolate skips re-fetch', async () => {
    const fixture = await makeKeyFixture('k1');
    const fetchMock = makePublicKeyFetchMock([fixture]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const env = envWith();

    const jwt1 = await signJwt(fixture);
    const r1 = await handleGoogleChatWebhook(
      buildRequest(
        JSON.stringify(makeMessageEvent('spaces/A/messages/M1')),
        `Bearer ${jwt1}`,
      ),
      env,
    );
    expect(r1.status).toBe(200);

    // second event, distinct message.name to avoid dedupe duplicate path.
    const jwt2 = await signJwt(fixture);
    const r2 = await handleGoogleChatWebhook(
      buildRequest(
        JSON.stringify(makeMessageEvent('spaces/A/messages/M2')),
        `Bearer ${jwt2}`,
      ),
      env,
    );
    expect(r2.status).toBe(200);
    // public-key fetch should have been called exactly once.
    expect(fetchMock.calls.length).toBe(1);
  });

  it('500 when GCP_BOT_PROJECT_NUMBER env is missing', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const env = envWith({
      GCP_BOT_PROJECT_NUMBER: undefined as unknown as string,
    });
    const jwt = await signJwt(fixture);
    const body = JSON.stringify(makeMessageEvent('spaces/A/messages/M1'));
    const resp = await handleGoogleChatWebhook(
      buildRequest(body, `Bearer ${jwt}`),
      env,
    );
    expect(resp.status).toBe(500);
  });
});

describe('verifyGoogleChatJwt (unit)', () => {
  let origFetch: typeof fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
    _resetPublicKeyCacheForTesting();
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    _resetPublicKeyCacheForTesting();
  });

  it('returns the decoded payload for a valid JWT', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const jwt = await signJwt(fixture);
    const claims = await verifyGoogleChatJwt(jwt, PROJECT_NUMBER);
    expect(claims).not.toBeNull();
    expect(claims!.iss).toBe(ISSUER);
    expect(claims!.aud).toBe(PROJECT_NUMBER);
  });

  it('returns the decoded payload when any expected audience matches', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const endpointUrl = 'https://example.test/webhooks/google-chat';
    const jwt = await signJwt(fixture, { aud: endpointUrl });
    const claims = await verifyGoogleChatJwt(jwt, [PROJECT_NUMBER, endpointUrl]);
    expect(claims).not.toBeNull();
    expect(claims!.aud).toBe(endpointUrl);
  });

  it('returns null for a non-JWT string', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const claims = await verifyGoogleChatJwt('not-a-jwt', PROJECT_NUMBER);
    expect(claims).toBeNull();
  });
});
