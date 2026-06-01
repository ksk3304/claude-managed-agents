/**
 * Google Docs custom tools for the MAKOTO bridge.
 *
 * Native Docs creation/editing uses the Google Docs API. File-level
 * delete stays in Drive (`drive_delete`) so all destructive file
 * operations share one confirmation-token flow.
 */

import {
  GoogleApiToolError,
  ToolSchemaError,
  googleApiFetch,
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePositiveIntInRange,
  safeErrorSnippet,
  truncateChars,
  type Fetcher,
  type GoogleApiFetchOptions,
} from './tool-common';

export const DOCS_API_BASE = 'https://docs.googleapis.com/v1';

const DOCS_CREATE_KNOWN_KEYS = new Set(['title', 'initial_text']);
const DOCS_GET_KNOWN_KEYS = new Set(['document_id', 'max_chars']);
const DOCS_BATCH_UPDATE_KNOWN_KEYS = new Set(['document_id', 'requests', 'write_control']);
const DOCS_GET_DEFAULT_MAX_CHARS = 80_000;
const DOCS_GET_MAX_CHARS_CAP = 200_000;

export interface DocsToolDeps {
  accessToken: string;
  refreshAccessToken?: () => Promise<string>;
  fetcher?: Fetcher;
}

export interface DocsCreateResult {
  document_id: string | null;
  title: string | null;
  document_url: string | null;
}

export interface DocsGetResult {
  document_id: string;
  title: string | null;
  body_text: string;
  truncated: boolean;
  revision_id?: string;
}

export interface DocsBatchUpdateResult {
  document_id: string;
  replies: unknown[];
  write_control?: unknown;
}

function fetchOpts(deps: DocsToolDeps): GoogleApiFetchOptions {
  const opts: GoogleApiFetchOptions = { accessToken: deps.accessToken };
  if (deps.refreshAccessToken) opts.refreshAccessToken = deps.refreshAccessToken;
  if (deps.fetcher) opts.fetcher = deps.fetcher;
  return opts;
}

export async function docsCreate(
  input: Record<string, unknown>,
  deps: DocsToolDeps,
): Promise<DocsCreateResult> {
  rejectUnknownKeys(input, DOCS_CREATE_KNOWN_KEYS, 'docs_create');
  const title = requireNonEmptyString(input.title, 'title', 'docs_create');
  const resp = await googleApiFetch(
    `${DOCS_API_BASE}/documents`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    },
    fetchOpts(deps),
  );
  const body = await parseDocsResponse(resp, 'docs_create');
  const documentId = typeof body.documentId === 'string' ? body.documentId : null;
  const result: DocsCreateResult = {
    document_id: documentId,
    title: typeof body.title === 'string' ? body.title : title,
    document_url: documentId ? `https://docs.google.com/document/d/${documentId}/edit` : null,
  };

  if (documentId && typeof input.initial_text === 'string' && input.initial_text.length > 0) {
    await docsBatchUpdate(
      {
        document_id: documentId,
        requests: [{ insertText: { location: { index: 1 }, text: input.initial_text } }],
      },
      deps,
    );
  }
  return result;
}

export async function docsGet(
  input: Record<string, unknown>,
  deps: DocsToolDeps,
): Promise<DocsGetResult> {
  rejectUnknownKeys(input, DOCS_GET_KNOWN_KEYS, 'docs_get');
  const documentId = requireNonEmptyString(input.document_id, 'document_id', 'docs_get');
  const maxChars = requirePositiveIntInRange(
    input.max_chars,
    'max_chars',
    'docs_get',
    1,
    DOCS_GET_MAX_CHARS_CAP,
    DOCS_GET_DEFAULT_MAX_CHARS,
  );
  const resp = await googleApiFetch(
    `${DOCS_API_BASE}/documents/${encodeURIComponent(documentId)}`,
    { method: 'GET' },
    fetchOpts(deps),
  );
  const body = await parseDocsResponse(resp, 'docs_get');
  const { value, truncated } = truncateChars(extractDocumentText(body), maxChars);
  const result: DocsGetResult = {
    document_id: documentId,
    title: typeof body.title === 'string' ? body.title : null,
    body_text: value,
    truncated,
  };
  if (typeof body.revisionId === 'string') result.revision_id = body.revisionId;
  return result;
}

export async function docsBatchUpdate(
  input: Record<string, unknown>,
  deps: DocsToolDeps,
): Promise<DocsBatchUpdateResult> {
  rejectUnknownKeys(input, DOCS_BATCH_UPDATE_KNOWN_KEYS, 'docs_batch_update');
  const documentId = requireNonEmptyString(
    input.document_id,
    'document_id',
    'docs_batch_update',
  );
  if (!Array.isArray(input.requests) || input.requests.length === 0) {
    throw new ToolSchemaError('docs_batch_update: requests must be a non-empty array');
  }
  const requestBody: Record<string, unknown> = { requests: input.requests };
  if (input.write_control !== undefined) requestBody.writeControl = input.write_control;

  const resp = await googleApiFetch(
    `${DOCS_API_BASE}/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    },
    fetchOpts(deps),
  );
  const body = await parseDocsResponse(resp, 'docs_batch_update');
  return {
    document_id: typeof body.documentId === 'string' ? body.documentId : documentId,
    replies: Array.isArray(body.replies) ? body.replies : [],
    write_control: body.writeControl,
  };
}

async function parseDocsResponse(
  resp: Response,
  toolName: string,
): Promise<Record<string, unknown>> {
  if (!resp.ok) {
    const snippet = await safeErrorSnippet(resp);
    if (resp.status === 403) {
      throw new GoogleApiToolError(
        `${toolName} scope_insufficient: HTTP 403: ${snippet}`,
        { status: 403, bodySnippet: snippet },
      );
    }
    throw new GoogleApiToolError(
      `${toolName} HTTP ${resp.status}: ${snippet}`,
      { status: resp.status, bodySnippet: snippet },
    );
  }
  try {
    const body = await resp.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new GoogleApiToolError(
        `${toolName} unexpected_response_type: ${body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body}`,
      );
    }
    return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof GoogleApiToolError) throw err;
    throw new GoogleApiToolError(`${toolName} invalid_json`);
  }
}

function extractDocumentText(doc: Record<string, unknown>): string {
  const out: string[] = [];
  const body = doc.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const content = (body as Record<string, unknown>).content;
  if (!Array.isArray(content)) return '';
  for (const item of content) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    collectStructuralText(item as Record<string, unknown>, out);
  }
  return out.join('');
}

function collectStructuralText(node: Record<string, unknown>, out: string[]): void {
  const paragraph = node.paragraph;
  if (paragraph && typeof paragraph === 'object' && !Array.isArray(paragraph)) {
    const elements = (paragraph as Record<string, unknown>).elements;
    if (Array.isArray(elements)) {
      for (const element of elements) {
        if (!element || typeof element !== 'object' || Array.isArray(element)) continue;
        const textRun = (element as Record<string, unknown>).textRun;
        if (textRun && typeof textRun === 'object' && !Array.isArray(textRun)) {
          const content = (textRun as Record<string, unknown>).content;
          if (typeof content === 'string') out.push(content);
        }
      }
    }
  }

  const table = node.table;
  if (table && typeof table === 'object' && !Array.isArray(table)) {
    const rows = (table as Record<string, unknown>).tableRows;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        const cells = (row as Record<string, unknown>).tableCells;
        if (!Array.isArray(cells)) continue;
        for (const cell of cells) {
          if (!cell || typeof cell !== 'object' || Array.isArray(cell)) continue;
          const content = (cell as Record<string, unknown>).content;
          if (!Array.isArray(content)) continue;
          for (const nested of content) {
            if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
              collectStructuralText(nested as Record<string, unknown>, out);
            }
          }
        }
      }
    }
  }
}

export { ToolSchemaError };
