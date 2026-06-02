import {
  ANTHROPIC_VERSION,
  resolveAnthropicApiKey,
  resolveAnthropicBaseURL,
} from '../anthropic';
import { assertBridgeEgressAllowed } from './egress-guard';
import {
  driveUploadBinaryFile,
  type DriveToolDeps,
  type DriveCreateFileResult,
} from '../tools/drive';

const ANTHROPIC_FILES_BETA = 'files-api-2025-04-14,managed-agents-2026-04-01';
const SESSION_OUTPUT_PATH_RE = /\/mnt\/session\/outputs\/([^\s"'<>),\]]+)/g;
const ARTIFACT_FILENAME_HINT_RE = /\b[^\s"'<>),\]]+\.(xlsx|xlsm|docx|pptx|pdf|csv|tsv)\b/i;
const MAX_UPLOAD_FILES = 5;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  '.xlsx',
  '.xlsm',
  '.docx',
  '.pptx',
  '.pdf',
  '.csv',
  '.tsv',
]);

const ALLOWED_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/pdf',
  'text/csv',
  'text/tab-separated-values',
]);

interface AnthropicSessionFile {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  downloadable?: boolean;
  created_at?: string;
  scope?: { id?: string; type?: string } | null;
}

export interface SessionOutputDeliveryResult {
  text: string;
  uploaded: Array<{ filename: string; webViewLink: string; id?: string }>;
  failures: Array<{ filename: string; reason: string }>;
  skipped: Array<{ filename: string; reason: string }>;
  sanitizedPathCount: number;
}

export interface DeliverSessionOutputsInput {
  env: Env;
  sessionId: string;
  sourceText: string;
  artifactHintText?: string;
  minCreatedAtMs: number;
  eventKey: string;
  resolveDriveDeps: () => Promise<DriveToolDeps>;
  fetcher?: typeof fetch;
}

export async function deliverSessionOutputsToDrive(
  input: DeliverSessionOutputsInput,
): Promise<SessionOutputDeliveryResult> {
  const sanitized = sanitizeSessionOutputPaths(input.sourceText);
  const base: SessionOutputDeliveryResult = {
    text: sanitized.text,
    uploaded: [],
    failures: [],
    skipped: [],
    sanitizedPathCount: sanitized.count,
  };
  const hintText = `${input.sourceText}\n${input.artifactHintText ?? ''}`;
  if (sanitized.count === 0 && !ARTIFACT_FILENAME_HINT_RE.test(hintText)) {
    return base;
  }

  const apiKey = resolveAnthropicApiKey(input.env);
  if (!apiKey) {
    if (sanitized.count > 0) {
      base.failures.push({ filename: 'session outputs', reason: 'anthropic_api_key_missing' });
      base.text = appendNotice(base.text, buildNotice(base));
    }
    return base;
  }

  let files: AnthropicSessionFile[];
  try {
    files = await listSessionFiles(input.env, input.sessionId, input.fetcher);
  } catch (err) {
    if (sanitized.count > 0) {
      base.failures.push({
        filename: 'session outputs',
        reason: err instanceof Error ? err.message : String(err),
      });
      base.text = appendNotice(base.text, buildNotice(base));
    }
    return base;
  }

  const eligible = selectEligibleFiles(files, input.sessionId, input.minCreatedAtMs);
  base.skipped.push(...eligible.skipped);
  if (eligible.files.length === 0) return base;

  let driveDeps: DriveToolDeps;
  try {
    driveDeps = await input.resolveDriveDeps();
  } catch (err) {
    for (const f of eligible.files) {
      base.failures.push({
        filename: f.filename,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    base.text = appendNotice(base.text, buildNotice(base));
    return base;
  }

  for (const f of eligible.files) {
    try {
      const bytes = await downloadSessionFile(input.env, f.id, input.fetcher);
      const uploaded = await driveUploadBinaryFile(
        { name: f.filename, content: bytes, mimeType: f.mime_type },
        driveDeps,
      );
      base.uploaded.push(formatUploadedFile(f.filename, uploaded));
    } catch (err) {
      base.failures.push({
        filename: f.filename,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  base.text = appendNotice(base.text, buildNotice(base));
  return base;
}

export function sanitizeSessionOutputPaths(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(SESSION_OUTPUT_PATH_RE, (_match, filename: string) => {
    count += 1;
    return filename;
  });
  return { text: out, count };
}

function selectEligibleFiles(
  files: AnthropicSessionFile[],
  sessionId: string,
  minCreatedAtMs: number,
): { files: AnthropicSessionFile[]; skipped: Array<{ filename: string; reason: string }> } {
  const selected: AnthropicSessionFile[] = [];
  const skipped: Array<{ filename: string; reason: string }> = [];
  let totalBytes = 0;

  for (const f of files) {
    const filename = f.filename || f.id;
    if (f.scope && (f.scope.type !== 'session' || f.scope.id !== sessionId)) {
      skipped.push({ filename, reason: 'different_scope' });
      continue;
    }
    if (f.downloadable !== true) {
      skipped.push({ filename, reason: 'not_downloadable' });
      continue;
    }
    const createdAtMs = Date.parse(f.created_at ?? '');
    if (Number.isFinite(createdAtMs) && createdAtMs < minCreatedAtMs) {
      skipped.push({ filename, reason: 'older_than_turn' });
      continue;
    }
    if (!isAllowedArtifact(f)) {
      skipped.push({ filename, reason: 'unsupported_type' });
      continue;
    }
    if (f.size_bytes > MAX_FILE_BYTES) {
      skipped.push({ filename, reason: 'file_too_large' });
      continue;
    }
    if (selected.length >= MAX_UPLOAD_FILES) {
      skipped.push({ filename, reason: 'too_many_files' });
      continue;
    }
    if (totalBytes + f.size_bytes > MAX_TOTAL_BYTES) {
      skipped.push({ filename, reason: 'total_too_large' });
      continue;
    }
    selected.push(f);
    totalBytes += f.size_bytes;
  }

  return { files: selected, skipped };
}

async function listSessionFiles(
  env: Env,
  sessionId: string,
  fetcher: typeof fetch = fetch,
): Promise<AnthropicSessionFile[]> {
  const params = new URLSearchParams({ scope_id: sessionId, limit: '20' });
  const url = `${resolveAnthropicBaseURL(env)}/v1/files?${params.toString()}`;
  assertBridgeEgressAllowed(url, 'session-output-files:list');
  const resp = await fetcher(url, {
    method: 'GET',
    headers: anthropicFilesHeaders(env),
  });
  if (!resp.ok) {
    throw new Error(`files_list_http_${resp.status}`);
  }
  const body = (await resp.json()) as { data?: unknown[] };
  return Array.isArray(body.data) ? body.data.filter(isAnthropicSessionFile) : [];
}

async function downloadSessionFile(
  env: Env,
  fileId: string,
  fetcher: typeof fetch = fetch,
): Promise<ArrayBuffer> {
  const url = `${resolveAnthropicBaseURL(env)}/v1/files/${encodeURIComponent(fileId)}/content`;
  assertBridgeEgressAllowed(url, 'session-output-files:download');
  const resp = await fetcher(url, {
    method: 'GET',
    headers: anthropicFilesHeaders(env),
  });
  if (!resp.ok) {
    throw new Error(`files_download_http_${resp.status}`);
  }
  return await resp.arrayBuffer();
}

function anthropicFilesHeaders(env: Env): Record<string, string> {
  return {
    'x-api-key': resolveAnthropicApiKey(env),
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': ANTHROPIC_FILES_BETA,
  };
}

function isAnthropicSessionFile(v: unknown): v is AnthropicSessionFile {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.filename === 'string' &&
    typeof o.mime_type === 'string' &&
    typeof o.size_bytes === 'number'
  );
}

function isAllowedArtifact(f: AnthropicSessionFile): boolean {
  if (ALLOWED_MIME_TYPES.has(f.mime_type)) return true;
  const lower = f.filename.toLowerCase();
  for (const ext of ALLOWED_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function formatUploadedFile(
  filename: string,
  uploaded: DriveCreateFileResult,
): { filename: string; webViewLink: string; id?: string } {
  const id = typeof uploaded.id === 'string' ? uploaded.id : undefined;
  const webViewLink =
    typeof uploaded.webViewLink === 'string'
      ? uploaded.webViewLink
      : id
        ? `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`
        : '';
  return {
    filename,
    webViewLink,
    ...(id ? { id } : {}),
  };
}

function buildNotice(result: SessionOutputDeliveryResult): string {
  const lines: string[] = [];
  if (result.uploaded.length > 0) {
    lines.push('*Driveに保存しました*');
    for (const f of result.uploaded) {
      lines.push(`- ${f.filename}: ${f.webViewLink}`);
    }
  }
  if (result.failures.length > 0) {
    lines.push(
      'ファイル生成は完了しましたが、Drive保存に失敗したものがあります。問題が続くようでしたら開発側で確認します。',
    );
  }
  return lines.join('\n');
}

function appendNotice(text: string, notice: string): string {
  if (!notice) return text;
  return `${text.trim()}\n\n${notice}`.trim();
}
