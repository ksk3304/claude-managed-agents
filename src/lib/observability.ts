import type { ChatEventPayload } from '../webhooks/google-chat';

const RUNTIME_TTL_DAYS = 14;
const PAYLOAD_AUDIT_TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const PREVIEW_CHARS = 300;
const DETAIL_CHARS = 12_000;

const TOKEN_RE =
  /(sk-ant-[A-Za-z0-9_-]{16,}|ya29\.[A-Za-z0-9_-]{16,}|whsec_[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,})/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CHAT_THREAD_RE = /spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_-]+/g;
const CHAT_MESSAGE_RE = /spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.:-]+/g;
const CHAT_SPACE_RE = /spaces\/[A-Za-z0-9_-]+/g;

export interface RuntimeEventInput {
  eventKey: string;
  sessionId?: string | null;
  messageId?: string | null;
  userSlug?: string | null;
  eventType: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  detail?: unknown;
}

export interface SessionBindInput {
  senderEmail: string;
  spaceName: string;
  threadName: string | null;
  sessionId: string;
  eventKey: string;
  messageId?: string | null;
  userSlug?: string | null;
  isNewSession: boolean;
}

export interface PayloadAuditInput {
  sessionId: string;
  eventKey?: string | null;
  messageId?: string | null;
  userSlug?: string | null;
  sessionKeyHash?: string | null;
  payload: unknown;
}

export function stableHash(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  const digest = simpleSha256Hex(text);
  return digest.slice(0, 12);
}

export function sessionKeyHash(
  senderEmail: string,
  spaceName: string,
  threadName: string | null | undefined,
): string {
  return simpleSha256Hex(`${senderEmail}#${spaceName}#${threadName ?? ''}`).slice(0, 12);
}

export function redactForObservability(value: unknown, limit = DETAIL_CHARS): unknown {
  if (typeof value === 'string') return truncate(redactText(value), limit);
  if (Array.isArray(value)) return value.map((item) => redactForObservability(item, limit));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactForObservability(child, limit);
    }
    return out;
  }
  return value;
}

export async function recordChatWebhookPayload(
  env: Env,
  eventKey: string,
  event: ChatEventPayload,
): Promise<void> {
  const now = Date.now();
  const message = event.message;
  const space = event.space;
  const sender = message?.sender;
  const rawText = message?.text ?? '';
  const redactedPreview = truncate(redactText(rawText), PREVIEW_CHARS);
  await bestEffort('chat_webhook_payload', async () => {
    await env.DB.prepare(
      `INSERT INTO cma_chat_webhook_payloads
       (created_at_ms, expire_at_ms, event_key, message_id, space_name_hash,
        thread_name_hash, sender_name_hash, sender_type, event_type, space_type,
        text_chars, attachment_count, annotation_count, redacted_preview)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    )
      .bind(
        now,
        now + RUNTIME_TTL_DAYS * DAY_MS,
        eventKey,
        message?.name ?? null,
        stableHash(space?.name),
        stableHash(message?.thread?.name),
        stableHash(sender?.name),
        (sender as { type?: string } | undefined)?.type ?? null,
        event.type ?? null,
        space?.type ?? null,
        rawText.length,
        message?.attachment?.length ?? 0,
        message?.annotations?.length ?? 0,
        redactedPreview,
      )
      .run();
  });
}

export async function recordRuntimeEvent(env: Env, input: RuntimeEventInput): Promise<void> {
  const now = Date.now();
  const detail = redactForObservability(input.detail ?? {});
  const detailJsonRaw = JSON.stringify(detail);
  const detailJson = boundedJson(detailJsonRaw, DETAIL_CHARS);
  await bestEffort(`runtime_event:${input.eventType}`, async () => {
    await env.DB.prepare(
      `INSERT INTO cma_worker_runtime_events
       (created_at_ms, expire_at_ms, event_key, session_id, message_id,
        user_slug, event_type, level, source, detail_json, detail_chars)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
      .bind(
        now,
        now + RUNTIME_TTL_DAYS * DAY_MS,
        input.eventKey,
        input.sessionId ?? null,
        input.messageId ?? null,
        input.userSlug ?? null,
        input.eventType,
        input.level ?? 'info',
        input.source,
        detailJson,
        detailJsonRaw.length,
      )
      .run();
  });
}

export async function recordSessionBind(env: Env, input: SessionBindInput): Promise<void> {
  const now = Date.now();
  const keyHash = sessionKeyHash(input.senderEmail, input.spaceName, input.threadName);
  await bestEffort('session_bind', async () => {
    await env.DB.prepare(
      `INSERT INTO cma_session_binds
       (created_at_ms, expire_at_ms, session_key_hash, session_id, event_key,
        message_id, user_slug, thread_name_hash, is_new_session)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        now,
        now + RUNTIME_TTL_DAYS * DAY_MS,
        keyHash,
        input.sessionId,
        input.eventKey,
        input.messageId ?? null,
        input.userSlug ?? null,
        stableHash(input.threadName),
        input.isNewSession ? 1 : 0,
      )
      .run();
  });
}

export async function recordPayloadAudit(env: Env, input: PayloadAuditInput): Promise<boolean> {
  const enabled = String(env.CMA_AUDIT_USER_MESSAGE_PAYLOADS ?? '').trim().toLowerCase();
  if (!['1', 'true', 'yes', 'on'].includes(enabled)) return false;
  const now = Date.now();
  const payload = redactForObservability(input.payload);
  const payloadJsonRaw = JSON.stringify(payload);
  const payloadJson = boundedJson(payloadJsonRaw, DETAIL_CHARS);
  let saved = false;
  await bestEffort('payload_audit', async () => {
    await env.DB.prepare(
      `INSERT INTO cma_session_payload_audit
       (created_at_ms, expire_at_ms, session_id, event_key, message_id,
        user_slug, session_key_hash, payload_json, payload_chars)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        now,
        now + PAYLOAD_AUDIT_TTL_DAYS * DAY_MS,
        input.sessionId,
        input.eventKey ?? null,
        input.messageId ?? null,
        input.userSlug ?? null,
        input.sessionKeyHash ?? null,
        payloadJson,
        payloadJsonRaw.length,
      )
      .run();
    saved = true;
  });
  return saved;
}

export async function pruneObservability(env: Env, now = Date.now()): Promise<{
  webhookPayloads: number;
  runtimeEvents: number;
  sessionBinds: number;
  payloadAudit: number;
}> {
  const webhookPayloads = await deleteExpired(env.DB, 'cma_chat_webhook_payloads', now);
  const runtimeEvents = await deleteExpired(env.DB, 'cma_worker_runtime_events', now);
  const sessionBinds = await deleteExpired(env.DB, 'cma_session_binds', now);
  const payloadAudit = await deleteExpired(env.DB, 'cma_session_payload_audit', now);
  return { webhookPayloads, runtimeEvents, sessionBinds, payloadAudit };
}

async function deleteExpired(db: D1Database, table: string, now: number): Promise<number> {
  const result = await db.prepare(`DELETE FROM ${table} WHERE expire_at_ms < ?`).bind(now).run();
  return Number(result.meta?.changes ?? 0);
}

async function bestEffort(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(
      `[observability] ${label} save failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function redactText(text: string): string {
  return text
    .replace(TOKEN_RE, '[REDACTED_TOKEN]')
    .replace(EMAIL_RE, '[REDACTED_EMAIL]')
    .replace(CHAT_THREAD_RE, 'spaces/[REDACTED_SPACE]/threads/[REDACTED_THREAD]')
    .replace(CHAT_MESSAGE_RE, 'spaces/[REDACTED_SPACE]/messages/[REDACTED_MESSAGE]')
    .replace(CHAT_SPACE_RE, 'spaces/[REDACTED_SPACE]');
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]`;
}

function boundedJson(jsonText: string, limit: number): string {
  if (jsonText.length <= limit) return jsonText;
  return JSON.stringify({
    truncated: true,
    original_chars: jsonText.length,
    preview: truncate(jsonText, limit - 200),
  });
}

// Small SHA-256 implementation to avoid async WebCrypto at call sites.
function simpleSha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    words[i >> 2] = (words[i >> 2] ?? 0) | (bytes[i]! << (24 - (i % 4) * 8));
  }
  const bitLen = bytes.length * 8;
  words[bitLen >> 5] = (words[bitLen >> 5] ?? 0) | (0x80 << (24 - (bitLen % 32)));
  words[(((bitLen + 64) >> 9) << 4) + 15] = bitLen;
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < words.length; i += 16) {
    const w = new Array<number>(64);
    for (let t = 0; t < 16; t += 1) w[t] = words[i + t] ?? 0;
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15]!, 7) ^ rotr(w[t - 15]!, 18) ^ (w[t - 15]! >>> 3);
      const s1 = rotr(w[t - 2]!, 17) ^ rotr(w[t - 2]!, 19) ^ (w[t - 2]! >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + k[t]! + w[t]!) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((h) => (h >>> 0).toString(16).padStart(8, '0'))
    .join('');
}
