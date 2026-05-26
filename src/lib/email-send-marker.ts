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
const EMAIL_SEND_PREFIX = 'EMAIL_SEND:';

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
  const spans = extractEmailSendSpans(assistantText);
  for (const span of spans) {
    try {
      const parsed = parseOne(span.json);
      markers.push(parsed);
    } catch (err) {
      failures.push({
        raw: span.raw,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const cleanedText = removeSpans(assistantText, spans)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { markers, failures, cleanedText };
}

interface EmailSendSpan {
  start: number;
  end: number;
  raw: string;
  json: string;
}

function extractEmailSendSpans(text: string): EmailSendSpan[] {
  const spans: EmailSendSpan[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const prefixAt = text.indexOf(EMAIL_SEND_PREFIX, searchFrom);
    if (prefixAt === -1) break;
    const jsonStart = text.indexOf('{', prefixAt + EMAIL_SEND_PREFIX.length);
    if (jsonStart === -1) {
      spans.push({
        start: prefixAt,
        end: lineEnd(text, prefixAt),
        raw: text.slice(prefixAt, lineEnd(text, prefixAt)),
        json: '',
      });
      searchFrom = prefixAt + EMAIL_SEND_PREFIX.length;
      continue;
    }
    const jsonEnd = findBalancedJsonObjectEnd(text, jsonStart);
    if (jsonEnd === -1) {
      const end = lineEnd(text, jsonStart);
      spans.push({
        start: prefixAt,
        end,
        raw: text.slice(prefixAt, end),
        json: text.slice(jsonStart, end),
      });
      searchFrom = end;
      continue;
    }
    const end = jsonEnd + 1;
    spans.push({
      start: prefixAt,
      end,
      raw: text.slice(prefixAt, end),
      json: text.slice(jsonStart, end),
    });
    searchFrom = end;
  }
  return spans;
}

function findBalancedJsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineEnd(text: string, start: number): number {
  const idx = text.indexOf('\n', start);
  return idx === -1 ? text.length : idx;
}

function removeSpans(text: string, spans: EmailSendSpan[]): string {
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start);
    cursor = span.end;
  }
  out += text.slice(cursor);
  return out;
}

function parseOne(rawJson: string): EmailSendMarker {
  let data: unknown;
  try {
    data = JSON.parse(rawJson);
  } catch (err) {
    try {
      data = JSON.parse(escapeLiteralControlCharsInJsonStrings(rawJson));
    } catch {
      throw new Error(`EMAIL_SEND JSON parse: ${err instanceof Error ? err.message : String(err)}`);
    }
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

function escapeLiteralControlCharsInJsonStrings(rawJson: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < rawJson.length; i += 1) {
    const ch = rawJson[i]!;
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
    }
    out += ch;
  }
  return out;
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

// ---------------------------------------------------------------------------
// cap / gate redaction (port mapping v1 §1 row #23)
// ---------------------------------------------------------------------------

/**
 * cap (= tool_call_cap / max_iter / session_watchdog) 到達時に EMAIL_SEND
 * を送信せず prefix の BCC アドレスだけ伏字化する。Cloud Run の
 * `_redact_email_send_on_cap` (`cma_gchat_bot.py` l.1486) の TS port。
 *
 * 元の logic:
 *   - cap でなければ素通り
 *   - EMAIL_SEND marker 検出 → JSON parse → BCC を抽出
 *   - prefix (= marker 直前まで) の BCC アドレスを `[BCC redacted]` 置換
 *   - JSON parse 失敗 → BCC 特定不可 → 安全側として prefix 破棄
 *
 * 「送信は行わない」「✅ 送信完了」固定サマリは出さない (= 実送信なし)
 * の表現は呼出側 (= reactive bot dispatcher) で行う。本関数は **prefix
 * のテキスト変換のみ** を担う。
 *
 * Source: scripts/cma_gchat_bot.py l.1486-1524.
 */
export const CAP_STOP_REASONS = [
  'tool_call_cap',
  'max_iter',
  'session_watchdog',
] as const;
export type CapStopReason = (typeof CAP_STOP_REASONS)[number];
export const BCC_REDACTED_PLACEHOLDER = '[BCC redacted]';

export interface RedactEmailSendOnCapResult {
  /** redaction 適用後の prefix (= marker 直前まで、BCC 置換済 or 破棄)。 */
  redactedPrefix: string;
  /** cap でない場合は本来の `final_text`、それ以外は redacted prefix。 */
  finalText: string;
  /** EMAIL_SEND marker が検出されたか。 */
  markerFound: boolean;
  /** cap 判定 (stop_reason が _CAP_STOP_REASONS に含まれるか)。 */
  isCap: boolean;
  /** JSON parse 失敗で prefix 破棄したか (Python 安全側挙動)。 */
  prefixDiscarded: boolean;
}

export function redactEmailSendOnCap(
  finalText: string,
  stopReason: string,
): RedactEmailSendOnCapResult {
  const isCap = (CAP_STOP_REASONS as readonly string[]).includes(stopReason);
  if (!isCap) {
    return {
      redactedPrefix: finalText,
      finalText,
      markerFound: false,
      isCap: false,
      prefixDiscarded: false,
    };
  }
  // module-level regex の lastIndex を踏まないよう per-call instance を作る。
  const re = new RegExp(EMAIL_SEND_MARKER_RE.source, EMAIL_SEND_MARKER_RE.flags);
  const match = re.exec(finalText);
  if (!match) {
    return {
      redactedPrefix: finalText,
      finalText,
      markerFound: false,
      isCap: true,
      prefixDiscarded: false,
    };
  }
  let prefix = finalText.slice(0, match.index).replace(/\s+$/, '');
  let prefixDiscarded = false;
  try {
    const data = JSON.parse(match[1]!) as Record<string, unknown>;
    const bccAddrs = normalizeAddresses(data.bcc);
    if (bccAddrs.length > 0) {
      for (const addr of bccAddrs) {
        const escaped = addr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        prefix = prefix.replace(new RegExp(escaped, 'gi'), BCC_REDACTED_PLACEHOLDER);
      }
    }
  } catch {
    // BCC 特定不可 → 安全側として prefix 破棄 (Python l.1521-1523)
    prefix = '';
    prefixDiscarded = true;
  }
  return {
    redactedPrefix: prefix,
    finalText: prefix,
    markerFound: true,
    isCap: true,
    prefixDiscarded,
  };
}

/**
 * 汎用 marker gate strip — Python `_strip_marker_on_gate`
 * (`cma_gchat_bot.py` l.1437) の TS port。`gate=false` なら素通り、
 * `gate=true` なら regex で marker を strip し、empty 時は fallback 挿入。
 *
 * EMAIL_SEND は専用 `redactEmailSendOnCap` を使う (BCC redact あり)。
 * 本 helper は CHAT_POST / SCHEDULE_ACTION のような「単純 strip + 空時
 * fallback」用途で使う (= callers can import from chat-post-marker /
 * schedule-action-marker 等で再利用)。
 */
export function stripMarkerOnGate(
  finalText: string,
  markerRegex: RegExp,
  options: { gate: boolean; emptyFallback?: string },
): string {
  if (!options.gate) return finalText;
  // `g` flag 必須 (replace で global strip)、無ければ補う。
  const re = markerRegex.global
    ? markerRegex
    : new RegExp(markerRegex.source, markerRegex.flags + 'g');
  let stripped = finalText.replace(re, '').trim();
  if (stripped === '' && options.emptyFallback !== undefined) {
    stripped = options.emptyFallback;
  }
  return stripped;
}
