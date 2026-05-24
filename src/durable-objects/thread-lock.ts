/**
 * Per-thread / per-message exclusion Durable Object.
 *
 * The AgentMail Queue consumer takes a lock keyed by the RFC 822
 * Message-ID before doing any side-effecting work, to keep two parallel
 * consumer invocations from running `sessions.create` + `AgentMail.send`
 * for the same inbound message at the same time. The D1 `dedupe` table
 * already fences double-commit; the DO catches in-flight overlap before
 * either side reaches its commit point.
 *
 * One DO instance per thread key (`idFromName(threadKey)`) — Cloudflare
 * single-threads execution per instance, so the Map below is safe
 * without explicit locks. State lives only in-memory; a DO eviction
 * simply releases the lock early, which is acceptable because the
 * dedupe fence catches the race in that narrow window.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 7 — 層 5)
 * Spec: plan-draft.md §step 7 + R6
 */

const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;

export interface AcquireResult {
  acquired: boolean;
  /** Set when `acquired=false`; ms until the current holder's lease ends. */
  retry_after_ms?: number;
}

export interface ReleaseResult {
  released: boolean;
}

export interface ExtendResult {
  extended: boolean;
}

export class ThreadLock {
  private state: DurableObjectState;
  // expires_at_ms keyed by sub-key. Typical use is one entry per DO
  // instance (caller calls `idFromName(threadKey)`), but we accept a
  // sub-key so a thread DO can hold multiple per-message locks if a
  // future caller needs that.
  private locks: Map<string, number>;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    this.locks = new Map();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const key = url.searchParams.get('key') ?? 'default';
    const now = Date.now();

    if (action === 'acquire') {
      const ttl = parseTtl(url.searchParams.get('ttl_ms'));
      const existing = this.locks.get(key);
      if (existing !== undefined && existing > now) {
        return Response.json({
          acquired: false,
          retry_after_ms: existing - now,
        } satisfies AcquireResult);
      }
      this.locks.set(key, now + ttl);
      return Response.json({ acquired: true } satisfies AcquireResult);
    }

    if (action === 'release') {
      this.locks.delete(key);
      return Response.json({ released: true } satisfies ReleaseResult);
    }

    if (action === 'extend') {
      const ttl = parseTtl(url.searchParams.get('ttl_ms'));
      // Refresh whether or not the lock was already present — caller
      // is asserting ownership, so we just push the deadline forward.
      this.locks.set(key, now + ttl);
      return Response.json({ extended: true } satisfies ExtendResult);
    }

    return new Response('unknown action', { status: 400 });
  }
}

function parseTtl(raw: string | null): number {
  if (!raw) return DEFAULT_LOCK_TTL_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOCK_TTL_MS;
}

// ----------------------------------------------------------------------------
// RPC-style wrapper for callers. Keeps the URL plumbing out of the
// consumer call sites and gives us a typed surface for unit testing
// (= the consumer can be tested against a fake `ThreadLockStub` that
// matches this interface).
// ----------------------------------------------------------------------------

export interface ThreadLockStub {
  /**
   * Attempt to acquire the lock for `key`. Returns `{ acquired: true }`
   * on success; `{ acquired: false, retry_after_ms }` if another caller
   * still holds an unexpired lease.
   */
  acquire(key: string, ttlMs?: number): Promise<AcquireResult>;
  /** Release the lock unconditionally. */
  release(key: string): Promise<ReleaseResult>;
  /** Refresh the lock deadline (no ownership check — caller-assertion). */
  extend(key: string, ttlMs?: number): Promise<ExtendResult>;
}

/**
 * Build a stub for the DO that owns `threadKey`. The DO instance is
 * picked by `idFromName(threadKey)` so callers operating on the same
 * key always land on the same instance.
 */
export function getThreadLock(env: Env, threadKey: string): ThreadLockStub {
  const id = env.MAKOTO_THREAD_LOCK.idFromName(threadKey);
  const stub = env.MAKOTO_THREAD_LOCK.get(id);
  return {
    async acquire(key: string, ttlMs?: number): Promise<AcquireResult> {
      const u = new URL('https://internal/');
      u.searchParams.set('action', 'acquire');
      u.searchParams.set('key', key);
      if (ttlMs !== undefined) u.searchParams.set('ttl_ms', String(ttlMs));
      const r = await stub.fetch(u.toString());
      return (await r.json()) as AcquireResult;
    },
    async release(key: string): Promise<ReleaseResult> {
      const u = new URL('https://internal/');
      u.searchParams.set('action', 'release');
      u.searchParams.set('key', key);
      const r = await stub.fetch(u.toString());
      return (await r.json()) as ReleaseResult;
    },
    async extend(key: string, ttlMs?: number): Promise<ExtendResult> {
      const u = new URL('https://internal/');
      u.searchParams.set('action', 'extend');
      u.searchParams.set('key', key);
      if (ttlMs !== undefined) u.searchParams.set('ttl_ms', String(ttlMs));
      const r = await stub.fetch(u.toString());
      return (await r.json()) as ExtendResult;
    },
  };
}
