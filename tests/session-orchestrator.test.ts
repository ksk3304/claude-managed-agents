import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  buildChatCapabilitySessionKey,
  chatThreadSessionKey,
  orchestrateChatTurn,
  resolveReactiveSessionWatchdogSec,
} from '../src/lib/session-orchestrator';
import { makeKv } from './helpers';

interface MakeClientOpts {
  streamEvents?: Array<Record<string, unknown>>;
  sessionIds?: string[];
  sendErrors?: Error[];
  sendCapturePayloads?: unknown[];
  memoryListItems?: Record<string, Array<Record<string, unknown>>>;
}

function asyncPage(items: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

function makeClient(
  calls: string[],
  opts: MakeClientOpts | Array<Record<string, unknown>> = {},
): Anthropic {
  const options: MakeClientOpts = Array.isArray(opts) ? { streamEvents: opts } : opts;
  let createCallCount = 0;
  let sendCallCount = 0;

  async function* stream(): AsyncIterable<Record<string, unknown>> {
    const events = options.streamEvents ?? [
      { type: 'agent.message.text_delta', text: 'ok' },
      { type: 'session.status_idle', stop_reason: 'end_turn' },
    ];
    for (const event of events) yield event;
  }

  return {
    beta: {
      agents: {
        async create() {
          calls.push('agents.create');
          throw new Error('agents.create must not be called');
        },
      },
      environments: {
        async create() {
          calls.push('environments.create');
          throw new Error('environments.create must not be called');
        },
      },
      sessions: {
        async create(args: unknown) {
          calls.push('sessions.create');
          const id = options.sessionIds?.[createCallCount] ?? 'sesn_new';
          createCallCount += 1;
          return { id, args };
        },
        events: {
          async send(_sessionId: string, payload: unknown) {
            calls.push('events.send');
            const error = options.sendErrors?.[sendCallCount];
            sendCallCount += 1;
            if (error) throw error;
            options.sendCapturePayloads?.push(payload);
          },
          async stream() {
            calls.push('events.stream');
            return stream();
          },
        },
      },
      memoryStores: {
        memories: {
          async list(memoryStoreId: string) {
            calls.push('memories.list');
            return asyncPage(options.memoryListItems?.[memoryStoreId] ?? []);
          },
        },
      },
    },
  } as unknown as Anthropic;
}

describe('resolveReactiveSessionWatchdogSec', () => {
  it('returns undefined when unset so the session default remains 600s', () => {
    expect(resolveReactiveSessionWatchdogSec(undefined)).toBeUndefined();
    expect(resolveReactiveSessionWatchdogSec('')).toBeUndefined();
    expect(resolveReactiveSessionWatchdogSec('   ')).toBeUndefined();
  });

  it('accepts 0..600 integer seconds for incident tests', () => {
    expect(resolveReactiveSessionWatchdogSec('0')).toBe(0);
    expect(resolveReactiveSessionWatchdogSec('1')).toBe(1);
    expect(resolveReactiveSessionWatchdogSec('600')).toBe(600);
  });

  it('rejects invalid values and falls back to default behavior', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveReactiveSessionWatchdogSec('-1')).toBeUndefined();
      expect(resolveReactiveSessionWatchdogSec('601')).toBeUndefined();
      expect(resolveReactiveSessionWatchdogSec('1.5')).toBeUndefined();
      expect(resolveReactiveSessionWatchdogSec('abc')).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(4);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('orchestrateChatTurn', () => {
  it('ignores attachedSkills and creates a session on the mapped employee agent/environment', async () => {
    const calls: string[] = [];
    const kv = makeKv();
    const createArgs: unknown[] = [];
    const client = makeClient(calls);
    const originalCreate = client.beta.sessions.create;
    client.beta.sessions.create = (async (args: unknown) => {
      createArgs.push(args);
      return originalCreate.call(client.beta.sessions, args as never);
    }) as typeof client.beta.sessions.create;

    const result = await orchestrateChatTurn({
      env: {
        ENVIRONMENT_ID: 'env_employee',
        MAKOTO_KV: kv,
      } as Env,
      client,
      senderEmail: 'alice@example.com',
      spaceName: 'spaces/AAA',
      spaceType: 'DM',
      threadName: 'spaces/AAA/threads/T1',
      bodyText: 'メールして',
      userMapping: {
        user_slug: 'alice',
        agent_id: 'agent_employee',
        memory_attachments: [],
      },
      personaSpec: 'persona',
      toolsSpec: '## メール送信能力\nmail',
      attachedSkills: [{ type: 'custom', skill_id: 'skill_mail' }],
      toolDispatcher: async () => ({ ok: true, payload: null }),
    });

    expect(result.sessionId).toBe('sesn_new');
    expect(calls).toEqual(['sessions.create', 'events.send', 'events.stream']);
    expect(createArgs[0]).toMatchObject({
      agent: 'agent_employee',
      environment_id: 'env_employee',
    });
  });

  it('routes Memory Store resources before sessions.create', async () => {
    const calls: string[] = [];
    const kv = makeKv();
    const createArgs: unknown[] = [];
    const client = makeClient(calls);
    const originalCreate = client.beta.sessions.create;
    client.beta.sessions.create = (async (args: unknown) => {
      createArgs.push(args);
      return originalCreate.call(client.beta.sessions, args as never);
    }) as typeof client.beta.sessions.create;

    await orchestrateChatTurn({
      env: {
        ENVIRONMENT_ID: 'env_employee',
        MAKOTO_KV: kv,
      } as Env,
      client,
      senderEmail: 'alice@example.com',
      spaceName: 'spaces/AAA',
      spaceType: 'DM',
      threadName: 'spaces/AAA/threads/T2',
      bodyText: '昨日の議事録を踏まえて整理して',
      userMapping: {
        user_slug: 'alice',
        agent_id: 'agent_employee',
        memory_attachments: [
          { memory_store_id: 'mem_extra_1', access: 'read_only', store_name: 'random_1' },
          { memory_store_id: 'mem_wiki', access: 'read_write', store_name: 'corporate_wiki_memory' },
          { memory_store_id: 'mem_company', access: 'read_only', store_name: 'company_core_memory' },
          { memory_store_id: 'mem_makoto', access: 'read_write', store_name: 'makoto_kun_memory' },
          { memory_store_id: 'mem_dm_report', access: 'read_write', store_name: 'daily_report_dm_store' },
          { memory_store_id: 'mem_dm_log', access: 'read_write', store_name: 'session_log_dm_store' },
          { memory_store_id: 'mem_shared_report', access: 'read_write', store_name: 'daily_report_shared_store' },
          { memory_store_id: 'mem_shared_log', access: 'read_write', store_name: 'session_log_shared_store' },
          { memory_store_id: 'mem_extra_2', access: 'read_only', store_name: 'random_2' },
          { memory_store_id: 'mem_extra_3', access: 'read_only', store_name: 'random_3' },
        ],
      },
      personaSpec: 'persona',
      toolsSpec: '## メール送信能力\nmail',
      toolDispatcher: async () => ({ ok: true, payload: null }),
    });

    const resources = (createArgs[0] as { resources: Array<{ memory_store_id: string }> })
      .resources;
    expect(resources.map((r) => r.memory_store_id)).toEqual([
      'mem_wiki',
      'mem_company',
      'mem_makoto',
      'mem_dm_report',
      'mem_dm_log',
      'mem_shared_report',
      'mem_shared_log',
      'mem_extra_1',
    ]);
  });

  it('injects memory bootstrap on new session when memory wrapper flag is on', async () => {
    const calls: string[] = [];
    const sendPayloads: unknown[] = [];
    const kv = makeKv();
    const client = makeClient(calls, {
      sendCapturePayloads: sendPayloads,
      memoryListItems: {
        mem_company: [{ type: 'memory', id: 'mem_1', path: '/company.md' }],
      },
    });

    await orchestrateChatTurn({
      env: {
        ENVIRONMENT_ID: 'env_employee',
        MAKOTO_KV: kv,
        CMA_MEMORY_WRAPPER_POC_ENABLED: '1',
      } as Env,
      client,
      senderEmail: 'alice@example.com',
      spaceName: 'spaces/AAA',
      spaceType: 'DM',
      threadName: 'spaces/AAA/threads/T2',
      bodyText: '直近の状況を教えて',
      userMapping: {
        user_slug: 'alice',
        agent_id: 'agent_employee',
        memory_attachments: [
          {
            memory_store_id: 'mem_company',
            access: 'read_only',
            store_name: 'company_core',
          },
        ],
      },
      personaSpec: 'persona',
      toolsSpec: 'tools',
      toolDispatcher: async () => ({ ok: true, payload: null }),
    });

    const firstPayload = sendPayloads[0] as { events: Array<{ content: Array<{ text?: string }> }> };
    const text = firstPayload.events[0]!.content[0]!.text ?? '';
    expect(text).toContain('<memory_bootstrap>');
    expect(text).toContain('memory_manifest');
    expect(text).toContain('/mnt/memory is unavailable');
    expect(await kv.get('memory_wrapper_binding:sesn_new')).not.toBeNull();
    expect(calls).toContain('memories.list');
  });

  it('exposes the active session id before custom tool dispatch', async () => {
    const calls: string[] = [];
    const kv = makeKv();
    const client = makeClient(calls, [
      {
        type: 'agent.custom_tool_use',
        id: 'tu_stage',
        name: 'drive_stage_file',
        input: { file_id: 'file123' },
      },
      {
        type: 'session.status_idle',
        stop_reason: { type: 'requires_action', event_ids: ['tu_stage'] },
      },
      { type: 'agent.message', content: [{ type: 'text', text: 'done' }] },
      { type: 'session.status_idle', stop_reason: 'end_turn' },
    ]);
    let resolvedSessionId = '';
    let dispatcherSawSessionId = '';

    const result = await orchestrateChatTurn({
      env: {
        ENVIRONMENT_ID: 'env_employee',
        MAKOTO_KV: kv,
      } as Env,
      client,
      senderEmail: 'alice@example.com',
      spaceName: 'spaces/AAA',
      spaceType: 'DM',
      threadName: 'spaces/AAA/threads/T3',
      bodyText: 'テンプレを更新して',
      userMapping: {
        user_slug: 'alice',
        agent_id: 'agent_employee',
        memory_attachments: [],
      },
      personaSpec: 'persona',
      toolsSpec: '## Drive\nstage',
      onSessionIdResolved: (sessionId) => {
        resolvedSessionId = sessionId;
      },
      toolDispatcher: async () => {
        dispatcherSawSessionId = resolvedSessionId;
        return { ok: true, payload: { mount_path: '/mnt/session/uploads/template.xlsx' } };
      },
    });

    expect(result.sessionId).toBe('sesn_new');
    expect(dispatcherSawSessionId).toBe('sesn_new');
    expect(calls).toEqual(['sessions.create', 'events.send', 'events.stream', 'events.send']);
  });

  it('replaces an existing thread session stuck waiting on custom tool responses', async () => {
    const calls: string[] = [];
    const kv = makeKv();
    const env = {
      ENVIRONMENT_ID: 'env_employee',
      MAKOTO_KV: kv,
    } as Env;
    const senderEmail = 'alice@example.com';
    const spaceName = 'spaces/AAA';
    const threadName = 'spaces/AAA/threads/T4';
    const sessionKey = chatThreadSessionKey(
      senderEmail,
      spaceName,
      threadName,
      await buildChatCapabilitySessionKey(env),
    );
    expect(sessionKey).not.toBeNull();
    await kv.put(sessionKey!, 'sesn_poisoned');
    const client = makeClient(calls, {
      sessionIds: ['sesn_replacement'],
      sendErrors: [
        new Error(
          '400 Invalid user.message event: waiting on responses to events [sevt_custom_tool]',
        ),
      ],
    });
    const resolvedSessionIds: string[] = [];

    const result = await orchestrateChatTurn({
      env,
      client,
      senderEmail,
      spaceName,
      spaceType: 'DM',
      threadName,
      bodyText: 'テンプレを更新して',
      userMapping: {
        user_slug: 'alice',
        agent_id: 'agent_employee',
        memory_attachments: [],
      },
      personaSpec: 'persona',
      toolsSpec: '## Drive\nstage',
      onSessionIdResolved: (sessionId) => {
        resolvedSessionIds.push(sessionId);
      },
      toolDispatcher: async () => ({ ok: true, payload: null }),
    });

    expect(result.sessionId).toBe('sesn_replacement');
    expect(result.isNewSession).toBe(true);
    expect(await kv.get(sessionKey!)).toBe('sesn_replacement');
    expect(resolvedSessionIds).toEqual(['sesn_poisoned', 'sesn_replacement']);
    expect(calls).toEqual(['events.send', 'sessions.create', 'events.send', 'events.stream']);
  });
});
