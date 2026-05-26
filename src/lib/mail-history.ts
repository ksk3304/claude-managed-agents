/**
 * AgentMail thread-history fetcher — TS port of
 * `scripts/cma_agentmail_inbound.py:_fetch_thread_messages` (line
 * 2027-2041). Loads the prior messages on an inbound mail's thread so
 * the continuation prompt can carry full context into the agent (vs.
 * the Phase 6 fallback of passing an empty array, which made every
 * reply look like a cold inbound to the agent).
 *
 * `buildContinuationPrompt` is re-exported as `buildMailContinuationPrompt`
 * for callers that want to import both halves from this module; the
 * underlying implementation still lives in `src/lib/continuation.ts`
 * (no behaviour duplication — the prompt builder is unchanged).
 *
 * Flow:
 *   1. `GET /v0/inboxes/{inboxId}/threads/{threadId}` against the
 *      AgentMail REST surface. Uses native `fetch` directly so we
 *      stay scoped to this one file (the existing `AgentMailClient`
 *      in `agentmail-api.ts` doesn't expose a threads method yet —
 *      adding one would require editing two files when only this
 *      caller needs it for now).
 *   2. Return the response's `messages` array trimmed to the most
 *      recent `MAIL_HISTORY_MESSAGE_LIMIT` entries (= 10, matches
 *      Python `PROMPT_MESSAGE_LIMIT`).
 *   3. On AgentMail error (404 stale thread / 403 wrong inbox / 5xx /
 *      network) log + return `[]`. The caller's continuation flow keeps
 *      working with an empty history, exactly matching the pre-fetch
 *      Phase 6 behaviour — failure mode is observable but never fatal.
 *
 * Issue: ksk3304/makoto-prime#186 B (mail continuation thread fetch).
 * Source-of-truth: `scripts/cma_agentmail_inbound.py:2027-2041`
 * (`_fetch_thread_messages`) + line 87 (`PROMPT_MESSAGE_LIMIT = 10`).
 */

import type { AgentMailMessage } from '../types/agentmail';
import { assertBridgeEgressAllowed } from './egress-guard';
import { redactPiiInText } from '../redact/pii';
import {
  buildContinuationPrompt as _buildContinuationPrompt,
} from './continuation';

/** Maximum prior thread messages embedded in the continuation prompt.
 * Mirrors Python `PROMPT_MESSAGE_LIMIT` (`cma_agentmail_inbound.py:87`).
 */
export const MAIL_HISTORY_MESSAGE_LIMIT = 10;

/** Default AgentMail REST base URL (matches `agentmail-api.ts`). */
const DEFAULT_AGENTMAIL_BASE_URL = 'https://api.agentmail.to/v0';

/** Per-request timeout (ms). Conservative — we don't want a stuck
 * thread-fetch to delay the dispatcher past its session-stream cap. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Subset of `Env` this module needs. Declared narrow so the caller
 * doesn't have to pass the full Cloudflare `Env` (= easier to unit
 * test in isolation).
 */
export interface MailHistoryEnv {
  AGENTMAIL_API_KEY?: string;
  AGENTMAIL_API_BASE_URL?: string;
}

/**
 * Fetch the prior messages on `threadId` via the AgentMail threads
 * endpoint. Returns the most recent `MAIL_HISTORY_MESSAGE_LIMIT`
 * messages in chronological order (oldest-first) — same shape the
 * continuation prompt builder expects.
 *
 * Returns `[]` on every failure mode (missing key, missing inbox,
 * AgentMail 4xx/5xx, network, timeout). The continuation flow stays
 * usable because `buildContinuationPrompt` accepts an empty history;
 * the agent just loses thread context, mirroring the pre-fetch behaviour.
 *
 * Pass `fetchImpl` in tests to inject a mock; in production this
 * falls back to global `fetch`.
 */
export async function fetchMailThreadMessages(
  env: MailHistoryEnv,
  inboxId: string,
  threadId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<AgentMailMessage[]> {
  if (!env.AGENTMAIL_API_KEY) {
    console.warn(
      `[mail-history] skip thread_id=${redactPiiInText(threadId)} reason=no_api_key`,
    );
    return [];
  }
  if (!inboxId) {
    console.warn(
      `[mail-history] skip thread_id=${redactPiiInText(threadId)} reason=no_inbox_id`,
    );
    return [];
  }
  if (!threadId) {
    // Defensive: an empty thread id would hit `/threads/` which is a
    // different endpoint (list). Just skip with a warn.
    console.warn(`[mail-history] skip reason=empty_thread_id inbox=${inboxId}`);
    return [];
  }

  const baseUrl = (env.AGENTMAIL_API_BASE_URL ?? DEFAULT_AGENTMAIL_BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/inboxes/${encodeURIComponent(inboxId)}/threads/${encodeURIComponent(threadId)}`;

  // Egress hard-allowlist (parity with `agentmail-api.ts:request`).
  // If somehow the URL drifts off the allowlist we throw — caller
  // catches and the dispatcher proceeds with empty history.
  try {
    assertBridgeEgressAllowed(url, 'mail-history:fetchMailThreadMessages');
  } catch (err) {
    console.warn(
      `[mail-history] egress denied thread_id=${redactPiiInText(threadId)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'authorization': `Bearer ${env.AGENTMAIL_API_KEY}`,
        'accept': 'application/json',
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[mail-history] thread fetch network error thread_id=${redactPiiInText(threadId)}: ${redactPiiInText(message)}`,
    );
    return [];
  }
  clearTimeout(timer);

  if (!resp.ok) {
    // 4xx (stale thread / wrong inbox / auth) and 5xx alike — log
    // and degrade. We don't retry: thread fetch is best-effort; the
    // session-stream loop is already retried by the queue runtime if
    // dispatch returns `release_and_retry`, and a missing history
    // doesn't justify burning extra wall time here.
    console.warn(
      `[mail-history] thread fetch failed thread_id=${redactPiiInText(threadId)} status=${resp.status}`,
    );
    return [];
  }

  let raw: { messages?: unknown };
  try {
    const text = await resp.text();
    raw = text.length === 0 ? {} : (JSON.parse(text) as { messages?: unknown });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[mail-history] thread response parse error thread_id=${redactPiiInText(threadId)}: ${redactPiiInText(message)}`,
    );
    return [];
  }

  const msgsRaw = raw.messages;
  if (!Array.isArray(msgsRaw)) {
    // 200 OK but no `messages` array (= unexpected payload shape).
    console.warn(
      `[mail-history] thread response missing messages[] thread_id=${redactPiiInText(threadId)}`,
    );
    return [];
  }

  // Narrow to `AgentMailMessage` shape. We don't validate every field —
  // the continuation prompt builder only reads `from` / `subject` /
  // `extracted_text` / `text` / `extracted_html` / `html` /
  // `received_at`, and downstream tolerates `undefined` for any of
  // them. Anything that isn't an object is dropped.
  const msgs: AgentMailMessage[] = msgsRaw.filter(
    (m): m is AgentMailMessage => typeof m === 'object' && m !== null,
  );

  if (msgs.length <= MAIL_HISTORY_MESSAGE_LIMIT) return msgs;
  // Take the last N, preserving chronological order (oldest-first).
  return msgs.slice(-MAIL_HISTORY_MESSAGE_LIMIT);
}

/**
 * Convenience re-export so callers can do
 * `import { fetchMailThreadMessages, buildMailContinuationPrompt }
 * from '../lib/mail-history'` in one line. The underlying builder is
 * defined in `src/lib/continuation.ts` and is unchanged.
 */
export function buildMailContinuationPrompt(
  inbound: AgentMailMessage,
  threadHistory: AgentMailMessage[],
): string {
  return _buildContinuationPrompt(inbound, threadHistory);
}
