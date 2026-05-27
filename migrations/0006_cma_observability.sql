-- ============================================================================
-- Issue #202 — Cloudflare CMA observability.
--
-- Lets operators resolve Google Chat thread -> Anthropic session id from D1,
-- and temporarily inspect the exact user.message payload sent by the Worker
-- to Anthropic. Raw email / space / thread names are not stored; lookup uses
-- the same short SHA-256 hash as the local observation CLI.
-- ============================================================================

CREATE TABLE IF NOT EXISTS cma_session_binds (
    id                TEXT PRIMARY KEY,
    created_at_ms     INTEGER NOT NULL,
    session_key_hash  TEXT,
    session_id        TEXT NOT NULL,
    event_key         TEXT NOT NULL,
    message_id        TEXT,
    user_slug         TEXT,
    space_name_hash   TEXT,
    thread_name_hash  TEXT,
    is_new_session    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cma_session_binds_key
    ON cma_session_binds (session_key_hash, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_session_binds_session
    ON cma_session_binds (session_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_session_binds_event
    ON cma_session_binds (event_key, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS cma_session_payload_audit (
    id                TEXT PRIMARY KEY,
    created_at_ms     INTEGER NOT NULL,
    expire_at_ms      INTEGER NOT NULL,
    session_id        TEXT NOT NULL,
    event_key         TEXT NOT NULL,
    message_id        TEXT,
    user_slug         TEXT,
    session_key_hash  TEXT,
    payload_json      TEXT NOT NULL,
    payload_chars     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cma_payload_audit_session
    ON cma_session_payload_audit (session_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_payload_audit_event
    ON cma_session_payload_audit (event_key, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_payload_audit_expire
    ON cma_session_payload_audit (expire_at_ms);
