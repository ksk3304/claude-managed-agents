-- ============================================================================
-- Issue #251 — TODO secretary daily suggestion contract.
--
-- The notification text is intentionally short, but the chosen task,
-- MAKOTOくん support action, and promised outcome must be retained for
-- same-day follow-up phrases such as "じゃあお願い".
-- ============================================================================

CREATE TABLE IF NOT EXISTS brief_suggestions (
    suggestion_id       TEXT PRIMARY KEY,
    tenant_id           TEXT NOT NULL DEFAULT 'makoto-prime',
    user_slug           TEXT NOT NULL,
    date_label          TEXT NOT NULL,
    job_id              TEXT NOT NULL,
    event_key           TEXT NOT NULL,
    suggestion_rank     INTEGER NOT NULL DEFAULT 1,
    task_key            TEXT NOT NULL,
    task_title          TEXT NOT NULL,
    support_action      TEXT NOT NULL,
    promised_outcome    TEXT NOT NULL,
    urgency_note        TEXT,
    visible_text        TEXT,
    raw_json            TEXT,
    status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'superseded', 'expired')),
    created_at_ms       INTEGER NOT NULL,
    expires_at_ms       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_brief_suggestions_active
    ON brief_suggestions (tenant_id, user_slug, status, expires_at_ms, created_at_ms);

CREATE INDEX IF NOT EXISTS idx_brief_suggestions_event
    ON brief_suggestions (event_key);
