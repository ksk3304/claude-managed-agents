/**
 * Unit tests for `src/lib/email-thread.ts` — RFC 822 thread helpers.
 *
 * Parity with Python `scripts/cma_agentmail_inbound.py:786-820`
 * (`extract_thread_refs` / `re_chain_depth` / `_normalize_msgid` /
 * `extract_body`).
 */

import { describe, it, expect } from 'vitest';
import {
  extractBody,
  extractInboundRfc822MessageId,
  extractMessageIds,
  extractThreadRefs,
  normalizeMessageId,
  reChainDepth,
} from '../src/lib/email-thread';
import type { AgentMailMessage } from '../src/types/agentmail';

describe('normalizeMessageId', () => {
  it('strips a surrounding <...> pair and lowercases', () => {
    expect(normalizeMessageId('<ABC@Example.COM>')).toBe('abc@example.com');
  });
  it('returns empty string for empty input', () => {
    expect(normalizeMessageId('')).toBe('');
    expect(normalizeMessageId('   ')).toBe('');
  });
  it('passes through ids without brackets', () => {
    expect(normalizeMessageId('foo@bar.com')).toBe('foo@bar.com');
  });
});

describe('extractMessageIds', () => {
  it('returns [] for undefined', () => {
    expect(extractMessageIds(undefined)).toEqual([]);
  });
  it('handles an array of ids', () => {
    expect(extractMessageIds(['<a@x>', 'b@x'])).toEqual(['a@x', 'b@x']);
  });
  it('extracts bracketed ids from a string', () => {
    expect(extractMessageIds('<a@x> <b@x> not-bracketed')).toEqual(['a@x', 'b@x']);
  });
  it('falls back to whitespace split when no brackets present', () => {
    expect(extractMessageIds('a@x b@x')).toEqual(['a@x', 'b@x']);
  });
});

describe('extractThreadRefs', () => {
  it('returns empty refs for a message with no headers', () => {
    const msg: AgentMailMessage = { id: 'm1' };
    expect(extractThreadRefs(msg)).toEqual({ references: [] });
  });
  it('normalizes in_reply_to and merges into references tail', () => {
    const msg: AgentMailMessage = {
      id: 'm1',
      in_reply_to: '<IRT@example.com>',
      references: '<a@x> <b@x>',
    };
    const refs = extractThreadRefs(msg);
    expect(refs.inReplyTo).toBe('irt@example.com');
    expect(refs.references).toEqual(['a@x', 'b@x', 'irt@example.com']);
  });
  it('does not duplicate in_reply_to when references already contains it', () => {
    const msg: AgentMailMessage = {
      id: 'm1',
      in_reply_to: '<a@x>',
      references: ['<a@x>', '<b@x>'],
    };
    expect(extractThreadRefs(msg).references).toEqual(['a@x', 'b@x']);
  });
});

describe('reChainDepth', () => {
  it('returns 0 for no Re: prefix', () => {
    expect(reChainDepth('hello')).toBe(0);
    expect(reChainDepth(undefined)).toBe(0);
  });
  it('counts repeated Re: prefixes', () => {
    expect(reChainDepth('Re: hello')).toBe(1);
    expect(reChainDepth('Re: Re: Re: hello')).toBe(3);
    expect(reChainDepth('re:re:re: hello')).toBe(3);
  });
  it('caps at 20 (safety against pathological input)', () => {
    const subject = 'Re: '.repeat(50) + 'x';
    expect(reChainDepth(subject)).toBe(20);
  });
});

describe('extractBody', () => {
  it('prefers extracted_text', () => {
    const msg: AgentMailMessage = {
      id: 'm1',
      extracted_text: 'A',
      text: 'B',
      extracted_html: 'C',
      html: 'D',
    };
    expect(extractBody(msg)).toBe('A');
  });
  it('falls back through text → extracted_html → html', () => {
    expect(extractBody({ id: 'm', text: 'B' } as AgentMailMessage)).toBe('B');
    expect(extractBody({ id: 'm', extracted_html: 'C' } as AgentMailMessage)).toBe('C');
    expect(extractBody({ id: 'm', html: 'D' } as AgentMailMessage)).toBe('D');
  });
  it('returns empty string when nothing usable is present', () => {
    expect(extractBody({ id: 'm' } as AgentMailMessage)).toBe('');
  });
});

describe('extractInboundRfc822MessageId', () => {
  it('prefers rfc822_message_id', () => {
    const msg: AgentMailMessage = {
      id: 'm',
      rfc822_message_id: '<UPPER@X>',
      headers: { 'message-id': '<other@x>' },
    };
    expect(extractInboundRfc822MessageId(msg)).toBe('upper@x');
  });
  it('falls back to headers.message-id (case-insensitive)', () => {
    const msg: AgentMailMessage = {
      id: 'm',
      headers: { 'Message-ID': '<A@X>' },
    };
    expect(extractInboundRfc822MessageId(msg)).toBe('a@x');
  });
  it('returns empty string when no id is present', () => {
    expect(extractInboundRfc822MessageId({ id: 'm' } as AgentMailMessage)).toBe('');
  });
});
