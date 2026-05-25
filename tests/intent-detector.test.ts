/**
 * Unit tests for `src/lib/intent-detector.ts` — Cloud Run の
 * `_detect_mail_intent` / `_detect_schedule_intent` /
 * `_detect_action_skill_intent` (scripts/cma_gchat_bot.py) の logic 等価性
 * を担保する。
 *
 * 同入力で同判定を返すかをチェック (byte 等価性は要求しない、判定 logic
 * のみ等価)。
 */

import { describe, it, expect } from 'vitest';
import {
  detectMailIntent,
  detectScheduleIntent,
  detectActionSkillIntent,
  detectAllIntents,
  parseCommand,
  type SkillsData,
} from '../src/lib/intent-detector';

// ---------------------------------------------------------------------------
// parseCommand
// ---------------------------------------------------------------------------

describe('parseCommand', () => {
  it('extracts /<command> at the head and returns the rest', () => {
    expect(parseCommand('/mail to:foo@example.com body')).toEqual([
      '/mail',
      'to:foo@example.com body',
    ]);
  });

  it('returns [null, text] when no leading slash command', () => {
    expect(parseCommand('hello there')).toEqual([null, 'hello there']);
  });

  it('strips whitespace around the rest', () => {
    expect(parseCommand('/help   stuff   ')).toEqual(['/help', 'stuff']);
  });

  it('handles multiline (DOTALL semantics)', () => {
    expect(parseCommand('/schedule line1\nline2')).toEqual([
      '/schedule',
      'line1\nline2',
    ]);
  });

  it('treats command-only input correctly', () => {
    expect(parseCommand('/help')).toEqual(['/help', '']);
  });
});

// ---------------------------------------------------------------------------
// detectMailIntent
// ---------------------------------------------------------------------------

describe('detectMailIntent', () => {
  // --- 正例 (verb pattern) ---
  it('detects MAIL_VERB_PATTERNS — メールして', () => {
    const r = detectMailIntent('明日の議事録、瀬戸さんにメールしておいて');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('verb_pattern');
    // 入力 "メールしておいて" は "メールして" (verb pattern 配列の先頭) に HIT する
    expect(r!.matchedKeywords).toContain('メールして');
  });

  it('detects MAIL_VERB_PATTERNS — メール送', () => {
    const r = detectMailIntent('資料をメール送ってくれ');
    expect(r?.reason).toBe('verb_pattern');
  });

  // --- 正例 (email_addr + action) ---
  it('detects email address + action word', () => {
    const r = detectMailIntent('foo@example.com に資料を送って');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('email_addr_and_action');
    expect(r!.matchedKeywords).toContain('送って');
  });

  it('detects email address + 連絡', () => {
    const r = detectMailIntent('bar@test.co.jp 宛に連絡しておいて');
    expect(r?.reason).toBe('email_addr_and_action');
  });

  // --- 正例 (signal + action) ---
  it('detects signal word + action word — Gmail+送信', () => {
    const r = detectMailIntent('Gmail で送信しておいて');
    expect(r?.reason).toBe('signal_word_and_action');
  });

  it('detects signal word + action word — メアド+伝えて', () => {
    const r = detectMailIntent('竹井さんのメアドに伝えておいて');
    expect(r?.reason).toBe('signal_word_and_action');
  });

  // --- 負例 (調査語 = research suppression) ---
  it('returns null when research word coexists with verb pattern (#1192 対策)', () => {
    expect(
      detectMailIntent('天気を調べてメール送って'),
    ).toBeNull();
  });

  it('returns null when research word coexists with email+action', () => {
    expect(
      detectMailIntent('foo@example.com に最新ニュース調べて送って'),
    ).toBeNull();
  });

  it('returns null when research word coexists with signal+action', () => {
    expect(
      detectMailIntent('リサーチした内容を Gmail で送って'),
    ).toBeNull();
  });

  // --- 負例 (シグナルだけ / アクションだけ) ---
  it('returns null on signal word only (no action)', () => {
    expect(detectMailIntent('Gmail を見た')).toBeNull();
  });

  it('returns null on action word only (no signal)', () => {
    expect(detectMailIntent('資料を送って')).toBeNull();
  });

  it('returns null on empty / blank input', () => {
    expect(detectMailIntent('')).toBeNull();
  });

  it('returns null on plain greeting', () => {
    expect(detectMailIntent('こんにちは、調子はどう？')).toBeNull();
  });

  // --- 境界 (email regex) ---
  it('treats sub-domain emails correctly', () => {
    const r = detectMailIntent('user.name+tag@sub.example.co.jp に送って');
    expect(r?.reason).toBe('email_addr_and_action');
  });

  it('does NOT treat bare "@mention" as email', () => {
    // "@taro" は \w+@\w+\.\w+ 形式を満たさないので email として HIT しない
    // → signal word も無いので最終的に null
    expect(detectMailIntent('@taro に送って')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectScheduleIntent
// ---------------------------------------------------------------------------

describe('detectScheduleIntent', () => {
  // --- 正例 (trigger pattern) ---
  it('detects 定期実行', () => {
    const r = detectScheduleIntent('明日から定期実行で動かして');
    expect(r?.reason).toBe('trigger_pattern');
    expect(r!.matchedKeywords).toContain('定期実行');
  });

  it('detects 毎朝', () => {
    const r = detectScheduleIntent('毎朝 8 時にニュース確認');
    expect(r?.reason).toBe('trigger_pattern');
    expect(r!.matchedKeywords).toContain('毎朝');
  });

  it('detects スケジュール as trigger word', () => {
    const r = detectScheduleIntent('スケジュールに入れて');
    expect(r?.reason).toBe('trigger_pattern');
  });

  // --- 正例 (mgmt + noun) ---
  it('detects 削除 + ジョブ', () => {
    const r = detectScheduleIntent('news_check ジョブを削除して');
    expect(r?.reason).toBe('trigger_pattern'); // ジョブが trigger 集合にも含まれる
  });

  it('detects 一覧 + ジョブ', () => {
    const r = detectScheduleIntent('ジョブの一覧を見せて');
    expect(r).not.toBeNull();
  });

  it('detects 確認 + 定期 (mgmt + noun path, no trigger hit)', () => {
    // 定期 alone は trigger set には無い (= "定期実行" / "定期的に" のみ)
    // また ジョブ / スケジュール / 毎X も含まれないので trigger 経路は通らない
    // → mgmt + noun (定期) 経路で HIT
    const r = detectScheduleIntent('定期のものを確認したい');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('mgmt_word_and_noun');
    expect(r!.matchedKeywords).toContain('確認');
    expect(r!.matchedKeywords).toContain('定期');
  });

  // --- 負例 ---
  it('returns null when management word lacks the schedule noun', () => {
    // "削除して" だけでは noun が無いので null (Cloud Run l.1097 等価)
    expect(detectScheduleIntent('このメッセージを削除して')).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(detectScheduleIntent('')).toBeNull();
  });

  it('returns null on unrelated text', () => {
    expect(detectScheduleIntent('今日のお昼ご飯どうしよう')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectActionSkillIntent
// ---------------------------------------------------------------------------

const SKILLS_DATA: SkillsData = {
  skills: {
    '/mail': { attach_memory: false }, // action skill = ephemeral
    '/schedule': { attach_memory: false }, // action skill
    '/help': { attach_memory: true }, // 通常 skill = 既存セッション継続
    '/notes': {}, // attach_memory 未指定 = 既定 true 扱い → 通常 skill
  },
};

describe('detectActionSkillIntent', () => {
  it('detects explicit /mail slash command as action skill', () => {
    const r = detectActionSkillIntent('/mail to:foo@example.com hi', SKILLS_DATA);
    expect(r).not.toBeNull();
    expect(r!.command).toBe('/mail');
    expect(r!.isActionSkill).toBe(true);
    expect(r!.source).toBe('slash_command');
  });

  it('detects /help slash command as non-action (attach_memory=true)', () => {
    const r = detectActionSkillIntent('/help', SKILLS_DATA);
    expect(r!.command).toBe('/help');
    expect(r!.isActionSkill).toBe(false);
  });

  it('detects /notes (attach_memory unspecified) as non-action', () => {
    // Python `skill_def.get("attach_memory", True)` 等価 → True → not True = False
    const r = detectActionSkillIntent('/notes whatever', SKILLS_DATA);
    expect(r!.isActionSkill).toBe(false);
  });

  it('escalates mail intent to pseudo /mail when no slash command', () => {
    const r = detectActionSkillIntent('foo@example.com に資料を送って', SKILLS_DATA);
    expect(r!.command).toBe('/mail');
    expect(r!.isActionSkill).toBe(true);
    expect(r!.source).toBe('mail_intent');
  });

  it('escalates schedule intent to pseudo /schedule when no slash command', () => {
    const r = detectActionSkillIntent('毎朝 8 時にニュース確認', SKILLS_DATA);
    expect(r!.command).toBe('/schedule');
    expect(r!.isActionSkill).toBe(true);
    expect(r!.source).toBe('schedule_intent');
  });

  it('returns null when no slash command and no implicit intent', () => {
    expect(
      detectActionSkillIntent('こんにちは、調子はどう？', SKILLS_DATA),
    ).toBeNull();
  });

  it('returns command with isActionSkill=false when skill not registered', () => {
    // Cloud Run l.1217-1218: skill_def が None なら (False, cmd) を返す
    const r = detectActionSkillIntent('/unknown args', SKILLS_DATA);
    expect(r).not.toEqual(null);
    expect(r!.command).toBe('/unknown');
    expect(r!.isActionSkill).toBe(false);
  });

  it('handles skills_data with no "skills" key gracefully', () => {
    const r = detectActionSkillIntent('/mail body', {});
    expect(r!.command).toBe('/mail');
    expect(r!.isActionSkill).toBe(false); // not registered = non-action
  });

  it('research word suppresses pseudo /mail escalation (#1192)', () => {
    // mail intent が研究語で潰れるので、slash も無ければ schedule にも該当しない → null
    expect(
      detectActionSkillIntent('天気を調べてメール送って', SKILLS_DATA),
    ).toBeNull();
  });

  it('explicit /mail with research word still routes as /mail (slash override)', () => {
    // slash command が明示されているので research suppression は適用されない
    // (Cloud Run l.1209: cmd, query = parse_command(...) → cmd 取れた時点で確定)
    const r = detectActionSkillIntent('/mail 天気を調べて送って', SKILLS_DATA);
    expect(r!.command).toBe('/mail');
    expect(r!.isActionSkill).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectAllIntents
// ---------------------------------------------------------------------------

describe('detectAllIntents', () => {
  it('returns mail + schedule both, actionSkill omitted when no skillsData', () => {
    const r = detectAllIntents('毎朝 foo@example.com に送って');
    expect(r.mail).not.toBeNull();
    expect(r.mail!.reason).toBe('email_addr_and_action');
    expect(r.schedule).not.toBeNull();
    expect(r.schedule!.reason).toBe('trigger_pattern');
    expect(r.actionSkill).toBeUndefined();
  });

  it('returns actionSkill when skillsData supplied', () => {
    const r = detectAllIntents('毎朝 foo@example.com に送って', SKILLS_DATA);
    // Cloud Run l.1210-1213: mail intent → /mail を先に試し、見つからない時のみ
    // schedule intent → /schedule に escalate。本入力は mail intent HIT で /mail。
    expect(r.actionSkill).not.toBeNull();
    expect(r.actionSkill!.command).toBe('/mail');
  });

  it('returns all-null for unrelated chitchat', () => {
    const r = detectAllIntents('こんにちは', SKILLS_DATA);
    expect(r.mail).toBeNull();
    expect(r.schedule).toBeNull();
    expect(r.actionSkill).toBeNull();
  });

  it('detects multiple intents simultaneously (mail + schedule, no skillsData)', () => {
    const r = detectAllIntents('スケジュールに入れて、メールも送って');
    expect(r.mail).not.toBeNull();
    expect(r.schedule).not.toBeNull();
  });
});
