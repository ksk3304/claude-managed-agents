/**
 * D1-backed per-event claim / lease / commit fence.
 *
 * Webhook handlers and Queue consumers race on the same `event_key`.
 * To prevent double-reply when a worker dies mid-flight and a second
 * worker takes over the same message, the dedupe row carries an
 * `owner` + `version` fence. All side-effecting work (Anthropic
 * sessions, AgentMail send / reply) is gated on owner+version match,
 * checked both at commit and again immediately before the send.
 *
 * State machine (per `tryClaim` call):
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ 1. DONE_DUPLICATE first.                                 │
 *   │    committed_at_ms IS NOT NULL → skip (already replied). │
 *   │                                                          │
 *   │ 2. NEW.                                                  │
 *   │    INSERT OR IGNORE — first writer wins, lease_version=1.│
 *   │                                                          │
 *   │ 3. TAKEOVER.                                             │
 *   │    UPDATE ... WHERE committed_at_ms IS NULL              │
 *   │                AND lease_expires_at_ms < NOW             │
 *   │    Successor gets owner+1, must still re-check owner     │
 *   │    immediately before any external write.                │
 *   │                                                          │
 *   │ 4. LEASE_ALIVE.                                          │
 *   │    Another worker holds an unexpired lease → skip.       │
 *   └──────────────────────────────────────────────────────────┘
 *
 * `commitDone` and `confirmOwner` both fence on (owner, version):
 * a stale owner cannot complete a send after its lease has passed to
 * the successor.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 3 — 層 1)
 * Spec: plan-draft.md §8 dedupe + §completion-conditions C10
 */

export type ClaimState = 'NEW' | 'TAKEOVER' | 'LEASE_ALIVE' | 'DONE_DUPLICATE';

export interface ClaimResult {
  state: ClaimState;
  /** Set when state is NEW or TAKEOVER; otherwise undefined. */
  owner?: string;
  /** Set when state is NEW (=1) or TAKEOVER (=previous+1). */
  version?: number;
}

export interface DedupeOptions {
  /** Lease lifetime added to `now`. Defaults to 5 minutes. */
  leaseTtlMs?: number;
  /** Row retention added to `now`. Defaults to 30 days (cron-pruned). */
  retainTtlMs?: number;
  /** Override clock for tests. Defaults to `Date.now()`. */
  now?: number;
}

const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RETAIN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Build a unique `claim_owner` string. The caller supplies a worker
 * instance label (Cloudflare deployment id, cf-ray prefix, or "" if
 * unknown); we append a random UUID so two parallel attempts from the
 * same instance still get distinct owners.
 */
export function newClaimOwner(workerInstanceId: string = ''): string {
  const random = crypto.randomUUID();
  return workerInstanceId ? `${workerInstanceId}:${random}` : random;
}

/**
 * Atomic claim attempt with fence. See module doc for the decision tree.
 * Idempotent: safe to call again with the same event_key + owner.
 */
export async function tryClaim(
  db: D1Database,
  eventKey: string,
  owner: string,
  options: DedupeOptions = {},
): Promise<ClaimResult> {
  const now = options.now ?? Date.now();
  const leaseTtl = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const retainTtl = options.retainTtlMs ?? DEFAULT_RETAIN_TTL_MS;
  const leaseExp = now + leaseTtl;
  const ttlExp = now + retainTtl;

  // Step 1: DONE_DUPLICATE check first. This must run before the INSERT
  // OR IGNORE / UPDATE branches so a re-delivery of a long-completed
  // event short-circuits without touching the lease.
  const existing = await db
    .prepare(`SELECT committed_at_ms FROM dedupe WHERE event_key = ?`)
    .bind(eventKey)
    .first<{ committed_at_ms: number | null }>();
  if (existing && existing.committed_at_ms !== null) {
    return { state: 'DONE_DUPLICATE' };
  }

  // Step 2: NEW claim. INSERT OR IGNORE is atomic — exactly one parallel
  // caller observes meta.changes === 1.
  const insertResult = await db
    .prepare(
      `INSERT OR IGNORE INTO dedupe
         (event_key, claim_state, claim_owner, lease_version,
          lease_expires_at_ms, committed_at_ms,
          created_at_ms, ttl_expires_at_ms)
       VALUES (?1, 'NEW', ?2, 1, ?3, NULL, ?4, ?5)`,
    )
    .bind(eventKey, owner, leaseExp, now, ttlExp)
    .run();
  if ((insertResult.meta?.changes ?? 0) > 0) {
    return { state: 'NEW', owner, version: 1 };
  }

  // Step 3: TAKEOVER. The row exists, has no committed_at_ms, and the
  // current lease has expired. Bump owner + version atomically.
  const updateResult = await db
    .prepare(
      `UPDATE dedupe
         SET claim_state = 'TAKEOVER',
             claim_owner = ?2,
             lease_version = lease_version + 1,
             lease_expires_at_ms = ?3
       WHERE event_key = ?1
         AND committed_at_ms IS NULL
         AND lease_expires_at_ms < ?4`,
    )
    .bind(eventKey, owner, leaseExp, now)
    .run();
  if ((updateResult.meta?.changes ?? 0) > 0) {
    const after = await db
      .prepare(`SELECT lease_version FROM dedupe WHERE event_key = ?`)
      .bind(eventKey)
      .first<{ lease_version: number }>();
    return {
      state: 'TAKEOVER',
      owner,
      version: after?.lease_version,
    };
  }

  // Step 4: LEASE_ALIVE — another worker still holds an unexpired
  // lease, or DONE_DUPLICATE raced in between our SELECT and INSERT
  // (in which case the next call will short-circuit at step 1).
  return { state: 'LEASE_ALIVE' };
}

/**
 * Extend the lease for `(eventKey, owner, version)`. Returns true if
 * the lease was extended, false if owner / version drifted (i.e. we
 * lost the claim and must abort).
 *
 * Long-running Queue consumers should renew before the lease expires
 * so a stale-takeover doesn't fire while we're still working.
 */
export async function renewLease(
  db: D1Database,
  eventKey: string,
  owner: string,
  version: number,
  options: DedupeOptions = {},
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const leaseTtl = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const leaseExp = now + leaseTtl;

  const r = await db
    .prepare(
      `UPDATE dedupe
         SET lease_expires_at_ms = ?3
       WHERE event_key = ?1
         AND claim_owner = ?2
         AND lease_version = ?4
         AND committed_at_ms IS NULL`,
    )
    .bind(eventKey, owner, leaseExp, version)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * Re-check that we still own the claim. Returns true if owner+version
 * still match and committed_at_ms is NULL.
 *
 * Call this immediately before any side-effecting external write
 * (AgentMail send / reply) — between the start of the run and the
 * actual send, our lease may have expired and a successor may have
 * taken over. Sending after losing the claim risks double-reply.
 */
export async function confirmOwner(
  db: D1Database,
  eventKey: string,
  owner: string,
  version: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT claim_owner, lease_version, committed_at_ms
         FROM dedupe WHERE event_key = ?`,
    )
    .bind(eventKey)
    .first<{
      claim_owner: string;
      lease_version: number;
      committed_at_ms: number | null;
    }>();
  if (!row) return false;
  if (row.committed_at_ms !== null) return false;
  return row.claim_owner === owner && row.lease_version === version;
}

/**
 * Commit the claim atomically — sets committed_at_ms only if
 * owner+version still match and the row is not already committed.
 * Returns true on success, false on fence mismatch.
 *
 * Once committed, subsequent `tryClaim` calls on this event_key return
 * DONE_DUPLICATE.
 */
export async function commitDone(
  db: D1Database,
  eventKey: string,
  owner: string,
  version: number,
  options: { now?: number } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const r = await db
    .prepare(
      `UPDATE dedupe
         SET committed_at_ms = ?2
       WHERE event_key = ?1
         AND claim_owner = ?3
         AND lease_version = ?4
         AND committed_at_ms IS NULL`,
    )
    .bind(eventKey, now, owner, version)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * Release a claim without committing — used when the worker decides
 * not to process the event (e.g. recoverable validation failure that
 * should be retried by a fresh successor immediately).
 *
 * Sets lease_expires_at_ms to 0 so the next `tryClaim` sees it as
 * expired and TAKEOVER-eligible. Owner+version fence keeps a stale
 * owner from releasing someone else's lease.
 */
export async function releaseClaim(
  db: D1Database,
  eventKey: string,
  owner: string,
  version: number,
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE dedupe
         SET lease_expires_at_ms = 0
       WHERE event_key = ?1
         AND claim_owner = ?2
         AND lease_version = ?3
         AND committed_at_ms IS NULL`,
    )
    .bind(eventKey, owner, version)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * Prune rows past their ttl_expires_at_ms. Call from the cron handler
 * to keep the table bounded.
 */
export async function pruneExpiredDedupe(
  db: D1Database,
  now: number = Date.now(),
): Promise<number> {
  const r = await db
    .prepare(`DELETE FROM dedupe WHERE ttl_expires_at_ms < ?`)
    .bind(now)
    .run();
  return r.meta?.changes ?? 0;
}

// ----------------------------------------------------------------------------
// Event-key namespaces.
//
// The bridge dedupes at two levels:
//   - svix transport: `agentmail:event:<svix-id>` — guards against
//     AgentMail retrying the webhook delivery.
//   - application: `mail:msgid:<rfc822-msgid-normalized>` — guards
//     against the same RFC 822 message arriving via two distinct
//     transports (svix replay + manual replay, fork in routing, etc).
// ----------------------------------------------------------------------------

export function eventKeyForSvix(svixId: string): string {
  return `agentmail:event:${svixId}`;
}

/**
 * Normalize a raw RFC 822 Message-ID, then namespace it.
 * Normalization: trim, strip a single leading `<` and trailing `>`,
 * lowercase. Matches the Python `_normalize_msgid` behaviour
 * (`scripts/cma_agentmail_inbound.py:183` doc + 380-381).
 */
export function eventKeyForRfc822(rfc822MessageId: string): string {
  let s = rfc822MessageId.trim();
  if (s.startsWith('<') && s.endsWith('>')) {
    s = s.slice(1, -1).trim();
  }
  return `mail:msgid:${s.toLowerCase()}`;
}
