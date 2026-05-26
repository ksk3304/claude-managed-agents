/**
 * Chat alias resolver — TS port of
 * `scripts/cma_gchat_send.py:resolve_space` / `reverse_resolve_alias`.
 *
 * MAKOTOくん の CHAT_POST marker は `space` フィールドに「Keisuke SetoDM」
 * 等の alias 名、または `spaces/<id>` 形式の resource name を入れる
 * (`scripts/cma_gchat_bot.py` で alias→resource name に解決してから
 * Chat REST API を呼ぶ)。Worker (TS) でも同じ alias 解決を行う。
 *
 * 台帳は makoto-prime repo の `scripts/cma_gchat_aliases.json` が正本
 * (Python 側はファイル read で動的取得)。Worker ではコンテナ FS を
 * 持たないため `src/data/cma_gchat_aliases.json` に bundle 用 snapshot
 * を置き、static import で読み込む。差分同期は別 Issue でフォロー。
 *
 * 予約 key `_comment` は alias 扱いしない (Python `_RESERVED_ALIAS_KEYS`
 * と整合)。
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 既知 #7 — CHAT_POST alias resolver)
 * Source of truth (Python):
 *   - scripts/cma_gchat_send.py l.208-234 (resolve_space)
 *   - scripts/cma_gchat_send.py l.131-148 (reverse_resolve_alias)
 *   - scripts/cma_gchat_send.py l.45      (_RESERVED_ALIAS_KEYS)
 */

import aliasesJson from '../data/cma_gchat_aliases.json';

/** Python `_RESERVED_ALIAS_KEYS` mirror. */
const RESERVED_ALIAS_KEYS: ReadonlySet<string> = new Set(['_comment']);

/**
 * Load and validate the alias map at module init time. Invalid entries
 * (non-string value, missing `spaces/` prefix) are dropped with a warn
 * log; Python raises `AliasesFileError` and fail-fasts. Worker 側は
 * snapshot 経由なので静かに無視 + log (台帳更新時の sync ミス検知は
 * 別 Issue)。予約 key (`_comment`) はスキップ。
 */
function loadAliases(): Map<string, string> {
  const map = new Map<string, string>();
  if (!aliasesJson || typeof aliasesJson !== 'object') {
    return map;
  }
  const obj = aliasesJson as Record<string, unknown>;
  for (const [alias, value] of Object.entries(obj)) {
    if (RESERVED_ALIAS_KEYS.has(alias)) {
      continue;
    }
    if (typeof value !== 'string' || !value.startsWith('spaces/')) {
      console.warn(
        `[chat-alias-resolver] skip invalid entry alias=${JSON.stringify(alias)} value=${JSON.stringify(value)}`,
      );
      continue;
    }
    map.set(alias, value);
  }
  return map;
}

const ALIAS_MAP: ReadonlyMap<string, string> = loadAliases();

/**
 * `resolveChatAlias(input)` の挙動 (Python `resolve_space` と同形):
 *
 *   - `input` が `spaces/...` で始まる → そのまま返す (resource name 入力)
 *   - `input` が alias 台帳に登録済 → 対応する `spaces/<id>` を返す
 *   - 上記いずれでもない → エラーを throw
 *     (空文字 / 未登録 alias / 予約 key)
 *
 * Python は `SystemExit` を投げるが Worker では通常の `Error` にする
 * (呼出側 `executeChatPostMarker` が catch して `outcome: 'failed'`
 * に変換する想定)。
 *
 * 大文字小文字は厳密一致 (Python `dict[key]` と同等)。trim はしない。
 */
export function resolveChatAlias(input: string): string {
  if (typeof input !== 'string' || input === '') {
    throw new Error(`alias '${String(input)}' を解決できません: 空文字または非文字列`);
  }
  if (input.startsWith('spaces/')) {
    return input;
  }
  if (RESERVED_ALIAS_KEYS.has(input)) {
    throw new Error(`alias '${input}' は予約済みで解決対象外`);
  }
  const resolved = ALIAS_MAP.get(input);
  if (resolved !== undefined) {
    return resolved;
  }
  const available = Array.from(ALIAS_MAP.keys());
  throw new Error(
    `alias '${input}' は未登録です。登録済み: ${JSON.stringify(available)}`,
  );
}

/**
 * `reverseResolveChatAlias(spaceId)` — `spaces/<id>` → alias 名の逆引き
 * (Python `reverse_resolve_alias` と同形)。同じ space_id に複数 alias
 * が紐づく場合は JSON 挿入順で最初にヒットしたものを返す。見つからな
 * ければ `null`。
 *
 * 主に Chat 受信側 (sender→user_slug 等) のラベル付けで使う想定の補助
 * API。CHAT_POST marker 経路では使われない。
 */
export function reverseResolveChatAlias(spaceId: string): string | null {
  if (typeof spaceId !== 'string' || !spaceId.startsWith('spaces/')) {
    return null;
  }
  for (const [alias, sid] of ALIAS_MAP.entries()) {
    if (sid === spaceId) {
      return alias;
    }
  }
  return null;
}

/**
 * Test/diagnostic helper — list登録済 alias (予約 key は含まれない)。
 */
export function listChatAliases(): string[] {
  return Array.from(ALIAS_MAP.keys());
}
