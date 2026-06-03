import { describe, expect, it } from 'vitest';

import type { ChatQueueMessage } from '../src/webhooks/google-chat';
import {
  buildHeartbeatChatEvent,
  enqueueHeartbeatTask,
  HEARTBEAT_CRON,
  isActiveHour,
  isHeartbeatEnabled,
  runHeartbeatTick,
  type HeartbeatTaskRow,
} from '../src/scheduled/heartbeat';
import { makeFakeQueue, makeMakotoDb } from './makoto-helpers';
import { makeKv } from './helpers';

function envWithQueue(overrides: Partial<Env> = {}): Env & {
  MAKOTO_CHAT_QUEUE: Queue<ChatQueueMessage> & { _sent: ChatQueueMessage[] };
} {
  const queue = makeFakeQueue<ChatQueueMessage>();
  return {
    DB: makeMakotoDb(),
    MAKOTO_KV: makeKv(),
    MAKOTO_CHAT_QUEUE: queue,
    ...overrides,
  } as unknown as Env & {
    MAKOTO_CHAT_QUEUE: Queue<ChatQueueMessage> & { _sent: ChatQueueMessage[] };
  };
}

function addTask(env: Env, patch: Partial<HeartbeatTaskRow> = {}): HeartbeatTaskRow {
  const row: HeartbeatTaskRow = {
    task_id: 'news_check_seto',
    owner_user_id: 'k.seto@makotoprime.com',
    target_space_name: 'spaces/DM_SET0',
    kind: 'patrol',
    prompt: 'ニュースを確認する',
    interval_min: 30,
    active_hours: null,
    target_scope: 'dm',
    enabled: 1,
    last_run_at: null,
    ...patch,
  };
  (env.DB as unknown as { _tables: { heartbeat_tasks: Map<string, unknown> } })._tables
    .heartbeat_tasks.set(row.task_id, { ...row, created_at: 1, updated_at: 1 });
  return row;
}

describe('heartbeat scheduled enqueue', () => {
  it('uses a 30 minute Cloudflare cron expression', () => {
    expect(HEARTBEAT_CRON).toBe('*/30 * * * *');
  });

  it('defaults disabled and accepts explicit opt-in values', () => {
    expect(isHeartbeatEnabled({} as Env)).toBe(false);
    expect(isHeartbeatEnabled({ HEARTBEAT_ENABLED: 'on' } as Env)).toBe(true);
    expect(isHeartbeatEnabled({ HEARTBEAT_ENABLED: '1' } as Env)).toBe(true);
  });

  it('does not query or enqueue when HEARTBEAT_ENABLED is off', async () => {
    const env = envWithQueue();
    addTask(env);
    const result = await runHeartbeatTick(env, Date.parse('2026-06-02T23:30:00.000Z'));
    expect(result).toEqual({ kind: 'disabled', checked: 0, enqueued: 0, skipped: 0 });
    expect(env.MAKOTO_CHAT_QUEUE._sent).toHaveLength(0);
  });

  it('skips when no task is due', async () => {
    const env = envWithQueue({ HEARTBEAT_ENABLED: '1' });
    addTask(env, {
      last_run_at: Date.parse('2026-06-02T23:15:00.000Z'),
      interval_min: 30,
    });
    const result = await runHeartbeatTick(env, Date.parse('2026-06-02T23:30:00.000Z'));
    expect(result).toEqual({ kind: 'no_due', checked: 0, enqueued: 0, skipped: 0 });
    expect(env.MAKOTO_CHAT_QUEUE._sent).toHaveLength(0);
  });

  it('claims, enqueues, and advances last_run_at for due tasks', async () => {
    const env = envWithQueue({ HEARTBEAT_ENABLED: '1' });
    addTask(env, { interval_min: 30, last_run_at: Date.parse('2026-06-02T22:30:00.000Z') });
    const nowMs = Date.parse('2026-06-02T23:30:00.000Z');

    const result = await runHeartbeatTick(env, nowMs);
    expect(result).toEqual({ kind: 'completed', checked: 1, enqueued: 1, skipped: 0 });
    expect(env.MAKOTO_CHAT_QUEUE._sent).toHaveLength(1);
    const sent = env.MAKOTO_CHAT_QUEUE._sent[0]!;
    expect(sent.eventKey).toContain('scheduled:heartbeat_tick:news_check_seto:');
    expect(sent.payload.space?.name).toBe('spaces/DM_SET0');
    expect(sent.payload.message?.sender.email).toBe('k.seto@makotoprime.com');
    expect(sent.payload.message?.text).toContain('===HEARTBEAT_NOTHING===');

    const row = (env.DB as unknown as { _tables: { heartbeat_tasks: Map<string, { last_run_at: number }> } })
      ._tables.heartbeat_tasks.get('news_check_seto')!;
    expect(row.last_run_at).toBe(nowMs);
  });

  it('filters active_hours in JST before enqueue', async () => {
    const env = envWithQueue({ HEARTBEAT_ENABLED: '1' });
    addTask(env, { active_hours: '8-20' });
    const result = await runHeartbeatTick(env, Date.parse('2026-06-02T22:30:00.000Z'));
    expect(result).toEqual({ kind: 'no_due', checked: 1, enqueued: 0, skipped: 1 });
    expect(env.MAKOTO_CHAT_QUEUE._sent).toHaveLength(0);
  });

  it('does not enqueue duplicate event keys while the lease is alive', async () => {
    const env = envWithQueue({ HEARTBEAT_ENABLED: '1' });
    const task = addTask(env);
    const nowMs = Date.parse('2026-06-02T23:30:00.000Z');
    await enqueueHeartbeatTask(env, task, nowMs);
    const second = await enqueueHeartbeatTask(env, task, nowMs);
    expect(second.kind).toBe('lease_alive');
    expect(env.MAKOTO_CHAT_QUEUE._sent).toHaveLength(1);
  });

  it('requires dm target space for v1', async () => {
    const env = envWithQueue({ HEARTBEAT_ENABLED: '1' });
    const noSpace = addTask(env, { target_space_name: null });
    const shared = addTask(env, { task_id: 'shared-task', target_scope: 'shared' });
    expect((await enqueueHeartbeatTask(env, noSpace)).kind).toBe('missing_target_space');
    expect((await enqueueHeartbeatTask(env, shared)).kind).toBe('unsupported_target');
    expect(env.MAKOTO_CHAT_QUEUE._sent).toHaveLength(0);
  });
});

describe('heartbeat helpers', () => {
  it('interprets active_hours as JST inclusive start / exclusive end', () => {
    expect(isActiveHour('8-20', Date.parse('2026-06-02T23:00:00.000Z'))).toBe(true);
    expect(isActiveHour('8-20', Date.parse('2026-06-02T22:00:00.000Z'))).toBe(false);
    expect(isActiveHour('22-5', Date.parse('2026-06-02T16:00:00.000Z'))).toBe(true);
  });

  it('builds a synthetic Google Chat DM event', () => {
    const event = buildHeartbeatChatEvent(
      {
        task_id: 'news_check_seto',
        owner_user_id: 'k.seto@makotoprime.com',
        target_space_name: 'spaces/DM_SET0',
        prompt: 'ニュースを確認する',
      },
      Date.parse('2026-06-02T23:30:00.000Z'),
      'scheduled:heartbeat_tick:news_check_seto:123',
    );
    expect(event.space?.type).toBe('DM');
    expect(event.message?.text).toContain('今日は 2026-06-03 JST です。');
    expect(event.message?.text).toContain('ニュースを確認する');
  });
});
