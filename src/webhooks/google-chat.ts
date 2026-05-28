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
  importJWK,
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
import {
  recordChatWebhookPayload,
  recordRuntimeEvent,
} from '../lib/observability';

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
    /**
     * Google Chat `Message.annotations`. shared space で mention の
     * 厳密判定 (= substring 一致では拾えない USER_MENTION の
     * startIndex/length) を行うため必須 (Issue #186 既知 #9 + #10)。
     *
     * type / userMention / startIndex / length の詳細は
     * `src/lib/mention-detection.ts:ChatAnnotation` を参照。
     */
    annotations?: Array<{
      type?: string;
      startIndex?: number;
      length?: number;
      userMention?: {
        user?: {
          name?: string;
          type?: string;
        };
      };
    }>;
    /**
     * Google Chat REST API の `messagePayload.message.attachment[]`。Issue
     * #186 既知 #1 + O で image / PDF / Office 添付処理を有効化する際に
     * 必要 (`src/lib/attachment-processing.ts:buildAllAttachmentBlocks`).
     * normalize 時の `mp.message` cast 経由で透過的に通る (= field 名そのまま)。
     */
    attachment?: Array<{
      contentType?: string;
      contentName?: string;
      name?: string;
      source?: string;
      attachmentDataRef?: { resourceName?: string };
    }> | null;
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

// Google Chat HTTPS push の OIDC JWT は標準 Google OIDC token なので
// iss claim は `https://accounts.google.com` か `accounts.google.com` の
// いずれか (公式 doc: https://developers.google.com/workspace/chat/verify-requests-from-chat
// "for standard Google OIDC tokens, verify that the value of the iss claim
// in the ID token is equal to https://accounts.google.com or
// accounts.google.com")。歴史的 email-form `chat@system.gserviceaccount.com`
// は email field の値であって iss claim ではない (2026-05-26 実機検証で
// "unexpected iss" 判明、3 候補全部 accept で安全側に倒す)。
const GOOGLE_CHAT_ISSUERS = [
  'https://accounts.google.com',
  'accounts.google.com',
  'chat@system.gserviceaccount.com',
];
// 旧: chat@system の X.509 cert dict を見ていたが、実機の JWT は Google
// 標準 OIDC JWK Set (`oauth2/v3/certs`) の key で sign されている
// (= 2026-05-26 実機検証で kid mismatch 判明)。標準 JWKS に切替。
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
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
 * Google 標準 OIDC JWK Set (`oauth2/v3/certs`) を引いて kid -> CryptoKey
 * の Map に変換する。response は `{keys: [{kid, kty, n, e, alg, use}, ...]}`
 * の JWK Set 形式。jose の `importJWK` で各 JWK を CryptoKey に変換。
 *
 * 失敗時は throw、呼出元が 500 にマップする。
 */
async function fetchGooglePublicKeys(): Promise<Map<string, CryptoKey>> {
  assertBridgeEgressAllowed(GOOGLE_JWKS_URL, 'google-chat-webhook:fetchPublicKeys');
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) {
    throw new Error(
      `google-chat public key fetch failed: status=${res.status}`,
    );
  }
  const data = (await res.json()) as {
    keys?: Array<Record<string, string>>;
  };
  const out = new Map<string, CryptoKey>();
  for (const jwk of data.keys ?? []) {
    const kid = jwk.kid;
    if (typeof kid !== 'string' || !kid) continue;
    try {
      const key = (await importJWK(jwk, 'RS256')) as unknown as CryptoKey;
      out.set(kid, key);
    } catch (err) {
      console.warn(
        `[chat-webhook] importJWK skip kid=${kid}: ${err instanceof Error ? err.message : String(err)}`,
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
      issuer: GOOGLE_CHAT_ISSUERS,
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

/**
 * 実際の Google Chat HTTPS push の payload を `ChatEventPayload` 形式に
 * 正規化する。Workspace Add-on モード (= screenshot で「この Chat アプリを
 * Workspace アドオンとしてビルドします」cb 付き) の payload は Cloud Run
 * `cma_gchat_bot.py:l.3819` の dispatch logic と同じ envelope:
 *
 *   {
 *     "commonEventObject": {...},
 *     "chat": {
 *       "user": {...},
 *       "eventTime": "...",
 *       "messagePayload":     { space, message },   // MESSAGE
 *       "addedToSpacePayload":   { space },           // ADDED_TO_SPACE
 *       "removedFromSpacePayload": { space },          // REMOVED_FROM_SPACE
 *       "buttonClickedPayload": { ... }                // CARD_CLICKED
 *     }
 *   }
 *
 * `type` field は無く、`chat.*Payload` キーの存在で event 種別が決まる。
 * 旧仕様 (= `{ type, message, space }` 直接) も後方互換で accept する
 * (= 主に test fixture / 古い integration 経路用)。返り値が null なら
 * 上位で invalid shape として 400 を返す。
 */
function normalizeChatEventPayload(raw: unknown): ChatEventPayload | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  // Workspace Add-on envelope
  const chat = obj.chat as Record<string, unknown> | undefined;
  if (chat && typeof chat === 'object') {
    const eventTime =
      typeof chat.eventTime === 'string' ? chat.eventTime : undefined;
    const user = chat.user as ChatEventPayload['user'] | undefined;

    const pickSpace = (
      p: unknown,
    ): ChatEventPayload['space'] | undefined => {
      if (p && typeof p === 'object') {
        const sp = (p as Record<string, unknown>).space;
        if (sp && typeof sp === 'object') {
          return sp as ChatEventPayload['space'];
        }
      }
      return undefined;
    };

    if ('messagePayload' in chat) {
      const mp = chat.messagePayload as
        | Record<string, unknown>
        | undefined;
      const message = mp?.message as ChatEventPayload['message'] | undefined;
      const space = pickSpace(mp);
      const result: ChatEventPayload = { type: 'MESSAGE' };
      if (eventTime) result.eventTime = eventTime;
      if (message) result.message = message;
      if (space) result.space = space;
      if (user) result.user = user;
      return result;
    }
    if ('addedToSpacePayload' in chat) {
      const result: ChatEventPayload = { type: 'ADDED_TO_SPACE' };
      if (eventTime) result.eventTime = eventTime;
      const space = pickSpace(chat.addedToSpacePayload);
      if (space) result.space = space;
      if (user) result.user = user;
      return result;
    }
    if ('removedFromSpacePayload' in chat) {
      const result: ChatEventPayload = { type: 'REMOVED_FROM_SPACE' };
      if (eventTime) result.eventTime = eventTime;
      const space = pickSpace(chat.removedFromSpacePayload);
      if (space) result.space = space;
      if (user) result.user = user;
      return result;
    }
    if ('buttonClickedPayload' in chat) {
      const result: ChatEventPayload = { type: 'CARD_CLICKED' };
      if (eventTime) result.eventTime = eventTime;
      if (user) result.user = user;
      return result;
    }
    // chat envelope だが既知 payload キーなし → unknown event、skip
    return { type: 'UNKNOWN_CHAT_EVENT' };
  }

  // 旧仕様 (`{ type, message, space, ... }`) 直接形式
  if (isChatEventPayload(raw)) return raw;
  return null;
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
 *   - 200 OK + `{}`                                  — MESSAGE event 受理 + Queue 投入
 *   - 200 OK + `{}`                                  — 非 MESSAGE event / duplicate
 *   - 401 Unauthorized                                — Authorization header 欠落 / JWT 検証失敗
 *   - 400 Bad Request                                 — malformed JSON
 *   - 500 Internal Server Error                       — Queue 投入失敗 / 公開鍵 fetch 失敗
 *
 * Google Chat は 2xx で ack、4xx/5xx で retry (= Pub/Sub と同様の
 * at-least-once 配送)。dedupe で二重投入を防ぐ。
 *
 * Workspace Add-on mode では `{ ok: true }` のような独自 JSON は
 * DataActions / RenderActions ではないため、Chat UI に「応答がありません」
 * が出る。後続 Queue から Chat API で非同期投稿する場合は、公式どおり
 * 空 JSON `{}` を返す。
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
  const event = normalizeChatEventPayload(parsed);
  if (!event) {
    console.warn(`[chat-webhook] reject invalid-shape cfRay=${cfRay}`);
    return Response.json({ error: 'invalid payload shape' }, { status: 400 });
  }

  // ---- 5. event type filter ----
  if (!isMessageEvent(event)) {
    console.log(
      `[chat-webhook] skip non-message type=${event.type} cfRay=${cfRay}`,
    );
    return Response.json({});
  }

  // ---- 6. dedupe claim ----
  const eventKey = `chat:msgname:${event.message.name}`;
  await recordChatWebhookPayload(env, eventKey, event);
  await recordRuntimeEvent(env, {
    eventKey,
    messageId: event.message.name,
    eventType: 'chat_webhook_received',
    source: 'google-chat-webhook',
    detail: {
      type: event.type,
      space_type: event.space?.type ?? null,
      text_chars: event.message.text?.length ?? 0,
      attachment_count: event.message.attachment?.length ?? 0,
      annotation_count: event.message.annotations?.length ?? 0,
    },
  });
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
    return Response.json({});
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
    await recordRuntimeEvent(env, {
      eventKey,
      messageId: event.message.name,
      eventType: 'chat_queue_enqueued',
      source: 'google-chat-webhook',
      detail: { claim_state: claim.state, claim_version: claim.version },
    });
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
    await recordRuntimeEvent(env, {
      eventKey,
      messageId: event.message.name,
      eventType: 'chat_queue_enqueue_failed',
      level: 'error',
      source: 'google-chat-webhook',
      detail: { error: err instanceof Error ? err.message : String(err) },
    });
    return Response.json({ error: 'queue send failed' }, { status: 500 });
  }

  console.log(
    `[chat-webhook] enqueued eventKey=${eventKey} sender=${event.message.sender?.name ?? ''} cfRay=${cfRay}`,
  );
  return Response.json({});
}
