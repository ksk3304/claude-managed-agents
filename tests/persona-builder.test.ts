/**
 * Unit tests for `src/lib/persona-builder.ts` — Cloud Run の
 * `build_makoto_system_prompt` / `_log_prompt_source` の TS port が
 * byte 等価で動くことを担保する。
 *
 * Cloud Run 側 (`cma_gchat_bot.py:build_makoto_system_prompt` l.896-919)
 * の挙動:
 *   - persona spec を read
 *   - tools spec に対し `default_prompt.find('## メール送信能力')` の
 *     index 以降を切り出し
 *   - `makoto_prompt.rstrip() + "\n\n" + tools_section` で連結
 *   - `[gchat] system prompt source: persona=(... sha256=X) tools=(... sha256=Y)`
 *     起動ログを吐く
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildMakotoSystemPrompt,
  logPromptSource,
  TOOLS_SECTION_MARKER,
} from '../src/lib/persona-builder';

const SAMPLE_PERSONA = `あなたは MAKOTOくん。\n\n# 役割\n業務支援。\n\n# 応答スタイル\n\n丁寧に。\n   \n`;
const SAMPLE_TOOLS = `# 前文プレアンブル\n\nこれは preamble 部分。\n\n## メール送信能力\n\nAgentMail で送る。\n\n## Chat 投稿能力\n\nCHAT_POST マーカー。\n`;

describe('buildMakotoSystemPrompt', () => {
  it('concatenates persona + tools section after rtrimming persona', async () => {
    const r = await buildMakotoSystemPrompt(SAMPLE_PERSONA, SAMPLE_TOOLS);
    expect(r.toolsSectionFound).toBe(true);
    // persona 末尾の空白群 ("\n   \n") を rstrip して "\n\n" + tools_section。
    expect(r.systemPrompt).toBe(
      'あなたは MAKOTOくん。\n\n# 役割\n業務支援。\n\n# 応答スタイル\n\n丁寧に。' +
        '\n\n' +
        '## メール送信能力\n\nAgentMail で送る。\n\n## Chat 投稿能力\n\nCHAT_POST マーカー。\n',
    );
  });

  it('drops the preamble before TOOLS_SECTION_MARKER (Cloud Run l.914-916 等価)', async () => {
    const r = await buildMakotoSystemPrompt(SAMPLE_PERSONA, SAMPLE_TOOLS);
    expect(r.systemPrompt).not.toContain('# 前文プレアンブル');
    expect(r.systemPrompt).not.toContain('これは preamble 部分。');
  });

  it('returns persona-only when tools marker is missing (toolsSectionFound=false)', async () => {
    const toolsWithoutMarker = '# 別のセクションだけ\n\n本文\n';
    const r = await buildMakotoSystemPrompt(SAMPLE_PERSONA, toolsWithoutMarker);
    expect(r.toolsSectionFound).toBe(false);
    expect(r.systemPrompt).toBe(SAMPLE_PERSONA);
  });

  it('exposes byte length (UTF-8) and sha256 truncated to 12 hex chars', async () => {
    const r = await buildMakotoSystemPrompt(SAMPLE_PERSONA, SAMPLE_TOOLS);
    expect(r.personaBytes).toBe(new TextEncoder().encode(SAMPLE_PERSONA).length);
    expect(r.toolsBytes).toBe(new TextEncoder().encode(SAMPLE_TOOLS).length);
    expect(r.personaSha256).toMatch(/^[0-9a-f]{12}$/);
    expect(r.toolsSha256).toMatch(/^[0-9a-f]{12}$/);
  });

  it('byte equivalence with Python: rstrip semantics on persona (issue #117 byte 等価)', async () => {
    const persona = 'persona body';
    const tools = `## メール送信能力\nbody`;
    const r = await buildMakotoSystemPrompt(persona, tools);
    // persona 末尾に余分な空白がないので '\n\n' で結合 (l.918)。
    expect(r.systemPrompt).toBe('persona body\n\n## メール送信能力\nbody');
  });

  it('byte equivalence: trailing newlines on persona collapsed via rstrip', async () => {
    const persona = 'persona\n\n\n   \n';
    const tools = `## メール送信能力\nbody`;
    const r = await buildMakotoSystemPrompt(persona, tools);
    // rstrip して 'persona' + '\n\n' + tools。
    expect(r.systemPrompt).toBe('persona\n\n## メール送信能力\nbody');
  });

  it('sha256 changes when content changes (drift detection)', async () => {
    const r1 = await buildMakotoSystemPrompt(SAMPLE_PERSONA, SAMPLE_TOOLS);
    const r2 = await buildMakotoSystemPrompt(SAMPLE_PERSONA + ' ', SAMPLE_TOOLS);
    expect(r1.personaSha256).not.toBe(r2.personaSha256);
    expect(r1.toolsSha256).toBe(r2.toolsSha256);
  });

  it('throws on empty persona', async () => {
    await expect(buildMakotoSystemPrompt('', SAMPLE_TOOLS)).rejects.toThrow(
      /personaSpec must be a non-empty string/,
    );
  });

  it('accepts empty tools spec (returns persona-only)', async () => {
    const r = await buildMakotoSystemPrompt(SAMPLE_PERSONA, '');
    expect(r.toolsSectionFound).toBe(false);
    expect(r.systemPrompt).toBe(SAMPLE_PERSONA);
    expect(r.toolsBytes).toBe(0);
  });

  it('TOOLS_SECTION_MARKER is the exact Python literal', () => {
    // Cloud Run 側 `cma_gchat_bot.py:build_makoto_system_prompt` l.914 の
    // `marker = "## メール送信能力"` と byte 等価。
    expect(TOOLS_SECTION_MARKER).toBe('## メール送信能力');
  });
});

describe('logPromptSource', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  beforeEach(() => {
    logSpy.mockClear();
    warnSpy.mockClear();
  });
  afterEach(() => {
    logSpy.mockClear();
    warnSpy.mockClear();
  });

  it('emits the Cloud Run-equivalent startup line with [gchat] prefix by default', async () => {
    const r = await buildMakotoSystemPrompt(SAMPLE_PERSONA, SAMPLE_TOOLS);
    logPromptSource(r);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0]![0] as string;
    expect(line).toMatch(
      new RegExp(
        `^\\[gchat\\] system prompt source: persona=\\(bytes=${r.personaBytes} sha256=${r.personaSha256}\\), tools=\\(bytes=${r.toolsBytes} sha256=${r.toolsSha256}\\)$`,
      ),
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('uses the [stage] prefix when options.stage is supplied', async () => {
    const r = await buildMakotoSystemPrompt(SAMPLE_PERSONA, SAMPLE_TOOLS);
    logPromptSource(r, { stage: 'cold' });
    expect(logSpy.mock.calls[0]![0]).toMatch(/^\[cold\] system prompt source:/);
    logPromptSource(r, { stage: 'reactive' });
    expect(logSpy.mock.calls[1]![0]).toMatch(/^\[reactive\] system prompt source:/);
  });

  it('warns when tools marker missing (toolsSectionFound=false)', async () => {
    const r = await buildMakotoSystemPrompt(SAMPLE_PERSONA, '');
    logPromptSource(r);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warn = warnSpy.mock.calls[0]![0] as string;
    expect(warn).toContain("tools marker '## メール送信能力' not found");
  });
});
