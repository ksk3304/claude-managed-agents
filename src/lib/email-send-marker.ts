/**
 * EMAIL_SEND marker extraction (STUB).
 *
 * Replaced with the real parser in layer 4 (Task #7). Stub returns
 * an empty array so callers compile cleanly and the bridge silently
 * sends nothing — far safer than the alternative (spurious sends).
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 6 — 層 4 stub)
 */

import type { EmailSendMarker } from '../types/agentmail';

export function parseEmailSendMarkers(_assistantText: string): EmailSendMarker[] {
  // TODO(phase6-layer4): port the Python parser at
  // scripts/cma_lib.py:_handle_email_send_marker. Until then, every
  // assistant turn is treated as "no email to send" — webhook-side
  // commit_done still runs, the agent just doesn't reply by mail.
  return [];
}
