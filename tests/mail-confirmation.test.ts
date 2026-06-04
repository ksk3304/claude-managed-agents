import { describe, expect, it } from 'vitest';

import {
  hasPendingMailSendDraft,
  isMailSendApprovalText,
  isMailSendApprovalTurn,
} from '../src/lib/mail-confirmation';

const HISTORY =
  '## スレッド過去履歴（時系列順）\n' +
  '- [bot] 以下の内容で送ってよいですか？\n\n' +
  '宛先: k.seto@makotoprime.com\n' +
  '件名: 猫の行動について\n' +
  '本文:\n猫の行動について、簡単にまとめます。\n\n' +
  'このまま送信しますか？';

const RESULT_MAIL_HISTORY =
  '## スレッド過去履歴（時系列順）\n' +
  '- [bot] アンケート結果が揃いました！\n\n' +
  '*結果メール案（送信確認待ち）*\n\n' +
  '- 宛先: k.seto@makotoprime.com\n' +
  '- CC: takei@makotoprime.com\n' +
  '- 件名: 【結果報告】キャッチコピーアンケート集計結果\n\n' +
  '```\n' +
  '瀬戸様\n\n' +
  'キャッチコピーアンケートの集計結果をご報告します。\n' +
  '```\n\n' +
  '送信してよろしければ「送って」とお声がけください！';

describe('mail confirmation detection', () => {
  it('detects short Japanese approval text', () => {
    expect(isMailSendApprovalText('はい、お願いします')).toBe(true);
    expect(isMailSendApprovalText('お願いします')).toBe(true);
    expect(isMailSendApprovalText('OK')).toBe(true);
  });

  it('requires a pending draft in thread history', () => {
    expect(hasPendingMailSendDraft(HISTORY)).toBe(true);
    expect(isMailSendApprovalTurn('はい、お願いします', HISTORY)).toBe(true);
    expect(isMailSendApprovalTurn('はい、お願いします', 'ただの雑談')).toBe(false);
  });

  it('accepts result-mail draft blocks from async heartbeat aggregate replies', () => {
    expect(hasPendingMailSendDraft(RESULT_MAIL_HISTORY)).toBe(true);
    expect(isMailSendApprovalTurn('送って', RESULT_MAIL_HISTORY)).toBe(true);
  });
});
