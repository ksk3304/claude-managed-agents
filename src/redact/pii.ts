/**
 * PII redaction compatibility layer.
 *
 * 2026-06-01 policy: email addresses and phone numbers are no longer masked in
 * runtime logs/audit text. Keep this module as a passthrough API so callers do
 * not need broad rewrites, while token redaction remains in `tool-common.ts`
 * and payload-audit specific token/space redaction remains active.
 */

const EMAIL_REDACTED = '[REDACTED:email]';
const PHONE_REDACTED = '[REDACTED:phone]';

// === Public API ===

/**
 * Compatibility no-op.
 */
export function redactPiiFieldsInPlace(obj: Record<string, unknown>): void {
  void obj;
}

/**
 * Free-text compatibility no-op.
 */
export function redactPiiInText(text: unknown): string {
  if (typeof text === 'string') {
    return text;
  }
  if (text === null || text === undefined) return '';
  return String(text);
}

console.log('[pii] PII redactor disabled by policy');
