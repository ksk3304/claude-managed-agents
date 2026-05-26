/**
 * Unit tests for `src/redact/pii.ts` — PII redaction layer.
 *
 * Parity contract: behaviourally equivalent to Python
 * `scripts/cma_log_redaction.py:redact_pii_fields_inplace` (l.55) and
 * `redact_pii_in_text` (l.85). Replacement tokens differ in literal
 * (TS uses `[REDACTED:email]` / `[REDACTED:phone]`; Python uses
 * `[email redacted]` / `[phone redacted]`) but the trigger patterns
 * are byte-equivalent.
 *
 * Issue: ksk3304/makoto-prime#186
 */

import { describe, it, expect } from 'vitest';
import {
  redactPiiFieldsInPlace,
  redactPiiInText,
} from '../src/redact/pii';

describe('redactPiiInText — email substitution', () => {
  it('redacts a single email', () => {
    expect(redactPiiInText('contact user@example.com please')).toBe(
      'contact [REDACTED:email] please',
    );
  });

  it('redacts an email with + and . in the local part', () => {
    expect(redactPiiInText('foo.bar+tag@sub.example.co.jp here')).toBe(
      '[REDACTED:email] here',
    );
  });

  it('redacts multiple emails in one string', () => {
    expect(
      redactPiiInText('a@b.com and c@d.org'),
    ).toBe('[REDACTED:email] and [REDACTED:email]');
  });

  it('passes through text with no email', () => {
    expect(redactPiiInText('plain text with no PII')).toBe(
      'plain text with no PII',
    );
  });
});

describe('redactPiiInText — phone substitution (JP)', () => {
  it('redacts a Japanese mobile phone (090-1234-5678)', () => {
    expect(redactPiiInText('call 090-1234-5678 today')).toBe(
      'call [REDACTED:phone] today',
    );
  });

  it('redacts a Japanese landline (03-1234-5678)', () => {
    expect(redactPiiInText('Tokyo: 03-1234-5678')).toBe(
      'Tokyo: [REDACTED:phone]',
    );
  });

  it('redacts a Japanese freedial (0120-123-456)', () => {
    expect(redactPiiInText('Freedial 0120-123-456 open 24h')).toBe(
      'Freedial [REDACTED:phone] open 24h',
    );
  });

  it('redacts an international JP phone (+819012345678)', () => {
    expect(redactPiiInText('Intl: +819012345678 only')).toBe(
      'Intl: [REDACTED:phone] only',
    );
  });
});

describe('redactPiiInText — mixed + negative cases', () => {
  it('redacts a mix of emails + phones + free text', () => {
    const input =
      'From: alice@example.com / Tel: 090-1234-5678 / note: thank you';
    const out = redactPiiInText(input);
    expect(out).toBe(
      'From: [REDACTED:email] / Tel: [REDACTED:phone] / note: thank you',
    );
  });

  it('does not false-positive on a URL with digits', () => {
    const input = 'https://example.com/api/v1/users/12345';
    expect(redactPiiInText(input)).toBe(input);
  });

  it('does not false-positive on long digit strings without dashes', () => {
    const input = 'order id 09012345678 ref 1234567890';
    expect(redactPiiInText(input)).toBe(input);
  });

  it('does not false-positive on a year like 2026-05-26', () => {
    // date 2026-05-26 doesn't match phone (no leading 0 + segment-length mismatch)
    expect(redactPiiInText('Today is 2026-05-26')).toBe('Today is 2026-05-26');
  });

  it('handles non-string input (null / undefined / number)', () => {
    expect(redactPiiInText(null)).toBe('');
    expect(redactPiiInText(undefined)).toBe('');
    expect(redactPiiInText(123)).toBe('123');
  });

  it('preserves empty string', () => {
    expect(redactPiiInText('')).toBe('');
  });
});

describe('redactPiiFieldsInPlace — known PII field names', () => {
  it('redacts sender_email field', () => {
    const obj: Record<string, unknown> = {
      sender_email: 'x@y.com',
      body: 'test body',
    };
    redactPiiFieldsInPlace(obj);
    expect(obj).toEqual({
      sender_email: '[REDACTED:email]',
      body: 'test body',
    });
  });

  it('redacts multiple email-bearing fields at once', () => {
    const obj: Record<string, unknown> = {
      from: 'a@b.com',
      to: 'c@d.com',
      cc: 'e@f.com',
      subject: 'Hello',
    };
    redactPiiFieldsInPlace(obj);
    expect(obj).toEqual({
      from: '[REDACTED:email]',
      to: '[REDACTED:email]',
      cc: '[REDACTED:email]',
      subject: 'Hello',
    });
  });

  it('redacts phone-bearing field values', () => {
    const obj: Record<string, unknown> = {
      phone: '090-1234-5678',
      note: 'caller info',
    };
    redactPiiFieldsInPlace(obj);
    expect(obj).toEqual({
      phone: '[REDACTED:phone]',
      note: 'caller info',
    });
  });

  it('does not touch unknown field names', () => {
    const obj: Record<string, unknown> = {
      message: 'leave email like a@b.com here',
      custom: 'random text',
    };
    redactPiiFieldsInPlace(obj);
    expect(obj).toEqual({
      message: 'leave email like a@b.com here',
      custom: 'random text',
    });
  });

  it('skips non-string values on PII field names', () => {
    const obj: Record<string, unknown> = {
      from: null,
      to: 42,
      cc: undefined,
      phone: { nested: 'object' },
    };
    redactPiiFieldsInPlace(obj);
    expect(obj).toEqual({
      from: null,
      to: 42,
      cc: undefined,
      phone: { nested: 'object' },
    });
  });

  it('does not redact PII-named field whose value is not actually PII', () => {
    // e.g. Chat payloads use `from` for resource names (not emails) —
    // make sure those aren't falsely scrubbed.
    const obj: Record<string, unknown> = {
      from: 'spaces/AAAA/messages/BBBB',
      to: 'users/123',
    };
    redactPiiFieldsInPlace(obj);
    expect(obj).toEqual({
      from: 'spaces/AAAA/messages/BBBB',
      to: 'users/123',
    });
  });

  it('handles empty / non-object input safely', () => {
    const empty: Record<string, unknown> = {};
    redactPiiFieldsInPlace(empty);
    expect(empty).toEqual({});
    // Defensive: should not throw on null-like inputs.
    expect(() => {
      redactPiiFieldsInPlace(
        null as unknown as Record<string, unknown>,
      );
    }).not.toThrow();
  });
});
