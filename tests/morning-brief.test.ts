import { describe, expect, it } from 'vitest';

import type { ChatQueueMessage } from '../src/webhooks/google-chat';
import {
  buildMorningBriefChatEvent,
  enqueueMorningBriefSeto,
  MORNING_BRIEF_SETO_CRON,
  MORNING_BRIEF_SETO_EMAIL,
  MORNING_BRIEF_SETO_SPACE,
} from '../src/scheduled/morning-brief';
import { makeFakeQueue, makeMakotoDb } from './makoto-helpers';
import { makeKv } from './helpers';

function envWithQueue(): Env & { MAKOTO_CHAT_QUEUE: Queue<ChatQueueMessage> & { _sent: ChatQueueMessage[] } } {
  const queue = makeFakeQueue<ChatQueueMessage>();
  return {
    DB: makeMakotoDb(),
    MAKOTO_KV: makeKv(),
    MAKOTO_CHAT_QUEUE: queue,
  } as unknown as Env & {
    MAKOTO_CHAT_QUEUE: Queue<ChatQueueMessage> & { _sent: ChatQueueMessage[] };
  };
}

describe('morning brief scheduled enqueue', () => {
  it('uses the Cloudflare UTC cron equivalent of weekday 08:30 JST', () => {
    expect(MORNING_BRIEF_SETO_CRON).toBe('30 23 * * 0-4');
  });

  it('builds a synthetic Google Chat event for the Seto DM route', () => {
    const event = buildMorningBriefChatEvent(
      Date.parse('2026-05-24T23:30:00.000Z'),
      'scheduled:morning_brief_seto:2026-05-25:1779665400000',
    );
    expect(event.space.name).toBe(MORNING_BRIEF_SETO_SPACE);
    expect(event.space.type).toBe('DM');
    expect(event.message?.sender?.email).toBe(MORNING_BRIEF_SETO_EMAIL);
    expect(event.message?.text).toContain('今日は 2026-05-25 (月) JST です。');
    expect(event.message?.text).toContain('===BRIEF_FINAL===');
    expect(event.message?.text).toContain('内部状態・内部名を書かない');
    expect(event.message?.thread).toBeUndefined();
  });

  it('claims and enqueues one Chat queue message', async () => {
    const env = envWithQueue();
    const nowMs = Date.parse('2026-05-24T23:30:00.000Z');
    const result = await enqueueMorningBriefSeto(env, nowMs);
    expect(result.kind).toBe('enqueued');
    expect(env.MAKOTO_CHAT_QUEUE._sent).toHaveLength(1);
    const sent = env.MAKOTO_CHAT_QUEUE._sent[0]!;
    expect(sent.eventKey).toBe(result.eventKey);
    expect(sent.payload.message?.text).toContain('瀬戸さん向けの朝ブリーフ');
    expect(sent.claim.owner).toMatch(/^cron-morning-brief-seto:/);

    const runtimeEvents = (env.DB as unknown as {
      _tables: { cma_worker_runtime_events: Array<{ event_type?: string }> };
    })._tables.cma_worker_runtime_events.map((row) => row.event_type);
    expect(runtimeEvents).toContain('scheduled_morning_brief_enqueue_start');
    expect(runtimeEvents).toContain('scheduled_morning_brief_enqueued');
  });

  it('does not enqueue duplicate event keys', async () => {
    const env = envWithQueue();
    const nowMs = Date.parse('2026-05-24T23:30:00.000Z');
    await enqueueMorningBriefSeto(env, nowMs);
    const second = await enqueueMorningBriefSeto(env, nowMs);
    expect(second.kind).toBe('lease_alive');
    expect(env.MAKOTO_CHAT_QUEUE._sent).toHaveLength(1);
  });
});
