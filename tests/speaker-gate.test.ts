/**
 * Unit tests for `src/lib/speaker-gate.ts` (Issue #186 既知 #6 —
 * 未解決 speaker gate 完全実装).
 *
 * Covers the wire-up layer that combines pure decision functions
 * (`computeChatPostGate` / `computeExternalToolGate` from
 * `speaker-resolver.ts`) with the marker-strip side-effect
 * (`applyChatPostGateToText`, Python `_strip_chat_post_on_unresolved`
 * 等価) and the convenience combinator (`computeSpeakerGateDecisions`).
 *
 * The pure-function algebra itself is tested in
 * `speaker-resolver.test.ts`; this file focuses on the integration
 * helper behaviour the chat-event-handler depends on.
 */

import { describe, it, expect } from 'vitest';
import {
  applyChatPostGateToText,
  computeChatPostGate,
  computeExternalToolGate,
  computeSpeakerGateDecisions,
} from '../src/lib/speaker-gate';

// ---------------------------------------------------------------- fixtures

const CHAT_POST_MARKER =
  'CHAT_POST:{"space":"瀬戸DM","text":"別 space へ展開","thread":"current"}';

// ---------------------------------------------------------------- applyChatPostGateToText

describe('applyChatPostGateToText', () => {
  it('returns input verbatim with gate=false when hasUnresolvedSpeakers=false', () => {
    // 旧挙動温存: 未解決者ゼロ = 全 CHAT_POST marker 通す (= 別 space 投稿許可)。
    // .trim() も走らせない (Python `_strip_marker_on_gate` l.1461-1462 短絡)。
    const text = `要件確認します。\n\n${CHAT_POST_MARKER}\n\n以上`;
    const result = applyChatPostGateToText(text, false);
    expect(result.text).toBe(text);
    expect(result.decision).toEqual({ gate: false, reason: 'n/a' });
  });

  it('strips all CHAT_POST markers and preserves surrounding body when gated', () => {
    // 未解決者あり = CHAT_POST 全 strip。空にならないとき fallback 文言は
    // 使わない (本文の他のテキストはそのまま残す)。
    const text = `了解しました。\n\n${CHAT_POST_MARKER}\n\n後ほど共有します。`;
    const result = applyChatPostGateToText(text, true);
    expect(result.text).not.toContain('CHAT_POST:');
    expect(result.text).toContain('了解しました');
    expect(result.text).toContain('後ほど共有します');
    expect(result.decision).toEqual({ gate: true, reason: 'unresolved' });
  });

  it('replaces empty result with the unresolved fallback literal when body has only marker', () => {
    // CHAT_POST のみ = strip 後 .trim() で空 → Python と byte 等価の
    // fallback「（未登録ユーザー検知のため CHAT_POST 抑止、本文出力なし）」
    // を返す (= chat-event-handler は finalText.trim().length === 0 経路で
    // placeholder DELETE せず本 fallback を投稿する)。
    const result = applyChatPostGateToText(CHAT_POST_MARKER, true);
    expect(result.text).toBe('（未登録ユーザー検知のため CHAT_POST 抑止、本文出力なし）');
    expect(result.decision).toEqual({ gate: true, reason: 'unresolved' });
  });

  it('strips multiple CHAT_POST markers on separate lines (Python re.sub parity)', () => {
    // Python `re.sub` は全マッチ置換、JS `replace` は first-match のみ。
    // applyChatPostGateToText は内部で global regex を使うので、複数行に
    // 散らばる marker をすべて落とす (= 単一 strip で取りこぼし無い)。
    const text =
      `A 件\nCHAT_POST:{"space":"X","text":"1"}\n` +
      `B 件\nCHAT_POST:{"space":"Y","text":"2"}\n` +
      `C 件`;
    const result = applyChatPostGateToText(text, true);
    expect(result.text).not.toContain('CHAT_POST:');
    expect(result.text).toContain('A 件');
    expect(result.text).toContain('B 件');
    expect(result.text).toContain('C 件');
    expect(result.decision.gate).toBe(true);
  });
});

// ---------------------------------------------------------------- computeSpeakerGateDecisions

describe('computeSpeakerGateDecisions', () => {
  it('combines actor-trusted + clean history = both axes pass', () => {
    // 登録済オーナー本人 + 未解決者なし = 何も gate しない (= 旧経路と同じ)。
    const r = computeSpeakerGateDecisions(true, 'mapping', false);
    expect(r.externalTool).toEqual({ gate: false, reason: 'allowed_actor_trusted' });
    expect(r.chatPost).toEqual({ gate: false, reason: 'n/a' });
  });

  it('actor untrusted (unresolved) + unresolved history = both gate fire', () => {
    // 依頼主本人が外部 + 履歴にも未登録者 = 外部ツールも CHAT_POST も両方 gate。
    // 二軸は独立判定だが、本ケースでは両方が同方向に倒れる (= 厳格 fail-safe)。
    const r = computeSpeakerGateDecisions(false, null, true);
    expect(r.externalTool).toEqual({ gate: true, reason: 'unresolved' });
    expect(r.chatPost).toEqual({ gate: true, reason: 'unresolved' });
  });

  it('actor untrusted (chat_api fallback) but history clean = only external gates', () => {
    // 表示名のみ解決の actor + 履歴 clean = 外部ツールは gate (mapping 必須)、
    // CHAT_POST は通る (= S5 履歴駆動ロジックは hasUnresolved=false で n/a)。
    // 二軸独立性の demonstration (Issue #161 分離設計)。
    const r = computeSpeakerGateDecisions(false, 'chat_api', false);
    expect(r.externalTool).toEqual({ gate: true, reason: 'chat_api_untrusted' });
    expect(r.chatPost).toEqual({ gate: false, reason: 'n/a' });
  });

  it('actor trusted + unresolved history = only CHAT_POST gates (external pass)', () => {
    // 登録済オーナー本人だが履歴に未確認ユーザー = 外部ツールは通す
    // (actor 駆動 #161 で履歴 latch 撤去)、CHAT_POST は履歴駆動 S5 で
    // gate する。actor 駆動軸 vs 履歴駆動軸の責任分界を明示する case。
    const r = computeSpeakerGateDecisions(true, 'mapping', true);
    expect(r.externalTool).toEqual({ gate: false, reason: 'allowed_actor_trusted' });
    expect(r.chatPost).toEqual({ gate: true, reason: 'unresolved' });
  });
});

// ---------------------------------------------------------------- re-exports

describe('speaker-gate re-exports speaker-resolver pure functions', () => {
  it('exposes computeChatPostGate identical to speaker-resolver (single source of truth)', () => {
    // 同一実装の re-export であることを byte レベルで確認 (= 重複実装による
    // doc-drift の予防、speaker-resolver.ts が単一正本)。
    expect(computeChatPostGate(true)).toEqual({ gate: true, reason: 'unresolved' });
    expect(computeChatPostGate(false)).toEqual({ gate: false, reason: 'n/a' });
  });

  it('exposes computeExternalToolGate identical to speaker-resolver', () => {
    expect(computeExternalToolGate(true, 'mapping')).toEqual({
      gate: false,
      reason: 'allowed_actor_trusted',
    });
    expect(computeExternalToolGate(false, 'chat_api')).toEqual({
      gate: true,
      reason: 'chat_api_untrusted',
    });
    expect(computeExternalToolGate(false, null)).toEqual({
      gate: true,
      reason: 'unresolved',
    });
  });
});
