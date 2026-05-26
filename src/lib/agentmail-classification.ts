/**
 * AgentMail inbound classification — TS port of the continuation /
 * cold-inbound decision tree in
 * `scripts/cma_agentmail_inbound.py:_handle_one_internal` (l.1651-1757)
 * plus the `_notify_only` / `_auto_reply_continuation` dispatch fork
 * (l.1934 / l.1947).
 *
 * The Python source uses three OR'd signals to decide continuation:
 *
 *   SignalA = RFC 822 `In-Reply-To` / `References` ∩ `outbound_rfc822_set`
 *             (in-memory set of message-IDs we sent earlier). Strong:
 *             header-only, deterministic, no API call.
 *   SignalB = AgentMail thread that contains a message authored by the
 *             bot (`_thread_self_scan`). Survives Cloud Run restarts
 *             since the bot is the only sender of its outbound mail.
 *   Tertiary= legacy AgentMail-opaque id match (kept as a no-cost
 *             fallback for very old outbound rows where we never
 *             persisted the RFC 822 id).
 *
 * On Cloudflare Workers we replace the in-memory `outbound_rfc822_set`
 * with the D1 `sent_messages.rfc822_msgid` lookup the dispatch layer
 * already performs (`findSessionByRfc822MessageId` in
 * `src/storage.ts:44`). The CF port therefore exposes a **pure**
 * `classifyInboundMail` function that does **header-only** analysis
 * (Re: chain depth, RFC 822 refs, sender-claimed reply markers) and
 * lets the caller fold in the D1 thread-match result. That keeps the
 * classifier testable in isolation while still letting the dispatcher
 * upgrade `cold` → `continuation` once it has DB context.
 *
 * The `RE_CHAIN_MAX = 5` demote-to-cold rule (Python l.1741-1743) is
 * applied here as well: when a counterparty has stacked five or more
 * `Re:` prefixes the thread is treated as runaway / spam and we fall
 * back to the cold notification path even if header signals would
 * otherwise mark it continuation.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 — G: continuation /
 *        notification 判定強化)
 * Python source:
 *   - `scripts/cma_agentmail_inbound.py:1651` `_handle_one_internal`
 *   - `scripts/cma_agentmail_inbound.py:1934` `_notify_only`
 *   - `scripts/cma_agentmail_inbound.py:1947` `_auto_reply_continuation`
 */

import { extractThreadRefs, reChainDepth } from './email-thread';
import type { AgentMailMessage } from '../types/agentmail';

/**
 * Hard cap on `Re:` prefix repetition before we demote the thread to
 * cold. Mirrors Python `RE_CHAIN_MAX = 5` at
 * `scripts/cma_agentmail_inbound.py:86`.
 */
export const RE_CHAIN_MAX = 5;

/** Discrete signal sources the classifier inspects. */
export type ClassificationSignal =
  | 'rfc822_in_reply_to' // header carries In-Reply-To we recognize
  | 'rfc822_references' // header carries References we recognize
  | 'thread_self' // an outbound message lives on the same thread (D1 / SignalB)
  | 'legacy_opaque' // tertiary AgentMail-opaque id match (rare)
  | 're_prefix' // subject starts with one or more `Re:` prefixes
  | 're_chain_exceeded' // `Re:` count >= RE_CHAIN_MAX → demote to cold
  | 'no_thread_refs'; // header has no In-Reply-To or References at all

/**
 * Caller-supplied hints. None of these are required — the pure helper
 * still produces a useful verdict from headers alone. Callers that
 * already know the answer to (e.g.) "does this In-Reply-To match a
 * row in sent_messages" should pass `knownOutboundMessageIds` so the
 * classifier can upgrade the verdict from `cold` to `continuation`.
 */
export interface ClassificationHints {
  /**
   * RFC 822 Message-IDs (normalized: lowercase, no angle brackets)
   * the bridge has previously emitted. Equivalent to Python
   * `outbound_rfc822_set`. Typically populated by the dispatcher
   * after a `findSessionByRfc822MessageId` lookup, but tests can
   * pass a static set.
   */
  knownOutboundMessageIds?: ReadonlySet<string>;
  /**
   * Whether an AgentMail thread containing a bot-authored message
   * exists for this inbound. Python `_thread_self_scan` SignalB.
   * Default `false` — the CF port does not currently fetch the
   * thread (handled in dispatch via `findSessionByRfc822MessageId`).
   */
  threadHasSelf?: boolean;
  /**
   * Legacy / tertiary: the AgentMail-opaque parent message id, if
   * known to the bridge. Equivalent to Python `outbound_set`.
   * Default `false` — most callers won't have this.
   */
  legacyOpaqueIdMatch?: boolean;
}

/** Result of `classifyInboundMail`. */
export interface InboundClassification {
  /**
   * The bridge's verdict. `cold` → notify-only (human decides reply);
   * `continuation` → auto-reply path may proceed.
   */
  kind: 'cold' | 'continuation';
  /**
   * Heuristic confidence in `[0, 1]`. Pure-header verdicts top out at
   * 0.6; DB-confirmed thread matches (caller passes
   * `knownOutboundMessageIds` that hit) reach 0.95. Subject-only
   * `Re:` matches stay below 0.5 because counterparties trivially
   * forge them by replying to unrelated mail.
   */
  confidence: number;
  /** Ordered list of which signals fired (for log lines / debugging). */
  signals: ClassificationSignal[];
  /**
   * When `kind === 'cold'` and the classifier demoted from a
   * would-be `continuation`, this is the reason. Lets the caller
   * decide whether to alert the operator separately.
   */
  demotedReason?: 're_chain_exceeded';
}

/**
 * Classify an inbound `AgentMailMessage` as `cold` or `continuation`.
 *
 * Pure: no I/O, no DB lookup, no AgentMail API call. Callers pass any
 * DB-derived hints through `hints`; the classifier folds them in.
 *
 * Decision tree (mirrors Python `_handle_one_internal` l.1709-1743):
 *
 *   1. Compute header signals
 *      a. `irt` = In-Reply-To (normalized)
 *      b. `refs` = References array (normalized, oldest-first)
 *      c. `depth` = `reChainDepth(subject)` (number of leading `Re:`)
 *
 *   2. SignalA = `irt`/`refs` ∩ `hints.knownOutboundMessageIds`
 *      (high confidence — DB-confirmed thread)
 *
 *   3. SignalB = `hints.threadHasSelf` (medium-high — bot-authored
 *      message exists on the AgentMail thread)
 *
 *   4. Tertiary = `hints.legacyOpaqueIdMatch` (medium — legacy id)
 *
 *   5. RePrefix = `depth >= 1` (low — counterparty can forge)
 *
 *   6. If any of (SignalA, SignalB, Tertiary) → `continuation` (high)
 *      Else if RePrefix → `continuation` (low confidence)
 *      Else → `cold`
 *
 *   7. **Demote**: if `continuation` AND `depth >= RE_CHAIN_MAX` →
 *      override to `cold` with `demotedReason='re_chain_exceeded'`.
 */
export function classifyInboundMail(
  message: AgentMailMessage,
  hints: ClassificationHints = {},
): InboundClassification {
  const refs = extractThreadRefs(message);
  const irt = refs.inReplyTo ?? '';
  const depth = reChainDepth(message.subject);
  const signals: ClassificationSignal[] = [];

  // SignalA — RFC 822 header ∩ known outbound set.
  const known = hints.knownOutboundMessageIds ?? new Set<string>();
  const irtMatch = irt.length > 0 && known.has(irt);
  let referencesMatch = false;
  for (const r of refs.references) {
    if (r.length > 0 && known.has(r)) {
      referencesMatch = true;
      break;
    }
  }
  if (irtMatch) signals.push('rfc822_in_reply_to');
  if (referencesMatch) signals.push('rfc822_references');

  // SignalB — AgentMail thread carries a bot-authored message.
  if (hints.threadHasSelf === true) signals.push('thread_self');

  // Tertiary — legacy opaque id match.
  if (hints.legacyOpaqueIdMatch === true) signals.push('legacy_opaque');

  // Subject prefix (low-confidence indicator on its own).
  if (depth >= 1) signals.push('re_prefix');
  if (irt.length === 0 && refs.references.length === 0) {
    signals.push('no_thread_refs');
  }

  const strongMatch = irtMatch || referencesMatch || hints.threadHasSelf === true;
  const tertiaryMatch = hints.legacyOpaqueIdMatch === true;
  const subjectOnlyMatch = depth >= 1 && !strongMatch && !tertiaryMatch;

  let kind: 'cold' | 'continuation';
  let confidence: number;
  if (strongMatch) {
    kind = 'continuation';
    confidence = 0.95;
  } else if (tertiaryMatch) {
    kind = 'continuation';
    confidence = 0.7;
  } else if (subjectOnlyMatch) {
    // Re: prefix only — counterparty trivially forges this by replying
    // to unrelated mail. Treat as continuation so the dispatch can try
    // a session lookup, but with low confidence so the operator can
    // sanity-check via log lines if needed.
    kind = 'continuation';
    confidence = 0.35;
  } else {
    kind = 'cold';
    confidence = depth >= 1 ? 0.4 : 0.85;
  }

  // RE_CHAIN_MAX demote — runaway `Re:` chains often signal mail-loop
  // or spam. Override even a strong continuation verdict.
  if (kind === 'continuation' && depth >= RE_CHAIN_MAX) {
    signals.push('re_chain_exceeded');
    return {
      kind: 'cold',
      confidence: 0.5,
      signals,
      demotedReason: 're_chain_exceeded',
    };
  }

  return { kind, confidence, signals };
}

/**
 * Convenience predicate — true when the inbound should follow the
 * `_auto_reply_continuation` path (Python l.1947). Wraps
 * `classifyInboundMail` so callers can spell the common branch as
 * `if (shouldAutoReply(msg, hints))`.
 */
export function shouldAutoReply(
  message: AgentMailMessage,
  hints: ClassificationHints = {},
): boolean {
  return classifyInboundMail(message, hints).kind === 'continuation';
}
