/**
 * Unit tests for `src/lib/chat-post-marker.ts` — port-mapping v1 §1
 * row #19 ("CHAT_POST marker"). Mirrors the Python tests for
 * `_resolve_chat_post_thread` / `_strip_chat_post_on_cap` /
 * `_strip_chat_post_on_unresolved` / `_process_chat_post_marker`
 * in `scripts/cma_gchat_bot.py`.
 *
 * The Chat REST POST is exercised by stubbing `postChatMessage` at the
 * fetch boundary (same pattern as `tests/chat-api.test.ts`) so we
 * never call Google in CI.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CHAT_POST_MARKER_REGEX,
  CAP_STOP_REASONS,
  executeChatPostMarker,
  parseChatPostMarker,
  parseChatPostMarkerDetailed,
  resolveChatPostThread,
  stripChatPostMarker,
  stripChatPostOnCap,
  stripChatPostOnUnresolved,
} from '../src/lib/chat-post-marker';
import type {
  ChatPostMarkerDeps,
  ParsedChatPostMarker,
} from '../src/lib/chat-post-marker';
import { _resetChatTokenCacheForTests } from '../src/lib/chat-api';
import { makeFetchMock } from './makoto-helpers';

// ---------------------------------------------------------------- fixtures

const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDMg3c8BYnUyuKy
/sE+hpSWDkzGpCSp4jkU7PEzl7z0ik36HN8m8wAv7OAjepJzMbi+hIOI+KYS7u8u
kKzH9R6qat3XtumMJJ/7C4azj9vvqlt0+hpfm/udtmqSvXq4szThcE5AlbD4sU1O
Up7qlgnaUsflxlyJ4Y+/ZKacFkNTJqYoxfM7rMwxgBc5zqrCCZp76Pypj+JIQ4O3
ZIewxBMVuyd5LDxrsNamXl7ENTga+1bBFQxdE6Zum6/oTLomhx94lwcgmTJX2GLx
q3HpxEpAaM29Og4sekRzYn/LYShN89mlwMai1kKtUwUZZnIDO0IW05rhtkxxUMsp
l9mAbJZvAgMBAAECggEABqKODL5CDkt8XVt5TRw0PkYKfmtQd5gYsZgaUmOUd5T0
TXszgvthQMZjlmMUoae16BOhtm2ytzlVoy7oaOuH6il7ajmYWO0BqU7JBcXscb/j
v02Z63FcRKECOVTr+7zWQcLqyjRqptB09jSLmVRZNeJEcyzwHAnbjjvat+rbYxtc
1juUqCPR568edUDfkMuZDBzJ3fRUhlYZDRwckeNpDiu83a6Gbyk8/lnn2HjUccvG
zcs2tOQTbVjZQB+7aeKqlvXR3nItIH03SFFR94M1nvsmmBlgoaDxIDsFrZQDion8
ad8SC6PFGHR1ZACc2iLD2IKoRvKUEnQsobtTxXSKqQKBgQDsbCD+g7kgP0ZhMStB
tYkhZBtLOP0Yxf6xkEqbWF7dypjn2aiSo/pFZkzvxyYDDY9vOlERAgxlIQQeDvVL
zmAiRqKH/P0dTTlQpfBa7D2UMXGLc3tEsDAnh6wr0Q8dAK8eVFPKLvmXKOdzo96s
3uI2hQkSchVbAyGxzJpUAxiBqwKBgQDdcuhe4AM45qn1FHIv/mtNFafv9aqwh4QC
ez46IBjzs06Tipbju0dkoV2Tl/XWH7hcLRBBwSHA5ysirCsni6ahfkoG8f+WDpn+
b/i/9ZtIr5YY1uifj4JMXNlHpgcRLuM8Qyjx0d7YU//yZmIgLCwET+sjtObSh/4i
EU9oKV7CTQKBgHBY5cjsgYGAcAppmhusj5CtiIbTevpVxDVO0xVFBjexOb4bYY7l
m111QqRC555VyE5b0QAbEBbSfKloBErUtDw1grDKmOFevBjF8hTS5GRSpplU9EPs
0cVHJJrhyqPGmnD4M6UFc5fQWURLn9pYQ/kSeQAp9Fn+f/mEt+WqXu/nAoGANPxm
jzTocHf4mJSA0ez9PZ995FOSuNRkCLf2ZrABaGYx2emiOvE3nuNhYYxNnSNP2HZL
2n/clKx7TLuHQ9oNT7zI96p1rjDmNdQS39NjiVvB/UWGuY777UuWDaezLzBZ3LRx
GpNNz9MhfZ1zwyDuk0WQDKYfSKaTbxFXP6QOcU0CgYBDS4hD1GHV+zMoJ/syRbeY
nm5ZxWUfP2OnCKT+sj+54DLHS53KwbquJRSNJBB4t/6IODAoStHfPpTLt18IfeQo
cmhs1W5d46A9bnEMLf/uZ/thauX8b771QGYLTDQMkgTlfTLsbnKcb4/XQ4iR4n/A
jFFa+31v/gSYzRUQMeyhUg==
-----END PRIVATE KEY-----`;

function fixtureSaKeyJson(): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'cma-bot-mp-20260501',
    private_key_id: 'fixture-kid',
    private_key: TEST_PRIVATE_KEY_PEM,
    client_email: 'cma-chat-bot@cma-bot-mp-20260501.iam.gserviceaccount.com',
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function tokenResponse(): Response {
  return jsonResponse(200, {
    access_token: 'test-access-token',
    expires_in: 3600,
    token_type: 'Bearer',
  });
}

const RECEIVED_SPACE = 'spaces/AAAreceived';
const RECEIVED_THREAD = 'spaces/AAAreceived/threads/TTT123';
const TARGET_SPACE_BY_ALIAS = 'spaces/BBBtarget';

function aliasResolver(map: Record<string, string> = {}) {
  return (alias: string): string => {
    if (alias in map) return map[alias]!;
    if (alias === 'received') return RECEIVED_SPACE;
    if (alias === 'target') return TARGET_SPACE_BY_ALIAS;
    throw new Error(`unknown alias: ${alias}`);
  };
}

beforeEach(() => {
  _resetChatTokenCacheForTests();
});

// ============================================================ parse

describe('parseChatPostMarker', () => {
  it('returns null when no marker is present', () => {
    expect(parseChatPostMarker('just text, nothing to post')).toBeNull();
  });

  it('parses a minimal marker (space + text only)', () => {
    const text =
      'preface\nCHAT_POST:{"space":"target","text":"hello"}';
    const m = parseChatPostMarker(text);
    expect(m).not.toBeNull();
    expect(m!.spaceAlias).toBe('target');
    expect(m!.text).toBe('hello');
    expect(m!.thread).toBeUndefined();
  });

  it('parses thread="current"', () => {
    const m = parseChatPostMarker(
      'CHAT_POST:{"space":"received","text":"hi","thread":"current"}',
    );
    expect(m!.thread).toBe('current');
  });

  it('parses explicit thread resource name', () => {
    const explicit = 'spaces/BBBtarget/threads/XYZ';
    const m = parseChatPostMarker(
      `CHAT_POST:{"space":"target","text":"hi","thread":"${explicit}"}`,
    );
    expect(m!.thread).toBe(explicit);
  });

  it('treats thread: null the same as omitted (new thread)', () => {
    const m = parseChatPostMarker(
      'CHAT_POST:{"space":"target","text":"hi","thread":null}',
    );
    expect(m!.thread).toBeUndefined();
  });

  it('records range pointing at the CHAT_POST: substring', () => {
    const prefix = 'before-text\n';
    const marker = 'CHAT_POST:{"space":"target","text":"hi"}';
    const m = parseChatPostMarker(prefix + marker);
    expect(m!.range.start).toBe(prefix.length);
    expect(m!.range.end).toBe(prefix.length + marker.length);
  });
});

describe('parseChatPostMarkerDetailed (failure paths)', () => {
  it('returns failure when JSON is malformed', () => {
    const r = parseChatPostMarkerDetailed('CHAT_POST:{not json here}');
    expect(r.marker).toBeNull();
    expect(r.failure).not.toBeNull();
    expect(r.failure!.reason).toMatch(/JSON parse/);
  });

  it('returns failure when space is missing', () => {
    const r = parseChatPostMarkerDetailed('CHAT_POST:{"text":"hi"}');
    expect(r.marker).toBeNull();
    expect(r.failure!.reason).toMatch(/space/);
  });

  it('returns failure when text is empty', () => {
    const r = parseChatPostMarkerDetailed(
      'CHAT_POST:{"space":"target","text":""}',
    );
    expect(r.marker).toBeNull();
    expect(r.failure!.reason).toMatch(/text/);
  });

  it('returns failure when thread is non-string non-null', () => {
    const r = parseChatPostMarkerDetailed(
      'CHAT_POST:{"space":"target","text":"hi","thread":123}',
    );
    expect(r.marker).toBeNull();
    expect(r.failure!.reason).toMatch(/thread/);
  });

  it('returns failure when payload is an array', () => {
    const r = parseChatPostMarkerDetailed('CHAT_POST:["a","b"]');
    expect(r.marker).toBeNull();
    // Array literal does not match the `\{...\}` regex, so this is a "no marker" case.
    expect(r.failure).toBeNull();
  });
});

// ============================================================ thread resolve

describe('resolveChatPostThread', () => {
  function mk(thread?: string): ParsedChatPostMarker {
    const m: ParsedChatPostMarker = {
      spaceAlias: 'target',
      text: 'hi',
      range: { start: 0, end: 1 },
    };
    if (thread !== undefined) m.thread = thread;
    return m;
  }

  it('thread omitted → new thread (mode=new, no isSelfThread)', () => {
    const r = resolveChatPostThread(
      mk(),
      TARGET_SPACE_BY_ALIAS,
      RECEIVED_SPACE,
      RECEIVED_THREAD,
    );
    expect(r.mode).toBe('new');
    expect(r.threadName).toBeUndefined();
    expect(r.isSelfThread).toBe(false);
  });

  it("thread='current' + target_space == received_space → resolves to received thread", () => {
    const r = resolveChatPostThread(
      mk('current'),
      RECEIVED_SPACE,
      RECEIVED_SPACE,
      RECEIVED_THREAD,
    );
    expect(r.mode).toBe('current');
    expect(r.threadName).toBe(RECEIVED_THREAD);
    expect(r.isSelfThread).toBe(true);
  });

  it("thread='current' + no received thread → throws", () => {
    expect(() =>
      resolveChatPostThread(mk('current'), RECEIVED_SPACE, RECEIVED_SPACE, null),
    ).toThrow(/受信メッセージにスレッド情報がない/);
  });

  it("thread='current' + cross-space → throws (誤投稿防止)", () => {
    expect(() =>
      resolveChatPostThread(
        mk('current'),
        TARGET_SPACE_BY_ALIAS,
        RECEIVED_SPACE,
        RECEIVED_THREAD,
      ),
    ).toThrow(/受信スペース/);
  });

  it('explicit valid thread within target space → resolves', () => {
    const explicit = `${TARGET_SPACE_BY_ALIAS}/threads/EXPLICIT`;
    const r = resolveChatPostThread(
      mk(explicit),
      TARGET_SPACE_BY_ALIAS,
      RECEIVED_SPACE,
      RECEIVED_THREAD,
    );
    expect(r.mode).toBe('explicit');
    expect(r.threadName).toBe(explicit);
    expect(r.isSelfThread).toBe(false);
  });

  it('explicit thread with prefix mismatch → throws (cross-target guard)', () => {
    expect(() =>
      resolveChatPostThread(
        mk('spaces/OTHER/threads/X'),
        TARGET_SPACE_BY_ALIAS,
        RECEIVED_SPACE,
        RECEIVED_THREAD,
      ),
    ).toThrow(/target_space と不整合/);
  });

  it('explicit thread malformed (no /threads/) → throws', () => {
    expect(() =>
      resolveChatPostThread(
        mk('garbage/value'),
        TARGET_SPACE_BY_ALIAS,
        RECEIVED_SPACE,
        RECEIVED_THREAD,
      ),
    ).toThrow(/'current' または 'spaces\/<id>\/threads\/<id>'/);
  });

  it('explicit thread == received thread same space → isSelfThread=true', () => {
    const r = resolveChatPostThread(
      mk(RECEIVED_THREAD),
      RECEIVED_SPACE,
      RECEIVED_SPACE,
      RECEIVED_THREAD,
    );
    expect(r.isSelfThread).toBe(true);
  });
});

// ============================================================ cap / unresolved strip

describe('stripChatPostOnCap', () => {
  it('passes through when stop_reason not in CAP_STOP_REASONS', () => {
    const text = 'preface CHAT_POST:{"space":"a","text":"b"}';
    expect(stripChatPostOnCap(text, 'end_turn')).toBe(text);
  });

  it('strips marker on tool_call_cap (preserving prefix)', () => {
    const text =
      'visible body\nCHAT_POST:{"space":"a","text":"b"}';
    expect(stripChatPostOnCap(text, 'tool_call_cap')).toBe('visible body');
  });

  it('strips marker on max_iter / session_watchdog', () => {
    const text = 'CHAT_POST:{"space":"a","text":"b"}\nrest';
    expect(stripChatPostOnCap(text, 'max_iter')).toBe('rest');
    expect(stripChatPostOnCap(text, 'session_watchdog')).toBe('rest');
  });

  it('falls back to "（<stop_reason> のため出力なし）" when stripped to empty', () => {
    const text = 'CHAT_POST:{"space":"a","text":"b"}';
    expect(stripChatPostOnCap(text, 'tool_call_cap')).toBe(
      '（tool_call_cap のため出力なし）',
    );
  });

  it('CAP_STOP_REASONS contains the documented three', () => {
    expect(CAP_STOP_REASONS.has('tool_call_cap')).toBe(true);
    expect(CAP_STOP_REASONS.has('max_iter')).toBe(true);
    expect(CAP_STOP_REASONS.has('session_watchdog')).toBe(true);
  });
});

describe('stripChatPostOnUnresolved', () => {
  it('passes through when hasUnresolved=false', () => {
    const text = 'CHAT_POST:{"space":"a","text":"b"}';
    expect(stripChatPostOnUnresolved(text, false)).toBe(text);
  });

  it('strips marker when hasUnresolved=true', () => {
    const text = 'visible\nCHAT_POST:{"space":"a","text":"b"}';
    expect(stripChatPostOnUnresolved(text, true)).toBe('visible');
  });

  it('falls back to the documented Japanese message when empty', () => {
    expect(stripChatPostOnUnresolved('CHAT_POST:{"space":"a","text":"b"}', true)).toBe(
      '（未登録ユーザー検知のため CHAT_POST 抑止、本文出力なし）',
    );
  });
});

describe('stripChatPostMarker (re-export, reason variants)', () => {
  it('cross_space_untrusted fallback', () => {
    expect(
      stripChatPostMarker('CHAT_POST:{"space":"a","text":"b"}', 'cross_space_untrusted'),
    ).toContain('別 space への CHAT_POST 抑止');
  });
  it('parse_failed_untrusted fallback', () => {
    expect(
      stripChatPostMarker('CHAT_POST:{"space":"a","text":"b"}', 'parse_failed_untrusted'),
    ).toContain('CHAT_POST 解析失敗');
  });
});

// ============================================================ regex re-export

describe('CHAT_POST_MARKER_REGEX', () => {
  it('matches single-line JSON only (does not span newlines)', () => {
    const multi = 'CHAT_POST:{\n"space":"a"}';
    expect(new RegExp(CHAT_POST_MARKER_REGEX.source).test(multi)).toBe(false);
    const single = 'CHAT_POST:{"space":"a","text":"b"}';
    expect(new RegExp(CHAT_POST_MARKER_REGEX.source).test(single)).toBe(true);
  });
});

// ============================================================ executeChatPostMarker

describe('executeChatPostMarker', () => {
  function makeDeps(
    handler: (url: string, init: RequestInit) => Response,
    aliasMap: Record<string, string> = {},
  ): ChatPostMarkerDeps {
    return {
      saKeyJson: fixtureSaKeyJson(),
      fetchImpl: makeFetchMock((url, init) => handler(url, init)),
      resolveSpaceAlias: aliasResolver(aliasMap),
    };
  }

  it('no-op when no marker is present', async () => {
    const deps = makeDeps(() => new Response('should not be called', { status: 500 }));
    const text = 'just a normal reply';
    const r = await executeChatPostMarker(deps, text, {
      receivedSpaceName: RECEIVED_SPACE,
      receivedThreadName: RECEIVED_THREAD,
    });
    expect(r.outcome).toBe('no_marker');
    expect(r.cleanedText).toBe(text);
  });

  it('posts to a new thread in another space (mode=new)', async () => {
    let postCalled = false;
    const deps = makeDeps((url) => {
      if (url.includes('oauth2.googleapis.com')) return tokenResponse();
      if (url.includes(`${TARGET_SPACE_BY_ALIAS}/messages`)) {
        postCalled = true;
        return jsonResponse(200, {
          name: `${TARGET_SPACE_BY_ALIAS}/messages/MMM`,
          thread: { name: `${TARGET_SPACE_BY_ALIAS}/threads/NEW` },
        });
      }
      return new Response('not-mocked', { status: 500 });
    });
    const text =
      'prefix line\nCHAT_POST:{"space":"target","text":"hello-from-bot"}';
    const r = await executeChatPostMarker(deps, text, {
      receivedSpaceName: RECEIVED_SPACE,
      receivedThreadName: RECEIVED_THREAD,
    });
    expect(postCalled).toBe(true);
    expect(r.outcome).toBe('posted');
    expect(r.postedMessage?.name).toBe(`${TARGET_SPACE_BY_ALIAS}/messages/MMM`);
    expect(r.cleanedText).toContain('✅ Chat 投稿完了');
    expect(r.cleanedText).toContain('スペース: target');
    expect(r.cleanedText).toContain('prefix line');
    expect(r.target?.mode).toBe('new');
  });

  it('posts with thread reply when thread=explicit (mode=explicit)', async () => {
    const explicit = `${TARGET_SPACE_BY_ALIAS}/threads/EXP`;
    let lastBody: unknown = null;
    const deps = makeDeps((url, init) => {
      if (url.includes('oauth2.googleapis.com')) return tokenResponse();
      lastBody = JSON.parse(String(init.body));
      return jsonResponse(200, {
        name: `${TARGET_SPACE_BY_ALIAS}/messages/MMM2`,
      });
    });
    const text = `CHAT_POST:{"space":"target","text":"reply","thread":"${explicit}"}`;
    const r = await executeChatPostMarker(deps, text, {
      receivedSpaceName: RECEIVED_SPACE,
      receivedThreadName: RECEIVED_THREAD,
    });
    expect(r.outcome).toBe('posted');
    expect(r.cleanedText).toContain('(thread reply)');
    expect(r.target?.mode).toBe('explicit');
    expect(lastBody).toMatchObject({ text: 'reply', thread: { name: explicit } });
  });

  it('self-thread → skips POST and returns marker.text as cleanedText', async () => {
    let postCalled = false;
    const deps = makeDeps((url) => {
      postCalled = true;
      if (url.includes('oauth2.googleapis.com')) return tokenResponse();
      return jsonResponse(200, { name: 'should-not-happen' });
    });
    // thread='current' + alias resolves to RECEIVED_SPACE → self-thread.
    const text =
      'prefix should be discarded\n' +
      'CHAT_POST:{"space":"received","text":"only-this-body","thread":"current"}';
    const r = await executeChatPostMarker(deps, text, {
      receivedSpaceName: RECEIVED_SPACE,
      receivedThreadName: RECEIVED_THREAD,
    });
    expect(r.outcome).toBe('self_thread_skipped');
    expect(r.cleanedText).toBe('only-this-body');
    expect(postCalled).toBe(false);
    expect(r.target?.isSelfThread).toBe(true);
  });

  it('alias resolver throws → outcome=failed with ❌ Chat 投稿失敗', async () => {
    const deps = makeDeps(() => new Response('not-called', { status: 500 }));
    const text =
      'visible prefix\nCHAT_POST:{"space":"unknown-alias","text":"x"}';
    const r = await executeChatPostMarker(deps, text, {
      receivedSpaceName: RECEIVED_SPACE,
      receivedThreadName: RECEIVED_THREAD,
    });
    expect(r.outcome).toBe('failed');
    expect(r.cleanedText).toContain('❌ Chat 投稿失敗');
    expect(r.cleanedText).toContain('unknown-alias');
    expect(r.cleanedText).toContain('visible prefix');
  });

  it('thread inconsistency → outcome=failed', async () => {
    const deps = makeDeps(() => new Response('not-called', { status: 500 }));
    // thread='current' but alias resolves to a different space → resolve throws.
    const text =
      'preface\nCHAT_POST:{"space":"target","text":"x","thread":"current"}';
    const r = await executeChatPostMarker(deps, text, {
      receivedSpaceName: RECEIVED_SPACE,
      receivedThreadName: RECEIVED_THREAD,
    });
    expect(r.outcome).toBe('failed');
    expect(r.cleanedText).toContain('❌ Chat 投稿失敗');
  });

  it('chat REST POST 5xx → outcome=failed with error info', async () => {
    const deps = makeDeps((url) => {
      if (url.includes('oauth2.googleapis.com')) return tokenResponse();
      return new Response('boom', { status: 500 });
    });
    const text = 'CHAT_POST:{"space":"target","text":"x"}';
    const r = await executeChatPostMarker(deps, text, {
      receivedSpaceName: RECEIVED_SPACE,
      receivedThreadName: RECEIVED_THREAD,
    });
    expect(r.outcome).toBe('failed');
    expect(r.error).toBeDefined();
    expect(r.cleanedText).toContain('❌ Chat 投稿失敗');
  });

  it('marker present but malformed JSON → outcome=failed (parseFailure surfaced)', async () => {
    const deps = makeDeps(() => new Response('not-called', { status: 500 }));
    const text = 'CHAT_POST:{not-json-at-all}';
    const r = await executeChatPostMarker(deps, text, {
      receivedSpaceName: RECEIVED_SPACE,
      receivedThreadName: RECEIVED_THREAD,
    });
    expect(r.outcome).toBe('failed');
    expect(r.parseFailure).toBeDefined();
    expect(r.parseFailure!.reason).toMatch(/JSON parse/);
  });
});
