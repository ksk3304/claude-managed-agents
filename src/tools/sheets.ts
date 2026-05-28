/**
 * Google Sheets custom tools for the MAKOTO bridge.
 *
 * Five functions matching Python's `get_sheets_tool_dispatch` surface
 * (`scripts/cma_lib.py:2543-2548`):
 *
 *   - `sheetsCreate` → Python `_exec_sheets_create` (`cma_lib.py:2148-2190`)
 *   - `sheetsRead`   → Python `_exec_sheets_read`   (`cma_lib.py:2193-2245`)
 *   - `sheetsUpdate` → Python `_exec_sheets_update` (`cma_lib.py:2248-2312`)
 *   - `sheetsAppend` → Python `_exec_sheets_append` (`cma_lib.py:2315-2397`)
 *   - `sheetsClear`  → Issue #189 weekly Drive list full refresh helper
 *
 * Same stateless-function shape as `drive.ts`. The dispatcher in
 * layer 7 wires the access token through `SheetsToolDeps.accessToken`.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 8 — 層 6)
 * Source: `scripts/cma_lib.py:2148-2397` (sheets_* helpers).
 */

import {
  GoogleApiToolError,
  ToolSchemaError,
  googleApiFetch,
  rejectUnknownKeys,
  requireNonEmptyString,
  safeErrorSnippet,
  type Fetcher,
  type GoogleApiFetchOptions,
} from './tool-common';

export const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4';

export interface SheetsToolDeps {
  accessToken: string;
  refreshAccessToken?: () => Promise<string>;
  fetcher?: Fetcher;
}

function fetchOpts(deps: SheetsToolDeps): GoogleApiFetchOptions {
  const opts: GoogleApiFetchOptions = { accessToken: deps.accessToken };
  if (deps.refreshAccessToken) opts.refreshAccessToken = deps.refreshAccessToken;
  if (deps.fetcher) opts.fetcher = deps.fetcher;
  return opts;
}

/**
 * Throw `ToolSchemaError` if `values` isn't a 2D array (outer array of
 * inner arrays). The inner cells can be anything — Sheets API accepts
 * primitives, strings, formula strings, etc. — but the *outer/inner*
 * shape is non-negotiable.
 */
function require2DArray(value: unknown, toolName: string): unknown[][] {
  if (!Array.isArray(value)) {
    throw new ToolSchemaError(
      `${toolName}: values must be 2D list (outer list)`,
    );
  }
  for (const row of value) {
    if (!Array.isArray(row)) {
      throw new ToolSchemaError(
        `${toolName}: values must be 2D list (each row is list)`,
      );
    }
  }
  return value as unknown[][];
}

/**
 * URL-encode a Sheets range value while keeping `:` (range separator)
 * and `!` (sheet-name terminator) — Python's
 * `urllib.parse.quote(range, safe="!:")` equivalent. `encodeURI`
 * preserves more than we want; we encode aggressively and then
 * re-decode the two safe characters.
 */
function encodeSheetsRange(range: string): string {
  return encodeURIComponent(range).replace(/%21/g, '!').replace(/%3A/g, ':');
}

// ============================================================================
// 1. sheets_create (Python: _exec_sheets_create)
// ============================================================================

const SHEETS_CREATE_KNOWN_KEYS = new Set(['title']);

export interface SheetsCreateResult {
  spreadsheet_id: string | null;
  spreadsheet_url: string | null;
  title: string | null;
}

/**
 * Create a new Google Spreadsheet at My Drive root.
 *
 * Python: `_exec_sheets_create` (`scripts/cma_lib.py:2148-2190`).
 * API: `POST {SHEETS_API_BASE}/spreadsheets`
 *   body: `{properties: {title: "..."}}`
 *   response: `{spreadsheetId, spreadsheetUrl, properties: {title}, ...}`
 */
export async function sheetsCreate(
  input: Record<string, unknown>,
  deps: SheetsToolDeps,
): Promise<SheetsCreateResult> {
  rejectUnknownKeys(input, SHEETS_CREATE_KNOWN_KEYS, 'sheets_create');
  const title = requireNonEmptyString(input.title, 'title', 'sheets_create');

  const url = `${SHEETS_API_BASE}/spreadsheets`;
  const resp = await googleApiFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { title } }),
    },
    fetchOpts(deps),
  );
  if (!resp.ok) {
    const snippet = await safeErrorSnippet(resp);
    if (resp.status === 403) {
      throw new GoogleApiToolError(
        `sheets_create scope_insufficient: HTTP 403: ${snippet}`,
        { status: 403, bodySnippet: snippet },
      );
    }
    throw new GoogleApiToolError(
      `sheets_create HTTP ${resp.status}: ${snippet}`,
      { status: resp.status, bodySnippet: snippet },
    );
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    const snippet = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    throw new GoogleApiToolError(`sheets_create invalid_json: ${snippet}`);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new GoogleApiToolError(
      `sheets_create unexpected_response_type: ${body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body}`,
    );
  }
  const data = body as {
    spreadsheetId?: string;
    spreadsheetUrl?: string;
    properties?: { title?: string };
  };
  return {
    spreadsheet_id: typeof data.spreadsheetId === 'string' ? data.spreadsheetId : null,
    spreadsheet_url: typeof data.spreadsheetUrl === 'string' ? data.spreadsheetUrl : null,
    title:
      data.properties && typeof data.properties.title === 'string'
        ? data.properties.title
        : null,
  };
}

// ============================================================================
// 2. sheets_read (Python: _exec_sheets_read)
// ============================================================================

const SHEETS_READ_KNOWN_KEYS = new Set(['spreadsheet_id', 'range']);

export interface SheetsReadResult {
  range: string;
  values: unknown[][];
  major_dimension: string;
}

export async function sheetsRead(
  input: Record<string, unknown>,
  deps: SheetsToolDeps,
): Promise<SheetsReadResult> {
  rejectUnknownKeys(input, SHEETS_READ_KNOWN_KEYS, 'sheets_read');
  const spreadsheetId = requireNonEmptyString(
    input.spreadsheet_id,
    'spreadsheet_id',
    'sheets_read',
  );
  const range = requireNonEmptyString(input.range, 'range', 'sheets_read');
  const url = `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeSheetsRange(range)}`;
  const resp = await googleApiFetch(url, { method: 'GET' }, fetchOpts(deps));
  if (!resp.ok) {
    const snippet = await safeErrorSnippet(resp);
    if (resp.status === 403) {
      throw new GoogleApiToolError(
        `sheets_read scope_insufficient: HTTP 403: ${snippet}`,
        { status: 403, bodySnippet: snippet },
      );
    }
    throw new GoogleApiToolError(`sheets_read HTTP ${resp.status}: ${snippet}`, {
      status: resp.status,
      bodySnippet: snippet,
    });
  }
  const body = (await resp.json()) as {
    range?: string;
    values?: unknown[][];
    majorDimension?: string;
  };
  return {
    range: body.range ?? range,
    values: Array.isArray(body.values) ? body.values : [],
    major_dimension: body.majorDimension ?? 'ROWS',
  };
}

// ============================================================================
// 3. sheets_update (Python: _exec_sheets_update)
// ============================================================================

const SHEETS_UPDATE_KNOWN_KEYS = new Set(['spreadsheet_id', 'range', 'values']);

export interface SheetsUpdateResult {
  spreadsheet_id: string;
  updated_range: string;
  updated_cells: number;
}

export async function sheetsUpdate(
  input: Record<string, unknown>,
  deps: SheetsToolDeps,
): Promise<SheetsUpdateResult> {
  rejectUnknownKeys(input, SHEETS_UPDATE_KNOWN_KEYS, 'sheets_update');
  const spreadsheetId = requireNonEmptyString(
    input.spreadsheet_id,
    'spreadsheet_id',
    'sheets_update',
  );
  const range = requireNonEmptyString(input.range, 'range', 'sheets_update');
  const values = require2DArray(input.values, 'sheets_update');

  const params = new URLSearchParams({ valueInputOption: 'RAW' });
  const url = `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeSheetsRange(range)}?${params.toString()}`;
  const resp = await googleApiFetch(
    url,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    },
    fetchOpts(deps),
  );
  if (!resp.ok) {
    const snippet = await safeErrorSnippet(resp);
    if (resp.status === 403) {
      throw new GoogleApiToolError(
        `sheets_update scope_insufficient: HTTP 403: ${snippet}`,
        { status: 403, bodySnippet: snippet },
      );
    }
    throw new GoogleApiToolError(
      `sheets_update HTTP ${resp.status}: ${snippet}`,
      { status: resp.status, bodySnippet: snippet },
    );
  }
  const body = (await resp.json()) as {
    updatedRange?: string;
    updatedCells?: number;
  };
  return {
    spreadsheet_id: spreadsheetId,
    updated_range: body.updatedRange ?? '',
    updated_cells: typeof body.updatedCells === 'number' ? body.updatedCells : 0,
  };
}

// ============================================================================
// 4. sheets_clear (Issue #189 full refresh helper)
// ============================================================================

const SHEETS_CLEAR_KNOWN_KEYS = new Set(['spreadsheet_id', 'range']);

export interface SheetsClearResult {
  spreadsheet_id: string;
  cleared_range: string;
}

export async function sheetsClear(
  input: Record<string, unknown>,
  deps: SheetsToolDeps,
): Promise<SheetsClearResult> {
  rejectUnknownKeys(input, SHEETS_CLEAR_KNOWN_KEYS, 'sheets_clear');
  const spreadsheetId = requireNonEmptyString(
    input.spreadsheet_id,
    'spreadsheet_id',
    'sheets_clear',
  );
  const range = requireNonEmptyString(input.range, 'range', 'sheets_clear');
  const url = `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeSheetsRange(range)}:clear`;
  const resp = await googleApiFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
    fetchOpts(deps),
  );
  if (!resp.ok) {
    const snippet = await safeErrorSnippet(resp);
    if (resp.status === 403) {
      throw new GoogleApiToolError(
        `sheets_clear scope_insufficient: HTTP 403: ${snippet}`,
        { status: 403, bodySnippet: snippet },
      );
    }
    throw new GoogleApiToolError(
      `sheets_clear HTTP ${resp.status}: ${snippet}`,
      { status: resp.status, bodySnippet: snippet },
    );
  }
  const body = (await resp.json()) as { clearedRange?: string };
  return {
    spreadsheet_id: spreadsheetId,
    cleared_range: body.clearedRange ?? range,
  };
}

// ============================================================================
// 5. sheets_append (Python: _exec_sheets_append)
// ============================================================================

const SHEETS_APPEND_KNOWN_KEYS = new Set(['spreadsheet_id', 'range', 'values']);

export interface SheetsAppendResult {
  spreadsheet_id: string;
  table_range: string;
  updated_range: string;
  updated_cells: number;
}

export async function sheetsAppend(
  input: Record<string, unknown>,
  deps: SheetsToolDeps,
): Promise<SheetsAppendResult> {
  rejectUnknownKeys(input, SHEETS_APPEND_KNOWN_KEYS, 'sheets_append');
  const spreadsheetId = requireNonEmptyString(
    input.spreadsheet_id,
    'spreadsheet_id',
    'sheets_append',
  );
  const range = requireNonEmptyString(input.range, 'range', 'sheets_append');
  const values = require2DArray(input.values, 'sheets_append');

  const params = new URLSearchParams({
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
  });
  const url = `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeSheetsRange(range)}:append?${params.toString()}`;
  const resp = await googleApiFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    },
    fetchOpts(deps),
  );
  if (!resp.ok) {
    const snippet = await safeErrorSnippet(resp);
    if (resp.status === 403) {
      throw new GoogleApiToolError(
        `sheets_append scope_insufficient: HTTP 403: ${snippet}`,
        { status: 403, bodySnippet: snippet },
      );
    }
    throw new GoogleApiToolError(
      `sheets_append HTTP ${resp.status}: ${snippet}`,
      { status: resp.status, bodySnippet: snippet },
    );
  }
  const body = (await resp.json()) as {
    tableRange?: string;
    updates?: { updatedRange?: string; updatedCells?: number };
  };
  const updates = body.updates ?? {};
  return {
    spreadsheet_id: spreadsheetId,
    table_range: body.tableRange ?? '',
    updated_range: updates.updatedRange ?? '',
    updated_cells:
      typeof updates.updatedCells === 'number' ? updates.updatedCells : 0,
  };
}
