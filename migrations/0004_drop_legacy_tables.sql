-- Drop tables from the pre-v4 self-hosted-sandbox era.
--
-- v4 (Phase 2 cloud-env-only) removes the dashboard / sandbox / agent
-- routing surface. The matching D1 tables are no longer written to and
-- their data is dead. This migration drops them so they stop appearing
-- in `wrangler d1 list-tables` and storage usage reports.
--
-- Apply timing: Phase 9 cutover (run alongside `wrangler deploy` so the
-- worker code that referenced these tables is already gone in
-- production). Applying earlier is harmless — the v4 worker code does
-- not reference any of these tables — but coupling the apply to cutover
-- keeps the rollback path simple (revert worker code AND skip apply).
--
-- Tables retained by v4: sent_messages, email_threads (0001), dedupe,
-- user_mapping_audit, oauth_audit (0002), agentmail_webhook_seen (0003).

DROP TABLE IF EXISTS webhook_events;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS agent_backends;
DROP TABLE IF EXISTS inbox;
DROP TABLE IF EXISTS agent_emails;
