/**
 * Chat notification text builders for AgentMail inbound events
 * (Issue #186 #2 cold inbound + #4 continuation auto-reply).
 *
 * Mirrors the Cloud Run side
 * (`scripts/cma_agentmail_inbound.py:_build_notification_text` l.1893-1905
 *  and `_build_autoreply_notification_text` l.1907-1932). The output
 * strings are byte-equivalent to Python — keep `📨` / `📤` glyphs,
 * preview cutoffs (cold: 300 chars, autoreply received: 200 chars,
 * autoreply sent: 600 chars), `…` ellipsis, and the `── 送信した返信文
 * (先頭600字) ──` / `── 送信した返信文 ──` selector logic unchanged.
 *
 * Pure helpers; no I/O. Production callers feed the returned string
 * into `chat-api.ts:postChatMessage` to deliver to
 * `env.MAKOTO_NOTIFY_SPACE`.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — #2 cold + #4 continuation Chat 通知)
 * Spec: port-mapping v1 §1 rows #2 + #4 + plan-draft-v5.md §4 Day 3 4.2
 * Python source: scripts/cma_agentmail_inbound.py l.1893-1932
 */

const COLD_PREVIEW_BYTES = 300;
const AUTOREPLY_RECEIVED_PREVIEW_BYTES = 200;
const AUTOREPLY_SENT_PREVIEW_BYTES = 600;

/**
 * Subset of the AgentMail message envelope these builders need.
 * Extra fields are ignored — keep this loose so callers can pass the
 * raw inbound shape without reshaping.
 */
export interface AgentMailDetail {
  /** RFC 5322 `From:` value (display name + addr-spec). */
  from?: string;
  /** Subject line. */
  subject?: string;
  /** Plain-text body. */
  body?: string;
}

/**
 * Build the cold/continuation inbound notification text. `📨 cold inbound`
 * (continuation=false) goes to the operator as a 判断依頼; `📨 continuation
 * 返信` (continuation=true) goes as a "received but not auto-replying"
 * notice.
 *
 * Byte-equivalent with Python `_build_notification_text` (l.1893-1905).
 */
export function buildInboundNotificationText(
  detail: AgentMailDetail,
  isContinuation: boolean,
): string {
  const fromAddr = detail.from ?? '';
  const subject = detail.subject ?? '';
  const body = detail.body ?? '';
  const preview =
    body.length > COLD_PREVIEW_BYTES
      ? body.slice(0, COLD_PREVIEW_BYTES) + '…'
      : body;
  const kind = isContinuation
    ? '📨 continuation 返信'
    : '📨 新規問い合わせ (cold inbound)';
  return (
    `${kind}\n` +
    `From: ${fromAddr}\n` +
    `件名: ${subject}\n` +
    `本文 preview:\n${preview}\n\n` +
    `返信判断は瀬戸さんでお願いします`
  );
}

/**
 * Build the continuation auto-reply "send confirmation" notification
 * text. Sent to the operator after AgentMail accepts the outbound, so
 * they get an FYI of exactly what got auto-replied to whom.
 *
 * Byte-equivalent with Python `_build_autoreply_notification_text`
 * (l.1907-1932). The `Re:` prefix dedup, received/sent preview cuts,
 * and the truncation-aware sent label literal are all kept verbatim.
 */
export function buildAutoreplyNotificationText(
  detail: AgentMailDetail,
  replyText: string,
): string {
  const fromAddr = detail.from ?? '';
  const subject = (detail.subject ?? '').trim();
  // 件名が既に Re: 始まりなら二重付与しない (Python `re.match(r"(?i)^re:", ...)`)
  const dispSubj = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  const recv = detail.body ?? '';
  const recvPrev =
    recv.length > AUTOREPLY_RECEIVED_PREVIEW_BYTES
      ? recv.slice(0, AUTOREPLY_RECEIVED_PREVIEW_BYTES) + '…'
      : recv;
  const sent = (replyText ?? '').trim();
  const truncated = sent.length > AUTOREPLY_SENT_PREVIEW_BYTES;
  const sentPrev = truncated
    ? sent.slice(0, AUTOREPLY_SENT_PREVIEW_BYTES) + '…'
    : sent;
  const sentLabel = truncated
    ? '── 送信した返信文 (先頭600字) ──'
    : '── 送信した返信文 ──';
  return (
    `📤 continuation 自動返信を送信しました\n` +
    `宛先: ${fromAddr}\n` +
    `件名: ${dispSubj}\n` +
    `受信本文 preview:\n${recvPrev}\n\n` +
    `${sentLabel}\n${sentPrev}`
  );
}
