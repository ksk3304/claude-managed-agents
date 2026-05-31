/**
 * Unit tests for `src/lib/slash-skill.ts` — Cloud Run の
 * `_format_help` (l.3582) と `_resolve_skill_run` (l.3616) を TS port した
 * `formatHelp` / `resolveSkillRun` / `dispatchSlashCommand` の logic 等価性
 * を担保する。
 *
 * 同入力で同判定を返すかをチェック (byte 等価性は要求しない、判定 logic と
 * 文字列出力の等価性を担保)。
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — port mapping v1 §1 row #23)
 */

import { describe, it, expect } from 'vitest';
import {
  parseSlashCommand,
  formatHelp,
  resolveSkillRun,
  dispatchSlashCommand,
  type SlashSkillHandlers,
} from '../src/lib/slash-skill';
import { SLASH_SKILLS_DATA } from '../src/data/skills-data';
import type { SkillsData } from '../src/lib/intent-detector';

// ---------------------------------------------------------------------------
// parseSlashCommand
// ---------------------------------------------------------------------------

describe('parseSlashCommand', () => {
  it('extracts /<command> at the head and returns the rest', () => {
    expect(parseSlashCommand('/help foo bar')).toEqual(['/help', 'foo bar']);
  });

  it('returns [null, text] when no leading slash', () => {
    expect(parseSlashCommand('hi there')).toEqual([null, 'hi there']);
  });

  it('handles command-only input (empty query)', () => {
    expect(parseSlashCommand('/help')).toEqual(['/help', '']);
  });

  it('preserves multiline body (DOTALL semantics)', () => {
    expect(parseSlashCommand('/mail to:a@x\nbody line2')).toEqual([
      '/mail',
      'to:a@x\nbody line2',
    ]);
  });
});

// ---------------------------------------------------------------------------
// formatHelp
// ---------------------------------------------------------------------------

describe('formatHelp', () => {
  it('returns "スキルが登録されていません。" when skills is empty', () => {
    expect(formatHelp({ skills: {} })).toBe('スキルが登録されていません。');
  });

  it('returns same string when skills key is absent entirely', () => {
    expect(formatHelp({})).toBe('スキルが登録されていません。');
  });

  it('formats skills list with header + bullet lines + footer (Python l.3582-3591 等価)', () => {
    const skillsData: SkillsData = {
      skills: {
        '/mail': { description: 'メールを送信' },
        '/help': { description: '一覧を表示' },
      },
    };
    const out = formatHelp(skillsData);
    expect(out.startsWith('*利用可能なスキル一覧*\n')).toBe(true);
    expect(out).toContain('• `/mail` — メールを送信');
    expect(out).toContain('• `/help` — 一覧を表示');
    expect(out.endsWith('\n※ コマンドなしのメンションは汎用 CMA に投げます。')).toBe(true);
  });

  it('bundled slash skills provide a non-empty /help list', () => {
    const out = formatHelp(SLASH_SKILLS_DATA);
    expect(out).toContain('*利用可能なスキル一覧*');
    expect(out).toContain('• `/help`');
    expect(out).toContain('• `/costguard`');
    expect(out).toContain('コストガード見せて');
    expect(out).not.toBe('スキルが登録されていません。');
  });

  it('treats missing description as empty string', () => {
    const out = formatHelp({ skills: { '/x': {} } });
    expect(out).toContain('• `/x` — ');
  });
});

// ---------------------------------------------------------------------------
// resolveSkillRun
// ---------------------------------------------------------------------------

describe('resolveSkillRun', () => {
  const SKILLS: SkillsData = {
    skills: {
      '/調査': {
        name: '調査',
        description: 'テーマ調査',
        template: 'テーマ: {query}\n\n調査せよ。',
      },
      '/mail': {
        name: 'メール送信',
        description: 'メール送信',
        attach_memory: false,
        system_prompt: 'mail-skill system prompt',
        template: '依頼: {query}',
      },
    },
  };

  it('returns reply for unregistered command', () => {
    const r = resolveSkillRun('/unknown', 'args', SKILLS);
    expect(r.kind).toBe('reply');
    if (r.kind === 'reply') {
      expect(r.text).toContain('`/unknown`');
      expect(r.text).toContain('未登録');
    }
  });

  it('returns reply for registered command with empty query', () => {
    const r = resolveSkillRun('/調査', '', SKILLS);
    expect(r.kind).toBe('reply');
    if (r.kind === 'reply') {
      expect(r.text).toContain('内容を入力');
    }
  });

  it('returns run with template applied for registered command + query', () => {
    const r = resolveSkillRun('/調査', 'AI 規制動向', SKILLS);
    expect(r.kind).toBe('run');
    if (r.kind === 'run') {
      expect(r.prompt).toBe('テーマ: AI 規制動向\n\n調査せよ。');
      expect(r.title).toContain('調査');
      expect(r.title).toContain('AI 規制動向');
      expect(r.systemPrompt).toBeNull(); // skill に system_prompt 未指定 → caller default
      expect(r.attachMemory).toBe(true); // default
    }
  });

  it('honors skill system_prompt + attach_memory=false (action skill)', () => {
    const r = resolveSkillRun('/mail', 'foo@example.com に hi', SKILLS);
    expect(r.kind).toBe('run');
    if (r.kind === 'run') {
      expect(r.prompt).toBe('依頼: foo@example.com に hi');
      expect(r.systemPrompt).toBe('mail-skill system prompt');
      expect(r.attachMemory).toBe(false); // explicit false
    }
  });

  it('returns run with query as prompt for null command (汎用 mention)', () => {
    const r = resolveSkillRun(null, 'hello world', SKILLS);
    expect(r.kind).toBe('run');
    if (r.kind === 'run') {
      expect(r.prompt).toBe('hello world');
      expect(r.title.startsWith('GChat:')).toBe(true);
      expect(r.systemPrompt).toBeNull();
      expect(r.attachMemory).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// dispatchSlashCommand
// ---------------------------------------------------------------------------

describe('dispatchSlashCommand', () => {
  const SKILLS: SkillsData = {
    skills: {
      '/mail': { name: 'メール', description: '送信', template: '{query}' },
    },
  };

  it('short-circuits /help with formatHelp output', async () => {
    const out = await dispatchSlashCommand('/help', SKILLS);
    expect(out.kind).toBe('decided');
    if (out.kind === 'decided') {
      expect(out.source).toBe('help');
      expect(out.text).toContain('*利用可能なスキル一覧*');
      expect(out.text).toContain('• `/mail`');
    }
  });

  it('returns fallthrough when text does not start with slash', async () => {
    const out = await dispatchSlashCommand('hello', SKILLS);
    expect(out.kind).toBe('fallthrough');
  });

  it('invokes costguard handler when provided', async () => {
    const handlers: SlashSkillHandlers = {
      costguard: (query, senderEmail) => `costguard ok query=${query} email=${senderEmail}`,
    };
    const out = await dispatchSlashCommand('/costguard status', SKILLS, {
      senderEmail: 'k.seto@example.com',
      handlers,
    });
    expect(out.kind).toBe('decided');
    if (out.kind === 'decided') {
      expect(out.source).toBe('costguard');
      expect(out.text).toContain('query=status');
      expect(out.text).toContain('email=k.seto@example.com');
    }
  });

  it('falls through /costguard when handler not configured (graceful degradation)', async () => {
    // 本中間版 = `/costguard` handler 未配線時は agent 経路に逃がす
    const out = await dispatchSlashCommand('/costguard status', SKILLS);
    expect(out.kind).toBe('fallthrough');
  });

  it('returns reply outcome for unregistered slash command', async () => {
    const out = await dispatchSlashCommand('/unknown foo', SKILLS);
    expect(out.kind).toBe('decided');
    if (out.kind === 'decided') {
      expect(out.source).toBe('resolver_reply');
      expect(out.text).toContain('未登録');
    }
  });

  it('returns run outcome for registered slash command + query', async () => {
    const out = await dispatchSlashCommand('/mail send body', SKILLS);
    expect(out.kind).toBe('run');
    if (out.kind === 'run') {
      expect(out.command).toBe('/mail');
      expect(out.prompt).toBe('send body');
      expect(out.attachMemory).toBe(true); // SKILLS.skills[/mail] に attach_memory 未指定 → default true
    }
  });
});
