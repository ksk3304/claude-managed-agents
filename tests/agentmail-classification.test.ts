/**
 * Unit tests for `src/lib/agentmail-classification.ts` — the
 * header-only continuation / cold-inbound decision tree (Issue
 * #186 G).
 *
 * Covers the five decision branches the dispatcher relies on:
 *
 *   1. cold inbound (unknown sender, no thread refs, no `Re:`)
 *   2. continuation via DB-confirmed RFC 822 In-Reply-To match
 *   3. continuation via DB-confirmed References match (no In-Reply-To)
 *   4. `Re:` prefix only (no DB match) — low-confidence continuation
 *   5. runaway `Re:` chain (>= RE_CHAIN_MAX) — demote to cold
 *
 * Plus a handful of edge cases that surfaced during the Python port:
 *
 *   - SignalB (`threadHasSelf`) alone is enough
 *   - legacy tertiary opaque-id match alone is enough
 *   - empty subject / undefined fields don't crash
 *   - `shouldAutoReply` convenience predicate matches `classify().kind`
 */

import { describe, it, expect } from 'vitest';
import {
  RE_CHAIN_MAX,
  classifyInboundMail,
  shouldAutoReply,
} from '../src/lib/agentmail-classification';
import type { AgentMailMessage } from '../src/types/agentmail';

function makeMessage(overrides: Partial<AgentMailMessage> = {}): AgentMailMessage {
  return {
    id: 'msg_in',
    from: 'alice@example.com',
    subject: 'Hello',
    extracted_text: 'body',
    ...overrides,
  };
}

describe('classifyInboundMail', () => {
  // ---- Branch 1: cold inbound ----
  it('cold inbound: no thread refs, no Re:, no DB match', () => {
    const msg = makeMessage({ subject: 'Hello' });
    const result = classifyInboundMail(msg);
    expect(result.kind).toBe('cold');
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.signals).toContain('no_thread_refs');
    expect(result.signals).not.toContain('re_prefix');
    expect(result.demotedReason).toBeUndefined();
  });

  // ---- Branch 2: continuation via In-Reply-To ----
  it('continuation: In-Reply-To matches knownOutboundMessageIds (high confidence)', () => {
    const msg = makeMessage({
      subject: 'Re: weekly sync',
      in_reply_to: '<bot-outbound-001@agentmail.to>',
    });
    const result = classifyInboundMail(msg, {
      knownOutboundMessageIds: new Set(['bot-outbound-001@agentmail.to']),
    });
    expect(result.kind).toBe('continuation');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.signals).toContain('rfc822_in_reply_to');
    expect(result.signals).toContain('re_prefix');
    expect(result.demotedReason).toBeUndefined();
  });

  // ---- Branch 3: continuation via References (no In-Reply-To) ----
  it('continuation: References array contains a known outbound id', () => {
    const msg = makeMessage({
      subject: 'Re: budget Q1',
      references: ['<unrelated-1@x.com>', '<bot-outbound-042@agentmail.to>'],
      // No in_reply_to set on purpose — some MTAs only fill References.
    });
    const result = classifyInboundMail(msg, {
      knownOutboundMessageIds: new Set(['bot-outbound-042@agentmail.to']),
    });
    expect(result.kind).toBe('continuation');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.signals).toContain('rfc822_references');
    expect(result.signals).not.toContain('rfc822_in_reply_to');
  });

  // ---- Branch 4: Re: prefix only (no DB match) ----
  it('Re: prefix only without DB match → low-confidence continuation', () => {
    const msg = makeMessage({
      subject: 'Re: meeting tomorrow',
      // Counterparty replied to unrelated mail and kept the Re: — we
      // mark continuation so dispatch attempts the session lookup, but
      // confidence stays low so the operator can sanity-check.
    });
    const result = classifyInboundMail(msg);
    expect(result.kind).toBe('continuation');
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.signals).toContain('re_prefix');
    expect(result.signals).not.toContain('rfc822_in_reply_to');
  });

  // ---- Branch 5: runaway Re: chain → demote to cold ----
  it('runaway Re: chain (>= RE_CHAIN_MAX) demotes a confirmed thread to cold', () => {
    // Stack the Re: prefix 6 deep (RE_CHAIN_MAX = 5 → demote).
    const subject = 'Re: '.repeat(RE_CHAIN_MAX + 1) + 'spam thread';
    const msg = makeMessage({
      subject,
      in_reply_to: '<bot-outbound-001@agentmail.to>',
    });
    const result = classifyInboundMail(msg, {
      knownOutboundMessageIds: new Set(['bot-outbound-001@agentmail.to']),
    });
    expect(result.kind).toBe('cold');
    expect(result.demotedReason).toBe('re_chain_exceeded');
    expect(result.signals).toContain('re_chain_exceeded');
    expect(result.signals).toContain('rfc822_in_reply_to'); // signal still recorded
  });

  // ---- Edge cases (regression coverage) ----

  it('SignalB alone (threadHasSelf=true) → continuation', () => {
    const msg = makeMessage({
      subject: 'Hello',
      // No Re:, no In-Reply-To — relies entirely on SignalB.
    });
    const result = classifyInboundMail(msg, { threadHasSelf: true });
    expect(result.kind).toBe('continuation');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.signals).toContain('thread_self');
  });

  it('legacy opaque id match alone → continuation (lower confidence)', () => {
    const msg = makeMessage({ subject: 'Hello' });
    const result = classifyInboundMail(msg, { legacyOpaqueIdMatch: true });
    expect(result.kind).toBe('continuation');
    expect(result.signals).toContain('legacy_opaque');
    // Tertiary signal: medium confidence, below strong signals.
    expect(result.confidence).toBeLessThan(0.95);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('depth at exactly RE_CHAIN_MAX-1 does NOT demote', () => {
    const subject = 'Re: '.repeat(RE_CHAIN_MAX - 1) + 'still ok';
    const msg = makeMessage({
      subject,
      in_reply_to: '<bot-outbound-001@agentmail.to>',
    });
    const result = classifyInboundMail(msg, {
      knownOutboundMessageIds: new Set(['bot-outbound-001@agentmail.to']),
    });
    expect(result.kind).toBe('continuation');
    expect(result.demotedReason).toBeUndefined();
  });

  it('depth at exactly RE_CHAIN_MAX demotes (boundary)', () => {
    const subject = 'Re: '.repeat(RE_CHAIN_MAX) + 'boundary';
    const msg = makeMessage({
      subject,
      in_reply_to: '<bot-outbound-001@agentmail.to>',
    });
    const result = classifyInboundMail(msg, {
      knownOutboundMessageIds: new Set(['bot-outbound-001@agentmail.to']),
    });
    expect(result.kind).toBe('cold');
    expect(result.demotedReason).toBe('re_chain_exceeded');
  });

  it('handles undefined subject + missing thread refs without crashing', () => {
    const msg = makeMessage({ subject: undefined, in_reply_to: undefined, references: undefined });
    const result = classifyInboundMail(msg);
    expect(result.kind).toBe('cold');
    expect(result.signals).toContain('no_thread_refs');
  });

  it('In-Reply-To normalization: angle brackets + case-insensitive match', () => {
    // knownOutboundMessageIds is normalized lowercase per the helper
    // contract. The classifier must normalize the inbound In-Reply-To
    // (strip <…>, lowercase) before set lookup.
    const msg = makeMessage({
      subject: 'Re: weekly sync',
      in_reply_to: '<Bot-Outbound-001@AgentMail.to>', // mixed case + brackets
    });
    const result = classifyInboundMail(msg, {
      knownOutboundMessageIds: new Set(['bot-outbound-001@agentmail.to']),
    });
    expect(result.kind).toBe('continuation');
    expect(result.signals).toContain('rfc822_in_reply_to');
  });

  it('unrelated In-Reply-To id falls back to subject-only branch', () => {
    const msg = makeMessage({
      subject: 'Re: unrelated thread',
      in_reply_to: '<somebody-elses-id@example.org>',
    });
    const result = classifyInboundMail(msg, {
      knownOutboundMessageIds: new Set(['bot-outbound-001@agentmail.to']),
    });
    // The In-Reply-To exists but doesn't match the known set → falls
    // through to the Re: branch (low-confidence continuation).
    expect(result.kind).toBe('continuation');
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.signals).not.toContain('rfc822_in_reply_to');
    expect(result.signals).toContain('re_prefix');
  });
});

describe('shouldAutoReply', () => {
  it('returns true for confirmed continuation', () => {
    const msg = makeMessage({
      subject: 'Re: hello',
      in_reply_to: '<bot-outbound-001@agentmail.to>',
    });
    expect(
      shouldAutoReply(msg, {
        knownOutboundMessageIds: new Set(['bot-outbound-001@agentmail.to']),
      }),
    ).toBe(true);
  });

  it('returns false for cold inbound', () => {
    const msg = makeMessage({ subject: 'Hello' });
    expect(shouldAutoReply(msg)).toBe(false);
  });

  it('returns false for runaway Re: chain even with DB match', () => {
    const subject = 'Re: '.repeat(RE_CHAIN_MAX + 2) + 'spam';
    const msg = makeMessage({
      subject,
      in_reply_to: '<bot-outbound-001@agentmail.to>',
    });
    expect(
      shouldAutoReply(msg, {
        knownOutboundMessageIds: new Set(['bot-outbound-001@agentmail.to']),
      }),
    ).toBe(false);
  });
});
