/**
 * Unit tests for `src/tools/sheets.ts` — 4 Sheets custom tools.
 */

import { describe, it, expect } from 'vitest';
import {
  sheetsAppend,
  sheetsClear,
  sheetsCreate,
  sheetsRead,
  sheetsUpdate,
  type SheetsToolDeps,
} from '../src/tools/sheets';
import { makeFetchMock } from './makoto-helpers';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deps(fetcher: typeof fetch): SheetsToolDeps {
  return { accessToken: 'ya29.test', fetcher };
}

describe('sheetsCreate', () => {
  it('POSTs title and returns spreadsheet_id / url / title', async () => {
    const fetcher = makeFetchMock(async (url, init) => {
      expect(url).toBe('https://sheets.googleapis.com/v4/spreadsheets');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({
        properties: { title: 'My Sheet' },
      });
      return jsonResponse(200, {
        spreadsheetId: 'sid-1',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sid-1/edit',
        properties: { title: 'My Sheet' },
      });
    });
    const r = await sheetsCreate({ title: 'My Sheet' }, deps(fetcher));
    expect(r.spreadsheet_id).toBe('sid-1');
    expect(r.spreadsheet_url).toBe(
      'https://docs.google.com/spreadsheets/d/sid-1/edit',
    );
    expect(r.title).toBe('My Sheet');
  });

  it('rejects empty title with schema error', async () => {
    const fetcher = makeFetchMock(async () => jsonResponse(200, {}));
    await expect(
      sheetsCreate({ title: '' }, deps(fetcher)),
    ).rejects.toThrow(/title \(string, non-empty\) is required/);
  });

  it('rejects unknown keys', async () => {
    const fetcher = makeFetchMock(async () => jsonResponse(200, {}));
    await expect(
      sheetsCreate(
        { title: 'ok', bogus: 1 } as Record<string, unknown>,
        deps(fetcher),
      ),
    ).rejects.toThrow(/unknown key/);
  });

  it('403 raises scope_insufficient error', async () => {
    const fetcher = makeFetchMock(async () =>
      new Response('forbidden', { status: 403 }),
    );
    await expect(
      sheetsCreate({ title: 'X' }, deps(fetcher)),
    ).rejects.toThrow(/scope_insufficient: HTTP 403/);
  });

  it('400 raises HTTP error with status code', async () => {
    const fetcher = makeFetchMock(async () =>
      new Response('bad request', { status: 400 }),
    );
    await expect(
      sheetsCreate({ title: 'X' }, deps(fetcher)),
    ).rejects.toThrow(/sheets_create HTTP 400/);
  });

  it('invalid JSON body raises invalid_json error', async () => {
    const fetcher = makeFetchMock(async () =>
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      sheetsCreate({ title: 'X' }, deps(fetcher)),
    ).rejects.toThrow(/sheets_create invalid_json/);
  });
});

describe('sheetsRead', () => {
  it('returns values + range + major_dimension', async () => {
    const fetcher = makeFetchMock(async () =>
      jsonResponse(200, {
        range: "'Sheet1'!A1:B2",
        values: [
          ['a', 'b'],
          ['c', 'd'],
        ],
        majorDimension: 'ROWS',
      }),
    );
    const r = await sheetsRead(
      { spreadsheet_id: 'spr', range: 'Sheet1!A1:B2' },
      deps(fetcher),
    );
    expect(r.values).toHaveLength(2);
    expect(r.major_dimension).toBe('ROWS');
  });

  it('rejects unknown keys', async () => {
    const fetcher = makeFetchMock(async () => jsonResponse(200, {}));
    await expect(
      sheetsRead(
        { spreadsheet_id: 'a', range: 'A1', bogus: 1 } as Record<string, unknown>,
        deps(fetcher),
      ),
    ).rejects.toThrow(/unknown key/);
  });
});

describe('sheetsAppend', () => {
  it('POSTs values, returns updated_cells', async () => {
    const fetcher = makeFetchMock(async () =>
      jsonResponse(200, {
        tableRange: "'Sheet1'!A1:B5",
        updates: { updatedRange: "'Sheet1'!A6:B6", updatedCells: 2 },
      }),
    );
    const r = await sheetsAppend(
      { spreadsheet_id: 'spr', range: 'Sheet1', values: [['x', 'y']] },
      deps(fetcher),
    );
    expect(r.updated_cells).toBe(2);
  });

  it('rejects non-2D values', async () => {
    const fetcher = makeFetchMock(async () => jsonResponse(200, {}));
    await expect(
      sheetsAppend(
        { spreadsheet_id: 'a', range: 'A1', values: 'not2d' as unknown as unknown[][] },
        deps(fetcher),
      ),
    ).rejects.toThrow(/2D list/);
  });
});

describe('sheetsUpdate', () => {
  it('PUTs values, returns updated_cells', async () => {
    const fetcher = makeFetchMock(async (_url, init) => {
      expect(init.method).toBe('PUT');
      return jsonResponse(200, { updatedRange: 'A1:B1', updatedCells: 2 });
    });
    const r = await sheetsUpdate(
      { spreadsheet_id: 'spr', range: 'A1:B1', values: [['x', 'y']] },
      deps(fetcher),
    );
    expect(r.updated_cells).toBe(2);
  });
});

describe('sheetsClear', () => {
  it('POSTs to values:clear and returns cleared_range', async () => {
    const fetcher = makeFetchMock(async (url, init) => {
      expect(url).toBe(
        'https://sheets.googleapis.com/v4/spreadsheets/spr/values/Sheet1!A:Z:clear',
      );
      expect(init.method).toBe('POST');
      return jsonResponse(200, { clearedRange: 'Sheet1!A:Z' });
    });
    const r = await sheetsClear(
      { spreadsheet_id: 'spr', range: 'Sheet1!A:Z' },
      deps(fetcher),
    );
    expect(r.cleared_range).toBe('Sheet1!A:Z');
  });
});
