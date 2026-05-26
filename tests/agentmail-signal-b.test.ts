/**
 * Unit tests for `src/lib/agentmail-signal-b.ts` — continuation SignalB
 * thread self-scan. Parity with Python
 * `scripts/cma_agentmail_inbound.py:_thread_self_scan` (lines 2043-2087).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  normalizeEmail,
  scanThreadForSelf,
  threadSelfScan,
  type AgentMailThread,
  type ThreadSelfScanLogger,
} from '../src/lib/agentmail-signal-b';
import type { AgentMailMessage } from '../src/types/agentmail';

const INBOX_ID = 'makoto@agentmail.to';

function makeLogger(): { logger: ThreadSelfScanLogger; warns: string[] } {
  const warns: string[] = [];
  return { logger: { warn: (m) => warns.push(m) }, warns };
}

function msg(from: string, extra: Partial<AgentMailMessage> = {}): AgentMailMessage {
  return { from, ...extra };
}

// =====================================================================
// scanThreadForSelf — the pure scan over an already-fetched thread.
// =====================================================================

describe('scanThreadForSelf', () => {
  it('self IS in thread → selfPresent=true, messages passed through', () => {
    const messages: AgentMailMessage[] = [
      msg('alice@example.com', { extracted_text: 'お問い合わせです' }),
      msg('MAKOTO <Makoto@AgentMail.to>', { extracted_text: '返信です' }),
      msg('alice@example.com', { extracted_text: '了解しました' }),
    ];
    const thread: AgentMailThread = { messages };

    const { logger, warns } = makeLogger();
    const result = scanThreadForSelf(thread, INBOX_ID, logger);

    expect(result.selfPresent).toBe(true);
    expect(result.messages).toBe(messages); // pass-through, no copy
    expect(result.messages).toHaveLength(3);
    expect(result.sendersSelf).toBe(false); // no senders field on thread
    expect(warns).toEqual([]); // no warning on success
  });

  it('self NOT in thread → selfPresent=false', () => {
    const messages: AgentMailMessage[] = [
      msg('alice@example.com'),
      msg('bob@example.com'),
      msg('Carol Doe <carol@external.com>'),
    ];
    const thread: AgentMailThread = { messages };

    const { logger, warns } = makeLogger();
    const result = scanThreadForSelf(thread, INBOX_ID, logger);

    expect(result.selfPresent).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.sendersSelf).toBe(false);
    expect(warns).toEqual([]);
  });

  it('empty messages array → selfPresent=false, WARN emitted', () => {
    const thread: AgentMailThread = { messages: [] };

    const { logger, warns } = makeLogger();
    const result = scanThreadForSelf(thread, INBOX_ID, logger, 'thr-abc');

    expect(result.selfPresent).toBe(false);
    expect(result.messages).toEqual([]);
    expect(result.sendersSelf).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('thread_id=thr-abc');
    expect(warns[0]).toContain('messages 欠落/空');
  });

  it('missing messages field → selfPresent=false, WARN emitted', () => {
    const thread: AgentMailThread = {}; // no messages key

    const { logger, warns } = makeLogger();
    const result = scanThreadForSelf(thread, INBOX_ID, logger, 'thr-xyz');

    expect(result.selfPresent).toBe(false);
    expect(result.messages).toEqual([]);
    expect(result.sendersSelf).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('thread_id=thr-xyz');
  });

  it('mixed thread with case/whitespace/angle-wrapped self addresses → selfPresent=true', () => {
    // Python `_normalize_email` lowercases + strips `< >` wrapper but
    // does NOT strip `+tag`. Cover all three transforms here.
    const messages: AgentMailMessage[] = [
      msg('  customer@x.com  '),
      msg('Stranger <stranger@x.com>'),
      // angle-wrapped + mixed case + outer whitespace — all should still match
      msg('  MAKOTO Bot <Makoto@AgentMail.TO>  '),
    ];
    const thread: AgentMailThread = { messages };

    const result = scanThreadForSelf(thread, INBOX_ID);

    expect(result.selfPresent).toBe(true);
  });

  it('non-object entries in messages array are skipped without throwing', () => {
    // Python guards with `isinstance(m, dict)`. Mirror that resilience.
    const messages = [
      null,
      'not-a-message',
      msg('Makoto@AgentMail.to'),
      undefined,
    ] as unknown as AgentMailMessage[];
    const thread: AgentMailThread = { messages };

    const result = scanThreadForSelf(thread, INBOX_ID);

    expect(result.selfPresent).toBe(true); // the one real message matches
  });

  it('senders[] echoes self → sendersSelf=true (audit only, does NOT flip selfPresent)', () => {
    // Per the design note in `_thread_self_scan`: senders is audit-only.
    // selfPresent must remain driven solely by messages[].from.
    const messages: AgentMailMessage[] = [
      msg('alice@example.com'),
      msg('bob@example.com'),
    ];
    const thread: AgentMailThread = {
      messages,
      senders: ['alice@example.com', 'makoto@agentmail.to'],
    };

    const result = scanThreadForSelf(thread, INBOX_ID);

    expect(result.selfPresent).toBe(false); // messages[].from has no self
    expect(result.sendersSelf).toBe(true); // senders[] does
  });

  it('null thread → selfPresent=false, WARN emitted', () => {
    const { logger, warns } = makeLogger();

    const result = scanThreadForSelf(null, INBOX_ID, logger, 'thr-null');

    expect(result.selfPresent).toBe(false);
    expect(result.messages).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('thr-null');
  });
});

// =====================================================================
// threadSelfScan — orchestrator with injected fetch.
// =====================================================================

describe('threadSelfScan', () => {
  it('fetches via injected function and returns scan result', async () => {
    const fetchThread = vi.fn().mockResolvedValue({
      messages: [
        msg('alice@example.com'),
        msg('makoto@agentmail.to'),
      ],
    } satisfies AgentMailThread);

    const result = await threadSelfScan(fetchThread, INBOX_ID, 'thr-1');

    expect(fetchThread).toHaveBeenCalledOnce();
    expect(fetchThread).toHaveBeenCalledWith(INBOX_ID, 'thr-1');
    expect(result.selfPresent).toBe(true);
    expect(result.messages).toHaveLength(2);
  });

  it('fetch error → returns fail-closed result + WARN (no throw)', async () => {
    const fetchThread = vi.fn().mockRejectedValue(
      new Error('AgentMail GET /threads/thr-2 failed: 500'),
    );
    const { logger, warns } = makeLogger();

    const result = await threadSelfScan(fetchThread, INBOX_ID, 'thr-2', logger);

    expect(result.selfPresent).toBe(false);
    expect(result.messages).toEqual([]);
    expect(result.sendersSelf).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('threads.get failed');
    expect(warns[0]).toContain('thr-2');
  });
});

// =====================================================================
// normalizeEmail — byte-equivalence with Python _normalize_email.
// =====================================================================

describe('normalizeEmail', () => {
  it.each([
    // [input, expected]
    ['MAKOTO <Makoto@AgentMail.to>', 'makoto@agentmail.to'],
    ['  makoto@agentmail.to  ', 'makoto@agentmail.to'],
    ['Makoto@AgentMail.TO', 'makoto@agentmail.to'],
    // KEY parity case: Python `_normalize_email` does NOT strip `+tag`.
    // (vs `cma_session_resolver._normalize_email` which DOES strip)
    ['makoto+test@agentmail.to', 'makoto+test@agentmail.to'],
    ['<bare@x.com>', 'bare@x.com'],
    ['', ''],
  ])('normalizes %j → %j', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });
});
