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

  it('parses marker JSON when body contains literal newlines', () => {
    const text =
      '以下の内容で送信します:\n' +
      'EMAIL_SEND:{"to":"a@x","subject":"猫","body":"1行目\n\n2行目"}';
    const result = parseAssistantText(text);
    expect(result.failures).toHaveLength(0);
    expect(result.markers).toHaveLength(1);
    expect(result.markers[0]!.body).toBe('1行目\n\n2行目');
    expect(result.cleanedText).toBe('以下の内容で送信します:');
  });

  it('parses marker JSON across lines when newlines are escaped', () => {
    const text =
      '以下の内容で送信します:\n' +
      'EMAIL_SEND:{\n' +
      '  "to":"a@x",\n' +
      '  "subject":"猫",\n' +
      '  "body":"1行目\\n\\n2行目"\n' +
      '}';
    const result = parseAssistantText(text);
    expect(result.failures).toHaveLength(0);
    expect(result.markers).toHaveLength(1);
    expect(result.markers[0]).toMatchObject({
      to: 'a@x',
      subject: '猫',
      body: '1行目\n\n2行目',
    });
    expect(result.cleanedText).toBe('以下の内容で送信します:');
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

// ---------------------------------------------------------------------------
// cap / gate redaction tests (port mapping v1 §1 row #23)
// ---------------------------------------------------------------------------

import {
  redactEmailSendOnCap,
  stripMarkerOnGate,
  CAP_STOP_REASONS,
  BCC_REDACTED_PLACEHOLDER,
} from '../src/lib/email-send-marker';

describe('redactEmailSendOnCap', () => {
  it('passes through unchanged when stopReason is not a cap reason', () => {
    const text = 'prefix bcc@example.com\nEMAIL_SEND:{"to":"x@y","subject":"s","body":"b","bcc":"bcc@example.com"}';
    const r = redactEmailSendOnCap(text, 'end_turn');
    expect(r.isCap).toBe(false);
    expect(r.finalText).toBe(text);
    expect(r.markerFound).toBe(false);
  });

  it('passes through when cap but no EMAIL_SEND marker', () => {
    const r = redactEmailSendOnCap('普通の応答', 'tool_call_cap');
    expect(r.isCap).toBe(true);
    expect(r.markerFound).toBe(false);
    expect(r.finalText).toBe('普通の応答');
  });

  it('redacts BCC address in prefix when cap', () => {
    const text =
      'お送りします: bcc@example.com\nEMAIL_SEND:{"to":"x@y","subject":"s","body":"b","bcc":"bcc@example.com"}';
    const r = redactEmailSendOnCap(text, 'tool_call_cap');
    expect(r.isCap).toBe(true);
    expect(r.markerFound).toBe(true);
    expect(r.redactedPrefix).toBe(`お送りします: ${BCC_REDACTED_PLACEHOLDER}`);
    expect(r.finalText).toBe(r.redactedPrefix);
    expect(r.prefixDiscarded).toBe(false);
  });

  it('redacts case-insensitively (gi flag like Python re.IGNORECASE)', () => {
    const text =
      'メール: BCC@Example.COM\nEMAIL_SEND:{"to":"x@y","subject":"s","body":"b","bcc":"bcc@example.com"}';
    const r = redactEmailSendOnCap(text, 'max_iter');
    expect(r.redactedPrefix).toBe(`メール: ${BCC_REDACTED_PLACEHOLDER}`);
  });

  it('handles multi-bcc list', () => {
    const text =
      'a@example.com cc b@example.com\nEMAIL_SEND:{"to":"x@y","subject":"s","body":"b","bcc":["a@example.com","b@example.com"]}';
    const r = redactEmailSendOnCap(text, 'session_watchdog');
    expect(r.redactedPrefix).toBe(
      `${BCC_REDACTED_PLACEHOLDER} cc ${BCC_REDACTED_PLACEHOLDER}`,
    );
  });

  it('discards prefix when JSON parse fails (Python l.1521-1523 安全側)', () => {
    const text = 'prefix\nEMAIL_SEND:{not json}';
    const r = redactEmailSendOnCap(text, 'tool_call_cap');
    expect(r.markerFound).toBe(true);
    expect(r.prefixDiscarded).toBe(true);
    expect(r.redactedPrefix).toBe('');
    expect(r.finalText).toBe('');
  });

  it('handles no BCC (prefix unchanged after rstrip)', () => {
    const text =
      'プレフィクス\n\nEMAIL_SEND:{"to":"x@y","subject":"s","body":"b"}';
    const r = redactEmailSendOnCap(text, 'tool_call_cap');
    expect(r.redactedPrefix).toBe('プレフィクス');
    expect(r.prefixDiscarded).toBe(false);
  });

  it('CAP_STOP_REASONS matches Python tuple byte-equivalently', () => {
    expect([...CAP_STOP_REASONS]).toEqual([
      'tool_call_cap',
      'max_iter',
      'session_watchdog',
    ]);
  });
});

describe('stripMarkerOnGate', () => {
  it('passes through when gate=false', () => {
    const text = 'before EMAIL_SEND:{"x":1} after';
    const r = stripMarkerOnGate(text, /EMAIL_SEND:\{[^\n]+\}/g, {
      gate: false,
    });
    expect(r).toBe(text);
  });

  it('strips marker and trims when gate=true', () => {
    const text = '   prefix\n\nEMAIL_SEND:{"x":1}\n\n  ';
    const r = stripMarkerOnGate(text, /EMAIL_SEND:\{[^\n]+\}/g, {
      gate: true,
    });
    expect(r).toBe('prefix');
  });

  it('inserts empty fallback when stripping leaves nothing', () => {
    const text = 'EMAIL_SEND:{"x":1}';
    const r = stripMarkerOnGate(text, /EMAIL_SEND:\{[^\n]+\}/g, {
      gate: true,
      emptyFallback: '（tool_call_cap のため出力なし）',
    });
    expect(r).toBe('（tool_call_cap のため出力なし）');
  });

  it('adds g flag automatically if regex lacks it', () => {
    const text = 'a\nEMAIL_SEND:{"x":1}\nb\nEMAIL_SEND:{"y":2}\nc';
    const r = stripMarkerOnGate(text, /EMAIL_SEND:\{[^\n]+\}/, {
      gate: true,
    });
    expect(r).toBe('a\n\nb\n\nc');
  });
});
