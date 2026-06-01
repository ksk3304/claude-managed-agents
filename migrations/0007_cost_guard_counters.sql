-- ============================================================================
-- Issue #191 — Cost Guard D1 counter foundation.
--
-- KV remains the availability fallback, but D1 is the authoritative
-- Cloudflare-persistent counter store when available. Rows are bucketed by
-- counter kind and UTC day/month, matching the existing Worker implementation.
-- ============================================================================

CREATE TABLE IF NOT EXISTS cost_guard_counters (
    kind           TEXT NOT NULL,
    bucket         TEXT NOT NULL,
    value          REAL NOT NULL DEFAULT 0,
    updated_at_ms  INTEGER NOT NULL,
    expire_at_ms   INTEGER NOT NULL,
    PRIMARY KEY (kind, bucket)
);

CREATE INDEX IF NOT EXISTS idx_cost_guard_counters_ttl
    ON cost_guard_counters (expire_at_ms);

CREATE INDEX IF NOT EXISTS idx_cost_guard_counters_kind
    ON cost_guard_counters (kind, updated_at_ms DESC);
