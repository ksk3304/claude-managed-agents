/**
 * CHAT_POST marker — TS port of `cma_gchat_bot.py:_process_chat_post_marker`
 * (l.1793-1858) + `_resolve_chat_post_thread` (l.1262-1312) + the cap /
 * unresolved strip helpers (l.1469-1483 / l.1652-1662).
 *
 * The MAKOTOくん agent emits a marker line at the end of a reply:
 *
 *   CHAT_POST:{"space": "<alias>", "text": "<本文>", "thread": "<spec>"}
 *
 * - `space` (required): Chat space alias (resolver supplied by caller —
 *   Python uses `cma_gchat_send.resolve_space`)
 * - `text`  (required): non-empty body to post
 * - `thread` (optional): one of
 *     omitted / null         → post as a new thread
 *     "current"              → reply to the received thread (same space only)
 *     "spaces/<sid>/threads/<tid>" → explicit thread name; must share
 *                             `target_space`'s prefix (cross-space guard)
 *
 * The bot reads this marker AFTER the LLM turn completes and posts to
 * the resolved space/thread via the Chat REST API (`chat-api.ts`).
 *
 * Why this file is one cohesive lib (not three): parse → resolve →
 * execute share `ParsedChatPostMarker` as the central type, and the
 * gate helpers (`stripChatPostOnCap` / `stripChatPostOnUnresolved`)
 * key off the same regex. Splitting forces callers to import the same
 * vocabulary from multiple places without earning reuse — same call
 * the `speaker-resolver.ts` port made (commit c2acf19).
 *
 * Cross-space-untrusted gating (when an untrusted display-name-only
 * speaker sits in the thread) lives in `speaker-resolver.ts`
 * (`gateChatPostForCrossSpace`) — that helper consumes the same
 * `CHAT_POST_MARKER_REGEX` exported there. We re-export it here for
 * convenience but the source of truth is speaker-resolver.ts.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — port mapping v1 §1 row #19
 *                                  "CHAT_POST marker")
 * Spec: products/makoto-kun/specs/system-prompt-persona.md l.362-368
 * Source of truth (Python):
 *   - scripts/cma_gchat_bot.py l.1262-1312 (_resolve_chat_post_thread)
 *   - scripts/cma_gchat_bot.py l.1469-1483 (_strip_chat_post_on_cap)
 *   - scripts/cma_gchat_bot.py l.1652-1662 (_strip_chat_post_on_unresolved)
 *   - scripts/cma_gchat_bot.py l.1720          (_CHAT_POST_MARKER_REGEX)
 *   - scripts/cma_gchat_bot.py l.1793-1858 (_process_chat_post_marker)
 */

import type { ChatApiDeps, ChatMessageResult } from './chat-api';
import { postChatMessage } from './chat-api';
import {
  CHAT_POST_MARKER_REGEX,
  gateChatPostForCrossSpace,
  stripChatPostMarker,
} from './speaker-resolver';
import type { ChatPostThreadResolver } from './speaker-resolver';

export { CHAT_POST_MARKER_REGEX } from './speaker-resolver';

/**
 * Cap stop reasons that suppress CHAT_POST execution (mirror of
 * `cma_lib._CAP_STOP_REASONS`). These three correspond to:
 *   - `tool_call_cap`     — agent.tool_use ceiling hit
 *   - `max_iter`          — custom_tool_use roundtrip ceiling hit
 *   - `session_watchdog`  — session-level watchdog tripped
 *
 * Re-exported as a Set so callers can extend (Python's
 * `cma_lib._CAP_STOP_REASONS` is a frozenset). Membership check is the
 * authoritative gate — string equality only.
 */
export const CAP_STOP_REASONS: ReadonlySet<string> = new Set([
  'tool_call_cap',
  'max_iter',
  'session_watchdog',
]);

/**
 * Parsed CHAT_POST marker payload — validated shape of the JSON
 * literal after `CHAT_POST:`. `thread` is normalized to:
 *   - `undefined`              — field omitted or explicit null
 *   - `'current'`              — string literal, resolved at execute time
 *   - `string` (resource name) — `spaces/.../threads/...`
 *
 * Python keeps the raw dict; the TS port surfaces a typed view so
 * callers can branch on the discriminant without re-parsing.
 */
export interface ParsedChatPostMarker {
  /** Raw `space` field — caller resolves to a `spaces/...` resource name. */
  spaceAlias: string;
  /** Body text to post. */
  text: string;
  /** Thread spec — see ParsedChatPostMarker JSDoc for the value space. */
  thread?: 'current' | string;
  /** Source range of the marker substring in the assistant text. */
  range: { start: number; end: number };
}

export interface ParseChatPostMarkerFailure {
  /** Raw marker substring (including the `CHAT_POST:` prefix). */
  raw: string;
  reason: string;
}

/**
 * Find the (first) CHAT_POST marker in `finalText` and validate its
 * shape. Returns `null` if no marker is present. Throws nothing; shape
 * failures are surfaced as `ParseChatPostMarkerFailure` via the result
 * variant `parseChatPostMarkerDetailed`.
 *
 * Python regex `_CHAT_POST_MARKER_REGEX` matches the first occurrence
 * (single-line JSON, no embedded `\n`). We follow the same contract.
 */
export function parseChatPostMarker(
  finalText: string,
): ParsedChatPostMarker | null {
  const result = parseChatPostMarkerDetailed(finalText);
  return result.marker;
}

export interface ParseChatPostMarkerResult {
  /** Successfully parsed marker, or null if absent / shape-invalid. */
  marker: ParsedChatPostMarker | null;
  /** Set when a marker substring was present but shape validation failed. */
  failure: ParseChatPostMarkerFailure | null;
}

/**
 * Detailed variant — distinguishes "no marker" (`marker=null, failure=null`)
 * from "marker present but malformed" (`marker=null, failure=…`). Use
 * this when the caller wants to audit-log the agent's bad emission.
 */
export function parseChatPostMarkerDetailed(
  finalText: string,
): ParseChatPostMarkerResult {
  // Use a fresh regex so module-level `lastIndex` (if `g` flag were
  // added later) never leaks across calls. Currently CHAT_POST_MARKER_REGEX
  // is non-global; this is defensive.
  const re = new RegExp(CHAT_POST_MARKER_REGEX.source);
  const match = re.exec(finalText);
  if (!match) {
    return { marker: null, failure: null };
  }
  const raw = match[0]!;
  const jsonLiteral = match[1]!;
  let data: unknown;
  try {
    data = JSON.parse(jsonLiteral);
  } catch (exc) {
    return {
      marker: null,
      failure: {
        raw,
        reason: `CHAT_POST JSON parse: ${(exc as Error)?.message ?? String(exc)}`,
      },
    };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      marker: null,
      failure: {
        raw,
        reason: `CHAT_POST payload must be a JSON object (got ${describe(data)})`,
      },
    };
  }
  const obj = data as Record<string, unknown>;

  const spaceField = obj['space'];
  if (typeof spaceField !== 'string' || spaceField.trim() === '') {
    return {
      marker: null,
      failure: {
        raw,
        reason: `CHAT_POST.space must be a non-empty string (got ${describe(spaceField)})`,
      },
    };
  }

  const textField = obj['text'];
  if (typeof textField !== 'string' || textField.length === 0) {
    return {
      marker: null,
      failure: {
        raw,
        reason: `CHAT_POST.text must be a non-empty string (got ${describe(textField)})`,
      },
    };
  }

  const start = match.index;
  const end = match.index + raw.length;

  const marker: ParsedChatPostMarker = {
    spaceAlias: spaceField,
    text: textField,
    range: { start, end },
  };

  // `thread` is optional. Accept omitted (key absent) and explicit null
  // both as "new thread" (Python l.1282-1286). Reject non-string non-null.
  if ('thread' in obj && obj['thread'] !== null) {
    const threadField = obj['thread'];
    if (typeof threadField !== 'string' || threadField === '') {
      return {
        marker: null,
        failure: {
          raw,
          reason: `CHAT_POST.thread must be 'current' or 'spaces/<id>/threads/<id>' (got ${describe(threadField)})`,
        },
      };
    }
    marker.thread = threadField;
  }

  return { marker, failure: null };
}

/**
 * Resolved CHAT_POST target — `spaceName` + optional `threadName`.
 * `threadName === undefined` means "post as new thread".
 *
 * `mode` describes how the thread was resolved (mirrors the Python
 * `mode` log field at l.1839/1845): `current` = thread reply that
 * came from `thread: "current"`, `explicit` = `spaces/.../threads/...`
 * literal, `new` = no thread (top-level post).
 */
export interface ResolvedChatPostTarget {
  spaceName: string;
  threadName?: string;
  mode: 'new' | 'current' | 'explicit';
  /** True iff target_space + target_thread both match the received
   *  conversation (Python `is_self_thread`, l.1823-1827). Caller may
   *  use this to short-circuit a duplicate placeholder reply. */
  isSelfThread: boolean;
}

/**
 * Resolve the CHAT_POST `thread` spec to a Chat resource name.
 *
 * Throws on:
 *   - `thread === 'current'` but `receivedThreadName == null`
 *     (Python l.1292-1295)
 *   - `thread === 'current'` but `targetSpaceName !== receivedSpaceName`
 *     (Python l.1296-1300)
 *   - explicit `spaces/.../threads/...` not matching `targetSpaceName`
 *     prefix (Python l.1302-1311)
 *   - non-string / empty / malformed (caught earlier by
 *     `parseChatPostMarker`, but defensively re-checked)
 *
 * TS port of `_resolve_chat_post_thread`. The Python version takes
 * `chat_data: dict` + `target_space_name`; we take the already-parsed
 * marker + a resolved `targetSpaceName` (caller resolved the alias
 * upstream via `resolveSpaceAlias`).
 */
export function resolveChatPostThread(
  marker: ParsedChatPostMarker,
  targetSpaceName: string,
  receivedSpaceName: string,
  receivedThreadName: string | null,
): ResolvedChatPostTarget {
  const spec = marker.thread;
  // Field omitted / explicit null → new thread.
  if (spec === undefined) {
    return {
      spaceName: targetSpaceName,
      mode: 'new',
      isSelfThread: false,
    };
  }
  if (spec === 'current') {
    if (!receivedThreadName) {
      throw new Error(
        "CHAT_POST thread='current' 指定だが、受信メッセージにスレッド情報がない",
      );
    }
    if (targetSpaceName !== receivedSpaceName) {
      throw new Error(
        `CHAT_POST thread='current' は受信スペース (${receivedSpaceName}) でのみ有効。` +
          `target_space=${targetSpaceName} と不一致`,
      );
    }
    return {
      spaceName: targetSpaceName,
      threadName: receivedThreadName,
      mode: 'current',
      isSelfThread: targetSpaceName === receivedSpaceName,
    };
  }
  // Explicit `spaces/<sid>/threads/<tid>`.
  if (!spec.startsWith('spaces/') || !spec.includes('/threads/')) {
    throw new Error(
      `CHAT_POST thread は 'current' または 'spaces/<id>/threads/<id>' 形式: ${JSON.stringify(spec)}`,
    );
  }
  const expectedPrefix = `${targetSpaceName}/threads/`;
  if (!spec.startsWith(expectedPrefix)) {
    throw new Error(
      `CHAT_POST thread が target_space と不整合 (expected prefix ${JSON.stringify(expectedPrefix)}): ${JSON.stringify(spec)}`,
    );
  }
  return {
    spaceName: targetSpaceName,
    threadName: spec,
    mode: 'explicit',
    isSelfThread:
      targetSpaceName === receivedSpaceName && spec === receivedThreadName,
  };
}

/**
 * Strip CHAT_POST markers from `finalText` when a cap stop_reason fired.
 *
 * `stop_reason ∈ CAP_STOP_REASONS` → strip + (if empty) fall back to
 *   `（<stop_reason> のため出力なし）` (Python l.1482 byte-equivalent).
 * Otherwise → pass through unchanged.
 *
 * TS port of `_strip_chat_post_on_cap`.
 */
export function stripChatPostOnCap(
  finalText: string,
  stopReason: string,
): string {
  if (!CAP_STOP_REASONS.has(stopReason)) {
    return finalText;
  }
  // Use a fresh `g` regex — Python `re.sub` replaces ALL matches.
  const globalMarker = new RegExp(CHAT_POST_MARKER_REGEX.source, 'g');
  const stripped = finalText.replace(globalMarker, '').trim();
  if (stripped === '') {
    return `（${stopReason} のため出力なし）`;
  }
  return stripped;
}

/**
 * Strip CHAT_POST markers when a mapping-unresolved speaker sits in
 * the thread history. Fallback message is byte-equivalent to Python
 * l.1661.
 *
 * TS port of `_strip_chat_post_on_unresolved`.
 */
export function stripChatPostOnUnresolved(
  finalText: string,
  hasUnresolved: boolean,
): string {
  if (!hasUnresolved) {
    return finalText;
  }
  const globalMarker = new RegExp(CHAT_POST_MARKER_REGEX.source, 'g');
  const stripped = finalText.replace(globalMarker, '').trim();
  if (stripped === '') {
    return '（未登録ユーザー検知のため CHAT_POST 抑止、本文出力なし）';
  }
  return stripped;
}

/**
 * Re-export of the cross-space gate from speaker-resolver.ts so callers
 * can `import { ... } from './chat-post-marker'` cohesively. The
 * implementation lives in speaker-resolver.ts because it shares the
 * `ResolvedSpeaker` taxonomy.
 */
export { gateChatPostForCrossSpace, stripChatPostMarker };

/**
 * Dependencies injected into `executeChatPostMarker`.
 *
 * `resolveSpaceAlias` is the alias → `spaces/<id>` mapping (Python
 * `cma_gchat_send.resolve_space`). Throws on unknown alias; we catch
 * and surface as a result error.
 */
export interface ChatPostMarkerDeps extends ChatApiDeps {
  /** Alias → space resource name resolver (caller-supplied). */
  resolveSpaceAlias: (alias: string) => string;
}

/**
 * Execution result of `executeChatPostMarker`. `outcome` discriminates
 * the four cases mirroring Python l.1828-1858:
 *
 *   - `'posted'`       — Chat REST POST completed (`postedMessage` set)
 *   - `'self_thread_skipped'` — same-space same-thread; caller uses
 *     `marker.text` as the placeholder body. (Python l.1828-1834)
 *   - `'no_marker'`    — no CHAT_POST marker present; nothing to do.
 *   - `'failed'`       — parse / resolve / POST failed; `error` set.
 *
 * `cleanedText` is the assistant text with the marker stripped + a
 * status suffix appended (Python l.1853 / l.1857). For `self_thread_skipped`
 * the suffix is omitted (Python returns `chat_data["text"]` directly).
 */
export type ExecuteChatPostOutcome =
  | 'posted'
  | 'self_thread_skipped'
  | 'no_marker'
  | 'failed';

export interface ExecuteChatPostMarkerResult {
  outcome: ExecuteChatPostOutcome;
  /** Modified final_text the caller should send/persist. */
  cleanedText: string;
  /** Set when `outcome === 'posted'`. */
  postedMessage?: ChatMessageResult;
  /** Resolved target — set for `posted` / `self_thread_skipped` / `failed` */
  target?: ResolvedChatPostTarget;
  /** Set when `outcome === 'failed'`. */
  error?: Error;
  /** Set when `outcome === 'failed'` due to shape validation. */
  parseFailure?: ParseChatPostMarkerFailure;
}

export interface ExecuteChatPostMarkerOptions {
  /** Received space (Python `space_name` arg). */
  receivedSpaceName: string;
  /** Received thread name; null for top-level events. */
  receivedThreadName: string | null;
}

/**
 * Process a CHAT_POST marker end-to-end: parse → resolve thread →
 * post (or skip if self-thread). Returns the modified assistant text
 * + the outcome discriminant.
 *
 * Failures are surfaced as `outcome: 'failed'` (Python catches at
 * l.1855 and appends `❌ Chat 投稿失敗: {exc}`); we never rethrow so
 * the caller doesn't have to wrap in try/catch.
 *
 * TS port of `_process_chat_post_marker`. Does NOT call the cap /
 * unresolved gates first — those run upstream (see
 * `stripChatPostOnCap` / `stripChatPostOnUnresolved` /
 * `gateChatPostForCrossSpace`).
 */
export async function executeChatPostMarker(
  deps: ChatPostMarkerDeps,
  finalText: string,
  options: ExecuteChatPostMarkerOptions,
): Promise<ExecuteChatPostMarkerResult> {
  const parsed = parseChatPostMarkerDetailed(finalText);
  if (!parsed.marker && !parsed.failure) {
    return { outcome: 'no_marker', cleanedText: finalText };
  }
  if (parsed.failure) {
    // Marker present but malformed — Python l.1855 path. Strip the
    // marker substring (best effort: it matched the regex even though
    // JSON shape failed; the regex matched against `parsed.failure.raw`).
    const prefix = finalText.split(parsed.failure.raw)[0] ?? '';
    return {
      outcome: 'failed',
      cleanedText: `${prefix.trim()}\n\n❌ Chat 投稿失敗: ${parsed.failure.reason}`,
      error: new Error(parsed.failure.reason),
      parseFailure: parsed.failure,
    };
  }
  const marker = parsed.marker!;
  let targetSpace: string;
  try {
    targetSpace = deps.resolveSpaceAlias(marker.spaceAlias);
  } catch (exc) {
    const err = exc as Error;
    const prefix = finalText.slice(0, marker.range.start);
    return {
      outcome: 'failed',
      cleanedText: `${prefix.trim()}\n\n❌ Chat 投稿失敗: ${err.message ?? String(exc)}`,
      error: err,
    };
  }

  let target: ResolvedChatPostTarget;
  try {
    target = resolveChatPostThread(
      marker,
      targetSpace,
      options.receivedSpaceName,
      options.receivedThreadName,
    );
  } catch (exc) {
    const err = exc as Error;
    const prefix = finalText.slice(0, marker.range.start);
    return {
      outcome: 'failed',
      cleanedText: `${prefix.trim()}\n\n❌ Chat 投稿失敗: ${err.message ?? String(exc)}`,
      error: err,
    };
  }

  // Self-thread short-circuit (Python l.1823-1834). Caller is
  // expected to feed `marker.text` through the placeholder PATCH
  // path so we don't double-post.
  if (target.isSelfThread) {
    console.log(
      `[gchat] CHAT_POST self-thread skip space=${target.spaceName} ` +
        `alias=${JSON.stringify(marker.spaceAlias)} text_chars=${marker.text.length}`,
    );
    return {
      outcome: 'self_thread_skipped',
      cleanedText: marker.text,
      target,
    };
  }

  // Actual POST.
  try {
    const posted = await postChatMessage(
      deps,
      target.spaceName,
      marker.text,
      target.threadName ? { threadName: target.threadName } : {},
    );
    const modeLabel = target.threadName ? ' (thread reply)' : '';
    const prefix = finalText.slice(0, marker.range.start).trim();
    const summary =
      `${prefix ? `${prefix}\n\n` : ''}` +
      `✅ Chat 投稿完了${modeLabel}\nスペース: ${marker.spaceAlias}`;
    console.log(
      `[gchat] CHAT_POST posted space=${target.spaceName} ` +
        `alias=${JSON.stringify(marker.spaceAlias)} resource=${posted.name} ` +
        `mode=${target.mode === 'new' ? 'new_thread' : 'thread_reply'}`,
    );
    return {
      outcome: 'posted',
      cleanedText: summary,
      postedMessage: posted,
      target,
    };
  } catch (exc) {
    const err = exc as Error;
    const prefix = finalText.slice(0, marker.range.start).trim();
    return {
      outcome: 'failed',
      cleanedText: `${prefix}\n\n❌ Chat 投稿失敗: ${err.message ?? String(exc)}`,
      error: err,
      target,
    };
  }
}

/**
 * Re-export of the cross-space gate's thread resolver type — callers
 * wiring `gateChatPostForCrossSpace` can use ours instead of importing
 * from two places.
 */
export type { ChatPostThreadResolver };

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
