/**
 * Unit tests for `src/lib/chat-oauth.ts` — Chat User OAuth refresh
 * for `chat.messages.readonly` scope (Issue #186 #7).
 *
 * Covers:
 *   - first call: seed the vault from the Worker secret, refresh via
 *     Google /token, return a fresh access_token
 *   - second call: module-level cache hit (no fetch)
 *   - cache expiry → re-refresh (via fake timers)
 *   - Google rotates the refresh_token → vault is updated
 *   - existing vault entry takes precedence over the seed
 *   - missing seed + empty vault → ChatOAuthError
 *   - Google 401 → ChatOAuthError
 *   - malformed Google response (no access_token / expires_in) → error
 *
 * Real Google API calls happen in the Day 3 实机 E2E
 * (`.claude/rules/makoto-kun-verification.md`); these unit tests
 * intercept fetch.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getChatReadonlyAccessToken,
  ChatOAuthError,
  CHAT_BOT_USER_SLUG,
  CHAT_MESSAGES_READONLY_SCOPE,
  _resetChatOAuthCacheForTests,
} from '../src/lib/chat-oauth';
import {
  getRefreshToken,
  putRefreshToken,
} from '../src/lib/oauth-vault';
import {
  makeKv,
  makeFetchMock,
  TEST_VAULT_KEY_B64,
} from './makoto-helpers';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

function tokenResponse(
  body: { access_token?: string; expires_in?: number; refresh_token?: string },
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function baseDeps(
  overrides: Partial<Parameters<typeof getChatReadonlyAccessToken>[0]> = {},
) {
  const kv = makeKv();
  return {
    kv,
    vaultKeyB64: TEST_VAULT_KEY_B64,
    clientId: 'chat-client-id.apps.googleusercontent.com',
    clientSecret: 'chat-client-secret-value',
    refreshTokenSeed: 'seed-refresh-token-AAA',
    ...overrides,
  };
}

describe('chat-oauth scope constant', () => {
  it('matches the Cloud Run side scope literal', () => {
    expect(CHAT_MESSAGES_READONLY_SCOPE).toBe(
      'https://www.googleapis.com/auth/chat.messages.readonly',
    );
  });

  it('uses the singleton bot slug', () => {
    expect(CHAT_BOT_USER_SLUG).toBe('gchat-bot');
  });
});

describe('getChatReadonlyAccessToken', () => {
  beforeEach(() => {
    _resetChatOAuthCacheForTests();
  });

  it('seeds the vault from Worker secret on first use and returns a fresh token', async () => {
    const deps = baseDeps();
    const fetchMock = makeFetchMock(async (url, init) => {
      expect(url).toBe(GOOGLE_TOKEN_URL);
      expect(init.method).toBe('POST');
      const params = new URLSearchParams(init.body as string);
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('client_id')).toBe(deps.clientId);
      expect(params.get('client_secret')).toBe(deps.clientSecret);
      expect(params.get('refresh_token')).toBe(deps.refreshTokenSeed);
      return tokenResponse({ access_token: 'ya29.fresh-1', expires_in: 3600 });
    });
    const result = await getChatReadonlyAccessToken({
      ...deps,
      fetchImpl: fetchMock,
    });
    expect(result.access_token).toBe('ya29.fresh-1');
    expect(result.from_cache).toBe(false);
    // Vault now holds the seed (so future cold starts skip the seed copy).
    expect(
      await getRefreshToken(deps.kv, deps.vaultKeyB64, CHAT_BOT_USER_SLUG),
    ).toBe(deps.refreshTokenSeed);
    expect(fetchMock.calls).toHaveLength(1);
  });

  it('serves from the module cache on the second call (no Google fetch)', async () => {
    const deps = baseDeps();
    const fetchMock = makeFetchMock(async () =>
      tokenResponse({ access_token: 'ya29.fresh-2', expires_in: 3600 }),
    );
    const a = await getChatReadonlyAccessToken({ ...deps, fetchImpl: fetchMock });
    expect(a.from_cache).toBe(false);
    const b = await getChatReadonlyAccessToken({ ...deps, fetchImpl: fetchMock });
    expect(b.access_token).toBe('ya29.fresh-2');
    expect(b.from_cache).toBe(true);
    expect(fetchMock.calls).toHaveLength(1);
  });

  it('re-refreshes after the cached token enters the 5-minute margin', async () => {
    const deps = baseDeps();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-26T00:00:00Z'));
      const fetchMock = makeFetchMock(async () => {
        const seq = fetchMock.calls.length; // call we're handling, 1-indexed
        return tokenResponse({
          access_token: `ya29.token-${seq}`,
          expires_in: 3600,
        });
      });
      const first = await getChatReadonlyAccessToken({
        ...deps,
        fetchImpl: fetchMock,
      });
      expect(first.access_token).toBe('ya29.token-1');

      // Advance past 3600 - 5 min = 55 minutes → next call should refresh.
      vi.setSystemTime(new Date('2026-05-26T00:56:00Z'));
      const second = await getChatReadonlyAccessToken({
        ...deps,
        fetchImpl: fetchMock,
      });
      expect(second.from_cache).toBe(false);
      expect(second.access_token).toBe('ya29.token-2');
      expect(fetchMock.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists a rotated refresh_token back to the vault', async () => {
    const deps = baseDeps();
    const fetchMock = makeFetchMock(async () =>
      tokenResponse({
        access_token: 'ya29.rotated-1',
        expires_in: 3600,
        refresh_token: 'seed-refresh-token-BBB', // Google rotated
      }),
    );
    const result = await getChatReadonlyAccessToken({
      ...deps,
      fetchImpl: fetchMock,
    });
    expect(result.access_token).toBe('ya29.rotated-1');
    expect(
      await getRefreshToken(deps.kv, deps.vaultKeyB64, CHAT_BOT_USER_SLUG),
    ).toBe('seed-refresh-token-BBB');
  });

  it('prefers an existing vault entry over the Worker secret seed', async () => {
    const deps = baseDeps();
    await putRefreshToken(
      deps.kv,
      deps.vaultKeyB64,
      CHAT_BOT_USER_SLUG,
      'vault-refresh-token-CCC',
    );
    const fetchMock = makeFetchMock(async (_url, init) => {
      const params = new URLSearchParams(init.body as string);
      expect(params.get('refresh_token')).toBe('vault-refresh-token-CCC');
      return tokenResponse({ access_token: 'ya29.ok', expires_in: 3600 });
    });
    await getChatReadonlyAccessToken({ ...deps, fetchImpl: fetchMock });
    expect(fetchMock.calls).toHaveLength(1);
    // Seed must not overwrite the vault entry.
    expect(
      await getRefreshToken(deps.kv, deps.vaultKeyB64, CHAT_BOT_USER_SLUG),
    ).toBe('vault-refresh-token-CCC');
  });

  it('throws ChatOAuthError when both the vault entry and the seed are empty', async () => {
    const deps = baseDeps({ refreshTokenSeed: '' });
    const fetchMock = makeFetchMock(async () => {
      throw new Error('fetch must not be called when no refresh_token exists');
    });
    await expect(
      getChatReadonlyAccessToken({ ...deps, fetchImpl: fetchMock }),
    ).rejects.toBeInstanceOf(ChatOAuthError);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it('throws ChatOAuthError on Google 401 (revoked refresh_token)', async () => {
    const deps = baseDeps();
    const fetchMock = makeFetchMock(async () =>
      tokenResponse(
        { /* google body */ error: 'invalid_grant' } as unknown as {
          access_token?: string;
          expires_in?: number;
        },
        401,
      ),
    );
    await expect(
      getChatReadonlyAccessToken({ ...deps, fetchImpl: fetchMock }),
    ).rejects.toThrow(/status=401/);
  });

  it('throws ChatOAuthError on malformed Google response (no access_token)', async () => {
    const deps = baseDeps();
    const fetchMock = makeFetchMock(async () =>
      tokenResponse({ expires_in: 3600 }), // missing access_token
    );
    await expect(
      getChatReadonlyAccessToken({ ...deps, fetchImpl: fetchMock }),
    ).rejects.toThrow(/malformed response/);
  });

  it('honours a custom userSlug for the cache key', async () => {
    const deps = baseDeps({ userSlug: 'gchat-bot-tenant-b' });
    const fetchMock = makeFetchMock(async () =>
      tokenResponse({ access_token: 'ya29.tenant-b', expires_in: 3600 }),
    );
    const result = await getChatReadonlyAccessToken({
      ...deps,
      fetchImpl: fetchMock,
    });
    expect(result.access_token).toBe('ya29.tenant-b');
    expect(
      await getRefreshToken(deps.kv, deps.vaultKeyB64, 'gchat-bot-tenant-b'),
    ).toBe(deps.refreshTokenSeed);
  });
});
