/**
 * Google Calendar custom tool for the MAKOTO bridge.
 *
 * One function (`calendarListEvents`) matching Python's
 * `_exec_calendar_list_events` in `scripts/cma_lib.py:1770`. Plan-draft
 * v3 deliberately ships only the read path here — MAKOTOくん's calendar
 * write surface (create/move/delete) lives behind a higher-trust
 * confirm flow that we don't expose in the auto-generated bridge.
 *
 * Stateless function, same `deps`-injection shape as `drive.ts` /
 * `sheets.ts`.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 8 — 層 6)
 */

import {
  GoogleApiToolError,
  ToolSchemaError,
  googleApiFetch,
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePositiveIntInRange,
  safeErrorSnippet,
  type Fetcher,
  type GoogleApiFetchOptions,
} from './tool-common';

export const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

const CALENDAR_LIST_EVENTS_KNOWN_KEYS = new Set([
  'time_min',
  'time_max',
  'max_results',
  'calendar_id',
]);

const CALENDAR_DEFAULT_MAX_RESULTS = 10;
const CALENDAR_MAX_RESULTS_CAP = 50;

export interface CalendarToolDeps {
  accessToken: string;
  refreshAccessToken?: () => Promise<string>;
  fetcher?: Fetcher;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: unknown;
  end: unknown;
  location?: string;
}

export interface CalendarListEventsResult {
  events: CalendarEvent[];
  count: number;
  truncated: boolean;
}

function fetchOpts(deps: CalendarToolDeps): GoogleApiFetchOptions {
  const opts: GoogleApiFetchOptions = { accessToken: deps.accessToken };
  if (deps.refreshAccessToken) opts.refreshAccessToken = deps.refreshAccessToken;
  if (deps.fetcher) opts.fetcher = deps.fetcher;
  return opts;
}

/**
 * List calendar events in `[time_min, time_max]`. Both bounds are
 * RFC3339 strings; we pass them verbatim to Google and let it parse —
 * the agent will see the API's own error if the format is off.
 *
 * `singleEvents=true` + `orderBy=startTime` are always set so recurring
 * events expand into individual instances, which is what the agent
 * actually needs to reason about ("does the user have a meeting at
 * 14:00 Tuesday").
 */
export async function calendarListEvents(
  input: Record<string, unknown>,
  deps: CalendarToolDeps,
): Promise<CalendarListEventsResult> {
  rejectUnknownKeys(input, CALENDAR_LIST_EVENTS_KNOWN_KEYS, 'calendar_list_events');
  const timeMin = requireNonEmptyString(input.time_min, 'time_min', 'calendar_list_events');
  const timeMax = requireNonEmptyString(input.time_max, 'time_max', 'calendar_list_events');
  const maxResults = requirePositiveIntInRange(
    input.max_results,
    'max_results',
    'calendar_list_events',
    1,
    CALENDAR_MAX_RESULTS_CAP,
    CALENDAR_DEFAULT_MAX_RESULTS,
  );
  const calendarId =
    input.calendar_id === undefined || input.calendar_id === null
      ? 'primary'
      : requireNonEmptyString(input.calendar_id, 'calendar_id', 'calendar_list_events');

  // Google's calendar id path segment can contain `@` (`primary` is
  // safe, but custom ids like `myteam@group.calendar.google.com` are
  // common). Python uses `urllib.parse.quote(calendar_id, safe="@")`;
  // replicate by encoding then restoring `@`.
  const encodedId = encodeURIComponent(calendarId).replace(/%40/g, '@');

  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(maxResults),
  });
  const url = `${CALENDAR_API_BASE}/calendars/${encodedId}/events?${params.toString()}`;
  const resp = await googleApiFetch(url, { method: 'GET' }, fetchOpts(deps));
  if (!resp.ok) {
    const snippet = await safeErrorSnippet(resp);
    if (resp.status === 403) {
      throw new GoogleApiToolError(
        `calendar_list_events scope_insufficient: HTTP 403: ${snippet}`,
        { status: 403, bodySnippet: snippet },
      );
    }
    throw new GoogleApiToolError(
      `calendar_list_events HTTP ${resp.status}: ${snippet}`,
      { status: resp.status, bodySnippet: snippet },
    );
  }
  let body: {
    items?: Array<{
      id?: string;
      summary?: string;
      start?: unknown;
      end?: unknown;
      location?: string;
    }>;
    nextPageToken?: string;
  };
  try {
    body = (await resp.json()) as typeof body;
  } catch {
    throw new GoogleApiToolError('calendar_list_events invalid_json');
  }
  if (!body || typeof body !== 'object') {
    throw new GoogleApiToolError(
      `calendar_list_events unexpected_response_type: ${typeof body}`,
    );
  }
  const items = Array.isArray(body.items) ? body.items : [];
  const events: CalendarEvent[] = items.map((it) => {
    const event: CalendarEvent = {
      id: typeof it.id === 'string' ? it.id : '',
      summary: typeof it.summary === 'string' && it.summary.length > 0 ? it.summary : '(無題)',
      start: it.start,
      end: it.end,
    };
    if (typeof it.location === 'string') event.location = it.location;
    return event;
  });
  return {
    events,
    count: events.length,
    truncated: typeof body.nextPageToken === 'string' && body.nextPageToken.length > 0,
  };
}

// `ToolSchemaError` is exported by the common module — re-exported
// here as a no-op so the `tools/calendar.ts` caller surface mirrors
// `tools/drive.ts` and `tools/sheets.ts`.
export { ToolSchemaError };
