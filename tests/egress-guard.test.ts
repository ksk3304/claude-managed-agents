/**
 * Unit tests for `src/lib/egress-guard.ts` (層 8 hard-allowlist).
 */

import { describe, it, expect } from 'vitest';
import {
  assertBridgeEgressAllowed,
  BridgeEgressDeniedError,
  MAKOTO_BRIDGE_EGRESS_ALLOWLIST,
} from '../src/lib/egress-guard';

describe('assertBridgeEgressAllowed', () => {
  it('allows every host in MAKOTO_BRIDGE_EGRESS_ALLOWLIST', () => {
    for (const host of MAKOTO_BRIDGE_EGRESS_ALLOWLIST) {
      expect(() =>
        assertBridgeEgressAllowed(`https://${host}/some/path?q=1`, 'test'),
      ).not.toThrow();
    }
  });

  it('throws BridgeEgressDeniedError on un-allowlisted host', () => {
    expect(() => assertBridgeEgressAllowed('https://evil.example.com/x', 'test')).toThrow(
      BridgeEgressDeniedError,
    );
  });

  it('treats subdomains as distinct (no wildcard match)', () => {
    // www.googleapis.com is allowed; foo.googleapis.com is not.
    expect(() =>
      assertBridgeEgressAllowed('https://foo.googleapis.com/x', 'test'),
    ).toThrow(BridgeEgressDeniedError);
  });

  it('lowercases the hostname before comparison', () => {
    expect(() =>
      assertBridgeEgressAllowed('https://API.AGENTMAIL.TO/x', 'test'),
    ).not.toThrow();
  });

  it('throws on an unparseable URL with a caller hint', () => {
    try {
      assertBridgeEgressAllowed('not a url', 'caller-X');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeEgressDeniedError);
      expect((err as BridgeEgressDeniedError).message).toContain('caller-X');
    }
  });

  it('records the caller hint in the error message', () => {
    try {
      assertBridgeEgressAllowed('https://evil.example.com', 'tool-X:fetch');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).toContain('tool-X:fetch');
      expect((err as Error).message).toContain('evil.example.com');
    }
  });
});
