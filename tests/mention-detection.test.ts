/**
 * Unit tests for `src/lib/mention-detection.ts` — annotations-based
 * Google Chat mention detection / strip.
 *
 * Python 一次ソースとの parity を担保する (= `cma_gchat_bot.py:_is_for_bot`
 * / `_strip_mention`、Issue #186 既知 #9 + #10):
 *
 *   - annotations あり / なし
 *   - 複数 mention の正確な範囲除去
 *   - startIndex 末尾 (= 本文中 / 末尾 mention) の strip
 *   - substring false hit (= 本文に `@<displayName>` 文字列はあるが
 *     annotations に USER_MENTION が無い) で誤判定しないこと
 */

import { describe, it, expect } from 'vitest';
import {
  isMentioningBot,
  stripMentions,
  type ChatAnnotation,
} from '../src/lib/mention-detection';

// ----- fixtures
const BOT_USER_NAME = 'users/123456789';

function botMention(startIndex: number, length: number): ChatAnnotation {
  return {
    type: 'USER_MENTION',
    startIndex,
    length,
    userMention: { user: { type: 'BOT', name: BOT_USER_NAME } },
  };
}

function humanMention(
  startIndex: number,
  length: number,
  userName = 'users/9999',
): ChatAnnotation {
  return {
    type: 'USER_MENTION',
    startIndex,
    length,
    userMention: { user: { type: 'HUMAN', name: userName } },
  };
}

// =========================================================================
// isMentioningBot
// =========================================================================

describe('isMentioningBot', () => {
  it('annotations 無し → false (Python `_is_for_bot` の annotations 空ループ等価)', () => {
    expect(isMentioningBot(undefined, BOT_USER_NAME)).toBe(false);
    expect(isMentioningBot(null, BOT_USER_NAME)).toBe(false);
    expect(isMentioningBot([], BOT_USER_NAME)).toBe(false);
  });

  it('USER_MENTION + user.type=BOT → true (env BOT_USER_NAME 不問)', () => {
    const anns: ChatAnnotation[] = [botMention(0, 9)];
    // botUserName が空でも user.type='BOT' で先に true
    expect(isMentioningBot(anns, '')).toBe(true);
    expect(isMentioningBot(anns, BOT_USER_NAME)).toBe(true);
  });

  it('user.type が無くても user.name === botUserName → true (フォールバック判定)', () => {
    const anns: ChatAnnotation[] = [
      {
        type: 'USER_MENTION',
        startIndex: 0,
        length: 9,
        userMention: { user: { name: BOT_USER_NAME } },
      },
    ];
    expect(isMentioningBot(anns, BOT_USER_NAME)).toBe(true);
    // botUserName 不一致 → false
    expect(isMentioningBot(anns, 'users/different')).toBe(false);
  });

  it('USER_MENTION だが他人 (user.type=HUMAN、name 不一致) → false', () => {
    const anns: ChatAnnotation[] = [humanMention(0, 6, 'users/9999')];
    expect(isMentioningBot(anns, BOT_USER_NAME)).toBe(false);
  });

  it('複数 USER_MENTION のうち 1 つでも bot 該当 → true', () => {
    const anns: ChatAnnotation[] = [
      humanMention(0, 6, 'users/9999'),
      botMention(7, 9),
    ];
    expect(isMentioningBot(anns, BOT_USER_NAME)).toBe(true);
  });

  it('type が USER_MENTION 以外 (SLASH_COMMAND 等) → skip して判定影響なし', () => {
    const anns: ChatAnnotation[] = [
      { type: 'SLASH_COMMAND', startIndex: 0, length: 5 },
      humanMention(6, 6),
    ];
    expect(isMentioningBot(anns, BOT_USER_NAME)).toBe(false);
  });

  it('substring false hit 防止 — 本文に `@MAKOTOくん` が含まれていても annotations が無ければ false (#9)', () => {
    // 旧 substring 経路では誤って true になっていた case。
    // annotations が空 (= 引用や貼り付けで mention ではない) → false。
    expect(isMentioningBot([], BOT_USER_NAME)).toBe(false);
    expect(isMentioningBot(undefined, BOT_USER_NAME)).toBe(false);
  });
});

// =========================================================================
// stripMentions
// =========================================================================

describe('stripMentions', () => {
  it('annotations 無し → text.trim() のみ', () => {
    expect(stripMentions('  hello  ', undefined)).toBe('hello');
    expect(stripMentions('hello', [])).toBe('hello');
  });

  it('先頭 mention を startIndex+length で正確に除去', () => {
    // '@MAKOTOくん 簡単な質問です' (= 半角空白込み 9 文字を mention とする)
    const text = '@MAKOTOくん 簡単な質問です';
    const anns: ChatAnnotation[] = [botMention(0, 9)];
    expect(stripMentions(text, anns)).toBe('簡単な質問です');
  });

  it('末尾 mention の strip (#10 = 旧 simplified では先頭しか落ちなかった)', () => {
    // 'お疲れさまです @MAKOTOくん' — 末尾に mention
    const head = 'お疲れさまです ';
    const mention = '@MAKOTOくん';
    const text = head + mention;
    const anns: ChatAnnotation[] = [botMention(head.length, mention.length)];
    expect(stripMentions(text, anns)).toBe('お疲れさまです');
  });

  it('複数 mention を降順で削る (= startIndex がズレない)', () => {
    // '@A さん @B さん よろしく' のような複数 mention 想定。
    // 単純化: 'X@A_X@B_X' を mention 範囲 [(1,2),(5,2)] とする。
    const text = 'X@A_X@B_X';
    const anns: ChatAnnotation[] = [
      humanMention(1, 2),
      humanMention(5, 2),
    ];
    // mention 部 '@A' と '@B' を除去すると 'X_X_X'
    expect(stripMentions(text, anns)).toBe('X_X_X');
  });

  it('mention のみ (本文無し) → 空文字列', () => {
    // '@MAKOTOくん' = 9 UTF-16 code units (@ + 6 ASCII + 2 hiragana)
    const text = '@MAKOTOくん';
    const anns: ChatAnnotation[] = [botMention(0, text.length)];
    expect(stripMentions(text, anns)).toBe('');
  });

  it('USER_MENTION 以外の annotation 型 (SLASH_COMMAND) は無視', () => {
    const text = '/slash command body';
    const anns: ChatAnnotation[] = [
      { type: 'SLASH_COMMAND', startIndex: 0, length: 6 },
    ];
    // SLASH_COMMAND は対象外 → text そのまま (trim のみ)
    expect(stripMentions(text, anns)).toBe('/slash command body');
  });

  it('length=0 の壊れた annotation は安全に skip (Python と等価)', () => {
    const text = '@MAKOTOくん hello';
    const anns: ChatAnnotation[] = [
      { type: 'USER_MENTION', startIndex: 0, length: 0 },
      botMention(0, 9),
    ];
    // length=0 は skip、length=9 だけ採用 → 'hello'
    expect(stripMentions(text, anns)).toBe('hello');
  });
});
