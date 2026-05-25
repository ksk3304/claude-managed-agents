/**
 * Google Sheets custom tools for the MAKOTO bridge.
 *
 * Four functions matching the plan-draft v3 §step 8 surface:
 *   - `sheetsGet`     → Python `_exec_sheets_read` (renamed for the
 *                       agent-facing name `sheets_get`)
 *   - `sheetsAppend`  → Python `_exec_sheets_append`
 *   - `sheetsUpdate`  → Python `_exec_sheets_update`
 *   - `sheetsClear`   → NEW (no Python counterpart; uses Google's
 *                       `spreadsheets.values.clear` endpoint). plan-
 *                       draft v3 lists this in place of the legacy
 *                       `sheets_create` to give the agent a way to
 *                       wipe a range without re-issuing a full update.
 *
 * Same stateless-function shape as `drive.ts`. The dispatcher in
 * layer 7 wires the access token through `SheetsToolDeps.accessToken`.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 8 — 層 6)
 * Source: `scripts/cma_lib.py:1947-2236` (sheets_* helpers).
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
// 1. sheets_get (Python: _exec_sheets_read)
// ============================================================================

const SHEETS_GET_KNOWN_KEYS = new Set(['spreadsheet_id', 'range']);

export interface SheetsGetResult {
  range: string;
  values: unknown[][];
  major_dimension: string;
}

export async function sheetsGet(
  input: Record<string, unknown>,
  deps: SheetsToolDeps,
): Promise<SheetsGetResult> {
  rejectUnknownKeys(input, SHEETS_GET_KNOWN_KEYS, 'sheets_get');
  const spreadsheetId = requireNonEmptyString(
    input.spreadsheet_id,
    'spreadsheet_id',
    'sheets_get',
  );
  const range = requireNonEmptyString(input.range, 'range', 'sheets_get');
  const url = `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeSheetsRange(range)}`;
  const resp = await googleApiFetch(url, { method: 'GET' }, fetchOpts(deps));
  if (!resp.ok) {
    const snippet = await safeErrorSnippet(resp);
    if (resp.status === 403) {
      throw new GoogleApiToolError(
        `sheets_get scope_insufficient: HTTP 403: ${snippet}`,
        { status: 403, bodySnippet: snippet },
      );
    }
    throw new GoogleApiToolError(`sheets_get HTTP ${resp.status}: ${snippet}`, {
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
// 2. sheets_append
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

// ============================================================================
// 3. sheets_update
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
// 4. sheets_clear  (new — no Python counterpart)
// ============================================================================
//
// Google Sheets API: `spreadsheets.values.clear`
//   POST {SHEETS_API_BASE}/spreadsheets/{id}/values/{range}:clear
//   body: {} (no payload required; the URL specifies what to clear)
//
// Plan-draft v3 lists this in `sheets.ts`'s 4-tool set; the legacy
// `sheets_create` is intentionally absent because new-spreadsheet
// creation lives elsewhere (operators provision spreadsheets via the
// dashboard, the bridge writes into them but doesn't mint them).

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
