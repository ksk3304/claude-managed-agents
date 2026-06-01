/**
 * Unit tests for `src/tools/calendar.ts` — Calendar custom tools.
 */

import { describe, it, expect } from 'vitest';
import {
  calendarCreateEvent,
  calendarDeleteEvent,
  calendarListEvents,
  calendarUpdateEvent,
  type CalendarToolDeps,
} from '../src/tools/calendar';
import { createKvConfirmTokenStore } from '../src/tools/tool-common';
import { makeFetchMock, makeKv } from './makoto-helpers';

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

describe('calendarCreateEvent', () => {
  it('posts a native Calendar event with sendUpdates defaulting to all', async () => {
    const fetcher = makeFetchMock(async (url, init) => {
      expect(url).toContain('/calendars/primary/events?sendUpdates=all');
      expect(init.method).toBe('POST');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.summary).toBe('商談');
      expect(body.start).toEqual({ dateTime: '2026-06-02T10:00:00+09:00', timeZone: 'Asia/Tokyo' });
      expect(body.attendees).toEqual([{ email: 'a@example.com' }]);
      return jsonResponse(200, {
        id: 'evt-1',
        summary: '商談',
        start: body.start,
        end: body.end,
        htmlLink: 'https://calendar.google.com/event?eid=evt-1',
      });
    });
    const r = await calendarCreateEvent(
      {
        summary: '商談',
        start: { dateTime: '2026-06-02T10:00:00+09:00' },
        end: { dateTime: '2026-06-02T11:00:00+09:00' },
        attendees: ['a@example.com'],
      },
      deps(fetcher),
    );
    expect(r.id).toBe('evt-1');
    expect(r.htmlLink).toContain('calendar.google.com');
  });
});

describe('calendarUpdateEvent', () => {
  it('puts a full replacement event and passes sendUpdates', async () => {
    const fetcher = makeFetchMock(async (url, init) => {
      expect(url).toContain('/calendars/primary/events/evt-1?sendUpdates=none');
      expect(init.method).toBe('PUT');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.summary).toBe('変更後');
      return jsonResponse(200, {
        id: 'evt-1',
        summary: '変更後',
        start: body.start,
        end: body.end,
        status: 'confirmed',
      });
    });
    const r = await calendarUpdateEvent(
      {
        event_id: 'evt-1',
        summary: '変更後',
        start: { date: '2026-06-02' },
        end: { date: '2026-06-03' },
        send_updates: 'none',
      },
      deps(fetcher),
    );
    expect(r.status).toBe('confirmed');
  });
});

describe('calendarDeleteEvent', () => {
  it('requires a second message confirmation before deleting', async () => {
    const fetcher = makeFetchMock(async (url, init) => {
      if (init.method === 'GET') {
        return jsonResponse(200, {
          id: 'evt-1',
          summary: '削除対象',
          start: { dateTime: '2026-06-02T10:00:00+09:00' },
          end: { dateTime: '2026-06-02T11:00:00+09:00' },
        });
      }
      expect(init.method).toBe('DELETE');
      expect(url).toContain('/calendars/primary/events/evt-1?sendUpdates=all');
      return new Response(null, { status: 204 });
    });
    const store = createKvConfirmTokenStore(makeKv());
    const step1 = await calendarDeleteEvent(
      { event_id: 'evt-1' },
      { ...deps(fetcher), confirmTokenStore: store, boundMessageId: 'msg-1' },
    );
    expect(step1.status).toBe('confirmation_required');
    const token = (step1 as { token: string }).token;
    const step2 = await calendarDeleteEvent(
      { event_id: 'evt-1', confirmation_token: token },
      { ...deps(fetcher), confirmTokenStore: store, boundMessageId: 'msg-2' },
    );
    expect(step2.status).toBe('deleted');
  });

  it('rejects same-message confirmation', async () => {
    const fetcher = makeFetchMock(async () =>
      jsonResponse(200, {
        id: 'evt-1',
        summary: '削除対象',
        start: { dateTime: '2026-06-02T10:00:00+09:00' },
        end: { dateTime: '2026-06-02T11:00:00+09:00' },
      }),
    );
    const store = createKvConfirmTokenStore(makeKv());
    const sameMessageDeps = { ...deps(fetcher), confirmTokenStore: store, boundMessageId: 'msg-1' };
    const step1 = await calendarDeleteEvent({ event_id: 'evt-1' }, sameMessageDeps);
    const token = (step1 as { token: string }).token;
    const step2 = await calendarDeleteEvent(
      { event_id: 'evt-1', confirmation_token: token },
      sameMessageDeps,
    );
    expect(step2.status).toBe('confirmation_required');
  });
});
