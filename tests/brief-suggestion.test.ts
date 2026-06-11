import { describe, expect, it } from 'vitest';

import {
  briefDateLabelFromEventKey,
  briefExpiresAtMs,
  buildBriefSuggestionFollowupContext,
  isBriefSuggestionFollowup,
  isFullBriefRequest,
  parseBriefSuggestionMarkers,
  readLatestBriefSuggestion,
  storeBriefSuggestions,
  stripBriefSkipMarker,
} from '../src/lib/brief-suggestion';
import { makeMakotoDb } from './makoto-helpers';

describe('brief suggestion marker', () => {
  it('strips BRIEF_SUGGESTION and parses task/action/goal contract', () => {
    const text =
      'BRIEF_SUGGESTION:{"items":[{"rank":1,"task_key":"issue-416","task_title":"Issue 416整理","support_action":"論点を整理する","promised_outcome":"次に着手できるPR候補まで絞る"}]}\n' +
      '瀬戸さん、おはようございます。Issue 416は僕が論点を整理すると、次に着手できるPR候補まで絞れます。必要なら言ってください。';

    const parsed = parseBriefSuggestionMarkers(text);

    expect(parsed.failures).toEqual([]);
    expect(parsed.cleanedText).not.toContain('BRIEF_SUGGESTION');
    expect(parsed.cleanedText).toContain('瀬戸さん、おはようございます。');
    expect(parsed.suggestions[0]!.items[0]).toMatchObject({
      rank: 1,
      taskKey: 'issue-416',
      taskTitle: 'Issue 416整理',
      supportAction: '論点を整理する',
      promisedOutcome: '次に着手できるPR候補まで絞る',
    });
  });

  it('stores and reads the latest active same-day suggestion', async () => {
    const db = makeMakotoDb();
    const eventKey = 'scheduled:morning_brief_seto:2026-06-11:test';
    const dateLabel = briefDateLabelFromEventKey(eventKey, Date.parse('2026-06-10T23:30:00Z'));
    const parsed = parseBriefSuggestionMarkers(
      'BRIEF_SUGGESTION:{"items":[{"rank":1,"task_title":"開発管理表整理","support_action":"未完了行を優先度順に並べる","promised_outcome":"今日触る1件を選べる状態にする"}]}\n本文',
    );

    await storeBriefSuggestions(db, {
      userSlug: 'alice',
      eventKey,
      jobId: 'morning_brief_seto',
      dateLabel,
      createdAtMs: Date.parse('2026-06-10T23:31:00Z'),
      expiresAtMs: briefExpiresAtMs(dateLabel),
      visibleText: parsed.cleanedText,
      suggestions: parsed.suggestions,
    });

    const row = await readLatestBriefSuggestion(db, {
      userSlug: 'alice',
      nowMs: Date.parse('2026-06-11T00:00:00Z'),
    });

    expect(row).toMatchObject({
      user_slug: 'alice',
      date_label: '2026-06-11',
      task_title: '開発管理表整理',
      support_action: '未完了行を優先度順に並べる',
      promised_outcome: '今日触る1件を選べる状態にする',
      status: 'active',
    });
    expect(buildBriefSuggestionFollowupContext(row!)).toContain('今日触る1件を選べる状態');
  });

  it('recognizes brief follow-up and full brief trigger phrases', () => {
    expect(isBriefSuggestionFollowup('じゃあお願い')).toBe(true);
    expect(isBriefSuggestionFollowup('この件お願いします。')).toBe(true);
    expect(isBriefSuggestionFollowup('お願いします')).toBe(false);

    expect(isFullBriefRequest('今日のブリーフ')).toBe(true);
    expect(isFullBriefRequest('今日の予定とTODO見せて')).toBe(true);
    expect(isFullBriefRequest('全体ブリーフ')).toBe(true);
  });

  it('strips 13:00 skip marker', () => {
    const r = stripBriefSkipMarker('===BRIEF_SKIP===');
    expect(r.skip).toBe(true);
    expect(r.text).toBe('');
  });
});
