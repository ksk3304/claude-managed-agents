/**
 * EMAIL_SEND marker extraction — TS port of
 * `scripts/cma_gchat_bot.py:_handle_email_send_marker` (line 735-).
 *
 * The agent emits EMAIL_SEND markers as a single line of the form:
 *
 *   EMAIL_SEND:{"to":"…","subject":"…","body":"…","cc":…,"bcc":…}
 *
 * - Body must be one-line JSON (regex `[^\n]+` enforces this).
 * - `to` is a SINGLE string per Python "Round 3 O3" contract; arrays
 *   are rejected.
 * - `cc` / `bcc` may be string OR list; we normalize to `string[]`.
 *
 * This module returns the parsed markers + the assistant text minus
 * the marker lines. BCC redaction in the surrounding human-facing
 * prefix and the "✅ メール送信完了 …" summary belong in the layer 7
 * dispatcher (where the AgentMail call site sits), not here.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 6 — 層 4)
 * Spec: plan-draft.md §10 EMAIL_SEND + cma_gchat_bot.py:725-810
 */

import type { EmailSendMarker } from '../types/agentmail';

const EMAIL_SEND_MARKER_RE = /EMAIL_SEND:(\{[^\n]+\})/g;

export interface ParseResult {
  /** All markers successfully parsed, in source order. */
  markers: EmailSendMarker[];
  /**
   * Failures: marker text was present but JSON parse / shape check
   * failed. Carried separately so the dispatcher can audit-log them
   * (the agent emitted something but we can't act on it).
   */
  failures: ParseFailure[];
  /**
   * `assistantText` with every marker substring removed. Leading /
   * trailing whitespace on the boundary is trimmed so a "prefix\n\n"
   * + marker collapse cleanly.
   */
  cleanedText: string;
}

export interface ParseFailure {
  /** Raw marker text the agent emitted (including the prefix). */
  raw: string;
  reason: string;
}

/**
 * Extract every EMAIL_SEND marker from one assistant text block.
 *
 * Replacement of the stub from layer 3 (commit f900691) — same
 * function signature so importers don't need to change.
 */
export function parseEmailSendMarkers(assistantText: string): EmailSendMarker[] {
  return parseAssistantText(assistantText).markers;
}

/**
 * Full result variant — gives the dispatcher both the successes and
 * the failures plus the cleaned text body. Prefer this in the queue
 * consumer where we want to audit and strip in one pass.
 */
export function parseAssistantText(assistantText: string): ParseResult {
  const markers: EmailSendMarker[] = [];
  const failures: ParseFailure[] = [];
  let cleanedText = assistantText;
  // We walk the matches with a fresh RegExp instance per call so the
  // module-level `g`-flagged regex's lastIndex state doesn't leak
  // across calls.
  const localRe = new RegExp(EMAIL_SEND_MARKER_RE.source, EMAIL_SEND_MARKER_RE.flags);
  for (const match of assistantText.matchAll(localRe)) {
    const rawJson = match[1];
    if (!rawJson) continue;
    try {
      const parsed = parseOne(rawJson);
      markers.push(parsed);
    } catch (err) {
      failures.push({
        raw: match[0]!,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cleanedText = assistantText.replace(localRe, '').replace(/\n{3,}/g, '\n\n').trim();
  return { markers, failures, cleanedText };
}

function parseOne(rawJson: string): EmailSendMarker {
  let data: unknown;
  try {
    data = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`EMAIL_SEND JSON parse: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`EMAIL_SEND payload must be a JSON object, got ${typeof data}`);
  }
  const obj = data as Record<string, unknown>;

  const to = obj.to;
  if (typeof to !== 'string' || to.trim().length === 0) {
    throw new Error(`EMAIL_SEND.to must be a non-empty string (got ${describe(to)})`);
  }

  const subject = obj.subject;
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new Error(`EMAIL_SEND.subject must be a non-empty string (got ${describe(subject)})`);
  }

  const body = obj.body;
  if (typeof body !== 'string') {
    throw new Error(`EMAIL_SEND.body must be a string (got ${describe(body)})`);
  }

  const marker: EmailSendMarker = { to: to.trim(), subject, body };

  const cc = normalizeAddresses(obj.cc);
  if (cc.length > 0) marker.cc = cc;
  const bcc = normalizeAddresses(obj.bcc);
  if (bcc.length > 0) marker.bcc = bcc;

  if (typeof obj.in_reply_to_message_id === 'string' && obj.in_reply_to_message_id.length > 0) {
    marker.in_reply_to_message_id = obj.in_reply_to_message_id;
  }

  return marker;
}

/**
 * Accept string / string[] / undefined / null and produce a trimmed
 * non-empty `string[]`. Mirrors Python `_normalize_addresses`.
 */
function normalizeAddresses(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length === 0 ? [] : [t];
  }
  if (Array.isArray(v)) {
    return v
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
