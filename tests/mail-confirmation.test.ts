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
});

