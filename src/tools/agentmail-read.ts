/**
 * AgentMail read-only custom tool.
 *
 * The agent never receives AgentMail credentials. This tool runs in the
 * Worker, reads only the configured default inbox, and returns bounded,
 * redacted message data back to the session.
 */

import { AgentMailClient, AgentMailError } from '../lib/agentmail-api';
import {
  extractDocxText,
  extractPptxText,
  extractXlsxText,
  isOfficeZipSafe,
  LEGACY_OFFICE_MIME,
  MAX_OFFICE_ATTACHMENT_BYTES,
  MAX_OFFICE_TEXT_CHARS,
  MAX_OFFICE_TOTAL_TEXT_CHARS,
  SUPPORTED_OFFICE_MIME,
} from '../lib/attachment-processing';
import { extractBody } from '../lib/email-thread';
import type { AgentMailMessage } from '../types/agentmail';
import {
  ToolSchemaError,
  rejectUnknownKeys,
  requirePositiveIntInRange,
} from './tool-common';

type AgentMailAttachment = Record<string, unknown> & {
  attachment_id?: string;
  attachmentId?: string;
  content_type?: string;
  contentType?: string;
  file_name?: string;
  filename?: string;
  id?: string;
  mime_type?: string;
  name?: string;
  size?: number;
};

const TOOL_NAME = 'agentmail_read';
const SEARCH_LIMIT_MAX = 20;
const GET_MAX_CHARS_DEFAULT = 4000;
const GET_MAX_CHARS_MAX = 12000;
const ATTACHMENT_TEXT_MAX_CHARS_DEFAULT = 60000;
const ATTACHMENT_TEXT_MAX_CHARS_MAX = 120000;
const ATTACHMENT_TEXT_COUNT_MAX = 10;

const KNOWN_KEYS = new Set([
  'action',
  'message_id',
  'thread_id',
  'from_contains',
  'subject_contains',
  'query',
  'after',
  'before',
  'labels',
  'page_token',
  'limit',
  'max_chars',
  'include_attachment_text',
  'max_attachment_chars',
  'include_spam',
  'include_blocked',
  'include_unauthenticated',
]);

export class AgentMailToolError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, options: { status?: number } = {}) {
    super(message);
    this.name = 'AgentMailToolError';
    this.code = code;
    this.status = options.status;
  }
}

export interface AgentMailReadDeps {
  apiKey?: string;
  inboxId?: string;
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
}

type Action = 'search' | 'get';

export async function agentmailRead(
  input: Record<string, unknown>,
  deps: AgentMailReadDeps,
): Promise<Record<string, unknown>> {
  rejectUnknownKeys(input, KNOWN_KEYS, TOOL_NAME);
  const action = parseAction(input.action);
  if (!deps.apiKey || !deps.inboxId) {
    throw new AgentMailToolError(
      'agentmail_unavailable',
      'AgentMail の取得に失敗しました。問題が続くようでしたら開発側に連絡します。',
    );
  }
  const client = new AgentMailClient(deps.apiKey, {
    ...(deps.apiBaseUrl ? { baseUrl: deps.apiBaseUrl } : {}),
    ...(deps.fetcher ? { fetchImpl: deps.fetcher } : {}),
  });

  try {
    if (action === 'search') return await searchMessages(input, deps.inboxId, client);
    return await getMessage(input, deps.inboxId, client);
  } catch (err) {
    if (err instanceof ToolSchemaError || err instanceof AgentMailToolError) throw err;
    if (err instanceof AgentMailError) {
      throw new AgentMailToolError(
        'agentmail_api',
        'AgentMail の取得に失敗しました。問題が続くようでしたら開発側に連絡します。',
        { status: err.status },
      );
    }
    throw err;
  }
}

async function searchMessages(
  input: Record<string, unknown>,
  inboxId: string,
  client: AgentMailClient,
): Promise<Record<string, unknown>> {
  const fromContains = optionalString(input.from_contains, 'from_contains');
  const subjectContains = optionalString(input.subject_contains, 'subject_contains');
  const query = optionalString(input.query, 'query');
  const after = optionalString(input.after, 'after');
  const before = optionalString(input.before, 'before');
  const labels = optionalStringArray(input.labels, 'labels');
  const pageToken = optionalString(input.page_token, 'page_token');
  const includeSpam = optionalBoolean(input.include_spam, 'include_spam', true);
  const includeBlocked = optionalBoolean(input.include_blocked, 'include_blocked');
  const includeUnauthenticated = optionalBoolean(
    input.include_unauthenticated,
    'include_unauthenticated',
  );

  const hasSelector =
    Boolean(fromContains) ||
    Boolean(subjectContains) ||
    Boolean(query) ||
    Boolean(after) ||
    Boolean(before) ||
    labels.length > 0;
  if (!hasSelector) {
    throw new ToolSchemaError(
      `${TOOL_NAME}: search requires at least one selector (from_contains, subject_contains, query, after, before, or labels)`,
    );
  }

  const limit = requirePositiveIntInRange(
    input.limit,
    'limit',
    TOOL_NAME,
    1,
    SEARCH_LIMIT_MAX,
    10,
  );
  const res = await client.listMessages(inboxId, {
    limit,
    ...(pageToken ? { pageToken } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(after ? { after } : {}),
    ...(before ? { before } : {}),
    includeSpam,
    includeBlocked,
    includeUnauthenticated,
  });

  const filtered = res.messages.filter((msg) =>
    matchesSearch(msg, { fromContains, subjectContains, query }),
  );
  return {
    action: 'search',
    count: filtered.length,
    truncated: Boolean(res.next_page_token),
    next_page_token: res.next_page_token ?? '',
    messages: filtered.map(summarizeMessage),
  };
}

async function getMessage(
  input: Record<string, unknown>,
  inboxId: string,
  client: AgentMailClient,
): Promise<Record<string, unknown>> {
  const messageId = optionalString(input.message_id, 'message_id');
  const threadId = optionalString(input.thread_id, 'thread_id');
  if (!messageId && !threadId) {
    throw new ToolSchemaError(`${TOOL_NAME}: get requires message_id or thread_id`);
  }
  const maxChars = requirePositiveIntInRange(
    input.max_chars,
    'max_chars',
    TOOL_NAME,
    1,
    GET_MAX_CHARS_MAX,
    GET_MAX_CHARS_DEFAULT,
  );
  const includeAttachmentText =
    input.include_attachment_text === undefined
      ? true
      : optionalBoolean(input.include_attachment_text, 'include_attachment_text');
  const maxAttachmentChars = requirePositiveIntInRange(
    input.max_attachment_chars,
    'max_attachment_chars',
    TOOL_NAME,
    1,
    ATTACHMENT_TEXT_MAX_CHARS_MAX,
    ATTACHMENT_TEXT_MAX_CHARS_DEFAULT,
  );
  let msg: AgentMailMessage;
  if (messageId) {
    try {
      msg = await client.getMessage(inboxId, messageId);
    } catch (err) {
      if (err instanceof AgentMailError && err.status === 404) {
        const bracketed = maybeBracketRfc822MessageId(messageId);
        if (bracketed && bracketed !== messageId) {
          try {
            msg = await client.getMessage(inboxId, bracketed);
            return await formatMessageForGet(
              msg,
              maxChars,
              includeAttachmentText ? { client, inboxId, maxAttachmentChars } : null,
            );
          } catch (retryErr) {
            if (
              (!(retryErr instanceof AgentMailError) || retryErr.status !== 404) &&
              !threadId &&
              !looksLikeThreadId(messageId)
            ) {
              throw retryErr;
            }
            // Fall through to thread fallback or the original 404.
          }
        }
      }
      if (
        !(err instanceof AgentMailError) ||
        err.status !== 404 ||
        (!threadId && !looksLikeThreadId(messageId))
      ) {
        throw err;
      }
      msg = await getMessageFromThread(input, inboxId, client, threadId || messageId);
    }
  } else {
    msg = await getMessageFromThread(input, inboxId, client, threadId);
  }
  return await formatMessageForGet(
    msg,
    maxChars,
    includeAttachmentText ? { client, inboxId, maxAttachmentChars } : null,
  );
}

async function getMessageFromThread(
  input: Record<string, unknown>,
  inboxId: string,
  client: AgentMailClient,
  threadId: string,
): Promise<AgentMailMessage> {
  const thread = await client.getThread(inboxId, threadId);
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  if (messages.length === 0) {
    throw new AgentMailToolError(
      'agentmail_thread_empty',
      'AgentMail の取得に失敗しました。問題が続くようでしたら開発側に連絡します。',
      { status: 404 },
    );
  }
  const fromContains = optionalString(input.from_contains, 'from_contains');
  const subjectContains = optionalString(input.subject_contains, 'subject_contains');
  const query = optionalString(input.query, 'query');
  const matching = messages.filter((msg) => matchesSearch(msg, { fromContains, subjectContains, query }));
  return matching.at(-1) ?? messages.at(-1)!;
}

async function formatMessageForGet(
  msg: AgentMailMessage,
  maxChars: number,
  attachmentOptions: {
    client: AgentMailClient;
    inboxId: string;
    maxAttachmentChars: number;
  } | null = null,
): Promise<Record<string, unknown>> {
  const rawBody = extractBody(msg);
  const redacted = redactSecrets(rawBody);
  const clipped = redacted.length > maxChars;
  const attachmentText = attachmentOptions
    ? await extractReadableAttachmentText(msg, attachmentOptions)
    : null;
  return {
    action: 'get',
    message: {
      ...summarizeMessage(msg),
      body: clipped ? redacted.slice(0, maxChars) : redacted,
      body_truncated: clipped,
      attachments: summarizeAttachments(msg),
      ...(attachmentText ? { attachment_text: attachmentText } : {}),
    },
  };
}

function parseAction(value: unknown): Action {
  if (value === undefined || value === null) return 'search';
  if (value === 'search' || value === 'get') return value;
  throw new ToolSchemaError(`${TOOL_NAME}: action must be 'search' or 'get'`);
}

function summarizeMessage(msg: AgentMailMessage): Record<string, unknown> {
  const id = firstNonEmptyString(msg.id, msg.message_id);
  return {
    id,
    message_id: firstNonEmptyString(msg.message_id, msg.id),
    thread_id: stringField(msg.thread_id),
    from: stringField(msg.from),
    to: arrayField(msg.to),
    cc: arrayField(msg.cc),
    subject: stringField(msg.subject),
    received_at: firstNonEmptyString(msg.received_at, msg.timestamp, msg.created_at),
    labels: arrayField(msg.labels),
  };
}

function summarizeAttachments(msg: AgentMailMessage): Array<Record<string, unknown>> {
  const raw = msg.attachments;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => {
      const id = stringField(item.attachment_id ?? item.id ?? item.attachmentId);
      return {
        ...(id ? { id } : {}),
        filename: stringField(item.filename ?? item.name),
        content_type: stringField(item.content_type ?? item.mime_type),
        size: typeof item.size === 'number' ? item.size : null,
      };
    });
}

async function extractReadableAttachmentText(
  msg: AgentMailMessage,
  options: {
    client: AgentMailClient;
    inboxId: string;
    maxAttachmentChars: number;
  },
): Promise<{
  items: Array<Record<string, unknown>>;
  notice: string | null;
  truncated: boolean;
}> {
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const messageId = attachmentMessageId(msg);
  const items: Array<Record<string, unknown>> = [];
  const noticeParts: string[] = [];
  let totalChars = 0;
  let truncated = false;
  let unsupported = 0;
  let legacy = 0;
  let missingId = 0;
  let sizeOver = 0;
  let unsafeZip = 0;
  let downloadFailed = 0;
  let extractFailed = 0;
  let countOverflow = 0;
  let totalOverflow = 0;

  if (!messageId && attachments.length > 0) {
    return {
      items,
      notice: '添付ファイルはありますが、AgentMail message id が無いため本体を取得できませんでした。',
      truncated: false,
    };
  }

  for (const att of attachments) {
    const ctype = attachmentContentType(att).toLowerCase();
    const filename = attachmentName(att);
    const attachmentId = attachmentIdValue(att);
    if (LEGACY_OFFICE_MIME.includes(ctype)) {
      legacy += 1;
      continue;
    }
    if (!SUPPORTED_OFFICE_MIME.includes(ctype)) {
      unsupported += 1;
      continue;
    }
    if (items.length >= ATTACHMENT_TEXT_COUNT_MAX) {
      countOverflow += 1;
      continue;
    }
    if (!attachmentId) {
      missingId += 1;
      continue;
    }
    if (typeof att.size === 'number' && att.size > MAX_OFFICE_ATTACHMENT_BYTES) {
      sizeOver += 1;
      continue;
    }
    const remainingBudget = Math.min(
      options.maxAttachmentChars - totalChars,
      MAX_OFFICE_TOTAL_TEXT_CHARS - totalChars,
      MAX_OFFICE_TEXT_CHARS,
    );
    if (remainingBudget <= 0) {
      totalOverflow += 1;
      truncated = true;
      continue;
    }

    let data: Uint8Array;
    try {
      data = await options.client.getMessageAttachment(
        options.inboxId,
        messageId,
        attachmentId,
        { maxBytes: MAX_OFFICE_ATTACHMENT_BYTES },
      );
    } catch {
      downloadFailed += 1;
      continue;
    }
    if (data.byteLength > MAX_OFFICE_ATTACHMENT_BYTES) {
      sizeOver += 1;
      continue;
    }

    const zipCheck = isOfficeZipSafe(data);
    if (!zipCheck.safe) {
      unsafeZip += 1;
      continue;
    }

    let extracted: { text: string; truncated: boolean };
    try {
      extracted = extractOfficeAttachmentText(ctype, data, remainingBudget);
    } catch {
      extractFailed += 1;
      continue;
    }
    const redacted = redactSecrets(extracted.text);
    const itemTruncated = extracted.truncated || redacted.length > remainingBudget;
    const text = redacted.length > remainingBudget
      ? redacted.slice(0, remainingBudget)
      : redacted;
    if (itemTruncated) truncated = true;
    totalChars += text.length;
    items.push({
      id: attachmentId,
      filename,
      content_type: ctype,
      text,
      truncated: itemTruncated,
    });
  }

  if (legacy > 0) noticeParts.push(`旧Office形式 ${legacy} 件は未対応です`);
  if (unsupported > 0) noticeParts.push(`Office以外または非対応添付 ${unsupported} 件は本文抽出対象外です`);
  if (missingId > 0) noticeParts.push(`添付IDなし ${missingId} 件は取得できませんでした`);
  if (sizeOver > 0) noticeParts.push(`サイズ上限超過 ${sizeOver} 件は取得しませんでした`);
  if (unsafeZip > 0) noticeParts.push(`安全性検査で拒否 ${unsafeZip} 件`);
  if (downloadFailed > 0) noticeParts.push(`取得失敗 ${downloadFailed} 件`);
  if (extractFailed > 0) noticeParts.push(`抽出失敗 ${extractFailed} 件`);
  if (countOverflow > 0) noticeParts.push(`件数上限超過 ${countOverflow} 件はスキップ`);
  if (totalOverflow > 0) noticeParts.push(`文字数上限超過 ${totalOverflow} 件はスキップ`);

  return {
    items,
    notice: noticeParts.length > 0 ? noticeParts.join(' / ') : null,
    truncated,
  };
}

function extractOfficeAttachmentText(
  ctype: string,
  data: Uint8Array,
  charLimit: number,
): { text: string; truncated: boolean } {
  if (
    ctype ===
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return extractDocxText(data, charLimit);
  }
  if (
    ctype ===
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return extractXlsxText(data, charLimit);
  }
  if (
    ctype ===
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return extractPptxText(data, charLimit);
  }
  throw new Error(`unsupported_office_attachment:${ctype}`);
}

function attachmentMessageId(msg: AgentMailMessage): string {
  return firstNonEmptyString(msg.id, msg.message_id, msg.rfc822_message_id);
}

function attachmentIdValue(attachment: AgentMailAttachment): string {
  return firstNonEmptyString(
    attachment.attachment_id,
    attachment.id,
    attachment.attachmentId,
  );
}

function attachmentName(attachment: AgentMailAttachment): string {
  return firstNonEmptyString(
    attachment.filename,
    attachment.name,
    attachment.file_name,
  );
}

function attachmentContentType(attachment: AgentMailAttachment): string {
  return firstNonEmptyString(
    attachment.content_type,
    attachment.mime_type,
    attachment.contentType,
  );
}

function matchesSearch(
  msg: AgentMailMessage,
  opts: { fromContains: string; subjectContains: string; query: string },
): boolean {
  if (opts.fromContains && !stringField(msg.from).toLowerCase().includes(opts.fromContains.toLowerCase())) {
    return false;
  }
  if (
    opts.subjectContains &&
    !stringField(msg.subject).toLowerCase().includes(opts.subjectContains.toLowerCase())
  ) {
    return false;
  }
  if (opts.query) {
    const haystack = [
      stringField(msg.from),
      stringField(msg.subject),
      stringField(msg.received_at),
      ...arrayField(msg.labels),
    ].join('\n').toLowerCase();
    if (!haystack.includes(opts.query.toLowerCase())) return false;
  }
  return true;
}

function optionalString(value: unknown, fieldName: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new ToolSchemaError(`${TOOL_NAME}: ${fieldName} must be string`);
  }
  return value.trim();
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const str = stringField(value);
    if (str) return str;
  }
  return '';
}

function looksLikeThreadId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function maybeBracketRfc822MessageId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('<') || trimmed.endsWith('>')) return trimmed;
  if (!/^[^@\s<>]+@[^@\s<>]+$/.test(trimmed)) return '';
  return `<${trimmed}>`;
}

function optionalStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new ToolSchemaError(`${TOOL_NAME}: ${fieldName} must be string[]`);
  }
  return value.map((v) => v.trim()).filter((v) => v.length > 0);
}

function optionalBoolean(value: unknown, fieldName: string, defaultValue = false): boolean {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new ToolSchemaError(`${TOOL_NAME}: ${fieldName} must be boolean`);
  }
  return value;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function arrayField(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function redactSecrets(text: string): string {
  return text
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[REDACTED_SECRET]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED_SECRET]')
    .replace(/((?:password|passwd|api[_ -]?key|secret|token)\s*[:=]\s*)[^\s]+/gi, '$1[REDACTED_SECRET]');
}
