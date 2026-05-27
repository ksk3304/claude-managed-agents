import { redactPiiInText } from '../redact/pii';

const AUDIT_PREFIX = 'cma_payload_audit';
const DEFAULT_TTL_DAYS = 7;
const DEFAULT_MAX_TEXT_CHARS = 12_000;
const SECONDS_PER_DAY = 24 * 60 * 60;

const TOKEN_LIKE_RE =
  /(sk-ant-[A-Za-z0-9_-]{16,}|ya29\.[A-Za-z0-9_-]{16,}|whsec_[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,})/gi;
const CHAT_THREAD_RE = /spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_-]+/g;
const CHAT_MESSAGE_RE = /spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.:-]+/g;
const CHAT_SPACE_RE = /spaces\/[A-Za-z0-9_-]+/g;

export interface PayloadAuditConfig {
  kv?: KVNamespace;
  enabled?: string;
  ttlDays?: string;
  maxTextChars?: string;
  mode: string;
  context?: Record<string, unknown>;
}

interface PayloadAuditRecord {
  session_id: string;
  mode: string;
  events: Array<Record<string, unknown>>;
  context: Record<string, unknown>;
  created_at_iso: string;
  expire_at_iso: string;
  ttl_days: number;
}

export async function saveUserMessagePayloadAudit(
  sessionId: string,
  events: Array<Record<string, unknown>>,
  config?: PayloadAuditConfig,
): Promise<boolean> {
  if (!config?.kv || !isEnabled(config.enabled)) return false;
  const ttlDays = parsePositiveInt(config.ttlDays, DEFAULT_TTL_DAYS);
  const maxTextChars = parsePositiveInt(
    config.maxTextChars,
    DEFAULT_MAX_TEXT_CHARS,
  );
  const now = new Date();
  const expireAt = new Date(now.getTime() + ttlDays * SECONDS_PER_DAY * 1000);
  const record: PayloadAuditRecord = {
    session_id: sessionId,
    mode: config.mode,
    events: redactForAudit(events, maxTextChars) as Array<Record<string, unknown>>,
    context: redactForAudit(config.context ?? {}, maxTextChars) as Record<string, unknown>,
    created_at_iso: now.toISOString(),
    expire_at_iso: expireAt.toISOString(),
    ttl_days: ttlDays,
  };
  const key = `${AUDIT_PREFIX}:${sessionId}:${now.toISOString()}:${crypto.randomUUID().slice(0, 8)}`;
  try {
    await config.kv.put(key, JSON.stringify(record), {
      expirationTtl: ttlDays * SECONDS_PER_DAY,
    });
    return true;
  } catch (err) {
    console.warn(
      `[payload-audit] save failed session=${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

function isEnabled(raw: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function redactForAudit(value: unknown, maxTextChars: number): unknown {
  if (typeof value === 'string') {
    return truncate(redactText(value), maxTextChars);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactForAudit(v, maxTextChars));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactForAudit(v, maxTextChars);
    }
    return out;
  }
  return value;
}

function redactText(text: string): string {
  return redactPiiInText(text)
    .replace(TOKEN_LIKE_RE, '[REDACTED_TOKEN]')
    .replace(CHAT_THREAD_RE, 'spaces/[REDACTED_SPACE]/threads/[REDACTED_THREAD]')
    .replace(CHAT_MESSAGE_RE, 'spaces/[REDACTED_SPACE]/messages/[REDACTED_MESSAGE]')
    .replace(CHAT_SPACE_RE, 'spaces/[REDACTED_SPACE]');
}

function truncate(text: string, maxTextChars: number): string {
  if (text.length <= maxTextChars) return text;
  return `${text.slice(0, maxTextChars)}...[truncated ${text.length - maxTextChars} chars]`;
}
