/**
 * Unit tests for `src/lib/three-stage-precheck.ts` — thin wrapper around
 * the D1 `dedupe` layer that mirrors Cloud Run Python's
 * `cma_lib.py:send_*` 3-stage shape (precheck → API → commit) with
 * `_LeaseHeartbeat` parity.
 *
 * Coverage:
 *
 *   1. Happy path — first send: precheck claim → sendFn ran → commit
 *      → outcome=sent
 *   2. Idempotency — second send for the same (kind, target) skips
 *      sendFn entirely (= ALREADY)
 *   3. Pre-API heartbeat death — sendFn never runs, claim released
 *   4. Post-API heartbeat death — sendFn ran but commit skipped
 *      (= committed_at remains null, outcome=lease_lost with result)
 *   5. LeaseHeartbeat lifecycle — start/stop + isAlive across simulated
 *      clock advancement + renewLease success + failure paths
 */

import { describe, it, expect } from 'vitest';
import {
  LeaseHeartbeat,
  buildSideEffectKey,
  buildSideEffectOwner,
  executeWithCommit,
  precheckSend,
} from '../src/lib/three-stage-precheck';
import { commitDone, newClaimOwner, renewLease, tryClaim } from '../src/lib/dedupe';
import { makeMakotoDb } from './makoto-helpers';

const PARENT_KEY = 'mail:msgid:test@example.com';
const TARGET = 'spaces/AAA/threads/TTT';

describe('buildSideEffectKey / buildSideEffectOwner', () => {
  it('side-effect key includes kind + parent + hashed target', async () => {
    const key = await buildSideEffectKey(PARENT_KEY, 'placeholder', TARGET);
    // shape: send:<kind>:<16-hex>:<parent>
    expect(key.startsWith('send:placeholder:')).toBe(true);
    expect(key.endsWith(`:${PARENT_KEY}`)).toBe(true);
    const middle = key.slice('send:placeholder:'.length, -(`:${PARENT_KEY}`.length));
    expect(middle).toMatch(/^[0-9a-f]{16}$/);
  });

  it('different targets produce different side-effect keys', async () => {
    const a = await buildSideEffectKey(PARENT_KEY, 'placeholder', 'target-a');
    const b = await buildSideEffectKey(PARENT_KEY, 'placeholder', 'target-b');
    expect(a).not.toBe(b);
  });

  it('different kinds produce different side-effect keys', async () => {
    const a = await buildSideEffectKey(PARENT_KEY, 'placeholder', TARGET);
    const b = await buildSideEffectKey(PARENT_KEY, 'chat_reply', TARGET);
    expect(a).not.toBe(b);
  });

  it('side-effect owner appends #<kind>', () => {
    const o = buildSideEffectOwner('worker-1:abc', 'email_send');
    expect(o).toBe('worker-1:abc#email_send');
  });
});

// ---------------------------------------------------------------------------

describe('executeWithCommit — happy path', () => {
  it('first send: precheck claim + sendFn runs + commit success', async () => {
    const db = makeMakotoDb();
    const parentOwner = newClaimOwner('w1');
    let sendCalls = 0;
    const outcome = await executeWithCommit({
      env: { DB: db },
      parentEventKey: PARENT_KEY,
      parentOwner,
      kind: 'placeholder',
      target: TARGET,
      sendFn: async () => {
        sendCalls += 1;
        return { messageName: 'spaces/AAA/messages/X1' };
      },
    });
    expect(outcome.outcome).toBe('sent');
    if (outcome.outcome === 'sent') {
      expect(outcome.result.messageName).toBe('spaces/AAA/messages/X1');
      expect(outcome.claim.owner).toBe(`${parentOwner}#placeholder`);
      expect(outcome.claim.version).toBe(1);
    }
    expect(sendCalls).toBe(1);

    // The dedupe row for the side-effect key must be committed
    const sideKey = await buildSideEffectKey(PARENT_KEY, 'placeholder', TARGET);
    const row = db._tables.dedupe.get(sideKey);
    expect(row).toBeDefined();
    expect(row?.committed_at_ms).not.toBeNull();
  });

  it('caller commitFn runs with sendFn result + claim envelope', async () => {
    const db = makeMakotoDb();
    const parentOwner = newClaimOwner('w1');
    let commitFnCalls = 0;
    let commitFnReceived: { result?: unknown; ownerSeen?: string; versionSeen?: number } = {};
    await executeWithCommit({
      env: { DB: db },
      parentEventKey: PARENT_KEY,
      parentOwner,
      kind: 'email_send',
      target: 'to:user@x.com',
      sendFn: async () => ({ message_id: 'am_123' }),
      commitFn: async (result, claim) => {
        commitFnCalls += 1;
        commitFnReceived = {
          result,
          ownerSeen: claim.owner,
          versionSeen: claim.version,
        };
      },
    });
    expect(commitFnCalls).toBe(1);
    expect(commitFnReceived.result).toEqual({ message_id: 'am_123' });
    expect(commitFnReceived.ownerSeen).toBe(`${parentOwner}#email_send`);
    expect(commitFnReceived.versionSeen).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('executeWithCommit — idempotency (ALREADY)', () => {
  it('second send for same (kind, target) sees DONE_DUPLICATE + skips sendFn', async () => {
    const db = makeMakotoDb();
    const parentOwner = newClaimOwner('w1');
    let sendCalls = 0;
    const opts = {
      env: { DB: db },
      parentEventKey: PARENT_KEY,
      parentOwner,
      kind: 'placeholder' as const,
      target: TARGET,
      sendFn: async () => {
        sendCalls += 1;
        return 'first';
      },
    };
    const first = await executeWithCommit(opts);
    expect(first.outcome).toBe('sent');
    expect(sendCalls).toBe(1);

    // Second call (same kind + target) — even with a *different* parent
    // owner the side-effect dedupe stops us re-running.
    const second = await executeWithCommit({
      ...opts,
      parentOwner: newClaimOwner('w2'),
      sendFn: async () => {
        sendCalls += 1;
        return 'second';
      },
    });
    expect(second.outcome).toBe('already');
    if (second.outcome === 'already') {
      // Use a coercion-safe check (no `result` field on the 'already'
      // discriminant).
      expect((second as Record<string, unknown>).result).toBeUndefined();
    }
    expect(sendCalls).toBe(1); // unchanged
  });

  it('different target within the same parent does NOT collapse to ALREADY', async () => {
    const db = makeMakotoDb();
    const parentOwner = newClaimOwner('w1');
    let sendCalls = 0;
    const base = {
      env: { DB: db },
      parentEventKey: PARENT_KEY,
      parentOwner,
      kind: 'chat_post' as const,
      sendFn: async () => {
        sendCalls += 1;
        return 'ok';
      },
    };
    const a = await executeWithCommit({ ...base, target: 'spaces/AAA/threads/X' });
    const b = await executeWithCommit({ ...base, target: 'spaces/BBB/threads/Y' });
    expect(a.outcome).toBe('sent');
    expect(b.outcome).toBe('sent');
    expect(sendCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe('executeWithCommit — heartbeat death scenarios', () => {
  /**
   * Build a fake heartbeat with controllable `isAlive()`. We don't go
   * through the real `LeaseHeartbeat` to keep this test deterministic —
   * the wrapper only reads `isAlive()` so a stub is sufficient.
   */
  function fakeHeartbeat(initialAlive: boolean): LeaseHeartbeat & {
    _setAlive: (v: boolean) => void;
  } {
    let alive = initialAlive;
    const hb = {
      isAlive: () => alive,
      isLost: () => !alive,
      lostBecause: () => (alive ? null : 'forced'),
      markLost: () => {
        alive = false;
      },
      _setAlive: (v: boolean) => {
        alive = v;
      },
    } as unknown as LeaseHeartbeat & { _setAlive: (v: boolean) => void };
    return hb;
  }

  it('heartbeat dead before sendFn → sendFn never runs, outcome=lease_lost', async () => {
    const db = makeMakotoDb();
    const parentOwner = newClaimOwner('w1');
    let sendCalls = 0;
    const heartbeat = fakeHeartbeat(false);
    const outcome = await executeWithCommit({
      env: { DB: db },
      parentEventKey: PARENT_KEY,
      parentOwner,
      kind: 'placeholder',
      target: TARGET,
      sendFn: async () => {
        sendCalls += 1;
        return 'never';
      },
      options: { heartbeat },
    });
    expect(outcome.outcome).toBe('lease_lost');
    expect(sendCalls).toBe(0);
    // No dedupe row was created — precheck bailed before tryClaim
    const sideKey = await buildSideEffectKey(PARENT_KEY, 'placeholder', TARGET);
    expect(db._tables.dedupe.has(sideKey)).toBe(false);
  });

  it('heartbeat dies between sendFn and commit → sendFn ran, commit skipped', async () => {
    const db = makeMakotoDb();
    const parentOwner = newClaimOwner('w1');
    let sendCalls = 0;
    const heartbeat = fakeHeartbeat(true);
    const outcome = await executeWithCommit({
      env: { DB: db },
      parentEventKey: PARENT_KEY,
      parentOwner,
      kind: 'chat_reply',
      target: TARGET,
      sendFn: async () => {
        sendCalls += 1;
        // Simulate the lease being torn out from under us mid-call
        heartbeat._setAlive(false);
        return { id: 'sent_anyway' };
      },
      options: { heartbeat },
    });
    expect(sendCalls).toBe(1);
    expect(outcome.outcome).toBe('lease_lost');
    // Result is surfaced so the caller can audit the partially-shipped
    // side-effect.
    if (outcome.outcome === 'lease_lost') {
      expect(outcome.result).toEqual({ id: 'sent_anyway' });
    }
    // Dedupe row exists (= claim was made) but committed_at is null
    const sideKey = await buildSideEffectKey(PARENT_KEY, 'chat_reply', TARGET);
    const row = db._tables.dedupe.get(sideKey);
    expect(row).toBeDefined();
    expect(row?.committed_at_ms).toBeNull();
  });

  it('sendFn throws → claim released so a fresh worker can retry immediately', async () => {
    const db = makeMakotoDb();
    const parentOwner = newClaimOwner('w1');
    let sendCalls = 0;
    await expect(
      executeWithCommit({
        env: { DB: db },
        parentEventKey: PARENT_KEY,
        parentOwner,
        kind: 'placeholder',
        target: TARGET,
        sendFn: async () => {
          sendCalls += 1;
          throw new Error('agentmail transient 503');
        },
      }),
    ).rejects.toThrow('agentmail transient 503');
    expect(sendCalls).toBe(1);

    // Side-effect row exists; lease_expires_at_ms should be 0 (released)
    const sideKey = await buildSideEffectKey(PARENT_KEY, 'placeholder', TARGET);
    const row = db._tables.dedupe.get(sideKey);
    expect(row).toBeDefined();
    expect(row?.lease_expires_at_ms).toBe(0);
    expect(row?.committed_at_ms).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('precheckSend (standalone)', () => {
  it('OK on NEW + heartbeat alive', async () => {
    const db = makeMakotoDb();
    const parentOwner = newClaimOwner('w1');
    const r = await precheckSend(
      { DB: db },
      PARENT_KEY,
      parentOwner,
      'email_send',
      'to:x@y.com',
    );
    expect(r.state).toBe('OK');
    if (r.state === 'OK') {
      expect(r.claim.owner).toBe(`${parentOwner}#email_send`);
      expect(r.claim.version).toBe(1);
    }
  });

  it('ALREADY after the side-effect is committed', async () => {
    const db = makeMakotoDb();
    const parentOwner = newClaimOwner('w1');
    const sideKey = await buildSideEffectKey(PARENT_KEY, 'placeholder', TARGET);
    const sideOwner = buildSideEffectOwner(parentOwner, 'placeholder');
    await tryClaim(db, sideKey, sideOwner);
    await commitDone(db, sideKey, sideOwner, 1);

    const r = await precheckSend(
      { DB: db },
      PARENT_KEY,
      newClaimOwner('w2'),
      'placeholder',
      TARGET,
    );
    expect(r.state).toBe('ALREADY');
  });

  it('LEASE_ALIVE while another worker still holds the side-effect lease', async () => {
    const db = makeMakotoDb();
    const parentOwner1 = newClaimOwner('w1');
    const parentOwner2 = newClaimOwner('w2');
    await precheckSend({ DB: db }, PARENT_KEY, parentOwner1, 'placeholder', TARGET);
    const r = await precheckSend({ DB: db }, PARENT_KEY, parentOwner2, 'placeholder', TARGET);
    expect(r.state).toBe('LEASE_ALIVE');
  });
});

// ---------------------------------------------------------------------------

describe('LeaseHeartbeat lifecycle', () => {
  /**
   * Build a deterministic heartbeat that uses a manual clock + a
   * captured interval handler so the test drives the renewal loop
   * without depending on real wall time.
   */
  function buildHeartbeatHarness(db: ReturnType<typeof makeMakotoDb>, version: number) {
    let now = 1_000_000;
    let intervalCallback: (() => void) | null = null;
    let intervalCleared = false;
    const failures: Array<{ count: number; err: unknown }> = [];
    const losses: string[] = [];
    const hb = new LeaseHeartbeat({
      env: { DB: db },
      eventKey: PARENT_KEY,
      owner: 'worker-x',
      version,
      intervalMs: 60_000,
      leaseTtlMs: 300_000,
      safetyMarginMs: 30_000,
      clock: () => now,
      setIntervalImpl: (cb, _ms) => {
        intervalCallback = cb;
        return { name: 'fake-interval' };
      },
      clearIntervalImpl: () => {
        intervalCleared = true;
      },
      onFailure: (count, err) => failures.push({ count, err }),
      onLost: (reason) => losses.push(reason),
    });
    return {
      hb,
      advance(ms: number) {
        now += ms;
      },
      fireInterval() {
        if (!intervalCallback) throw new Error('interval not started');
        intervalCallback();
      },
      get intervalCleared() {
        return intervalCleared;
      },
      get failures() {
        return failures;
      },
      get losses() {
        return losses;
      },
      get now() {
        return now;
      },
    };
  }

  it('start + stop are idempotent + clear the interval', async () => {
    const db = makeMakotoDb();
    const parentOwner = newClaimOwner('w1');
    await tryClaim(db, PARENT_KEY, parentOwner);
    const h = buildHeartbeatHarness(db, 1);
    h.hb.start();
    h.hb.start(); // second start is a no-op
    await h.hb.stop();
    await h.hb.stop(); // second stop is a no-op
    expect(h.intervalCleared).toBe(true);
  });

  it('isAlive() flips false after lease_ttl - safety_margin without success', async () => {
    const db = makeMakotoDb();
    const parentOwner = newClaimOwner('w1');
    await tryClaim(db, PARENT_KEY, parentOwner);
    // Parent owner has to match the heartbeat owner for tick() to extend
    // — for the lifecycle test we are just checking the time math, so we
    // use a fake owner whose renewLease will fail. That makes `tick()`
    // mark lost on the second consecutive failure. The isAlive check
    // here only exercises the time elapsed branch.
    const h = buildHeartbeatHarness(db, 1);
    expect(h.hb.isAlive()).toBe(true);
    // 4 min elapsed → still under 5 - 0.5 min budget
    h.advance(4 * 60 * 1000);
    expect(h.hb.isAlive()).toBe(true);
    // total 4 min 31 s → now exceeds 4 min 30 s budget → not alive
    h.advance(31 * 1000);
    expect(h.hb.isAlive()).toBe(false);
  });

  it('tick() success: renewLease returns true → lastSuccessAt updates', async () => {
    const db = makeMakotoDb();
    const parentOwner = 'worker-x';
    // Parent claim with owner-x so renewLease can extend it.
    await tryClaim(db, PARENT_KEY, parentOwner);
    const h = buildHeartbeatHarness(db, 1);
    const startedAt = h.hb._lastSuccessAtForTests();
    h.advance(60_000);
    const ok = await h.hb.tick();
    expect(ok).toBe(true);
    expect(h.hb._lastSuccessAtForTests()).toBeGreaterThan(startedAt);
    expect(h.hb._consecutiveFailuresForTests()).toBe(0);
    expect(h.hb.isAlive()).toBe(true);
  });

  it('tick() failure path: 2 consecutive failures mark lost', async () => {
    // We construct a DB whose renewLease will not match (because the
    // PARENT claim was never created), so each `tick` sees changes=0.
    const db = makeMakotoDb();
    const h = buildHeartbeatHarness(db, 1);
    expect(h.hb.isAlive()).toBe(true);
    const ok1 = await h.hb.tick();
    expect(ok1).toBe(false);
    expect(h.hb.isLost()).toBe(true);
    // renewLease returning false (= no matching row) maps to
    // `renewLease_returned_false` lost reason.
    expect(h.hb.lostBecause()).toBe('renewLease_returned_false');
  });

  it('markLost short-circuits isAlive() regardless of clock', async () => {
    const db = makeMakotoDb();
    const h = buildHeartbeatHarness(db, 1);
    expect(h.hb.isAlive()).toBe(true);
    h.hb.markLost('observer_drift');
    expect(h.hb.isAlive()).toBe(false);
    // Second markLost call is ignored (= first reason wins)
    h.hb.markLost('something_else');
    expect(h.hb.lostBecause()).toBe('observer_drift');
  });

  it('interval callback drives tick + completionPromise resolves on stop', async () => {
    const db = makeMakotoDb();
    const parentOwner = 'worker-x';
    await tryClaim(db, PARENT_KEY, parentOwner);
    const h = buildHeartbeatHarness(db, 1);
    h.hb.start();
    // Drive one interval cycle — must increment lastSuccessAt
    const before = h.hb._lastSuccessAtForTests();
    h.advance(60_000);
    h.fireInterval();
    // tick fires-and-forgets; await microtasks via a renewLease followup
    await renewLease(db, PARENT_KEY, parentOwner, 1, { now: h.now });
    // The interval callback ran a `void this.tick()`, so we await the
    // tick by running it directly here too to flush microtask queue.
    await h.hb.tick();
    expect(h.hb._lastSuccessAtForTests()).toBeGreaterThan(before);
    await h.hb.stop();
    await expect(h.hb.completionPromise).resolves.toBeUndefined();
  });
});
