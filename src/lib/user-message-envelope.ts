/**
 * user_message envelope builder — Chat reactive turn の入力 prompt を
 * Python と byte 等価で組み立てる純関数。
 *
 * Cloud Run `cma_gchat_bot.py:_handle_event` (l.3784-4280) の prompt 組立部
 * (`prompt = ...` の連鎖) を TS port。Python と byte 等価で並ぶ層は以下:
 *
 *   1. `cap` (任意) — cap-recovery turn 用の `_RECOVERY_PROMPT` 等価 prefix
 *      (= `cma_lib.py` l.95-103)。`opts.cap.recovery=true` の時のみ body の
 *      代わりに RECOVERY_PROMPT を envelope に置く (Python と同じく recovery
 *      は user prompt 全体差し替え。bodyText は無視され、戻り値は recovery 用)
 *   2. `speaker` (任意) — Python `_build_space_context_block` (l.3667-3781) の
 *      「[内部メモ・応答テキストには出さないこと]」block。TS port では XML
 *      tag `<context>` でも包んで agent 側に prompt boundary を明示
 *   3. `intent` (任意) — Python には input 側 prefix なし。TS port 拡張で
 *      `[intent: /mail, source=mail_intent]` の hint を入れて agent context 質
 *      を上げる (回帰防止: opts.intent 未指定なら 0 bytes 追加 = 旧挙動互換)
 *   4. `history` (任意) — Python `history_md` + `\n\n## 今回のメンション\n`
 *      (l.4195) を byte 等価で port
 *   5. `roster` (任意) — Python `_build_space_roster_block` 出力を speaker
 *      block 直後に prepend (l.4244-4253)
 *   6. body — raw user text (mention strip 済 = caller 責務)
 *
 * 設計方針:
 *   - 純関数 (= I/O / 例外 / global state なし、入力同値 → 出力同値)
 *   - 各 opts 欠落時は層が 0 bytes として落ちる (= caller が「中間版互換」を
 *     担保しつつ段階的に層を有効化できる)
 *   - cap-recovery (`opts.cap.recovery=true`) は body を差し替える (= Python
 *     と同じ recovery semantics、bodyText は無視)
 *   - 戻り値は XML tag で包んだ単一文字列 (= session.ts の
 *     sendAndStreamWithToolDispatch がそのまま user.message として送る)
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — port mapping 既知 #11)
 * Source of truth (Python):
 *   - scripts/cma_lib.py l.95-103 (_RECOVERY_PROMPT)
 *   - scripts/cma_gchat_bot.py l.3667-3781 (_build_space_context_block)
 *   - scripts/cma_gchat_bot.py l.4195 (history prepend)
 *   - scripts/cma_gchat_bot.py l.4244-4253 (roster prepend)
 *   - scripts/cma_gchat_bot.py l.4272 (space_context prepend)
 */

import { RECOVERY_PROMPT } from './cap-recovery';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/**
 * Python `## 今回のメンション\n` (l.4195) と byte 等価。history block の
 * 直後に挟む section header。
 */
export const MENTION_SECTION_HEADER = '## 今回のメンション';

/**
 * Python `[内部メモ・応答テキストには出さないこと]` の 1 行目 (l.3763,
 * l.3774) と byte 等価。caller 側で speaker block を組み立てる際の固定 prefix。
 * `speaker.contextBlock` に既に含まれていれば二重 prefix は付けない設計。
 */
export const INTERNAL_MEMO_HEADER = '[内部メモ・応答テキストには出さないこと]';

// ---------------------------------------------------------------------------
// opts type
// ---------------------------------------------------------------------------

/**
 * cap-recovery turn のオプション。Python `_RECOVERY_PROMPT` (cma_lib.py
 * l.95-103) を `recovery=true` で挿入する。recovery が true の時は body は
 * 無視 (Python と同じく recovery turn は body を差し替える semantics)。
 *
 * `noticePrefix` は出力側 (assistant reply) の cap notice (= `⚠️ ...`) では
 * **なく** input 側に注入する notice。Python は input には注入しないため
 * 通常未指定。test 用拡張点として残す。
 */
export interface CapEnvelopeOption {
  /** true なら body を `RECOVERY_PROMPT` で完全置換 (Python recovery 等価). */
  recovery?: boolean;
  /** 追加の input-side notice (Python 既定 = なし)。TS test 用拡張. */
  noticePrefix?: string;
}

/**
 * 検出された intent label (= `/mail` / `/schedule` / `/help` 等)。TS port
 * 拡張で agent context に hint として注入する。Python は input 側 prefix
 * を持たず、検出 intent は dispatch 分岐 (= 別 agent / template) でのみ使う。
 *
 * `command` は `/<name>` 形式、`source` は intent 検出経路 (debug 用)。
 * 未指定なら envelope に何も挿入しない (= 0 bytes、回帰なし)。
 */
export interface IntentEnvelopeOption {
  /** `/<command>` 形式。例: `/mail`、`/schedule`. */
  command: string;
  /** 検出経路。`detectActionSkillIntent` の `source` と等価. */
  source?: 'slash_command' | 'mail_intent' | 'schedule_intent';
  /** action skill (= ephemeral 新規 session) なら true. */
  isActionSkill?: boolean;
}

/**
 * 現ターン依頼主 (= speaker) の context block。Python
 * `_build_space_context_block` の出力 + 最小 `<context>...` 補助情報。
 *
 * - `spaceType` / `senderEmail` は 中間版 envelope (= 既存 `<context>`)
 *   と同形で必須相当 (= 未指定なら `UNKNOWN` / 空文字)
 * - `contextBlock` は Python `_build_space_context_block` の完成形 string を
 *   そのまま渡す (lazy port: caller が組み立てる)
 *   - `[内部メモ・応答テキストには出さないこと]` が先頭にあれば二重 prefix
 *     は付けない (byte 等価維持)
 *   - 空文字 / undefined なら最小 `<context>` のみ生成
 */
export interface SpeakerEnvelopeOption {
  /** Cloud Run `space.type` 等価。例: `DM` / `ROOM` / `SPACE` / `UNKNOWN`. */
  spaceType?: string;
  /** Cloud Run `sender.email` 等価 (lowercase 正規化済 caller 責務). */
  senderEmail?: string;
  /**
   * `_build_space_context_block` の出力 string をそのまま貼り込む。
   * 未指定 / 空文字なら最小 `<context>` のみ生成 (= 旧挙動互換)。
   */
  contextBlock?: string;
}

/**
 * `buildUserMessageEnvelope` の opts。
 *
 * 全 prop 任意。何も渡さなければ最小 envelope (= Python の `prompt = body` +
 * 中間版 TS の `<context>space_type=UNKNOWN sender=</context>\n<user_message>...`)
 * を返す = 回帰なし。
 */
export interface BuildUserMessageEnvelopeOptions {
  cap?: CapEnvelopeOption;
  intent?: IntentEnvelopeOption;
  speaker?: SpeakerEnvelopeOption;
  /**
   * Python `history_md` (l.4194) と byte 等価。`## スレッド過去履歴...`
   * を含む完成形 string を caller が渡す (組立は `chat-history.ts` 責務)。
   * 非空時のみ `\n\n## 今回のメンション\n` を後段に付けて body と連結する。
   */
  history?: string;
  /**
   * Python `_build_space_roster_block` (l.4244-4253) 出力 string。speaker
   * block の直後 (= history より前) に prepend。Python 同様、空 / undefined
   * なら 0 bytes。
   */
  roster?: string;
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

export const MAIL_INTENT_INSTRUCTIONS =
  '<mail_intent_instructions>\n' +
  'このターンはメール送信意図として扱う。\n' +
  '- 宛先・件名・本文が揃う、または宛先と明確な内容名がある場合は、送信前確認を挟まず EMAIL_SEND マーカーを1つ出す。\n' +
  '- 「こんにちはメール」「お礼メール」「確認メール」などの短い内容名は、件名と本文の素材として使う。「こんにちはメール」は件名「こんにちは」、本文「こんにちは」で足りる。\n' +
  '- 宛先が無い場合、または件名/内容/本文の素材が何も無い場合だけ、不足項目を聞き返す。\n' +
  '- 宛先・cc・bcc は推測しない。\n' +
  '</mail_intent_instructions>';

/**
 * speaker block を最小 `<context>...</context>` で組み立てる。
 *
 * - `speaker.contextBlock` が空 → 最小 1 行 `<context>space_type=... sender=...</context>`
 * - `speaker.contextBlock` が非空 → 中身を `<context>` で包んで返す
 *   (二重 wrap 防止: 既に `<context>` 始まりなら そのまま返す)
 */
function buildSpeakerSegment(speaker: SpeakerEnvelopeOption | undefined): string {
  const spaceType = (speaker?.spaceType || 'UNKNOWN').trim() || 'UNKNOWN';
  const senderEmail = (speaker?.senderEmail || '').trim();
  const contextBlock = (speaker?.contextBlock || '').trim();
  // Python `_build_space_context_block` の出力をそのまま `<context>` で包む。
  // 既存 envelope と互換維持のため、空時も最小 1 行 `<context>...</context>` を返す。
  if (!contextBlock) {
    return `<context>space_type=${spaceType} sender=${senderEmail}</context>`;
  }
  // 既に `<context>` 始まりなら二重 wrap せず素通り (= test 経路 fixture 用).
  if (contextBlock.startsWith('<context>')) {
    return contextBlock;
  }
  // 最小ヘッダ + Python 出力 (空行で分離) を `<context>` で包む。
  return `<context>space_type=${spaceType} sender=${senderEmail}\n${contextBlock}</context>`;
}

/**
 * intent label を hint として `<intent>` tag に包む。Python 側 prefix なし
 * のため、未指定なら空文字を返し envelope に何も差し込まない。
 */
function buildIntentSegment(intent: IntentEnvelopeOption | undefined): string {
  if (!intent) return '';
  const command = (intent.command || '').trim();
  if (!command) return '';
  const source = intent.source ? ` source=${intent.source}` : '';
  const actionSkill = intent.isActionSkill ? ` action_skill=true` : '';
  return `<intent>command=${command}${source}${actionSkill}</intent>`;
}

function buildMailIntentInstructionSegment(intent: IntentEnvelopeOption | undefined): string {
  if ((intent?.command || '').trim() !== '/mail') return '';
  return MAIL_INTENT_INSTRUCTIONS;
}

/**
 * roster block を素通り (Python l.4244-4253 と同じく 文字列を caller が
 * 組み立てる責務)。空 / undefined なら 0 bytes。
 */
function buildRosterSegment(roster: string | undefined): string {
  const r = (roster || '').trim();
  return r ? r : '';
}

/**
 * body 部分 (history + mention header + body or recovery prompt)。
 *
 * - cap.recovery=true → `<user_message>{RECOVERY_PROMPT}</user_message>`
 *   (body は完全無視 = Python recovery semantics)
 * - history 非空 → `<user_message>{history}\n\n## 今回のメンション\n{body}</user_message>`
 *   (Python l.4195 と byte 等価)
 * - history 空 → `<user_message>{body}</user_message>`
 */
function buildBodySegment(
  bodyText: string,
  history: string | undefined,
  cap: CapEnvelopeOption | undefined,
): string {
  // cap-recovery turn は body 完全差し替え (Python と同じ semantics)
  if (cap?.recovery === true) {
    return `<user_message>${RECOVERY_PROMPT}</user_message>`;
  }
  const body = bodyText ?? '';
  const h = (history || '').trim();
  if (h) {
    // Python `prompt = f"{history_md}\n\n## 今回のメンション\n{prompt}"` と byte 等価
    return `<user_message>${h}\n\n${MENTION_SECTION_HEADER}\n${body}</user_message>`;
  }
  return `<user_message>${body}</user_message>`;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Chat reactive turn 用の user_message envelope を組み立てる純関数。
 *
 * 戻り値は session に渡す user.message の text 部分そのもの (= caller が
 * `sendAndStreamWithToolDispatch({userMessage})` にそのまま渡す)。
 *
 * 並び (上から下、空文字層は省略 = 行間二重空行も発生しない):
 *
 *   ```
 *   <cap-notice (if opts.cap.noticePrefix)>
 *   <intent (if opts.intent)>
 *   <speaker context>
 *   <roster (if opts.roster)>
 *   <user_message body or recovery prompt>
 *   ```
 *
 * - 全 opts 未指定 → `<context>space_type=UNKNOWN sender=</context>\n<user_message>{body}</user_message>`
 *   (= 中間版 session-orchestrator が今出してる envelope と同形 = 回帰なし)
 * - cap.recovery=true → body 完全差し替え (Python recovery semantics)
 *
 * @param bodyText mention strip 済 raw 本文 (caller 責務)。cap-recovery の
 *                 ときは無視される
 * @param opts 各層の opt-in 入力。順序は固定 (= 上記並び)
 */
export function buildUserMessageEnvelope(
  bodyText: string,
  opts: BuildUserMessageEnvelopeOptions = {},
): string {
  const segments: string[] = [];

  // 1. cap notice (input-side, Python 未使用 = 通常空)
  const capNotice = (opts.cap?.noticePrefix || '').trim();
  if (capNotice) {
    segments.push(capNotice);
  }

  // 2. intent label (TS 拡張)
  const intentSeg = buildIntentSegment(opts.intent);
  if (intentSeg) {
    segments.push(intentSeg);
  }

  const mailIntentInstructions = buildMailIntentInstructionSegment(opts.intent);
  if (mailIntentInstructions) {
    segments.push(mailIntentInstructions);
  }

  // 3. speaker context (= 旧 `<context>` 等価 + Python `_build_space_context_block`)
  segments.push(buildSpeakerSegment(opts.speaker));

  // 4. roster block (Python l.4244-4253)
  const rosterSeg = buildRosterSegment(opts.roster);
  if (rosterSeg) {
    segments.push(rosterSeg);
  }

  // 5. body / recovery (Python l.4195 byte 等価)
  segments.push(buildBodySegment(bodyText, opts.history, opts.cap));

  // 単一改行で連結 = 既存 envelope `<context>...</context>\n<user_message>...`
  // と同形を維持しつつ、新層は同じ 1 改行で挟まる (= byte ドリフトなし)
  return segments.join('\n');
}
