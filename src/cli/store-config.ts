/**
 * Memory Store catalog for Cloudflare onboarding.
 *
 * 2026-06-04 朝MTG方針:
 *   - DM / 共有スペースでは分けない。
 *   - identity / support / makoto_kun_memory 相当は agent_core に統合。
 *   - 物理名は `company_core` と `MAKOTO_Prime_000X_<purpose>`。
 */

export type StoreAccess = 'read_write' | 'read_only';

export interface StoreSpec {
  description: string;
  access: StoreAccess;
  instructions: string;
}

export const STORES: Readonly<Record<string, StoreSpec>> = Object.freeze({
  company_core: {
    description:
      '会社全体で共有する不変知識 (人物・組織・経緯) を格納する。通常 session からは更新しない。',
    access: 'read_only',
    instructions:
      '会社全体の不変知識を read_only で参照します。人物・組織・用語・ポリシーの事実確認に使います。' +
      'この store には agent から書き込みません。',
  },
  agent_core: {
    description:
      '個別 agent の中核記憶。identity / support / 共通学びを統合して保持する。',
    access: 'read_write',
    instructions:
      '個別 agent の中核記憶です。`/identity/` に個体定義、`/support/` に支援対象の好み・継続文脈、' +
      '`/agent_learnings/` に業務で得た手順・パターン・反省を残します。' +
      '個人の私的情報を共有スペースで出力しない。重要な学びは短く、既存ファイルへ追記します。' +
      '1ファイル100KB上限、50KBを超えそうなら分割か要約します。',
  },
  session_log: {
    description:
      'agent 番号単位のセッションログ。DM / 共有スペースを分けず、発話者に紐づく agent のログとして保持する。',
    access: 'read_write',
    instructions:
      'セッションログ保管庫です。DM / 共有スペースを分けず、この agent 番号のログとして記録します。' +
      'ファイル命名: `/YYYY/MM/DD.md`。' +
      'セッション単位でログを追記し、同日の複数スレッドは同一ファイルに appendします。' +
      '1ファイル100KB接近時は `-2.md` `-3.md` で分割します。',
  },
  daily_report: {
    description:
      'agent 番号単位の日報。DM / 共有スペースを分けず、発話者に紐づく agent の日次要約として保持する。',
    access: 'read_write',
    instructions:
      '中期記憶として日報を保管します。DM / 共有スペースを分けず、この agent 番号の1日分を要約します。' +
      'ファイル命名: `/YYYY/MM/DD.md`。session 起動時に直近数日分を確認することを推奨します。',
  },
});

export const COMMON_STORES: readonly string[] = [
  'company_core',
  'agent_core',
  'session_log',
  'daily_report',
];

/** 旧名互換。新構成では共有スペース除外用 DM-only store は存在しない。 */
export const DM_ONLY_STORES: readonly string[] = [];

export const USER_SCOPED_STORE_NAMES: readonly string[] = [
  'agent_core',
  'session_log',
  'daily_report',
];

export const USER_SCOPED_STORES: ReadonlySet<string> = new Set(USER_SCOPED_STORE_NAMES);

export const AGENT_SCOPED_STORES = USER_SCOPED_STORE_NAMES;
export const AGENT_SCOPED_STORE_SET = USER_SCOPED_STORES;

export const DEFAULT_MEMORY_STORE_COMPANY_NAME = 'MAKOTO_Prime';

export function normalizeAgentNumber(agentNumber: string): string {
  const normalized = agentNumber.trim().toLowerCase().replace(/^agent[_-]?/, '');
  const raw = /^\d+$/.test(normalized)
    ? normalized
    : normalized.match(/[_-](\d+)$/)?.[1] ?? normalized;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`invalid agent number: ${JSON.stringify(agentNumber)}`);
  }
  return raw.padStart(4, '0');
}

export function normalizeMemoryStoreCompanyName(companyName?: string): string {
  const name = (companyName ?? DEFAULT_MEMORY_STORE_COMPANY_NAME)
    .trim()
    .replace(/\s+/g, '_');
  if (!name) {
    throw new Error('memory store company name is empty');
  }
  return name;
}

export function storePrefixForUserSlug(
  userSlug: string,
  agentNumber?: string,
  companyName?: string,
): string {
  const normalized = userSlug.trim();
  const fixed: Record<string, string> = {
    'k-seto': 'MAKOTO_Prime_0001',
    seto: 'MAKOTO_Prime_0001',
    takei: 'MAKOTO_Prime_0002',
  };
  if (fixed[normalized]) return fixed[normalized];
  if (agentNumber) {
    return `${normalizeMemoryStoreCompanyName(companyName)}_${normalizeAgentNumber(agentNumber)}`;
  }
  return normalized;
}

export function actualStoreName(
  logicalName: string,
  userSlugOrAgentNumber: string,
  companyName?: string,
): string {
  if (!USER_SCOPED_STORES.has(logicalName)) {
    return logicalName;
  }
  return `${storePrefixForUserSlug(userSlugOrAgentNumber, userSlugOrAgentNumber, companyName)}_${logicalName}`;
}
