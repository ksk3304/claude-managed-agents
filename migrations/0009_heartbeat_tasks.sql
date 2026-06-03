-- ============================================================================
-- Issue #245 — OpenClaw-style heartbeat tasks.
--
-- Data-driven periodic agent turns. The single cron tick reads due rows from
-- this table and enqueues synthetic Google Chat DM events.
-- ============================================================================

CREATE TABLE IF NOT EXISTS heartbeat_tasks (
    task_id              TEXT PRIMARY KEY,
    owner_user_id        TEXT NOT NULL,
    target_space_name    TEXT,
    kind                 TEXT NOT NULL DEFAULT 'patrol'
                         CHECK (kind IN ('patrol', 'async_wait')),
    prompt               TEXT NOT NULL,
    interval_min         INTEGER NOT NULL CHECK (interval_min > 0),
    active_hours         TEXT,
    target_scope         TEXT NOT NULL DEFAULT 'dm'
                         CHECK (target_scope IN ('dm', 'shared')),
    enabled              INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    last_run_at          INTEGER,

    -- Phase B/C design fields. Phase A only drives kind='patrol'; async_wait
    -- rows can be planned without adding a second scheduler substrate later.
    status               TEXT NOT NULL DEFAULT 'open',
    stage                TEXT,
    waiting_for          TEXT,
    next_check_at        INTEGER,
    last_progress_at     INTEGER,
    attempt_count        INTEGER NOT NULL DEFAULT 0,
    stop_reason          TEXT,
    thread_ref           TEXT,
    user_visible_status  TEXT,

    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_heartbeat_tasks_due
    ON heartbeat_tasks (enabled, kind, last_run_at);

CREATE INDEX IF NOT EXISTS idx_heartbeat_tasks_next_check
    ON heartbeat_tasks (enabled, kind, next_check_at);

CREATE INDEX IF NOT EXISTS idx_heartbeat_tasks_owner
    ON heartbeat_tasks (owner_user_id);
