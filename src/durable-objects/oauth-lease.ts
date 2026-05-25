/**
 * Per-user OAuth lease + token cache Durable Object.
 *
 * Serialises Google Workspace OAuth refresh work for the AgentMail
 * bridge. One DO instance per user (`idFromName(userSlug)`) so all
 * refresh attempts for the same user funnel through the same
 * single-threaded actor — no in-flight refresh race, no duplicate
 * audit-log rows, no cross-region thundering herd on Google's token
 * endpoint.
 *
 * Three concerns kept in one place:
 *   1. access_token cache (in-memory; ~50min TTL). Cache hits skip the
 *      refresh round-trip entirely.
 *   2. per-user refresh lease (in-memory; short TTL). Only the lease
 *      holder calls Google /token; everyone else either uses the cached
 *      token or backs off until the holder commits.
 *   3. D1 `oauth_audit` writes (per-user serial via the DO).
 *
 * The DO does NOT call Google's token endpoint itself — the caller (the
 * queue consumer) does, with the lease in hand. This keeps subrequest
 * budget on the consumer Worker (15min wall / 5min CPU / 10k subrequests)
 * where it belongs, and keeps the DO body small and fast.
 *
 * State lives only in-memory. A DO eviction simply re-issues a lease
 * to the next caller; the same KV-backed refresh_token survives.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 OAuth lease — plan v4 §5.4.3)
 */

import { randomUUID } from 'node:crypto';

const DEFAULT_LEASE_TTL_MS = 30 * 1000;
/**
 * Treat a token as expired this far ahead of its real expiry so a
 * downstream Google API call doesn't race the wire-level token death.
 */
const TOKEN_FRESHNESS_MARGIN_MS = 60 * 1000;

export type GetOrLeaseResult =
  | { kind: 'cached'; accessToken: string; expiresInMs: number }
  | { kind: 'leased'; leaseId: string; leaseTtlMs: number }
  | { kind: 'busy'; retryAfterMs: number };

export interface CommitResult {
  ok: boolean;
  reason?: string;
}

export interface ReleaseResult {
  ok: boolean;
}

export type AuditOutcome = 'success' | 'fail' | 'rotated' | 'busy_skip';

interface LeaseRecord {
  id: string;
  expiresAt: number;
}

interface TokenRecord {
  accessToken: string;
  expiresAt: number;
}

export class OAuthLease {
  private state: DurableObjectState;
  private env: Env;
  private leases: Map<string, LeaseRecord>;
  private tokens: Map<string, TokenRecord>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.leases = new Map();
    this.tokens = new Map();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    if (action === 'getOrLease') return this.handleGetOrLease(request);
    if (action === 'commit') return this.handleCommit(request);
    if (action === 'release') return this.handleRelease(request);
    if (action === 'invalidate') return this.handleInvalidate(request);
    return new Response('unknown action', { status: 400 });
  }

  private async handleGetOrLease(request: Request): Promise<Response> {
    const body = (await request.json()) as { userSlug?: string; leaseTtlMs?: number };
    const userSlug = body.userSlug;
    if (typeof userSlug !== 'string' || userSlug.length === 0) {
      return Response.json({ kind: 'error', reason: 'userSlug required' }, { status: 400 });
    }
    const now = Date.now();
    const ttl = clampPositive(body.leaseTtlMs, DEFAULT_LEASE_TTL_MS);

    const cached = this.tokens.get(userSlug);
    if (cached && cached.expiresAt - TOKEN_FRESHNESS_MARGIN_MS > now) {
      return Response.json(
        { kind: 'cached', accessToken: cached.accessToken, expiresInMs: cached.expiresAt - now } satisfies GetOrLeaseResult,
      );
    }

    const existingLease = this.leases.get(userSlug);
    if (existingLease && existingLease.expiresAt > now) {
      return Response.json(
        { kind: 'busy', retryAfterMs: existingLease.expiresAt - now } satisfies GetOrLeaseResult,
      );
    }

    const lease: LeaseRecord = { id: randomUUID(), expiresAt: now + ttl };
    this.leases.set(userSlug, lease);
    return Response.json(
      { kind: 'leased', leaseId: lease.id, leaseTtlMs: ttl } satisfies GetOrLeaseResult,
    );
  }

  private async handleCommit(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      userSlug?: string;
      leaseId?: string;
      accessToken?: string;
      expiresInMs?: number;
      refreshTokenRotated?: boolean;
      callerSessionId?: string | null;
      notes?: string | null;
    };
    const userSlug = body.userSlug;
    const leaseId = body.leaseId;
    const accessToken = body.accessToken;
    const expiresInMs = body.expiresInMs;
    if (
      typeof userSlug !== 'string' ||
      typeof leaseId !== 'string' ||
      typeof accessToken !== 'string' ||
      typeof expiresInMs !== 'number' ||
      !Number.isFinite(expiresInMs) ||
      expiresInMs <= 0
    ) {
      return Response.json(
        { ok: false, reason: 'invalid args' } satisfies CommitResult,
        { status: 400 },
      );
    }
    const lease = this.leases.get(userSlug);
    if (!lease || lease.id !== leaseId) {
      return Response.json(
        { ok: false, reason: 'lease not held' } satisfies CommitResult,
        { status: 409 },
      );
    }

    const now = Date.now();
    this.tokens.set(userSlug, { accessToken, expiresAt: now + expiresInMs });
    this.leases.delete(userSlug);

    const action = body.refreshTokenRotated ? 'rotate' : 'refresh';
    await this.writeAudit(userSlug, action, 'success', body.callerSessionId ?? null, body.notes ?? null);

    return Response.json({ ok: true } satisfies CommitResult);
  }

  private async handleRelease(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      userSlug?: string;
      leaseId?: string;
      outcome?: AuditOutcome;
      callerSessionId?: string | null;
      notes?: string | null;
    };
    const userSlug = body.userSlug;
    const leaseId = body.leaseId;
    if (typeof userSlug !== 'string' || typeof leaseId !== 'string') {
      return Response.json({ ok: false } satisfies ReleaseResult, { status: 400 });
    }
    const lease = this.leases.get(userSlug);
    if (lease && lease.id === leaseId) {
      this.leases.delete(userSlug);
    }
    const outcome: AuditOutcome = body.outcome ?? 'fail';
    await this.writeAudit(
      userSlug,
      'refresh',
      outcome,
      body.callerSessionId ?? null,
      body.notes ?? null,
    );
    return Response.json({ ok: true } satisfies ReleaseResult);
  }

  private async handleInvalidate(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      userSlug?: string;
      reason?: string;
      callerSessionId?: string | null;
    };
    const userSlug = body.userSlug;
    if (typeof userSlug !== 'string' || userSlug.length === 0) {
      return Response.json({ ok: false } satisfies ReleaseResult, { status: 400 });
    }
    this.tokens.delete(userSlug);
    this.leases.delete(userSlug);
    await this.writeAudit(
      userSlug,
      'revoke',
      'success',
      body.callerSessionId ?? null,
      body.reason ?? null,
    );
    return Response.json({ ok: true } satisfies ReleaseResult);
  }

  private async writeAudit(
    userSlug: string,
    action: string,
    outcome: AuditOutcome,
    callerSessionId: string | null,
    notes: string | null,
  ): Promise<void> {
    try {
      await this.env.DB.prepare(
        `INSERT INTO oauth_audit (timestamp_ms, user_slug, caller_session_id, action, outcome, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(Date.now(), userSlug, callerSessionId, action, outcome, notes)
        .run();
    } catch (err) {
      // Audit must not block the lease path. Surface to logs so the
      // operator can spot persistent failures.
      console.error(
        `[oauth-lease] audit write failed user=${userSlug} action=${action} outcome=${outcome}:`,
        err,
      );
    }
  }
}

function clampPositive(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

// ----------------------------------------------------------------------------
// RPC-style wrapper for callers. Mirrors `thread-lock.ts:getThreadLock`
// so consumer code reads naturally and tests can swap in a stub.
// ----------------------------------------------------------------------------

export interface OAuthLeaseStub {
  getOrLease(userSlug: string, leaseTtlMs?: number): Promise<GetOrLeaseResult>;
  commit(input: {
    userSlug: string;
    leaseId: string;
    accessToken: string;
    expiresInMs: number;
    refreshTokenRotated?: boolean;
    callerSessionId?: string | null;
    notes?: string | null;
  }): Promise<CommitResult>;
  release(input: {
    userSlug: string;
    leaseId: string;
    outcome?: AuditOutcome;
    callerSessionId?: string | null;
    notes?: string | null;
  }): Promise<ReleaseResult>;
  invalidate(input: {
    userSlug: string;
    reason?: string;
    callerSessionId?: string | null;
  }): Promise<ReleaseResult>;
}

export function getOAuthLease(env: Env, userSlug: string): OAuthLeaseStub {
  const id = env.MAKOTO_OAUTH_LEASE.idFromName(userSlug);
  const stub = env.MAKOTO_OAUTH_LEASE.get(id);
  const post = async (action: string, body: unknown): Promise<Response> => {
    const u = new URL('https://internal/');
    u.searchParams.set('action', action);
    return stub.fetch(u.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  };
  return {
    async getOrLease(userSlug, leaseTtlMs) {
      const r = await post('getOrLease', { userSlug, leaseTtlMs });
      return (await r.json()) as GetOrLeaseResult;
    },
    async commit(input) {
      const r = await post('commit', input);
      return (await r.json()) as CommitResult;
    },
    async release(input) {
      const r = await post('release', input);
      return (await r.json()) as ReleaseResult;
    },
    async invalidate(input) {
      const r = await post('invalidate', input);
      return (await r.json()) as ReleaseResult;
    },
  };
}
