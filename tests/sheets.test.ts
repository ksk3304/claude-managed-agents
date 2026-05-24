/**
 * Unit tests for `src/tools/sheets.ts` — 4 Sheets custom tools.
 */

import { describe, it, expect } from 'vitest';
import {
  sheetsAppend,
  sheetsClear,
  sheetsGet,
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

describe('sheetsGet', () => {
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
    const r = await sheetsGet(
      { spreadsheet_id: 'spr', range: 'Sheet1!A1:B2' },
      deps(fetcher),
    );
    expect(r.values).toHaveLength(2);
    expect(r.major_dimension).toBe('ROWS');
  });

  it('rejects unknown keys', async () => {
    const fetcher = makeFetchMock(async () => jsonResponse(200, {}));
    await expect(
      sheetsGet(
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
  it('POSTs to :clear and returns cleared_range', async () => {
    const fetcher = makeFetchMock(async (url) => {
      expect(url).toContain(':clear');
      return jsonResponse(200, { clearedRange: 'A1:B5' });
    });
    const r = await sheetsClear({ spreadsheet_id: 'spr', range: 'A1:B5' }, deps(fetcher));
    expect(r.cleared_range).toBe('A1:B5');
  });
});
