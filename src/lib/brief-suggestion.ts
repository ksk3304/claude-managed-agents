import type { D1Database } from '@cloudflare/workers-types';

export const BRIEF_SUGGESTION_PREFIX = 'BRIEF_SUGGESTION:';
export const BRIEF_SKIP_MARKER = '===BRIEF_SKIP===';
export const DEFAULT_BRIEF_TENANT_ID = 'makoto-prime';

export interface BriefSuggestionItem {
  rank: number;
  taskKey: string;
  taskTitle: string;
  supportAction: string;
  promisedOutcome: string;
  urgencyNote?: string;
}

export interface ParsedBriefSuggestion {
  items: BriefSuggestionItem[];
  raw: string;
}

export interface BriefSuggestionParseFailure {
  raw: string;
  reason: string;
}

export interface BriefSuggestionParseResult {
  suggestions: ParsedBriefSuggestion[];
  failures: BriefSuggestionParseFailure[];
  cleanedText: string;
}

export interface StoredBriefSuggestion {
  suggestion_id: string;
  tenant_id: string;
  user_slug: string;
  date_label: string;
  job_id: string;
  event_key: string;
  suggestion_rank: number;
  task_key: string;
  task_title: string;
  support_action: string;
  promised_outcome: string;
  urgency_note: string | null;
  visible_text: string | null;
  created_at_ms: number;
  expires_at_ms: number;
  status: string;
}

interface BriefSuggestionSpan {
  start: number;
  end: number;
  raw: string;
  json: string;
}

export function parseBriefSuggestionMarkers(text: string): BriefSuggestionParseResult {
  const spans = extractBriefSuggestionSpans(text);
  const suggestions: ParsedBriefSuggestion[] = [];
  const failures: BriefSuggestionParseFailure[] = [];
  for (const span of spans) {
    try {
      suggestions.push({
        raw: span.raw,
        items: normalizePayload(JSON.parse(span.json)),
      });
    } catch (error) {
      failures.push({
        raw: span.raw,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const cleanedText = removeSpans(text, spans).replace(/\n{3,}/g, '\n\n').trim();
  return { suggestions, failures, cleanedText };
}

export function stripBriefSkipMarker(text: string): { text: string; skip: boolean } {
  if (!text.includes(BRIEF_SKIP_MARKER)) return { text, skip: false };
  return { text: text.replaceAll(BRIEF_SKIP_MARKER, '').trim(), skip: true };
}

export function isBriefSuggestionFollowup(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\s+/g, '');
  return (
    /^(じゃあ|では)お願い(します)?[。.!！]*$/.test(normalized) ||
    /^(それ|この件|提案の件|今朝の件|朝の件)お願い(します)?[。.!！]*$/.test(normalized)
  );
}

export function isFullBriefRequest(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  return (
    normalized === '今日のブリーフ' ||
    normalized === '今日の予定とtodo見せて' ||
    normalized === '全体ブリーフ'
  );
}

export function buildBriefSuggestionFollowupContext(row: StoredBriefSuggestion): string {
  return [
    '<brief_suggestion_context>',
    'ユーザーの「じゃあお願い」は、今日の定期提案で保存済みの次の案件を指す。',
    `task: ${row.task_title}`,
    `can_do: ${row.support_action}`,
    `promised_goal: ${row.promised_outcome}`,
    row.urgency_note ? `urgency_note: ${row.urgency_note}` : '',
    'この期待値を満たすように、すぐ支援に入る。内部保存先やマーカー名は言わない。',
    '</brief_suggestion_context>',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildFullBriefRequestContext(): string {
  return [
    '<full_brief_request>',
    'ユーザーは全体ブリーフを明示的に求めている。',
    '今日の予定、TODO、未完了の重要案件、MAKOTOくんが手伝えることを要約版で返す。',
    '長くなりすぎる場合は要約を先に出し、詳細は「詳しく」で展開できる形にする。',
    '定期通知の短文一手提案ルールではなく、ユーザー明示リクエストとして全体を扱う。',
    '</full_brief_request>',
  ].join('\n');
}

export async function storeBriefSuggestions(
  db: D1Database,
  input: {
    tenantId?: string;
    userSlug: string;
    eventKey: string;
    jobId: string;
    dateLabel: string;
    createdAtMs: number;
    expiresAtMs: number;
    visibleText: string;
    suggestions: ParsedBriefSuggestion[];
  },
): Promise<number> {
  const tenantId = input.tenantId ?? DEFAULT_BRIEF_TENANT_ID;
  let count = 0;
  for (const suggestion of input.suggestions) {
    for (const item of suggestion.items) {
      const suggestionId = `${input.eventKey}:${item.rank}`;
      await db
        .prepare(
          `INSERT OR REPLACE INTO brief_suggestions
             (suggestion_id, tenant_id, user_slug, date_label, job_id, event_key,
              suggestion_rank, task_key, task_title, support_action, promised_outcome,
              urgency_note, visible_text, raw_json, status, created_at_ms, expires_at_ms)
           VALUES
             (?1, ?2, ?3, ?4, ?5, ?6,
              ?7, ?8, ?9, ?10, ?11,
              ?12, ?13, ?14, 'active', ?15, ?16)`,
        )
        .bind(
          suggestionId,
          tenantId,
          input.userSlug,
          input.dateLabel,
          input.jobId,
          input.eventKey,
          item.rank,
          item.taskKey,
          item.taskTitle,
          item.supportAction,
          item.promisedOutcome,
          item.urgencyNote ?? null,
          input.visibleText.slice(0, 2000),
          suggestion.raw,
          input.createdAtMs,
          input.expiresAtMs,
        )
        .run();
      count += 1;
    }
  }
  return count;
}

export async function readLatestBriefSuggestion(
  db: D1Database,
  input: {
    tenantId?: string;
    userSlug: string;
    nowMs: number;
  },
): Promise<StoredBriefSuggestion | null> {
  return await db
    .prepare(
      `SELECT suggestion_id, tenant_id, user_slug, date_label, job_id, event_key,
              suggestion_rank, task_key, task_title, support_action, promised_outcome,
              urgency_note, visible_text, created_at_ms, expires_at_ms, status
         FROM brief_suggestions
        WHERE tenant_id = ?1
          AND user_slug = ?2
          AND status = 'active'
          AND expires_at_ms > ?3
        ORDER BY created_at_ms DESC, suggestion_rank ASC
        LIMIT 1`,
    )
    .bind(input.tenantId ?? DEFAULT_BRIEF_TENANT_ID, input.userSlug, input.nowMs)
    .first<StoredBriefSuggestion>();
}

export function briefJobIdFromEventKey(eventKey: string): string {
  const match = eventKey.match(/^scheduled:([^:]+):/);
  return match?.[1] ?? 'unknown';
}

export function briefDateLabelFromEventKey(eventKey: string, nowMs: number): string {
  const match = eventKey.match(/^scheduled:[^:]+:(\d{4}-\d{2}-\d{2}):/);
  return match?.[1] ?? jstDateLabel(nowMs);
}

export function briefExpiresAtMs(dateLabel: string): number {
  const match = dateLabel.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return Date.now() + 24 * 60 * 60 * 1000;
  const [, y, m, d] = match;
  return Date.UTC(Number(y), Number(m) - 1, Number(d) + 1) - 9 * 60 * 60 * 1000;
}

function normalizePayload(payload: unknown): BriefSuggestionItem[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('BRIEF_SUGGESTION payload must be an object');
  }
  const obj = payload as Record<string, unknown>;
  const rawItems = Array.isArray(obj.items) ? obj.items : [obj];
  if (rawItems.length === 0 || rawItems.length > 2) {
    throw new Error('BRIEF_SUGGESTION items must contain 1 or 2 suggestions');
  }
  return rawItems.map((raw, index) => normalizeItem(raw, index + 1));
}

function normalizeItem(raw: unknown, defaultRank: number): BriefSuggestionItem {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('BRIEF_SUGGESTION item must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const taskTitle = nonEmptyString(obj.task_title, 'task_title');
  const supportAction = nonEmptyString(obj.support_action, 'support_action');
  const promisedOutcome = nonEmptyString(obj.promised_outcome, 'promised_outcome');
  const taskKey =
    typeof obj.task_key === 'string' && obj.task_key.trim()
      ? obj.task_key.trim()
      : stableTaskKey(taskTitle);
  const rank =
    typeof obj.rank === 'number' && Number.isFinite(obj.rank) && obj.rank > 0
      ? Math.floor(obj.rank)
      : defaultRank;
  const urgencyNote =
    typeof obj.urgency_note === 'string' && obj.urgency_note.trim()
      ? obj.urgency_note.trim()
      : undefined;
  return {
    rank,
    taskKey,
    taskTitle,
    supportAction,
    promisedOutcome,
    ...(urgencyNote ? { urgencyNote } : {}),
  };
}

function extractBriefSuggestionSpans(text: string): BriefSuggestionSpan[] {
  const spans: BriefSuggestionSpan[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const prefixAt = text.indexOf(BRIEF_SUGGESTION_PREFIX, searchFrom);
    if (prefixAt === -1) break;
    let jsonStart = prefixAt + BRIEF_SUGGESTION_PREFIX.length;
    while (text[jsonStart] === ' ' || text[jsonStart] === '\t') jsonStart += 1;
    if (text[jsonStart] !== '{') {
      searchFrom = prefixAt + BRIEF_SUGGESTION_PREFIX.length;
      continue;
    }
    const jsonEnd = findBalancedJsonObjectEnd(text, jsonStart);
    const end = jsonEnd === -1 ? lineEnd(text, jsonStart) : jsonEnd + 1;
    spans.push({
      start: prefixAt,
      end,
      raw: text.slice(prefixAt, end),
      json: text.slice(jsonStart, end),
    });
    searchFrom = end;
  }
  return spans;
}

function findBalancedJsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineEnd(text: string, start: number): number {
  const idx = text.indexOf('\n', start);
  return idx === -1 ? text.length : idx;
}

function removeSpans(text: string, spans: BriefSuggestionSpan[]): string {
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start);
    cursor = span.end;
  }
  out += text.slice(cursor);
  return out;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`BRIEF_SUGGESTION.${field} must be a non-empty string`);
  }
  return value.trim();
}

function stableTaskKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `task_${(hash >>> 0).toString(16)}`;
}

function jstDateLabel(nowMs: number): string {
  const shifted = new Date(nowMs + 9 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
