// D1-backed storage for the AgentMail bridge layer.
//
// v4 (Phase 2 cloud-env-only) trims this module to the minimum the
// bridge needs: outbound message tracking for In-Reply-To threading,
// AgentMail svix transport-level dedupe, and a small cron prune.
//
// Earlier v3 functions for self-hosted sandbox sessions, webhook
// event mirroring, agent backend routing, and per-agent alias
// provisioning have been removed. The matching D1 tables
// (`webhook_events` / `sessions` / `inbox` / `agent_backends` /
// `agent_emails`) are scheduled for `migrations/0004_drop_legacy_tables.sql`
// to be applied during Phase 9 cutover.

// ---------------------------------------------------------------------------
// Outbound message tracking — supports In-Reply-To threading.
// ---------------------------------------------------------------------------

import { normalizeMessageId } from './lib/email-thread';

function normalizeLikelyRfc822MessageId(raw: string | undefined): string {
  if (!raw) return '';
  const normalized = normalizeMessageId(raw);
  if (!normalized.includes('@')) return '';
  if (/\s/.test(normalized)) return '';
  return normalized;
}

export async function recordSentMessage(
  db: D1Database,
  messageId: string,
  sessionId: string,
  agentId: string,
  toAddr: string,
  rfc822MessageId?: string,
  autoReplyPolicy: string = 'unknown',
): Promise<void> {
  // `rfc822_msgid` is optional so AgentMail bridge callers pass the
  // normalized RFC 822 Message-ID; inbound In-Reply-To / References
  // routing then finds it through `findSessionByRfc822MessageId`.
  const rfc822 =
    normalizeLikelyRfc822MessageId(rfc822MessageId) ||
    normalizeLikelyRfc822MessageId(messageId) ||
    null;
  await db
    .prepare(
      `INSERT OR REPLACE INTO sent_messages
         (message_id, session_id, agent_id, to_addr, sent_at_ms, rfc822_msgid, auto_reply_policy)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(messageId, sessionId, agentId, toAddr, Date.now(), rfc822, autoReplyPolicy)
    .run();
}

// AgentMail bridge path: look up by the RFC 822 Message-ID we put in
// the outbound `Message-ID:` header. Caller is expected to normalize
// the input id (lowercase, strip angle brackets) before passing.
// Returns null when no match.
export async function findSessionByRfc822MessageId(
  db: D1Database,
  rfc822MessageId: string,
): Promise<{ sessionId: string; agentId: string } | null> {
  const row = await db
    .prepare(
      `SELECT session_id, agent_id FROM sent_messages
         WHERE rfc822_msgid = ?`,
    )
    .bind(rfc822MessageId)
    .first<{ session_id: string; agent_id: string }>();
  if (!row) return null;
  return { sessionId: row.session_id, agentId: row.agent_id };
}

// ----------------------------------------------------------------------------
// AgentMail webhook transport-level dedupe.
//
// Records every svix delivery id we've handled. The webhook handler does
// INSERT-OR-IGNORE on first sight, fast-paths 200 on duplicates. Kept
// separate from `dedupe` (application-level RFC 822 fence) — see
// `migrations/0003_agentmail_webhook_seen.sql` rationale.
// ----------------------------------------------------------------------------

const AGENTMAIL_WEBHOOK_SEEN_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Record an AgentMail svix delivery id. Returns `true` on first sight
 * (the caller should enqueue), `false` on duplicate (caller should
 * fast-path 200 without enqueuing).
 *
 * Insert-or-ignore is atomic in D1 so the boolean reflects the actual
 * winner of any parallel webhook deliveries.
 */
export async function markAgentMailWebhookSeen(
  db: D1Database,
  svixId: string,
  now: number = Date.now(),
  retainTtlMs: number = AGENTMAIL_WEBHOOK_SEEN_RETAIN_MS,
): Promise<boolean> {
  const ttlExp = now + retainTtlMs;
  const r = await db
    .prepare(
      `INSERT OR IGNORE INTO agentmail_webhook_seen
         (svix_id, received_at_ms, ttl_expires_at_ms)
       VALUES (?1, ?2, ?3)`,
    )
    .bind(svixId, now, ttlExp)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * Drop rows past `ttl_expires_at_ms`. Called from the daily cron handler
 * alongside `pruneExpiredDedupe`.
 */
export async function pruneExpiredAgentMailWebhookSeen(
  db: D1Database,
  now: number = Date.now(),
): Promise<number> {
  const r = await db
    .prepare(`DELETE FROM agentmail_webhook_seen WHERE ttl_expires_at_ms < ?`)
    .bind(now)
    .run();
  return r.meta?.changes ?? 0;
}

// ---------------------------------------------------------------------------
// Cron-driven pruning (sent_messages only in v4).
//
// `email_threads` is intentionally not pruned — a stale thread mapping
// is cheap to keep and forcing a fresh session for any reply more than
// the cutoff apart breaks the "reply to agent" UX.
// ---------------------------------------------------------------------------

export async function pruneOlderThan(
  db: D1Database,
  cutoffMs: number,
): Promise<{ sentMessages: number }> {
  const sentRes = await db
    .prepare(`DELETE FROM sent_messages WHERE sent_at_ms < ?`)
    .bind(cutoffMs)
    .run();
  return { sentMessages: sentRes.meta?.changes ?? 0 };
}
