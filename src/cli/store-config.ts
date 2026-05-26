/**
 * Memory Store カタログ (= TS port of `scripts/cma_memory_init.py:STORES`).
 *
 * 新メンバー onboarding CLI (`src/cli/onboarding.ts`) が
 * `init-user-memory-stores` で発行する DM-only ストア 2 種 (= `_DM_ONLY_STORES`
 * = `_USER_SCOPED_STORES`) と、共通ストア (per-user 発行しない) の定数定義。
 *
 * Python 一次ソース:
 *   - `STORES` dict           : `scripts/cma_memory_init.py:l.42` 〜 `l.143`
 *   - `_COMMON_STORES`        : 同 l.156-163
 *   - `_DM_ONLY_STORES`       : 同 l.166
 *   - `_USER_SCOPED_STORES`   : 同 l.167 (= `_DM_ONLY_STORES` frozenset)
 *
 * Issue: ksk3304/makoto-prime#186 (K = Onboarding CLI)
 * Parent: ksk3304/makoto-prime#177
 */

export type StoreAccess = 'read_write' | 'read_only';

export interface StoreSpec {
  description: string;
  access: StoreAccess;
  instructions: string;
}

/**
 * 全 Memory Store の論理名 → spec の dict.
 * Python `cma_memory_init.STORES` を逐語転記 (drift 防止のため description /
 * instructions の文言は変更しない)。
 */
export const STORES: Readonly<Record<string, StoreSpec>> = Object.freeze({
  company_core_memory: {
    description:
      '会社全体で共有する不変知識 (人物・組織・経緯) を格納する。read_only でユーザーは更新できない。',
    access: 'read_only',
    instructions:
      '会社の不変知識を読み取り専用で参照します。人物・組織・経緯の事実確認に使う。' +
      '更新は管理者が直接行う想定で、本 store からは書き込まない。',
  },
  makoto_kun_memory: {
    description:
      'MAKOTOくん自身の業務観・学び・反省・人間からのフィードバックを蓄積する自己ストア (read_write)。',
    access: 'read_write',
    instructions:
      'あなた (MAKOTOくん) 自身の業務知識・学び・反省を蓄積するストアです。' +
      '新規メンバー全員で共有 (per-user 分離しない)。各 session 終了時に、' +
      '学んだ手順・パターン・反省を `learning_<topic>.md` 等に追記する形で残す。' +
      '失敗・ヒヤリハット・人間からのフィードバック・反省は `emotion-log.md` に時系列で末尾追記。' +
      '1ファイル 100KB 上限、50KB を超えそうなら分割か要約。' +
      '確認してください。' +
      '業務支援で得た知識・パターンは `learning_<topic>.md` にトピック別で書き込み。' +
      '失敗・ヒヤリハット・人間からのフィードバック・反省は `emotion-log.md` に ' +
      '時系列で末尾追記する (新規ファイルを作らない)。' +
      '1ファイル 100KB 上限、50KB を超えそうなら分割か要約。' +
      'emotion-log.md が 100KB に近づいたら `emotion-log-archive-<YYYYQN>.md` に切り出す。',
  },
  session_log_dm_store: {
    description:
      'DM (個人 1:1) セッションログ保管庫。長期記憶 (それ以前のセッション全部) の ' +
      '参照源。共有スペースでの DM 漏洩防止のため、専用ストアに分離 (read_write)。',
    access: 'read_write',
    instructions:
      'DM (個人 1:1) で交わされた MAKOTOくんとのセッションログ保管庫です。' +
      'ファイル命名: `/YYYY-MM-DD/dm-<user_slug>.md`。' +
      'セッション (= Google Chat スレッド) 単位でログを追記し、' +
      '同日同ユーザーの複数スレッドは同一ファイルに append (区切りは MD 見出し or `---`)。' +
      '1 ファイル 100KB 接近時は `-2.md` `-3.md` で分割。' +
      '本ストアは共有スペースでは attach されないため、DM 内容がここに記録されても' +
      '共有スペースから直接は見えない。詳細は `specs/memory.md` を参照。',
  },
  session_log_shared_store: {
    description:
      '共有スペース (ROOM / GROUP_CHAT) セッションログ保管庫。長期記憶の ' +
      '参照源 (read_write)。全 session で attach される。',
    access: 'read_write',
    instructions:
      '共有スペースで交わされた MAKOTOくんとのセッションログ保管庫です。' +
      'ファイル命名: `/YYYY-MM-DD/<space_slug>.md`。' +
      'セッション単位でログを追記し、同日同スペースの複数スレッドは同一ファイルに append。' +
      '1 ファイル 100KB 接近時は `-2.md` `-3.md` で分割。' +
      '詳細は `specs/memory.md` を参照。',
  },
  daily_report_dm_store: {
    description:
      'DM 日報保管庫 (中期記憶、DM軸、直近3日分参照)。1日1ファイル DM のみ要約。' +
      'DM 漏洩防止のため共有スペースでは attach されない (read_write)。',
    access: 'read_write',
    instructions:
      'MAKOTOくんの中期記憶 (DM 軸、直近3日分の日報) を保管します。' +
      'ファイル命名: `/YYYY-MM-DD.md` (1日1ファイル、DM 由来のセッションのみを要約)。' +
      'DM session 起動時にまず直近3日分の DM 日報を確認することを推奨。' +
      '本ストアは共有スペースでは attach されない。' +
      '自動生成は Phase C の Cloud Run job が担当。詳細は `specs/memory.md`。',
  },
  daily_report_shared_store: {
    description:
      '共有スペース日報保管庫 (中期記憶、共有軸、直近3日分参照)。1日1ファイル' +
      '共有スペースのみ要約 (read_write)。全 session で attach される。',
    access: 'read_write',
    instructions:
      'MAKOTOくんの中期記憶 (共有スペース軸、直近3日分の日報) を保管します。' +
      'ファイル命名: `/YYYY-MM-DD.md` (1日1ファイル、共有スペース由来のセッションのみを要約)。' +
      'session 起動時にまず直近3日分の共有日報を確認することを推奨。DM 内容は含まれない。' +
      '自動生成は Phase C の Cloud Run job が担当。詳細は `specs/memory.md`。',
  },
});

/**
 * 全ユーザーが共通で attach する三層ストア。`_COMMON_STORES` の TS port。
 * `register_user_mapping` が `stores` field に詰めるリスト。
 */
export const COMMON_STORES: readonly string[] = [
  'company_core_memory',
  'makoto_kun_memory',
  'session_log_dm_store',
  'session_log_shared_store',
  'daily_report_dm_store',
  'daily_report_shared_store',
];

/**
 * DM session でのみ attach するストア (共有スペース session では除外)。
 * `_DM_ONLY_STORES` の TS port。`personal_stores` field に詰める。
 */
export const DM_ONLY_STORES: readonly string[] = [
  'session_log_dm_store',
  'daily_report_dm_store',
];

/**
 * user_slug suffix を付けるストアの集合 (= `_USER_SCOPED_STORES`).
 * Python では `frozenset(_DM_ONLY_STORES)` 相当。
 */
export const USER_SCOPED_STORES: ReadonlySet<string> = new Set(DM_ONLY_STORES);

/**
 * 物理ストア名を生成する (= `cma_memory_init.actual_store_name`).
 *
 * - user_scoped ストアは `<logical_name>__<user_slug>` (例:
 *   `session_log_dm_store__yamada`)
 * - 共通ストアは論理名そのまま
 */
export function actualStoreName(logicalName: string, userSlug: string): string {
  if (USER_SCOPED_STORES.has(logicalName)) {
    return `${logicalName}__${userSlug}`;
  }
  return logicalName;
}
