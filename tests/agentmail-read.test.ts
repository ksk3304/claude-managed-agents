/**
 * Unit tests for AgentMail read-only custom tool.
 */

import { describe, it, expect } from 'vitest';
import { agentmailRead } from '../src/tools/agentmail-read';
import { makeFetchMock } from './makoto-helpers';

const DEPS = {
  apiKey: 'am-key',
  inboxId: 'inbox_main',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('agentmailRead search', () => {
  it('requires at least one selector', async () => {
    await expect(agentmailRead({ action: 'search' }, DEPS)).rejects.toThrow(
      /search requires at least one selector/,
    );
  });

  it('lists bounded message metadata without body', async () => {
    const fetcher = makeFetchMock(async (url, init) => {
      expect(init.method).toBe('GET');
      const parsed = new URL(url);
      expect(parsed.searchParams.get('limit')).toBe('10');
      expect(parsed.searchParams.get('after')).toBe('2026-06-01T00:00:00Z');
      expect(parsed.searchParams.get('include_spam')).toBe('true');
      return jsonResponse(200, {
        messages: [
          {
            id: 'msg_1',
            message_id: '<rfc1@example.com>',
            thread_id: 'thr_1',
            from: 'survey@example.com',
            to: ['makoto@example.com'],
            subject: 'アンケート回答',
            received_at: '2026-06-01T01:00:00Z',
            extracted_text: 'body must not leak from search',
          },
        ],
        next_page_token: 'next',
      });
    });
    const res = await agentmailRead(
      { action: 'search', after: '2026-06-01T00:00:00Z' },
      { ...DEPS, fetcher },
    );
    expect(res.count).toBe(1);
    expect(res.truncated).toBe(true);
    expect(res.next_page_token).toBe('next');
    const msg = (res.messages as Array<Record<string, unknown>>)[0];
    expect(msg.id).toBe('msg_1');
    expect(msg.body).toBeUndefined();
  });

  it('fills id from message_id when AgentMail list omits opaque id', async () => {
    const fetcher = makeFetchMock(async () =>
      jsonResponse(200, {
        messages: [
          {
            id: '',
            message_id: '<CAJN01hdj5hXqvSmp67wePx2jL9Px7JbZ7oqgWKUe71VdAtPyOg@mail.gmail.com>',
            thread_id: 'c7b5b833-bf1b-4d93-97d1-0bf572e866e7',
            subject: 'Fwd: 【初校】巻頭対談(河北新報：水野)',
            timestamp: '2026-06-04T03:23:49Z',
          },
        ],
      }),
    );
    const res = await agentmailRead(
      { action: 'search', subject_contains: '巻頭対談' },
      { ...DEPS, fetcher },
    );
    const msg = (res.messages as Array<Record<string, unknown>>)[0];
    expect(msg.id).toBe('<CAJN01hdj5hXqvSmp67wePx2jL9Px7JbZ7oqgWKUe71VdAtPyOg@mail.gmail.com>');
    expect(msg.message_id).toBe(
      '<CAJN01hdj5hXqvSmp67wePx2jL9Px7JbZ7oqgWKUe71VdAtPyOg@mail.gmail.com>',
    );
    expect(msg.thread_id).toBe('c7b5b833-bf1b-4d93-97d1-0bf572e866e7');
    expect(msg.received_at).toBe('2026-06-04T03:23:49Z');
  });

  it('allows callers to opt out of spam-inclusive search', async () => {
    const fetcher = makeFetchMock(async (url) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('include_spam')).toBeNull();
      return jsonResponse(200, { messages: [] });
    });
    const res = await agentmailRead(
      { action: 'search', after: '2026-06-01T00:00:00Z', include_spam: false },
      { ...DEPS, fetcher },
    );
    expect(res.count).toBe(0);
  });

  it('applies local from and subject filters', async () => {
    const fetcher = makeFetchMock(async () =>
      jsonResponse(200, {
        messages: [
          { id: 'a', from: 'alice@example.com', subject: 'アンケート回答' },
          { id: 'b', from: 'bob@example.com', subject: '別件' },
        ],
      }),
    );
    const res = await agentmailRead(
      { action: 'search', from_contains: 'alice', subject_contains: 'アンケート' },
      { ...DEPS, fetcher },
    );
    const messages = res.messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => m.id)).toEqual(['a']);
  });
});

describe('agentmailRead get', () => {
  it('fetches one message body with truncation and secret redaction', async () => {
    const fetcher = makeFetchMock(async (url, init) => {
      expect(init.method).toBe('GET');
      expect(url).toBe('https://api.agentmail.to/v0/inboxes/inbox_main/messages/msg_1');
      return jsonResponse(200, {
        id: 'msg_1',
        from: 'alice@example.com',
        subject: '回答',
        extracted_text: 'hello api_key=secret1234567890 tail',
        attachments: [{ filename: 'a.pdf', content_type: 'application/pdf', size: 12 }],
      });
    });
    const res = await agentmailRead(
      { action: 'get', message_id: 'msg_1', max_chars: 20 },
      { ...DEPS, fetcher },
    );
    const message = res.message as Record<string, unknown>;
    expect(message.body).toBe('hello api_key=[REDAC');
    expect(message.body_truncated).toBe(true);
    expect(message.attachments).toEqual([
      { filename: 'a.pdf', content_type: 'application/pdf', size: 12 },
    ]);
  });

  it('retries RFC822 message_id with brackets when the first get 404s', async () => {
    const urls: string[] = [];
    const fetcher = makeFetchMock(async (url) => {
      urls.push(url);
      if (url.endsWith('/messages/rfc1%40example.com')) {
        return new Response('not found', { status: 404 });
      }
      expect(url).toBe('https://api.agentmail.to/v0/inboxes/inbox_main/messages/%3Crfc1%40example.com%3E');
      return jsonResponse(200, {
        message_id: '<rfc1@example.com>',
        subject: '回答',
        text: 'bracketed body',
      });
    });
    const res = await agentmailRead(
      { action: 'get', message_id: 'rfc1@example.com' },
      { ...DEPS, fetcher },
    );
    const message = res.message as Record<string, unknown>;
    expect(urls).toEqual([
      'https://api.agentmail.to/v0/inboxes/inbox_main/messages/rfc1%40example.com',
      'https://api.agentmail.to/v0/inboxes/inbox_main/messages/%3Crfc1%40example.com%3E',
    ]);
    expect(message.body).toBe('bracketed body');
  });

  it('falls back to thread_id when message get 404s and returns matching body', async () => {
    const urls: string[] = [];
    const fetcher = makeFetchMock(async (url) => {
      urls.push(url);
      if (url.includes('/messages/')) return new Response('not found', { status: 404 });
      expect(url).toBe(
        'https://api.agentmail.to/v0/inboxes/inbox_main/threads/c7b5b833-bf1b-4d93-97d1-0bf572e866e7',
      );
      return jsonResponse(200, {
        thread_id: 'c7b5b833-bf1b-4d93-97d1-0bf572e866e7',
        messages: [
          {
            message_id: '<older@example.com>',
            from: 'Other <other@example.com>',
            subject: '別件',
            extracted_text: 'wrong body',
          },
          {
            message_id: '<CAJN01hdj5hXqvSmp67wePx2jL9Px7JbZ7oqgWKUe71VdAtPyOg@mail.gmail.com>',
            thread_id: 'c7b5b833-bf1b-4d93-97d1-0bf572e866e7',
            from: 'Tomohiro Takei <takei@makotoprime.com>',
            subject: 'Fwd: 【初校】巻頭対談(河北新報：水野)',
            extracted_text: '本文が読めました',
            attachments: [{ filename: 'draft.pdf', content_type: 'application/pdf', size: 100 }],
          },
        ],
      });
    });
    const res = await agentmailRead(
      {
        action: 'get',
        message_id: 'CAJN01hdj5hXqvSmp67wePx2jL9Px7JbZ7oqgWKUe71VdAtPyOg@mail.gmail.com',
        thread_id: 'c7b5b833-bf1b-4d93-97d1-0bf572e866e7',
        from_contains: 'takei@makotoprime.com',
        subject_contains: '巻頭対談',
      },
      { ...DEPS, fetcher },
    );
    const message = res.message as Record<string, unknown>;
    expect(urls).toEqual([
      'https://api.agentmail.to/v0/inboxes/inbox_main/messages/CAJN01hdj5hXqvSmp67wePx2jL9Px7JbZ7oqgWKUe71VdAtPyOg%40mail.gmail.com',
      'https://api.agentmail.to/v0/inboxes/inbox_main/messages/%3CCAJN01hdj5hXqvSmp67wePx2jL9Px7JbZ7oqgWKUe71VdAtPyOg%40mail.gmail.com%3E',
      'https://api.agentmail.to/v0/inboxes/inbox_main/threads/c7b5b833-bf1b-4d93-97d1-0bf572e866e7',
    ]);
    expect(message.body).toBe('本文が読めました');
    expect(message.attachments).toEqual([
      { filename: 'draft.pdf', content_type: 'application/pdf', size: 100 },
    ]);
  });

  it('fails closed when AgentMail credential is missing', async () => {
    await expect(
      agentmailRead({ action: 'get', message_id: 'msg_1' }, { inboxId: 'inbox_main' }),
    ).rejects.toThrow(/AgentMail の取得に失敗/);
  });
});
