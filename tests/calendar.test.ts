/**
 * Unit tests for `src/tools/calendar.ts` — calendar_list_events.
 */

import { describe, it, expect } from 'vitest';
import { calendarListEvents, type CalendarToolDeps } from '../src/tools/calendar';
import { makeFetchMock } from './makoto-helpers';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deps(fetcher: typeof fetch): CalendarToolDeps {
  return { accessToken: 'ya29.test', fetcher };
}

describe('calendarListEvents', () => {
  it('returns parsed events', async () => {
    const fetcher = makeFetchMock(async (url) => {
      expect(url).toContain('singleEvents=true');
      expect(url).toContain('orderBy=startTime');
      return jsonResponse(200, {
        items: [{ id: 'e1', summary: 'Meeting', start: {}, end: {}, location: 'Room A' }],
      });
    });
    const r = await calendarListEvents(
      { time_min: '2026-01-01T00:00:00Z', time_max: '2026-01-02T00:00:00Z' },
      deps(fetcher),
    );
    expect(r.count).toBe(1);
    expect(r.events[0]!.summary).toBe('Meeting');
    expect(r.events[0]!.location).toBe('Room A');
  });

  it('substitutes (無題) for missing summary', async () => {
    const fetcher = makeFetchMock(async () =>
      jsonResponse(200, { items: [{ id: 'e1', start: {}, end: {} }] }),
    );
    const r = await calendarListEvents(
      { time_min: '2026-01-01T00:00:00Z', time_max: '2026-01-02T00:00:00Z' },
      deps(fetcher),
    );
    expect(r.events[0]!.summary).toBe('(無題)');
  });

  it('reports truncation via nextPageToken', async () => {
    const fetcher = makeFetchMock(async () =>
      jsonResponse(200, { items: [], nextPageToken: 'tok' }),
    );
    const r = await calendarListEvents(
      { time_min: '2026-01-01T00:00:00Z', time_max: '2026-01-02T00:00:00Z' },
      deps(fetcher),
    );
    expect(r.truncated).toBe(true);
  });

  it('defaults calendar_id to primary', async () => {
    const fetcher = makeFetchMock(async (url) => {
      expect(url).toContain('/calendars/primary/events');
      return jsonResponse(200, { items: [] });
    });
    await calendarListEvents(
      { time_min: '2026-01-01T00:00:00Z', time_max: '2026-01-02T00:00:00Z' },
      deps(fetcher),
    );
  });

  it('rejects schema errors with ToolSchemaError', async () => {
    const fetcher = makeFetchMock(async () => jsonResponse(200, {}));
    await expect(
      calendarListEvents({ time_min: '' } as Record<string, unknown>, deps(fetcher)),
    ).rejects.toThrow();
  });
});
