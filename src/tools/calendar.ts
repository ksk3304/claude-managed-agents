/**
 * Google Calendar custom tools for the MAKOTO bridge.
 *
 * Calendar write operations are exposed as bot-side custom tools:
 * the agent never receives Google credentials, and destructive delete
 * requires a second turn with a confirmation token.
 */

import {
  GoogleApiToolError,
  ToolSchemaError,
  googleApiFetch,
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePositiveIntInRange,
  safeErrorSnippet,
  sha256Hex,
  type ConfirmTokenStore,
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

const CALENDAR_GET_EVENT_KNOWN_KEYS = new Set(['calendar_id', 'event_id']);

const CALENDAR_CREATE_EVENT_KNOWN_KEYS = new Set([
  'calendar_id',
  'summary',
  'start',
  'end',
  'description',
  'location',
  'attendees',
  'send_updates',
]);

const CALENDAR_UPDATE_EVENT_KNOWN_KEYS = new Set([
  'calendar_id',
  'event_id',
  'summary',
  'start',
  'end',
  'description',
  'location',
  'attendees',
  'send_updates',
]);

const CALENDAR_DELETE_EVENT_KNOWN_KEYS = new Set([
  'calendar_id',
  'event_id',
  'send_updates',
  'confirmation_token',
]);

const CALENDAR_DEFAULT_MAX_RESULTS = 10;
const CALENDAR_MAX_RESULTS_CAP = 50;
const CALENDAR_DELETE_TTL_MS = 600_000;

export interface CalendarToolDeps {
  accessToken: string;
  refreshAccessToken?: () => Promise<string>;
  fetcher?: Fetcher;
  confirmTokenStore?: ConfirmTokenStore;
  boundMessageId?: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: unknown;
  end: unknown;
  location?: string;
  description?: string;
  attendees?: unknown[];
  htmlLink?: string;
}

export interface CalendarListEventsResult {
  events: CalendarEvent[];
  count: number;
  truncated: boolean;
}

export interface CalendarMutationResult {
  id: string;
  summary: string;
  start: unknown;
  end: unknown;
  htmlLink?: string;
  status?: string;
}

export type CalendarDeleteOutcome =
  | {
      status: 'confirmation_required';
      token: string;
      message: string;
      event: CalendarEvent;
    }
  | {
      status: 'confirmation_stale';
      token: string;
      message: string;
      event: CalendarEvent;
    }
  | { status: 'deleted'; calendar_id: string; event_id: string };

function fetchOpts(deps: CalendarToolDeps): GoogleApiFetchOptions {
  const opts: GoogleApiFetchOptions = { accessToken: deps.accessToken };
  if (deps.refreshAccessToken) opts.refreshAccessToken = deps.refreshAccessToken;
  if (deps.fetcher) opts.fetcher = deps.fetcher;
  return opts;
}

function calendarIdFromInput(
  input: Record<string, unknown>,
  toolName: string,
): string {
  return input.calendar_id === undefined || input.calendar_id === null
    ? 'primary'
    : requireNonEmptyString(input.calendar_id, 'calendar_id', toolName);
}

function encodeCalendarId(calendarId: string): string {
  return encodeURIComponent(calendarId).replace(/%40/g, '@');
}

function eventPath(calendarId: string, eventId?: string): string {
  const base = `${CALENDAR_API_BASE}/calendars/${encodeCalendarId(calendarId)}/events`;
  if (!eventId) return base;
  return `${base}/${encodeURIComponent(eventId)}`;
}

function requireEventId(input: Record<string, unknown>, toolName: string): string {
  return requireNonEmptyString(input.event_id, 'event_id', toolName);
}

/**
 * List calendar events in `[time_min, time_max]`. Both bounds are
 * RFC3339 strings; the agent is responsible for using Asia/Tokyo.
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
  const calendarId = calendarIdFromInput(input, 'calendar_list_events');

  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(maxResults),
  });
  const resp = await googleApiFetch(
    `${eventPath(calendarId)}?${params.toString()}`,
    { method: 'GET' },
    fetchOpts(deps),
  );
  const body = await parseCalendarResponse(resp, 'calendar_list_events');
  const items = Array.isArray(body.items) ? body.items : [];
  const events = items.map(normalizeCalendarEvent);
  return {
    events,
    count: events.length,
    truncated: typeof body.nextPageToken === 'string' && body.nextPageToken.length > 0,
  };
}

export async function calendarGetEvent(
  input: Record<string, unknown>,
  deps: CalendarToolDeps,
): Promise<CalendarEvent> {
  rejectUnknownKeys(input, CALENDAR_GET_EVENT_KNOWN_KEYS, 'calendar_get_event');
  const calendarId = calendarIdFromInput(input, 'calendar_get_event');
  const eventId = requireEventId(input, 'calendar_get_event');
  const resp = await googleApiFetch(
    eventPath(calendarId, eventId),
    { method: 'GET' },
    fetchOpts(deps),
  );
  return normalizeCalendarEvent(await parseCalendarResponse(resp, 'calendar_get_event'));
}

export async function calendarCreateEvent(
  input: Record<string, unknown>,
  deps: CalendarToolDeps,
): Promise<CalendarMutationResult> {
  rejectUnknownKeys(input, CALENDAR_CREATE_EVENT_KNOWN_KEYS, 'calendar_create_event');
  const calendarId = calendarIdFromInput(input, 'calendar_create_event');
  const eventBody = buildCalendarEventBody(input, 'calendar_create_event', false);
  const sendUpdates = parseSendUpdates(input.send_updates, 'calendar_create_event');
  const params = new URLSearchParams({ sendUpdates });
  const resp = await googleApiFetch(
    `${eventPath(calendarId)}?${params.toString()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody),
    },
    fetchOpts(deps),
  );
  return normalizeCalendarMutation(await parseCalendarResponse(resp, 'calendar_create_event'));
}

export async function calendarUpdateEvent(
  input: Record<string, unknown>,
  deps: CalendarToolDeps,
): Promise<CalendarMutationResult> {
  rejectUnknownKeys(input, CALENDAR_UPDATE_EVENT_KNOWN_KEYS, 'calendar_update_event');
  const calendarId = calendarIdFromInput(input, 'calendar_update_event');
  const eventId = requireEventId(input, 'calendar_update_event');
  const eventBody = buildCalendarEventBody(input, 'calendar_update_event', true);
  const sendUpdates = parseSendUpdates(input.send_updates, 'calendar_update_event');
  const params = new URLSearchParams({ sendUpdates });
  const resp = await googleApiFetch(
    `${eventPath(calendarId, eventId)}?${params.toString()}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody),
    },
    fetchOpts(deps),
  );
  return normalizeCalendarMutation(await parseCalendarResponse(resp, 'calendar_update_event'));
}

export async function calendarDeleteEvent(
  input: Record<string, unknown>,
  deps: CalendarToolDeps,
): Promise<CalendarDeleteOutcome> {
  rejectUnknownKeys(input, CALENDAR_DELETE_EVENT_KNOWN_KEYS, 'calendar_delete_event');
  if (!deps.confirmTokenStore) {
    throw new GoogleApiToolError(
      'calendar_delete_event misconfigured: confirmTokenStore not provided to dispatcher',
    );
  }
  const calendarId = calendarIdFromInput(input, 'calendar_delete_event');
  const eventId = requireEventId(input, 'calendar_delete_event');
  const sendUpdates = parseSendUpdates(input.send_updates, 'calendar_delete_event');
  const token =
    typeof input.confirmation_token === 'string' && input.confirmation_token.length > 0
      ? input.confirmation_token
      : null;
  const confirmKey = calendarConfirmKey(calendarId, eventId);

  if (token === null) {
    const event = await calendarGetEvent({ calendar_id: calendarId, event_id: eventId }, deps);
    return issueCalendarDeleteConfirmation(
      confirmKey,
      event,
      deps,
      'この予定を削除します。実行するなら同じ event_id と confirmation_token を次のメッセージで再送してください。',
    );
  }

  const popped = await deps.confirmTokenStore.consume(token);
  if (!popped) {
    const event = await calendarGetEvent({ calendar_id: calendarId, event_id: eventId }, deps);
    return issueCalendarDeleteConfirmation(
      confirmKey,
      event,
      deps,
      'confirmation_token が見つかりません。新しい token で再確認してください。',
    );
  }
  if (
    popped.bound_message_id !== undefined &&
    deps.boundMessageId !== undefined &&
    popped.bound_message_id === deps.boundMessageId
  ) {
    const event = await calendarGetEvent({ calendar_id: calendarId, event_id: eventId }, deps);
    return issueCalendarDeleteConfirmation(
      confirmKey,
      event,
      deps,
      '同一メッセージ内での自己確認はできません。次の inbound message で confirmation_token を再送してください。',
    );
  }
  if (popped.file_id !== confirmKey) {
    throw new ToolSchemaError(
      'calendar_delete_event: confirmation_token does not match calendar_id/event_id',
    );
  }
  if (Date.now() - popped.created_at_ms > CALENDAR_DELETE_TTL_MS) {
    const event = await calendarGetEvent({ calendar_id: calendarId, event_id: eventId }, deps);
    return issueCalendarDeleteConfirmation(
      confirmKey,
      event,
      deps,
      'confirmation_token の有効期限が切れています。新しい token で再確認してください。',
    );
  }

  const event = await calendarGetEvent({ calendar_id: calendarId, event_id: eventId }, deps);
  const fingerprint = await calendarDeleteFingerprint(event);
  if (fingerprint !== popped.fingerprint) {
    return issueCalendarDeleteConfirmation(
      confirmKey,
      event,
      deps,
      '予定の内容が前回確認時と変わっています。再確認してください。',
      'confirmation_stale',
    );
  }

  const params = new URLSearchParams({ sendUpdates });
  const resp = await googleApiFetch(
    `${eventPath(calendarId, eventId)}?${params.toString()}`,
    { method: 'DELETE' },
    fetchOpts(deps),
  );
  if (resp.status === 410 || resp.status === 404) {
    return { status: 'deleted', calendar_id: calendarId, event_id: eventId };
  }
  if (!resp.ok) {
    const snippet = await safeErrorSnippet(resp);
    throw new GoogleApiToolError(
      `calendar_delete_event HTTP ${resp.status}: ${snippet}`,
      { status: resp.status, bodySnippet: snippet },
    );
  }
  return { status: 'deleted', calendar_id: calendarId, event_id: eventId };
}

function buildCalendarEventBody(
  input: Record<string, unknown>,
  toolName: string,
  requireEventShape: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const summary = requireNonEmptyString(input.summary, 'summary', toolName);
  body.summary = summary;
  body.start = requireCalendarDate(input.start, 'start', toolName);
  body.end = requireCalendarDate(input.end, 'end', toolName);
  if (typeof input.description === 'string') body.description = input.description;
  if (typeof input.location === 'string') body.location = input.location;
  if (input.attendees !== undefined) body.attendees = requireAttendees(input.attendees, toolName);
  if (requireEventShape && Object.keys(body).length === 0) {
    throw new ToolSchemaError(`${toolName}: at least one event field is required`);
  }
  return body;
}

function requireCalendarDate(value: unknown, fieldName: string, toolName: string): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolSchemaError(`${toolName}: ${fieldName} must be an object`);
  }
  const obj = value as Record<string, unknown>;
  const hasDateTime = typeof obj.dateTime === 'string' && obj.dateTime.trim().length > 0;
  const hasDate = typeof obj.date === 'string' && obj.date.trim().length > 0;
  if (hasDateTime === hasDate) {
    throw new ToolSchemaError(
      `${toolName}: ${fieldName} must contain exactly one of dateTime or date`,
    );
  }
  const out: Record<string, string> = {};
  if (hasDateTime) {
    out.dateTime = obj.dateTime as string;
    out.timeZone =
      typeof obj.timeZone === 'string' && obj.timeZone.trim().length > 0
        ? obj.timeZone.trim()
        : 'Asia/Tokyo';
  } else {
    out.date = obj.date as string;
  }
  return out;
}

function requireAttendees(value: unknown, toolName: string): Array<Record<string, string>> {
  if (!Array.isArray(value)) {
    throw new ToolSchemaError(`${toolName}: attendees must be an array`);
  }
  return value.map((entry) => {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      return { email: entry.trim() };
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const email = requireNonEmptyString(
        (entry as Record<string, unknown>).email,
        'attendees.email',
        toolName,
      );
      const out: Record<string, string> = { email };
      const displayName = (entry as Record<string, unknown>).displayName;
      if (typeof displayName === 'string' && displayName.trim().length > 0) {
        out.displayName = displayName.trim();
      }
      return out;
    }
    throw new ToolSchemaError(`${toolName}: each attendee must be email string or object`);
  });
}

function parseSendUpdates(value: unknown, toolName: string): string {
  if (value === undefined || value === null) return 'all';
  if (value !== 'all' && value !== 'externalOnly' && value !== 'none') {
    throw new ToolSchemaError(
      `${toolName}: send_updates must be 'all', 'externalOnly', or 'none'`,
    );
  }
  return value;
}

async function parseCalendarResponse(
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

function normalizeCalendarEvent(it: Record<string, unknown>): CalendarEvent {
  const event: CalendarEvent = {
    id: typeof it.id === 'string' ? it.id : '',
    summary: typeof it.summary === 'string' && it.summary.length > 0 ? it.summary : '(無題)',
    start: it.start,
    end: it.end,
  };
  if (typeof it.location === 'string') event.location = it.location;
  if (typeof it.description === 'string') event.description = it.description;
  if (Array.isArray(it.attendees)) event.attendees = it.attendees;
  if (typeof it.htmlLink === 'string') event.htmlLink = it.htmlLink;
  return event;
}

function normalizeCalendarMutation(it: Record<string, unknown>): CalendarMutationResult {
  const event = normalizeCalendarEvent(it);
  const result: CalendarMutationResult = {
    id: event.id,
    summary: event.summary,
    start: event.start,
    end: event.end,
  };
  if (event.htmlLink) result.htmlLink = event.htmlLink;
  if (typeof it.status === 'string') result.status = it.status;
  return result;
}

function calendarConfirmKey(calendarId: string, eventId: string): string {
  return `calendar:${calendarId}:${eventId}`;
}

async function issueCalendarDeleteConfirmation(
  confirmKey: string,
  event: CalendarEvent,
  deps: CalendarToolDeps,
  message: string,
  status: 'confirmation_required' | 'confirmation_stale' = 'confirmation_required',
): Promise<CalendarDeleteOutcome> {
  const token = await deps.confirmTokenStore!.issue(
    confirmKey,
    await calendarDeleteFingerprint(event),
    deps.boundMessageId,
  );
  return { status, token, message, event };
}

async function calendarDeleteFingerprint(event: CalendarEvent): Promise<string> {
  return sha256Hex(JSON.stringify({
    id: event.id,
    summary: event.summary,
    start: event.start,
    end: event.end,
    location: event.location ?? '',
    description: event.description ?? '',
  }));
}

export { ToolSchemaError };
