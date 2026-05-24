/**
 * Unit tests for `src/lib/email-send-marker.ts` — EMAIL_SEND parser.
 *
 * Parity with Python `scripts/cma_gchat_bot.py:_handle_email_send_marker`
 * (Round 3 O3 contract: `to` single string, cc/bcc string-or-list).
 */

import { describe, it, expect } from 'vitest';
import {
  parseAssistantText,
  parseEmailSendMarkers,
} from '../src/lib/email-send-marker';

describe('parseEmailSendMarkers', () => {
  it('returns [] when no marker is present', () => {
    expect(parseEmailSendMarkers('nothing to send')).toEqual([]);
  });

  it('parses a single marker with required fields', () => {
    const text =
      'preface\nEMAIL_SEND:{"to":"user@example.com","subject":"hi","body":"hello"}\nafter';
    const markers = parseEmailSendMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      to: 'user@example.com',
      subject: 'hi',
      body: 'hello',
    });
  });

  it('parses multiple markers in source order', () => {
    const text =
      'EMAIL_SEND:{"to":"a@x","subject":"s1","body":"b1"}\n' +
      'EMAIL_SEND:{"to":"b@x","subject":"s2","body":"b2"}';
    const markers = parseEmailSendMarkers(text);
    expect(markers.map((m) => m.to)).toEqual(['a@x', 'b@x']);
  });

  it('rejects array `to` (Round 3 O3 contract)', () => {
    const result = parseAssistantText(
      'EMAIL_SEND:{"to":["a@x"],"subject":"s","body":"b"}',
    );
    expect(result.markers).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.reason).toContain('to');
  });

  it('normalizes cc/bcc string to array', () => {
    const m = parseEmailSendMarkers(
      'EMAIL_SEND:{"to":"a@x","subject":"s","body":"b","cc":"c@x","bcc":["d@x","e@x"]}',
    );
    expect(m[0]!.cc).toEqual(['c@x']);
    expect(m[0]!.bcc).toEqual(['d@x', 'e@x']);
  });

  it('reports parse failures separately with reason', () => {
    const result = parseAssistantText('EMAIL_SEND:{not json}');
    expect(result.markers).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.reason).toMatch(/JSON parse/);
  });

  it('strips marker lines from cleanedText', () => {
    const text = 'before\nEMAIL_SEND:{"to":"a@x","subject":"s","body":"b"}\nafter';
    const result = parseAssistantText(text);
    expect(result.cleanedText).toBe('before\n\nafter');
  });

  it('captures in_reply_to_message_id when present', () => {
    const m = parseEmailSendMarkers(
      'EMAIL_SEND:{"to":"a@x","subject":"s","body":"b","in_reply_to_message_id":"msg_abc"}',
    );
    expect(m[0]!.in_reply_to_message_id).toBe('msg_abc');
  });

  it('rejects empty subject', () => {
    const r = parseAssistantText('EMAIL_SEND:{"to":"a@x","subject":"","body":"b"}');
    expect(r.markers).toHaveLength(0);
    expect(r.failures).toHaveLength(1);
  });
});
