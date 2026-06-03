import type { ChatEventPayload, ChatQueueMessage } from '../webhooks/google-chat';
import { newClaimOwner, releaseClaim, tryClaim } from '../lib/dedupe';
import { recordRuntimeEvent } from '../lib/observability';
import { AgentMailClient } from '../lib/agentmail-api';
import type { AgentMailMessage } from '../types/agentmail';

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
  status?: string | null;
  stage?: string | null;
  waiting_for?: string | null;
  next_check_at?: number | null;
  last_progress_at?: number | null;
  attempt_count?: number | null;
  stop_reason?: string | null;
  thread_ref?: string | null;
  user_visible_status?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
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
    | 'missing_target_space'
    | 'not_ready';
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
    const result =
      task.kind === 'async_wait'
        ? await processAsyncWaitTask(env, task, nowMs)
        : await enqueueHeartbeatTask(env, task, nowMs);
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

export async function processAsyncWaitTask(
  env: Env,
  task: HeartbeatTaskRow,
  nowMs: number = Date.now(),
): Promise<HeartbeatEnqueueResult> {
  const eventKey = heartbeatEventKey(task.task_id, nowMs);
  if (task.target_scope !== 'dm') return { kind: 'unsupported_target', eventKey };
  if (!task.target_space_name) return { kind: 'missing_target_space', eventKey };
  if ((task.waiting_for ?? '').trim() !== 'mail_reply') {
    await markAsyncWaitNotReady(env.DB, task, nowMs, 'unsupported waiting_for');
    return { kind: 'not_ready', eventKey };
  }

  const state = await inspectMailReplyWait(env, task, nowMs);
  if (!state.ready) {
    await markAsyncWaitNotReady(env.DB, task, nowMs, state.statusText);
    await recordRuntimeEvent(env, {
      eventKey,
      eventType: 'scheduled_heartbeat_async_wait_pending',
      source: 'cron.heartbeat',
      detail: {
        task_id: task.task_id,
        waiting_for: task.waiting_for,
        matched: state.matched.length,
        expected: state.expected.length,
        status: state.statusText,
      },
    });
    return { kind: 'not_ready', eventKey };
  }

  const result = await enqueueHeartbeatTask(env, {
    ...task,
    prompt: buildAsyncWaitResumePrompt(task, state),
  }, nowMs);
  if (result.kind === 'enqueued') {
    await markAsyncWaitDone(env.DB, task.task_id, nowMs, state.statusText);
  }
  return result;
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
              active_hours, target_scope, enabled, last_run_at, status, stage,
              waiting_for, next_check_at, last_progress_at, attempt_count,
              stop_reason, thread_ref, user_visible_status
         FROM heartbeat_tasks
        WHERE enabled = 1
          AND (
            (kind = 'patrol'
             AND (last_run_at IS NULL OR ?1 - last_run_at >= interval_min * 60000))
            OR
            (kind = 'async_wait'
             AND status IN ('open', 'waiting')
             AND waiting_for = 'mail_reply'
             AND next_check_at IS NOT NULL
             AND next_check_at <= ?1)
          )
        ORDER BY COALESCE(next_check_at, last_run_at, 0), task_id
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

async function markAsyncWaitNotReady(
  db: D1Database,
  task: HeartbeatTaskRow,
  nowMs: number,
  statusText: string,
): Promise<void> {
  const nextCheckAt = nowMs + Math.max(1, Number(task.interval_min || 30)) * 60_000;
  await db
    .prepare(
      `UPDATE heartbeat_tasks
          SET status = 'waiting',
              next_check_at = ?2,
              last_run_at = ?3,
              updated_at = ?3,
              attempt_count = COALESCE(attempt_count, 0) + 1,
              user_visible_status = ?4
        WHERE task_id = ?1`,
    )
    .bind(task.task_id, nextCheckAt, nowMs, statusText.slice(0, 500))
    .run();
}

async function markAsyncWaitDone(
  db: D1Database,
  taskId: string,
  nowMs: number,
  statusText: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE heartbeat_tasks
          SET status = 'done',
              enabled = 0,
              last_run_at = ?2,
              last_progress_at = ?2,
              updated_at = ?2,
              user_visible_status = ?3
        WHERE task_id = ?1`,
    )
    .bind(taskId, nowMs, statusText.slice(0, 500))
    .run();
}

interface MailReplyWaitRef {
  inbox_id?: string;
  expected_from?: string[];
  since_ms?: number;
  subject_contains?: string;
}

interface MailReplyMatch {
  expected: string;
  from: string;
  subject: string;
  body: string;
  received_at: string;
}

interface MailReplyWaitState {
  ready: boolean;
  expected: string[];
  matched: MailReplyMatch[];
  missing: string[];
  statusText: string;
}

async function inspectMailReplyWait(
  env: Env,
  task: HeartbeatTaskRow,
  nowMs: number,
): Promise<MailReplyWaitState> {
  const ref = parseMailReplyWaitRef(task.thread_ref);
  const inboxId = ref.inbox_id || env.AGENTMAIL_DEFAULT_INBOX_ID || '';
  const expected = (ref.expected_from ?? [])
    .map((value) => normalizeEmail(value))
    .filter(Boolean);
  if (!env.AGENTMAIL_API_KEY || !inboxId || expected.length === 0) {
    return {
      ready: false,
      expected,
      matched: [],
      missing: expected,
      statusText: 'mail_reply wait not configured',
    };
  }

  const client = new AgentMailClient(
    env.AGENTMAIL_API_KEY,
    env.AGENTMAIL_API_BASE_URL ? { baseUrl: env.AGENTMAIL_API_BASE_URL } : {},
  );
  const sinceMs = Number(ref.since_ms ?? task.last_progress_at ?? task.created_at ?? 0);
  const after = Number.isFinite(sinceMs) && sinceMs > 0 ? new Date(sinceMs).toISOString() : undefined;
  const listed = await client.listMessages(inboxId, {
    limit: 100,
    after,
    includeSpam: true,
    includeBlocked: true,
    includeUnauthenticated: true,
  });
  const matches = await matchExpectedReplies(
    client,
    inboxId,
    expected,
    listed.messages,
    ref.subject_contains,
  );
  const matchedSet = new Set(matches.map((match) => match.expected));
  const missing = expected.filter((email) => !matchedSet.has(email));
  return {
    ready: expected.length > 0 && missing.length === 0,
    expected,
    matched: matches,
    missing,
    statusText:
      missing.length === 0
        ? `mail replies ready (${matches.length}/${expected.length})`
        : `waiting for mail replies (${matches.length}/${expected.length})`,
  };
}

function parseMailReplyWaitRef(raw: string | null | undefined): MailReplyWaitRef {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as MailReplyWaitRef;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function matchExpectedReplies(
  client: AgentMailClient,
  inboxId: string,
  expected: string[],
  messages: AgentMailMessage[],
  subjectContains: string | undefined,
): Promise<MailReplyMatch[]> {
  const matches = new Map<string, MailReplyMatch>();
  const subjectNeedle = (subjectContains ?? '').trim().toLowerCase();
  for (const message of messages) {
    const from = normalizeEmail(String(message.from ?? ''));
    if (!from) continue;
    const expectedEmail = expected.find((email) => email === from);
    if (!expectedEmail || matches.has(expectedEmail)) continue;
    const subject = String(message.subject ?? '');
    if (subjectNeedle && !subject.toLowerCase().includes(subjectNeedle)) continue;
    const body =
      agentMailMessageBody(message) ||
      (await hydrateAgentMailMessageBody(client, inboxId, message));
    matches.set(expectedEmail, {
      expected: expectedEmail,
      from,
      subject,
      body,
      received_at: String(message.received_at ?? ''),
    });
  }
  return [...matches.values()];
}

function agentMailMessageBody(message: AgentMailMessage): string {
  return String(message.extracted_text ?? message.text ?? '').trim().slice(0, 2000);
}

async function hydrateAgentMailMessageBody(
  client: AgentMailClient,
  inboxId: string,
  message: AgentMailMessage,
): Promise<string> {
  const messageId = String(message.id ?? message.message_id ?? '').trim();
  if (!messageId) return '';
  try {
    const detail = await client.getMessage(inboxId, messageId);
    return agentMailMessageBody(detail);
  } catch {
    return '';
  }
}

function buildAsyncWaitResumePrompt(task: HeartbeatTaskRow, state: MailReplyWaitState): string {
  const replies = state.matched
    .map((match, index) =>
      [
        `## 返信 ${index + 1}`,
        `from: ${match.from}`,
        `subject: ${match.subject || '(no subject)'}`,
        `received_at: ${match.received_at || '(unknown)'}`,
        '',
        match.body || '(本文なし)',
      ].join('\n'),
    )
    .join('\n\n');
  return `${task.prompt.trim()}

# 非同期継続
待っていたメール返信が揃いました。以下の返信内容を元に、本人DMへ短く集計・次アクション案を出してください。

期待返信者:
${state.expected.map((email) => `- ${email}`).join('\n')}

${replies}

# 制約
- メール送信、共有スペース投稿、外部変更は勝手に実行しない。
- 未確認事項があれば「確認したいこと」として書く。
- 内部状態・task id・実装事情は書かない。`;
}

function normalizeEmail(value: string): string {
  const match = value.match(/<([^>]+)>/);
  const raw = (match?.[1] ?? value).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw) ? raw : '';
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
