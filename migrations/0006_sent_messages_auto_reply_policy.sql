-- ============================================================================
-- Issue #186 Grill Me follow-up — sent_messages auto-reply policy evidence.
--
-- Records whether an outbound AgentMail row was user-requested from Google
-- Chat or generated from AgentMail inbound continuation auto-reply flow.
-- ============================================================================

ALTER TABLE sent_messages
  ADD COLUMN auto_reply_policy TEXT NOT NULL DEFAULT 'unknown';

