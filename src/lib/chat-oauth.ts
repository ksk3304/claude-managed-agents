/**
 * Google Chat User OAuth for `chat.messages.readonly` scope.
 *
 * Phase 2 (#186) — the reactive bot needs thread history (= past
 * messages in a Chat space) to build session context. Service-Account
 * delegation can't grant `chat.messages.readonly`; Google requires a
 * real user OAuth grant. The Cloud Run runtime persists this as a
 * Secret Manager-backed refresh_token rotated automatically
 * (`scripts/cma_gchat_auth.py:_PersistingUserCredentials`).
 *
 * On Cloudflare we can't write Worker secrets at runtime, so the
 * Worker carries the initial refresh_token as a Worker secret seed
 * (`GCHAT_OAUTH_REFRESH_TOKEN_SEED`). On first use we copy that seed
 * into the encrypted KV vault (under `vault:oauth:gchat-bot:
 * refresh_token`), and from that point forward Google's occasional
 * refresh_token rotation is written back to KV — exactly like
 * `workspace-oauth.ts` does for per-user Workspace OAuth.
 *
 * Auth flow (mirrors `cma_gchat_auth.py:load_user_oauth_credentials`):
 *   1. resolve refresh_token: KV vault → fall back to Worker secret
 *      seed and persist it under the same KV key
 *   2. POST to `https://oauth2.googleapis.com/token` with
 *      `grant_type=refresh_token` + chat OAuth client credentials
 *   3. if Google rotated the refresh_token, write the new value back
 *      to the KV vault (`_writeback_to_secret_manager` analogue)
 *   4. cache the access_token module-level (one isolate, mostly cache
 *      hits for the bot singleton) with 5-minute refresh margin
 *
 * This is a single-bot identity (`user_slug = 'gchat-bot'`) so we
 * don't use the per-user `OAuthLease` Durable Object — there is no
 * cross-user contention to serialise.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — #7 Chat User OAuth)
 * Spec: port-mapping v1 §1 row #7 + plan-draft-v5.md §4 Day 3
 * Python source: scripts/cma_gchat_auth.py:262-355
 *   (_PersistingUserCredentials + load_user_oauth_credentials)
 */

import {
  getRefreshToken,
  putRefreshToken,
} from './oauth-vault';
import { assertBridgeEgressAllowed } from './egress-guard';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Cloud Run side scope, mirrored 1:1 (`cma_gchat_auth.py:18`). */
export const CHAT_MESSAGES_READONLY_SCOPE =
  'https://www.googleapis.com/auth/chat.messages.readonly';

/** Bot-singleton vault slug. Allowed by oauth-vault `assertSlug`. */
export const CHAT_BOT_USER_SLUG = 'gchat-bot';

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface ChatOAuthDeps {
  kv: KVNamespace;
  /** Same vault key the Workspace OAuth path uses (AES-GCM-256). */
  vaultKeyB64: string;
  /** Worker secret `GCHAT_OAUTH_CLIENT_ID`. */
  clientId: string;
  /** Worker secret `GCHAT_OAUTH_CLIENT_SECRET`. */
  clientSecret: string;
  /**
   * Worker secret `GCHAT_OAUTH_REFRESH_TOKEN_SEED`. Used only when the
   * KV vault entry is absent (= first Worker startup or post-purge).
   * Once copied into the vault, Google's rotation path takes over and
   * the seed is ignored — leave it set so cold starts after a vault
   * miss can re-seed if the operator clears the entry by hand.
   */
  refreshTokenSeed: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Override slug for tests / future per-identity Chat OAuth callers. */
  userSlug?: string;
}

export interface ChatAccessTokenResult {
  access_token: string;
  /** Epoch ms the token expires (server-reported `expires_in`). */
  expires_at_ms: number;
  /** Whether we served from the module cache. */
  from_cache: boolean;
}

export class ChatOAuthError extends Error {
  readonly status: number | null;
  readonly responseBody: string | null;
  constructor(message: string, status: number | null, responseBody: string | null) {
    super(message);
    this.name = 'ChatOAuthError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

interface TokenCacheEntry {
  access_token: string;
  /** Epoch ms the token expires (server-reported `expires_in`). */
  expiresAtMs: number;
  /** Slug the cached token was minted for (lets us cache multiple bots). */
  userSlug: string;
}

// Module-level cache. One entry per isolate (one bot identity per
// Worker), safe to lose — we refresh transparently on miss.
let cachedToken: TokenCacheEntry | null = null;

/**
 * Resolve a Google access_token for `chat.messages.readonly`. Mostly
 * cache hits; on miss we refresh via Google `/token`, persist any
 * rotated refresh_token to the KV vault, and update the module cache.
 */
export async function getChatReadonlyAccessToken(
  deps: ChatOAuthDeps,
): Promise<ChatAccessTokenResult> {
  const userSlug = deps.userSlug ?? CHAT_BOT_USER_SLUG;
  const now = Date.now();
  if (
    cachedToken &&
    cachedToken.userSlug === userSlug &&
    cachedToken.expiresAtMs > now + TOKEN_REFRESH_MARGIN_MS
  ) {
    return {
      access_token: cachedToken.access_token,
      expires_at_ms: cachedToken.expiresAtMs,
      from_cache: true,
    };
  }

  const refreshToken = await resolveRefreshToken(deps, userSlug);

  const fetchImpl = deps.fetchImpl ?? fetch;
  assertBridgeEgressAllowed(GOOGLE_TOKEN_URL, 'chat-oauth:refresh');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: deps.clientId,
    client_secret: deps.clientSecret,
    refresh_token: refreshToken,
  });
  const resp = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await safeReadText(resp);
  if (!resp.ok) {
    throw new ChatOAuthError(
      `chat-oauth refresh failed status=${resp.status} user_slug=${userSlug} body=${text.slice(0, 300)}`,
      resp.status,
      text,
    );
  }

  const parsed = JSON.parse(text) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  if (!parsed.access_token || !parsed.expires_in) {
    throw new ChatOAuthError(
      `chat-oauth token endpoint returned malformed response (missing access_token / expires_in) user_slug=${userSlug}`,
      resp.status,
      text.slice(0, 300),
    );
  }

  // Google occasionally rotates refresh_tokens. Mirror the Cloud Run
  // `_PersistingUserCredentials._writeback_to_secret_manager` path:
  // when we observe a new token, persist it back to the vault so the
  // next isolate / cold start picks up the rotation. Failing to do so
  // is non-fatal — the old refresh_token still works for now — but we
  // log loudly because eventually the old one will be revoked.
  if (parsed.refresh_token && parsed.refresh_token !== refreshToken) {
    try {
      await putRefreshToken(
        deps.kv,
        deps.vaultKeyB64,
        userSlug,
        parsed.refresh_token,
      );
      console.log(
        `[chat-oauth] refresh_token rotated user_slug=${userSlug} — persisted new token to vault`,
      );
    } catch (err) {
      console.error(
        `[chat-oauth] WARN failed to persist rotated refresh_token user_slug=${userSlug}: ${errorMessage(err)} — next cold start will refresh with old token until vault write succeeds`,
      );
    }
  }

  const expiresInMs = parsed.expires_in * 1000;
  cachedToken = {
    access_token: parsed.access_token,
    expiresAtMs: now + expiresInMs,
    userSlug,
  };
  return {
    access_token: parsed.access_token,
    expires_at_ms: cachedToken.expiresAtMs,
    from_cache: false,
  };
}

/**
 * Read the refresh_token from the KV vault, falling back to the
 * Worker secret seed on first startup (and copying the seed into the
 * vault so subsequent rotations write to a known place).
 */
async function resolveRefreshToken(
  deps: ChatOAuthDeps,
  userSlug: string,
): Promise<string> {
  const existing = await getRefreshToken(deps.kv, deps.vaultKeyB64, userSlug);
  if (existing !== null) return existing;
  if (!deps.refreshTokenSeed) {
    throw new ChatOAuthError(
      `chat-oauth has no refresh_token: vault empty for user_slug=${userSlug} and no GCHAT_OAUTH_REFRESH_TOKEN_SEED Worker secret`,
      null,
      null,
    );
  }
  await putRefreshToken(
    deps.kv,
    deps.vaultKeyB64,
    userSlug,
    deps.refreshTokenSeed,
  );
  console.log(
    `[chat-oauth] seeded refresh_token from Worker secret into vault user_slug=${userSlug}`,
  );
  return deps.refreshTokenSeed;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable>';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reset the module-level cache. Tests only. */
export function _resetChatOAuthCacheForTests(): void {
  cachedToken = null;
}
