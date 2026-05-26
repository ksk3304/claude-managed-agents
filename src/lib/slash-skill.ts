/**
 * /help + slash-skill dispatch — Chat 受信本文の先頭 `/<command>` を **agent
 * 呼出より前** に決定論で処理する短絡経路。
 *
 * Cloud Run の以下 2 関数を TS port:
 *   - `cma_gchat_bot.py:_format_help`     (l.3582-3591) — `/help` 一覧 chat 文字列
 *   - `cma_gchat_bot.py:_resolve_skill_run` (l.3616-3664) — command + query から
 *     CMA に渡す prompt/title/attachMemory を組立 (resources 解決は caller)
 *
 * Cloud Run の `_handle_event` 経路 (l.4022-4034):
 *   1. parse_command で先頭 `/<cmd>` 抽出
 *   2. `/help`            → `_format_help` を decoded reply して return (agent 呼ばない)
 *   3. `/costguard`       → `cost_guard.command.handle` を decoded reply して return (l.3949-3956, pre-branch)
 *   4. その他 `/cmd`      → `_resolve_skill_run` で prompt/title を作って agent に投げる
 *   5. slash なし         → 通常 agent 経路
 *
 * 本 module は (1)〜(3) の **agent 非経由**の決定論短絡層を提供する。(4) と (5)
 * は caller (= chat-event-handler.ts) が既存 orchestrator 経路で扱う。
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — port mapping v1 §1 row #23 + 既知 #2 hook)
 * Spec: Cloud Run `scripts/cma_gchat_bot.py` (Python 一次ソース)
 */

import { parseCommand } from './intent-detector';
import type { SkillsData } from './intent-detector';

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/**
 * `_resolve_skill_run` の戻り値を TS 側の最小情報に絞った形。
 *
 * Cloud Run の 5-tuple `(prompt, title, error, run_resources, attach_memory)` のうち
 * resources は TS 側 session-orchestrator が別軸で解決する (= persona / tools spec
 * 注入は orchestrator が担当) ため省略。代わりに `systemPrompt` (skill 個別の
 * `system_prompt` 上書き) を露出させる。
 *
 *   - 正常解決時: `kind: 'run'` + prompt / title / systemPrompt / attachMemory
 *   - 即返信時:   `kind: 'reply'` + text (未登録スキル / 引数不足 等の case)
 *   - そもそも該当無し: `kind: 'fallthrough'` (= caller は agent 経路へ流す)
 */
export type ResolvedSkillRun =
  | {
      kind: 'run';
      /** template に query を埋めた最終 prompt。 */
      prompt: string;
      /** Anthropic API 用 title (= "<skill name> <query 先頭30文字>")。 */
      title: string;
      /** skill 個別 system_prompt 上書き (= null/undefined なら caller の default を使う)。 */
      systemPrompt: string | null;
      /** false なら ephemeral session (= memory 非 attach、Cloud Run l.3658 等価)。 */
      attachMemory: boolean;
    }
  | {
      kind: 'reply';
      /** ユーザー宛 chat 返信本文 (未登録スキル / 引数不足 等)。 */
      text: string;
    }
  | {
      /** caller は agent 経路 (= 通常 orchestrator) に fall through する。 */
      kind: 'fallthrough';
    };

/**
 * `dispatchSlashCommand` の戻り値。
 *
 *   - `decided`: 決定論で処理確定。caller は `text` を chat に投稿して終了。
 *   - `run`:     skill 解決済。caller は run-info で session orchestrate を起動。
 *   - `fallthrough`: slash 経路非該当 (= 通常 agent 経路へ)。
 */
export type SlashDispatchOutcome =
  | { kind: 'decided'; text: string; source: 'help' | 'costguard' | 'resolver_reply' }
  | {
      kind: 'run';
      command: string;
      prompt: string;
      title: string;
      systemPrompt: string | null;
      attachMemory: boolean;
    }
  | { kind: 'fallthrough' };

/**
 * `dispatchSlashCommand` に渡せる外部 handler (= 並列で別 subagent が実装する
 * `/costguard` 等を後付けで差し込めるようにする)。
 *
 * 各 handler は decoded chat 返信文字列を返す (= 副作用なしで text のみ生成、
 * 副作用は handler 内で完結させる契約)。null を返した場合は fall through 扱い
 * (= caller は agent 経路へ流す = 旧経路互換)。
 */
export interface SlashSkillHandlers {
  /**
   * `/costguard` 専用。Cloud Run `cma_gchat_bot.py:l.3949-3956` の pre-branch
   * 等価で、agent / 添付処理より前に決定論で叩く。本 module は dispatcher だけ
   * を提供し、本体実装は `src/lib/cost-guard.ts` 側で別 PR が用意する。
   *
   * @param query - `/costguard` の後ろに付いた argument 文字列 (空可)。
   * @param senderEmail - Cloud Run 側 `sender_email` 引数等価。観測/監査用。
   */
  costguard?: (query: string, senderEmail: string) => Promise<string> | string;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * 先頭 `/<command>` を抽出する。`intent-detector.ts:parseCommand` の re-export
 * (同関数 1 個を slash-skill module 入口からも引けるようにする = caller の
 * import boundary を 1 つに揃えるための alias)。
 *
 *   - `/help arg1 arg2` → `['/help', 'arg1 arg2']`
 *   - `/help`           → `['/help', '']`
 *   - `hi`              → `[null, 'hi']`
 *   - 多行入力 (DOTALL) も第 2 要素に丸ごと残す
 */
export function parseSlashCommand(text: string): [string | null, string] {
  return parseCommand(text);
}

/**
 * Cloud Run `_format_help` (l.3582-3591) の byte 等価 port。
 *
 *   - skills 空 → "スキルが登録されていません。"
 *   - skills 有 → 「*利用可能なスキル一覧*」見出し + "• `/cmd` — desc" 行列挙
 *                  + 末尾に汎用 fallback の注釈
 *
 * Python: 各行を改行で結合し、末尾に空行 + 注釈を入れる。本 port も同じ。
 */
export function formatHelp(skillsData: SkillsData): string {
  const skills = skillsData.skills ?? {};
  const cmds = Object.keys(skills);
  if (cmds.length === 0) {
    return 'スキルが登録されていません。';
  }
  const lines: string[] = ['*利用可能なスキル一覧*\n'];
  for (const cmd of cmds) {
    const info = skills[cmd] ?? {};
    const desc =
      typeof (info as { description?: unknown }).description === 'string'
        ? ((info as { description?: string }).description ?? '')
        : '';
    lines.push(`• \`${cmd}\` — ${desc}`);
  }
  lines.push('\n※ コマンドなしのメンションは汎用 CMA に投げます。');
  return lines.join('\n');
}

/**
 * Cloud Run `_sanitize_title` (l.3594-3613) の TS port。
 *
 *   - Unicode `Cc` (Control: \n \t NULL 等) → 半角スペース
 *   - Unicode `Cf` (Format: ZWJ BOM 等)     → 削除
 *   - Unicode `Z`* で ' ' 以外 (NBSP 等)    → 半角スペース
 *   - 連続スペースを 1 つに圧縮、前後 strip
 *
 * 判定: regex で十分 (JavaScript の Unicode property escape `\p{Cc}` 等)。
 */
function sanitizeTitle(s: string): string {
  if (!s) return '';
  // Cc / 'Z' but not ASCII space → space
  let out = s.replace(/[\p{Cc}]/gu, ' ');
  out = out.replace(/[\p{Cf}]/gu, '');
  // 'Z' (Zs/Zl/Zp) のうち ASCII space 以外を space に
  out = out.replace(/[\p{Z}]/gu, (ch) => (ch === ' ' ? ' ' : ' '));
  // 連続スペース圧縮 + strip
  return out.replace(/ +/g, ' ').trim();
}

/**
 * Cloud Run `_resolve_skill_run` (l.3616-3664) の TS port (最小版)。
 *
 * Cloud Run の 5-tuple のうち `run_resources` は TS 側 session-orchestrator が
 * 別軸で解決するため戻り値からは省略 (= caller 解決)。`systemPrompt` のみ
 * 露出し、null の場合は caller が default を使う契約。
 *
 *   - command なし (= 汎用メンション)        → `kind: 'run'` (query をそのまま prompt)
 *   - command 有 + 未登録                    → `kind: 'reply'` ("未登録のスキル")
 *   - command 有 + 登録済 + query 空         → `kind: 'reply'` ("内容を入力してください")
 *   - command 有 + 登録済 + query 有         → `kind: 'run'` (template 適用 + title 整形)
 */
export function resolveSkillRun(
  command: string | null,
  query: string,
  skillsData: SkillsData,
): ResolvedSkillRun {
  const skills = skillsData.skills ?? {};

  if (command) {
    const skill = skills[command];
    if (skill === undefined || skill === null) {
      return {
        kind: 'reply',
        text: `\`${command}\` は未登録のスキルです。\`/help\` で一覧を確認できます。`,
      };
    }
    if (!query) {
      return {
        kind: 'reply',
        text: `\`${command}\` の後に内容を入力してください。`,
      };
    }
    // template 適用 (= Python l.3643-3644)。`{query}` placeholder 1 箇所のみ置換。
    const templateRaw = (skill as { template?: unknown }).template;
    const template = typeof templateRaw === 'string' ? templateRaw : '{query}';
    const prompt = template.replace('{query}', query);
    // title = "<skill name> <query 先頭 30 文字>" (= Python l.3645)
    const nameRaw = (skill as { name?: unknown }).name;
    const name = typeof nameRaw === 'string' ? nameRaw : command;
    const title = sanitizeTitle(`${name} ${query.slice(0, 30)}`);
    // skill 個別 system_prompt 上書き (= Python l.3646: skill.get("system_prompt") or default)
    const sp = (skill as { system_prompt?: unknown }).system_prompt;
    const systemPrompt = typeof sp === 'string' && sp ? sp : null;
    // attach_memory (= Python l.3658: bool(skill.get("attach_memory", True)))
    const am = (skill as { attach_memory?: unknown }).attach_memory;
    const attachMemory = am === undefined ? true : Boolean(am);
    return { kind: 'run', prompt, title, systemPrompt, attachMemory };
  }

  // 汎用メンション (= Python l.3661-3664)
  return {
    kind: 'run',
    prompt: query,
    title: sanitizeTitle(`GChat: ${query.slice(0, 40)}`),
    systemPrompt: null,
    attachMemory: true,
  };
}

/**
 * Chat 受信本文を slash command として処理する dispatcher entry point。
 *
 * 短絡判定 (= agent 経路に流さず決定論で返答):
 *   1. parseSlashCommand で先頭 `/<cmd>` 抽出
 *   2. command が null (= slash 無し) → `fallthrough` (caller は agent 経路)
 *   3. `/help`                       → `formatHelp` 結果を decided 返却
 *   4. `/costguard` + handler 設定済 → handler を await して decided 返却
 *      handler 未設定 / handler が空文字を返した場合は `fallthrough` (= 旧経路)
 *   5. その他 `/cmd`                 → `resolveSkillRun` を試す
 *      - `reply` (未登録 / 引数不足) → decided 返却 (`source: 'resolver_reply'`)
 *      - `run`                       → `run` outcome (caller は orchestrator に投げる)
 *
 * 副作用なし (= chat 投稿 / KV 書込 / DB 書込は caller 側で行う)。
 */
export async function dispatchSlashCommand(
  text: string,
  skillsData: SkillsData,
  options: {
    senderEmail?: string;
    handlers?: SlashSkillHandlers;
  } = {},
): Promise<SlashDispatchOutcome> {
  const [command] = parseSlashCommand(text);
  if (command === null) {
    return { kind: 'fallthrough' };
  }

  // /help — 一覧返信
  if (command === '/help') {
    return { kind: 'decided', text: formatHelp(skillsData), source: 'help' };
  }

  // /costguard — pre-branch handler (Cloud Run l.3949-3956 等価、agent 非経由)
  if (command === '/costguard') {
    const handler = options.handlers?.costguard;
    if (handler) {
      const [, query] = parseSlashCommand(text);
      const senderEmail = options.senderEmail ?? '';
      const reply = await handler(query, senderEmail);
      if (typeof reply === 'string' && reply.length > 0) {
        return { kind: 'decided', text: reply, source: 'costguard' };
      }
    }
    // handler 未設定 or 空応答 → 旧経路 (= agent fall through)。caller が
    // 通常 orchestrator 経路で扱う。`/costguard` 本体実装が未配線な段階での
    // graceful degradation (= bot 全体を落とさない、Issue #186 既知 #2 hook)。
    return { kind: 'fallthrough' };
  }

  // その他 /<cmd> — resolveSkillRun の解決結果に応じて分岐
  const [, query] = parseSlashCommand(text);
  const resolved = resolveSkillRun(command, query, skillsData);
  if (resolved.kind === 'reply') {
    return { kind: 'decided', text: resolved.text, source: 'resolver_reply' };
  }
  if (resolved.kind === 'run') {
    return {
      kind: 'run',
      command,
      prompt: resolved.prompt,
      title: resolved.title,
      systemPrompt: resolved.systemPrompt,
      attachMemory: resolved.attachMemory,
    };
  }
  return { kind: 'fallthrough' };
}
