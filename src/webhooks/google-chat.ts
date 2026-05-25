/**
 * Google Chat HTTPS webhook handler (Phase A = ingress).
 *
 * Cloud Run 旧経路 (`scripts/cma_gchat_bot.py:3784` の `_handle_event`) は
 * Pub/Sub pull で Google Chat event を受信していた。Cloudflare 移行では
 * Pub/Sub を撤去し Google Chat App 設定の endpoint を Worker の
 * `POST /webhooks/google-chat` に切り替える (Day 4 で Workspace Admin
 * Console から切替実施)。
 *
 * 本 handler の責務 (= Phase A ingress only):
 *   1. Google が発行する OIDC JWT (Authorization: Bearer <JWT>) を検証
 *   2. JSON payload を parse、MESSAGE event のみ採用
 *   3. message.name を event_key として `claimEvent` (= D1 dedupe lib) で
 *      二重投入を抑止
 *   4. Cloudflare Queue `makoto-chat-queue` に投入
 *   5. 200 OK を即返す (Google Chat の retry を抑える)
 *
 * Phase B (= sessions.create + tool dispatch + 各 marker 解析、= 重い
 * session orchestration) は Queue consumer 側で別 subagent が実装する。
 * 本 handler は **Queue 投入までで打ち切る**。dedupe の commit (= 完了
 * fence の確定) も Phase B 側で `commitDone` を呼ぶ。
 *
 * JWT 検証:
 *   - iss = 'chat@system.gserviceaccount.com'
 *   - aud = env.GCP_BOT_PROJECT_NUMBER (= bot project の数値 ID 文字列)
 *   - exp > now (= 期限切れ拒否、jose 側で自動検証)
 *   - 公開鍵: https://www.googleapis.com/service_accounts/v1/metadata/x509/
 *            chat@system.gserviceaccount.com (= `{kid: X.509 PEM cert}` JSON)
 *
 * 公開鍵 cache: module-level Map + TTL 24h (Google rotation は rare)。
 * cache miss / expiry で再 fetch。
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 #5 — Google Chat reactive bot)
 * Spec: 親 task brief (Day 3 subagent F、= Phase A ingress)
 */

import {
  importX509,
  jwtVerify,
  decodeProtectedHeader,
  type JWTPayload,
} from 'jose';

import {
  tryClaim,
  releaseClaim,
  newClaimOwner,
  type ClaimResult,
} from '../lib/dedupe';
import { assertBridgeEgressAllowed } from '../lib/egress-guard';

// ============================================================================
// 型定義
// ============================================================================

/**
 * Google Chat event payload — Phase A で消費する最小 subset。
 * Cloud Run `cma_gchat_bot.py:3784` `_handle_event` で参照する shape を
 * HTTPS push 形式に正規化したもの (Pub/Sub envelope は剥がす前提)。
 */
export interface ChatEventPayload {
  type:
    | 'MESSAGE'
    | 'ADDED_TO_SPACE'
    | 'REMOVED_FROM_SPACE'
    | 'CARD_CLICKED'
    | string;
  eventTime?: string; // ISO 8601
  message?: {
    name: string; // 'spaces/AAA/messages/BBB' = 一意 ID (dedupe key 用)
    sender: { name: string; displayName?: string; email?: string };
    text?: string;
    thread?: { name?: string };
  };
  space?: { name: string; type?: string; displayName?: string };
  user?: { name: string; displayName?: string; email?: string };
}

/**
 * Queue payload — Phase B (Queue consumer) が受け取る一式。
 * `claim` を載せて Phase B 側で `confirmOwner` → 重い処理 → `commitDone`
 * の dance を踏めるようにする。
 */
export interface ChatQueueMessage {
  eventKey: string;
  receivedAtMs: number;
  claim: { owner: string; version: number };
  payload: ChatEventPayload;
}

// ============================================================================
// 公開鍵 cache + fetch
// ============================================================================

const GOOGLE_CHAT_ISSUER = 'chat@system.gserviceaccount.com';
const GOOGLE_X509_URL =
  'https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com';
const PUBLIC_KEY_TTL_MS = 24 * 60 * 60 * 1000; // 24 時間

interface PublicKeyCacheEntry {
  /** kid -> CryptoKey */
  keys: Map<string, CryptoKey>;
  expiresAtMs: number;
}

/**
 * Module-level cache (= isolate 内で再利用)。Workers の isolate は
 * cold start でなければ温まったままなので、cache は実質ほぼ常に hit する。
 * cache 喪失時も透過的に再 fetch するので安全に揮発できる。
 */
let publicKeyCache: PublicKeyCacheEntry | null = null;

/**
 * Google の X.509 公開鍵 endpoint を引いて kid -> CryptoKey の Map に
 * 変換する。`{kid: PEM string}` 形式 JSON が返る前提。
 * jose の `importX509` で X.509 PEM を CryptoKey に変換。
 *
 * 失敗時は throw、呼出元が 500 にマップする。
 */
async function fetchGooglePublicKeys(): Promise<Map<string, CryptoKey>> {
  assertBridgeEgressAllowed(GOOGLE_X509_URL, 'google-chat-webhook:fetchPublicKeys');
  const res = await fetch(GOOGLE_X509_URL);
  if (!res.ok) {
    throw new Error(
      `google-chat public key fetch failed: status=${res.status}`,
    );
  }
  const data = (await res.json()) as Record<string, string>;
  const out = new Map<string, CryptoKey>();
  for (const [kid, pem] of Object.entries(data)) {
    if (typeof pem !== 'string') continue;
    try {
      const key = (await importX509(pem, 'RS256')) as unknown as CryptoKey;
      out.set(kid, key);
    } catch (err) {
      console.warn(
        `[chat-webhook] importX509 skip kid=${kid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (out.size === 0) {
    throw new Error('google-chat public key fetch returned no valid keys');
  }
  return out;
}

/**
 * cache hit なら cache を返し、miss / expiry なら再 fetch する。
 * 戻り値の Map は (= 共有参照なので) 変更しないこと。
 */
async function getGooglePublicKeys(now: number = Date.now()): Promise<
  Map<string, CryptoKey>
> {
  if (publicKeyCache && publicKeyCache.expiresAtMs > now) {
    return publicKeyCache.keys;
  }
  const keys = await fetchGooglePublicKeys();
  publicKeyCache = { keys, expiresAtMs: now + PUBLIC_KEY_TTL_MS };
  return keys;
}

/**
 * テスト用 (cache を強制クリアして再 fetch を走らせる)。本番経路では
 * 呼ばない。
 */
export function _resetPublicKeyCacheForTesting(): void {
  publicKeyCache = null;
}

// ============================================================================
// JWT 検証
// ============================================================================

/**
 * Bearer JWT を検証して claims を返す。失敗時は null を返す
 * (呼出元が 401 にマップ)。kid mismatch / signature 失敗 / claims 不一致
 * いずれも null。
 */
export async function verifyGoogleChatJwt(
  jwt: string,
  expectedAudience: string,
): Promise<JWTPayload | null> {
  // kid を header から取り出して、該当する公開鍵を選別する。
  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(jwt);
    if (typeof header.kid === 'string') kid = header.kid;
  } catch {
    return null;
  }
  if (!kid) return null;

  let keys: Map<string, CryptoKey>;
  try {
    keys = await getGooglePublicKeys();
  } catch (err) {
    // 公開鍵 fetch 失敗は呼出元で 500 にしたいので throw する。
    throw err;
  }
  let key = keys.get(kid);
  if (!key) {
    // cache に該当 kid なし → rotation の可能性。一度だけ強制再 fetch。
    publicKeyCache = null;
    try {
      keys = await getGooglePublicKeys();
    } catch (err) {
      throw err;
    }
    key = keys.get(kid);
    if (!key) {
      console.warn(`[chat-webhook] reject unknown-kid kid=${kid}`);
      return null;
    }
  }

  try {
    const { payload } = await jwtVerify(jwt, key, {
      issuer: GOOGLE_CHAT_ISSUER,
      audience: expectedAudience,
      algorithms: ['RS256'],
    });
    return payload;
  } catch (err) {
    console.warn(
      `[chat-webhook] jwt verify fail: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ============================================================================
// payload validation
// ============================================================================

/**
 * 最小 validation — JSON.parse の結果が ChatEventPayload らしき形状か
 * を確認する。Phase A は MESSAGE event のときに `message.name` が
 * 必須 (= dedupe key)。
 */
function isChatEventPayload(v: unknown): v is ChatEventPayload {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.type !== 'string') return false;
  return true;
}

function isMessageEvent(
  e: ChatEventPayload,
): e is ChatEventPayload & {
  message: NonNullable<ChatEventPayload['message']>;
} {
  if (e.type !== 'MESSAGE') return false;
  const m = e.message;
  if (!m || typeof m !== 'object') return false;
  if (typeof m.name !== 'string' || m.name.length === 0) return false;
  return true;
}

// ============================================================================
// public entrypoint
// ============================================================================

/**
 * `POST /webhooks/google-chat` route handler。`src/index.ts` から dispatch。
 *
 * 応答 contract:
 *   - 200 OK + `{ ok: true }`                        — MESSAGE event 受理 + Queue 投入
 *   - 200 OK + `{ ok: true, skipped: true }`          — 非 MESSAGE event
 *   - 200 OK + `{ ok: true, duplicate: true }`        — 同一 message.name 再送
 *   - 401 Unauthorized                                — Authorization header 欠落 / JWT 検証失敗
 *   - 400 Bad Request                                 — malformed JSON
 *   - 500 Internal Server Error                       — Queue 投入失敗 / 公開鍵 fetch 失敗
 *
 * Google Chat は 2xx で ack、4xx/5xx で retry (= Pub/Sub と同様の
 * at-least-once 配送)。dedupe で二重投入を防ぐ。
 */
export async function handleGoogleChatWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const cfRay = request.headers.get('cf-ray') || 'unknown';

  // ---- 1. Authorization header ----
  const authz = request.headers.get('authorization') || request.headers.get('Authorization');
  if (!authz || !authz.toLowerCase().startsWith('bearer ')) {
    console.warn(
      `[chat-webhook] reject missing-authorization cfRay=${cfRay}`,
    );
    return Response.json(
      { error: 'missing authorization header' },
      { status: 401 },
    );
  }
  const jwt = authz.slice(7).trim();
  if (!jwt) {
    return Response.json({ error: 'empty bearer token' }, { status: 401 });
  }

  // ---- 2. project number (audience) ----
  const projectNumber = env.GCP_BOT_PROJECT_NUMBER;
  if (!projectNumber || typeof projectNumber !== 'string') {
    console.error(
      `[chat-webhook] reject no-project-number cfRay=${cfRay}`,
    );
    return Response.json(
      { error: 'GCP_BOT_PROJECT_NUMBER not configured' },
      { status: 500 },
    );
  }

  // ---- 3. JWT verify ----
  let claims: JWTPayload | null;
  try {
    claims = await verifyGoogleChatJwt(jwt, projectNumber);
  } catch (err) {
    // 公開鍵 fetch 失敗 = 一過性の障害として 500 を返し Google Chat の
    // retry に任せる。
    console.error(
      `[chat-webhook] public-key fetch failed cfRay=${cfRay}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return Response.json(
      { error: 'public key fetch failed' },
      { status: 500 },
    );
  }
  if (!claims) {
    return Response.json({ error: 'invalid jwt' }, { status: 401 });
  }

  // ---- 4. body parse ----
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return Response.json({ error: 'failed to read body' }, { status: 400 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    console.warn(`[chat-webhook] reject invalid-json cfRay=${cfRay}`);
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!isChatEventPayload(parsed)) {
    console.warn(`[chat-webhook] reject invalid-shape cfRay=${cfRay}`);
    return Response.json({ error: 'invalid payload shape' }, { status: 400 });
  }
  const event = parsed;

  // ---- 5. event type filter ----
  if (!isMessageEvent(event)) {
    console.log(
      `[chat-webhook] skip non-message type=${event.type} cfRay=${cfRay}`,
    );
    return Response.json({ ok: true, skipped: true });
  }

  // ---- 6. dedupe claim ----
  const eventKey = `chat:msgname:${event.message.name}`;
  const owner = newClaimOwner(cfRay);
  let claim: ClaimResult;
  try {
    claim = await tryClaim(env.DB, eventKey, owner);
  } catch (err) {
    console.error(
      `[chat-webhook] dedupe-claim failed cfRay=${cfRay} eventKey=${eventKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return Response.json({ error: 'dedupe claim failed' }, { status: 500 });
  }

  if (claim.state === 'DONE_DUPLICATE' || claim.state === 'LEASE_ALIVE') {
    console.log(
      `[chat-webhook] duplicate state=${claim.state} eventKey=${eventKey} cfRay=${cfRay}`,
    );
    return Response.json({ ok: true, duplicate: true });
  }
  if ((claim.state !== 'NEW' && claim.state !== 'TAKEOVER') ||
      claim.owner === undefined || claim.version === undefined) {
    // 防御的: 型上 NEW/TAKEOVER のときは owner/version が入る契約だが
    // 何らかの理由で取れなかったら 500 にして retry させる。
    console.error(
      `[chat-webhook] unexpected claim state=${claim.state} cfRay=${cfRay}`,
    );
    return Response.json({ error: 'unexpected claim state' }, { status: 500 });
  }

  // ---- 7. Queue 投入 ----
  const queueMsg: ChatQueueMessage = {
    eventKey,
    receivedAtMs: Date.now(),
    claim: { owner: claim.owner, version: claim.version },
    payload: event,
  };
  try {
    await env.MAKOTO_CHAT_QUEUE.send(queueMsg);
  } catch (err) {
    // Queue 投入失敗 → claim は release して successor が retake できる
    // ようにする。Google Chat 側 retry に任せる。
    try {
      await releaseClaim(env.DB, eventKey, claim.owner, claim.version);
    } catch (releaseErr) {
      console.error(
        `[chat-webhook] releaseClaim after queue fail also failed cfRay=${cfRay}: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`,
      );
    }
    console.error(
      `[chat-webhook] queue-send failed cfRay=${cfRay} eventKey=${eventKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return Response.json({ error: 'queue send failed' }, { status: 500 });
  }

  console.log(
    `[chat-webhook] enqueued eventKey=${eventKey} sender=${event.message.sender?.name ?? ''} cfRay=${cfRay}`,
  );
  return Response.json({ ok: true });
}
