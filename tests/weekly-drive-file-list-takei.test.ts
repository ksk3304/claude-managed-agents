import { describe, expect, it } from 'vitest';
import {
  WEEKLY_DRIVE_FILE_LIST_TAKEI_CRON,
  WEEKLY_DRIVE_FILE_LIST_TAKEI_PROMPT,
  WEEKLY_DRIVE_FILE_LIST_TAKEI_SPACE,
  runWeeklyDriveFileListTakeiCron,
} from '../src/scheduled/weekly-drive-file-list-takei';
import { makeKv } from './helpers';
import { makeMakotoDb } from './makoto-helpers';
import type { MailRouteResolution } from '../src/lib/memory-attach';

function env(): Env {
  return {
    DB: makeMakotoDb(),
    MAKOTO_KV: makeKv(),
    ENVIRONMENT_ID: 'env_test',
  } as unknown as Env;
}

const mapping: MailRouteResolution = {
  user_slug: 'takei',
  agent_id: 'agent_takei',
  resources: [
    {
      type: 'memory_store',
      memory_store_id: 'memstore_takei',
      access: 'read_write',
    },
  ],
  full: {
    sender_email: 'takei@makotoprime.com',
    user_slug: 'takei',
    memory_attachments: [],
    system_prompt_addendum: '',
    is_default: false,
    space_type: 'DM',
    filtered_personal_store_count: 0,
  },
};

describe('weekly_drive_file_list_takei cron', () => {
  it('creates a takei session, runs the live prompt, and posts assistant text', async () => {
    const posted: Array<{ space: string; text: string }> = [];
    const result = await runWeeklyDriveFileListTakeiCron(
      env(),
      { cron: WEEKLY_DRIVE_FILE_LIST_TAKEI_CRON, scheduledTime: 123 } as ScheduledController,
      {
        client: {} as never,
        mapping,
        createSession: async (_client, input) => {
          expect(input.agentId).toBe('agent_takei');
          expect(input.environmentId).toBe('env_test');
          expect(input.resources).toHaveLength(1);
          return 'sesn_test';
        },
        runSession: async (_client, sessionId) => {
          expect(sessionId).toBe('sesn_test');
          return {
            assistantText: '更新完了: 3件 / シートURL: https://docs.google.com/spreadsheets/d/x',
            emailSendMarkers: [],
            terminalEventType: 'session.status_idle',
            stopReason: 'end_turn',
          };
        },
        chatSender: async (space, text) => {
          posted.push({ space, text });
        },
      },
    );

    expect(WEEKLY_DRIVE_FILE_LIST_TAKEI_PROMPT).toContain(
      '竹井さんマイドライブファイル一覧',
    );
    expect(result.sessionId).toBe('sesn_test');
    expect(result.eventKey).toBe('scheduled:weekly_drive_file_list_takei:123');
    expect(posted).toEqual([
      {
        space: WEEKLY_DRIVE_FILE_LIST_TAKEI_SPACE,
        text: '更新完了: 3件 / シートURL: https://docs.google.com/spreadsheets/d/x',
      },
    ]);
  });

  it('scrubs internal-state leakage before Chat posting', async () => {
    const posted: string[] = [];
    const result = await runWeeklyDriveFileListTakeiCron(
      env(),
      undefined,
      {
        now: () => 456,
        client: {} as never,
        mapping,
        createSession: async () => 'sesn_scrub',
        runSession: async () => ({
          assistantText: 'memory store が未 attach です',
          emailSendMarkers: [],
        }),
        chatSender: async (_space, text) => {
          posted.push(text);
        },
      },
    );

    expect(result.internalStateHits).toContain('memory store');
    expect(posted[0]).toBe(
      '[weekly_drive_file_list_takei] 今回のタスクは完了できませんでした。担当者が確認します。',
    );
  });
});
