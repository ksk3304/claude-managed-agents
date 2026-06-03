/**
 * Memory Store catalog for Cloudflare onboarding.
 *
 * Current design:
 *   - company-wide stores keep stable names (for example `company_core_memory`).
 *   - agent-specific stores use a company prefix, agent number, and purpose suffix
 *     (for example `Makoto Prime_0001_session_log_store`).
 *   - DM / shared-space split is a legacy alias only, not a store creation rule.
 */

export type StoreAccess = 'read_write' | 'read_only';

export interface StoreSpec {
  description: string;
  access: StoreAccess;
  instructions: string;
}

export const STORES: Readonly<Record<string, StoreSpec>> = Object.freeze({
  company_core_memory: {
    description:
      'Company-wide stable knowledge such as organization facts, policies, roles, and terminology.',
    access: 'read_only',
    instructions:
      '会社全体の不変知識を read_only で参照します。人物・組織・用語・ポリシーの事実確認に使います。' +
      'この store には agent から書き込みません。',
  },
  agent_identity_memory: {
    description:
      'Agent-instance identity, profile, operating rules, learnings, and reflections.',
    access: 'read_write',
    instructions:
      'この agent instance 自身の人格・役割・行動ルール・学び・反省を置く store です。' +
      '固有名は generic prompt ではなく instance 変数やこの store 側で扱います。' +
      '個人パーソナル情報を学びとして書く場合は owner 承認を前提にし、必要なら抽象化します。',
  },
  agent_support_memory: {
    description:
      'Owner support context such as preferences, continuing tasks, work style, and open loops.',
    access: 'read_write',
    instructions:
      'owner 支援のための好み・継続タスク・作業文脈・注意点を置く store です。' +
      'DM と共有スペースで store を分けず、owner-agent 単位の支援文脈として扱います。',
  },
  agent_daily_report_store: {
    description:
      'Owner-agent daily reports. Medium-term memory used to restore recent context quickly.',
    access: 'read_write',
    instructions:
      'owner-agent 単位の日報 store です。DM と共有スペースを分けず、1 日の出来事を統合します。' +
      'ログ中の space_type / space / thread は場所メタデータとして残します。',
  },
  agent_session_log_store: {
    description:
      'Owner-agent session logs. Long-term memory containing conversation turns and decisions.',
    access: 'read_write',
    instructions:
      'owner-agent 単位の session log store です。DM と共有スペースを分けず、' +
      '`/YYYY-MM-DD/agent-<user_slug>.md` に append します。' +
      '1 ファイル 100KB 接近時は `-2.md` `-3.md` で分割します。',
  },
});

export const COMPANY_WIDE_STORES: readonly string[] = [
  'company_core_memory',
];

export const AGENT_SCOPED_STORES: readonly string[] = [
  'agent_identity_memory',
  'agent_support_memory',
  'agent_daily_report_store',
  'agent_session_log_store',
];

export const COMMON_STORES: readonly string[] = [
  ...COMPANY_WIDE_STORES,
  ...AGENT_SCOPED_STORES,
];

export const AGENT_SCOPED_STORE_SET: ReadonlySet<string> = new Set(AGENT_SCOPED_STORES);
export const DEFAULT_MEMORY_STORE_COMPANY_NAME = 'Makoto Prime';

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
    .replace(/\s+/g, ' ');
  if (!name) {
    throw new Error('memory store company name is empty');
  }
  return name;
}

export function actualStoreName(
  logicalName: string,
  agentNumber: string,
  companyName?: string,
): string {
  if (!AGENT_SCOPED_STORE_SET.has(logicalName)) {
    return logicalName;
  }
  const number = normalizeAgentNumber(agentNumber);
  const company = normalizeMemoryStoreCompanyName(companyName);
  const suffix = logicalName.replace(/^agent_/, '');
  return `${company}_${number}_${suffix}`;
}
