/**
 * Unit tests for `src/lib/agentmail-api.ts` — AgentMail REST client.
 */

import { describe, it, expect } from 'vitest';
import {
  AgentMailClient,
  AgentMailError,
} from '../src/lib/agentmail-api';
import { makeFetchMock } from './makoto-helpers';

const API_KEY = 'test-key';
const INBOX = 'inbox_main';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AgentMailClient.sendMessage', () => {
  it('POSTs to /v0/inboxes/{inbox}/messages/send with the right body', async () => {
    const fetchMock = makeFetchMock(async (url, init) => {
      expect(url).toBe(`https://api.agentmail.to/v0/inboxes/${INBOX}/messages/send`);
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['authorization']).toBe(
        `Bearer ${API_KEY}`,
      );
      const body = JSON.parse(init.body as string);
      expect(body.to).toEqual(['x@y']);
      expect(body.subject).toBe('hello');
      expect(body.text).toBe('body content');
      return jsonResponse(200, { message_id: 'msg_1', rfc822_message_id: '<rfc@x>' });
    });
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock });
    const r = await client.sendMessage({
      inboxId: INBOX,
      to: ['x@y'],
      subject: 'hello',
      body: 'body content',
    });
    expect(r).toEqual({ message_id: 'msg_1', rfc822_message_id: '<rfc@x>' });
  });

  it('includes cc/bcc when provided', async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchMock = makeFetchMock(async (_url, init) => {
      captured = JSON.parse(init.body as string);
      return jsonResponse(200, { id: 'msg_2' });
    });
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock });
    await client.sendMessage({
      inboxId: INBOX,
      to: ['x@y'],
      cc: ['c@y'],
      bcc: ['b@y'],
      subject: 's',
      body: 'b',
    });
    expect(captured!.cc).toEqual(['c@y']);
    expect(captured!.bcc).toEqual(['b@y']);
  });

  it('falls back to `id` when response omits `message_id`', async () => {
    const fetchMock = makeFetchMock(async () => jsonResponse(200, { id: 'msg_fallback' }));
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock });
    const r = await client.sendMessage({ inboxId: INBOX, to: ['x@y'], subject: 's', body: 'b' });
    expect(r.message_id).toBe('msg_fallback');
  });

  it('retries on 429 then succeeds', async () => {
    let calls = 0;
    const fetchMock = makeFetchMock(async () => {
      calls++;
      if (calls < 2) return new Response('rate limited', { status: 429 });
      return jsonResponse(200, { message_id: 'ok' });
    });
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock, maxRetries: 3 });
    const r = await client.sendMessage({ inboxId: INBOX, to: ['x@y'], subject: 's', body: 'b' });
    expect(r.message_id).toBe('ok');
    expect(calls).toBe(2);
  });

  it('throws AgentMailError with transient=true on 5xx after exhausting retries', async () => {
    const fetchMock = makeFetchMock(async () => new Response('boom', { status: 503 }));
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock, maxRetries: 1 });
    try {
      await client.sendMessage({ inboxId: INBOX, to: ['x@y'], subject: 's', body: 'b' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentMailError);
      const e = err as AgentMailError;
      expect(e.status).toBe(503);
      expect(e.transient).toBe(true);
    }
  });

  it('throws AgentMailError with transient=false on 4xx', async () => {
    const fetchMock = makeFetchMock(async () => new Response('bad', { status: 400 }));
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock });
    try {
      await client.sendMessage({ inboxId: INBOX, to: ['x@y'], subject: 's', body: 'b' });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as AgentMailError;
      expect(e.status).toBe(400);
      expect(e.transient).toBe(false);
    }
  });
});

describe('AgentMailClient.replyMessage', () => {
  it('targets the /reply endpoint under the parent message id with text only', async () => {
    let url = '';
    let body: Record<string, unknown> | null = null;
    const fetchMock = makeFetchMock(async (u, init) => {
      url = u;
      body = JSON.parse(init.body as string);
      return jsonResponse(200, { message_id: 'reply_1' });
    });
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock });
    await client.replyMessage({
      inboxId: INBOX,
      to: ['x@y'],
      subject: 'Re',
      body: 'b',
      parentMessageId: 'parent_msg',
    });
    expect(url).toBe(`https://api.agentmail.to/v0/inboxes/${INBOX}/messages/parent_msg/reply`);
    expect(body).toEqual({ text: 'b' });
  });
});

describe('AgentMailClient.getMessage', () => {
  it('GETs the message and returns parsed JSON', async () => {
    const fetchMock = makeFetchMock(async (_url, init) => {
      expect(init.method).toBe('GET');
      return jsonResponse(200, { id: 'msg_x', subject: 'hi' });
    });
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock });
    const m = await client.getMessage(INBOX, 'msg_x');
    expect(m.id).toBe('msg_x');
    expect(m.subject).toBe('hi');
  });
});

describe('AgentMailClient.getMessageAttachment', () => {
  it('follows AgentMail download_url descriptors without forwarding Authorization', async () => {
    const calls: Array<{ url: string; authorization: string | undefined }> = [];
    const fetchMock = makeFetchMock(async (url, init) => {
      calls.push({
        url,
        authorization: (init.headers as Record<string, string>)['authorization'],
      });
      if (url.endsWith('/messages/msg_x/attachments/att_x')) {
        return jsonResponse(200, {
          attachment_id: 'att_x',
          download_url: 'https://signed.agentmail-download.test/att_x?sig=ok',
          filename: 'sample.docx',
        });
      }
      if (url === 'https://signed.agentmail-download.test/att_x?sig=ok') {
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      return new Response('unexpected', { status: 500 });
    });
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock });

    const data = await client.getMessageAttachment(INBOX, 'msg_x', 'att_x');

    expect([...data]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(calls).toEqual([
      {
        url: `https://api.agentmail.to/v0/inboxes/${INBOX}/messages/msg_x/attachments/att_x`,
        authorization: `Bearer ${API_KEY}`,
      },
      {
        url: 'https://signed.agentmail-download.test/att_x?sig=ok',
        authorization: undefined,
      },
    ]);
  });

  it('blocks non-HTTPS attachment download_url values', async () => {
    const fetchMock = makeFetchMock(async () =>
      jsonResponse(200, {
        attachment_id: 'att_x',
        download_url: 'http://signed.agentmail-download.test/att_x',
      }),
    );
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock });

    await expect(client.getMessageAttachment(INBOX, 'msg_x', 'att_x')).rejects.toThrow(
      /egress denied/,
    );
  });

  it('rejects oversized downloads using Content-Length before reading the body', async () => {
    const fetchMock = makeFetchMock(async () =>
      new Response('too large', {
        status: 200,
        headers: { 'content-length': '1024' },
      }),
    );
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock });

    await expect(
      client.getMessageAttachment(INBOX, 'msg_x', 'att_x', { maxBytes: 10 }),
    ).rejects.toMatchObject({
      status: 413,
      transient: false,
    });
  });
});

describe('AgentMailClient.getThread', () => {
  it('GETs the thread and returns messages', async () => {
    const fetchMock = makeFetchMock(async (url, init) => {
      expect(init.method).toBe('GET');
      expect(url).toBe(`https://api.agentmail.to/v0/inboxes/${INBOX}/threads/thread_x`);
      return jsonResponse(200, {
        thread_id: 'thread_x',
        messages: [{ message_id: '<m@example.com>', text: 'body' }],
      });
    });
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock });
    const thread = await client.getThread(INBOX, 'thread_x');
    expect(thread.thread_id).toBe('thread_x');
    expect(thread.messages?.[0]?.text).toBe('body');
  });
});

describe('AgentMailClient.listMessages', () => {
  it('includes spam by default for polling-style readers', async () => {
    const fetchMock = makeFetchMock(async (url, init) => {
      expect(init.method).toBe('GET');
      const parsed = new URL(url);
      expect(parsed.searchParams.get('include_spam')).toBe('true');
      return jsonResponse(200, { messages: [] });
    });
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock });
    await client.listMessages(INBOX, { limit: 10 });
  });

  it('allows callers to opt out of spam-inclusive listing', async () => {
    const fetchMock = makeFetchMock(async (url) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('include_spam')).toBeNull();
      return jsonResponse(200, { messages: [] });
    });
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock });
    await client.listMessages(INBOX, { limit: 10, includeSpam: false });
  });

  it('uses current AgentMail pagination and safety query params', async () => {
    const fetchMock = makeFetchMock(async (url, init) => {
      expect(init.method).toBe('GET');
      const parsed = new URL(url);
      expect(parsed.pathname).toBe(`/v0/inboxes/${INBOX}/messages`);
      expect(parsed.searchParams.get('limit')).toBe('5');
      expect(parsed.searchParams.get('page_token')).toBe('pt_1');
      expect(parsed.searchParams.getAll('labels')).toEqual(['survey']);
      expect(parsed.searchParams.get('after')).toBe('2026-06-01T00:00:00Z');
      expect(parsed.searchParams.get('before')).toBe('2026-06-02T00:00:00Z');
      expect(parsed.searchParams.get('include_spam')).toBe('true');
      expect(parsed.searchParams.get('include_blocked')).toBe('true');
      expect(parsed.searchParams.get('include_unauthenticated')).toBe('true');
      return jsonResponse(200, {
        messages: [{ id: 'msg_x', subject: 'hi' }],
        next_page_token: 'pt_2',
      });
    });
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock });
    const res = await client.listMessages(INBOX, {
      limit: 5,
      pageToken: 'pt_1',
      labels: ['survey'],
      after: '2026-06-01T00:00:00Z',
      before: '2026-06-02T00:00:00Z',
      includeSpam: true,
      includeBlocked: true,
      includeUnauthenticated: true,
    });
    expect(res.messages[0].id).toBe('msg_x');
    expect(res.next_page_token).toBe('pt_2');
  });
});

describe('AgentMailClient egress guard', () => {
  it('throws BridgeEgressDeniedError when baseUrl is off the allowlist', async () => {
    const client = new AgentMailClient(API_KEY, { baseUrl: 'https://evil.example.com' });
    await expect(
      client.sendMessage({ inboxId: INBOX, to: ['x@y'], subject: 's', body: 'b' }),
    ).rejects.toThrow(/egress denied/);
  });
});
