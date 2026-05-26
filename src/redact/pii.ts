/**
 * PII redaction layer — TypeScript port of
 * `scripts/cma_log_redaction.py:redact_pii_fields_inplace` (l.55) and
 * `redact_pii_in_text` (l.85) in the makoto-prime repo.
 *
 * Background (parity with Python `cma_log_redaction.py` module
 * docstring, Issue #1289 / #1273-S3):
 *
 *   Cloudflare Worker logs (= `console.log/warn/error`) flow into the
 *   Cloudflare Logs pipeline and may be retained long-term in third-
 *   party log aggregators. Sender email addresses and phone numbers
 *   embedded in webhook payloads / body previews / log lines therefore
 *   need to be scrubbed at the log emit boundary as a defensive layer.
 *
 *   This module is the TS counterpart of Python `cma_log_redaction.py`.
 *   The two implementations MUST stay byte-equivalent in their regex
 *   and field-name lists so a future shared JSON fixture (mirror of
 *   `internal_state_patterns.json`) can verify parity.
 *
 * Pattern parity with Python source (verbatim copy):
 *
 *   _EMAIL_PATTERN  = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/
 *   _PHONE_PATTERN  = /(?:\+81\d{9,10}|0\d{1,4}-\d{1,4}-\d{3,4})/
 *
 *   Replacement tokens are intentionally NOT the same string as Python's
 *   ("[email redacted]" / "[phone redacted]") — the task brief asks for
 *   `[REDACTED:email]` / `[REDACTED:phone]` to make grep-based audits
 *   distinguishable from prior log lines. Behaviourally equivalent.
 *
 * Field-name list (= fields whose VALUES are emails / phones):
 *
 *   Python `redact_pii_fields_inplace` is narrowly scoped to
 *   `sender_email` only (see Python module table "既知の PII キー一覧").
 *   This TS port broadens to the union of email-bearing fields that
 *   actually appear in TS log emit sites:
 *
 *     email-bearing : sender_email, from, to, email, recipient,
 *                     sender, replyTo, reply_to, cc, bcc
 *     phone-bearing : phone, tel, telephone
 *
 *   Each field is checked against the matching regex; only matching
 *   values are replaced. Non-matching values are left untouched so
 *   structural fields (e.g. `from: "spaces/AAA"` in Chat payloads) are
 *   not falsely scrubbed.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — D コンプラ対応)
 */

// === Pattern definitions — verbatim copy of Python (cma_log_redaction.py) ===

/**
 * Email regex — verbatim copy of Python `_EMAIL_PATTERN` (cma_log_redaction.py:47).
 * Practical (not RFC 5322 strict) pattern: local@host.tld with dots / pluses / hyphens.
 */
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * Phone regex — verbatim copy of Python `_PHONE_PATTERN` (cma_log_redaction.py:52).
 * Matches Japanese landline / mobile (hyphen-separated) and international
 * `+81` form. Non-anchored — designed for substring scanning inside larger text.
 *
 *   - 0\d{1,4}-\d{1,4}-\d{3,4}   e.g. 03-1234-5678 / 090-1234-5678 / 0120-123-456
 *   - \+81\d{9,10}               e.g. +819012345678
 */
const PHONE_PATTERN = /(?:\+81\d{9,10}|0\d{1,4}-\d{1,4}-\d{3,4})/g;

// === Field-name lists ===

/**
 * Field names whose values are email addresses. Values are regex-checked
 * before replacement so non-email values (e.g. resource names) are left
 * untouched even when they share a key name with an email field.
 */
const EMAIL_FIELD_NAMES: ReadonlySet<string> = new Set([
  'sender_email',
  'senderEmail',
  'from',
  'From',
  'to',
  'To',
  'email',
  'Email',
  'recipient',
  'sender',
  'replyTo',
  'reply_to',
  'Reply-To',
  'cc',
  'Cc',
  'CC',
  'bcc',
  'Bcc',
  'BCC',
]);

/**
 * Field names whose values are phone numbers.
 */
const PHONE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'phone',
  'Phone',
  'tel',
  'Tel',
  'telephone',
  'Telephone',
  'phone_number',
  'phoneNumber',
]);

// === Replacement tokens ===

const EMAIL_REDACTED = '[REDACTED:email]';
const PHONE_REDACTED = '[REDACTED:phone]';

// === Public API ===

/**
 * In-place PII redaction for structured-log field dicts (parity with
 * Python `redact_pii_fields_inplace`, cma_log_redaction.py:55).
 *
 * Replaces values of known email / phone fields with `[REDACTED:email]`
 * / `[REDACTED:phone]` literals. Non-matching field names are skipped;
 * non-string values are skipped; matching field names with values that
 * don't actually look like emails / phones are also skipped (safety
 * net for fields like `from: "spaces/..."` in Chat payloads).
 *
 * Mutates the input object. Returns void to mirror Python's `-> None`.
 *
 * @param obj - log-field dict; mutated in place.
 */
export function redactPiiFieldsInPlace(obj: Record<string, unknown>): void {
  if (obj === null || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    if (EMAIL_FIELD_NAMES.has(key)) {
      // Reset lastIndex because the regex carries /g state across calls.
      EMAIL_PATTERN.lastIndex = 0;
      if (EMAIL_PATTERN.test(value)) {
        obj[key] = value.replace(
          new RegExp(EMAIL_PATTERN.source, 'g'),
          EMAIL_REDACTED,
        );
      }
      continue;
    }
    if (PHONE_FIELD_NAMES.has(key)) {
      PHONE_PATTERN.lastIndex = 0;
      if (PHONE_PATTERN.test(value)) {
        obj[key] = value.replace(
          new RegExp(PHONE_PATTERN.source, 'g'),
          PHONE_REDACTED,
        );
      }
      continue;
    }
  }
}

/**
 * Free-text PII redaction (parity with Python `redact_pii_in_text`,
 * cma_log_redaction.py:85).
 *
 * Replaces every email substring with `[REDACTED:email]` and every
 * phone substring with `[REDACTED:phone]`. Non-string / empty inputs
 * are coerced via `String(text)` (or `''` for `null`/`undefined`) to
 * mirror Python's safe handling.
 *
 * @param text - input text (any type accepted, coerced to string).
 * @returns redacted text.
 */
export function redactPiiInText(text: unknown): string {
  let s: string;
  if (typeof text === 'string') {
    s = text;
  } else if (text === null || text === undefined) {
    s = '';
  } else {
    s = String(text);
  }
  if (s.length === 0) return s;
  let out = s.replace(
    new RegExp(EMAIL_PATTERN.source, 'g'),
    EMAIL_REDACTED,
  );
  out = out.replace(
    new RegExp(PHONE_PATTERN.source, 'g'),
    PHONE_REDACTED,
  );
  return out;
}

// Load-time observation log — visible in Cloudflare Worker logs at startup,
// mirrors Python `[cma_log_redaction] internal_state_patterns loaded: ...`.
// Helps verify the module loaded into the deploy.
console.log(
  `[pii] PII redactor loaded: email_fields=${EMAIL_FIELD_NAMES.size} phone_fields=${PHONE_FIELD_NAMES.size}`,
);
