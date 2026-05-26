/**
 * Google Drive custom tools for the MAKOTO bridge.
 *
 * Each `drive*` function is a pure TS port of the matching `_exec_drive_*`
 * in `scripts/cma_lib.py`. We keep the functions stateless and pass
 * dependencies through `DriveToolDeps` so the layer-7 dispatcher can
 * wire in:
 *
 *   - the per-user access token resolved via `workspace-oauth.ts`,
 *   - a `refreshAccessToken` callback the wrapper uses on a 401,
 *   - the confirm-token store (KV-backed) for the destructive 2-step
 *     `drive_delete` flow,
 *   - the inbound RFC 822 Message-ID as `boundMessageId` so Issue #126
 *     (same-inbound-message confirmation skip) is enforced.
 *
 * `drive_create_file` is the TS port of Python's `_exec_drive_create_file`
 * — same multipart-upload contract; tool name matches Python's
 * `DRIVE_CREATE_FILE_TOOL_DEF` (`scripts/cma_lib.py:1727`).
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 8 — 層 6)
 * Source: `scripts/cma_lib.py:799-1396` (drive helpers + 5 _exec_drive_*).
 */

import {
  GoogleApiToolError,
  ToolSchemaError,
  googleApiFetch,
  rejectUnknownKeys,
  redactTokenLike,
  requireNonEmptyString,
  requirePositiveIntInRange,
  safeErrorSnippet,
  sha256Hex,
  truncateChars,
  utf8ByteLength,
  validateDriveFileId,
  type ConfirmTokenStore,
  type Fetcher,
  type GoogleApiFetchOptions,
} from './tool-common';

export const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API_BASE = 'https://www.googleapis.com/upload/drive/v3';

/** Deps shared by all 5 Drive tools. The dispatcher provides these. */
export interface DriveToolDeps {
  accessToken: string;
  refreshAccessToken?: () => Promise<string>;
  fetcher?: Fetcher;
  /** Required only for `driveDelete`. */
  confirmTokenStore?: ConfirmTokenStore;
  /** Inbound RFC 822 Message-ID — only meaningful for `driveDelete` (Issue #126). */
  boundMessageId?: string;
}

function fetchOpts(deps: DriveToolDeps): GoogleApiFetchOptions {
  const opts: GoogleApiFetchOptions = { accessToken: deps.accessToken };
  if (deps.refreshAccessToken) opts.refreshAccessToken = deps.refreshAccessToken;
  if (deps.fetcher) opts.fetcher = deps.fetcher;
  return opts;
}

// ============================================================================
// 1. drive_search
// ============================================================================

const DRIVE_SEARCH_KNOWN_KEYS = new Set([
  'query',
  'page_size',
  'order_by',
  'corpora',
]);

const DRIVE_SEARCH_FIELDS =
  'nextPageToken, files(id,name,mimeType,modifiedTime,owners(emailAddress),parents,webViewLink)';
const DRIVE_SEARCH_DEFAULT_PAGE_SIZE = 20;
const DRIVE_SEARCH_MAX_PAGE_SIZE = 50;
const DRIVE_SEARCH_VALID_CORPORA = new Set(['user', 'allDrives']);

export interface DriveSearchResult {
  files: unknown[];
  next_page_token: string | null;
  truncated_to: number;
}

/**
 * Search Drive with the agent's `q` expression. `trashed=false` is
 * always appended so trashed files never surface through this tool
 * (the agent has no concept of "trash recovery" — that's a separate
 * flow under `drive_restore` which we do not expose).
 *
 * `includeItemsFromAllDrives=true` + `supportsAllDrives=true` are
 * always set (Issue #183 — shared drives must be searchable even when
 * `corpora=user`, because some inboxes share business docs from the
 * org's shared drives).
 */
export async function driveSearch(
  input: Record<string, unknown>,
  deps: DriveToolDeps,
): Promise<DriveSearchResult> {
  rejectUnknownKeys(input, DRIVE_SEARCH_KNOWN_KEYS, 'drive_search');

  const query = requireNonEmptyString(input.query, 'query', 'drive_search');
  const pageSize = requirePositiveIntInRange(
    input.page_size,
    'page_size',
    'drive_search',
    1,
    DRIVE_SEARCH_MAX_PAGE_SIZE,
    DRIVE_SEARCH_DEFAULT_PAGE_SIZE,
  );
  const orderBy =
    typeof input.order_by === 'string' && input.order_by.length > 0
      ? input.order_by
      : 'modifiedTime desc';
  const corpora =
    typeof input.corpora === 'string' && input.corpora.length > 0
      ? input.corpora
      : 'user';
  if (!DRIVE_SEARCH_VALID_CORPORA.has(corpora)) {
    throw new ToolSchemaError(
      "drive_search: corpora must be 'user' or 'allDrives'",
    );
  }

  const params = new URLSearchParams({
    q: `(${query}) and trashed=false`,
    pageSize: String(pageSize),
    orderBy,
    fields: DRIVE_SEARCH_FIELDS,
    corpora,
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
  });
  const url = `${DRIVE_API_BASE}/files?${params.toString()}`;
  const resp = await googleApiFetch(url, { method: 'GET' }, fetchOpts(deps));
  if (!resp.ok) {
    const snippet = await safeErrorSnippet(resp);
    throw new GoogleApiToolError(
      `drive_search HTTP ${resp.status}: ${snippet}`,
      { status: resp.status, bodySnippet: snippet },
    );
  }
  const body = (await resp.json()) as {
    files?: unknown[];
    nextPageToken?: string;
  };
  return {
    files: Array.isArray(body.files) ? body.files : [],
    next_page_token: typeof body.nextPageToken === 'string' ? body.nextPageToken : null,
    truncated_to: pageSize,
  };
}

// ============================================================================
// 2. drive_get_file_metadata
// ============================================================================

const DRIVE_GET_METADATA_KNOWN_KEYS = new Set(['file_id', 'fields']);

const DRIVE_METADATA_FIELDS_WHITELIST = new Set([
  'id',
  'name',
  'mimeType',
  'modifiedTime',
  'createdTime',
  'size',
  'owners',
  'parents',
  'webViewLink',
  'description',
  'starred',
  'shared',
  'trashed',
  'viewedByMeTime',
  'iconLink',
  'thumbnailLink',
]);

const DRIVE_METADATA_DEFAULT_FIELDS =
  'id,name,mimeType,modifiedTime,createdTime,size,owners,parents,webViewLink,description';

export async function driveGetFileMetadata(
  input: Record<string, unknown>,
  deps: DriveToolDeps,
): Promise<Record<string, unknown>> {
  rejectUnknownKeys(input, DRIVE_GET_METADATA_KNOWN_KEYS, 'drive_get_file_metadata');
  const fileId = validateDriveFileId(input.file_id, 'drive_get_file_metadata');
  const fields = filterMetadataFields(input.fields);

  const params = new URLSearchParams({
    fields,
    supportsAllDrives: 'true',
  });
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${params.toString()}`;
  const resp = await googleApiFetch(url, { method: 'GET' }, fetchOpts(deps));
  if (resp.status === 404) {
    throw new GoogleApiToolError(
      `drive_get_file_metadata not_found: file_id=${fileId}`,
      { status: 404 },
    );
  }
  if (!resp.ok) {
    const snippet = await safeErrorSnippet(resp);
    throw new GoogleApiToolError(
      `drive_get_file_metadata HTTP ${resp.status}: ${snippet}`,
      { status: resp.status, bodySnippet: snippet },
    );
  }
  return (await resp.json()) as Record<string, unknown>;
}

function filterMetadataFields(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return DRIVE_METADATA_DEFAULT_FIELDS;
  }
  const filtered = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && DRIVE_METADATA_FIELDS_WHITELIST.has(s));
  return filtered.length > 0 ? filtered.join(',') : DRIVE_METADATA_DEFAULT_FIELDS;
}

// ============================================================================
// 3. drive_read_export
// ============================================================================

const DRIVE_READ_EXPORT_KNOWN_KEYS = new Set(['file_id', 'format', 'max_chars']);
const DRIVE_READ_EXPORT_VALID_FORMATS = new Set(['text', 'markdown', 'html']);
const DRIVE_READ_EXPORT_DEFAULT_MAX = 100_000;
const DRIVE_READ_EXPORT_MAX_CAP = 200_000;

const DRIVE_BINARY_PREFIXES = ['image/', 'video/', 'audio/', 'application/pdf'];

const DRIVE_EXPORT_FORMATS: Record<string, Record<string, string>> = {
  text: {
    'application/vnd.google-apps.document': 'text/plain',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
    'application/vnd.google-apps.presentation': 'text/plain',
  },
  markdown: {
    'application/vnd.google-apps.document': 'text/markdown',
  },
  html: {
    'application/vnd.google-apps.document': 'text/html',
    'application/vnd.google-apps.spreadsheet': 'text/html',
    'application/vnd.google-apps.presentation': 'text/html',
  },
};

export interface DriveReadExportResult {
  file_id: string;
  name: string;
  mimeType: string;
  exported_mime: string;
  content: string;
  truncated: boolean;
  byte_size: number;
}

/**
 * Read a Drive file's content. Three branches:
 *   - Binary MIME → reject (`drive_read_export binary not supported`).
 *   - Google-native MIME (Docs/Sheets/Slides) → `/export?mimeType=…`
 *     where the export MIME is chosen from `DRIVE_EXPORT_FORMATS`
 *     based on the requested `format`.
 *   - Anything else → `?alt=media`, return raw UTF-8.
 *
 * `byte_size` is always the *original* UTF-8 byte count (before
 * truncation), so the agent can tell whether the doc would have
 * exceeded `max_chars`.
 */
export async function driveReadExport(
  input: Record<string, unknown>,
  deps: DriveToolDeps,
): Promise<DriveReadExportResult> {
  rejectUnknownKeys(input, DRIVE_READ_EXPORT_KNOWN_KEYS, 'drive_read_export');
  const fileId = validateDriveFileId(input.file_id, 'drive_read_export');
  const format =
    typeof input.format === 'string' && input.format.length > 0
      ? input.format
      : 'text';
  if (!DRIVE_READ_EXPORT_VALID_FORMATS.has(format)) {
    throw new ToolSchemaError(
      "drive_read_export: format must be 'text', 'markdown', or 'html'",
    );
  }
  const maxChars = requirePositiveIntInRange(
    input.max_chars,
    'max_chars',
    'drive_read_export',
    1,
    DRIVE_READ_EXPORT_MAX_CAP,
    DRIVE_READ_EXPORT_DEFAULT_MAX,
  );

  // 1. Fetch metadata to decide how to read the file.
  const metaParams = new URLSearchParams({
    fields: 'id,name,mimeType',
    supportsAllDrives: 'true',
  });
  const metaUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${metaParams.toString()}`;
  const metaResp = await googleApiFetch(metaUrl, { method: 'GET' }, fetchOpts(deps));
  if (metaResp.status === 404) {
    throw new GoogleApiToolError(`drive_read_export not_found: file_id=${fileId}`, {
      status: 404,
    });
  }
  if (!metaResp.ok) {
    const snippet = await safeErrorSnippet(metaResp);
    throw new GoogleApiToolError(
      `drive_read_export metadata HTTP ${metaResp.status}: ${snippet}`,
      { status: metaResp.status, bodySnippet: snippet },
    );
  }
  const meta = (await metaResp.json()) as {
    id?: string;
    name?: string;
    mimeType?: string;
  };
  const mimeType = meta.mimeType ?? '';
  if (DRIVE_BINARY_PREFIXES.some((p) => mimeType.startsWith(p))) {
    throw new GoogleApiToolError(
      `drive_read_export binary not supported: mimeType=${mimeType} file_id=${fileId}`,
    );
  }

  // 2. Pick download URL + expected MIME.
  let downloadUrl: string;
  let exportedMime: string;
  if (mimeType.startsWith('application/vnd.google-apps.')) {
    const exportMime = DRIVE_EXPORT_FORMATS[format]?.[mimeType];
    if (!exportMime) {
      throw new GoogleApiToolError(
        `drive_read_export unsupported combo: mimeType=${mimeType} format=${format}`,
      );
    }
    const exportParams = new URLSearchParams({ mimeType: exportMime });
    downloadUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/export?${exportParams.toString()}`;
    exportedMime = exportMime;
  } else {
    downloadUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
    exportedMime = mimeType;
  }

  // 3. Fetch content and decode as UTF-8.
  const contentResp = await googleApiFetch(downloadUrl, { method: 'GET' }, fetchOpts(deps));
  if (!contentResp.ok) {
    const snippet = await safeErrorSnippet(contentResp);
    throw new GoogleApiToolError(
      `drive_read_export HTTP ${contentResp.status}: ${snippet}`,
      { status: contentResp.status, bodySnippet: snippet },
    );
  }
  const raw = await contentResp.arrayBuffer();
  const byteSize = raw.byteLength;
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw);
  } catch {
    throw new GoogleApiToolError(
      `drive_read_export decode_failed (binary): mimeType=${mimeType} byte_size=${byteSize}`,
    );
  }
  const { value, truncated } = truncateChars(content, maxChars);
  return {
    file_id: fileId,
    name: meta.name ?? '',
    mimeType,
    exported_mime: exportedMime,
    content: value,
    truncated,
    byte_size: byteSize,
  };
}

// ============================================================================
// 4. drive_create_file (Python: _exec_drive_create_file)
// ============================================================================

const DRIVE_CREATE_FILE_KNOWN_KEYS = new Set(['name', 'content', 'mime_type', 'parents']);
const DRIVE_CREATE_FILE_MAX_BYTES = 1024 * 1024;

export interface DriveCreateFileResult {
  id?: string;
  name?: string;
  mimeType?: string;
  webViewLink?: string;
  parents?: string[];
  [extra: string]: unknown;
}

/**
 * Create a new Drive file with the given UTF-8 text body. Uses Drive's
 * multipart upload endpoint so we can post metadata and content in a
 * single request — necessary because Workers' fetch doesn't expose the
 * separate resumable-upload session API helpers.
 *
 * `parents` MUST be valid Drive folder ids; the regex check happens
 * before we ever encode them into the upload body.
 */
export async function driveCreateFile(
  input: Record<string, unknown>,
  deps: DriveToolDeps,
): Promise<DriveCreateFileResult> {
  rejectUnknownKeys(input, DRIVE_CREATE_FILE_KNOWN_KEYS, 'drive_create_file');
  const name = requireNonEmptyString(input.name, 'name', 'drive_create_file');
  if (typeof input.content !== 'string') {
    throw new ToolSchemaError('drive_create_file: content (string) is required');
  }
  const content = input.content;
  const contentBytes = utf8ByteLength(content);
  if (contentBytes > DRIVE_CREATE_FILE_MAX_BYTES) {
    throw new ToolSchemaError(
      `drive_create_file: content too large (${contentBytes} bytes > ${DRIVE_CREATE_FILE_MAX_BYTES})`,
    );
  }
  const mimeType =
    typeof input.mime_type === 'string' && input.mime_type.trim().length > 0
      ? input.mime_type.trim()
      : 'text/plain';

  let parents: string[] | undefined;
  if (input.parents !== undefined) {
    if (!Array.isArray(input.parents)) {
      throw new ToolSchemaError(
        'drive_create_file: parents must be array of strings',
      );
    }
    parents = input.parents.map((p) => {
      if (typeof p !== 'string' || !/^[A-Za-z0-9_-]+$/.test(p)) {
        throw new ToolSchemaError(
          `drive_create_file: parents id ${JSON.stringify(String(p).slice(0, 32))} must match [A-Za-z0-9_-]+`,
        );
      }
      return p;
    });
  }

  // Multipart/related body. Boundary uses crypto.randomUUID() so it's
  // guaranteed not to collide with the content.
  const boundary = `boundary_${crypto.randomUUID().replace(/-/g, '')}`;
  const meta: Record<string, unknown> = { name, mimeType };
  if (parents) meta.parents = parents;
  const metaJson = JSON.stringify(meta);

  // Build the multipart/related body as a single concatenated string
  // and pass it to fetch directly. (Workers' Blob doesn't expose the
  // `BlobPart` type alias from the DOM lib, so we sidestep it — fetch
  // accepts strings for the request body.)
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    metaJson +
    `\r\n--${boundary}\r\n` +
    `Content-Type: ${mimeType}; charset=UTF-8\r\n\r\n` +
    content +
    `\r\n--${boundary}--`;

  const params = new URLSearchParams({
    uploadType: 'multipart',
    fields: 'id,name,mimeType,webViewLink,parents',
    supportsAllDrives: 'true',
  });
  const url = `${DRIVE_UPLOAD_API_BASE}/files?${params.toString()}`;
  const resp = await googleApiFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    },
    fetchOpts(deps),
  );
  if (resp.status === 403) {
    const snippet = await safeErrorSnippet(resp);
    throw new GoogleApiToolError(
      `drive_create_file permission_denied (HTTP 403): ${snippet}`,
      { status: 403, bodySnippet: snippet },
    );
  }
  if (!resp.ok) {
    const snippet = await safeErrorSnippet(resp);
    throw new GoogleApiToolError(
      `drive_create_file HTTP ${resp.status}: ${snippet}`,
      { status: resp.status, bodySnippet: snippet },
    );
  }
  return (await resp.json()) as DriveCreateFileResult;
}

// ============================================================================
// 5. drive_delete (destructive 2-step with TTL + fingerprint + Issue #126)
// ============================================================================

const DRIVE_DELETE_KNOWN_KEYS = new Set(['file_id', 'confirmation_token']);
const DRIVE_DELETE_TTL_MS = 600_000;
const DRIVE_DELETE_META_FIELDS =
  'id,name,mimeType,owners,parents,modifiedTime,webViewLink,trashed';

export type DriveDeleteOutcome =
  | { status: 'confirmation_required'; token: string; message: string; file: Record<string, unknown> }
  | { status: 'confirmation_stale'; token: string; message: string; file: Record<string, unknown> }
  | { status: 'already_trashed'; file: Record<string, unknown> }
  | { status: 'trashed'; file: Record<string, unknown> };

/**
 * Two-step destructive delete:
 *
 *   Step 1 (no `confirmation_token`):
 *     - Fetch metadata, return `confirmation_required` with a new
 *       token bound to (file_id, fingerprint, boundMessageId).
 *     - If the file is already trashed, return `already_trashed`
 *       short-circuit (the agent shouldn't waste a confirm round on
 *       a no-op).
 *
 *   Step 2 (with `confirmation_token`):
 *     - Atomic-pop the token from the store.
 *     - If popped is null (negative / expired / replay), return a
 *       fresh `confirmation_required`.
 *     - Issue #126: reject if the popped token was bound to the
 *       *same* inbound message we're handling — same-message confirms
 *       bypass the human-in-the-loop intent.
 *     - Validate file_id matches the popped entry — otherwise the
 *       agent is trying to use a token issued for a different file.
 *     - Validate TTL (Cloudflare KV's TTL is approximate; we
 *       double-check here so we don't act on a stale token that
 *       happened to survive a slow KV expiration).
 *     - Re-GET metadata and recompute fingerprint. If different,
 *       return `confirmation_stale` with a new token — the file
 *       changed between Step 1 and now, so a fresh confirmation is
 *       needed.
 *     - PATCH `trashed: true`. Return `trashed`.
 */
export async function driveDelete(
  input: Record<string, unknown>,
  deps: DriveToolDeps,
): Promise<DriveDeleteOutcome> {
  rejectUnknownKeys(input, DRIVE_DELETE_KNOWN_KEYS, 'drive_delete');
  if (!deps.confirmTokenStore) {
    throw new GoogleApiToolError(
      'drive_delete misconfigured: confirmTokenStore not provided to dispatcher',
    );
  }
  const fileId = validateDriveFileId(input.file_id, 'drive_delete');
  const token =
    typeof input.confirmation_token === 'string' && input.confirmation_token.length > 0
      ? input.confirmation_token
      : null;

  // -- Step 1 --
  if (token === null) {
    const meta = await driveDeleteGetMeta(fileId, deps);
    if (meta.trashed === true) {
      return { status: 'already_trashed', file: meta };
    }
    return await issueConfirmation(fileId, meta, deps, 'このファイルをゴミ箱に移動します。実行するなら同じ file_id と confirmation_token を再度送ってください。');
  }

  // -- Step 2 --
  const popped = await deps.confirmTokenStore.consume(token);
  if (!popped) {
    const meta = await driveDeleteGetMeta(fileId, deps);
    return await issueConfirmation(
      fileId,
      meta,
      deps,
      'confirmation_token が見つかりません (期限切れ / 既に使用済み / 不正な値)。新しい token で再確認してください。',
    );
  }
  // Issue #126: same-inbound-message confirms are forbidden. Caller
  // must wait for the next message to confirm.
  if (
    popped.bound_message_id !== undefined &&
    deps.boundMessageId !== undefined &&
    popped.bound_message_id === deps.boundMessageId
  ) {
    const meta = await driveDeleteGetMeta(fileId, deps);
    return await issueConfirmation(
      fileId,
      meta,
      deps,
      '同一メッセージ内での自己確認はできません。次の inbound message で confirmation_token を再送してください (Issue #126)。',
    );
  }
  if (popped.file_id !== fileId) {
    throw new ToolSchemaError(
      'drive_delete: confirmation_token does not match file_id (token was issued for a different file)',
    );
  }
  if (Date.now() - popped.created_at_ms > DRIVE_DELETE_TTL_MS) {
    const meta = await driveDeleteGetMeta(fileId, deps);
    return await issueConfirmation(
      fileId,
      meta,
      deps,
      'confirmation_token の有効期限が切れています。新しい token で再確認してください。',
    );
  }

  // Re-fetch metadata and re-check fingerprint (TOCTOU).
  const meta = await driveDeleteGetMeta(fileId, deps);
  const currentFp = await driveDeleteFingerprint(meta);
  if (currentFp !== popped.fingerprint) {
    return await issueConfirmation(
      fileId,
      meta,
      deps,
      'ファイルの metadata が前回確認時と変わっています。再確認してください。',
      'confirmation_stale',
    );
  }
  if (meta.trashed === true) {
    return { status: 'already_trashed', file: meta };
  }

  // PATCH trashed=true.
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`;
  const resp = await googleApiFetch(
    url,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    },
    fetchOpts(deps),
  );
  if (resp.status === 403) {
    const snippet = await safeErrorSnippet(resp);
    throw new GoogleApiToolError(
      `drive_delete permission_denied (HTTP 403): CMA が作成した or 編集権限を持つファイルのみゴミ箱移動できます。${snippet}`,
      { status: 403, bodySnippet: snippet },
    );
  }
  if (!resp.ok) {
    const snippet = await safeErrorSnippet(resp);
    throw new GoogleApiToolError(
      `drive_delete HTTP ${resp.status}: ${snippet}`,
      { status: resp.status, bodySnippet: snippet },
    );
  }
  const patched = (await resp.json()) as Record<string, unknown>;
  return {
    status: 'trashed',
    file: { ...meta, ...patched, trashed: true },
  };
}

async function issueConfirmation(
  fileId: string,
  meta: Record<string, unknown>,
  deps: DriveToolDeps,
  message: string,
  status: 'confirmation_required' | 'confirmation_stale' = 'confirmation_required',
): Promise<DriveDeleteOutcome> {
  const fingerprint = await driveDeleteFingerprint(meta);
  const newToken = await deps.confirmTokenStore!.issue(
    fileId,
    fingerprint,
    deps.boundMessageId,
  );
  return { status, token: newToken, message, file: meta };
}

async function driveDeleteGetMeta(
  fileId: string,
  deps: DriveToolDeps,
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({
    fields: DRIVE_DELETE_META_FIELDS,
    supportsAllDrives: 'true',
  });
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${params.toString()}`;
  const resp = await googleApiFetch(url, { method: 'GET' }, fetchOpts(deps));
  if (resp.status === 403) {
    const snippet = await safeErrorSnippet(resp);
    throw new GoogleApiToolError(
      `drive_delete permission_denied (HTTP 403): CMA がメタデータを読めません。${snippet}`,
      { status: 403, bodySnippet: snippet },
    );
  }
  if (resp.status === 404) {
    throw new GoogleApiToolError(
      `drive_delete not_found (HTTP 404): file_id=${fileId}`,
      { status: 404 },
    );
  }
  if (!resp.ok) {
    const snippet = await safeErrorSnippet(resp);
    throw new GoogleApiToolError(
      `drive_delete metadata HTTP ${resp.status}: ${snippet}`,
      { status: resp.status, bodySnippet: snippet },
    );
  }
  return (await resp.json()) as Record<string, unknown>;
}

/**
 * SHA-256 fingerprint of the file's mutable metadata, used as the
 * TOCTOU defence: if anything material changes between Step 1 and
 * Step 2, the fingerprint differs and we force a fresh confirmation.
 *
 * Mirrors the Python helper (referenced via `_drive_delete_fingerprint`
 * + the comment at `_exec_drive_delete:1300`). `owners` / `parents`
 * are JSON-stringified with sorted keys so insertion order doesn't
 * spuriously change the digest.
 */
export async function driveDeleteFingerprint(
  meta: Record<string, unknown>,
): Promise<string> {
  const parts = [
    String(meta.name ?? ''),
    String(meta.mimeType ?? ''),
    String(meta.modifiedTime ?? ''),
    String(meta.trashed ?? ''),
    stableJsonStringify(meta.owners),
    stableJsonStringify(meta.parents),
  ];
  return await sha256Hex(parts.join('|'));
}

/**
 * `JSON.stringify` with sorted object keys at every depth. Plain
 * `JSON.stringify` is insertion-ordered, so a re-fetch that returns
 * the same data in a different order would falsely invalidate the
 * fingerprint. This sort is shallow-recursive — adequate for the
 * shapes Drive returns.
 */
function stableJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${stableJsonStringify((value as Record<string, unknown>)[k])}`,
    );
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

// ----------------------------------------------------------------------------
// Re-exports for callers that only need the snippet helper but want a
// single import surface.
// ----------------------------------------------------------------------------

export { redactTokenLike };
