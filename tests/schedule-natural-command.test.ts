import { describe, expect, it, vi } from 'vitest';

import {
  handleNaturalScheduleCommand,
  parseNaturalScheduleCommand,
} from '../src/lib/schedule-natural-command';
import type { ScheduleJob, ScheduleJobManager } from '../src/lib/schedule-action-marker';

function makeManager(jobs: ScheduleJob[]): ScheduleJobManager {
  return {
    list_jobs: vi.fn().mockResolvedValue(jobs),
    format_job_list: vi.fn((items: ScheduleJob[]) =>
      items.map((j) => `・${j.job_id} ${j.cron}`).join('\n'),
    ),
    get_job: vi.fn(),
    create_job: vi.fn(),
    pause_job: vi.fn(),
    resume_job: vi.fn(),
    delete_job: vi.fn(),
    run_job_once: vi.fn(),
    update_job: vi.fn(),
  };
}

describe('parseNaturalScheduleCommand', () => {
  it('maps 削除 to delete, not pause', () => {
    expect(
      parseNaturalScheduleCommand('毎朝5時20分のAIニュースの定期実行を削除してください'),
    ).toMatchObject({ action: 'delete' });
  });

  it('maps 停止 to pause, not delete', () => {
    expect(
      parseNaturalScheduleCommand('morning_ai_news_seto の定期実行を停止して'),
    ).toMatchObject({ action: 'pause' });
  });

  it('extracts the last time as update cron', () => {
    expect(
      parseNaturalScheduleCommand('morning_ai_news_seto の定期実行を6時10分に変更して'),
    ).toMatchObject({ action: 'update', newCron: '10 6 * * *' });
  });
});

describe('handleNaturalScheduleCommand', () => {
  it('deletes the single matched job by time and AI news terms', async () => {
    const manager = makeManager([
      {
        job_id: 'morning_ai_news_seto_dm',
        cron: '20 5 * * *',
        handler: 'cma_session',
        description: '毎朝5:20 AIニュース3本 → 瀬戸さんDM',
      },
    ]);

    const result = await handleNaturalScheduleCommand(
      '毎朝5時20分のAIニュースの定期実行を削除してください',
      manager,
    );

    expect(result.text).toBe('✅ `morning_ai_news_seto_dm` 削除');
    expect(manager.delete_job).toHaveBeenCalledWith('morning_ai_news_seto_dm');
    expect(manager.pause_job).not.toHaveBeenCalled();
  });

  it('pauses the target job when the user says 停止', async () => {
    const manager = makeManager([
      {
        job_id: 'morning_ai_news_seto',
        cron: '45 5 * * *',
        handler: 'cma_session',
      },
    ]);

    await handleNaturalScheduleCommand(
      'morning_ai_news_seto の定期実行を停止して',
      manager,
    );

    expect(manager.pause_job).toHaveBeenCalledWith('morning_ai_news_seto');
    expect(manager.delete_job).not.toHaveBeenCalled();
  });

  it('updates cron for the target job', async () => {
    const manager = makeManager([
      {
        job_id: 'morning_ai_news_seto',
        cron: '45 5 * * *',
        handler: 'cma_session',
      },
    ]);

    const result = await handleNaturalScheduleCommand(
      'morning_ai_news_seto の定期実行を6時10分に変更して',
      manager,
    );

    expect(result.text).toBe('✅ `morning_ai_news_seto` 更新 (cron=10 6 * * *)');
    expect(manager.update_job).toHaveBeenCalledWith('morning_ai_news_seto', {
      cron: '10 6 * * *',
    });
  });

  it('does not mutate when multiple jobs tie', async () => {
    const manager = makeManager([
      { job_id: 'morning_ai_news_a', cron: '20 5 * * *', handler: 'cma_session' },
      { job_id: 'morning_ai_news_b', cron: '20 5 * * *', handler: 'cma_session' },
    ]);

    const result = await handleNaturalScheduleCommand(
      '毎朝5時20分のAIニュースの定期実行を削除して',
      manager,
    );

    expect(result.text).toContain('対象ジョブを1件に絞れません');
    expect(manager.delete_job).not.toHaveBeenCalled();
  });

  it('uses fallback job id for このスケジュール references', async () => {
    const manager = makeManager([
      {
        job_id: 'morning_ai_news_seto',
        cron: '45 5 * * 1-5',
        handler: 'cma_session',
        description: '毎朝5:45 AIニュース3本 (瀬戸さんDM、平日のみ)',
      },
    ]);

    const result = await handleNaturalScheduleCommand(
      'このスケジュール自体いらなくなったので削除して',
      manager,
      { fallbackJobId: 'morning_ai_news_seto' },
    );

    expect(result.text).toBe('✅ `morning_ai_news_seto` 削除');
    expect(manager.delete_job).toHaveBeenCalledWith('morning_ai_news_seto');
  });

  it('treats delete fallback for an absent job as already deleted', async () => {
    const manager = makeManager([]);

    const result = await handleNaturalScheduleCommand(
      'このスケジュールってどのスケジュールかしらちょっとよくわかんないけど削除して削除ね',
      manager,
      { fallbackJobId: 'morning_ai_news_seto' },
    );

    expect(result).toMatchObject({
      handled: true,
      action: 'delete',
      job_id: 'morning_ai_news_seto',
      text: '✅ `morning_ai_news_seto` は登録一覧にありません（既に削除済み）',
    });
    expect(manager.delete_job).not.toHaveBeenCalled();
  });
});
