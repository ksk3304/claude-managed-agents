/**
 * Unit tests for `src/dispatch/makoto-tool-dispatcher.ts` — wraps the
 * custom tool functions with per-user OAuth where needed + error
 * envelope encoding.
 */

import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  dispatchMakotoTool,
  isMakotoToolName,
  MAKOTO_TOOL_NAMES,
} from '../src/dispatch/makoto-tool-dispatcher';
import { MAKOTO_AGENT_TOOLS } from '../src/lib/makoto-capability-registry';
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
    expect(MAKOTO_TOOL_NAMES.length).toBe(14);
    expect(MAKOTO_TOOL_NAMES).toContain('chat_list_space_members');
    expect(MAKOTO_TOOL_NAMES).toContain('drive_stage_file');
    expect(MAKOTO_TOOL_NAMES).toContain('agentmail_read');
    expect(MAKOTO_TOOL_NAMES).toContain('makoto_introspect');
  });
  it('isMakotoToolName narrows correctly', () => {
    expect(isMakotoToolName('drive_search')).toBe(true);
    expect(isMakotoToolName('chat_list_space_members')).toBe(true);
    expect(isMakotoToolName('agentmail_read')).toBe(true);
    expect(isMakotoToolName('makoto_introspect')).toBe(true);
    expect(isMakotoToolName('drive_bogus')).toBe(false);
  });
  it('agent create tool schema stays aligned with dispatcher names', () => {
    const customToolNames = MAKOTO_AGENT_TOOLS
      .filter((tool) => tool.type === 'custom')
      .map((tool) => tool.name);
    expect(customToolNames.sort()).toEqual([...MAKOTO_TOOL_NAMES].sort());
  });
  it('chat_list_space_members is exposed as an optional-input custom tool', () => {
    const tool = MAKOTO_AGENT_TOOLS.find(
      (candidate) => candidate.type === 'custom' && candidate.name === 'chat_list_space_members',
    ) as Record<string, unknown> | undefined;
    expect(tool).toBeDefined();
    expect(tool!.description).toContain('displayName/user_id pairs');
    expect(tool!.input_schema).toMatchObject({
      type: 'object',
      properties: {
        space_name: { type: 'string' },
        limit: { type: 'integer' },
      },
      required: [],
    });
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
  it('makoto_introspect returns safe local manifest without OAuth', async () => {
    const env = {
      DB: makeMakotoDb(),
      MAKOTO_KV: makeKv(),
    } as unknown as Env;
    const r = await dispatchMakotoTool('makoto_introspect', { detail: 'all' }, {
      env,
      userSlug: 'alice',
      boundMessageId: 'm-1',
    });
    expect(r.ok).toBe(true);
    const payload = r.payload as Record<string, unknown>;
    expect(payload.product).toBe('汎用CMAエージェント Cloudflare版');
    expect(payload.schema_version).toBe(2);
    expect(payload.identity_model).toMatchObject({
      template: 'generic_agent',
    });
    expect(
      ((payload.identity_model as Record<string, unknown>).instance_variables as string[]),
    ).toContain('agent_number');
    expect(
      ((payload.identity_model as Record<string, unknown>).instance_variables as string[]),
    ).toContain('memory_store_company_name');
    expect((payload.custom_tools as Array<Record<string, unknown>>).length).toBe(
      MAKOTO_TOOL_NAMES.length,
    );
    expect(payload.mcp).toMatchObject({
      status: 'not_active_for_workspace',
      active_connectors: [],
    });
    expect(payload.memory_strategy).toMatchObject({
      plan: 'plan_b_memory_store_primary',
      max_session_memory_stores: 8,
    });
    expect(payload.memory_router).toMatchObject({
      strategy: 'plan_b_memory_store_router_v1',
      hard_limit: 8,
    });
    expect(payload.system_memory_logic_classification).toBeDefined();
    expect(payload.cannot_claim).toContain(
      'Do not claim active MCP connectors for Google Workspace; they are not the current implementation path.',
    );
    expect(payload.cannot_claim).toContain(
      'Do not claim the LLM automatically chooses which Memory Stores to mount; the Worker router chooses resources[].',
    );
    expect(payload).not.toHaveProperty('secrets');
  });

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

  it('chat_list_space_members bypasses Workspace OAuth and reports Chat API config', async () => {
    const env = {
      DB: makeMakotoDb(),
      MAKOTO_KV: makeKv(),
    } as unknown as Env;
    const r = await dispatchMakotoTool(
      'chat_list_space_members',
      {},
      {
        env,
        userSlug: 'alice',
        boundMessageId: 'm-1',
        currentSpaceName: 'spaces/AAA',
      },
    );
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error).toBe('chat_api_unavailable');
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

  it('drive_stage_file resolves OAuth then mounts the Drive binary into the session', async () => {
    const kv = makeKv();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'rt');
    let driveCalls = 0;
    const fetchImpl = makeFetchMock(async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return jsonResponse(200, { access_token: 'AT', expires_in: 3600 });
      }
      if (url.includes('googleapis.com/drive/v3/files/file123')) {
        driveCalls++;
        if (driveCalls === 1) {
          return jsonResponse(200, {
            id: 'file123',
            name: 'template.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: '2',
          });
        }
        return new Response(new Uint8Array([0x50, 0x4b]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const anthropic = {
      beta: {
        files: {
          upload: async () => ({
            id: 'file_ant',
            type: 'file',
            filename: 'template.xlsx',
            mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size_bytes: 2,
            created_at: '2026-06-02T00:00:00Z',
          }),
        },
        sessions: {
          resources: {
            add: async () => ({
              id: 'sesrsc_ant',
              type: 'file',
              file_id: 'file_ant',
              mount_path: '/mnt/session/uploads/template.xlsx',
              created_at: '2026-06-02T00:00:00Z',
              updated_at: '2026-06-02T00:00:00Z',
            }),
          },
        },
      },
    } as unknown as Anthropic;
    const env = {
      DB: makeMakotoDb(),
      MAKOTO_KV: kv,
      MAKOTO_OAUTH_LEASE: makeFakeOAuthLeaseNamespace(),
      OAUTH_VAULT_KEY: TEST_VAULT_KEY_B64,
      OAUTH_CLIENT_ID: 'cid',
      OAUTH_CLIENT_SECRET: 'csec',
    } as unknown as Env;

    const r = await dispatchMakotoTool(
      'drive_stage_file',
      { file_id: 'file123' },
      {
        env,
        userSlug: 'alice',
        boundMessageId: 'm-1',
        callerSessionId: 'sesn_123',
        anthropic,
        fetchImpl,
      },
    );

    expect(r.ok).toBe(true);
    expect((r.payload as Record<string, unknown>).mount_path).toBe(
      '/mnt/session/uploads/template.xlsx',
    );
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
