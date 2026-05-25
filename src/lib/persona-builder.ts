/**
 * MAKOTOくん system prompt builder — persona spec + tools spec を連結し、
 * 本番反映ゲート §5.2 用の sha256 ログを吐くための核 lib。
 *
 * Cloud Run の `cma_gchat_bot.py:build_makoto_system_prompt(skills_data)`
 * + `_log_prompt_source(skills_data)` を TS port したもの。byte 等価で
 * 動作するよう、連結方法と marker (`## メール送信能力`) は厳密に踏襲。
 *
 * 1. persona spec (= `system-prompt-persona.md`) を read
 * 2. tools spec (= `system-prompt-tools.md`) を read
 * 3. tools spec から `## メール送信能力` 以降を切り出す (= preamble は
 *    `cma_skills.json` の別 consumer 向けで、persona prompt には不要)
 * 4. persona の末尾空白を rstrip して `\n\n` で tools section と連結
 * 5. sha256 (先頭 12 hex) を計算 — `[gchat] system prompt source: ...`
 *    起動ログとしてローカル master の `shasum -a 256` と突合する
 *
 * spec の **データ自体** (Worker bundle にどう同梱するか / makoto-prime
 * 側とどう drift 防止するか) は本 lib の責務外。caller が文字列を渡す
 * 形にして、データ供給方式 (Worker secret / Assets binding / build-time
 * inline) は別途決める (Phase 2 内で詰める、現状 stub data に依存)。
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — #25 persona builder)
 * Spec: port-mapping v1 §1 row #25 + plan-draft-v5.md §0 Day 2 一気 port
 * Source of truth: products/makoto-kun/specs/system-prompt-persona.md
 *                  products/makoto-kun/specs/system-prompt-tools.md
 */

/**
 * `cma_skills.json` で tools 能力セクションの境界を示す marker。Cloud Run
 * 側 (`cma_gchat_bot.py:build_makoto_system_prompt` l.914) と byte 等価で
 * 同じ文字列を切り出すため厳密に固定。
 */
export const TOOLS_SECTION_MARKER = '## メール送信能力';

export interface SystemPromptResult {
  /** 連結済 system prompt (= persona + tools section)。Anthropic API に渡す。 */
  systemPrompt: string;
  /** persona spec の UTF-8 byte length。本番反映ゲート照合用。 */
  personaBytes: number;
  /** persona spec の sha256 先頭 12 hex (Python `[:12]` 等価)。 */
  personaSha256: string;
  /** tools spec の UTF-8 byte length。 */
  toolsBytes: number;
  /** tools spec の sha256 先頭 12 hex。 */
  toolsSha256: string;
  /** tools section が見つかったか (marker miss = persona のみ) */
  toolsSectionFound: boolean;
}

/**
 * persona + tools spec を連結して system prompt を構築する。
 *
 * `personaSpec` / `toolsSpec` は呼出側が事前に load した文字列。Worker
 * bundle のどこから供給するかは caller 責務 (Assets binding / static
 * import / Worker secret 等)。
 */
export async function buildMakotoSystemPrompt(
  personaSpec: string,
  toolsSpec: string,
): Promise<SystemPromptResult> {
  if (typeof personaSpec !== 'string' || personaSpec.length === 0) {
    throw new Error('buildMakotoSystemPrompt: personaSpec must be a non-empty string');
  }
  if (typeof toolsSpec !== 'string') {
    throw new Error('buildMakotoSystemPrompt: toolsSpec must be a string');
  }

  const idx = toolsSpec.indexOf(TOOLS_SECTION_MARKER);
  const toolsSectionFound = idx >= 0;
  const toolsSection = toolsSectionFound ? toolsSpec.slice(idx) : '';

  // Python 側 (l.918): `makoto_prompt.rstrip() + "\n\n" + tools_section`
  // 末尾の空白 / 改行を落としてから `\n\n` を挟む。byte 等価維持。
  const systemPrompt = toolsSection
    ? personaSpec.replace(/\s+$/, '') + '\n\n' + toolsSection
    : personaSpec;

  const [personaSha, toolsSha] = await Promise.all([
    sha256Hex12(personaSpec),
    sha256Hex12(toolsSpec),
  ]);

  return {
    systemPrompt,
    personaBytes: byteLength(personaSpec),
    personaSha256: personaSha,
    toolsBytes: byteLength(toolsSpec),
    toolsSha256: toolsSha,
    toolsSectionFound,
  };
}

/**
 * 起動時に system prompt の実体ソース (persona / tools spec) を 1 回
 * ログ出力する (Cloud Run の `_log_prompt_source` 等価)。本番反映ゲート
 * §5.2 で「ローカル master の `shasum -a 256` 先頭 12 桁と突合」する
 * 起動ログをここで吐く。
 *
 * フォーマットは Cloud Run と byte 等価 — 既存 grep / drift 監視
 * (`scripts/check-prod-prompt-drift.sh`) がそのまま使えるよう固定。
 */
export function logPromptSource(
  result: SystemPromptResult,
  options: { stage?: 'cold' | 'reactive' | 'scheduled' } = {},
): void {
  const stagePrefix = options.stage ? `[${options.stage}]` : '[gchat]';
  console.log(
    `${stagePrefix} system prompt source: ` +
      `persona=(bytes=${result.personaBytes} sha256=${result.personaSha256}), ` +
      `tools=(bytes=${result.toolsBytes} sha256=${result.toolsSha256})`,
  );
  if (!result.toolsSectionFound) {
    console.warn(
      `${stagePrefix} system prompt: tools marker '${TOOLS_SECTION_MARKER}' ` +
        `not found in tools spec — persona-only prompt. Check spec sync.`,
    );
  }
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

async function sha256Hex12(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  let hex = '';
  for (const b of new Uint8Array(hash)) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex.slice(0, 12);
}
