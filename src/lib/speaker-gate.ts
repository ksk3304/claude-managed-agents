/**
 * Speaker-gate wire-up layer — combines the pure gate-decision
 * primitives from `speaker-resolver.ts` (TS port of Python
 * `_compute_chat_post_gate` / `_compute_external_tool_gate`) with the
 * marker-strip side-effect (Python `_strip_chat_post_on_unresolved`)
 * and the chat-event-handler entry points.
 *
 * Why a separate file from `speaker-resolver.ts`:
 *   - `speaker-resolver.ts` is the pure decision tree (= no I/O, no
 *     marker-strip). It's the single source of truth for the
 *     `(gate, reason)` algebra and stays small + side-effect-free.
 *   - This file (`speaker-gate.ts`) is the **integration layer**: it
 *     re-exports the decision functions for ergonomics, adds the
 *     marker-strip helpers (= the actual side-effect on `final_text`),
 *     and hosts the chat-event-handler-facing `applyChatPostGateToText`
 *     helper that ties unresolved-speaker history meta → CHAT_POST gate
 *     decision → marker strip into one call.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — 未解決 speaker gate 完全実装,
 *                                  既知 #6)
 * Source of truth (Python):
 *   - scripts/cma_gchat_bot.py:1603 (`_compute_external_tool_gate`)
 *   - scripts/cma_gchat_bot.py:1638 (`_compute_chat_post_gate`)
 *   - scripts/cma_gchat_bot.py:1652 (`_strip_chat_post_on_unresolved`)
 *   - scripts/cma_gchat_bot.py:1444 (`_strip_marker_on_gate` — common
 *     marker-strip helper)
 */

import {
  CHAT_POST_MARKER_REGEX,
  computeChatPostGate,
  computeExternalToolGate,
} from './speaker-resolver';
import type {
  ChatPostGateDecision,
  ChatPostGateReason,
  ExternalToolGateDecision,
  ExternalToolGateReason,
  ResolvedSpeakerSource,
} from './speaker-resolver';

// Re-export the pure decision primitives so callers can `import { ... }
// from './speaker-gate'` without also reaching into `./speaker-resolver`
// for the algebra. The implementations live in `speaker-resolver.ts`
// (single source of truth — see file docstring).
export {
  computeChatPostGate,
  computeExternalToolGate,
} from './speaker-resolver';
export type {
  ChatPostGateDecision,
  ChatPostGateReason,
  ExternalToolGateDecision,
  ExternalToolGateReason,
} from './speaker-resolver';

/**
 * Python `_strip_chat_post_on_unresolved:1652` — fallback literal used
 * when stripping CHAT_POST markers under `hasUnresolved=true` empties
 * the body. **byte-equivalent** to Python `empty_fallback` arg
 * (`_strip_marker_on_gate` invocation at l.1657-1662).
 *
 * NOTE: This fallback differs from the per-reason fallbacks used by
 * `stripChatPostMarker` (cross-space / parse-failed) in
 * `speaker-resolver.ts`. Those are S6 cross-space-class fallbacks; this
 * one is the S5 unresolved-speaker fallback (issue #92).
 */
const CHAT_POST_UNRESOLVED_EMPTY_FALLBACK =
  '（未登録ユーザー検知のため CHAT_POST 抑止、本文出力なし）';

/**
 * Result of `applyChatPostGateToText`. `text` is the (possibly modified)
 * reply text; `decision` is the structured-log classification + gate
 * flag the caller writes to the structured log.
 */
export interface ChatPostGateApplication {
  /**
   * The (possibly modified) reply text. When `decision.gate === true`,
   * every `CHAT_POST:{...}` marker has been stripped + replaced with the
   * unresolved fallback literal if the body became empty. When
   * `decision.gate === false`, the input is returned verbatim.
   */
  text: string;
  decision: ChatPostGateDecision;
}

/**
 * Strip CHAT_POST markers from `finalText` when the gate fires (=
 * `hasUnresolvedSpeakers=true`). Equivalent to Python
 * `_strip_chat_post_on_unresolved` (cma_gchat_bot.py:1652) which
 * delegates to `_strip_marker_on_gate` (l.1444) with `gate=has_unresolved`
 * and `empty_fallback=CHAT_POST_UNRESOLVED_EMPTY_FALLBACK`.
 *
 * Contract:
 *   - `hasUnresolvedSpeakers=false` → return `{ text: finalText, decision: { gate: false, reason: 'n/a' } }`
 *     (= input verbatim, no `.trim()` applied — Python `_strip_marker_on_gate`
 *      line 1461-1462 short-circuits on `not gate`)
 *   - `hasUnresolvedSpeakers=true`  → return text with all CHAT_POST
 *     markers stripped + trimmed; if the result is empty, replace with
 *     the unresolved fallback literal; `decision = { gate: true, reason: 'unresolved' }`
 *
 * The gate decision itself comes from `computeChatPostGate` (single
 * source of truth in `speaker-resolver.ts`); this helper just adds the
 * side-effect on `finalText`.
 */
export function applyChatPostGateToText(
  finalText: string,
  hasUnresolvedSpeakers: boolean,
): ChatPostGateApplication {
  const decision = computeChatPostGate(hasUnresolvedSpeakers);
  if (!decision.gate) {
    return { text: finalText, decision };
  }
  // Python `_CHAT_POST_MARKER_REGEX.sub('', final_text).strip()` —
  // re.sub replaces ALL matches; JS `.replace(regex, '')` only replaces
  // the first unless `g` flag is set. Mirror Python by using a fresh
  // global regex (don't mutate the shared regex's `lastIndex`).
  const globalMarker = new RegExp(CHAT_POST_MARKER_REGEX.source, 'g');
  let stripped = finalText.replace(globalMarker, '').trim();
  if (stripped === '') {
    stripped = CHAT_POST_UNRESOLVED_EMPTY_FALLBACK;
  }
  return { text: stripped, decision };
}

/**
 * Chat-event-handler-facing convenience: given an actor resolution
 * (actorTrusted + actorSource) AND a history meta (unresolved speaker
 * count from `formatThreadHistoryWithMeta`), compute both the external-
 * tool gate decision AND the chat-post gate decision in one call.
 *
 * The two axes are independent (issue #161 separated them deliberately):
 *   - external tools (Drive / EMAIL_SEND / SCHEDULE_ACTION / Sheets /
 *     Cal) are gated on **actor trust** — history state does NOT matter
 *   - CHAT_POST is gated on **history-side unresolved speakers** —
 *     actor trust does NOT matter
 *
 * Returns both decisions so callers can wire up the dispatch logic
 * without re-importing both helpers.
 *
 * @param actorTrusted   — output of `resolveActorForGate(...)`. true when the
 *                          current-turn requester is mapping-resolved.
 * @param actorSource    — output of `resolveActorForGate(...)`. mapping /
 *                          chat_api / null (=  unresolved).
 * @param hasUnresolvedSpeakers — true when the thread history contains at
 *                                least one chat_user_id that the speaker
 *                                resolver could not identify (= surface
 *                                from `formatThreadHistoryWithMeta(...).unresolvedCount > 0`).
 */
export interface SpeakerGateDecisions {
  externalTool: ExternalToolGateDecision;
  chatPost: ChatPostGateDecision;
}

export function computeSpeakerGateDecisions(
  actorTrusted: boolean,
  actorSource: ResolvedSpeakerSource | null,
  hasUnresolvedSpeakers: boolean,
): SpeakerGateDecisions {
  return {
    externalTool: computeExternalToolGate(actorTrusted, actorSource),
    chatPost: computeChatPostGate(hasUnresolvedSpeakers),
  };
}
