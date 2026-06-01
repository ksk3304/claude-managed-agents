-- ============================================================================
-- Issue #212 — /costguard mutation config overlay.
--
-- cost_guard_counters (0007) keeps usage counters. These tables keep operator
-- config, one-shot pending confirmations, and an append-only audit log for
-- deterministic Google Chat /costguard mutation commands.
-- ============================================================================

CREATE TABLE IF NOT EXISTS cost_guard_config (
    id               TEXT PRIMARY KEY,
    enabled          INTEGER,
    paused_until_ms  INTEGER,
    limits_json      TEXT NOT NULL DEFAULT '{}',
    updated_by       TEXT,
    updated_at_ms    INTEGER,
    change_seq       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cost_guard_pending (
    actor_email    TEXT PRIMARY KEY,
    token_hash     TEXT NOT NULL,
    action         TEXT NOT NULL,
    patch_json     TEXT NOT NULL,
    summary        TEXT NOT NULL,
    base_change_seq INTEGER NOT NULL,
    created_at_ms  INTEGER NOT NULL,
    expires_at_ms  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cost_guard_pending_expires
    ON cost_guard_pending (expires_at_ms);

CREATE TABLE IF NOT EXISTS cost_guard_audit (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp_ms    INTEGER NOT NULL,
    actor_email     TEXT NOT NULL,
    action          TEXT NOT NULL,
    old_value_json  TEXT NOT NULL,
    new_value_json  TEXT NOT NULL,
    detail          TEXT
);

CREATE INDEX IF NOT EXISTS idx_cost_guard_audit_ts
    ON cost_guard_audit (timestamp_ms DESC);

CREATE INDEX IF NOT EXISTS idx_cost_guard_audit_actor
    ON cost_guard_audit (actor_email, timestamp_ms DESC);
