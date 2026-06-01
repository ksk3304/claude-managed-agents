/**
 * Speaker resolution + gate computation — TS port of the gate-side
 * helpers in `scripts/cma_gchat_bot.py` (around l.1557-1790) plus the
 * supporting result types from `scripts/cma_session_resolver.py`
 * (`ResolvedSpeaker` / `SpeakerResolutionReport` / `ChatApiResolveResult`).
 *
 * These are the pure speaker-resolution primitives that decide:
 *   1. whether the ⚠️ "本人確認が取れなかった" notice should be prepended
 *      to a Chat reply (`unresolvedSpeakersNoticePrefix`)
 *   2. who the current-turn actor is and whether they're mapping-trusted
 *      (`resolveActorForGate`)
 *   3. whether the CHAT_POST sink should be wholly stripped because the
 *      thread contains an unresolved speaker (`computeChatPostGate`)
 *   4. cross-space CHAT_POST gating when the thread has untrusted (but
 *      display-name-resolved) speakers (`gateChatPostForCrossSpace`)
 *
 * Why this is one file rather than five: the helpers form one tight
 * decision tree — actor trust and untrusted-but-resolved speakers feed the
 * cross-space gate, and they all share the
 * same `ResolvedSpeaker` / `SpeakerResolutionReport` vocabulary. Splitting
 * across files would force callers to import the same types from three
 * places without earning any reuse.
 *
 * Side-effect-free + injection-only: the cross-space helper takes the
 * Chat alias resolver as a callback (Python imports `cma_gchat_send`
 * directly; the TS port injects the equivalent so tests don't have to
 * stub a module). No `fetch`, no I/O.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — port mapping v1 §1 row #26
 *                                  "Speaker resolution + gate")
 * Source of truth (Python):
 *   - scripts/cma_gchat_bot.py l.1527-1564 (notice prefix + banner literal)
 *   - scripts/cma_gchat_bot.py l.1567-1635 (actor resolve)
 *   - scripts/cma_gchat_bot.py l.1638-1649 (chat-post gate)
 *   - scripts/cma_gchat_bot.py l.1740-1790 (cross-space chat-post gate)
 *   - scripts/cma_session_resolver.py l.67-126 (result types)
 */

/**
 * `spaces.members.get` 呼出結果の HTTP / 例外分類 (issue #92).
 *
 * Mirrors `ChatApiResolveStatus` Literal in `cma_session_resolver.py`.
 */
export type ChatApiResolveStatus =
  | 'ok'
  | '404'
  | '403'
  | '401'
  | '429'
  | 'timeout'
  | 'network';

/**
 * `spaces.members.get` 呼出結果の構造化 metadata. Mirrors the
 * `ChatApiResolveResult` frozen dataclass in `cma_session_resolver.py`.
 *
 * - `displayName`: only set when `status === 'ok'`; null otherwise
 * - `retryAfterSeconds`: only set when `status === '429'` and Retry-After
 *   header was present; null otherwise
 */
export interface ChatApiResolveResult {
  displayName: string | null;
  status: ChatApiResolveStatus;
  retryAfterSeconds?: number | null;
}

/**
 * `ResolvedSpeakerSource`: where the speaker identity came from.
 *   - `mapping`: registered in `cma-user-mapping.json` — trusted for
 *     external tools (Drive / EMAIL_SEND / SCHEDULE_ACTION)
 *   - `chat_api`: only the display name is known (resolved via
 *     `spaces.members.get`); NOT trusted for external tools, only for
 *     same-space CHAT_POST replies
 */
export type ResolvedSpeakerSource = 'mapping' | 'chat_api';

/** `HUMAN` user / `BOT` user — same Literal as the Python source. */
export type ResolvedSpeakerSenderType = 'HUMAN' | 'BOT';

/**
 * 話者識別の構造化結果 (issue #92).
 *
 * `trustedForExternalTools` is the boundary for Drive / EMAIL_SEND /
 * SCHEDULE_ACTION — true only when `source === 'mapping'`. Python uses
 * a `@property` on the dataclass; TS port surfaces it as a plain field
 * computed by the constructor helper below.
 */
export interface ResolvedSpeaker {
  chatUserId: string;
  displayName: string;
  source: ResolvedSpeakerSource;
  senderType: ResolvedSpeakerSenderType;
  /** Mirrors `ResolvedSpeaker.trusted_for_external_tools` (Python @property). */
  trustedForExternalTools: boolean;
}

/**
 * Construct a `ResolvedSpeaker` and pre-compute `trustedForExternalTools`
 * so callers (and the JSON deserializer) cannot drift the invariant.
 */
export function makeResolvedSpeaker(
  args: Omit<ResolvedSpeaker, 'trustedForExternalTools'>,
): ResolvedSpeaker {
  return {
    ...args,
    trustedForExternalTools: args.source === 'mapping',
  };
}

/**
 * `_format_thread_history` の結果集約 (issue #92, S4).
 *
 * - `historyMd`: bullet-list rendering of resolved speakers (with
 *   warning fence). Built upstream of this lib, surfaced as the
 *   prompt-side history snippet.
 * - `resolvedSpeakers`: speakers actually appearing in history (order
 *   preserved, duplicates kept).
 * - `unresolvedChatUserIds`: chat_user_ids that could not be resolved
 *   at all (de-duplicated, order preserved).
 */
export interface SpeakerResolutionReport {
  historyMd: string;
  resolvedSpeakers: ResolvedSpeaker[];
  unresolvedChatUserIds: string[];
}

/**
 * Helper mirroring `SpeakerResolutionReport.has_chat_api_speakers`
 * (Python @property). True iff any history speaker was resolved via
 * Chat API fallback (display-name-only).
 */
export function hasChatApiSpeakers(report: SpeakerResolutionReport): boolean {
  return report.resolvedSpeakers.some((s) => s.source === 'chat_api');
}

/**
 * The ⚠️ banner literal. **byte-equivalent** to
 * `_UNRESOLVED_NOTICE_MESSAGE` in `cma_gchat_bot.py` (l.1534-1537) — do
 * NOT translate or paraphrase. The literal is what `.claude/rules/`
 * danger-word checks key on.
 */
export const UNRESOLVED_NOTICE_MESSAGE =
  '⚠️ 参加者の本人確認が取れなかったため、外部ツール (メール送信 / CHAT_POST / ' +
  'SCHEDULE_ACTION / Drive 参照 / Calendar 参照 / Sheets 操作) の操作は行いませんでした。';

/**
 * 履歴に未登録者が実在 (`hasUnresolvedSpeakers`) AND 実際に外部ツールを
 * gate した (`gateExternalTools`) AND を呼出側で算出して `showNotice` に
 * 渡す。本関数は表示可否を判断せずフラグに従うのみ。
 *
 * Returns the prefix string (banner + `\n\n`) when shown, or empty
 * string otherwise. Caller prepends to `final_text` (Python:
 * `cma_gchat_bot.py` l.4506-4525 — banner is factually neutral on the
 * 履歴起因 vs actor起因 axis).
 *
 * TS port of `_unresolved_speakers_notice_prefix` (issue #161).
 */
export function unresolvedSpeakersNoticePrefix(showNotice: boolean): string {
  return showNotice ? `${UNRESOLVED_NOTICE_MESSAGE}\n\n` : '';
}

/**
 * Result tuple of `resolveActorForGate` — destructure as
 * `{ actor, actorTrusted, actorSource }`. Python returns a 3-tuple;
 * TS port surfaces it as an interface for clarity at the call site.
 */
export interface ActorResolution {
  actor: ResolvedSpeaker | null;
  actorTrusted: boolean;
  /** null when `actor === null` (resolver missing / threw / unresolved). */
  actorSource: ResolvedSpeakerSource | null;
}

/**
 * Resolver interface the TS port consumes — Python takes the concrete
 * `SessionCredentialResolver` instance, which exposes `resolve_speaker(
 * sender_name, sender_type, space_name=..., api_resolver=...)`. The TS
 * port flattens this to a single callable so callers can inject a
 * lambda (real resolver in prod, stub in tests).
 *
 * Returns the resolved speaker or null if the speaker cannot be
 * resolved at all. May throw; the gate helper below catches and treats
 * throws as "unresolved" (fail-safe — never widen).
 */
export type SpeakerResolverFn = (args: {
  senderName: string;
  senderType: string;
  spaceName?: string | null;
  apiResolver?: unknown;
}) => ResolvedSpeaker | null;

export interface ResolveActorForGateOptions {
  spaceName?: string | null;
  apiResolver?: unknown;
}

/**
 * 現ターンの指示主 (actor = 今 bot に依頼した本人) を resolver で解決し
 * (actor, actorTrusted, actorSource) を返す。
 *
 * Fail-safe contract (Python l.1588-1600 で同形):
 *   - resolver === null         → (null, false, null)
 *   - resolver throws           → (null, false, null) (console.error 出力)
 *   - resolver returns null     → (null, false, null)
 *   - resolver returns speaker  → (speaker, speaker.trustedForExternalTools,
 *                                   speaker.source)
 *
 * 緩める方向の fallback は一切しない (== 一度でも触れて落ちたら untrusted)。
 *
 * TS port of `_resolve_actor_for_gate` (issue #161).
 */
export function resolveActorForGate(
  resolver: SpeakerResolverFn | null,
  senderName: string,
  senderType: string,
  options: ResolveActorForGateOptions = {},
): ActorResolution {
  if (resolver === null) {
    return { actor: null, actorTrusted: false, actorSource: null };
  }
  let actor: ResolvedSpeaker | null = null;
  try {
    actor = resolver({
      senderName,
      senderType,
      spaceName: options.spaceName ?? null,
      apiResolver: options.apiResolver,
    });
  } catch (exc) {
    // Python uses traceback.print_exc(); TS equivalent is one structured
    // log line. We do NOT rethrow — caller already gated to untrusted.
    console.error(
      `[speaker-resolver] resolveActorForGate: resolver threw, treating as unresolved: ${
        (exc as Error)?.message ?? String(exc)
      }`,
    );
    actor = null;
  }
  if (actor === null) {
    return { actor: null, actorTrusted: false, actorSource: null };
  }
  return {
    actor,
    actorTrusted: actor.trustedForExternalTools,
    actorSource: actor.source,
  };
}

/**
 * CHAT_POST 全 strip gate の発動有無 + 理由 (issue #92, S5).
 *
 * CHAT_POST は mapping 未登録 speaker が履歴に居るときのみ全 strip。
 * chat_api fallback 解決時は本関数では gate せず (`n/a`)、S6 cross-space
 * gate (`gateChatPostForCrossSpace`) で個別判定する。
 *
 * TS port of `_compute_chat_post_gate`.
 */
export type ChatPostGateReason = 'unresolved' | 'n/a';

export interface ChatPostGateDecision {
  gate: boolean;
  reason: ChatPostGateReason;
}

export function computeChatPostGate(
  hasUnresolvedSpeakers: boolean,
): ChatPostGateDecision {
  if (hasUnresolvedSpeakers) {
    return { gate: true, reason: 'unresolved' };
  }
  return { gate: false, reason: 'n/a' };
}

/**
 * Regex equivalent to Python `_CHAT_POST_MARKER_REGEX`
 * (`r'CHAT_POST:(\{[^\n]+\})'`). Capture group 1 = the marker JSON
 * literal (single-line by current AI-output spec).
 */
export const CHAT_POST_MARKER_REGEX = /CHAT_POST:(\{[^\n]+\})/;

/**
 * Result of `gateChatPostForCrossSpace`. `newFinalText` is the (possibly
 * modified) reply text; `reason` is the structured-log classification.
 */
export type CrossSpaceGateReason =
  | 'n/a'
  | 'cross_space_untrusted'
  | 'parse_failed_untrusted';

export interface CrossSpaceGateResult {
  newFinalText: string;
  reason: CrossSpaceGateReason;
}

/**
 * Chat alias resolver injection. Python calls
 * `cma_gchat_send.resolve_space(alias)`; the TS port takes a callable
 * so test code can stub it without module patching.
 *
 * Must throw on alias resolution failure (Python `SystemExit` / `Exception`
 * — both are caught as `parse_failed_untrusted`).
 */
export type SpaceAliasResolver = (alias: string) => string;

/**
 * Chat thread resolver injection (Python `_resolve_chat_post_thread`).
 * Must throw on any inconsistency (cross-space `current` / malformed
 * spec / bad prefix). Throws are caught and classified as
 * `cross_space_untrusted` (Python l.1781-1789 等価).
 *
 * The TS port does NOT include a port of `_resolve_chat_post_thread`
 * itself — that's a separate row in the port mapping and would
 * duplicate the validation logic. Callers inject the live
 * implementation (or a stub in tests).
 */
export type ChatPostThreadResolver = (args: {
  chatData: Record<string, unknown>;
  receivedSpaceName: string;
  receivedThreadName: string | null;
  targetSpaceName: string;
}) => string | null;

/**
 * `_strip_chat_post_marker` 等価 (Python l.1723-1737). CHAT_POST マーカー
 * 除去 + reason 別 fallback 文言で空ケースを埋める. **byte 等価**:
 * fallback 文言は Python 側を逐語転記。
 */
export function stripChatPostMarker(
  finalText: string,
  reason: 'cross_space_untrusted' | 'parse_failed_untrusted' | string,
): string {
  // Python: `_CHAT_POST_MARKER_REGEX.sub('', final_text).strip()`
  // Note: Python re.sub replaces ALL matches; JS `.replace(regex, '')`
  // only replaces the first match unless `g` is set. Use a fresh
  // global regex so we don't mutate the shared one's `lastIndex`.
  const globalMarker = new RegExp(CHAT_POST_MARKER_REGEX.source, 'g');
  let stripped = finalText.replace(globalMarker, '').trim();
  if (stripped === '') {
    if (reason === 'cross_space_untrusted') {
      stripped = '（未確認ユーザー混在のため別 space への CHAT_POST 抑止、本文出力なし）';
    } else if (reason === 'parse_failed_untrusted') {
      stripped = '（CHAT_POST 解析失敗かつ未確認ユーザー混在のため抑止、本文出力なし）';
    } else {
      stripped = '（CHAT_POST 抑止、本文出力なし）';
    }
  }
  return stripped;
}

export interface CrossSpaceGateOptions {
  /** Chat alias → resource-name resolver (Python `cma_gchat_send.resolve_space`). */
  resolveSpace: SpaceAliasResolver;
  /** thread spec validator (Python `_resolve_chat_post_thread`). */
  resolveChatPostThread: ChatPostThreadResolver;
}

/**
 * untrusted (display-name-only) speaker 混在時、CHAT_POST が別 space を
 * 指す場合に marker を strip する (issue #92, S6).
 *
 * Behavior contract (Python l.1758-1790 と byte 等価):
 *   - `!hasUntrustedSpeakers`           → no-op, reason = 'n/a'
 *   - no CHAT_POST marker found         → no-op, reason = 'n/a'
 *   - JSON parse fail / resolveSpace 失敗 → strip + reason = 'parse_failed_untrusted'
 *   - parse OK & target_space !== received_space
 *                                       → strip + reason = 'cross_space_untrusted'
 *   - parse OK & same space but thread spec invalid (throw)
 *                                       → strip + reason = 'cross_space_untrusted'
 *   - all OK                            → no-op, reason = 'n/a'
 *
 * TS port of `_gate_chat_post_for_cross_space`.
 */
export function gateChatPostForCrossSpace(
  finalText: string,
  hasUntrustedSpeakers: boolean,
  receivedSpaceName: string,
  receivedThreadName: string | null,
  options: CrossSpaceGateOptions,
): CrossSpaceGateResult {
  if (!hasUntrustedSpeakers) {
    return { newFinalText: finalText, reason: 'n/a' };
  }
  const match = finalText.match(CHAT_POST_MARKER_REGEX);
  if (!match) {
    return { newFinalText: finalText, reason: 'n/a' };
  }

  // Phase 1: parse JSON + resolve target space.
  let chatData: Record<string, unknown>;
  let targetSpace: string;
  try {
    chatData = JSON.parse(match[1]!) as Record<string, unknown>;
    const spaceAlias = chatData['space'];
    if (typeof spaceAlias !== 'string') {
      throw new Error("CHAT_POST 'space' field missing or not a string");
    }
    targetSpace = options.resolveSpace(spaceAlias);
  } catch {
    return {
      newFinalText: stripChatPostMarker(finalText, 'parse_failed_untrusted'),
      reason: 'parse_failed_untrusted',
    };
  }

  // Phase 2: cross-space detection — target_space ≠ received_space.
  if (targetSpace !== receivedSpaceName) {
    return {
      newFinalText: stripChatPostMarker(finalText, 'cross_space_untrusted'),
      reason: 'cross_space_untrusted',
    };
  }

  // Phase 3: thread consistency check (same space but invalid thread spec
  // is still treated as cross-space-class inconsistency by Python l.1781).
  try {
    options.resolveChatPostThread({
      chatData,
      receivedSpaceName,
      receivedThreadName,
      targetSpaceName: targetSpace,
    });
  } catch {
    return {
      newFinalText: stripChatPostMarker(finalText, 'cross_space_untrusted'),
      reason: 'cross_space_untrusted',
    };
  }

  return { newFinalText: finalText, reason: 'n/a' };
}
