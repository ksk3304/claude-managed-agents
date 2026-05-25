/**
 * Intent detection — Chat 発話から bot が起動すべき意図 (mail / schedule /
 * action skill) を抽出する純関数群。
 *
 * Cloud Run の `scripts/cma_gchat_bot.py` の以下 3 関数を TS port:
 *   - `_detect_mail_intent` (l.1052): メール送信意図の検出
 *   - `_detect_schedule_intent` (l.1089): スケジュール管理意図の検出
 *   - `_detect_action_skill_intent` (l.1193): action skill 起動意図の検出
 *
 * 判定 logic は Cloud Run 側と等価 (= 同入力で同判定)。byte 等価性は
 * 要求されないが、キーワード集合と判定式は厳密に踏襲する。
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — port mapping v1 §1 row #22)
 * Spec: products/makoto-kun/specs/architecture.md (action skill 章)
 */
/* eslint-disable @typescript-eslint/no-unused-vars */

// ---------------------------------------------------------------------------
// キーワード集合 (Cloud Run l.1028-1049 / l.1075-1086 と等価)
// ---------------------------------------------------------------------------

/** メール送信を強く示唆する複合動詞句 (= verb pattern)。 */
const MAIL_VERB_PATTERNS: readonly string[] = [
  'メールして', 'メールしとい', 'メール書い',
  'メール送', 'メアド送',
];

/** メール関連の signal word (= 単独では弱い、action と組合せで判定)。 */
const MAIL_SIGNAL_WORDS: readonly string[] = [
  'メール', 'メアド', 'Gmail', 'gmail', 'E-mail', 'e-mail',
];

/** 送信動作を表す action word。 */
const MAIL_ACTION_WORDS: readonly string[] = [
  '送って', '送っとい', '送信', '送る', '送れ', '送りた', '送付',
  '伝えて', '伝えとい',
  '連絡して', '連絡しとい', '連絡お願い',
  '返信', '返事', '返して', '書いて送',
];

/** RFC-style メールアドレス検出 (= Python `[\w.+\-]+@[\w\-]+\.[\w.\-]+` 等価)。 */
const EMAIL_ADDR_RE = /[\w.+\-]+@[\w\-]+\.[\w.\-]+/;

/**
 * 調査語。これらを伴うメール依頼は「調査＋送信」の複合依頼とみなし、
 * action skill (/mail) ではなく本体セッションで処理させる (Cloud Run l.1046)。
 */
const RESEARCH_INTENT_WORDS: readonly string[] = [
  '調べ', '検索', '最新', 'ニュース', '天気', '相場',
  'リサーチ', '調査', '探して', 'まとめて', '要約して', '情報を集め',
];

/** スケジュール trigger pattern (= 単独で強く schedule 意図を示す語)。 */
const SCHEDULE_TRIGGER_PATTERNS: readonly string[] = [
  '定期実行', '定期的に', 'スケジュール', 'ジョブ',
  '毎朝', '毎晩', '毎日', '毎週', '毎月', '毎時',
];

/** スケジュール管理動詞 (= management + 名詞 で確定)。 */
const SCHEDULE_MANAGEMENT_WORDS: readonly string[] = [
  '止めて', '停止', '止めろ', '止まれ',
  '再開', '再スタート',
  '削除', '消して', '消去',
  '一覧', 'リスト', '見せて', '確認',
  '登録', '追加', '設定', '作って',
  '今すぐ実行', '今すぐ送', '即時実行',
];

/** management word と組み合わせて schedule 確定させる名詞 (Cloud Run l.1097)。 */
const SCHEDULE_MANAGEMENT_NOUNS: readonly string[] = ['ジョブ', '定期', 'スケジュール'];

// ---------------------------------------------------------------------------
// 結果型定義
// ---------------------------------------------------------------------------

/** メール送信意図検出結果。 */
export interface MailIntent {
  /** 判定理由 (= debug / 観測用、ユーザー表示しない)。 */
  reason:
    | 'verb_pattern'        // MAIL_VERB_PATTERNS のいずれかが HIT
    | 'email_addr_and_action' // メアド + action word
    | 'signal_word_and_action'; // signal word + action word
  /** HIT したキーワード列 (重複あり、debug 用)。 */
  matchedKeywords: string[];
}

/** スケジュール管理意図検出結果。 */
export interface ScheduleIntent {
  reason:
    | 'trigger_pattern'       // SCHEDULE_TRIGGER_PATTERNS のいずれかが HIT
    | 'mgmt_word_and_noun';   // mgmt word + noun (ジョブ/定期/スケジュール)
  matchedKeywords: string[];
}

/** Action skill 起動意図検出結果。 */
export interface ActionSkillIntent {
  /** 起動対象 command (例: `/mail`, `/schedule`, `/help`)。 */
  command: string;
  /**
   * skills_data 上で `attach_memory: false` だったか。true なら ephemeral
   * 新規セッションに逃がすべき (Cloud Run l.1205-1206 等価)。
   */
  isActionSkill: boolean;
  /** command 検出経路 (= debug 用)。 */
  source: 'slash_command' | 'mail_intent' | 'schedule_intent';
}

/** 3 つの intent をまとめて取得する便利結果。 */
export interface IntentDetectionResult {
  mail: MailIntent | null;
  schedule: ScheduleIntent | null;
  /** skills_data を渡した場合のみ非 null。それ以外は undefined。 */
  actionSkill?: ActionSkillIntent | null;
}

/**
 * skills_data の最小型。Cloud Run 側 `skills_data.get("skills") or {}` 経由で
 * `cmd -> {attach_memory: bool, ...}` を引く部分のみを利用する。
 */
export interface SkillsData {
  skills?: Record<string, { attach_memory?: boolean } & Record<string, unknown>> | null;
}

// ---------------------------------------------------------------------------
// 内部ユーティリティ
// ---------------------------------------------------------------------------

/** `text` に `words` のいずれかが部分一致するかと、HIT 語列を返す。 */
function findMatches(text: string, words: readonly string[]): string[] {
  const hits: string[] = [];
  for (const w of words) {
    if (text.includes(w)) hits.push(w);
  }
  return hits;
}

/**
 * Python `parse_command` 等価 (l.956)。
 *
 *   - 先頭が `/<command>` なら `[command, 残りテキスト]` を返す
 *   - そうでなければ `[null, 全テキスト (strip 済)]` を返す
 *
 * 呼出前に mention は除去済みである前提。
 */
export function parseCommand(text: string): [string | null, string] {
  const cleaned = text.trim();
  // Python: `re.match(r"(/\S+)\s*(.*)", cleaned, re.DOTALL)`
  // `\S+` = 非空白連続、`\s*` = 区切り空白、`(.*)` = 残り。DOTALL 相当に `[\s\S]` 使用。
  const m = cleaned.match(/^(\/\S+)\s*([\s\S]*)$/);
  if (m) {
    return [m[1]!, m[2]!.trim()];
  }
  return [null, cleaned];
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * メール送信意図を検出する (Cloud Run `_detect_mail_intent` 等価)。
 *
 * 判定 logic (Cloud Run l.1060-1072):
 *   1. `query` が空 → null
 *   2. MAIL_VERB_PATTERNS HIT → 調査語なしなら mail intent、調査語ありなら null
 *   3. メアド + MAIL_ACTION_WORDS → 同上
 *   4. MAIL_SIGNAL_WORDS + MAIL_ACTION_WORDS → 同上
 *   5. それ以外 → null
 *
 * 調査語 (RESEARCH_INTENT_WORDS) 同居時は null = 本体セッションで処理させる
 * (action skill `/mail` の ephemeral 新規セッションだと web_search/memory が
 * 使えないため、調査＋送信の複合依頼が踏ん詰まる #1192 対策)。
 */
export function detectMailIntent(text: string): MailIntent | null {
  if (!text) return null;
  const hasResearchHits = findMatches(text, RESEARCH_INTENT_WORDS);
  const hasResearch = hasResearchHits.length > 0;

  const verbHits = findMatches(text, MAIL_VERB_PATTERNS);
  if (verbHits.length > 0) {
    if (hasResearch) return null;
    return { reason: 'verb_pattern', matchedKeywords: verbHits };
  }

  const hasEmailAddr = EMAIL_ADDR_RE.test(text);
  const actionHits = findMatches(text, MAIL_ACTION_WORDS);
  const signalHits = findMatches(text, MAIL_SIGNAL_WORDS);

  if (hasEmailAddr && actionHits.length > 0) {
    if (hasResearch) return null;
    return {
      reason: 'email_addr_and_action',
      matchedKeywords: actionHits,
    };
  }
  if (signalHits.length > 0 && actionHits.length > 0) {
    if (hasResearch) return null;
    return {
      reason: 'signal_word_and_action',
      matchedKeywords: [...signalHits, ...actionHits],
    };
  }
  return null;
}

/**
 * スケジュール管理意図を検出する (Cloud Run `_detect_schedule_intent` 等価)。
 *
 * 判定 logic (Cloud Run l.1092-1099):
 *   1. `query` が空 → null
 *   2. SCHEDULE_TRIGGER_PATTERNS HIT → schedule intent (trigger_pattern)
 *   3. SCHEDULE_MANAGEMENT_WORDS HIT かつ {ジョブ,定期,スケジュール} HIT → schedule intent
 *   4. それ以外 → null
 */
export function detectScheduleIntent(text: string): ScheduleIntent | null {
  if (!text) return null;

  const triggerHits = findMatches(text, SCHEDULE_TRIGGER_PATTERNS);
  if (triggerHits.length > 0) {
    return { reason: 'trigger_pattern', matchedKeywords: triggerHits };
  }
  const mgmtHits = findMatches(text, SCHEDULE_MANAGEMENT_WORDS);
  if (mgmtHits.length > 0) {
    const nounHits = findMatches(text, SCHEDULE_MANAGEMENT_NOUNS);
    if (nounHits.length > 0) {
      return {
        reason: 'mgmt_word_and_noun',
        matchedKeywords: [...mgmtHits, ...nounHits],
      };
    }
  }
  return null;
}

/**
 * Action skill 起動意図を検出する (Cloud Run `_detect_action_skill_intent` 等価)。
 *
 * 判定 logic (Cloud Run l.1209-1220):
 *   1. parse_command で `/<command>` 抽出
 *   2. command なしで mail intent → `/mail` として擬似 command
 *   3. command なしで schedule intent → `/schedule` として擬似 command
 *   4. command なし → null
 *   5. skills_data.skills[command] が存在しなければ command 返却 + isActionSkill=false
 *      (Cloud Run は `return False, cmd` を返す = 検出はしたが action skill ではない)
 *   6. attach_memory が `false` 明示なら isActionSkill=true、それ以外 (true / undefined) は false
 *      (Cloud Run: `is_action = not bool(skill_def.get("attach_memory", True))`)
 */
export function detectActionSkillIntent(
  text: string,
  skillsData: SkillsData,
): ActionSkillIntent | null {
  const [cmdFromText, query] = parseCommand(text);
  let cmd: string | null = cmdFromText;
  let source: ActionSkillIntent['source'] = 'slash_command';

  if (cmd === null && detectMailIntent(query) !== null) {
    cmd = '/mail';
    source = 'mail_intent';
  }
  if (cmd === null && detectScheduleIntent(query) !== null) {
    cmd = '/schedule';
    source = 'schedule_intent';
  }
  if (cmd === null) return null;

  const skills = skillsData.skills ?? {};
  const skillDef = skills[cmd];
  if (skillDef === undefined || skillDef === null) {
    return { command: cmd, isActionSkill: false, source };
  }
  // Python: `not bool(skill_def.get("attach_memory", True))`
  // → attach_memory が true / 未指定なら is_action=false、false 明示なら is_action=true
  const attach = skillDef.attach_memory;
  const isActionSkill = !(attach === undefined ? true : Boolean(attach));
  return { command: cmd, isActionSkill, source };
}

/**
 * 3 つの intent を 1 回でまとめて取得する便利関数。
 *
 * `skillsData` を省略した場合は mail/schedule のみ判定し、actionSkill は
 * `undefined` のまま (= caller 側で skills_data を持っていない呼出経路用)。
 */
export function detectAllIntents(
  text: string,
  skillsData?: SkillsData,
): IntentDetectionResult {
  const mail = detectMailIntent(text);
  const schedule = detectScheduleIntent(text);
  if (skillsData === undefined) {
    return { mail, schedule };
  }
  return {
    mail,
    schedule,
    actionSkill: detectActionSkillIntent(text, skillsData),
  };
}
