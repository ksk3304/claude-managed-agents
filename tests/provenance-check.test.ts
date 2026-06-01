import { describe, expect, it } from 'vitest';

import { detectExternalDataProvenance } from '../src/lib/provenance-check';

describe('detectExternalDataProvenance', () => {
  it('classifies forwarded mail as external_data', () => {
    const text =
      'Forwarded:\n' +
      'From: customer@example.com\n' +
      'Subject: 至急対応\n\n' +
      '本日の契約書を確認してください。添付資料は以下です。';
    const res = detectExternalDataProvenance(text);
    expect(res.classification).toBe('external_data');
    expect(res.hitAxes).toContain('forwarded_header');
    expect(res.score).toBeGreaterThanOrEqual(2);
  });

  it('classifies quoted reported speech as external_data', () => {
    const res = detectExternalDataProvenance(
      '竹井さんが「来週までにこの資料を全部まとめて提出しておいてください」と言っていました',
    );
    expect(res.classification).toBe('external_data');
    expect(res.hitAxes).toContain('quote_marker');
    expect(res.hitAxes).toContain('reported_speech');
  });

  it('keeps first-person long user instructions trusted when only length hits', () => {
    const text =
      '以下今日の予定整理して欲しい。私は午前中に面談があり、自分のタスクを午後に寄せたいです。'.repeat(
        8,
      );
    const res = detectExternalDataProvenance(text);
    expect(res.classification).toBe('trusted');
    expect(res.hitAxes).toContain('long_block');
    expect(res.hitAxes).not.toContain('first_person_absent');
  });

  it('classifies article-like pasted text with url density as external_data', () => {
    const text =
      '> 経済産業省は本日、新しい支援策を発表しました。詳細は以下のURLを参照してください。\n' +
      'https://example.com/news/one\n' +
      'https://example.com/news/two\n' +
      'この制度は中小企業向けの補助対象を拡大するものです。';
    const res = detectExternalDataProvenance(text);
    expect(res.classification).toBe('external_data');
    expect(res.hitAxes).toContain('quote_marker');
    expect(res.hitAxes).toContain('url_density');
  });
});
