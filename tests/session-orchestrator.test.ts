import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  orchestrateChatTurn,
  resolveReactiveSessionWatchdogSec,
} from '../src/lib/session-orchestrator';
import { makeKv } from './helpers';

function makeClient(calls: string[]): Anthropic {
  async function* stream(): AsyncIterable<Record<string, unknown>> {
    yield { type: 'agent.message.text_delta', text: 'ok' };
    yield { type: 'session.status_idle', stop_reason: 'end_turn' };
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
          return { id: 'sesn_new', args };
        },
        events: {
          async send() {
            calls.push('events.send');
          },
          async stream() {
            calls.push('events.stream');
            return stream();
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
});
