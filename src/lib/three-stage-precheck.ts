/**
 * 3-stage precheck / send / commit pattern — thin TS wrapper around the
 * existing D1 `dedupe` layer (`src/lib/dedupe.ts`).
 *
 * ## Why this lib exists
 *
 * Cloud Run Python's `cma_lib.py` (`send_placeholder` l.3664 / `send_chat_reply`
 * l.3738 / `send_chat_post` l.3831 / `send_mail` l.3894) wraps every external
 * side-effect in a `precheck → API → commit` triple, gated on Firestore
 * `lease_owner` + `_LeaseHeartbeat.is_alive()`. The shape guarantees:
 *
 *   1. **precheck** decides whether this worker still owns the work and
 *      whether the side-effect has *already* been sent by a prior worker.
 *      Stale workers stop here.
 *   2. **API** does the actual external call (Chat POST / AgentMail send).
 *      No D1 writes — the only thing that escapes is the side-effect itself.
 *   3. **commit** records "this side-effect is now durable" gated on the
 *      same owner + version. Stale workers cannot mark something done that
 *      they're not entitled to.
 *
 * The Cloudflare Worker already has two complementary layers:
 *
 *   - `dedupe.ts` (D1): per-**event** claim / lease_version / committed_at fence
 *     keyed by `event_key`. `tryClaim` / `confirmOwner` / `commitDone` cover
 *     the 4-state machine (NEW / TAKEOVER / LEASE_ALIVE / DONE_DUPLICATE).
 *   - `thread-lock.ts` (DO): in-memory per-thread mutex to catch in-flight
 *     overlap before either side reaches commit.
 *
 * What's missing — and what this lib adds — is the **per-side-effect**
 * "has this exact send already been committed?" check. Today
 * `chat-event-handler.ts` calls `confirmOwner` once at start and
 * `commitDone` once at end, so if a worker dies after posting the
 * placeholder but before sending the chat reply, the successor re-runs
 * **everything** including the placeholder POST (= duplicate). That is
 * the Queue retry + parallel consumer hole life #1266 hit on Cloud Run.
 *
 * ## Design
 *
 * Rather than introduce a new table, we layer on the existing `dedupe`
 * table using a synthetic event_key per side-effect:
 *
 *   send:<kind>:<sha256(target)[:16]>:<parent_event_key>
 *
 * - `kind`         — `placeholder` / `chat_reply` / `chat_post` / `email_send`
 * - `target`       — the destination identity (e.g. `<spaceName>:<threadName>`
 *                    for chat, `<inboxId>:<to>:<rfc822>` for mail). Hashed
 *                    so the event_key stays bounded.
 * - `parent_event_key` — the outer event_key the consumer is processing
 *                    (so two distinct inbound events to the same target
 *                    each get their own independent claim).
 *
 * Each side-effect gets its own NEW claim. If the same worker (or its
 * successor) re-enters the wrapper for the same (parent_event_key, kind,
 * target), the second call sees DONE_DUPLICATE and skips the API call.
 *
 * The wrapper inherits `owner` from the parent and appends a kind suffix
 * (`<parentOwner>#<kind>`) so multiple side-effects within one event do
 * not collide on owner identity but still trace back to the parent.
 *
 * `LeaseHeartbeat` is a periodic `renewLease` daemon. Cloudflare Workers
 * do not have native threads — we use `setInterval` driven by
 * `ctx.waitUntil` (caller responsibility). The heartbeat exposes
 * `isAlive()` which `executeWithCommit` checks **before** the API call
 * and **before** commit; either check failing aborts the commit so a
 * stale worker that has already passed precheck cannot mark a side-effect
 * done after losing the lease.
 *
 * ## Trade-offs vs. introducing a new `send_log` table
 *
 * - New table: cleaner per-side-effect schema but doubles the write path
 *   and requires a migration. The task scope (= no migration in this
 *   commit) and the "既存層を活用" guidance both point to layering on
 *   `dedupe` instead. The 30-day TTL on dedupe rows is already a fine
 *   retention window for side-effect dedupe (= longer than any inbound
 *   retry window).
 *
 * ## Relationship to `thread-lock.ts`
 *
 * ThreadLock is an in-memory DO mutex that catches the in-flight overlap
 * window. The three-stage wrapper catches the **committed-overlap** window
 * (= duplicate after both sides reached the API). Both layers are
 * complementary — see `plan-draft.md §step 7 + R6` for the original
 * layering rationale on the Python side.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — I)
 * Source of truth (Python):
 *   - scripts/cma_lib.py l.3501-3635 (_LeaseHeartbeat)
 *   - scripts/cma_lib.py l.3664-3735 (send_placeholder)
 *   - scripts/cma_lib.py l.3738-3828 (send_chat_reply)
 *   - scripts/cma_lib.py l.3831-3891 (send_chat_post)
 *   - scripts/cma_lib.py l.3894-4001 (send_mail)
 *   - scripts/cma_lib.py l.4004-4033 (commit_done)
 */

import { commitDone, releaseClaim, renewLease, tryClaim } from './dedupe';
import type { ClaimResult } from './dedupe';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default lease TTL for a single side-effect — matches `dedupe.ts`. */
const DEFAULT_SIDE_LEASE_TTL_MS = 5 * 60 * 1000;

/**
 * Default heartbeat interval. Python (`HEARTBEAT_INTERVAL_SEC`) defaults
 * to 60 s; we keep the same value so behaviour stays parity.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60 * 1000;

/**
 * Default safety margin between "last successful renewal" and the lease
 * expiry. Python (`SAFETY_MARGIN_SEC`) defaults to 30 s. `isAlive()`
 * returns false once `now - last_success_at` exceeds `lease_ttl - margin`,
 * giving the caller enough headroom to abort cleanly before the lease
 * actually expires upstream.
 */
const DEFAULT_SAFETY_MARGIN_MS = 30 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Side-effect categories we wrap. */
export type SideEffectKind = 'placeholder' | 'chat_reply' | 'chat_post' | 'email_send';

/**
 * Outcome of `executeWithCommit`. Mirrors the Cloud Run Python branches
 * (`ALREADY` / `OK` / `WAIT` / `_LeaseLostError`) but flattens to a
 * discriminated union the consumer can pattern-match on.
 *
 *   - `sent`         — sendFn ran + commit succeeded. `result` carries the
 *                       sendFn return value.
 *   - `already`      — precheck saw a committed side-effect (= another
 *                       worker already sent this one). `result` undefined.
 *   - `lease_alive`  — another worker is still in-flight. The caller
 *                       should skip + let the queue retry path handle it.
 *   - `lease_lost`   — precheck OK but the heartbeat went stale before
 *                       commit, or the commit fence drifted. If `result`
 *                       is set the API call succeeded but the row could
 *                       not be marked done (= rare, manual audit path).
 *   - `precheck_failed` — `tryClaim` returned an unexpected state. Should
 *                       not happen in practice but surfaces as a typed
 *                       outcome rather than a throw.
 */
export type SendOutcome<R> =
  | { outcome: 'sent'; result: R; claim: ClaimResult }
  | { outcome: 'already' }
  | { outcome: 'lease_alive'; retryAfterHint?: string }
  | { outcome: 'lease_lost'; result?: R }
  | { outcome: 'precheck_failed'; reason: string };

/**
 * Options accepted by `executeWithCommit` + `precheckSend`.
 */
export interface ExecuteOptions {
  /** Lease TTL for this side-effect (defaults to 5 min). */
  leaseTtlMs?: number;
  /**
   * Heartbeat to check immediately before the API call and immediately
   * before commit. If absent, the wrapper still works but cannot detect
   * the "alive at precheck → dead before commit" race that Python
   * `_LeaseHeartbeat.is_alive()` guards.
   */
  heartbeat?: LeaseHeartbeat;
  /** Override `Date.now()` for tests. */
  now?: number;
}

// ---------------------------------------------------------------------------
// Side-effect event_key derivation
// ---------------------------------------------------------------------------

/**
 * Build the synthetic event_key for a side-effect. The format is:
 *
 *   send:<kind>:<sha256(target)[:16]>:<parent_event_key>
 *
 * Hashing the target keeps the row key bounded regardless of the target
 * string's length and avoids leaking raw email addresses / thread names
 * into D1 (which is logged on long-tail audit queries).
 *
 * Public so dispatcher code can derive the same key for cleanup /
 * inspection without re-implementing the format. The hash is SHA-256
 * truncated to 16 hex chars (= 64 bits), the same construction Python
 * `_make_request_id` uses for GChat requestId (l.3649-3661).
 */
export async function buildSideEffectKey(
  parentEventKey: string,
  kind: SideEffectKind,
  target: string,
): Promise<string> {
  const targetHash = await sha256Hex16(target);
  return `send:${kind}:${targetHash}:${parentEventKey}`;
}

/**
 * Build the side-effect owner from the parent owner. The owner format is
 *
 *   <parent_owner>#<kind>
 *
 * which keeps the audit trail (= can grep claim_owner to find which
 * parent owner ran this side-effect) without breaking the (owner, version)
 * fence semantics. Two parallel workers for the same parent event will
 * also produce two distinct owners (their parent owners differ), so the
 * fence still rejects the loser.
 */
export function buildSideEffectOwner(parentOwner: string, kind: SideEffectKind): string {
  return `${parentOwner}#${kind}`;
}

// ---------------------------------------------------------------------------
// precheckSend — stage 1 of the 3-stage pattern
// ---------------------------------------------------------------------------

export type PrecheckResult =
  | { state: 'OK'; claim: ClaimResult }
  | { state: 'ALREADY' }
  | { state: 'LEASE_ALIVE' }
  | { state: 'LEASE_LOST'; reason: string };

/**
 * Reserve the right to perform a side-effect for `(parentEventKey, kind, target)`.
 *
 * Wraps `tryClaim` on the derived side-effect event_key and translates
 * the 4-state dedupe machine into a precheck verdict:
 *
 *   - dedupe state `NEW` / `TAKEOVER` → `OK` (caller proceeds to API call)
 *   - dedupe state `DONE_DUPLICATE`   → `ALREADY` (caller skips)
 *   - dedupe state `LEASE_ALIVE`      → `LEASE_ALIVE` (another worker is
 *                                       sending this side-effect right
 *                                       now; caller leaves it alone)
 *
 * The `heartbeat` check (when supplied) runs **before** `tryClaim` —
 * a worker whose parent lease is already gone has no business reserving
 * new side-effects.
 */
export async function precheckSend(
  env: { DB: D1Database },
  parentEventKey: string,
  parentOwner: string,
  kind: SideEffectKind,
  target: string,
  options: ExecuteOptions = {},
): Promise<PrecheckResult> {
  if (options.heartbeat && !options.heartbeat.isAlive()) {
    return { state: 'LEASE_LOST', reason: 'parent_heartbeat_dead_at_precheck' };
  }
  const sideKey = await buildSideEffectKey(parentEventKey, kind, target);
  const owner = buildSideEffectOwner(parentOwner, kind);
  const claim = await tryClaim(env.DB, sideKey, owner, {
    leaseTtlMs: options.leaseTtlMs ?? DEFAULT_SIDE_LEASE_TTL_MS,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  switch (claim.state) {
    case 'NEW':
    case 'TAKEOVER':
      return { state: 'OK', claim };
    case 'DONE_DUPLICATE':
      return { state: 'ALREADY' };
    case 'LEASE_ALIVE':
      return { state: 'LEASE_ALIVE' };
    /* istanbul ignore next — `tryClaim` returns only the 4 states above. */
    default:
      return { state: 'LEASE_LOST', reason: `unexpected_claim_state` };
  }
}

// ---------------------------------------------------------------------------
// executeWithCommit — stage 1 + 2 + 3 wired together
// ---------------------------------------------------------------------------

export interface ExecuteWithCommitParams<R> {
  env: { DB: D1Database };
  parentEventKey: string;
  parentOwner: string;
  kind: SideEffectKind;
  target: string;
  /**
   * The API call. The wrapper only invokes this when precheck returns
   * OK + heartbeat is alive. If `sendFn` throws, the precheck claim is
   * released so a fresh worker can retry without waiting out the lease.
   */
  sendFn: () => Promise<R>;
  /**
   * Optional caller-supplied commit step that runs **before** the
   * wrapper's own `commitDone` on the side-effect key. Useful for
   * recording the sendFn's return value into a caller-owned table
   * (`sent_messages.rfc822_msgid` etc.) under the same owner+version
   * fence the wrapper is about to use. If `commitFn` throws, the
   * wrapper still attempts `commitDone` (= the side-effect actually
   * shipped; we don't want to leave the row uncommitted) but surfaces
   * the throw as `outcome: 'lease_lost'` so the caller can audit.
   *
   * `commitFn` receives the `sendFn` return value and the dedupe
   * claim (owner + version) so it can pass the fence into any nested
   * D1 update.
   */
  commitFn?: (result: R, claim: ClaimResult) => Promise<void>;
  options?: ExecuteOptions;
}

/**
 * Run the full precheck → API → commit triple for a single side-effect.
 *
 * Mirrors the Python `cma_lib.py:send_*` shape:
 *
 *   1. `precheckSend` → reserve the side-effect (or skip if ALREADY).
 *   2. `heartbeat.isAlive()` re-check (Python l.3705 == this).
 *   3. `sendFn()` → external API call (Chat POST / AgentMail send).
 *   4. `heartbeat.isAlive()` re-check (Python l.3726 == this).
 *   5. Optional caller `commitFn(result, claim)` — caller's own D1 update.
 *   6. `commitDone` on the side-effect key, gated on owner + version.
 *
 * Failure modes:
 *
 *   - sendFn throws → release the claim + rethrow. The caller wraps it
 *     in their own try/catch (= existing failure isolation pattern).
 *   - heartbeat dies mid-flight → commit is skipped, outcome is
 *     `lease_lost`. `result` is included so the caller can decide
 *     whether to surface the shipped side-effect (= rare but real).
 *   - commitDone returns false (fence drift) → outcome `lease_lost`.
 */
export async function executeWithCommit<R>(
  params: ExecuteWithCommitParams<R>,
): Promise<SendOutcome<R>> {
  const { env, parentEventKey, parentOwner, kind, target, sendFn, commitFn, options = {} } = params;

  // ---- Stage 1: precheck ----
  const pre = await precheckSend(env, parentEventKey, parentOwner, kind, target, options);
  if (pre.state === 'ALREADY') return { outcome: 'already' };
  if (pre.state === 'LEASE_ALIVE') return { outcome: 'lease_alive' };
  if (pre.state === 'LEASE_LOST') {
    return { outcome: 'lease_lost' };
  }

  // pre.state === 'OK' from here on
  const claim = pre.claim;
  const sideKey = await buildSideEffectKey(parentEventKey, kind, target);
  const owner = buildSideEffectOwner(parentOwner, kind);

  // ---- Stage 2a: re-check heartbeat right before the API call ----
  // Python `cma_lib.py:send_placeholder:l.3701` checks `heartbeat.is_alive()`
  // inside the precheck transaction. We split it into a separate read
  // because D1 doesn't carry the same transactional boundary.
  if (options.heartbeat && !options.heartbeat.isAlive()) {
    await safeReleaseClaim(env, sideKey, owner, claim.version!);
    return { outcome: 'lease_lost' };
  }

  // ---- Stage 2b: API call ----
  let result: R;
  try {
    result = await sendFn();
  } catch (err) {
    // Release so the next worker takes over immediately rather than
    // waiting out the lease. Swallow release errors — the original
    // sendFn throw is the signal the caller cares about.
    await safeReleaseClaim(env, sideKey, owner, claim.version!);
    throw err;
  }

  // ---- Stage 3a: re-check heartbeat right before commit ----
  // Python `cma_lib.py:send_placeholder:l.3726` re-asserts ownership at
  // commit. If the lease has gone stale between sendFn start and now,
  // the successor has already taken over — committing now would mask
  // the takeover and risk double-send on a future retry.
  if (options.heartbeat && !options.heartbeat.isAlive()) {
    return { outcome: 'lease_lost', result };
  }

  // ---- Stage 3b: caller-supplied commitFn (optional) ----
  if (commitFn) {
    try {
      await commitFn(result, claim);
    } catch (err) {
      // commitFn failed but the side-effect already shipped. We still
      // commitDone (= dedupe row marks the side-effect done; otherwise
      // a successor would re-send) and surface lease_lost so the caller
      // can audit-log the partial failure.
      void err;
      const committedDespiteCommitFnFailure = await commitDone(
        env.DB,
        sideKey,
        owner,
        claim.version!,
        options.now !== undefined ? { now: options.now } : {},
      );
      return {
        outcome: 'lease_lost',
        ...(committedDespiteCommitFnFailure ? { result } : { result }),
      };
    }
  }

  // ---- Stage 3c: commitDone on the side-effect key ----
  const committed = await commitDone(
    env.DB,
    sideKey,
    owner,
    claim.version!,
    options.now !== undefined ? { now: options.now } : {},
  );
  if (!committed) {
    return { outcome: 'lease_lost', result };
  }
  return { outcome: 'sent', result, claim };
}

async function safeReleaseClaim(
  env: { DB: D1Database },
  sideKey: string,
  owner: string,
  version: number,
): Promise<void> {
  try {
    await releaseClaim(env.DB, sideKey, owner, version);
  } catch {
    // Best-effort cleanup; the lease will expire on its own anyway.
  }
}

// ---------------------------------------------------------------------------
// LeaseHeartbeat
// ---------------------------------------------------------------------------

export interface LeaseHeartbeatDeps {
  env: { DB: D1Database };
  /** The PARENT event_key (= the one the consumer is processing). */
  eventKey: string;
  /** The PARENT owner (= the one from the consumer's `claim` envelope). */
  owner: string;
  /** The PARENT lease_version. */
  version: number;
  /** Renewal interval (ms). Defaults to 60 s. */
  intervalMs?: number;
  /** Lease TTL each renewal asks for. Defaults to 5 min. */
  leaseTtlMs?: number;
  /**
   * Safety margin (ms). `isAlive()` returns false once
   * `now - lastSuccessAt > leaseTtl - margin`. Defaults to 30 s.
   */
  safetyMarginMs?: number;
  /** Override `Date.now()` for tests. */
  clock?: () => number;
  /**
   * Override the timer constructors (= for tests). Both must come in
   * pairs — supplying `setIntervalImpl` without `clearIntervalImpl`
   * is a config bug.
   */
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
  /** Hook the wrapper calls when a renewal fails. Tests use this. */
  onFailure?: (consecutiveFailures: number, err: unknown) => void;
  /** Hook the wrapper calls when the lease is declared lost. */
  onLost?: (reason: string) => void;
}

/**
 * Periodic `renewLease` daemon for a parent dedupe claim.
 *
 * Cloud Run Python (`_LeaseHeartbeat`, l.3501-3635) runs this on a daemon
 * thread that extends the Firestore `lease_until` field every 60 s and
 * also calls `pubsub_message.modify_ack_deadline` so the Pub/Sub message
 * does not redeliver mid-flight.
 *
 * Cloudflare Workers do not have threads — `setInterval` is the
 * single-isolate equivalent. The caller is responsible for keeping the
 * Worker isolate alive long enough for the interval to fire, typically
 * by passing `ctx.waitUntil(heartbeat.completionPromise)` if it wants
 * the runtime to keep the isolate around even after the main handler
 * returns. The standard dispatcher pattern (= `handleChatEvent` /
 * `agentmailDispatch`) already runs to completion inside the Queue
 * consumer's wall-time, so the typical lifecycle is:
 *
 *     const hb = new LeaseHeartbeat({ env, eventKey, owner, version });
 *     hb.start();
 *     try {
 *       // ... dispatcher logic + side-effect sends ...
 *     } finally {
 *       await hb.stop();
 *     }
 *
 * `isAlive()` is what `executeWithCommit` reads to decide whether the
 * parent lease is still trustworthy. It returns false once:
 *
 *   1. `markLost()` was called (= external observer noticed lease drift)
 *   2. The most recent successful renewal is older than
 *      `leaseTtl - safetyMargin` (= the lease is about to expire and
 *      we have not heard back from D1 in time).
 *
 * The heartbeat does not call AgentMail / Pub/Sub `modify_ack_deadline`
 * — Cloudflare Queue lease extension is the consumer framework's
 * responsibility (not exposed in user code today).
 */
export class LeaseHeartbeat {
  private deps: Required<
    Pick<LeaseHeartbeatDeps, 'intervalMs' | 'leaseTtlMs' | 'safetyMarginMs' | 'clock'>
  > &
    LeaseHeartbeatDeps;
  private timerHandle: unknown | null = null;
  private lostReason: string | null = null;
  /** Epoch ms of the last successful (or initial) heartbeat. */
  private lastSuccessAt: number;
  /** Number of consecutive renewal failures since the last success. */
  private consecutiveFailures = 0;
  /** `completionPromise` resolves when `stop()` finishes. */
  private completionResolver: (() => void) | null = null;
  /** Promise that resolves when the heartbeat is fully stopped. */
  readonly completionPromise: Promise<void>;
  private setIntervalFn: (cb: () => void, ms: number) => unknown;
  private clearIntervalFn: (handle: unknown) => void;

  constructor(deps: LeaseHeartbeatDeps) {
    this.deps = {
      ...deps,
      intervalMs: deps.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      leaseTtlMs: deps.leaseTtlMs ?? DEFAULT_SIDE_LEASE_TTL_MS,
      safetyMarginMs: deps.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS,
      clock: deps.clock ?? (() => Date.now()),
    };
    this.lastSuccessAt = this.deps.clock();
    this.setIntervalFn = deps.setIntervalImpl ?? ((cb, ms) => setInterval(cb, ms) as unknown);
    this.clearIntervalFn = deps.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.completionPromise = new Promise<void>((resolve) => {
      this.completionResolver = resolve;
    });
  }

  /**
   * Begin the renewal loop. Idempotent — a second call is a no-op.
   */
  start(): void {
    if (this.timerHandle !== null) return;
    this.timerHandle = this.setIntervalFn(
      () => {
        // Fire-and-forget the renewal. We do not await inside
        // `setInterval` because the interval is the only thing keeping
        // the heartbeat alive on its own schedule.
        void this.tick();
      },
      this.deps.intervalMs,
    );
  }

  /**
   * Stop the renewal loop. Idempotent. The returned promise (also
   * available as `completionPromise`) resolves once the timer is
   * cleared so callers can `await heartbeat.stop()` in `finally` blocks.
   */
  async stop(): Promise<void> {
    if (this.timerHandle !== null) {
      this.clearIntervalFn(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.completionResolver) {
      const r = this.completionResolver;
      this.completionResolver = null;
      r();
    }
    return this.completionPromise;
  }

  /**
   * Returns true while the parent lease is still trustworthy enough to
   * commit side-effects under. Called by `executeWithCommit` at two
   * checkpoints (= before sendFn + before commitDone).
   */
  isAlive(): boolean {
    if (this.lostReason !== null) return false;
    const now = this.deps.clock();
    const elapsed = now - this.lastSuccessAt;
    if (elapsed > this.deps.leaseTtlMs - this.deps.safetyMarginMs) return false;
    return true;
  }

  /** True iff the heartbeat has been declared lost. */
  isLost(): boolean {
    return this.lostReason !== null;
  }

  /** The reason `markLost` was last called with, or null. */
  lostBecause(): string | null {
    return this.lostReason;
  }

  /**
   * Force the heartbeat into the "lost" state. External observers
   * (= caller logic that notices a parallel commit, or a parent
   * confirmOwner that drifted) call this to short-circuit subsequent
   * `isAlive()` checks. Idempotent — the first reason wins.
   */
  markLost(reason: string): void {
    if (this.lostReason !== null) return;
    this.lostReason = reason;
    if (this.deps.onLost) {
      try {
        this.deps.onLost(reason);
      } catch {
        // hook failure should never block the heartbeat
      }
    }
  }

  /**
   * Manually run one renewal cycle. Exposed for tests + for callers that
   * want a one-off extension outside the normal interval cadence (e.g.
   * right before a long-running sendFn). Returns true if the lease was
   * extended, false if it drifted (= marks lost as a side-effect).
   */
  async tick(): Promise<boolean> {
    if (this.lostReason !== null) return false;
    try {
      const ok = await renewLease(
        this.deps.env.DB,
        this.deps.eventKey,
        this.deps.owner,
        this.deps.version,
        { leaseTtlMs: this.deps.leaseTtlMs, now: this.deps.clock() },
      );
      if (!ok) {
        this.markLost('renewLease_returned_false');
        return false;
      }
      this.consecutiveFailures = 0;
      this.lastSuccessAt = this.deps.clock();
      return true;
    } catch (err) {
      this.consecutiveFailures += 1;
      if (this.deps.onFailure) {
        try {
          this.deps.onFailure(this.consecutiveFailures, err);
        } catch {
          // hook failure should never bubble out of the heartbeat loop
        }
      }
      // Python (`_LeaseHeartbeat._loop`, l.3605-3611) gives up after 2
      // consecutive failures. We keep parity — first failure is
      // recoverable, second failure marks the lease lost so subsequent
      // `isAlive()` calls return false.
      if (this.consecutiveFailures >= 2) {
        this.markLost('consecutive_renewLease_failures');
      }
      return false;
    }
  }

  /** Internal accessor used by tests. */
  _consecutiveFailuresForTests(): number {
    return this.consecutiveFailures;
  }

  /** Internal accessor used by tests. */
  _lastSuccessAtForTests(): number {
    return this.lastSuccessAt;
  }
}

// ---------------------------------------------------------------------------
// Helpers — sha256 truncated to 16 hex chars
// ---------------------------------------------------------------------------

async function sha256Hex16(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < 8; i++) {
    const b = view[i]!;
    out += (b >>> 4).toString(16);
    out += (b & 0x0f).toString(16);
  }
  return out;
}
