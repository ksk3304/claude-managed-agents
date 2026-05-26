/**
 * Unit tests for `src/lib/mail-history.ts` — AgentMail thread-history
 * fetcher used by the continuation-reply dispatcher. Parity target:
 * `scripts/cma_agentmail_inbound.py:_fetch_thread_messages` (line
 * 2027-2041) + `PROMPT_MESSAGE_LIMIT = 10` (line 87).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MAIL_HISTORY_MESSAGE_LIMIT,
  buildMailContinuationPrompt,
  fetchMailThreadMessages,
  type MailHistoryEnv,
} from '../src/lib/mail-history';
import type { AgentMailMessage } from '../src/types/agentmail';
import { makeFetchMock } from './makoto-helpers';

const API_KEY = 'test-key';
const INBOX = 'inbox_main';
const THREAD = 'thread_abc';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function plainResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

function envWith(overrides: Partial<MailHistoryEnv> = {}): MailHistoryEnv {
  return {
    AGENTMAIL_API_KEY: API_KEY,
    ...overrides,
  };
}

describe('fetchMailThreadMessages — happy path', () => {
  it('GETs /v0/inboxes/{inbox}/threads/{thread} with the right headers', async () => {
    const fetchMock = makeFetchMock(async (url, init) => {
      expect(url).toBe(
        `https://api.agentmail.to/v0/inboxes/${INBOX}/threads/${THREAD}`,
      );
      expect(init.method).toBe('GET');
      const headers = init.headers as Record<string, string>;
      expect(headers['authorization']).toBe(`Bearer ${API_KEY}`);
      expect(headers['accept']).toBe('application/json');
      return jsonResponse(200, {
        messages: [
          { id: 'm-1', from: 'bot@x', extracted_text: 'first', received_at: '2026-05-01' },
          { id: 'm-2', from: 'alice@x', extracted_text: 'reply', received_at: '2026-05-02' },
        ],
      });
    });

    const msgs = await fetchMailThreadMessages(envWith(), INBOX, THREAD, {
      fetchImpl: fetchMock,
    });

    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.id).toBe('m-1');
    expect(msgs[1]!.id).toBe('m-2');
    expect(fetchMock.calls).toHaveLength(1);
  });

  it('honours AGENTMAIL_API_BASE_URL override (within egress allowlist)', async () => {
    // Override hosts must stay on the egress allowlist —
    // `assertBridgeEgressAllowed` denies anything else. Realistic
    // override use case: a versioned path on the same host
    // (`/v1` instead of `/v0`) or a trailing-slash variant.
    const fetchMock = makeFetchMock(async (url) => {
      expect(url).toBe(
        `https://api.agentmail.to/v1/inboxes/${INBOX}/threads/${THREAD}`,
      );
      return jsonResponse(200, { messages: [] });
    });
    await fetchMailThreadMessages(
      envWith({ AGENTMAIL_API_BASE_URL: 'https://api.agentmail.to/v1' }),
      INBOX,
      THREAD,
      { fetchImpl: fetchMock },
    );
    expect(fetchMock.calls).toHaveLength(1);
  });

  it('returns [] when override host is denied by egress allowlist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = makeFetchMock(async () => {
      throw new Error('should not be called — egress should block first');
    });
    const got = await fetchMailThreadMessages(
      envWith({ AGENTMAIL_API_BASE_URL: 'https://evil.example.com/v0' }),
      INBOX,
      THREAD,
      { fetchImpl: fetchMock },
    );
    expect(got).toEqual([]);
    expect(fetchMock.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('egress denied'),
    );
    warn.mockRestore();
  });

  it('returns [] when AgentMail says the thread is empty', async () => {
    const fetchMock = makeFetchMock(async () => jsonResponse(200, { messages: [] }));
    const msgs = await fetchMailThreadMessages(envWith(), INBOX, THREAD, {
      fetchImpl: fetchMock,
    });
    expect(msgs).toEqual([]);
  });
});

describe('fetchMailThreadMessages — limit + truncation', () => {
  it('keeps only the most-recent MAIL_HISTORY_MESSAGE_LIMIT messages', async () => {
    // 15 messages → only last 10 kept, preserving order
    const messages: AgentMailMessage[] = Array.from({ length: 15 }, (_, i) => ({
      id: `m-${i}`,
      from: `s${i}@x`,
      extracted_text: `body-${i}`,
      received_at: `2026-05-${String(i + 1).padStart(2, '0')}`,
    }));
    const fetchMock = makeFetchMock(async () =>
      jsonResponse(200, { messages }),
    );
    const got = await fetchMailThreadMessages(envWith(), INBOX, THREAD, {
      fetchImpl: fetchMock,
    });
    expect(got).toHaveLength(MAIL_HISTORY_MESSAGE_LIMIT);
    expect(got[0]!.id).toBe('m-5');
    expect(got[MAIL_HISTORY_MESSAGE_LIMIT - 1]!.id).toBe('m-14');
  });

  it('keeps all when count <= limit', async () => {
    const messages: AgentMailMessage[] = Array.from({ length: 3 }, (_, i) => ({
      id: `m-${i}`,
    }));
    const fetchMock = makeFetchMock(async () =>
      jsonResponse(200, { messages }),
    );
    const got = await fetchMailThreadMessages(envWith(), INBOX, THREAD, {
      fetchImpl: fetchMock,
    });
    expect(got).toHaveLength(3);
  });
});

describe('fetchMailThreadMessages — failure modes', () => {
  it('returns [] + no fetch when AGENTMAIL_API_KEY is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = makeFetchMock(async () => {
      throw new Error('should not be called');
    });
    const got = await fetchMailThreadMessages(
      { AGENTMAIL_API_KEY: undefined },
      INBOX,
      THREAD,
      { fetchImpl: fetchMock },
    );
    expect(got).toEqual([]);
    expect(fetchMock.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns [] + no fetch when inboxId is empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = makeFetchMock(async () => {
      throw new Error('should not be called');
    });
    const got = await fetchMailThreadMessages(envWith(), '', THREAD, {
      fetchImpl: fetchMock,
    });
    expect(got).toEqual([]);
    expect(fetchMock.calls).toHaveLength(0);
    warn.mockRestore();
  });

  it('returns [] + no fetch when threadId is empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = makeFetchMock(async () => {
      throw new Error('should not be called');
    });
    const got = await fetchMailThreadMessages(envWith(), INBOX, '', {
      fetchImpl: fetchMock,
    });
    expect(got).toEqual([]);
    expect(fetchMock.calls).toHaveLength(0);
    warn.mockRestore();
  });

  it('returns [] on 404 (stale thread / wrong inbox)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = makeFetchMock(async () => plainResponse(404, 'not found'));
    const got = await fetchMailThreadMessages(envWith(), INBOX, THREAD, {
      fetchImpl: fetchMock,
    });
    expect(got).toEqual([]);
    expect(fetchMock.calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('status=404'),
    );
    warn.mockRestore();
  });

  it('returns [] on 403 (wrong inbox auth)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = makeFetchMock(async () => plainResponse(403, 'forbidden'));
    const got = await fetchMailThreadMessages(envWith(), INBOX, THREAD, {
      fetchImpl: fetchMock,
    });
    expect(got).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('status=403'));
    warn.mockRestore();
  });

  it('returns [] on 5xx', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = makeFetchMock(async () => plainResponse(503, 'upstream'));
    const got = await fetchMailThreadMessages(envWith(), INBOX, THREAD, {
      fetchImpl: fetchMock,
    });
    expect(got).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns [] on network / fetch reject', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = makeFetchMock(async () => {
      throw new TypeError('network down');
    });
    const got = await fetchMailThreadMessages(envWith(), INBOX, THREAD, {
      fetchImpl: fetchMock,
    });
    expect(got).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('network error'),
    );
    warn.mockRestore();
  });

  it('returns [] on unparseable JSON body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = makeFetchMock(async () => plainResponse(200, '<<not json>>'));
    const got = await fetchMailThreadMessages(envWith(), INBOX, THREAD, {
      fetchImpl: fetchMock,
    });
    expect(got).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('parse error'));
    warn.mockRestore();
  });

  it('returns [] when 200 response lacks messages array', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = makeFetchMock(async () =>
      jsonResponse(200, { foo: 'bar' }),
    );
    const got = await fetchMailThreadMessages(envWith(), INBOX, THREAD, {
      fetchImpl: fetchMock,
    });
    expect(got).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('missing messages'),
    );
    warn.mockRestore();
  });

  it('drops non-object entries inside messages[]', async () => {
    const fetchMock = makeFetchMock(async () =>
      jsonResponse(200, {
        messages: [
          { id: 'm-good' },
          null,
          'string-junk',
          42,
          { id: 'm-good-2' },
        ],
      }),
    );
    const got = await fetchMailThreadMessages(envWith(), INBOX, THREAD, {
      fetchImpl: fetchMock,
    });
    expect(got.map((m) => m.id)).toEqual(['m-good', 'm-good-2']);
  });
});

describe('fetchMailThreadMessages — URL encoding', () => {
  it('percent-encodes inbox and thread ids', async () => {
    const fetchMock = makeFetchMock(async (url) => {
      expect(url).toBe(
        'https://api.agentmail.to/v0/inboxes/inbox%2Bone%40x.com/threads/t%2Fwith%20space',
      );
      return jsonResponse(200, { messages: [] });
    });
    await fetchMailThreadMessages(
      envWith(),
      'inbox+one@x.com',
      't/with space',
      { fetchImpl: fetchMock },
    );
    expect(fetchMock.calls).toHaveLength(1);
  });
});

describe('buildMailContinuationPrompt re-export', () => {
  it('delegates to the underlying continuation builder', () => {
    const inbound: AgentMailMessage = {
      id: 'm-x',
      from: 'alice@example.com',
      subject: 'Re: 案件',
      extracted_text: '了解',
    };
    const out = buildMailContinuationPrompt(inbound, []);
    expect(out).toContain('alice@example.com');
    expect(out).toContain('Re: 案件');
    expect(out).toContain('了解');
  });
});
