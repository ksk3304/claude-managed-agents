/**
 * weekly_drive_file_list_takei cron runner.
 *
 * Cloud Run job parity:
 * - job_id: weekly_drive_file_list_takei
 * - JST cron: 34 11 * * 3
 * - Cloudflare cron: 34 2 * * 3
 * - payload: Drive file list -> Sheets full refresh -> Chat completion report
 */

import type Anthropic from '@anthropic-ai/sdk';
import {
  buildAnthropicClient,
  createSessionWithResources,
  sendAndStreamWithToolDispatch,
  type CreateSessionInput,
  type SendAndStreamResult,
} from '../lib/session';
import {
  resolveSenderToResources,
  type MailRouteResolution,
} from '../lib/memory-attach';
import { dispatchMakotoTool } from '../dispatch/makoto-tool-dispatcher';
import { postChatMessage } from '../lib/chat-api';
import { wrapChatSender } from '../lib/cost-guard';
import { scrubInternalStateForChat } from '../redact/internal-state';
import { recordRuntimeEvent } from '../lib/observability';

export const WEEKLY_DRIVE_FILE_LIST_TAKEI_CRON = '34 2 * * 3';
export const WEEKLY_DRIVE_FILE_LIST_TAKEI_JOB_ID = 'weekly_drive_file_list_takei';
export const WEEKLY_DRIVE_FILE_LIST_TAKEI_SPACE = 'spaces/AAAAtMj7k-o';
export const WEEKLY_DRIVE_FILE_LIST_TAKEI_EMAIL = 'takei@makotoprime.com';

const SESSION_TIMEOUT_MS = 12 * 60 * 1000;
const SESSION_WATCHDOG_SEC = 11 * 60;
const MAX_CUSTOM_TOOL_CALLS = 120;
const MAX_BUILTIN_TOOL_CALLS = 5;

export const WEEKLY_DRIVE_FILE_LIST_TAKEI_PROMPT =
  '竹井さんのマイドライブにある全ファイル ' +
  '(name / id / mimeType / modifiedTime / owners / webViewLink) を Drive API で取得し、' +
  '専用のスプレッドシート「竹井さんマイドライブファイル一覧」' +
  '(無ければ新規作成、あれば既存を流用) に全件洗い替え ' +
  '(既存シートの内容をクリアしてから全行書き込み) で更新してください。' +
  '完了後、このスペースに「更新完了: 〇件 / シートURL: ...」の形式で報告してください。';

export interface WeeklyDriveFileListResult {
  eventKey: string;
  sessionId: string;
  postedText: string;
  internalStateHits: string[];
  stopReason?: string;
  terminalEventType?: string;
}

export interface WeeklyDriveFileListOverrides {
  client?: Anthropic | null;
  mapping?: MailRouteResolution | null;
  createSession?: (
    client: Anthropic,
    input: CreateSessionInput,
  ) => Promise<string>;
  runSession?: (
    client: Anthropic,
    sessionId: string,
  ) => Promise<SendAndStreamResult>;
  chatSender?: (spaceName: string, text: string) => Promise<void>;
  now?: () => number;
}

export async function runWeeklyDriveFileListTakeiCron(
  env: Env,
  controller?: ScheduledController,
  overrides: WeeklyDriveFileListOverrides = {},
): Promise<WeeklyDriveFileListResult> {
  const nowMs = overrides.now?.() ?? Date.now();
  const scheduledTime = controller?.scheduledTime ?? nowMs;
  const eventKey = `scheduled:${WEEKLY_DRIVE_FILE_LIST_TAKEI_JOB_ID}:${scheduledTime}`;

  await recordRuntimeEvent(env, {
    eventKey,
    messageId: null,
    eventType: 'weekly_drive_file_list_started',
    source: 'scheduled-weekly-drive-file-list-takei',
    detail: { cron: controller?.cron ?? null },
  });

  const mapping =
    overrides.mapping !== undefined
      ? overrides.mapping
      : await resolveSenderToResources(
          env.MAKOTO_KV,
          WEEKLY_DRIVE_FILE_LIST_TAKEI_EMAIL,
        );
  if (mapping === null) {
    throw new Error(
      `${WEEKLY_DRIVE_FILE_LIST_TAKEI_JOB_ID}: user_mapping missing for ${WEEKLY_DRIVE_FILE_LIST_TAKEI_EMAIL}`,
    );
  }

  const client =
    overrides.client !== undefined ? overrides.client : buildAnthropicClient(env);
  if (client === null) {
    throw new Error(`${WEEKLY_DRIVE_FILE_LIST_TAKEI_JOB_ID}: Anthropic API key missing`);
  }

  const createSession = overrides.createSession ?? createSessionWithResources;
  const sessionId = await createSession(client, {
    agentId: mapping.agent_id,
    environmentId: env.ENVIRONMENT_ID,
    resources: mapping.resources,
  });

  const runSession =
    overrides.runSession ??
    ((c: Anthropic, sid: string) =>
      sendAndStreamWithToolDispatch(c, {
        sessionId: sid,
        userMessage: WEEKLY_DRIVE_FILE_LIST_TAKEI_PROMPT,
        timeoutMs: SESSION_TIMEOUT_MS,
        sessionWatchdogSec: SESSION_WATCHDOG_SEC,
        maxToolCalls: MAX_CUSTOM_TOOL_CALLS,
        maxBuiltinToolCalls: MAX_BUILTIN_TOOL_CALLS,
        payloadAudit: {
          kv: env.MAKOTO_KV,
          enabled: env.CMA_AUDIT_USER_MESSAGE_PAYLOADS,
          ttlDays: env.CMA_AUDIT_TTL_DAYS,
          maxTextChars: env.CMA_AUDIT_MAX_TEXT_CHARS,
          mode: 'scheduled_weekly_drive_file_list_takei',
          context: { eventKey, job_id: WEEKLY_DRIVE_FILE_LIST_TAKEI_JOB_ID },
        },
        toolDispatcher: (toolName, input) =>
          dispatchMakotoTool(toolName, input, {
            env,
            userSlug: mapping.user_slug,
            boundMessageId: eventKey,
            callerSessionId: sid,
          }),
      }));

  const sessionResult = await runSession(client, sessionId);
  const rawText = normalizeAssistantText(sessionResult.assistantText);
  const scrubbed = scrubInternalStateForChat(
    rawText,
    WEEKLY_DRIVE_FILE_LIST_TAKEI_JOB_ID,
  );
  const postedText = scrubbed.text;

  const chatSender =
    overrides.chatSender ??
    wrapChatSender(
      { kv: env.MAKOTO_KV },
      async (spaceName: string, text: string): Promise<void> => {
        if (!env.CHAT_SA_KEY_JSON) {
          throw new Error('CHAT_SA_KEY_JSON missing');
        }
        await postChatMessage({ saKeyJson: env.CHAT_SA_KEY_JSON }, spaceName, text);
      },
    );
  await chatSender(WEEKLY_DRIVE_FILE_LIST_TAKEI_SPACE, postedText);

  await recordRuntimeEvent(env, {
    eventKey,
    messageId: null,
    sessionId,
    eventType: 'weekly_drive_file_list_completed',
    source: 'scheduled-weekly-drive-file-list-takei',
    detail: {
      text_chars: postedText.length,
      internal_state_hits: scrubbed.hits,
      stop_reason: sessionResult.stopReason ?? null,
      terminal_event_type: sessionResult.terminalEventType ?? null,
    },
  });

  return {
    eventKey,
    sessionId,
    postedText,
    internalStateHits: scrubbed.hits,
    stopReason: sessionResult.stopReason,
    terminalEventType: sessionResult.terminalEventType,
  };
}

function normalizeAssistantText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length > 0) return trimmed;
  return `[${WEEKLY_DRIVE_FILE_LIST_TAKEI_JOB_ID}] 今回のタスクは完了できませんでした。担当者が確認します。`;
}
