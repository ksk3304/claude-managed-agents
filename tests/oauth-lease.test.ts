// OAuthLease DO unit tests. Drives the class directly (no miniflare)
// so we cover the lease state machine, cache freshness margin, and the
// oauth_audit write path through an in-memory fake D1.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { OAuthLease } from '../src/durable-objects/oauth-lease';
import { makeMakotoDb } from './makoto-helpers';

function makeLease() {
  const db = makeMakotoDb();
  const env = { DB: db } as unknown as Env;
  const state = {} as unknown as DurableObjectState;
  const lease = new OAuthLease(state, env);
  return { lease, db };
}

async function post(lease: OAuthLease, action: string, body: unknown): Promise<unknown> {
  const u = new URL(`https://internal/?action=${action}`);
  const res = await lease.fetch(
    new Request(u.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return res.json();
}

describe('OAuthLease.getOrLease', () => {
  it('grants a lease on the first call for a user', async () => {
    const { lease } = makeLease();
    const r = (await post(lease, 'getOrLease', { userSlug: 'alice' })) as {
      kind: string;
      leaseId: string;
    };
    expect(r.kind).toBe('leased');
    expect(typeof r.leaseId).toBe('string');
  });

  it('returns busy while a lease is still in-flight', async () => {
    const { lease } = makeLease();
    await post(lease, 'getOrLease', { userSlug: 'alice', leaseTtlMs: 10_000 });
    const r = (await post(lease, 'getOrLease', { userSlug: 'alice' })) as {
      kind: string;
      retryAfterMs: number;
    };
    expect(r.kind).toBe('busy');
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it('returns cached token after commit while still fresh', async () => {
    const { lease } = makeLease();
    const grant = (await post(lease, 'getOrLease', { userSlug: 'alice' })) as {
      leaseId: string;
    };
    await post(lease, 'commit', {
      userSlug: 'alice',
      leaseId: grant.leaseId,
      accessToken: 'ya29.tok-alice',
      expiresInMs: 5 * 60 * 1000,
    });
    const r = (await post(lease, 'getOrLease', { userSlug: 'alice' })) as {
      kind: string;
      accessToken: string;
    };
    expect(r.kind).toBe('cached');
    expect(r.accessToken).toBe('ya29.tok-alice');
  });

  it('treats a token inside the freshness margin as expired', async () => {
    const { lease } = makeLease();
    const grant = (await post(lease, 'getOrLease', { userSlug: 'alice' })) as {
      leaseId: string;
    };
    // expires in 30s — inside the 60s freshness margin, so the next
    // getOrLease should reissue a lease instead of returning cached.
    await post(lease, 'commit', {
      userSlug: 'alice',
      leaseId: grant.leaseId,
      accessToken: 'ya29.tok-stale',
      expiresInMs: 30 * 1000,
    });
    const r = (await post(lease, 'getOrLease', { userSlug: 'alice' })) as {
      kind: string;
    };
    expect(r.kind).toBe('leased');
  });
});

describe('OAuthLease.commit', () => {
  it('rejects commit without a matching lease id', async () => {
    const { lease } = makeLease();
    await post(lease, 'getOrLease', { userSlug: 'alice' });
    const r = (await post(lease, 'commit', {
      userSlug: 'alice',
      leaseId: 'wrong-id',
      accessToken: 'x',
      expiresInMs: 60_000,
    })) as { ok: boolean; reason: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('lease');
  });

  it('writes a refresh audit row on success', async () => {
    const { lease, db } = makeLease();
    const grant = (await post(lease, 'getOrLease', { userSlug: 'alice' })) as {
      leaseId: string;
    };
    await post(lease, 'commit', {
      userSlug: 'alice',
      leaseId: grant.leaseId,
      accessToken: 'ya29.ok',
      expiresInMs: 60_000,
      callerSessionId: 'sesn_42',
    });
    expect(db._tables.oauth_audit.length).toBe(1);
    expect(db._tables.oauth_audit[0]).toMatchObject({
      user_slug: 'alice',
      action: 'refresh',
      outcome: 'success',
      caller_session_id: 'sesn_42',
    });
  });

  it('writes a rotate audit row when refresh_token rotated', async () => {
    const { lease, db } = makeLease();
    const grant = (await post(lease, 'getOrLease', { userSlug: 'alice' })) as {
      leaseId: string;
    };
    await post(lease, 'commit', {
      userSlug: 'alice',
      leaseId: grant.leaseId,
      accessToken: 'ya29.new',
      expiresInMs: 60_000,
      refreshTokenRotated: true,
    });
    expect(db._tables.oauth_audit[0]?.action).toBe('rotate');
  });
});

describe('OAuthLease.release', () => {
  it('frees the lease and audits with the failure outcome', async () => {
    const { lease, db } = makeLease();
    const grant = (await post(lease, 'getOrLease', { userSlug: 'alice' })) as {
      leaseId: string;
    };
    await post(lease, 'release', {
      userSlug: 'alice',
      leaseId: grant.leaseId,
      outcome: 'fail',
      notes: 'google_token_endpoint_500',
    });
    expect(db._tables.oauth_audit[0]).toMatchObject({
      user_slug: 'alice',
      action: 'refresh',
      outcome: 'fail',
      notes: 'google_token_endpoint_500',
    });
    // Next getOrLease should grant — the lease was actually released.
    const after = (await post(lease, 'getOrLease', { userSlug: 'alice' })) as {
      kind: string;
    };
    expect(after.kind).toBe('leased');
  });
});

describe('OAuthLease.invalidate', () => {
  it('drops the cached token and audits a revoke', async () => {
    const { lease, db } = makeLease();
    const grant = (await post(lease, 'getOrLease', { userSlug: 'alice' })) as {
      leaseId: string;
    };
    await post(lease, 'commit', {
      userSlug: 'alice',
      leaseId: grant.leaseId,
      accessToken: 'ya29.gone',
      expiresInMs: 60_000,
    });
    await post(lease, 'invalidate', { userSlug: 'alice', reason: 'user_revoked' });
    const after = (await post(lease, 'getOrLease', { userSlug: 'alice' })) as {
      kind: string;
    };
    expect(after.kind).toBe('leased');
    expect(db._tables.oauth_audit.at(-1)).toMatchObject({
      user_slug: 'alice',
      action: 'revoke',
      outcome: 'success',
      notes: 'user_revoked',
    });
  });
});

describe('OAuthLease.fetch error paths', () => {
  it('rejects unknown actions with 400', async () => {
    const { lease } = makeLease();
    const u = new URL('https://internal/?action=bogus');
    const res = await lease.fetch(new Request(u.toString(), { method: 'POST' }));
    expect(res.status).toBe(400);
  });

  it('rejects getOrLease without userSlug', async () => {
    const { lease } = makeLease();
    const u = new URL('https://internal/?action=getOrLease');
    const res = await lease.fetch(
      new Request(u.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('OAuthLease — DB audit failures must not crash the lease path', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('still grants the commit even when the audit insert throws', async () => {
    const db = makeMakotoDb();
    // Sabotage the oauth_audit insert path.
    const orig = db.prepare.bind(db);
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      if (/oauth_audit/i.test(sql)) {
        return {
          bind: () => ({
            run: async () => {
              throw new Error('forced d1 outage');
            },
          }),
        };
      }
      return orig(sql);
    };
    const env = { DB: db } as unknown as Env;
    const lease = new OAuthLease({} as unknown as DurableObjectState, env);
    const grant = (await post(lease, 'getOrLease', { userSlug: 'alice' })) as {
      leaseId: string;
    };
    const r = (await post(lease, 'commit', {
      userSlug: 'alice',
      leaseId: grant.leaseId,
      accessToken: 'ya29.ok',
      expiresInMs: 60_000,
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
