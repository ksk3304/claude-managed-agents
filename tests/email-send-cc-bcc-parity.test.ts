/**
 * Cloudflare / TypeScript EMAIL_SEND CC/BCC regression suite.
 *
 * This is the TS-side equivalent of makoto-prime
 * `tests/test_cma_gchat_email_cc.sh`: keep the parser, AgentMail payload,
 * and BCC redaction contracts in one focused place.
 */

import { describe, expect, it } from 'vitest';
import { AgentMailClient } from '../src/lib/agentmail-api';
import {
  BCC_REDACTED_PLACEHOLDER,
  parseAssistantText,
  redactEmailSendOnCap,
} from '../src/lib/email-send-marker';
import { makeFetchMock } from './makoto-helpers';

const API_KEY = 'test-key';
const INBOX = 'test-inbox';

function okResponse(body: unknown = { message_id: 'fake-id' }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('EMAIL_SEND CC/BCC parity: marker normalization', () => {
  it('omits empty cc/bcc values and trims string arrays', () => {
    const result = parseAssistantText(
      'EMAIL_SEND:{"to":"a@x","subject":"s","body":"b","cc":[" c@x ","","  "],"bcc":[]}',
    );

    expect(result.failures).toHaveLength(0);
    expect(result.markers).toHaveLength(1);
    expect(result.markers[0]).toMatchObject({
      to: 'a@x',
      subject: 's',
      body: 'b',
      cc: ['c@x'],
    });
    expect(result.markers[0]!.bcc).toBeUndefined();
  });

  it('accepts cc/bcc strings and arrays, rejecting non-string list members', () => {
    const result = parseAssistantText(
      'EMAIL_SEND:{"to":"a@x","subject":"s","body":"b","cc":"cc@x","bcc":["b1@x",123," b2@x "]}',
    );

    expect(result.failures).toHaveLength(0);
    expect(result.markers[0]!.cc).toEqual(['cc@x']);
    expect(result.markers[0]!.bcc).toEqual(['b1@x', 'b2@x']);
  });

  it('rejects array to so multiple reply targets must be separate markers', () => {
    const result = parseAssistantText(
      'EMAIL_SEND:{"to":["a@x","b@x"],"subject":"s","body":"b","cc":"c@x"}',
    );

    expect(result.markers).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.reason).toContain('EMAIL_SEND.to');
  });
});

describe('EMAIL_SEND CC/BCC parity: answer targets vs CC auditors', () => {
  it('parses A/B as two reply targets while C stays CC-only on both messages', () => {
    const result = parseAssistantText(
      [
        '2件送信します。',
        'EMAIL_SEND:{"to":"a@example.com","cc":"c@example.com","subject":"レビュー依頼","body":"レビューをお願いします。"}',
        'EMAIL_SEND:{"to":"b@example.com","cc":"c@example.com","subject":"レビュー依頼","body":"レビューをお願いします。"}',
      ].join('\n'),
    );

    expect(result.failures).toHaveLength(0);
    expect(result.markers.map((m) => m.to)).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
    expect(result.markers.map((m) => m.cc)).toEqual([
      ['c@example.com'],
      ['c@example.com'],
    ]);
    expect(result.markers.flatMap((m) => m.cc ?? [])).not.toContain('a@example.com');
    expect(result.markers.flatMap((m) => m.cc ?? [])).not.toContain('b@example.com');
  });
});

describe('EMAIL_SEND CC/BCC parity: AgentMail payload', () => {
  it('omits cc/bcc keys when they are absent', async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchMock = makeFetchMock(async (_url, init) => {
      captured = JSON.parse(init.body as string);
      return okResponse();
    });
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock });

    await client.sendMessage({
      inboxId: INBOX,
      to: ['to@x'],
      subject: 's',
      body: 'b',
    });

    expect(captured).toEqual({
      to: ['to@x'],
      subject: 's',
      text: 'b',
    });
  });

  it('includes cc/bcc arrays when provided', async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchMock = makeFetchMock(async (_url, init) => {
      captured = JSON.parse(init.body as string);
      return okResponse();
    });
    const client = new AgentMailClient(API_KEY, { fetchImpl: fetchMock });

    await client.sendMessage({
      inboxId: INBOX,
      to: ['to@x'],
      cc: ['cc1@x', 'cc2@x'],
      bcc: ['bcc@x'],
      subject: 's',
      body: 'b',
    });

    expect(captured).toMatchObject({
      to: ['to@x'],
      cc: ['cc1@x', 'cc2@x'],
      bcc: ['bcc@x'],
      subject: 's',
      text: 'b',
    });
  });
});

describe('EMAIL_SEND CC/BCC parity: BCC redaction on skipped sends', () => {
  it('redacts explicit BCC addresses from the prefix and keeps the prefix', () => {
    const result = redactEmailSendOnCap(
      [
        '以下の内容で送ります。BCC: secret-bcc@x にも送ります。',
        '',
        'EMAIL_SEND:{"to":"a@x","subject":"s","body":"b","bcc":["secret-bcc@x"]}',
      ].join('\n'),
      'tool_call_cap',
    );

    expect(result.prefixDiscarded).toBe(false);
    expect(result.redactedPrefix).toContain('以下の内容で送ります');
    expect(result.redactedPrefix).toContain(BCC_REDACTED_PLACEHOLDER);
    expect(result.redactedPrefix).not.toContain('secret-bcc@x');
  });

  it('redacts multiple BCC occurrences case-insensitively', () => {
    const result = redactEmailSendOnCap(
      [
        'Secret-Bcc@X / secret-bcc@x',
        'EMAIL_SEND:{"to":"a@x","subject":"s","body":"b","bcc":"secret-bcc@x"}',
      ].join('\n'),
      'session_watchdog',
    );

    expect(result.redactedPrefix).toBe(
      `${BCC_REDACTED_PLACEHOLDER} / ${BCC_REDACTED_PLACEHOLDER}`,
    );
  });

  it('discards prefix when malformed marker prevents BCC detection', () => {
    const result = redactEmailSendOnCap(
      'prefix may contain unknown BCC\nEMAIL_SEND:{"to":"a@x","subject":"s",}}',
      'max_iter',
    );

    expect(result.markerFound).toBe(true);
    expect(result.prefixDiscarded).toBe(true);
    expect(result.finalText).toBe('');
  });
});
