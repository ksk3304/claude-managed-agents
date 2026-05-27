-- ============================================================================
-- Issue #202 follow-up — persistent Cloudflare runtime events.
--
-- `wrangler tail` is live-only and sampling/search can miss Queue consumer logs.
-- Store redacted, short-lived runtime breadcrumbs in D1 so operators can read
-- Cloudflare-side evidence after the event has completed.
-- ============================================================================

CREATE TABLE IF NOT EXISTS cma_worker_runtime_events (
    id             TEXT PRIMARY KEY,
    created_at_ms  INTEGER NOT NULL,
    expire_at_ms   INTEGER NOT NULL,
    event_key      TEXT NOT NULL,
    session_id     TEXT,
    message_id     TEXT,
    user_slug      TEXT,
    event_type     TEXT NOT NULL,
    level          TEXT NOT NULL DEFAULT 'INFO',
    source         TEXT,
    detail_json    TEXT,
    detail_chars   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cma_runtime_events_event
    ON cma_worker_runtime_events (event_key, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_runtime_events_session
    ON cma_worker_runtime_events (session_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_runtime_events_type
    ON cma_worker_runtime_events (event_type, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cma_runtime_events_expire
    ON cma_worker_runtime_events (expire_at_ms);
