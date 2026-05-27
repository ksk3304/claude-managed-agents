/**
 * Cloudflare-side CMA observability helpers.
 *
 * Issue #202: let operators resolve Google Chat thread -> Anthropic
 * session, inspect Worker logs, and read the exact user.message payload
 * the Worker sent to Anthropic without exposing raw PII or secrets.
 */

export const SESSION_BIND_TABLE = 'cma_session_binds';
export const PAYLOAD_AUDIT_TABLE = 'cma_session_payload_audit';

const DEFAULT_AUDIT_TTL_DAYS = 7;
const DEFAULT_MAX_PAYLOAD_CHARS = 12_000;

const TOKEN_LIKE_RE =
  /(sk-ant-[A-Za-z0-9_-]{16,}|ya29\.[A-Za-z0-9_-]{16,}|whsec_[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,})/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CHAT_THREAD_RE = /spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_-]+/g;
const CHAT_MESSAGE_RE = /spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.:-]+/g;
const CHAT_SPACE_RE = /spaces\/[A-Za-z0-9_-]+/g;

export interface SessionBindInput {
  db: D1Database;
  senderEmail: string;
  spaceName: string;
  threadName: string | null | undefined;
  sessionId: string;
  eventKey: string;
  messageId?: string | null;
  userSlug?: string | null;
  isNewSession: boolean;
}

export interface PayloadAuditInput {
  db: D1Database;
  enabledFlag?: string | null;
  ttlDays?: string | number | null;
  maxPayloadChars?: string | number | null;
  sessionId: string;
  eventKey: string;
  messageId?: string | null;
  userSlug?: string | null;
  sessionKeyHash?: string | null;
  payload: unknown;
}

export function auditEnabled(raw: string | null | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());
}

export async function sessionKeyHash(
  senderEmail: string,
  spaceName: string,
  threadName: string | null | undefined,
): Promise<string | null> {
  const email = (senderEmail || '').trim().toLowerCase();
  const space = (spaceName || '').trim();
  const thread = (threadName || '').trim();
  if (!email || !space || !thread) return null;
  return (await sha256Hex(`${email}#${space}#${thread}`)).slice(0, 12);
}

export async function resourceHash(value: string | null | undefined): Promise<string | null> {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  return (await sha256Hex(raw)).slice(0, 12);
}

export function redactForAudit(value: unknown, maxChars = DEFAULT_MAX_PAYLOAD_CHARS): unknown {
  if (typeof value === 'string') {
    const redacted = redactText(value);
    if (redacted.length > maxChars) {
      return `${redacted.slice(0, maxChars)}...[truncated ${redacted.length - maxChars} chars]`;
    }
    return redacted;
  }
  if (Array.isArray(value)) return value.map((v) => redactForAudit(v, maxChars));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactForAudit(v, maxChars);
    }
    return out;
  }
  return value;
}

export async function recordSessionBind(input: SessionBindInput): Promise<string | null> {
  const keyHash = await sessionKeyHash(input.senderEmail, input.spaceName, input.threadName);
  const spaceHash = await resourceHash(input.spaceName);
  const threadHash = await resourceHash(input.threadName ?? '');
  const now = Date.now();
  const id = `bind_${now}_${crypto.randomUUID()}`;
  try {
    await input.db
      .prepare(
        `INSERT INTO cma_session_binds
         (id, created_at_ms, session_key_hash, session_id, event_key, message_id,
          user_slug, space_name_hash, thread_name_hash, is_new_session)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(
        id,
        now,
        keyHash,
        input.sessionId,
        input.eventKey,
        input.messageId ?? null,
        input.userSlug ?? null,
        spaceHash,
        threadHash,
        input.isNewSession ? 1 : 0,
      )
      .run();
  } catch (err) {
    console.warn(
      JSON.stringify({
        event_type: 'cma_session_bind_save_failed',
        level: 'WARN',
        event_key: input.eventKey,
        session_id: input.sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  console.log(
    JSON.stringify({
      event_type: 'cma_session_bind',
      runtime: 'cloudflare',
      event_key: input.eventKey,
      message_id: input.messageId ?? null,
      session_id: input.sessionId,
      session_key_hash: keyHash,
      user_slug: input.userSlug ?? null,
      space_name_hash: spaceHash,
      thread_name_hash: threadHash,
      is_new_session: input.isNewSession,
    }),
  );
  return keyHash;
}

export async function savePayloadAudit(input: PayloadAuditInput): Promise<boolean> {
  if (!auditEnabled(input.enabledFlag)) return false;
  const ttlDays = positiveInt(input.ttlDays, DEFAULT_AUDIT_TTL_DAYS);
  const maxChars = positiveInt(input.maxPayloadChars, DEFAULT_MAX_PAYLOAD_CHARS);
  const redacted = redactForAudit(input.payload, maxChars);
  const payloadJson = JSON.stringify(redacted);
  const now = Date.now();
  const id = `payload_${now}_${crypto.randomUUID()}`;
  try {
    await input.db
      .prepare(
        `INSERT INTO cma_session_payload_audit
         (id, created_at_ms, expire_at_ms, session_id, event_key, message_id,
          user_slug, session_key_hash, payload_json, payload_chars)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(
        id,
        now,
        now + ttlDays * 24 * 60 * 60 * 1000,
        input.sessionId,
        input.eventKey,
        input.messageId ?? null,
        input.userSlug ?? null,
        input.sessionKeyHash ?? null,
        payloadJson,
        payloadJson.length,
      )
      .run();
    console.log(
      JSON.stringify({
        event_type: 'cma_payload_audit_saved',
        runtime: 'cloudflare',
        event_key: input.eventKey,
        session_id: input.sessionId,
        payload_chars: payloadJson.length,
      }),
    );
    return true;
  } catch (err) {
    console.warn(
      JSON.stringify({
        event_type: 'cma_payload_audit_save_failed',
        level: 'WARN',
        event_key: input.eventKey,
        session_id: input.sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}

function redactText(text: string): string {
  return text
    .replace(TOKEN_LIKE_RE, '[REDACTED_TOKEN]')
    .replace(EMAIL_RE, '[REDACTED_EMAIL]')
    .replace(CHAT_THREAD_RE, 'spaces/[REDACTED_SPACE]/threads/[REDACTED_THREAD]')
    .replace(CHAT_MESSAGE_RE, 'spaces/[REDACTED_SPACE]/messages/[REDACTED_MESSAGE]')
    .replace(CHAT_SPACE_RE, 'spaces/[REDACTED_SPACE]');
}

function positiveInt(raw: string | number | null | undefined, fallback: number): number {
  const n =
    typeof raw === 'number'
      ? raw
      : Number.parseInt((raw ?? '').toString().trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
