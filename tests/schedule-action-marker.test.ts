/**
 * Unit tests for `src/lib/schedule-action-marker.ts` — Cloud Run の
 * `_handle_schedule_action_marker` + `_exec_schedule_action` 等価動作
 * を確認する。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseScheduleActionMarkers,
  stripScheduleActionMarkers,
  handleScheduleActionMarker,
  type ScheduleJobManager,
  type ScheduleJob,
} from '../src/lib/schedule-action-marker';

function makeManager(overrides: Partial<ScheduleJobManager> = {}): ScheduleJobManager {
  const base: ScheduleJobManager = {
    list_jobs: vi.fn().mockResolvedValue([]),
    format_job_list: vi.fn().mockReturnValue('(empty)'),
    get_job: vi.fn().mockResolvedValue(null),
    create_job: vi.fn().mockResolvedValue(undefined),
    pause_job: vi.fn().mockResolvedValue(undefined),
    resume_job: vi.fn().mockResolvedValue(undefined),
    delete_job: vi.fn().mockResolvedValue(undefined),
    run_job_once: vi.fn().mockResolvedValue(undefined),
    update_job: vi.fn().mockResolvedValue(undefined),
  };
  return { ...base, ...overrides };
}

describe('parseScheduleActionMarkers', () => {
  it('returns empty array when no marker', () => {
    expect(parseScheduleActionMarkers('普通の応答')).toEqual([]);
  });

  it('parses a single valid marker', () => {
    const text = '前文\nSCHEDULE_ACTION:{"action":"list"}';
    const r = parseScheduleActionMarkers(text);
    expect(r).toHaveLength(1);
    expect(r[0]!.data).toEqual({ action: 'list' });
    expect(r[0]!.parseError).toBeUndefined();
  });

  it('parses multiple markers in order', () => {
    const text =
      'SCHEDULE_ACTION:{"action":"list"}\n' +
      'SCHEDULE_ACTION:{"action":"create","job_id":"daily-report","cron":"0 0 * * *"}';
    const r = parseScheduleActionMarkers(text);
    expect(r).toHaveLength(2);
    expect(r[0]!.data!.action).toBe('list');
    expect(r[1]!.data!.action).toBe('create');
    expect(r[1]!.data!.job_id).toBe('daily-report');
  });

  it('records parse error on malformed JSON without throwing', () => {
    const text = 'SCHEDULE_ACTION:{not json}';
    const r = parseScheduleActionMarkers(text);
    expect(r).toHaveLength(1);
    expect(r[0]!.data).toBeUndefined();
    expect(r[0]!.parseError).toBeTruthy();
  });

  it('skips JSON with newlines (Python `[^\\n]+` regex parity)', () => {
    const text = 'SCHEDULE_ACTION:{"action":\n"list"}';
    expect(parseScheduleActionMarkers(text)).toEqual([]);
  });
});

describe('stripScheduleActionMarkers', () => {
  it('removes all markers and collapses excess newlines (3+ → 2)', () => {
    // 入力: '前文\n\n\n[marker]\n\n[marker]' = '前文\n\n\n\n\n' after strip
    // → \n{3,} → \n\n collapse = '前文\n\n'
    const text =
      '前文\n\n\nSCHEDULE_ACTION:{"action":"list"}\n\nSCHEDULE_ACTION:{"action":"pause","job_id":"x"}';
    expect(stripScheduleActionMarkers(text)).toBe('前文\n\n');
  });

  it('returns original when no marker', () => {
    expect(stripScheduleActionMarkers('普通の応答')).toBe('普通の応答');
  });
});

describe('handleScheduleActionMarker', () => {
  it('no-op when no marker (returns text as combinedText)', async () => {
    const r = await handleScheduleActionMarker('普通の応答', makeManager());
    expect(r.markerCount).toBe(0);
    expect(r.combinedText).toBe('普通の応答');
    expect(r.results).toEqual([]);
  });

  it('skipExecution=true: returns prefix only, no manager call', async () => {
    const manager = makeManager();
    const r = await handleScheduleActionMarker(
      '前文\nSCHEDULE_ACTION:{"action":"create","job_id":"x","cron":"* * * * *"}',
      manager,
      { skipExecution: true },
    );
    expect(r.markerCount).toBe(1);
    expect(r.combinedText).toBe('前文');
    expect(r.results).toEqual([]);
    expect(manager.create_job).not.toHaveBeenCalled();
  });

  it('action=list: invokes list_jobs + format_job_list', async () => {
    const manager = makeManager({
      list_jobs: vi.fn().mockResolvedValue([
        { job_id: 'a', cron: '* * * * *', handler: 'h' },
      ] as ScheduleJob[]),
      format_job_list: vi.fn().mockReturnValue('- a (* * * * *)'),
    });
    const r = await handleScheduleActionMarker(
      'SCHEDULE_ACTION:{"action":"list"}',
      manager,
    );
    expect(manager.list_jobs).toHaveBeenCalled();
    expect(r.results[0]).toContain('✅ 定期実行ジョブ一覧');
    expect(r.results[0]).toContain('- a (* * * * *)');
  });

  it('action=create: success path with description (byte-equivalent message)', async () => {
    const manager = makeManager({
      get_job: vi.fn().mockResolvedValue(null),
    });
    const r = await handleScheduleActionMarker(
      'SCHEDULE_ACTION:{"action":"create","job_id":"daily","cron":"0 9 * * *","description":"朝の日報"}',
      manager,
    );
    expect(manager.create_job).toHaveBeenCalledWith(
      'daily',
      '0 9 * * *',
      'cma_session',
      {},
      { description: '朝の日報' },
    );
    expect(r.results[0]).toBe('✅ `daily` 登録 (0 9 * * *, 朝の日報)');
  });

  it('action=create rejects when job_id already exists', async () => {
    const manager = makeManager({
      get_job: vi.fn().mockResolvedValue({
        job_id: 'daily',
        cron: '0 9 * * *',
        handler: 'h',
      } as ScheduleJob),
    });
    const r = await handleScheduleActionMarker(
      'SCHEDULE_ACTION:{"action":"create","job_id":"daily","cron":"* * * * *"}',
      manager,
    );
    expect(manager.create_job).not.toHaveBeenCalled();
    expect(r.results[0]).toContain('既に存在');
  });

  it('action=create fails when cron missing', async () => {
    const r = await handleScheduleActionMarker(
      'SCHEDULE_ACTION:{"action":"create","job_id":"x"}',
      makeManager(),
    );
    expect(r.results[0]).toBe('❌ `x`: cron が未指定');
  });

  it('action=delete: success path', async () => {
    const manager = makeManager();
    const r = await handleScheduleActionMarker(
      'SCHEDULE_ACTION:{"action":"delete","job_id":"x"}',
      manager,
    );
    expect(manager.delete_job).toHaveBeenCalledWith('x');
    expect(r.results[0]).toBe('✅ `x` 削除');
  });

  it('action=pause/resume/run_once: each routes to right manager method', async () => {
    const manager = makeManager();
    await handleScheduleActionMarker(
      'SCHEDULE_ACTION:{"action":"pause","job_id":"x"}\n' +
        'SCHEDULE_ACTION:{"action":"resume","job_id":"x"}\n' +
        'SCHEDULE_ACTION:{"action":"run_once","job_id":"x"}',
      manager,
    );
    expect(manager.pause_job).toHaveBeenCalledWith('x');
    expect(manager.resume_job).toHaveBeenCalledWith('x');
    expect(manager.run_job_once).toHaveBeenCalledWith('x');
  });

  it('action=update: collects updated fields in message', async () => {
    const manager = makeManager();
    const r = await handleScheduleActionMarker(
      'SCHEDULE_ACTION:{"action":"update","job_id":"x","cron":"*/5 * * * *","description":"頻度UP"}',
      manager,
    );
    expect(manager.update_job).toHaveBeenCalledWith('x', {
      cron: '*/5 * * * *',
      description: '頻度UP',
    });
    expect(r.results[0]).toBe('✅ `x` 更新 (cron=*/5 * * * *, desc=頻度UP)');
  });

  it('unknown action returns ❌ 不明なアクション', async () => {
    const r = await handleScheduleActionMarker(
      'SCHEDULE_ACTION:{"action":"foo","job_id":"x"}',
      makeManager(),
    );
    expect(r.results[0]).toBe('❌ 不明なアクション: foo');
  });

  it('manager throws → result captures ErrorName: message', async () => {
    const manager = makeManager({
      delete_job: vi.fn().mockRejectedValue(new TypeError('bad id')),
    });
    const r = await handleScheduleActionMarker(
      'SCHEDULE_ACTION:{"action":"delete","job_id":"x"}',
      manager,
    );
    expect(r.results[0]).toBe('❌ `x`: TypeError: bad id');
  });

  it('JSON parse error → ❌ JSON parse error: <msg>', async () => {
    const manager = makeManager();
    const r = await handleScheduleActionMarker(
      'SCHEDULE_ACTION:{not json}',
      manager,
    );
    expect(r.results[0]).toContain('❌ JSON parse error');
    expect(manager.create_job).not.toHaveBeenCalled();
  });

  it('combinedText: prefix + results joined (Python l.1190 等価)', async () => {
    const manager = makeManager();
    const r = await handleScheduleActionMarker(
      '前文だよ。\n\nSCHEDULE_ACTION:{"action":"pause","job_id":"x"}',
      manager,
    );
    expect(r.combinedText).toBe('前文だよ。\n✅ `x` 一時停止');
  });

  it('combinedText: results-only when prefix empty', async () => {
    const manager = makeManager();
    const r = await handleScheduleActionMarker(
      'SCHEDULE_ACTION:{"action":"pause","job_id":"x"}',
      manager,
    );
    expect(r.combinedText).toBe('✅ `x` 一時停止');
  });
});
