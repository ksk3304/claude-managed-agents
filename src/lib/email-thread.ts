/**
 * RFC 822 thread helpers — TS port of
 * `scripts/cma_agentmail_inbound.py:786-820` (extract_thread_refs /
 * re_chain_depth) plus the `_normalize_msgid` helper.
 *
 * Thread continuity is reconstructed from three RFC 822 headers:
 *   - `Message-ID:`     — current message's own id (outbound, we issue)
 *   - `In-Reply-To:`    — immediate parent id (set by the replier)
 *   - `References:`     — full ancestor chain, oldest-first
 *
 * Counterparties don't always set both; we normalize and merge so
 * the bridge can match any of them against
 * `sent_messages.rfc822_msgid` to recover the originating session.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 6 — 層 4)
 * Spec: plan-draft.md §2 thread 照合 + A4
 */

import type { AgentMailMessage } from '../types/agentmail';

const MSGID_BRACKET_RE = /<([^>]+)>/g;
const RE_PREFIX_RE = /^\s*[Rr][Ee]\s*:\s*/;

/**
 * Normalize a single RFC 822 Message-ID:
 *   - trim whitespace
 *   - strip a single surrounding pair of `<…>`
 *   - lowercase (Message-IDs are case-insensitive per RFC 5322 §3.6.4)
 *
 * Matches the Python helper at
 * `scripts/cma_agentmail_inbound.py:_normalize_msgid` (documented in
 * the file's L183 comment + applied L380-381).
 *
 * Returns an empty string for empty / whitespace-only input — callers
 * can use the value as a dedupe key directly.
 */
export function normalizeMessageId(raw: string): string {
  if (!raw) return '';
  let s = raw.trim();
  if (s.startsWith('<') && s.endsWith('>')) {
    s = s.slice(1, -1).trim();
  }
  return s.toLowerCase();
}

/**
 * Extract zero-or-more bracketed message IDs from a `References:` or
 * `In-Reply-To:` value. AgentMail sometimes delivers `References` as
 * a single space-delimited string, sometimes as an array — we accept
 * both forms (mirrors the Python branching at L791-795).
 *
 * The order returned is left-to-right (oldest-first per RFC 5322
 * convention), with empties / unbracketed garbage dropped.
 */
export function extractMessageIds(rawOrArray: string | string[] | undefined): string[] {
  if (!rawOrArray) return [];
  // Array case — assume each element is already one id (with or
  // without brackets) and normalize each.
  if (Array.isArray(rawOrArray)) {
    return rawOrArray
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .map(normalizeMessageId)
      .filter((s) => s.length > 0);
  }
  // String case — pull out every `<…>` bracketed token. If there are
  // none (some MTAs strip brackets), fall back to splitting on
  // whitespace.
  const matches = Array.from(rawOrArray.matchAll(MSGID_BRACKET_RE), (m) => m[1]);
  if (matches.length > 0) {
    return matches.map((s) => normalizeMessageId(s ?? '')).filter((s) => s.length > 0);
  }
  return rawOrArray
    .split(/\s+/)
    .map(normalizeMessageId)
    .filter((s) => s.length > 0);
}

/**
 * Resolved thread references for one inbound message.
 *   - `inReplyTo`: immediate parent (may be undefined)
 *   - `references`: ancestor chain (oldest-first; deduped against inReplyTo)
 */
export interface ThreadRefs {
  inReplyTo?: string;
  references: string[];
}

/**
 * Extract thread refs from an `AgentMailMessage`. Mirrors
 * `extract_thread_refs(detail)` in the Python source.
 */
export function extractThreadRefs(msg: AgentMailMessage): ThreadRefs {
  const irt = typeof msg.in_reply_to === 'string' && msg.in_reply_to.trim().length > 0
    ? normalizeMessageId(msg.in_reply_to)
    : undefined;
  const refs = extractMessageIds(msg.references);
  // If in_reply_to is not already at the tail, append it — most MTAs
  // do this, but a few don't, and downstream consumers expect the
  // most-recent ancestor to be reachable from `references`.
  if (irt && !refs.includes(irt)) refs.push(irt);
  const out: ThreadRefs = { references: refs };
  if (irt !== undefined) out.inReplyTo = irt;
  return out;
}

/**
 * Count the depth of leading "Re:" prefixes on a subject line.
 * Mirrors `re_chain_depth(subject)` in the Python source — used to
 * tell first-contact (`depth === 0`) from a continuation (`>= 1`).
 *
 * Safety cap at 20 (matches Python) so a malformed subject can't
 * trigger an unbounded loop.
 */
export function reChainDepth(subject: string | undefined): number {
  if (!subject) return 0;
  let s = subject.trim();
  let count = 0;
  while (count < 20) {
    const m = s.match(RE_PREFIX_RE);
    if (!m) break;
    s = s.slice(m[0].length);
    count += 1;
  }
  return count;
}

/**
 * Pull a plain-text body out of an `AgentMailMessage`. Fallback order
 * matches the Python `extract_body`: extracted_text → text →
 * extracted_html → html. (We do not strip HTML — that's a
 * higher-level concern; the agent receives the raw value.)
 *
 * Returns an empty string if nothing usable is present.
 */
export function extractBody(msg: AgentMailMessage): string {
  for (const k of ['extracted_text', 'text', 'extracted_html', 'html'] as const) {
    const v = msg[k];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return '';
}

/**
 * Pull the inbound message's own RFC 822 Message-ID, normalized.
 *
 * Lookup order (most-trusted first):
 *   1. `msg.rfc822_message_id` — populated when AgentMail surfaces the
 *      parsed RFC 822 header directly.
 *   2. `msg.headers['message-id']` / `Message-ID` — falls back to the raw
 *      headers map. Header keys are case-insensitive per RFC 5322; we
 *      probe both common casings since AgentMail's serialization is not
 *      consistently lowercased.
 *
 * Returns an empty string when no usable id is present. Empty-string is
 * the contract dedupe callers expect ("can't claim, must skip").
 */
export function extractInboundRfc822MessageId(msg: AgentMailMessage): string {
  // AgentMail webhook payload sends RFC 822 Message-ID as `message_id`
  // (verified 2026-05-25 against https://docs.agentmail.to/events).
  // `rfc822_message_id` was the unverified fixture field; kept as fallback
  // for outbound rows / older code paths.
  if (typeof msg.message_id === 'string' && msg.message_id.length > 0) {
    return normalizeMessageId(msg.message_id);
  }
  if (typeof msg.rfc822_message_id === 'string' && msg.rfc822_message_id.length > 0) {
    return normalizeMessageId(msg.rfc822_message_id);
  }
  const headers = msg.headers;
  if (headers && typeof headers === 'object') {
    for (const k of ['message-id', 'Message-ID', 'Message-Id'] as const) {
      const v = (headers as Record<string, string | string[] | undefined>)[k];
      const raw = Array.isArray(v) ? v[0] : v;
      if (typeof raw === 'string' && raw.length > 0) {
        return normalizeMessageId(raw);
      }
    }
  }
  return '';
}
