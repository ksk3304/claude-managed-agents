import type { ChatEventPayload, ChatQueueMessage } from '../webhooks/google-chat';
import { newClaimOwner, releaseClaim, tryClaim } from '../lib/dedupe';
import { recordRuntimeEvent } from '../lib/observability';

export const HEARTBEAT_CRON = '*/30 * * * *';
export const HEARTBEAT_JOB_ID = 'heartbeat_tick';
export const HEARTBEAT_NOTHING_MARKER = '===HEARTBEAT_NOTHING===';

const HEARTBEAT_TICK_MS = 30 * 60 * 1000;
const MAX_TASKS_PER_TICK = 10;

export interface HeartbeatTaskRow {
  task_id: string;
  owner_user_id: string;
  target_space_name: string | null;
  kind: 'patrol' | 'async_wait' | string;
  prompt: string;
  interval_min: number;
  active_hours: string | null;
  target_scope: 'dm' | 'shared' | string;
  enabled: number;
  last_run_at: number | null;
}

export interface HeartbeatTickResult {
  kind: 'disabled' | 'no_due' | 'completed';
  checked: number;
  enqueued: number;
  skipped: number;
}

export interface HeartbeatEnqueueResult {
  kind:
    | 'enqueued'
    | 'duplicate'
    | 'lease_alive'
    | 'failed'
    | 'unsupported_target'
    | 'missing_target_space';
  eventKey: string;
}

export async function runHeartbeatTick(
  env: Env,
  nowMs: number = Date.now(),
): Promise<HeartbeatTickResult> {
  if (!isHeartbeatEnabled(env)) {
    return { kind: 'disabled', checked: 0, enqueued: 0, skipped: 0 };
  }

  const candidates = await selectDueHeartbeatTasks(env.DB, nowMs);
  const due = candidates.filter((task) => isActiveHour(task.active_hours, nowMs));
  if (due.length === 0) {
    return { kind: 'no_due', checked: candidates.length, enqueued: 0, skipped: candidates.length };
  }

  let enqueued = 0;
  let skipped = candidates.length - due.length;
  for (const task of due) {
    const result = await enqueueHeartbeatTask(env, task, nowMs);
    if (result.kind === 'enqueued') enqueued += 1;
    else skipped += 1;
  }

  await recordRuntimeEvent(env, {
    eventKey: `scheduled:${HEARTBEAT_JOB_ID}:${heartbeatTickBucket(nowMs)}`,
    eventType: 'scheduled_heartbeat_tick',
    source: 'cron.heartbeat',
    detail: { checked: candidates.length, due: due.length, enqueued, skipped },
  });

  return { kind: 'completed', checked: candidates.length, enqueued, skipped };
}

export async function enqueueHeartbeatTask(
  env: Env,
  task: HeartbeatTaskRow,
  nowMs: number = Date.now(),
): Promise<HeartbeatEnqueueResult> {
  const eventKey = heartbeatEventKey(task.task_id, nowMs);
  if (task.target_scope !== 'dm') {
    return { kind: 'unsupported_target', eventKey };
  }
  if (!task.target_space_name) {
    return { kind: 'missing_target_space', eventKey };
  }

  const owner = newClaimOwner(`cron-heartbeat-${task.task_id}`);
  const claim = await tryClaim(env.DB, eventKey, owner, { now: nowMs });
  if (claim.state === 'DONE_DUPLICATE') return { kind: 'duplicate', eventKey };
  if (claim.state === 'LEASE_ALIVE') return { kind: 'lease_alive', eventKey };
  if (claim.owner === undefined || claim.version === undefined) {
    return { kind: 'failed', eventKey };
  }

  const payload = buildHeartbeatChatEvent(task, nowMs, eventKey);
  const queueMsg: ChatQueueMessage = {
    eventKey,
    receivedAtMs: nowMs,
    claim: { owner: claim.owner, version: claim.version },
    payload,
  };

  await recordRuntimeEvent(env, {
    eventKey,
    messageId: payload.message?.name,
    eventType: 'scheduled_heartbeat_enqueue_start',
    source: 'cron.heartbeat',
    detail: { task_id: task.task_id, kind: task.kind, target_scope: task.target_scope },
  });

  try {
    await env.MAKOTO_CHAT_QUEUE.send(queueMsg);
    await markHeartbeatTaskRun(env.DB, task.task_id, nowMs);
  } catch (error) {
    await releaseClaim(env.DB, eventKey, claim.owner, claim.version);
    await recordRuntimeEvent(env, {
      eventKey,
      messageId: payload.message?.name,
      eventType: 'scheduled_heartbeat_enqueue_failed',
      level: 'error',
      source: 'cron.heartbeat',
      detail: { task_id: task.task_id, error: error instanceof Error ? error.message : String(error) },
    });
    return { kind: 'failed', eventKey };
  }

  await recordRuntimeEvent(env, {
    eventKey,
    messageId: payload.message?.name,
    eventType: 'scheduled_heartbeat_enqueued',
    source: 'cron.heartbeat',
    detail: { task_id: task.task_id, text_chars: payload.message?.text?.length ?? 0 },
  });
  return { kind: 'enqueued', eventKey };
}

export function buildHeartbeatChatEvent(
  task: Pick<HeartbeatTaskRow, 'task_id' | 'owner_user_id' | 'target_space_name' | 'prompt'>,
  nowMs: number,
  eventKey: string,
): ChatEventPayload {
  const targetSpace = task.target_space_name ?? '';
  const messageName = `${targetSpace}/messages/${safeMessageId(eventKey)}`;
  return {
    type: 'MESSAGE',
    eventTime: new Date(nowMs).toISOString(),
    space: {
      name: targetSpace,
      type: 'DM',
      displayName: `${task.owner_user_id} DM`,
    },
    user: {
      name: `users/scheduled-heartbeat-${safeMessageId(task.task_id)}`,
      displayName: 'MAKOTO Scheduler',
      email: task.owner_user_id,
    },
    message: {
      name: messageName,
      sender: {
        name: `users/scheduled-heartbeat-${safeMessageId(task.task_id)}`,
        displayName: 'MAKOTO Scheduler',
        email: task.owner_user_id,
      },
      text: `${todayPrefix(nowMs)}${heartbeatPrompt(task.prompt)}`,
      annotations: [],
      attachment: [],
    },
  };
}

export function isHeartbeatEnabled(env: Pick<Env, 'HEARTBEAT_ENABLED'>): boolean {
  const value = (env.HEARTBEAT_ENABLED ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function isActiveHour(activeHours: string | null | undefined, nowMs: number): boolean {
  const value = (activeHours ?? '').trim();
  if (!value) return true;
  const match = value.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 0 || start > 23 || end < 0 || end > 24 || start === end) return false;
  const hour = new Date(nowMs + 9 * 60 * 60 * 1000).getUTCHours();
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

async function selectDueHeartbeatTasks(db: D1Database, nowMs: number): Promise<HeartbeatTaskRow[]> {
  const result = await db
    .prepare(
      `SELECT task_id, owner_user_id, target_space_name, kind, prompt, interval_min,
              active_hours, target_scope, enabled, last_run_at
         FROM heartbeat_tasks
        WHERE enabled = 1
          AND kind = 'patrol'
          AND (last_run_at IS NULL OR ?1 - last_run_at >= interval_min * 60000)
        ORDER BY COALESCE(last_run_at, 0), task_id
        LIMIT ?2`,
    )
    .bind(nowMs, MAX_TASKS_PER_TICK)
    .all<HeartbeatTaskRow>();
  return result.results;
}

async function markHeartbeatTaskRun(db: D1Database, taskId: string, nowMs: number): Promise<void> {
  await db
    .prepare(`UPDATE heartbeat_tasks SET last_run_at = ?2, updated_at = ?2 WHERE task_id = ?1`)
    .bind(taskId, nowMs)
    .run();
}

function heartbeatPrompt(prompt: string): string {
  return `${prompt.trim()}

# 出力規約（最優先）
- 通知すべき内容が無い場合は、本文を次の 1 行だけにする: ${HEARTBEAT_NOTHING_MARKER}
- 通知すべき内容がある場合は、本人 DM にそのまま出す短い本文だけを書く。
- 内部状態・ツール名・session 名・store 名・実装事情を書かない。
- メール送信、共有スペース投稿、外部変更は勝手に実行せず、必要なら提案だけにする。`;
}

function todayPrefix(nowMs: number): string {
  const shifted = new Date(nowMs + 9 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return (
    `今日は ${y}-${m}-${d} JST です。` +
    '本セッションは heartbeat 定期実行です。' +
    'prompt 内の「今日」「昨日」「直近 N 時間」はこの日付を基準に解釈すること。\n\n'
  );
}

function heartbeatTickBucket(nowMs: number): number {
  return Math.floor(nowMs / HEARTBEAT_TICK_MS);
}

function heartbeatEventKey(taskId: string, nowMs: number): string {
  return `scheduled:${HEARTBEAT_JOB_ID}:${taskId}:${heartbeatTickBucket(nowMs)}`;
}

function safeMessageId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 120);
}
