/**
 * Unit tests for `src/lib/agentmail-notification.ts` — byte-equivalent
 * port of the Cloud Run side
 * `cma_agentmail_inbound.py:_build_notification_text` (l.1893-1905) +
 * `_build_autoreply_notification_text` (l.1907-1932). The Python
 * fixtures below were re-computed locally; if Python ever diverges,
 * these tests will catch the drift first (Issue #186 #2 + #4).
 */

import { describe, it, expect } from 'vitest';
import {
  buildInboundNotificationText,
  buildAutoreplyNotificationText,
} from '../src/lib/agentmail-notification';

describe('buildInboundNotificationText', () => {
  it('builds the cold (= 新規問い合わせ) variant with kind, From, 件名, preview, 判断依頼 footer', () => {
    const text = buildInboundNotificationText(
      {
        from: 'sender@example.com',
        subject: '相談',
        body: 'おはようございます。会社の件で相談です。',
      },
      false,
    );
    expect(text).toBe(
      '📨 新規問い合わせ (cold inbound)\n' +
        'From: sender@example.com\n' +
        '件名: 相談\n' +
        '本文 preview:\nおはようございます。会社の件で相談です。\n\n' +
        '返信判断は瀬戸さんでお願いします',
    );
  });

  it('builds the continuation (= continuation 返信) variant', () => {
    const text = buildInboundNotificationText(
      {
        from: 'sender@example.com',
        subject: 'Re: 相談',
        body: '追加情報です。',
      },
      true,
    );
    expect(text.startsWith('📨 continuation 返信\n')).toBe(true);
    expect(text).toContain('件名: Re: 相談');
  });

  it('truncates body preview at 300 chars with … ellipsis (Python COLD_PREVIEW)', () => {
    const longBody = 'あ'.repeat(500);
    const text = buildInboundNotificationText(
      { from: 'x@y.com', subject: 's', body: longBody },
      false,
    );
    const previewLine = text.split('本文 preview:\n')[1]!.split('\n\n')[0]!;
    expect(previewLine).toBe('あ'.repeat(300) + '…');
  });

  it('does not append … when body fits in 300 chars exactly', () => {
    const body = 'あ'.repeat(300);
    const text = buildInboundNotificationText(
      { from: 'x@y.com', subject: 's', body },
      false,
    );
    const previewLine = text.split('本文 preview:\n')[1]!.split('\n\n')[0]!;
    expect(previewLine).toBe(body);
    expect(previewLine.endsWith('…')).toBe(false);
  });

  it('renders empty fields without crashing (defensive)', () => {
    const text = buildInboundNotificationText({}, false);
    expect(text).toBe(
      '📨 新規問い合わせ (cold inbound)\n' +
        'From: \n' +
        '件名: \n' +
        '本文 preview:\n\n\n' +
        '返信判断は瀬戸さんでお願いします',
    );
  });
});

describe('buildAutoreplyNotificationText', () => {
  it('builds the autoreply notification with 📤, 宛先, 件名 (with Re: dedup), recv preview, sent body', () => {
    const text = buildAutoreplyNotificationText(
      {
        from: 'user@example.com',
        subject: 'お問い合わせ',
        body: '質問本文です。',
      },
      'ご質問ありがとうございます。回答は…',
    );
    expect(text).toBe(
      '📤 continuation 自動返信を送信しました\n' +
        '宛先: user@example.com\n' +
        '件名: Re: お問い合わせ\n' +
        '受信本文 preview:\n質問本文です。\n\n' +
        '── 送信した返信文 ──\n' +
        'ご質問ありがとうございます。回答は…',
    );
  });

  it('does not double-prefix Re: when subject already starts with re: (case-insensitive)', () => {
    const cases = [
      { input: 'Re: x', expected: 'Re: x' },
      { input: 're: x', expected: 're: x' },
      { input: 'RE: x', expected: 'RE: x' },
    ];
    for (const c of cases) {
      const text = buildAutoreplyNotificationText(
        { from: 'a@b.com', subject: c.input, body: 'body' },
        'reply',
      );
      expect(text).toContain(`件名: ${c.expected}\n`);
    }
  });

  it('truncates recv preview at 200 chars and sent preview at 600 chars', () => {
    const longRecv = 'い'.repeat(300);
    const longSent = 'ろ'.repeat(800);
    const text = buildAutoreplyNotificationText(
      { from: 'a@b.com', subject: 's', body: longRecv },
      longSent,
    );
    expect(text).toContain('い'.repeat(200) + '…');
    expect(text).toContain('ろ'.repeat(600) + '…');
    // truncated sent → header switches to (先頭600字) variant
    expect(text).toContain('── 送信した返信文 (先頭600字) ──');
  });

  it('keeps the non-truncated header when sent text is exactly 600 chars', () => {
    const text = buildAutoreplyNotificationText(
      { from: 'a@b.com', subject: 's', body: 'b' },
      'ろ'.repeat(600),
    );
    expect(text).toContain('── 送信した返信文 ──\n');
    expect(text).not.toContain('(先頭600字)');
  });

  it('trims subject whitespace before applying Re: prefix', () => {
    const text = buildAutoreplyNotificationText(
      { from: 'a@b.com', subject: '   お問い合わせ   ', body: 'b' },
      'reply',
    );
    expect(text).toContain('件名: Re: お問い合わせ\n');
  });

  it('trims reply text whitespace before length check', () => {
    const text = buildAutoreplyNotificationText(
      { from: 'a@b.com', subject: 's', body: 'b' },
      '   reply   ',
    );
    expect(text.endsWith('── 送信した返信文 ──\nreply')).toBe(true);
  });
});
