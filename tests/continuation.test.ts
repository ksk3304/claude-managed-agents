/**
 * Unit tests for `src/lib/continuation.ts` — continuation-reply prompt
 * builder. Parity with Python `scripts/cma_agentmail_inbound.py:2090-2158`.
 */

import { describe, it, expect } from 'vitest';
import {
  buildContinuationPrompt,
  CONTINUATION_REPLY_SYSTEM_ADDENDUM,
  PROMPT_BYTES_LIMIT,
} from '../src/lib/continuation';
import type { AgentMailMessage } from '../src/types/agentmail';

const SHORT_INBOUND: AgentMailMessage = {
  id: 'm-new',
  from: 'alice@example.com',
  subject: 'Re: 提案について',
  extracted_text: '了解しました。詳細はこちら。',
};

describe('buildContinuationPrompt', () => {
  it('returns a prompt under PROMPT_BYTES_LIMIT for short input', () => {
    const prompt = buildContinuationPrompt(SHORT_INBOUND, []);
    expect(prompt.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThan(PROMPT_BYTES_LIMIT);
    expect(prompt).toContain('alice@example.com');
    expect(prompt).toContain('Re: 提案について');
    expect(prompt).toContain('了解しました');
  });

  it('embeds thread history oldest-first', () => {
    const history: AgentMailMessage[] = [
      {
        id: 'm-1',
        from: 'bot@x',
        received_at: '2026-05-01T00:00:00Z',
        extracted_text: '初回送信',
      },
      {
        id: 'm-2',
        from: 'alice@x',
        received_at: '2026-05-02T00:00:00Z',
        extracted_text: '返信 1',
      },
    ];
    const prompt = buildContinuationPrompt(SHORT_INBOUND, history);
    expect(prompt).toContain('スレッドの履歴');
    expect(prompt.indexOf('初回送信')).toBeLessThan(prompt.indexOf('返信 1'));
  });

  it('drops oldest bodies first when over the byte limit', () => {
    // 50KB限界の素材: 60KB の string を 1 entry に詰める
    const bigBody = 'あ'.repeat(20000); // 60KB (UTF-8 3 bytes/char)
    const history: AgentMailMessage[] = [
      { id: 'm-old', from: 'a@x', extracted_text: bigBody, received_at: '1' },
      { id: 'm-new', from: 'b@x', extracted_text: 'short', received_at: '2' },
    ];
    const prompt = buildContinuationPrompt(SHORT_INBOUND, history);
    // 現実装は古い側を slice(i+1) で除外するため big body の文字は出ない。
    // (= elide + slice の二重処理で [本文省略] placeholder は出力に乗らない。
    // 設計と実装のズレ — 完了ログ Issue 化候補に記載)
    expect(prompt).not.toContain('ああああ');
    expect(prompt).toContain('short');
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(
      PROMPT_BYTES_LIMIT,
    );
  });

  it('does not mutate caller-supplied history', () => {
    const big = 'あ'.repeat(20000);
    const history: AgentMailMessage[] = [
      { id: 'm-1', from: 'a@x', extracted_text: big, received_at: '1' },
    ];
    buildContinuationPrompt(SHORT_INBOUND, history);
    expect(history[0]!.extracted_text).toBe(big);
  });

  it('returns hard-truncated text when even elided form is over limit', () => {
    // 巨大 subject + 巨大 from で素材だけで 50KB 超す ill-formed input
    const inbound: AgentMailMessage = {
      id: 'm',
      from: 'x@y',
      subject: 'X'.repeat(60000),
      extracted_text: '',
    };
    const prompt = buildContinuationPrompt(inbound, []);
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(
      PROMPT_BYTES_LIMIT,
    );
  });
});

describe('CONTINUATION_REPLY_SYSTEM_ADDENDUM', () => {
  it('forbids EMAIL_SEND marker emission', () => {
    expect(CONTINUATION_REPLY_SYSTEM_ADDENDUM).toContain('EMAIL_SEND');
    expect(CONTINUATION_REPLY_SYSTEM_ADDENDUM).toContain('絶対に出さない');
  });
  it('forbids CHAT_POST marker emission', () => {
    expect(CONTINUATION_REPLY_SYSTEM_ADDENDUM).toContain('CHAT_POST');
  });
});
