/**
 * Continuation SignalB — thread self-scan.
 *
 * TS port of `scripts/cma_agentmail_inbound.py:_thread_self_scan`
 * (lines 2043-2087) plus the `_is_self` (line 1224-1225) and
 * `_normalize_email` (line 171-177) helpers it depends on.
 *
 * Purpose: when an inbound mail arrives and we can't link it back to a
 * prior session via Message-ID (SignalA), we fall back to scanning the
 * AgentMail thread for evidence the bot itself participated. If our
 * inbox address appears as a `from` on any message in the thread, the
 * inbound is a continuation of one of our previously-started threads
 * and we should generate a continuation reply rather than treat it as
 * a cold start.
 *
 * Design notes carried verbatim from the Python source:
 *   - **Primary judgement uses `messages[].from` only.** AgentMail's
 *     `Thread.senders` field is not contractually documented as
 *     "messages-sent-by-this-side"; treating it as such risks
 *     false-continuation on cold threads where our inbox happens to be
 *     in the participant set. We surface it only as `sendersSelf` for
 *     audit logging.
 *   - **Fetch is one-shot, no message trimming.** Caller (G layer
 *     `_handle_one_internal`) re-uses the returned message array to
 *     skip a second `threads.get` round-trip when building the
 *     continuation prompt (Python `_auto_reply_continuation`).
 *   - **Any failure / missing messages → (false, [], false) + WARN.**
 *     "Cold thread mis-classified as continuation → auto-reply to a
 *     cold sender" is the heavier failure mode, so we fail closed.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 6 — Cold-continuation
 *   SignalB, 既知 #5).
 */

import type { AgentMailMessage } from '../types/agentmail';

/**
 * Minimal shape of the `GET /v0/inboxes/{inbox}/threads/{thread}`
 * response that SignalB consumes. AgentMail returns more fields; we
 * only narrow to what the scan needs to keep the dependency surface
 * small. Other consumers (e.g. prompt builder) extract more from
 * `messages` via `AgentMailMessage`.
 */
export interface AgentMailThread {
  messages?: AgentMailMessage[];
  /**
   * AgentMail's Thread.senders array. Schema is not documented as
   * "outbound senders" specifically — see the Python docstring for the
   * rationale we treat this as audit-only.
   */
  senders?: string[];
}

/**
 * Result tuple equivalent to Python's `(self_present, messages,
 * senders_self)`. Named fields here (instead of a positional tuple) so
 * call sites read clearly — Python uses a literal 3-tuple, this is the
 * idiomatic TS shape.
 */
export interface ThreadSelfScanResult {
  /**
   * Primary judgement: at least one message in the thread has a `from`
   * matching the configured inbox address. SignalB true ⇒ caller
   * should branch to `_auto_reply_continuation`.
   */
  selfPresent: boolean;
  /**
   * The raw message array from the thread response — passed through
   * unchanged (no trimming, no body elision) so the caller can re-use
   * it without a second fetch.
   */
  messages: AgentMailMessage[];
  /**
   * Audit-only: whether `Thread.senders` (if present) contains a
   * matching address. Useful for logging/triage when `selfPresent` and
   * `sendersSelf` disagree.
   */
  sendersSelf: boolean;
}

/**
 * Logger surface — kept minimal so callers can pass console / a Worker
 * `WaitUntil`-aware logger / a no-op for tests. Mirrors the Python
 * `_log()` calls which write WARN lines on failure / empty-thread.
 */
export interface ThreadSelfScanLogger {
  warn: (msg: string) => void;
}

const NOOP_LOGGER: ThreadSelfScanLogger = { warn: () => {} };

/**
 * Pure scan over already-fetched thread data. Exported so the orchestrator
 * (`threadSelfScan`) and tests can both exercise the byte-equivalent
 * comparison logic without touching `fetch`. Mirrors the inner half of
 * Python `_thread_self_scan` (lines 2073-2087).
 *
 * `inboxId` is the bot's inbox address (e.g. `makoto@agentmail.to`) —
 * the comparison key. Both sides are normalised via the local
 * `normalizeEmail` (NOT the `+tag`-stripping `normalizeSenderEmail`
 * from `memory-attach.ts` — Python `cma_agentmail_inbound._normalize_email`
 * does **not** strip `+tag`, see line 171-177).
 */
export function scanThreadForSelf(
  thread: AgentMailThread | null | undefined,
  inboxId: string,
  logger: ThreadSelfScanLogger = NOOP_LOGGER,
  threadIdForLog: string = '?',
): ThreadSelfScanResult {
  const inboxNormalized = normalizeEmail(inboxId);

  if (!thread) {
    logger.warn(
      `_thread_self_scan: thread response missing thread_id=${threadIdForLog} ` +
        `(continuation=false に倒す)`,
    );
    return { selfPresent: false, messages: [], sendersSelf: false };
  }

  const msgs = thread.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) {
    logger.warn(
      `_thread_self_scan: thread messages 欠落/空 thread_id=${threadIdForLog} ` +
        `(continuation=false に倒す)`,
    );
    return { selfPresent: false, messages: [], sendersSelf: false };
  }

  const selfPresent = msgs.some(
    (m) => isPlainObject(m) && isSelf(m.from ?? '', inboxNormalized),
  );

  const senders = thread.senders;
  const sendersSelf =
    Array.isArray(senders) &&
    senders.some((s) => typeof s === 'string' && isSelf(s, inboxNormalized));

  return { selfPresent, messages: msgs, sendersSelf };
}

/**
 * Orchestrator equivalent to Python `_thread_self_scan`. Takes an
 * injectable fetch function (so tests can stub without standing up the
 * full `AgentMailClient`) and calls
 * `GET /v0/inboxes/{inbox}/threads/{thread}` then delegates to the
 * pure scan. Any thrown error from the fetch is caught, logged WARN
 * (matching Python's `except Exception` block) and degraded to
 * `(false, [], false)` — fail closed.
 */
export async function threadSelfScan(
  fetchThread: (inboxId: string, threadId: string) => Promise<AgentMailThread>,
  inboxId: string,
  threadId: string,
  logger: ThreadSelfScanLogger = NOOP_LOGGER,
): Promise<ThreadSelfScanResult> {
  let thread: AgentMailThread;
  try {
    thread = await fetchThread(inboxId, threadId);
  } catch (err) {
    const name = err instanceof Error ? err.name : typeof err;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `_thread_self_scan threads.get failed thread_id=${threadId}: ${name}: ${message}`,
    );
    return { selfPresent: false, messages: [], sendersSelf: false };
  }
  return scanThreadForSelf(thread, inboxId, logger, threadId);
}

// --------------------------------------------------------------------
// Helpers — byte-equivalent ports of the Python originals.
// --------------------------------------------------------------------

/**
 * Equivalent to `cma_agentmail_inbound.py:_normalize_email`
 * (lines 171-177).
 *
 * `'MAKOTO <Makoto@AgentMail.to>'` → `'makoto@agentmail.to'`.
 *
 * NOTE: This is **different** from `memory-attach.ts:normalizeSenderEmail`,
 * which additionally strips `+tag` from the local part to match
 * `cma_session_resolver.py:_normalize_email`. The SignalB logic needs
 * byte-equivalence with the inbound-side normaliser; using the
 * `+tag`-stripping variant would change classification for addresses
 * like `makoto+test@agentmail.to` and break Python parity.
 */
export function normalizeEmail(addr: string): string {
  const s = (addr ?? '').trim();
  // Equivalent to Python `re.search(r"<([^>]+)>", s)` → take group 1.
  const m = s.match(/<([^>]+)>/);
  const extracted = m ? m[1]!.trim() : s;
  return extracted.toLowerCase();
}

/**
 * Equivalent to `cma_agentmail_inbound.py:_is_self`
 * (lines 1224-1225). Compares an arbitrary `from`-style address to
 * a pre-normalised inbox id.
 */
function isSelf(addr: string, inboxNormalized: string): boolean {
  return normalizeEmail(addr) === inboxNormalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
