-- ============================================================================
-- MAKOTO Phase 2 — R-Mail bridge layer (AgentMail webhook → CMA session →
-- AgentMail reply) schema extension. Layered on top of 0001_init.sql.
--
-- AgentMail is a 3rd-party email provider (svix webhooks for inbound,
-- HTTPS REST for outbound) that the MAKOTO control plane talks to instead
-- of the Cloudflare Email Routing path implemented in 0001. The existing
-- `sent_messages` / `email_threads` / `agent_emails` tables are reused for
-- routing, but they need extra columns for the AgentMail-specific RFC 822
-- Message-ID space, so this migration ALTERs them in place. Three new
-- tables (`dedupe`, `user_mapping_audit`, `oauth_audit`) cover the
-- bridge-specific concerns (per-message claim fence, sender→agent mapping
-- audit, Google Workspace OAuth audit).
--
-- Issue: ksk3304/makoto-prime#186
-- Parent: ksk3304/makoto-prime#177
-- ============================================================================

-- ----------------------------------------------------------------------------
-- sent_messages: add AgentMail RFC 822 Message-ID column.
--
-- `rfc822_msgid` is the canonical Message-ID that AgentMail's REST API
-- returns for an outbound message — the value the counterparty's mail
-- client puts in In-Reply-To / References when they reply. The existing
-- `message_id` PK stays as the cf_email_send-issued id (legacy Cloudflare
-- Email Routing path); rfc822_msgid is the *AgentMail* path's secondary
-- index. Inbound RFC 822 chain matching (`References` / `In-Reply-To` →
-- session_id) joins through this column.
-- ----------------------------------------------------------------------------
ALTER TABLE sent_messages ADD COLUMN rfc822_msgid TEXT;
CREATE INDEX IF NOT EXISTS idx_sent_messages_rfc822 ON sent_messages (rfc822_msgid);

-- ----------------------------------------------------------------------------
-- dedupe: per-event claim/lease/commit fence for the AgentMail bridge.
--
-- Webhook handlers and Queue consumers race on the same `event_key`
-- (`agentmail:event:<svix-id>` for transport-level dedupe, `mail:msgid:
-- <rfc822>` for application-level dedupe). To avoid double-reply when a
-- lease expires mid-flight and a second worker takes over, the table
-- carries an `owner` + `version` fence:
--
--   1. DONE_DUPLICATE: committed_at_ms IS NOT NULL → skip (already replied)
--   2. NEW:            INSERT OR IGNORE — first worker wins claim
--   3. TAKEOVER:       UPDATE … WHERE committed_at_ms IS NULL
--                                  AND lease_expires_at_ms < NOW
--                       — successor bumps lease_version, becomes new owner
--   4. LEASE_ALIVE:    none of the above hit → another worker is processing
--
-- commit_done must match owner + version, and AgentMail.send is gated on
-- a re-check of owner/version immediately before send, so a stale owner
-- whose lease just expired cannot post a duplicate reply.
--
-- ttl_expires_at_ms is set ~30 days out so the dedupe row survives long
-- enough to catch genuine resends; the cron handler prunes after that.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dedupe (
    event_key            TEXT PRIMARY KEY,
    claim_state          TEXT NOT NULL,
    claim_owner          TEXT NOT NULL,
    lease_version        INTEGER NOT NULL DEFAULT 1,
    lease_expires_at_ms  INTEGER NOT NULL,
    committed_at_ms      INTEGER,
    created_at_ms        INTEGER NOT NULL,
    ttl_expires_at_ms    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dedupe_ttl ON dedupe (ttl_expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_dedupe_lease ON dedupe (lease_expires_at_ms)
    WHERE committed_at_ms IS NULL;

-- ----------------------------------------------------------------------------
-- user_mapping_audit: append-only log of sender_email → user_slug →
-- agent_id mapping events. The live mapping lives in KV
-- (`user_mapping:<email>`) and is written by the parent #177 copy_agent
-- CLI; this table records every registration / re-registration so we can
-- explain "which agent answered this sender" after the fact.
--
-- `event_type` is one of 'register' / 're-register' / 'remove'.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_mapping_audit (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    email             TEXT NOT NULL,
    user_slug         TEXT NOT NULL,
    agent_id          TEXT NOT NULL,
    event_type        TEXT NOT NULL,
    registered_at_ms  INTEGER NOT NULL,
    notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_mapping_audit_email
    ON user_mapping_audit (email, registered_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_user_mapping_audit_slug
    ON user_mapping_audit (user_slug, registered_at_ms DESC);

-- ----------------------------------------------------------------------------
-- oauth_audit: per-call audit log for Google Workspace OAuth operations.
--
-- The bridge stores per-user refresh_tokens encrypted in Cloudflare KV
-- (key `vault:oauth:<user_slug>:refresh_token`) and exchanges them for
-- short-lived access_tokens via Google's token endpoint. Every get /
-- refresh / revoke / decrypt-failure / cross-user-attempt is recorded
-- here, keyed by user_slug so we can both audit "who fetched user X's
-- token" and detect cross-user leak attempts (constructor-arg user_slug
-- mismatch against the AAD baked into the ciphertext).
--
-- `action` is one of:
--   'get_refresh'      — read encrypted refresh_token from KV
--   'refresh'          — exchanged refresh_token for new access_token
--   'rotate'           — Google returned a new refresh_token, replaced it
--   'revoke'           — called oauth2.googleapis.com/revoke + KV delete
--   'fail_decrypt'     — AES-GCM decrypt failed (corrupt ciphertext)
--   'fail_cross_user'  — caller's user_slug did not match AAD
--   'bootstrap'        — initial Cloud-Run-Secret-Manager → CF KV migration
--
-- `outcome` is 'success' or 'fail:<reason>'.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_audit (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp_ms       INTEGER NOT NULL,
    user_slug          TEXT NOT NULL,
    caller_session_id  TEXT,
    action             TEXT NOT NULL,
    outcome            TEXT NOT NULL,
    notes              TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_audit_user
    ON oauth_audit (user_slug, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_oauth_audit_action
    ON oauth_audit (action, timestamp_ms DESC);
