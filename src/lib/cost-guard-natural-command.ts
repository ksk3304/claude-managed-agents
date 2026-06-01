/**
 * Natural-language Cost Guard command parser.
 *
 * Slash commandを知らない運用者向けの入口。LLMには流さず、既存の
 * cost-guard-command handlerへ同じ command object を渡す。
 */

export interface ParsedCostGuardNaturalCommand {
  subcommand: string;
  restTokens: string[];
}

const COST_GUARD_TERMS = [
  'costguard',
  'cost guard',
  'コストガード',
  'コスト guard',
  'コスト管理',
  '予算ガード',
  '安全装置',
  '安全弁',
  '上限',
  '月額上限',
  '投稿数上限',
  '外部api上限',
  // 音声入力で "コストガード" が崩れやすい。
  'ポストカード',
] as const;

export function parseNaturalCostGuardCommand(
  text: string,
): ParsedCostGuardNaturalCommand | null {
  const normalized = normalize(text);
  if (!hasAny(normalized, COST_GUARD_TERMS)) return null;

  const hardCap = parseHardCap(normalized);
  if (hardCap) return hardCap;

  if (hasAny(normalized, ['再開', '復帰', '戻して', '解除', 'resume'])) {
    return { subcommand: 'resume', restTokens: [] };
  }
  if (hasAny(normalized, ['有効化', '有効に', 'オンに', 'enable'])) {
    return { subcommand: 'enable', restTokens: [] };
  }
  if (hasAny(normalized, ['一時停止', 'pause'])) {
    return { subcommand: 'pause', restTokens: [extractDuration(normalized) ?? '10m'] };
  }
  if (hasAny(normalized, ['無効化', '無効に', 'オフに', 'disable'])) {
    return { subcommand: 'disable', restTokens: [] };
  }
  if (hasAny(normalized, ['止めて', '止める', '止めろ', '停止'])) {
    const duration = extractDuration(normalized);
    if (duration) return { subcommand: 'pause', restTokens: [duration] };
    return { subcommand: 'disable', restTokens: [] };
  }

  return { subcommand: 'status', restTokens: [] };
}

function parseHardCap(text: string): ParsedCostGuardNaturalCommand | null {
  if (!hasAny(text, ['上限', 'hard cap', 'hard-cap', 'cap'])) return null;
  const value = extractNumber(text);
  if (!value) return null;

  const axis = detectAxis(text);
  if (!axis) return null;
  return { subcommand: 'set', restTokens: ['hard-cap', axis, value] };
}

function detectAxis(text: string): string | null {
  if (hasAny(text, ['外部api', '外部 api', 'external'])) return 'external-api-daily';
  if (hasAny(text, ['chat', 'チャット', '投稿数', '投稿'])) return 'chat-daily';
  if (hasAny(text, ['呼び数', '呼出数', '呼び出し数', 'calls'])) return 'month-calls';
  if (hasAny(text, ['月額', '月次', 'usd', 'ドル', '金額', '予算'])) return 'month-usd';
  return null;
}

function extractNumber(text: string): string | null {
  const m = text.match(/(\d+(?:\.\d+)?)/);
  return m?.[1] ?? null;
}

function extractDuration(text: string): string | null {
  const m = text.match(/(\d+)\s*(m|分|h|時間|d|日)/);
  if (!m) return null;
  const n = m[1]!;
  const unit = m[2]!;
  if (unit === '分' || unit === 'm') return `${n}m`;
  if (unit === '時間' || unit === 'h') return `${n}h`;
  return `${n}d`;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[　\s]+/g, ' ');
}

function hasAny(text: string, words: readonly string[]): boolean {
  return words.some((word) => text.includes(word));
}
