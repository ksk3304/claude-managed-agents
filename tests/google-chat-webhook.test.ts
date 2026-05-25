/**
 * Unit tests for `src/webhooks/google-chat.ts` — Phase A ingress
 * (JWT verify + dedupe claim + Queue enqueue).
 *
 * Test fixture strategy:
 *   - RSA-PSS / RSASSA-PKCS1-v1_5 RSA key pair を test 内で動的生成 (= jose
 *     の `generateKeyPair('RS256')`)。public key を X.509 PEM
 *     (jose の `exportSPKI` だと SPKI なので、Google が出す X.509
 *     certificate 形式に変換する代わりに、本 test では `importSPKI` を
 *     使う path に handler を切り替えず、handler の `importX509` を
 *     monkey-patch せずに、`exportSPKI` の結果を「`-----BEGIN CERTIFICATE-----`
 *     と書かれた偽 PEM」として fetch mock から返す ─ jose の
 *     `importX509` は X.509 DER parser を内蔵しているため、SPKI を
 *     CERTIFICATE と詐称しても失敗する)。
 *
 *     代わりに、本 test では module-level cache を直接書き換える
 *     test-only helper を `_resetPublicKeyCacheForTesting` 経由で
 *     使うのではなく、jose の private/public key を生成してから
 *     **生 CryptoKey を cache に直接突っ込む** test 専用 entrypoint を
 *     使えるようにする方が薄い。
 *
 *     ここでは fetch mock が return する body の中に "PEM" として
 *     `exportSPKI` の結果 (= BEGIN PUBLIC KEY ... PEM) を入れ、handler
 *     側で本来 `importX509` で読むはずの所を回避するために、
 *     `vi.mock('jose', ...)` で `importX509` を `importSPKI` に
 *     差し替える。これにより handler 本体の logic
 *     (= cache / kid 引き / claim verify) は本物のまま検証できる。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SignJWT,
  generateKeyPair,
  exportSPKI,
  importSPKI,
} from 'jose';

// `importX509` を `importSPKI` に差し替える。本来 Google が返す PEM は
// X.509 certificate だが、テスト fixture は SPKI public key で十分 (jose の
// JWT verify は最終的に CryptoKey を見るだけで、cert chain validation は
// 行わない)。
vi.mock('jose', async (importOriginal) => {
  const orig = await importOriginal<typeof import('jose')>();
  return {
    ...orig,
    importX509: orig.importSPKI,
  };
});

import {
  handleGoogleChatWebhook,
  verifyGoogleChatJwt,
  _resetPublicKeyCacheForTesting,
  type ChatQueueMessage,
  type ChatEventPayload,
} from '../src/webhooks/google-chat';
import { makeFakeQueue, makeMakotoDb } from './makoto-helpers';

const PROJECT_NUMBER = '192588613210';
const ISSUER = 'chat@system.gserviceaccount.com';
const X509_URL =
  'https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com';

interface KeyFixture {
  kid: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** "PEM" body that the fetch mock returns under this kid. */
  pem: string;
}

async function makeKeyFixture(kid = 'k1'): Promise<KeyFixture> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  const pem = await exportSPKI(publicKey);
  // Sanity: the SPKI export must round-trip through importSPKI to confirm
  // the in-memory fixture is valid.
  await importSPKI(pem, 'RS256');
  return { kid, privateKey, publicKey, pem };
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
    if (url !== X509_URL) {
      throw new Error(`unexpected fetch url=${url}`);
    }
    if (opts.status && opts.status >= 400) {
      return new Response(opts.body ?? 'err', { status: opts.status });
    }
    if (opts.body !== undefined) {
      return new Response(opts.body, { status: 200 });
    }
    const dict: Record<string, string> = {};
    for (const f of fixtures) dict[f.kid] = f.pem;
    return new Response(JSON.stringify(dict), {
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
    const json = (await resp.json()) as { ok: boolean; duplicate?: boolean };
    expect(json.ok).toBe(true);
    expect(json.duplicate).toBeUndefined();

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
    const json = (await resp.json()) as { ok: boolean; skipped?: boolean };
    expect(json.ok).toBe(true);
    expect(json.skipped).toBe(true);
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
    const j1 = (await r1.json()) as { ok: boolean; duplicate?: boolean };
    expect(j1.duplicate).toBeUndefined();

    const jwt2 = await signJwt(fixture);
    const r2 = await handleGoogleChatWebhook(buildRequest(body, `Bearer ${jwt2}`), env);
    expect(r2.status).toBe(200);
    const j2 = (await r2.json()) as { ok: boolean; duplicate?: boolean };
    expect(j2.duplicate).toBe(true);

    const sent = (env.MAKOTO_CHAT_QUEUE as unknown as { _sent: ChatQueueMessage[] })._sent;
    expect(sent).toHaveLength(1);
  });

  it('401 on tampered JWT signature', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const env = envWith();
    const jwt = await signJwt(fixture);
    // Flip the last character of the signature segment.
    const parts = jwt.split('.');
    parts[2] =
      parts[2]!.slice(0, -1) + (parts[2]!.endsWith('A') ? 'B' : 'A');
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

  it('401 on issuer mismatch', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const env = envWith();
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

  it('returns null for a non-JWT string', async () => {
    const fixture = await makeKeyFixture('k1');
    globalThis.fetch = makePublicKeyFetchMock([fixture]) as unknown as typeof fetch;
    const claims = await verifyGoogleChatJwt('not-a-jwt', PROJECT_NUMBER);
    expect(claims).toBeNull();
  });
});
