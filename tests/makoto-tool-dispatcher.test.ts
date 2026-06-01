/**
 * Unit tests for `src/dispatch/makoto-tool-dispatcher.ts` — wraps the
 * layer-6 tool functions with per-user OAuth resolution + error
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
  it('covers all registered tools', () => {
    expect(MAKOTO_TOOL_NAMES.length).toBe(17);
  });
  it('isMakotoToolName narrows correctly', () => {
    expect(isMakotoToolName('drive_search')).toBe(true);
    expect(isMakotoToolName('drive_update_file_metadata')).toBe(true);
    expect(isMakotoToolName('drive_update_file_content')).toBe(true);
    expect(isMakotoToolName('drive_delete')).toBe(false);
    expect(isMakotoToolName('calendar_delete_event')).toBe(false);
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

  it('drive_update_file_content verifies by reading back content', async () => {
    const kv = makeKv();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'rt');
    let metadataReads = 0;
    const fetchImpl = makeFetchMock(async (url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return jsonResponse(200, { access_token: 'AT', expires_in: 3600 });
      }
      if (url.includes('/upload/drive/v3/files/abc')) {
        expect(init.method).toBe('PATCH');
        expect(String(init.body)).toBe('CRU-Uのテスト');
        return jsonResponse(200, { id: 'abc', name: 'doc.txt', mimeType: 'text/plain' });
      }
      if (url.includes('/drive/v3/files/abc') && url.includes('alt=media')) {
        expect(init.method).toBe('GET');
        return new Response('CRU-Uのテスト', { status: 200 });
      }
      if (url.includes('/drive/v3/files/abc')) {
        metadataReads++;
        expect(init.method).toBe('GET');
        return jsonResponse(200, { id: 'abc', name: 'doc.txt', mimeType: 'text/plain' });
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
    const r = await dispatchMakotoTool(
      'drive_update_file_content',
      { file_id: 'abc', content: 'CRU-Uのテスト' },
      { env, userSlug: 'alice', boundMessageId: 'm-1', fetchImpl },
    );
    expect(r.ok).toBe(true);
    expect(metadataReads).toBe(2);
    const payload = r.payload as { verified: boolean; readback: { content: string } };
    expect(payload.verified).toBe(true);
    expect(payload.readback.content).toBe('CRU-Uのテスト');
  });

  it('calendar_create_event resolves OAuth then proxies', async () => {
    const kv = makeKv();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'rt');
    const fetchImpl = makeFetchMock(async (url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return jsonResponse(200, { access_token: 'AT', expires_in: 3600 });
      }
      if (init.method === 'POST') {
        expect(url).toContain('/calendar/v3/calendars/primary/events?sendUpdates=all');
        return jsonResponse(200, {
          id: 'evt-1',
          summary: '予定',
          start: { dateTime: '2026-06-02T10:00:00+09:00' },
          end: { dateTime: '2026-06-02T11:00:00+09:00' },
        });
      }
      expect(init.method).toBe('GET');
      expect(url).toContain('/calendar/v3/calendars/primary/events/evt-1');
      return jsonResponse(200, {
        id: 'evt-1',
        summary: '予定',
        start: { dateTime: '2026-06-02T10:00:00+09:00' },
        end: { dateTime: '2026-06-02T11:00:00+09:00' },
      });
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
      'calendar_create_event',
      {
        summary: '予定',
        start: { dateTime: '2026-06-02T10:00:00+09:00' },
        end: { dateTime: '2026-06-02T11:00:00+09:00' },
      },
      { env, userSlug: 'alice', boundMessageId: 'm-1', fetchImpl },
    );
    expect(r.ok).toBe(true);
    const payload = r.payload as { verified: boolean; readback: { id: string } };
    expect(payload.verified).toBe(true);
    expect(payload.readback.id).toBe('evt-1');
  });

  it('calendar_update_event fails closed when readback differs', async () => {
    const kv = makeKv();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'rt');
    const fetchImpl = makeFetchMock(async (url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return jsonResponse(200, { access_token: 'AT', expires_in: 3600 });
      }
      if (init.method === 'PUT') {
        return jsonResponse(200, {
          id: 'evt-1',
          summary: 'テスト2',
          start: { dateTime: '2026-06-01T22:00:00+09:00' },
          end: { dateTime: '2026-06-01T23:00:00+09:00' },
        });
      }
      expect(url).toContain('/calendar/v3/calendars/primary/events/evt-1');
      return jsonResponse(200, {
        id: 'evt-1',
        summary: 'テスト2',
        start: { dateTime: '2026-06-01T23:30:00+09:00' },
        end: { dateTime: '2026-06-02T00:00:00+09:00' },
      });
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
      'calendar_update_event',
      {
        event_id: 'evt-1',
        summary: 'テスト2',
        start: { dateTime: '2026-06-01T22:00:00+09:00' },
        end: { dateTime: '2026-06-01T23:00:00+09:00' },
      },
      { env, userSlug: 'alice', boundMessageId: 'm-1', fetchImpl },
    );
    expect(r.ok).toBe(false);
    const payload = r.payload as { error: string; verification: { mismatches: string[] } };
    expect(payload.error).toBe('verification_failed');
    expect(payload.verification.mismatches).toContain('start');
    expect(payload.verification.mismatches).toContain('end');
  });

  it('docs_create resolves OAuth then proxies', async () => {
    const kv = makeKv();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'rt');
    const fetchImpl = makeFetchMock(async (url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return jsonResponse(200, { access_token: 'AT', expires_in: 3600 });
      }
      if (init.method === 'POST') {
        expect(url).toContain('/documents');
        return jsonResponse(200, { documentId: 'doc-1', title: 'Doc' });
      }
      expect(init.method).toBe('GET');
      expect(url).toContain('/documents/doc-1');
      return jsonResponse(200, {
        documentId: 'doc-1',
        title: 'Doc',
        body: { content: [] },
      });
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
      'docs_create',
      { title: 'Doc' },
      { env, userSlug: 'alice', boundMessageId: 'm-1', fetchImpl },
    );
    expect(r.ok).toBe(true);
    const payload = r.payload as { verified: boolean; result: { document_url: string } };
    expect(payload.verified).toBe(true);
    expect(payload.result.document_url).toContain('/document/d/doc-1');
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
