/**
 * Continuation-reply prompt builder — TS port of
 * `scripts/cma_agentmail_inbound.py:build_continuation_prompt`
 * (line 2090-2144) + `CONTINUATION_REPLY_SYSTEM_ADDENDUM`
 * (line 2147-2158).
 *
 * Used when an inbound mail can be linked to a prior session via
 * Message-ID / In-Reply-To matching. The bridge feeds the agent the
 * thread history + the latest inbound and asks for a continuation
 * reply (no EMAIL_SEND marker — the bridge handles delivery).
 *
 * Prompts are byte-capped at 50 KB (PROMPT_BYTES_LIMIT). When over
 * the cap we elide thread bodies oldest-first, swapping them for
 * `[本文省略]` (matches Python truncation strategy).
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 6 — 層 4)
 * Spec: plan-draft.md §10 continuation + A5 / A6
 */

import type { AgentMailMessage } from '../types/agentmail';
import { extractBody } from './email-thread';

/** 50 KB — same value as Python's `PROMPT_BYTES_LIMIT`. */
export const PROMPT_BYTES_LIMIT = 50 * 1024;

/**
 * System-prompt addendum injected as part of the continuation
 * session-creation payload. Verbatim port of the Python string —
 * preserve wording so the bot's behaviour is observably identical.
 */
export const CONTINUATION_REPLY_SYSTEM_ADDENDUM = [
  'あなたは MAKOTO くん (株式会社 MAKOTO Prime の AI 社員第一号) です。',
  '自分が始めたメールスレッドへの返信に対し、文脈を踏まえて返信本文のみを生成してください。',
  '## 厳守事項',
  '- EMAIL_SEND マーカーは絶対に出さない (bot 側で送信する)',
  '- CHAT_POST マーカーも出さない',
  '- 返信本文だけを応答する (前置き・自己解説・コードブロック不要)',
  '- 改行は実際の改行で',
  '- 「詳細は後日改めて」のような defer 禁止。実質的な返信を書く',
  '- 不明な事実は「現時点で把握している範囲では」と前置きしつつ推測でも方向性を示す',
  '- 署名は付けない (bot 側で AgentMail スレッド継続として送信される)',
  '',
].join('\n');

/**
 * Build the per-call prompt body. `inbound` is the new mail we're
 * replying to; `threadHistory` is the older messages in chronological
 * order (oldest-first, mirrors Python convention).
 *
 * If the rendered text exceeds PROMPT_BYTES_LIMIT, oldest-first
 * truncation: replace body content with "[本文省略]" until under the
 * cap. If even the fully-truncated form is too big, hard-truncate
 * at the byte limit (rare; only happens for pathologically long
 * subjects / headers).
 */
export function buildContinuationPrompt(
  inbound: AgentMailMessage,
  threadHistory: AgentMailMessage[],
): string {
  const candidate = renderPrompt(inbound, threadHistory);
  if (utf8ByteLength(candidate) <= PROMPT_BYTES_LIMIT) return candidate;

  // Truncate oldest-first. We mutate a working copy of the array so
  // the caller's history is untouched.
  const working = threadHistory.map(cloneMessage);
  for (let i = 0; i < working.length; i++) {
    elideBody(working[i]!);
    const next = renderPrompt(inbound, working.slice(i + 1));
    if (utf8ByteLength(next) <= PROMPT_BYTES_LIMIT) return next;
  }

  // Even with everything elided we're over — hard truncate.
  return hardTruncate(candidate, PROMPT_BYTES_LIMIT);
}

// ----------------------------------------------------------------

function renderPrompt(
  inbound: AgentMailMessage,
  threadHistory: AgentMailMessage[],
): string {
  const subject = inbound.subject ?? '';
  const from = inbound.from ?? '';
  const body = extractBody(inbound);

  const parts: string[] = [];
  parts.push('以下は MAKOTO くんが過去に始めたメールスレッドです。');
  parts.push(`件名: ${subject}`);
  parts.push('');

  if (threadHistory.length > 0) {
    parts.push('## スレッドの履歴 (古い→新しい)');
    threadHistory.forEach((m, i) => {
      const who = m.from ?? '?';
      const ts = (m.received_at as string | undefined) ?? '?';
      const b = extractBody(m);
      parts.push(`--- [${i}] from=${who} at=${ts} ---`);
      parts.push(b.length > 0 ? b : '(本文なし)');
    });
    parts.push('');
  }

  parts.push('## 最新の受信メール (これに返信)');
  parts.push(`From: ${from}`);
  parts.push(`件名: ${subject}`);
  parts.push('本文:');
  parts.push(body.length > 0 ? body : '(本文なし)');
  parts.push('');
  parts.push(
    '上記スレッドの最新返信に対する MAKOTO くんからの返信本文のみを生成してください。' +
      'EMAIL_SEND マーカーは出さないでください。挨拶 → 本論 → 結びで、丁寧な日本語ビジネス文体。' +
      '署名は不要 (bot 側で送信)。',
  );
  return parts.join('\n');
}

function cloneMessage(m: AgentMailMessage): AgentMailMessage {
  // shallow + body-field overwrite; the prompt builder only reads
  // body + from + received_at + subject so this is safe.
  return { ...m };
}

function elideBody(m: AgentMailMessage): void {
  const placeholder = '[本文省略]';
  for (const k of ['extracted_text', 'text', 'extracted_html', 'html'] as const) {
    if (k in m) (m as Record<string, unknown>)[k] = placeholder;
  }
}

function utf8ByteLength(s: string): number {
  // TextEncoder is part of the standard Workers runtime.
  return new TextEncoder().encode(s).byteLength;
}

function hardTruncate(s: string, byteLimit: number): string {
  const enc = new TextEncoder().encode(s);
  if (enc.byteLength <= byteLimit) return s;
  // Slice on byte boundary then decode replacing-on-error so we don't
  // emit a malformed UTF-8 partial at the cut point.
  return new TextDecoder('utf-8').decode(enc.slice(0, byteLimit));
}
