-- ============================================================================
-- MAKOTO Issue #206 — Google Chat / CMA observability tables.
--
-- Short-lived, redacted operational evidence for correlating:
-- Google Chat webhook -> Queue -> CMA session -> final Chat reply.
-- ============================================================================

CREATE TABLE IF NOT EXISTS cma_chat_webhook_payloads (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at_ms       INTEGER NOT NULL,
    event_key           TEXT NOT NULL,
    message_id          TEXT,
    space_name_hash     TEXT,
    thread_name_hash    TEXT,
    sender_name_hash    TEXT,
    sender_type         TEXT,
    event_type          TEXT,
    space_type          TEXT,
    text_chars          INTEGER NOT NULL DEFAULT 0,
    attachment_count    INTEGER NOT NULL DEFAULT 0,
    annotation_count    INTEGER NOT NULL DEFAULT 0,
    redacted_preview    TEXT
);

ALTER TABLE cma_chat_webhook_payloads ADD COLUMN expire_at_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_cma_chat_webhook_payloads_event
    ON cma_chat_webhook_payloads (event_key, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_chat_webhook_payloads_message
    ON cma_chat_webhook_payloads (message_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_chat_webhook_payloads_thread
    ON cma_chat_webhook_payloads (thread_name_hash, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_chat_webhook_payloads_ttl
    ON cma_chat_webhook_payloads (expire_at_ms);

CREATE TABLE IF NOT EXISTS cma_worker_runtime_events (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at_ms       INTEGER NOT NULL,
    expire_at_ms        INTEGER NOT NULL,
    event_key           TEXT NOT NULL,
    session_id          TEXT,
    message_id          TEXT,
    user_slug           TEXT,
    event_type          TEXT NOT NULL,
    level               TEXT NOT NULL DEFAULT 'info',
    source              TEXT NOT NULL,
    detail_json         TEXT NOT NULL,
    detail_chars        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cma_worker_runtime_events_event
    ON cma_worker_runtime_events (event_key, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_worker_runtime_events_session
    ON cma_worker_runtime_events (session_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_worker_runtime_events_message
    ON cma_worker_runtime_events (message_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_worker_runtime_events_type
    ON cma_worker_runtime_events (event_type, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_worker_runtime_events_ttl
    ON cma_worker_runtime_events (expire_at_ms);

CREATE TABLE IF NOT EXISTS cma_session_binds (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at_ms       INTEGER NOT NULL,
    session_key_hash    TEXT NOT NULL,
    session_id          TEXT NOT NULL,
    event_key           TEXT NOT NULL,
    message_id          TEXT,
    user_slug           TEXT,
    thread_name_hash    TEXT,
    is_new_session      INTEGER NOT NULL DEFAULT 0
);

-- Existing production D1 already has cma_session_binds from earlier #186 work.
-- Add the short-lived retention column without requiring table recreation.
ALTER TABLE cma_session_binds ADD COLUMN expire_at_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_cma_session_binds_key
    ON cma_session_binds (session_key_hash, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_session_binds_session
    ON cma_session_binds (session_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_session_binds_event
    ON cma_session_binds (event_key, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_session_binds_thread
    ON cma_session_binds (thread_name_hash, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_session_binds_ttl
    ON cma_session_binds (expire_at_ms);

CREATE TABLE IF NOT EXISTS cma_session_payload_audit (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at_ms       INTEGER NOT NULL,
    expire_at_ms        INTEGER NOT NULL,
    session_id          TEXT NOT NULL,
    event_key           TEXT,
    message_id          TEXT,
    user_slug           TEXT,
    session_key_hash    TEXT,
    payload_json        TEXT NOT NULL,
    payload_chars       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cma_session_payload_audit_session
    ON cma_session_payload_audit (session_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_session_payload_audit_event
    ON cma_session_payload_audit (event_key, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_session_payload_audit_ttl
    ON cma_session_payload_audit (expire_at_ms);
