-- ============================================================================
-- MAKOTO Phase 2 — AgentMail webhook transport-level dedupe.
--
-- This table answers the question "has this svix delivery id been seen
-- before?" at the webhook-handler edge, so the handler can fast-path
-- 200 without enqueueing duplicate work. It is intentionally separate
-- from `dedupe` (application-level RFC 822 fence): the transport key is
-- the svix delivery id, which can be replayed by AgentMail/svix even
-- when the underlying RFC 822 message has already been processed (e.g.
-- our 200 response was dropped on the wire).
--
-- Keeping the two dedupe paths in separate tables avoids muddling the
-- claim/lease state machine in `dedupe` (which is sized for one
-- claim/owner/version per logical work unit) with a high-volume seen-set
-- whose only operation is INSERT-OR-IGNORE.
--
-- Rows are kept for 30 days (matches `dedupe.ttl_expires_at_ms`) and
-- pruned by the same daily cron handler.
--
-- Issue: ksk3304/makoto-prime#186 (Phase 6 step 7 — 層 5)
-- ============================================================================

CREATE TABLE IF NOT EXISTS agentmail_webhook_seen (
    svix_id            TEXT PRIMARY KEY,
    received_at_ms     INTEGER NOT NULL,
    ttl_expires_at_ms  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agentmail_webhook_seen_ttl
    ON agentmail_webhook_seen (ttl_expires_at_ms);
