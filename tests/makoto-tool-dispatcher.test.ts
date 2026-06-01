/**
 * Unit tests for `src/dispatch/makoto-tool-dispatcher.ts` — wraps the
 * custom tool functions with per-user OAuth where needed + error
 * envelope encoding.
 */

import { describe, it, expect } from 'vitest';
import {
  dispatchMakotoTool,
  isMakotoToolName,
  MAKOTO_TOOL_NAMES,
} from '../src/dispatch/makoto-tool-dispatcher';
import { putRefreshToken } from '../src/lib/oauth-vault';
import {
  makeFetchMock,
  makeKv,
  makeMakotoDb,
  makeFakeOAuthLeaseNamespace,
  TEST_VAULT_KEY_B64,
} from './makoto-helpers';

function envWith(_fetchImpl: typeof fetch): Env {
  return {
    DB: makeMakotoDb(),
    MAKOTO_KV: makeKv(),
    MAKOTO_OAUTH_LEASE: makeFakeOAuthLeaseNamespace(),
    OAUTH_VAULT_KEY: TEST_VAULT_KEY_B64,
    OAUTH_CLIENT_ID: 'cid',
    OAUTH_CLIENT_SECRET: 'csec',
  } as unknown as Env;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MAKOTO_TOOL_NAMES + isMakotoToolName', () => {
  it('covers all tools', () => {
    expect(MAKOTO_TOOL_NAMES.length).toBe(11);
    expect(MAKOTO_TOOL_NAMES).toContain('agentmail_read');
  });
  it('isMakotoToolName narrows correctly', () => {
    expect(isMakotoToolName('drive_search')).toBe(true);
    expect(isMakotoToolName('agentmail_read')).toBe(true);
    expect(isMakotoToolName('drive_bogus')).toBe(false);
  });
});

describe('dispatchMakotoTool error envelopes', () => {
  it('unknown tool → ok:false / error:unknown_tool', async () => {
    const env = envWith(makeFetchMock(async () => new Response('', { status: 200 })));
    const r = await dispatchMakotoTool('bogus_tool', {}, {
      env,
      userSlug: 'alice',
      boundMessageId: 'm-1',
    });
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error).toBe('unknown_tool');
  });

  it('non-object input → ok:false / error:schema', async () => {
    const env = envWith(makeFetchMock(async () => new Response('', { status: 200 })));
    const r = await dispatchMakotoTool('drive_search', 'not-object', {
      env,
      userSlug: 'alice',
      boundMessageId: 'm-1',
    });
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error).toBe('schema');
  });

  it('missing OAUTH_VAULT_KEY → ok:false / oauth_misconfigured', async () => {
    const env = {
      DB: makeMakotoDb(),
      MAKOTO_KV: makeKv(),
    } as unknown as Env;
    const r = await dispatchMakotoTool('drive_search', { query: 'x' }, {
      env,
      userSlug: 'alice',
      boundMessageId: 'm-1',
    });
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error).toBe('oauth_misconfigured');
  });

  it('no refresh_token in vault → ok:false / oauth_missing', async () => {
    const env = envWith(makeFetchMock(async () => new Response('', { status: 200 })));
    const r = await dispatchMakotoTool('drive_search', { query: 'x' }, {
      env,
      userSlug: 'alice',
      boundMessageId: 'm-1',
    });
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error).toBe('oauth_missing');
  });
});

describe('dispatchMakotoTool happy paths', () => {
  it('agentmail_read bypasses Workspace OAuth and reads default inbox', async () => {
    const fetchImpl = makeFetchMock(async (url) => {
      expect(url).toContain('/v0/inboxes/inbox_main/messages?');
      return jsonResponse(200, {
        messages: [{ id: 'msg_1', from: 'alice@example.com', subject: 'アンケート' }],
      });
    });
    const env = {
      DB: makeMakotoDb(),
      MAKOTO_KV: makeKv(),
      AGENTMAIL_API_KEY: 'am-key',
      AGENTMAIL_DEFAULT_INBOX_ID: 'inbox_main',
    } as unknown as Env;
    const r = await dispatchMakotoTool(
      'agentmail_read',
      { action: 'search', subject_contains: 'アンケート' },
      { env, userSlug: 'alice', boundMessageId: 'm-1', fetchImpl },
    );
    expect(r.ok).toBe(true);
    expect((r.payload as { count: number }).count).toBe(1);
  });

  it('agentmail_read missing key returns AgentMail error without OAuth checks', async () => {
    const env = {
      DB: makeMakotoDb(),
      MAKOTO_KV: makeKv(),
      AGENTMAIL_DEFAULT_INBOX_ID: 'inbox_main',
    } as unknown as Env;
    const r = await dispatchMakotoTool(
      'agentmail_read',
      { action: 'get', message_id: 'msg_1' },
      { env, userSlug: 'alice', boundMessageId: 'm-1' },
    );
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error).toBe('agentmail_unavailable');
  });

  it('drive_search resolves OAuth then proxies to driveSearch', async () => {
    const kv = makeKv();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'rt');
    const fetchImpl = makeFetchMock(async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return jsonResponse(200, { access_token: 'AT', expires_in: 3600 });
      }
      if (url.includes('googleapis.com/drive/v3/files')) {
        return jsonResponse(200, { files: [{ id: 'f1', name: 'F' }], nextPageToken: null });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const env = {
      DB: makeMakotoDb(),
      MAKOTO_KV: kv,
      MAKOTO_OAUTH_LEASE: makeFakeOAuthLeaseNamespace(),
      OAUTH_VAULT_KEY: TEST_VAULT_KEY_B64,
      OAUTH_CLIENT_ID: 'cid',
      OAUTH_CLIENT_SECRET: 'csec',
    } as unknown as Env;
    const r = await dispatchMakotoTool('drive_search', { query: 'x' }, {
      env,
      userSlug: 'alice',
      boundMessageId: 'm-1',
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    expect((r.payload as { files: unknown[] }).files).toHaveLength(1);
  });

  it('calendar_list_events also resolves OAuth then proxies', async () => {
    const kv = makeKv();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'rt');
    const fetchImpl = makeFetchMock(async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return jsonResponse(200, { access_token: 'AT', expires_in: 3600 });
      }
      return jsonResponse(200, { items: [] });
    });
    const env = {
      DB: makeMakotoDb(),
      MAKOTO_KV: kv,
      MAKOTO_OAUTH_LEASE: makeFakeOAuthLeaseNamespace(),
      OAUTH_VAULT_KEY: TEST_VAULT_KEY_B64,
      OAUTH_CLIENT_ID: 'cid',
      OAUTH_CLIENT_SECRET: 'csec',
    } as unknown as Env;
    const r = await dispatchMakotoTool(
      'calendar_list_events',
      { time_min: '2026-01-01T00:00:00Z', time_max: '2026-01-02T00:00:00Z' },
      { env, userSlug: 'alice', boundMessageId: 'm-1', fetchImpl },
    );
    expect(r.ok).toBe(true);
    expect((r.payload as { count: number }).count).toBe(0);
  });

  it('schema error from tool → ok:false / error:schema with tool name', async () => {
    const kv = makeKv();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'rt');
    const fetchImpl = makeFetchMock(async () =>
      jsonResponse(200, { access_token: 'AT', expires_in: 3600 }),
    );
    const env = {
      DB: makeMakotoDb(),
      MAKOTO_KV: kv,
      MAKOTO_OAUTH_LEASE: makeFakeOAuthLeaseNamespace(),
      OAUTH_VAULT_KEY: TEST_VAULT_KEY_B64,
      OAUTH_CLIENT_ID: 'cid',
      OAUTH_CLIENT_SECRET: 'csec',
    } as unknown as Env;
    // drive_search with unknown key
    const r = await dispatchMakotoTool('drive_search', { bogus: 1 }, {
      env,
      userSlug: 'alice',
      boundMessageId: 'm-1',
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error).toBe('schema');
    expect((r.payload as Record<string, unknown>).tool).toBe('drive_search');
  });
});
