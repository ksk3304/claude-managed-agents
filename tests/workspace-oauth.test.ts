/**
 * Unit tests for `src/lib/workspace-oauth.ts` — Google OAuth refresh /
 * revoke + KV cache + D1 audit.
 */

import { describe, it, expect } from 'vitest';
import { getAccessToken, revokeUser, bootstrapUser } from '../src/lib/workspace-oauth';
import { putRefreshToken } from '../src/lib/oauth-vault';
import {
  makeKv,
  makeFetchMock,
  makeMakotoDb,
  TEST_VAULT_KEY_B64,
} from './makoto-helpers';

const OAUTH_DEPS_BASE = {
  vaultKeyB64: TEST_VAULT_KEY_B64,
  clientId: 'client-id',
  clientSecret: 'client-secret',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('getAccessToken', () => {
  it('returns null when no refresh_token is in the vault', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    const fetchImpl = makeFetchMock(async () => new Response('', { status: 200 }));
    const r = await getAccessToken({ db, kv, fetchImpl, ...OAUTH_DEPS_BASE }, 'alice');
    expect(r).toBeNull();
  });

  it('refreshes and caches on first call', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'refresh-1');
    const fetchImpl = makeFetchMock(async () =>
      jsonResponse(200, { access_token: 'access-1', expires_in: 3600 }),
    );
    const r = await getAccessToken({ db, kv, fetchImpl, ...OAUTH_DEPS_BASE }, 'alice');
    expect(r).not.toBeNull();
    expect(r!.access_token).toBe('access-1');
    expect(r!.from_cache).toBe(false);
    // Second call within TTL hits the cache.
    const r2 = await getAccessToken({ db, kv, fetchImpl, ...OAUTH_DEPS_BASE }, 'alice');
    expect(r2!.from_cache).toBe(true);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('audits a successful refresh', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'refresh-1');
    const fetchImpl = makeFetchMock(async () =>
      jsonResponse(200, { access_token: 'a', expires_in: 3600 }),
    );
    await getAccessToken({ db, kv, fetchImpl, ...OAUTH_DEPS_BASE }, 'alice', {
      callerSessionId: 'sesn_1',
    });
    const audit = db._tables.oauth_audit;
    // 1 row for get_refresh + 1 row for refresh success.
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(audit.some((r) => r.action === 'refresh' && r.outcome === 'success')).toBe(
      true,
    );
  });

  it('returns null + deletes vault on 401 (revoked token)', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'refresh-1');
    const fetchImpl = makeFetchMock(async () => new Response('bad', { status: 401 }));
    const r = await getAccessToken({ db, kv, fetchImpl, ...OAUTH_DEPS_BASE }, 'alice');
    expect(r).toBeNull();
    // vault entry deleted (fail-close).
    expect(await kv.get('vault:oauth:alice:refresh_token')).toBeNull();
  });

  it('rotates the refresh_token when Google returns a new one', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'refresh-old');
    const fetchImpl = makeFetchMock(async () =>
      jsonResponse(200, {
        access_token: 'a',
        expires_in: 3600,
        refresh_token: 'refresh-new',
      }),
    );
    await getAccessToken({ db, kv, fetchImpl, ...OAUTH_DEPS_BASE }, 'alice');
    // Audit row should show rotation.
    expect(db._tables.oauth_audit.some((r) => r.action === 'rotate')).toBe(true);
  });
});

describe('revokeUser', () => {
  it('calls Google revoke endpoint + deletes the vault entry', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'refresh-1');
    let revokeCalled = false;
    const fetchImpl = makeFetchMock(async (url) => {
      if (url.includes('/revoke')) {
        revokeCalled = true;
        return new Response('', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await revokeUser({ db, kv, fetchImpl, ...OAUTH_DEPS_BASE }, 'alice');
    expect(revokeCalled).toBe(true);
    expect(await kv.get('vault:oauth:alice:refresh_token')).toBeNull();
    expect(db._tables.oauth_audit.some((r) => r.action === 'revoke')).toBe(true);
  });
});

describe('bootstrapUser', () => {
  it('writes the vault entry + audit row', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    const fetchImpl = makeFetchMock(async () => new Response('', { status: 200 }));
    await bootstrapUser(
      { db, kv, fetchImpl, ...OAUTH_DEPS_BASE },
      'alice',
      'refresh-fresh',
    );
    expect(await kv.get('vault:oauth:alice:refresh_token')).not.toBeNull();
    expect(db._tables.oauth_audit.some((r) => r.action === 'bootstrap')).toBe(true);
  });
});
