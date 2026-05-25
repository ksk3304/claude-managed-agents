/**
 * Google Workspace OAuth refresh + revoke for per-user access tokens.
 *
 * Wraps Google's standard OAuth 2.0 endpoints:
 *   - `https://oauth2.googleapis.com/token`  (refresh)
 *   - `https://oauth2.googleapis.com/revoke` (revoke)
 *
 * refresh_tokens live encrypted in `oauth-vault.ts`-keyed KV entries.
 *
 * access_token caching + in-flight refresh serialisation + per-user
 * audit log are funneled through the `OAuthLease` Durable Object
 * (`src/durable-objects/oauth-lease.ts`). Callers pass a `OAuthLeaseStub`
 * in `deps.oauthLease` (one per user_slug) and `getAccessToken` calls
 * `getOrLease` → either uses a cached token, waits briefly on busy, or
 * holds a lease while it talks to Google's `/token` endpoint and then
 * `commit`s the result.
 *
 * This is the Phase 2 OAuth lease path (plan v4 §5.4.3). The DO owns
 * the in-memory cache + audit serialisation; the Worker owns the
 * Google subrequest budget.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 4 — 層 2 / Phase 8 wire-up)
 * Spec: plan-draft-v4-cloud-env-only.md §5.4.3 OAuth lease
 */

import {
  getRefreshToken,
  putRefreshToken,
  deleteRefreshToken,
} from './oauth-vault';
import { assertBridgeEgressAllowed } from './egress-guard';
import type { OAuthLeaseStub } from '../durable-objects/oauth-lease';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/**
 * How long to wait once when `getOrLease` returns `busy`. A second
 * caller for the same user normally finds the cache populated on the
 * retry, which lets us avoid a parallel refresh without blocking
 * meaningfully. Capped to keep the consumer's wall-time budget honest.
 */
const BUSY_RETRY_WAIT_MS_MAX = 1000;

export type OAuthAction =
  | 'bootstrap'
  | 'get_refresh'
  | 'refresh'
  | 'rotate'
  | 'revoke'
  | 'fail_decrypt'
  | 'fail_cross_user';

export interface OAuthAuditRow {
  timestamp_ms: number;
  user_slug: string;
  caller_session_id?: string;
  action: OAuthAction;
  outcome: string;
  notes?: string;
}

export interface AccessTokenResult {
  access_token: string;
  /** Epoch ms the token expires. */
  expires_at_ms: number;
  /** Whether we hit the KV cache (true) or refreshed (false). */
  from_cache: boolean;
}

export interface WorkspaceOAuthDeps {
  db: D1Database;
  kv: KVNamespace;
  vaultKeyB64: string;
  clientId: string;
  clientSecret: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /**
   * Per-user lease + cache + audit serialiser. Required for `getAccessToken`
   * (it owns the refresh-side audit rows); `revokeUser` / `bootstrapUser`
   * use it when present to invalidate the cache, but tolerate `undefined`
   * for callers that don't need lease coordination (e.g. the bootstrap CLI
   * Worker path that only writes the vault).
   */
  oauthLease?: OAuthLeaseStub;
}

/**
 * Get a working Google access_token for `userSlug` via the `OAuthLease`
 * Durable Object.
 *
 *   - DO cache hit (60s freshness margin) → return cached token
 *   - DO `busy` (another caller is refreshing) → short wait, retry once;
 *     if still busy, return null (caller can retry the higher-level op)
 *   - DO `leased` → this caller holds the lease, talks to Google's
 *     /token endpoint, then calls `commit` (success) / `release` (fail) /
 *     `invalidate` (revoked) on the DO
 *
 * The DO writes the success / rotate / fail / revoke audit rows
 * serially per user — the Worker no longer writes them directly. The
 * one exception is `fail_decrypt` (vault corruption), which the Worker
 * audits via `recordOAuthAudit` before re-throwing because the lease
 * was never put in `commit-able` state.
 */
export async function getAccessToken(
  deps: WorkspaceOAuthDeps,
  userSlug: string,
  options: { callerSessionId?: string } = {},
): Promise<AccessTokenResult | null> {
  if (!deps.oauthLease) {
    throw new Error('getAccessToken requires deps.oauthLease (OAuthLease DO stub)');
  }
  const lease = deps.oauthLease;
  const callerSessionId = options.callerSessionId ?? null;

  const first = await lease.getOrLease(userSlug);
  if (first.kind === 'cached') return fromCached(first.accessToken, first.expiresInMs);
  if (first.kind === 'busy') {
    await sleep(Math.min(first.retryAfterMs, BUSY_RETRY_WAIT_MS_MAX));
    const second = await lease.getOrLease(userSlug);
    if (second.kind === 'cached') return fromCached(second.accessToken, second.expiresInMs);
    if (second.kind === 'busy') return null;
    return performRefresh(deps, userSlug, second.leaseId, callerSessionId);
  }
  return performRefresh(deps, userSlug, first.leaseId, callerSessionId);
}

function fromCached(accessToken: string, expiresInMs: number): AccessTokenResult {
  return {
    access_token: accessToken,
    expires_at_ms: Date.now() + expiresInMs,
    from_cache: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function performRefresh(
  deps: WorkspaceOAuthDeps,
  userSlug: string,
  leaseId: string,
  callerSessionId: string | null,
): Promise<AccessTokenResult | null> {
  const lease = deps.oauthLease!;
  let refreshToken: string | null;
  try {
    refreshToken = await getRefreshToken(deps.kv, deps.vaultKeyB64, userSlug);
  } catch (err) {
    // Decrypt failure is the one audit path that bypasses the DO: the
    // lease never reached a commit-able state, and the failure mode is
    // global (vault corrupt for this user), so record it directly and
    // free the lease.
    await recordOAuthAudit(deps.db, {
      timestamp_ms: Date.now(),
      user_slug: userSlug,
      caller_session_id: callerSessionId ?? undefined,
      action: 'fail_decrypt',
      outcome: `fail:${errorMessage(err)}`,
    });
    await lease.release({
      userSlug,
      leaseId,
      outcome: 'fail',
      callerSessionId,
      notes: 'decrypt_fail',
    });
    throw err;
  }
  if (refreshToken === null) {
    // Vault entry absent — caller never bootstrapped this user. Free
    // the lease so a future bootstrap can proceed without waiting.
    await lease.release({
      userSlug,
      leaseId,
      outcome: 'fail',
      callerSessionId,
      notes: 'no_refresh_token_in_vault',
    });
    return null;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  // Egress hard-allowlist (層 8). `GOOGLE_TOKEN_URL` is the constant
  // `oauth2.googleapis.com/token`; the check is here so a future
  // overridable-URL refactor doesn't silently leak.
  assertBridgeEgressAllowed(GOOGLE_TOKEN_URL, 'workspace-oauth:refresh');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: deps.clientId,
    client_secret: deps.clientSecret,
    refresh_token: refreshToken,
  });
  const resp = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = await resp.text();
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      // refresh_token itself is revoked / invalid → fail-close (S6).
      // Purge the vault entry and tell the DO to drop its cache so no
      // other caller serves stale data.
      await deleteRefreshToken(deps.kv, userSlug);
      await lease.invalidate({
        userSlug,
        callerSessionId,
        reason: `refresh_token_revoked_${resp.status}`,
      });
    } else {
      await lease.release({
        userSlug,
        leaseId,
        outcome: 'fail',
        callerSessionId,
        notes: `google_${resp.status}:${text.slice(0, 256)}`,
      });
    }
    return null;
  }
  const body = JSON.parse(text) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };
  const expiresInMs = body.expires_in * 1000;

  // Google rotates refresh_tokens only occasionally — handle it when
  // we see it (S3 rotate path).
  let refreshTokenRotated = false;
  if (body.refresh_token && body.refresh_token !== refreshToken) {
    await putRefreshToken(deps.kv, deps.vaultKeyB64, userSlug, body.refresh_token);
    refreshTokenRotated = true;
  }

  await lease.commit({
    userSlug,
    leaseId,
    accessToken: body.access_token,
    expiresInMs,
    refreshTokenRotated,
    callerSessionId,
  });

  return {
    access_token: body.access_token,
    expires_at_ms: Date.now() + expiresInMs,
    from_cache: false,
  };
}

/**
 * Revoke + purge a user's refresh_token. Idempotent: missing entries
 * are treated as "already revoked" and still audited.
 */
export async function revokeUser(
  deps: WorkspaceOAuthDeps,
  userSlug: string,
  options: { callerSessionId?: string } = {},
): Promise<void> {
  let refreshToken: string | null = null;
  try {
    refreshToken = await getRefreshToken(deps.kv, deps.vaultKeyB64, userSlug);
  } catch (err) {
    await recordOAuthAudit(deps.db, {
      timestamp_ms: Date.now(),
      user_slug: userSlug,
      caller_session_id: options.callerSessionId,
      action: 'fail_decrypt',
      outcome: `fail:${errorMessage(err)}`,
    });
    // fall through to delete the corrupt entry below
  }
  if (refreshToken) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const params = new URLSearchParams({ token: refreshToken });
    // Egress hard-allowlist (層 8). Same rationale as the refresh
    // path above.
    assertBridgeEgressAllowed(GOOGLE_REVOKE_URL, 'workspace-oauth:revoke');
    const resp = await fetchImpl(`${GOOGLE_REVOKE_URL}?${params.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    // Google returns 200 on success and 400 if the token was already
    // revoked. Both are fine — we delete the vault entry either way.
    if (!resp.ok && resp.status !== 400) {
      await recordOAuthAudit(deps.db, {
        timestamp_ms: Date.now(),
        user_slug: userSlug,
        caller_session_id: options.callerSessionId,
        action: 'revoke',
        outcome: `fail:${resp.status}`,
      });
    }
  }
  await deleteRefreshToken(deps.kv, userSlug);
  if (deps.oauthLease) {
    // Drop the DO's cached access_token + any in-flight lease for this
    // user. The DO writes the revoke audit row itself so we don't
    // double-audit when the lease is wired up.
    await deps.oauthLease.invalidate({
      userSlug,
      callerSessionId: options.callerSessionId ?? null,
      reason: 'revoke',
    });
  } else {
    // CLI / bootstrap path with no lease wired in — keep auditing.
    await recordOAuthAudit(deps.db, {
      timestamp_ms: Date.now(),
      user_slug: userSlug,
      caller_session_id: options.callerSessionId,
      action: 'revoke',
      outcome: 'success',
    });
  }
}

/**
 * One-shot helper used by the bootstrap CLI (Python side) to seed a
 * refresh_token into the vault for the first time. Writes the vault
 * entry and an audit row in one call.
 */
export async function bootstrapUser(
  deps: WorkspaceOAuthDeps,
  userSlug: string,
  refreshToken: string,
  options: { callerSessionId?: string; notes?: string } = {},
): Promise<void> {
  await putRefreshToken(deps.kv, deps.vaultKeyB64, userSlug, refreshToken);
  await recordOAuthAudit(deps.db, {
    timestamp_ms: Date.now(),
    user_slug: userSlug,
    caller_session_id: options.callerSessionId,
    action: 'bootstrap',
    outcome: 'success',
    notes: options.notes,
  });
}

/**
 * Append one row to D1 `oauth_audit`. Exposed so other callers
 * (custom tool dispatchers, etc.) can audit user-attributable
 * Workspace activity through the same table.
 */
export async function recordOAuthAudit(
  db: D1Database,
  row: OAuthAuditRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO oauth_audit
         (timestamp_ms, user_slug, caller_session_id, action, outcome, notes)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(
      row.timestamp_ms,
      row.user_slug,
      row.caller_session_id ?? null,
      row.action,
      row.outcome,
      row.notes ?? null,
    )
    .run();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
