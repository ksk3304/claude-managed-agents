/**
 * Unit tests for `src/lib/speaker-resolver.ts` — port-mapping v1 §1
 * row #26 ("Speaker resolution + gate"). Mirrors the Python tests for
 * `_resolve_actor_for_gate` / `_compute_chat_post_gate` / `_gate_chat_post_for_cross_space` /
 * `_unresolved_speakers_notice_prefix` and the result-type invariants
 * from `cma_session_resolver.py` (`ResolvedSpeaker.trusted_for_external_tools`,
 * `SpeakerResolutionReport.has_chat_api_speakers`).
 *
 * Pure-logic, no fetch / I/O — `makeFetchMock` not needed.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CHAT_POST_MARKER_REGEX,
  UNRESOLVED_NOTICE_MESSAGE,
  computeChatPostGate,
  gateChatPostForCrossSpace,
  hasChatApiSpeakers,
  makeResolvedSpeaker,
  resolveActorForGate,
  stripChatPostMarker,
  unresolvedSpeakersNoticePrefix,
} from '../src/lib/speaker-resolver';
import type {
  ResolvedSpeaker,
  SpeakerResolutionReport,
  SpeakerResolverFn,
} from '../src/lib/speaker-resolver';

// ---------------------------------------------------------------- fixtures

function mappingSpeaker(overrides: Partial<ResolvedSpeaker> = {}): ResolvedSpeaker {
  return makeResolvedSpeaker({
    chatUserId: 'users/111',
    displayName: '瀬戸 恵介',
    source: 'mapping',
    senderType: 'HUMAN',
    ...overrides,
  });
}

function chatApiSpeaker(overrides: Partial<ResolvedSpeaker> = {}): ResolvedSpeaker {
  return makeResolvedSpeaker({
    chatUserId: 'users/222',
    displayName: '田中 太郎',
    source: 'chat_api',
    senderType: 'HUMAN',
    ...overrides,
  });
}

// ---------------------------------------------------------------- makeResolvedSpeaker / invariants

describe('makeResolvedSpeaker', () => {
  it('sets trustedForExternalTools=true iff source=mapping', () => {
    expect(mappingSpeaker().trustedForExternalTools).toBe(true);
    expect(chatApiSpeaker().trustedForExternalTools).toBe(false);
  });

  it('preserves all input fields', () => {
    const s = mappingSpeaker({ chatUserId: 'users/xyz', displayName: 'X' });
    expect(s.chatUserId).toBe('users/xyz');
    expect(s.displayName).toBe('X');
    expect(s.senderType).toBe('HUMAN');
    expect(s.source).toBe('mapping');
  });

  it('respects BOT sender type independent of trust', () => {
    const bot = mappingSpeaker({ senderType: 'BOT' });
    expect(bot.senderType).toBe('BOT');
    expect(bot.trustedForExternalTools).toBe(true); // mapping override-able by source
  });
});

describe('hasChatApiSpeakers', () => {
  it('returns true when any resolved speaker has source=chat_api', () => {
    const report: SpeakerResolutionReport = {
      historyMd: '',
      resolvedSpeakers: [mappingSpeaker(), chatApiSpeaker()],
      unresolvedChatUserIds: [],
    };
    expect(hasChatApiSpeakers(report)).toBe(true);
  });

  it('returns false when all speakers are mapping', () => {
    const report: SpeakerResolutionReport = {
      historyMd: '',
      resolvedSpeakers: [mappingSpeaker(), mappingSpeaker({ chatUserId: 'u/2' })],
      unresolvedChatUserIds: [],
    };
    expect(hasChatApiSpeakers(report)).toBe(false);
  });

  it('returns false on empty resolved list', () => {
    const report: SpeakerResolutionReport = {
      historyMd: '',
      resolvedSpeakers: [],
      unresolvedChatUserIds: ['users/zz'],
    };
    expect(hasChatApiSpeakers(report)).toBe(false);
  });
});

// ---------------------------------------------------------------- unresolvedSpeakersNoticePrefix

describe('unresolvedSpeakersNoticePrefix', () => {
  it('emits banner + double newline when showNotice=true', () => {
    const prefix = unresolvedSpeakersNoticePrefix(true);
    expect(prefix).toBe(`${UNRESOLVED_NOTICE_MESSAGE}\n\n`);
  });

  it('emits empty string when showNotice=false', () => {
    expect(unresolvedSpeakersNoticePrefix(false)).toBe('');
  });

  it('banner literal is byte-equivalent to Python _UNRESOLVED_NOTICE_MESSAGE', () => {
    // Python literal at scripts/cma_gchat_bot.py l.1534-1537 — exact match required
    // because .claude/rules/ danger-word checks key on this string.
    expect(UNRESOLVED_NOTICE_MESSAGE).toBe(
      '⚠️ 参加者の本人確認が取れなかったため、外部ツール (メール送信 / CHAT_POST / ' +
        'SCHEDULE_ACTION / Drive 参照 / Calendar 参照 / Sheets 操作) の操作は行いませんでした。',
    );
  });
});

// ---------------------------------------------------------------- resolveActorForGate

describe('resolveActorForGate', () => {
  it('returns (null, false, null) when resolver is null', () => {
    const r = resolveActorForGate(null, 'users/1', 'HUMAN');
    expect(r).toEqual({ actor: null, actorTrusted: false, actorSource: null });
  });

  it('returns trusted result when resolver returns a mapping speaker', () => {
    const resolver: SpeakerResolverFn = () => mappingSpeaker();
    const r = resolveActorForGate(resolver, 'users/1', 'HUMAN');
    expect(r.actor).not.toBeNull();
    expect(r.actorTrusted).toBe(true);
    expect(r.actorSource).toBe('mapping');
  });

  it('returns untrusted result when resolver returns a chat_api speaker', () => {
    const resolver: SpeakerResolverFn = () => chatApiSpeaker();
    const r = resolveActorForGate(resolver, 'users/2', 'HUMAN');
    expect(r.actor).not.toBeNull();
    expect(r.actorTrusted).toBe(false);
    expect(r.actorSource).toBe('chat_api');
  });

  it('returns (null, false, null) when resolver returns null (unresolved)', () => {
    const resolver: SpeakerResolverFn = () => null;
    const r = resolveActorForGate(resolver, 'users/3', 'HUMAN');
    expect(r).toEqual({ actor: null, actorTrusted: false, actorSource: null });
  });

  it('catches resolver exception and degrades to untrusted (fail-safe)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const resolver: SpeakerResolverFn = () => {
      throw new Error('chat API timeout');
    };
    const r = resolveActorForGate(resolver, 'users/4', 'HUMAN');
    expect(r).toEqual({ actor: null, actorTrusted: false, actorSource: null });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toMatch(/resolver threw, treating as unresolved/);
    errSpy.mockRestore();
  });

  it('passes spaceName + apiResolver through to the resolver', () => {
    const resolver = vi.fn<SpeakerResolverFn>(() => mappingSpeaker());
    const fakeApi = { kind: 'fake-api-resolver' };
    resolveActorForGate(resolver, 'users/5', 'HUMAN', {
      spaceName: 'spaces/AAA',
      apiResolver: fakeApi,
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith({
      senderName: 'users/5',
      senderType: 'HUMAN',
      spaceName: 'spaces/AAA',
      apiResolver: fakeApi,
    });
  });

  it('defaults spaceName to null and apiResolver to undefined when not supplied', () => {
    const resolver = vi.fn<SpeakerResolverFn>(() => mappingSpeaker());
    resolveActorForGate(resolver, 'users/6', 'BOT');
    expect(resolver).toHaveBeenCalledWith({
      senderName: 'users/6',
      senderType: 'BOT',
      spaceName: null,
      apiResolver: undefined,
    });
  });
});

// ---------------------------------------------------------------- computeChatPostGate

describe('computeChatPostGate', () => {
  it('gates when there are unresolved speakers in history', () => {
    expect(computeChatPostGate(true)).toEqual({ gate: true, reason: 'unresolved' });
  });

  it('does not gate when history is clean (no unresolved)', () => {
    expect(computeChatPostGate(false)).toEqual({ gate: false, reason: 'n/a' });
  });
});

// ---------------------------------------------------------------- stripChatPostMarker

describe('stripChatPostMarker', () => {
  it('removes the marker and trims surrounding whitespace', () => {
    const text = 'こんにちは\n\nCHAT_POST:{"space":"alias","text":"hi"}\n\n以上';
    const out = stripChatPostMarker(text, 'n/a');
    expect(out).not.toContain('CHAT_POST:');
    expect(out).toContain('こんにちは');
    expect(out).toContain('以上');
  });

  it('uses cross_space_untrusted fallback when stripping results in empty string', () => {
    const text = 'CHAT_POST:{"space":"x","text":"y"}';
    const out = stripChatPostMarker(text, 'cross_space_untrusted');
    expect(out).toBe('（未確認ユーザー混在のため別 space への CHAT_POST 抑止、本文出力なし）');
  });

  it('uses parse_failed_untrusted fallback when empty after strip', () => {
    const text = 'CHAT_POST:{"space":"x"}';
    const out = stripChatPostMarker(text, 'parse_failed_untrusted');
    expect(out).toBe('（CHAT_POST 解析失敗かつ未確認ユーザー混在のため抑止、本文出力なし）');
  });

  it('uses generic fallback for unknown reason when empty after strip', () => {
    const text = 'CHAT_POST:{"space":"x"}';
    const out = stripChatPostMarker(text, 'something_else');
    expect(out).toBe('（CHAT_POST 抑止、本文出力なし）');
  });

  it('strips markers on separate lines (multi-line g-flag parity with Python re.sub)', () => {
    // 単一行内に複数 marker は AI 出力 spec 上ない (CHAT_POST_MARKER_REGEX の
    // `[^\n]+` が貪欲なので最初の `{` から最後の `}` まで一気に食う = Python
    // と同挙動)。複数行に分かれた場合は g-flag で全 strip されることだけ確認。
    const text =
      'A\nCHAT_POST:{"space":"x","text":"1"}\nB\nCHAT_POST:{"space":"y","text":"2"}\nC';
    const out = stripChatPostMarker(text, 'n/a');
    expect(out).not.toContain('CHAT_POST:');
    expect(out).toContain('A');
    expect(out).toContain('B');
    expect(out).toContain('C');
  });
});

// ---------------------------------------------------------------- gateChatPostForCrossSpace

const RECEIVED_SPACE = 'spaces/AAA';
const RECEIVED_THREAD: string | null = 'spaces/AAA/threads/T1';

function passThroughResolveSpace(alias: string): string {
  // Identity alias resolver: alias "AAA" → "spaces/AAA"
  if (!alias.startsWith('spaces/')) return `spaces/${alias}`;
  return alias;
}

function noopThreadResolver(): string | null {
  return null;
}

describe('gateChatPostForCrossSpace', () => {
  it('returns n/a when there are no untrusted speakers', () => {
    const text = 'CHAT_POST:{"space":"BBB","text":"hi"}';
    const r = gateChatPostForCrossSpace(text, false, RECEIVED_SPACE, RECEIVED_THREAD, {
      resolveSpace: passThroughResolveSpace,
      resolveChatPostThread: noopThreadResolver,
    });
    expect(r).toEqual({ newFinalText: text, reason: 'n/a' });
  });

  it('returns n/a when there is no CHAT_POST marker in text', () => {
    const text = 'plain reply with no marker';
    const r = gateChatPostForCrossSpace(text, true, RECEIVED_SPACE, RECEIVED_THREAD, {
      resolveSpace: passThroughResolveSpace,
      resolveChatPostThread: noopThreadResolver,
    });
    expect(r).toEqual({ newFinalText: text, reason: 'n/a' });
  });

  it('classifies broken JSON as parse_failed_untrusted', () => {
    const text = 'reply CHAT_POST:{not-json,broken=}';
    const r = gateChatPostForCrossSpace(text, true, RECEIVED_SPACE, RECEIVED_THREAD, {
      resolveSpace: passThroughResolveSpace,
      resolveChatPostThread: noopThreadResolver,
    });
    expect(r.reason).toBe('parse_failed_untrusted');
    expect(r.newFinalText).not.toContain('CHAT_POST:');
  });

  it('classifies missing space field as parse_failed_untrusted', () => {
    const text = 'reply CHAT_POST:{"text":"hi"}';
    const r = gateChatPostForCrossSpace(text, true, RECEIVED_SPACE, RECEIVED_THREAD, {
      resolveSpace: passThroughResolveSpace,
      resolveChatPostThread: noopThreadResolver,
    });
    expect(r.reason).toBe('parse_failed_untrusted');
  });

  it('classifies resolveSpace exception as parse_failed_untrusted', () => {
    const text = 'reply CHAT_POST:{"space":"UNKNOWN","text":"hi"}';
    const r = gateChatPostForCrossSpace(text, true, RECEIVED_SPACE, RECEIVED_THREAD, {
      resolveSpace: () => {
        throw new Error('alias not registered');
      },
      resolveChatPostThread: noopThreadResolver,
    });
    expect(r.reason).toBe('parse_failed_untrusted');
  });

  it('classifies target_space !== received_space as cross_space_untrusted', () => {
    const text = 'reply CHAT_POST:{"space":"BBB","text":"hi"}';
    const r = gateChatPostForCrossSpace(text, true, RECEIVED_SPACE, RECEIVED_THREAD, {
      resolveSpace: passThroughResolveSpace, // "BBB" → "spaces/BBB"
      resolveChatPostThread: noopThreadResolver,
    });
    expect(r.reason).toBe('cross_space_untrusted');
    expect(r.newFinalText).not.toContain('CHAT_POST:');
  });

  it('classifies same-space but thread spec invalid as cross_space_untrusted', () => {
    const text = `reply CHAT_POST:{"space":"AAA","text":"hi","thread":"current"}`;
    const r = gateChatPostForCrossSpace(text, true, RECEIVED_SPACE, RECEIVED_THREAD, {
      resolveSpace: passThroughResolveSpace, // "AAA" → "spaces/AAA" = received
      resolveChatPostThread: () => {
        throw new Error("thread='current' invalid here");
      },
    });
    expect(r.reason).toBe('cross_space_untrusted');
    expect(r.newFinalText).not.toContain('CHAT_POST:');
  });

  it('returns n/a (no modification) when same space and thread spec is valid', () => {
    const text = 'reply CHAT_POST:{"space":"AAA","text":"hi"}';
    const r = gateChatPostForCrossSpace(text, true, RECEIVED_SPACE, RECEIVED_THREAD, {
      resolveSpace: passThroughResolveSpace,
      resolveChatPostThread: () => RECEIVED_THREAD,
    });
    expect(r).toEqual({ newFinalText: text, reason: 'n/a' });
  });
});

// ---------------------------------------------------------------- CHAT_POST_MARKER_REGEX sanity

describe('CHAT_POST_MARKER_REGEX', () => {
  it('captures the JSON literal between CHAT_POST: and the next newline', () => {
    const m = 'prefix CHAT_POST:{"space":"x","text":"y"} suffix'.match(
      CHAT_POST_MARKER_REGEX,
    );
    expect(m).not.toBeNull();
    expect(m![1]).toBe('{"space":"x","text":"y"}');
  });

  it('does not match across newlines (single-line marker only)', () => {
    const m = 'CHAT_POST:{"space"\n:"x"}'.match(CHAT_POST_MARKER_REGEX);
    // The `[^\n]+` body cannot cross newlines — must not capture.
    expect(m).toBeNull();
  });
});
