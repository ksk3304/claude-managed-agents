/**
 * Google Workspace OAuth refresh + revoke for per-user access tokens.
 *
 * Wraps Google's standard OAuth 2.0 endpoints:
 *   - `https://oauth2.googleapis.com/token`  (refresh)
 *   - `https://oauth2.googleapis.com/revoke` (revoke)
 *
 * refresh_tokens live encrypted in `oauth-vault.ts`-keyed KV entries.
 * access_tokens are short-lived (~50 min) and cached in KV under
 * `oauth:access:<user_slug>` with `expirationTtl` so they auto-expire.
 *
 * Every operation writes one audit row to D1 `oauth_audit` (see
 * `recordOAuthAudit`) so we can answer "who used which user's
 * Workspace identity, when, with what outcome".
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 4 — 層 2)
 * Spec: plan-draft.md §7 OAuth + §S3 / §S4 / §S5 / §S6
 */

import {
  getRefreshToken,
  putRefreshToken,
  deleteRefreshToken,
} from './oauth-vault';
import { assertBridgeEgressAllowed } from './egress-guard';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const ACCESS_TOKEN_KV_PREFIX = 'oauth:access';
/** Google access_tokens are ~3600s lived; we cache ~3300s to leave headroom. */
const ACCESS_TOKEN_CACHE_TTL_SEC = 3300;

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
}

/**
 * Get a working Google access_token for `userSlug`. Pulls from KV
 * cache when fresh, otherwise refreshes via Google's token endpoint.
 *
 * Failure modes (all audited):
 *   - vault entry missing            → returns null, no audit row
 *   - vault decrypt fails (corrupt)  → throws, audit `fail_decrypt`
 *   - Google token endpoint 4xx      → returns null, audit `fail:<status>`
 *   - Google rotated refresh_token   → audit `rotate`, vault re-written
 */
export async function getAccessToken(
  deps: WorkspaceOAuthDeps,
  userSlug: string,
  options: { callerSessionId?: string } = {},
): Promise<AccessTokenResult | null> {
  // KV cache first.
  const cacheKey = `${ACCESS_TOKEN_KV_PREFIX}:${userSlug}`;
  const cached = await deps.kv.get(cacheKey, 'json') as
    | { access_token: string; expires_at_ms: number }
    | null;
  if (cached && cached.expires_at_ms > Date.now() + 60_000) {
    return { ...cached, from_cache: true };
  }

  // Vault read.
  let refreshToken: string | null;
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
    throw err;
  }
  if (refreshToken === null) {
    return null;
  }
  await recordOAuthAudit(deps.db, {
    timestamp_ms: Date.now(),
    user_slug: userSlug,
    caller_session_id: options.callerSessionId,
    action: 'get_refresh',
    outcome: 'success',
  });

  // Exchange with Google.
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
    await recordOAuthAudit(deps.db, {
      timestamp_ms: Date.now(),
      user_slug: userSlug,
      caller_session_id: options.callerSessionId,
      action: 'refresh',
      outcome: `fail:${resp.status}`,
      notes: text.slice(0, 512),
    });
    // 401 / 403 == refresh_token revoked or invalid → treat as revoked
    // (S6 fail-close). Clear vault so we don't keep retrying.
    if (resp.status === 401 || resp.status === 403) {
      await deleteRefreshToken(deps.kv, userSlug);
      await deps.kv.delete(cacheKey);
    }
    return null;
  }
  const body = JSON.parse(text) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    token_type?: string;
  };
  const expiresAtMs = Date.now() + body.expires_in * 1000;

  // Google rotates refresh_tokens only occasionally — handle it when
  // we see it (S3 rotate path).
  if (body.refresh_token && body.refresh_token !== refreshToken) {
    await putRefreshToken(deps.kv, deps.vaultKeyB64, userSlug, body.refresh_token);
    await recordOAuthAudit(deps.db, {
      timestamp_ms: Date.now(),
      user_slug: userSlug,
      caller_session_id: options.callerSessionId,
      action: 'rotate',
      outcome: 'success',
    });
  }

  await recordOAuthAudit(deps.db, {
    timestamp_ms: Date.now(),
    user_slug: userSlug,
    caller_session_id: options.callerSessionId,
    action: 'refresh',
    outcome: 'success',
  });

  // Cache. Use expirationTtl in seconds (Workers KV minimum is 60 s).
  await deps.kv.put(
    cacheKey,
    JSON.stringify({ access_token: body.access_token, expires_at_ms: expiresAtMs }),
    { expirationTtl: ACCESS_TOKEN_CACHE_TTL_SEC },
  );

  return {
    access_token: body.access_token,
    expires_at_ms: expiresAtMs,
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
  await deps.kv.delete(`${ACCESS_TOKEN_KV_PREFIX}:${userSlug}`);
  await recordOAuthAudit(deps.db, {
    timestamp_ms: Date.now(),
    user_slug: userSlug,
    caller_session_id: options.callerSessionId,
    action: 'revoke',
    outcome: 'success',
  });
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
