/**
 * Google Chat mention detection & strip — annotations-based implementation.
 *
 * Python 一次ソース (= byte 等価 port 元):
 *   - `scripts/cma_gchat_bot.py:_is_for_bot` (l.2058-2079)
 *   - `scripts/cma_gchat_bot.py:_strip_mention` (l.2082-2098)
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2, 既知 #9 + #10)
 *
 * 旧 chat-event-handler.ts 内の `textMentionsBot` / `stripLeadingMention` は
 * 「`@<displayName>` substring 含むか」「先頭 `@<displayName>` のみ落とす」
 * という簡略実装で、以下の正しさを欠いていた:
 *
 *   #9 false-positive: ユーザー本文に `@MAKOTOくん` という substring (= 引用、
 *       メンション ではない単なる文字列) が含まれるだけで誤って bot 宛と判定。
 *   #10 strip 失敗: shared space で `@MAKOTOくん` mention が **末尾** や
 *       **本文中** に置かれている (= 先頭ではない) ケースで、annotations
 *       で示された範囲 (startIndex + length) を正確に除去できなかった。
 *
 * 本実装は Google Chat API が message に付ける `annotations` 配列を一次情報
 * として扱う:
 *
 *   - `annotation.type === 'USER_MENTION'` 限定で mention 判定/除去
 *   - 判定: `userMention.user.type === 'BOT'` を最優先 (Workspace Add-on
 *     形式の確実な判定)、無ければ `userMention.user.name` と env で渡された
 *     `botUserName` (= `users/<id>` 形式) の一致を fallback (Python BOT_USER_NAME
 *     フォールバックと等価)。
 *   - 除去: `startIndex + length` 範囲を文字列から切り出す。複数 mention が
 *     ある場合は降順 sort して後ろから削る (= Python 実装と byte 等価)。
 *
 * 参照: Google Chat API `Message.annotations` の structure。
 * `type` は `USER_MENTION` / `SLASH_COMMAND` 等あり、本実装は USER_MENTION のみ扱う。
 */

/**
 * Google Chat `Message.annotations[]` の最小 subset (本ライブラリで使う field のみ)。
 *
 * 公式 doc: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages#annotation
 */
export interface ChatAnnotation {
  type?: string;
  startIndex?: number;
  length?: number;
  userMention?: {
    user?: {
      name?: string;
      type?: string;
    };
  };
}

/**
 * `annotations` 経由で「このメッセージが bot 宛か」を判定。
 *
 * Python `_is_for_bot` の `annotations` 走査部 (DM 分岐は呼び出し側で切る) と
 * byte 等価。
 *
 * 判定基準:
 *   1. annotations 内の `type === 'USER_MENTION'` を全件走査
 *   2. `userMention.user.type === 'BOT'` ならば true
 *   3. `botUserName` 非空 かつ `userMention.user.name === botUserName` ならば true
 *   4. いずれも該当なしなら false
 *
 * @param annotations - `message.annotations` (= 未定義 / 空配列も許容)
 * @param botUserName - 環境変数 `GCHAT_BOT_USER_NAME` 相当 (= `users/<id>`
 *                     形式)。空文字なら fallback 判定を skip
 */
export function isMentioningBot(
  annotations: readonly ChatAnnotation[] | undefined | null,
  botUserName: string,
): boolean {
  if (!annotations || annotations.length === 0) return false;
  for (const ann of annotations) {
    if (ann.type !== 'USER_MENTION') continue;
    const user = ann.userMention?.user;
    if (!user) continue;
    if (user.type === 'BOT') return true;
    if (botUserName && user.name === botUserName) return true;
  }
  return false;
}

/**
 * `annotations` の USER_MENTION 範囲を本文から除去。
 *
 * Python `_strip_mention` と byte 等価。複数 mention は降順 sort してから
 * 後ろから順に削る (= 前から削ると startIndex が ズレる事故を回避)。
 *
 * NOTE: `length > 0` のみ採用。 `length === 0` の壊れた annotation は
 * 安全側で skip する (Python 実装も `if length > 0:` で同等)。
 *
 * @returns 除去後の文字列 (= `.trim()` 適用済、Python と等価)
 */
export function stripMentions(
  text: string,
  annotations: readonly ChatAnnotation[] | undefined | null,
): string {
  if (!annotations || annotations.length === 0) return text.trim();
  // (start, end) range を収集
  const cuts: Array<[number, number]> = [];
  for (const ann of annotations) {
    if (ann.type !== 'USER_MENTION') continue;
    const start = Number(ann.startIndex ?? 0) || 0;
    const length = Number(ann.length ?? 0) || 0;
    if (length > 0) {
      cuts.push([start, start + length]);
    }
  }
  // 降順 sort (= 後ろから削る)。Python は `cuts.sort(reverse=True)` で
  // tuple 比較 (start 降順 → end 降順) する。TS は明示比較で同等の順序。
  cuts.sort((a, b) => {
    if (b[0] !== a[0]) return b[0] - a[0];
    return b[1] - a[1];
  });
  let out = text;
  for (const [s, e] of cuts) {
    out = out.slice(0, s) + out.slice(e);
  }
  return out.trim();
}
