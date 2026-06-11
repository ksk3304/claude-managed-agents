import { describe, expect, it } from 'vitest';

import type { ChatQueueMessage } from '../src/webhooks/google-chat';
import {
  buildMiddayBriefChatEvent,
  buildMorningBriefChatEvent,
  enqueueMiddayBriefSeto,
  enqueueMorningBriefSeto,
  MIDDAY_BRIEF_SETO_CRON,
  MORNING_BRIEF_SETO_CRON,
  MORNING_BRIEF_SETO_EMAIL,
  MORNING_BRIEF_SETO_SPACE,
} from '../src/scheduled/morning-brief';
import { readChatSenderMappingWithAutoPending } from '../src/lib/memory-attach';
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
    expect(MORNING_BRIEF_SETO_CRON).toBe('30 23 * * sun-thu');
  });

  it('uses the Cloudflare UTC cron equivalent of weekday 13:00 JST', () => {
    expect(MIDDAY_BRIEF_SETO_CRON).toBe('0 4 * * mon-fri');
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
    expect(event.message?.text).toContain('BRIEF_SUGGESTION');
    expect(event.message?.text).toContain('瀬戸さん、おはようございます。');
    expect(event.message?.text).toContain('一手提案');
    expect(event.message?.text).toContain('100〜140 字');
    expect(event.message?.text).toContain('Google Calendar');
    expect(event.message?.text).toContain('まことくん開発管理');
    expect(event.message?.text).toContain('Google Drive');
    expect(event.message?.text).toContain('未完了行');
    expect(event.message?.text).toContain('ActiveTasks.md');
    expect(event.message?.text).toContain('cc-secretary');
    expect(event.message?.text).toContain('補助メモ');
    expect(event.message?.text).toContain('promised_outcome');
    expect(event.message?.text).toContain('AI負担軽減度');
    expect(event.message?.text).toContain('内部状態・内部名を書かない');
    expect(event.message?.text).not.toContain('ブリーフ本文（6 セクション）');
    expect(event.message?.thread).toBeUndefined();
  });

  it('builds a synthetic Google Chat event for the Seto midday route', () => {
    const event = buildMiddayBriefChatEvent(
      Date.parse('2026-05-25T04:00:00.000Z'),
      'scheduled:midday_brief_seto:2026-05-25:1779681600000',
    );
    expect(event.space.name).toBe(MORNING_BRIEF_SETO_SPACE);
    expect(event.space.type).toBe('DM');
    expect(event.message?.sender?.email).toBe(MORNING_BRIEF_SETO_EMAIL);
    expect(event.message?.text).toContain('今日は 2026-05-25 (月) JST です。');
    expect(event.message?.text).toContain('瀬戸さん、お疲れ様です。');
    expect(event.message?.text).toContain('13時TODOチェック');
    expect(event.message?.text).toContain('===BRIEF_SKIP===');
    expect(event.message?.text).toContain('朝とそっくり同じ提案になるなら');
    expect(event.message?.text).toContain('BRIEF_SUGGESTION');
    expect(event.message?.text).toContain('Google Calendar');
    expect(event.message?.text).toContain('まことくん開発管理');
    expect(event.message?.text).toContain('未完了行');
    expect(event.message?.text).toContain('ActiveTasks.md');
    expect(event.message?.text).toContain('cc-secretary');
    expect(event.message?.text).toContain('AI負担軽減度');
    expect(event.message?.text).toContain('朝8:30の内容を暗記で再掲せず');
  });

  it('resolves the synthetic sender email to Seto user mapping for ActiveTasks ownership', async () => {
    const kv = makeKv();
    await kv.put(
      `user_mapping:${MORNING_BRIEF_SETO_EMAIL}`,
      JSON.stringify({
        user_slug: 'seto',
        agent_id: 'agent_seto',
        memory_attachments: [],
      }),
    );
    const event = buildMorningBriefChatEvent(
      Date.parse('2026-05-24T23:30:00.000Z'),
      'scheduled:morning_brief_seto:2026-05-25:1779665400000',
    );
    const r = await readChatSenderMappingWithAutoPending(
      kv,
      {
        senderEmail: event.message?.sender?.email,
        chatUserId: event.message?.sender?.name,
        displayName: event.message?.sender?.displayName,
      },
      undefined,
      event.space.type,
      false,
    );
    expect(r?.source).toBe('direct');
    expect(r?.actorTrusted).toBe(true);
    expect(r?.mapping.user_slug).toBe('seto');
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
    expect(sent.payload.message?.text).toContain('瀬戸さん、おはようございます。');
    expect(sent.claim.owner).toMatch(/^cron-morning-brief-seto:/);

    const runtimeEvents = (env.DB as unknown as {
      _tables: { cma_worker_runtime_events: Array<{ event_type?: string }> };
    })._tables.cma_worker_runtime_events.map((row) => row.event_type);
    expect(runtimeEvents).toContain('scheduled_morning_brief_enqueue_start');
    expect(runtimeEvents).toContain('scheduled_morning_brief_enqueued');
  });

  it('claims and enqueues one midday Chat queue message', async () => {
    const env = envWithQueue();
    const nowMs = Date.parse('2026-05-25T04:00:00.000Z');
    const result = await enqueueMiddayBriefSeto(env, nowMs);
    expect(result.kind).toBe('enqueued');
    expect(env.MAKOTO_CHAT_QUEUE._sent).toHaveLength(1);
    const sent = env.MAKOTO_CHAT_QUEUE._sent[0]!;
    expect(sent.eventKey).toContain('scheduled:midday_brief_seto:');
    expect(sent.payload.message?.text).toContain('13時TODOチェック');
    expect(sent.payload.message?.text).toContain('===BRIEF_SKIP===');
    expect(sent.claim.owner).toMatch(/^cron-midday-brief-seto:/);

    const runtimeEvents = (env.DB as unknown as {
      _tables: { cma_worker_runtime_events: Array<{ event_type?: string }> };
    })._tables.cma_worker_runtime_events.map((row) => row.event_type);
    expect(runtimeEvents).toContain('scheduled_midday_brief_enqueue_start');
    expect(runtimeEvents).toContain('scheduled_midday_brief_enqueued');
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
