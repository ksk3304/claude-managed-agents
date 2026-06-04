/**
 * Detect "yes, send it" turns that follow a mail draft confirmation.
 *
 * The initial mail request is detected by `intent-detector`, but the follow-up
 * approval often contains no mail keywords ("はい、お願いします"). We therefore
 * look at visible thread history for a pending draft confirmation and keep the
 * approval on the same employee agent/session.
 */

export function isMailSendApprovalText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return (
    /^(はい|はい、?お願いします|お願いします|お願い|ok|okay|yes|承認|送って|送信して|このまま|それで)(です|します|ください|で)?[。!！\s]*$/.test(
      normalized,
    ) || /送信(して|お願いします|していい|でお願いします)/.test(normalized)
  );
}

export function hasPendingMailSendDraft(historyBlock: string): boolean {
  const text = historyBlock.trim();
  if (!text) return false;
  const hasBody =
    /本文\s*[:：]/.test(text) ||
    (/結果メール案|メール案|送信確認待ち/.test(text) && /```[\s\S]+```/.test(text));
  const hasFields = /宛先\s*[:：]/.test(text) && /件名\s*[:：]/.test(text) && hasBody;
  const asksConfirmation =
    /送ってよいですか/.test(text) ||
    /送信してよろしければ/.test(text) ||
    /送って.*(お声がけ|ください)/.test(text) ||
    /送信しますか/.test(text) ||
    /このまま送信/.test(text) ||
    /このままお送り/.test(text) ||
    /内容を調整/.test(text);
  return hasFields && asksConfirmation;
}

export function isMailSendApprovalTurn(text: string, historyBlock: string): boolean {
  return isMailSendApprovalText(text) && hasPendingMailSendDraft(historyBlock);
}
