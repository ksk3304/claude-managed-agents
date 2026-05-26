/**
 * Unit tests for `src/lib/chat-alias-resolver.ts` — TS port of
 * `scripts/cma_gchat_send.py:resolve_space` / `reverse_resolve_alias`.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 既知 #7)
 *
 * 台帳 (`src/data/cma_gchat_aliases.json`) は makoto-prime 本体の
 * `scripts/cma_gchat_aliases.json` の snapshot。本テストでは現行
 * snapshot に登録されている `"Keisuke SetoDM"` を hit ケースに使う
 * (snapshot が更新されたら同テストも更新する想定)。
 */

import { describe, it, expect } from 'vitest';
import {
  resolveChatAlias,
  reverseResolveChatAlias,
  listChatAliases,
} from '../src/lib/chat-alias-resolver';

describe('resolveChatAlias', () => {
  it('alias hit: 登録済 alias を spaces/<id> に解決する', () => {
    // 現行 snapshot (`src/data/cma_gchat_aliases.json`) 依存。
    // 登録名は Python 側の `cma_gchat_aliases.json` と同一。
    expect(resolveChatAlias('Keisuke SetoDM')).toBe('spaces/rKtECyAAAAE');
  });

  it('spaces/... 形式はそのまま返す (resource name 入力の pass-through)', () => {
    expect(resolveChatAlias('spaces/AAAAAA')).toBe('spaces/AAAAAA');
    expect(resolveChatAlias('spaces/zzz/threads/qqq')).toBe('spaces/zzz/threads/qqq');
  });

  it('未登録 alias は throw する (登録済 alias 一覧をエラーメッセージに含む)', () => {
    expect(() => resolveChatAlias('NonExistentAlias_xyz')).toThrow(/未登録/);
    // 登録済 alias がエラーメッセージに含まれることで運用デバッグを助ける
    expect(() => resolveChatAlias('NonExistentAlias_xyz')).toThrow(/Keisuke SetoDM/);
  });

  it('大文字小文字は厳密一致 (Python dict[key] と同等)', () => {
    // "Keisuke SetoDM" が登録済 → "keisuke setodm" (小文字) は未登録扱い
    expect(() => resolveChatAlias('keisuke setodm')).toThrow(/未登録/);
    expect(() => resolveChatAlias('KEISUKE SETODM')).toThrow(/未登録/);
  });

  it('空文字 / 予約 key は throw する', () => {
    expect(() => resolveChatAlias('')).toThrow(/空文字/);
    expect(() => resolveChatAlias('_comment')).toThrow(/予約済み/);
  });
});

describe('reverseResolveChatAlias', () => {
  it('spaces/<id> → alias 名を返す (登録済)', () => {
    expect(reverseResolveChatAlias('spaces/rKtECyAAAAE')).toBe('Keisuke SetoDM');
  });

  it('未登録の spaces/<id> は null を返す', () => {
    expect(reverseResolveChatAlias('spaces/UNREGISTERED_ZZZ')).toBeNull();
  });

  it('非 spaces/ 文字列は null を返す (alias 名や空文字を渡しても crash しない)', () => {
    expect(reverseResolveChatAlias('Keisuke SetoDM')).toBeNull();
    expect(reverseResolveChatAlias('')).toBeNull();
  });
});

describe('listChatAliases', () => {
  it('予約 key を含まない alias 名一覧を返す', () => {
    const aliases = listChatAliases();
    expect(aliases).toContain('Keisuke SetoDM');
    expect(aliases).not.toContain('_comment');
  });
});
