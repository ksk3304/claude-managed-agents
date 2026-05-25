/**
 * Unit tests for `src/lib/workspace-oauth.ts` — Google OAuth refresh /
 * revoke + OAuth lease DO wire-up + D1 audit.
 *
 * v4 (Phase 8 wire-up): the refresh path now serialises through the
 * OAuth lease DO, so the test fake covers the same state machine the
 * real DO does.
 */

import { describe, it, expect } from 'vitest';
import { getAccessToken, revokeUser, bootstrapUser } from '../src/lib/workspace-oauth';
import { putRefreshToken } from '../src/lib/oauth-vault';
import type {
  OAuthLeaseStub,
  GetOrLeaseResult,
  CommitResult,
  ReleaseResult,
} from '../src/durable-objects/oauth-lease';
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

/**
 * In-memory OAuthLease stub. Mirrors the contract of the real DO
 * (cache freshness margin, lease state machine, audit log into a
 * captured array). Tests can introspect `audit` to assert the action
 * the lease actually wrote.
 *
 * `setCommitRejects` / `setInvalidateRejects` force the next RPC of
 * the matching kind to return `{ ok: false }` so the regression tests
 * for #186 round 2 (Codex must-fix: DO RPC result ignored) can drive
 * the lease into the failure branch deterministically.
 */
function makeFakeOAuthLease(): OAuthLeaseStub & {
  audit: Array<{
    user_slug: string;
    action: string;
    outcome: string;
    notes: string | null;
    caller_session_id: string | null;
  }>;
  setCached(userSlug: string, accessToken: string, expiresInMs: number): void;
  setBusy(userSlug: string, retryAfterMs: number): void;
  setCommitRejects(userSlug: string, reason?: string): void;
  setInvalidateRejects(userSlug: string): void;
} {
  const tokens = new Map<string, { accessToken: string; expiresAt: number }>();
  const leases = new Map<string, string>();
  const forcedBusy = new Map<string, number>();
  const forceCommitReject = new Map<string, string>();
  const forceInvalidateReject = new Set<string>();
  const audit: Array<{
    user_slug: string;
    action: string;
    outcome: string;
    notes: string | null;
    caller_session_id: string | null;
  }> = [];

  return {
    audit,
    setCached(userSlug, accessToken, expiresInMs) {
      tokens.set(userSlug, { accessToken, expiresAt: Date.now() + expiresInMs });
    },
    setBusy(userSlug, retryAfterMs) {
      forcedBusy.set(userSlug, Date.now() + retryAfterMs);
    },
    setCommitRejects(userSlug, reason = 'lease not held') {
      forceCommitReject.set(userSlug, reason);
    },
    setInvalidateRejects(userSlug) {
      forceInvalidateReject.add(userSlug);
    },
    async getOrLease(userSlug): Promise<GetOrLeaseResult> {
      const now = Date.now();
      const forcedUntil = forcedBusy.get(userSlug);
      if (forcedUntil && forcedUntil > now) {
        return { kind: 'busy', retryAfterMs: forcedUntil - now };
      }
      const cached = tokens.get(userSlug);
      if (cached && cached.expiresAt - 60_000 > now) {
        return {
          kind: 'cached',
          accessToken: cached.accessToken,
          expiresInMs: cached.expiresAt - now,
        };
      }
      if (leases.has(userSlug)) {
        return { kind: 'busy', retryAfterMs: 100 };
      }
      const id = `lease-${userSlug}-${Math.random().toString(36).slice(2, 8)}`;
      leases.set(userSlug, id);
      return { kind: 'leased', leaseId: id, leaseTtlMs: 30_000 };
    },
    async commit(input): Promise<CommitResult> {
      const forced = forceCommitReject.get(input.userSlug);
      if (forced !== undefined) {
        forceCommitReject.delete(input.userSlug);
        return { ok: false, reason: forced };
      }
      const held = leases.get(input.userSlug);
      if (held !== input.leaseId) return { ok: false, reason: 'lease not held' };
      leases.delete(input.userSlug);
      tokens.set(input.userSlug, {
        accessToken: input.accessToken,
        expiresAt: Date.now() + input.expiresInMs,
      });
      audit.push({
        user_slug: input.userSlug,
        action: input.refreshTokenRotated ? 'rotate' : 'refresh',
        outcome: 'success',
        notes: input.notes ?? null,
        caller_session_id: input.callerSessionId ?? null,
      });
      return { ok: true };
    },
    async release(input): Promise<ReleaseResult> {
      const held = leases.get(input.userSlug);
      if (held === input.leaseId) leases.delete(input.userSlug);
      audit.push({
        user_slug: input.userSlug,
        action: 'refresh',
        outcome: input.outcome ?? 'fail',
        notes: input.notes ?? null,
        caller_session_id: input.callerSessionId ?? null,
      });
      return { ok: true };
    },
    async invalidate(input): Promise<ReleaseResult> {
      if (forceInvalidateReject.has(input.userSlug)) {
        forceInvalidateReject.delete(input.userSlug);
        return { ok: false };
      }
      tokens.delete(input.userSlug);
      leases.delete(input.userSlug);
      audit.push({
        user_slug: input.userSlug,
        action: 'revoke',
        outcome: 'success',
        notes: input.reason ?? null,
        caller_session_id: input.callerSessionId ?? null,
      });
      return { ok: true };
    },
  };
}

describe('getAccessToken (DO-routed)', () => {
  it('returns null when no refresh_token is in the vault (lease released)', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    const oauthLease = makeFakeOAuthLease();
    const fetchImpl = makeFetchMock(async () => new Response('', { status: 200 }));
    const r = await getAccessToken(
      { db, kv, fetchImpl, oauthLease, ...OAUTH_DEPS_BASE },
      'alice',
    );
    expect(r).toBeNull();
    expect(oauthLease.audit).toEqual([
      expect.objectContaining({ action: 'refresh', outcome: 'fail', notes: 'no_refresh_token_in_vault' }),
    ]);
  });

  it('refreshes and caches on first call, returns cached on second', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    const oauthLease = makeFakeOAuthLease();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'refresh-1');
    const fetchImpl = makeFetchMock(async () =>
      jsonResponse(200, { access_token: 'access-1', expires_in: 3600 }),
    );
    const r = await getAccessToken(
      { db, kv, fetchImpl, oauthLease, ...OAUTH_DEPS_BASE },
      'alice',
    );
    expect(r).not.toBeNull();
    expect(r!.access_token).toBe('access-1');
    expect(r!.from_cache).toBe(false);
    // DO cached it via commit; the second call short-circuits.
    const r2 = await getAccessToken(
      { db, kv, fetchImpl, oauthLease, ...OAUTH_DEPS_BASE },
      'alice',
    );
    expect(r2!.from_cache).toBe(true);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('audits a successful refresh via the DO (action: refresh / outcome: success)', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    const oauthLease = makeFakeOAuthLease();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'refresh-1');
    const fetchImpl = makeFetchMock(async () =>
      jsonResponse(200, { access_token: 'a', expires_in: 3600 }),
    );
    await getAccessToken(
      { db, kv, fetchImpl, oauthLease, ...OAUTH_DEPS_BASE },
      'alice',
      { callerSessionId: 'sesn_1' },
    );
    expect(oauthLease.audit).toEqual([
      expect.objectContaining({
        user_slug: 'alice',
        action: 'refresh',
        outcome: 'success',
        caller_session_id: 'sesn_1',
      }),
    ]);
  });

  it('returns null + invalidates DO cache + deletes vault on 401 (revoked token)', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    const oauthLease = makeFakeOAuthLease();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'refresh-1');
    const fetchImpl = makeFetchMock(async () => new Response('bad', { status: 401 }));
    const r = await getAccessToken(
      { db, kv, fetchImpl, oauthLease, ...OAUTH_DEPS_BASE },
      'alice',
    );
    expect(r).toBeNull();
    expect(await kv.get('vault:oauth:alice:refresh_token')).toBeNull();
    expect(oauthLease.audit).toEqual([
      expect.objectContaining({
        action: 'revoke',
        outcome: 'success',
        notes: 'refresh_token_revoked_401',
      }),
    ]);
  });

  it('rotates the refresh_token when Google returns a new one and audits via DO', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    const oauthLease = makeFakeOAuthLease();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'refresh-old');
    const fetchImpl = makeFetchMock(async () =>
      jsonResponse(200, {
        access_token: 'a',
        expires_in: 3600,
        refresh_token: 'refresh-new',
      }),
    );
    await getAccessToken(
      { db, kv, fetchImpl, oauthLease, ...OAUTH_DEPS_BASE },
      'alice',
    );
    expect(oauthLease.audit).toEqual([
      expect.objectContaining({
        action: 'rotate',
        outcome: 'success',
      }),
    ]);
  });

  it('waits briefly then succeeds when the lease comes back from busy', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    const oauthLease = makeFakeOAuthLease();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'refresh-1');
    // First call returns busy; once the forced-busy window elapses the
    // retry path takes the lease itself.
    oauthLease.setBusy('alice', 50);
    const fetchImpl = makeFetchMock(async () =>
      jsonResponse(200, { access_token: 'a-after-wait', expires_in: 3600 }),
    );
    const r = await getAccessToken(
      { db, kv, fetchImpl, oauthLease, ...OAUTH_DEPS_BASE },
      'alice',
    );
    expect(r!.access_token).toBe('a-after-wait');
  });

  it('returns null when busy persists across the retry', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    const oauthLease = makeFakeOAuthLease();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'refresh-1');
    oauthLease.setBusy('alice', 10_000);
    const fetchImpl = makeFetchMock(async () =>
      jsonResponse(200, { access_token: 'a', expires_in: 3600 }),
    );
    const r = await getAccessToken(
      { db, kv, fetchImpl, oauthLease, ...OAUTH_DEPS_BASE },
      'alice',
    );
    expect(r).toBeNull();
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('throws if deps.oauthLease is missing (config error, not silent fall-through)', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'refresh-1');
    const fetchImpl = makeFetchMock(async () => new Response('', { status: 200 }));
    await expect(
      getAccessToken({ db, kv, fetchImpl, ...OAUTH_DEPS_BASE }, 'alice'),
    ).rejects.toThrow(/oauthLease/);
  });

  it('returns null + releases lease when DO commit rejects (lease lost race)', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    const oauthLease = makeFakeOAuthLease();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'refresh-1');
    oauthLease.setCommitRejects('alice', 'lease expired before commit');
    const fetchImpl = makeFetchMock(async () =>
      jsonResponse(200, { access_token: 'AT-stranded', expires_in: 3600 }),
    );
    const r = await getAccessToken(
      { db, kv, fetchImpl, oauthLease, ...OAUTH_DEPS_BASE },
      'alice',
    );
    // The token must NOT be returned — it was never committed to the
    // lease, so handing it out would leak an unaudited access_token.
    expect(r).toBeNull();
    // Release with the rejection reason audited as a fail.
    expect(
      oauthLease.audit.some(
        (a) =>
          a.outcome === 'fail' &&
          (a.notes ?? '').includes('commit_rejected'),
      ),
    ).toBe(true);
  });
});

describe('revokeUser', () => {
  it('calls Google revoke endpoint + deletes the vault entry + invalidates DO cache', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    const oauthLease = makeFakeOAuthLease();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'refresh-1');
    let revokeCalled = false;
    const fetchImpl = makeFetchMock(async (url) => {
      if (url.includes('/revoke')) {
        revokeCalled = true;
        return new Response('', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await revokeUser(
      { db, kv, fetchImpl, oauthLease, ...OAUTH_DEPS_BASE },
      'alice',
    );
    expect(revokeCalled).toBe(true);
    expect(await kv.get('vault:oauth:alice:refresh_token')).toBeNull();
    expect(oauthLease.audit).toEqual([
      expect.objectContaining({ action: 'revoke', outcome: 'success', notes: 'revoke' }),
    ]);
  });

  it('writes a D1 revoke audit row when the lease is not wired in (CLI path)', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'refresh-1');
    const fetchImpl = makeFetchMock(async () => new Response('', { status: 200 }));
    await revokeUser(
      { db, kv, fetchImpl, ...OAUTH_DEPS_BASE },
      'alice',
    );
    expect(db._tables.oauth_audit.some((r) => r.action === 'revoke')).toBe(true);
  });

  it('throws + records a fail audit when DO invalidate rejects (cache may still serve stale token)', async () => {
    const kv = makeKv();
    const db = makeMakotoDb();
    const oauthLease = makeFakeOAuthLease();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'refresh-1');
    oauthLease.setInvalidateRejects('alice');
    const fetchImpl = makeFetchMock(async (url) => {
      if (url.includes('/revoke')) return new Response('', { status: 200 });
      throw new Error(`unexpected: ${url}`);
    });
    await expect(
      revokeUser({ db, kv, fetchImpl, oauthLease, ...OAUTH_DEPS_BASE }, 'alice'),
    ).rejects.toThrow(/oauth lease invalidate failed/);
    // D1 audit captures the failure so the operator can audit the
    // partial-revoke state.
    expect(
      db._tables.oauth_audit.some(
        (r) => r.action === 'revoke' && r.outcome === 'fail',
      ),
    ).toBe(true);
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
