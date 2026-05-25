/**
 * Unit tests for `src/lib/dedupe.ts` — D1 claim / lease / commit fence.
 *
 * 4-state machine: NEW / TAKEOVER / LEASE_ALIVE / DONE_DUPLICATE.
 * Plus owner+version fence on commit_done / confirmOwner / releaseClaim
 * (= 旧 worker 死後送信 / 二重返信を構造排除する Codex 2 周目 must-fix #2).
 */

import { describe, it, expect } from 'vitest';
import {
  commitDone,
  confirmOwner,
  eventKeyForRfc822,
  eventKeyForSvix,
  newClaimOwner,
  pruneExpiredDedupe,
  releaseClaim,
  renewLease,
  tryClaim,
} from '../src/lib/dedupe';
import { makeMakotoDb } from './makoto-helpers';

const KEY = 'mail:msgid:test@example.com';
const LEASE_MS = 5 * 60 * 1000;

describe('eventKey helpers', () => {
  it('eventKeyForSvix prefixes with agentmail:event', () => {
    expect(eventKeyForSvix('svix_abc')).toBe('agentmail:event:svix_abc');
  });
  it('eventKeyForRfc822 strips brackets + lowercases', () => {
    expect(eventKeyForRfc822('<ABC@Example.COM>')).toBe('mail:msgid:abc@example.com');
  });
});

describe('newClaimOwner', () => {
  it('appends a random UUID to the instance id', () => {
    const a = newClaimOwner('worker-1');
    const b = newClaimOwner('worker-1');
    expect(a).not.toBe(b);
    expect(a.startsWith('worker-1:')).toBe(true);
  });
});

describe('tryClaim — 4 state', () => {
  it('NEW: first writer gets state=NEW, version=1', async () => {
    const db = makeMakotoDb();
    const owner = newClaimOwner('w1');
    const r = await tryClaim(db, KEY, owner, { leaseTtlMs: LEASE_MS });
    expect(r.state).toBe('NEW');
    expect(r.owner).toBe(owner);
    expect(r.version).toBe(1);
  });

  it('LEASE_ALIVE: second writer while lease is alive gets skip', async () => {
    const db = makeMakotoDb();
    const owner1 = newClaimOwner('w1');
    const owner2 = newClaimOwner('w2');
    await tryClaim(db, KEY, owner1, { leaseTtlMs: LEASE_MS });
    const r = await tryClaim(db, KEY, owner2, { leaseTtlMs: LEASE_MS });
    expect(r.state).toBe('LEASE_ALIVE');
  });

  it('TAKEOVER: successor wins after lease expires', async () => {
    const db = makeMakotoDb();
    const owner1 = newClaimOwner('w1');
    const owner2 = newClaimOwner('w2');
    const t0 = 1_000_000;
    await tryClaim(db, KEY, owner1, { leaseTtlMs: 100, now: t0 });
    // jump past lease expiry
    const r = await tryClaim(db, KEY, owner2, { leaseTtlMs: 100, now: t0 + 200 });
    expect(r.state).toBe('TAKEOVER');
    expect(r.owner).toBe(owner2);
    expect(r.version).toBe(2);
  });

  it('DONE_DUPLICATE: committed row short-circuits with state=DONE_DUPLICATE', async () => {
    const db = makeMakotoDb();
    const owner1 = newClaimOwner('w1');
    await tryClaim(db, KEY, owner1, { leaseTtlMs: LEASE_MS });
    await commitDone(db, KEY, owner1, 1);
    const r = await tryClaim(db, KEY, newClaimOwner('w2'), { leaseTtlMs: LEASE_MS });
    expect(r.state).toBe('DONE_DUPLICATE');
  });
});

describe('commit / confirm / release fences', () => {
  it('commitDone rejects a stale owner', async () => {
    const db = makeMakotoDb();
    const owner1 = newClaimOwner('w1');
    await tryClaim(db, KEY, owner1, { leaseTtlMs: LEASE_MS });
    const ok = await commitDone(db, KEY, 'someone-else', 1);
    expect(ok).toBe(false);
  });

  it('commitDone rejects mismatched version (= successor bumped it)', async () => {
    const db = makeMakotoDb();
    const owner1 = newClaimOwner('w1');
    const owner2 = newClaimOwner('w2');
    const t0 = 1_000_000;
    await tryClaim(db, KEY, owner1, { leaseTtlMs: 100, now: t0 });
    await tryClaim(db, KEY, owner2, { leaseTtlMs: 100, now: t0 + 200 });
    // owner1 still thinks it owns version=1 → commit with v=1 should fail.
    const ok = await commitDone(db, KEY, owner1, 1);
    expect(ok).toBe(false);
  });

  it('confirmOwner returns true while we still own the claim', async () => {
    const db = makeMakotoDb();
    const owner = newClaimOwner('w1');
    await tryClaim(db, KEY, owner, { leaseTtlMs: LEASE_MS });
    expect(await confirmOwner(db, KEY, owner, 1)).toBe(true);
  });

  it('confirmOwner returns false once committed', async () => {
    const db = makeMakotoDb();
    const owner = newClaimOwner('w1');
    await tryClaim(db, KEY, owner, { leaseTtlMs: LEASE_MS });
    await commitDone(db, KEY, owner, 1);
    expect(await confirmOwner(db, KEY, owner, 1)).toBe(false);
  });

  it('releaseClaim zeroes the lease so a successor can TAKEOVER immediately', async () => {
    const db = makeMakotoDb();
    const owner1 = newClaimOwner('w1');
    const owner2 = newClaimOwner('w2');
    await tryClaim(db, KEY, owner1, { leaseTtlMs: LEASE_MS, now: 1_000 });
    expect(await releaseClaim(db, KEY, owner1, 1)).toBe(true);
    const r = await tryClaim(db, KEY, owner2, { leaseTtlMs: LEASE_MS, now: 2_000 });
    expect(r.state).toBe('TAKEOVER');
  });

  it('renewLease extends only the matching owner+version', async () => {
    const db = makeMakotoDb();
    const owner = newClaimOwner('w1');
    await tryClaim(db, KEY, owner, { leaseTtlMs: 100, now: 1_000 });
    const ok = await renewLease(db, KEY, owner, 1, { leaseTtlMs: 100, now: 1_050 });
    expect(ok).toBe(true);
    // Stale owner attempt
    expect(await renewLease(db, KEY, 'someone-else', 1, { leaseTtlMs: 100, now: 1_050 })).toBe(
      false,
    );
  });
});

describe('pruneExpiredDedupe', () => {
  it('drops rows past ttl_expires_at_ms', async () => {
    const db = makeMakotoDb();
    const owner = newClaimOwner('w1');
    await tryClaim(db, KEY, owner, {
      leaseTtlMs: 1000,
      retainTtlMs: 1000,
      now: 1_000,
    });
    const deleted = await pruneExpiredDedupe(db, 3_000);
    expect(deleted).toBe(1);
  });
});
