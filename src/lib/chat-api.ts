/**
 * Google Chat REST client for the MAKOTOくん bridge.
 *
 * Phase 2 (#186) — the Worker posts notifications + reactive replies to
 * Google Chat spaces via `spaces/.../messages` REST. Authentication
 * follows the same model the Cloud Run runtime uses today
 * (`scripts/cma_gchat_auth.py:build_credentials`):
 *
 *   1. parse the Service Account JSON (Worker secret `CHAT_SA_KEY_JSON`)
 *   2. sign a short-lived JWT with the SA's RSA private key (RS256)
 *   3. exchange the JWT at `https://oauth2.googleapis.com/token` for an
 *      access_token with `chat.bot` scope
 *   4. POST to `https://chat.googleapis.com/v1/{space}/messages` with
 *      `Authorization: Bearer <token>`
 *
 * The Cloudflare Worker has no `K_SERVICE` ADC equivalent, so the SA
 * key has to be carried explicitly. We persist it as a Worker secret
 * (single-tenant, bot-wide key — not per-user) rather than the KV
 * envelope vault `oauth-vault.ts` uses for per-user OAuth refresh
 * tokens. Workers' secret storage encrypts at rest and is the standard
 * surface for this kind of single key material.
 *
 * Token caching: the access_token returned by Google's token endpoint
 * lasts 3600 seconds. We cache it module-level (one cache per isolate)
 * and refresh 5 minutes before expiry. Workers isolate reuse keeps the
 * cache warm across requests in practice but the cache is also safe
 * to lose — we fall back to a fresh JWT exchange transparently.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — #6 Chat REST client)
 * Spec: port-mapping v1 §1 row #6 + plan-draft-v5.md §0 Day 2 一気 port
 * Auth design: choice A (= SA key as Worker secret), see diary
 *   `引き継ぎログ-v5-plan-locked.md` follow-up (2026-05-26).
 */

import { assertBridgeEgressAllowed } from './egress-guard';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CHAT_API_BASE = 'https://chat.googleapis.com/v1';

/** Standard Chat bot scope — same as `cma_gchat_send.py:SCOPES`. */
export const CHAT_BOT_SCOPE = 'https://www.googleapis.com/auth/chat.bot';

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Minimal subset of the Google Service Account JSON we read. Real
 * keys carry more fields (`token_uri`, `auth_uri`, `type`, ...) but
 * those are advisory only — the JWT exchange only requires
 * `client_email` + `private_key`.
 */
export interface ChatSaKey {
  client_email: string;
  private_key: string;
  /** `kid` header — informational, not required for verification. */
  private_key_id?: string;
}

export interface ChatApiDeps {
  /**
   * Worker secret `CHAT_SA_KEY_JSON` — JSON-encoded Google Service
   * Account key (with `private_key` PEM + `client_email`). Same SA
   * the Cloud Run runtime uses for `chat.bot` scope.
   */
  saKeyJson: string;
  /** Override `fetch` for tests. */
  fetchImpl?: typeof fetch;
  /**
   * Override scopes (default: `['chat.bot']`). Reserved for future
   * Chat REST surfaces (e.g. `chat.messages.readonly` for thread
   * history reads) without forcing a separate token cache.
   */
  scopes?: readonly string[];
}

export interface PostChatMessageOptions {
  /**
   * Reply into an existing thread. Format: `spaces/.../threads/...`.
   * Omit for a new top-level thread.
   */
  threadName?: string;
  /**
   * Optional client-supplied message ID (Chat REST `messageId` query
   * param). Useful for idempotent retries — the same `messageId`
   * collapses to a single posted message.
   */
  messageId?: string;
  /**
   * Reply behaviour when `threadName` is set but the thread no longer
   * exists. Mirrors Chat REST `messageReplyOption`:
   *   - `REPLY_MESSAGE_OR_FAIL_IF_NOT_FOUND` (default-ish, Chat default)
   *   - `REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`
   * Omit for Chat default (= fail if thread not found).
   */
  threadFallback?:
    | 'REPLY_MESSAGE_OR_FAIL_IF_NOT_FOUND'
    | 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
}

export interface ChatMessageResult {
  /** Posted message resource name (`spaces/.../messages/...`). */
  name: string;
  /** Resource name of the thread the message landed in. */
  threadName?: string;
}

interface TokenCacheEntry {
  access_token: string;
  /** Epoch ms the token expires (server-reported `expires_in`). */
  expiresAtMs: number;
  /** Scopes the cached token was minted for. */
  scopes: string;
}

// Module-level cache. One entry per isolate; survives across requests
// in the same isolate but is safe to lose (we refresh transparently).
let cachedToken: TokenCacheEntry | null = null;

/**
 * Post a text message to a Chat space.
 *
 * `spaceName` must be the full resource name (`spaces/...`). Caller
 * resolves aliases (= `cma_gchat_aliases.json` equivalent) upstream;
 * this layer is identity-only.
 */
export async function postChatMessage(
  deps: ChatApiDeps,
  spaceName: string,
  text: string,
  options: PostChatMessageOptions = {},
): Promise<ChatMessageResult> {
  if (!spaceName.startsWith('spaces/')) {
    throw new Error(
      `postChatMessage: spaceName must start with 'spaces/' (got ${spaceName})`,
    );
  }
  if (!text || text.length === 0) {
    throw new Error('postChatMessage: text must be non-empty');
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const scopes = deps.scopes ?? [CHAT_BOT_SCOPE];
  const token = await getChatAccessToken(deps, scopes);

  const body: Record<string, unknown> = { text };
  if (options.threadName) {
    body.thread = { name: options.threadName };
  }

  const queryParams = new URLSearchParams();
  if (options.messageId) queryParams.set('messageId', options.messageId);
  if (options.threadFallback) {
    queryParams.set('messageReplyOption', options.threadFallback);
  }
  const qs = queryParams.toString();
  const url = `${CHAT_API_BASE}/${spaceName}/messages${qs ? `?${qs}` : ''}`;

  assertBridgeEgressAllowed(url, 'chat-api:postChatMessage');

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await safeReadText(response);
    throw new ChatApiError(
      `Chat REST POST failed status=${response.status} space=${spaceName} body=${errorText.slice(0, 300)}`,
      response.status,
      errorText,
    );
  }

  const result = (await response.json()) as {
    name?: string;
    thread?: { name?: string };
  };
  if (!result.name) {
    throw new ChatApiError(
      `Chat REST POST returned no 'name' field (space=${spaceName})`,
      response.status,
      JSON.stringify(result).slice(0, 300),
    );
  }
  const out: ChatMessageResult = { name: result.name };
  if (result.thread?.name) out.threadName = result.thread.name;
  return out;
}

export class ChatApiError extends Error {
  readonly status: number;
  readonly responseBody: string;
  constructor(message: string, status: number, responseBody: string) {
    super(message);
    this.name = 'ChatApiError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

/**
 * Resolve a Google access_token for the given scopes, using the
 * module-level cache when possible.
 *
 * Exported for direct use by callers that need a token for an
 * adjacent Chat REST surface (e.g. fetching a thread) — those callers
 * still go through this same cache.
 */
export async function getChatAccessToken(
  deps: ChatApiDeps,
  scopes: readonly string[],
): Promise<string> {
  const scopeKey = [...scopes].sort().join(' ');
  const now = Date.now();
  if (
    cachedToken &&
    cachedToken.scopes === scopeKey &&
    cachedToken.expiresAtMs > now + TOKEN_REFRESH_MARGIN_MS
  ) {
    return cachedToken.access_token;
  }

  const saKey = parseSaKey(deps.saKeyJson);
  const jwt = await buildSaJwt(saKey, scopes);

  const fetchImpl = deps.fetchImpl ?? fetch;
  assertBridgeEgressAllowed(GOOGLE_TOKEN_URL, 'chat-api:getAccessToken');

  const tokenBody = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });

  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  });

  if (!response.ok) {
    const errorText = await safeReadText(response);
    throw new ChatApiError(
      `Google token endpoint failed status=${response.status} body=${errorText.slice(0, 300)}`,
      response.status,
      errorText,
    );
  }

  const tokenResponse = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!tokenResponse.access_token || !tokenResponse.expires_in) {
    throw new ChatApiError(
      'Google token endpoint returned malformed response (missing access_token / expires_in)',
      response.status,
      JSON.stringify(tokenResponse).slice(0, 300),
    );
  }

  cachedToken = {
    access_token: tokenResponse.access_token,
    expiresAtMs: now + tokenResponse.expires_in * 1000,
    scopes: scopeKey,
  };
  return cachedToken.access_token;
}

function parseSaKey(saKeyJson: string): ChatSaKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(saKeyJson);
  } catch (exc) {
    throw new Error(
      `CHAT_SA_KEY_JSON is not valid JSON: ${(exc as Error).message}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('CHAT_SA_KEY_JSON must decode to a JSON object');
  }
  const o = parsed as Partial<ChatSaKey>;
  if (!o.client_email || typeof o.client_email !== 'string') {
    throw new Error("CHAT_SA_KEY_JSON missing 'client_email'");
  }
  if (!o.private_key || typeof o.private_key !== 'string') {
    throw new Error("CHAT_SA_KEY_JSON missing 'private_key'");
  }
  return {
    client_email: o.client_email,
    private_key: o.private_key,
    ...(typeof o.private_key_id === 'string'
      ? { private_key_id: o.private_key_id }
      : {}),
  };
}

async function buildSaJwt(
  saKey: ChatSaKey,
  scopes: readonly string[],
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (saKey.private_key_id) header.kid = saKey.private_key_id;
  const claim = {
    iss: saKey.client_email,
    scope: scopes.join(' '),
    aud: GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };

  const headerB64 = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(header)),
  );
  const claimB64 = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(claim)),
  );
  const signInput = `${headerB64}.${claimB64}`;

  const privateKey = await importSaPrivateKey(saKey.private_key);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signInput),
  );
  const signatureB64 = base64UrlEncode(new Uint8Array(signature));

  return `${signInput}.${signatureB64}`;
}

async function importSaPrivateKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (pemBody.length === 0) {
    throw new Error('SA private_key PEM body is empty after stripping headers');
  }
  let der: Uint8Array;
  try {
    der = base64Decode(pemBody);
  } catch (exc) {
    throw new Error(
      `SA private_key PEM body is not valid base64: ${(exc as Error).message}`,
    );
  }
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable>';
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64Decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Patch an existing Chat message's text. Used by the placeholder
 * post → update pattern (= Cloud Run `cma_gchat_bot.py:l.1861-1875`
 * `_update_chat_message`):
 *   1. Bot posts a placeholder (= "...MAKOTOくんが入力中") immediately
 *      to ack the user's message → Google Chat client stops the
 *      "MAKOTOくん から応答ありません" timeout error.
 *   2. Bot does the heavy session.create + LLM stream + marker parse.
 *   3. When done, bot PATCHes the placeholder's resource name with the
 *      final reply text → user sees the placeholder rewritten in place.
 *
 * `messageName` is the full resource name returned by `postChatMessage`
 * (e.g. `spaces/AAA/messages/BBB.CCC`). `updateMask=text` is the only
 * mask we use today; expand if cards/attachments are needed later.
 */
export async function updateChatMessage(
  deps: ChatApiDeps,
  messageName: string,
  text: string,
): Promise<void> {
  if (!messageName || !messageName.startsWith('spaces/')) {
    throw new Error(
      `updateChatMessage: messageName must start with 'spaces/' (got ${messageName})`,
    );
  }
  if (!text || text.length === 0) {
    throw new Error('updateChatMessage: text must be non-empty');
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const scopes = deps.scopes ?? [CHAT_BOT_SCOPE];
  const token = await getChatAccessToken(deps, scopes);

  // PATCH /v1/{messageName}?updateMask=text (= Python l.1867-1870 等価)
  const url = `${CHAT_API_BASE}/${messageName}?updateMask=text`;
  assertBridgeEgressAllowed(url, 'chat-api:updateChatMessage');

  const response = await fetchImpl(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const errorText = await safeReadText(response);
    throw new ChatApiError(
      `Chat REST PATCH failed status=${response.status} message=${messageName} body=${errorText.slice(0, 300)}`,
      response.status,
      errorText,
    );
  }
}

/** Reset the module-level cache. Tests only. */
export function _resetChatTokenCacheForTests(): void {
  cachedToken = null;
}
