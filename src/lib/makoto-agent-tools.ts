import type { Agents } from '@anthropic-ai/sdk/resources/beta/agents/agents';

type CustomToolParam = Agents.BetaManagedAgentsCustomToolParams;

const stringProp = (description: string): Record<string, unknown> => ({
  type: 'string',
  description,
});

const objectProp = (description: string): Record<string, unknown> => ({
  type: 'object',
  description,
});

const arrayProp = (description: string): Record<string, unknown> => ({
  type: 'array',
  description,
});

export const MAKOTO_AGENT_CUSTOM_TOOLS: readonly CustomToolParam[] = [
  {
    type: 'custom',
    name: 'drive_search',
    description: 'Search Google Drive files accessible to the user.',
    input_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: stringProp('Drive search query.'),
        page_size: { type: 'integer', description: 'Maximum number of files.' },
        corpora: stringProp("'user' or 'allDrives'."),
        drive_id: stringProp('Optional shared drive id.'),
      },
    },
  },
  {
    type: 'custom',
    name: 'drive_get_file_metadata',
    description: 'Get Google Drive file metadata by file id.',
    input_schema: {
      type: 'object',
      required: ['file_id'],
      properties: {
        file_id: stringProp('Google Drive file id.'),
        fields: stringProp('Optional Drive API fields selector.'),
      },
    },
  },
  {
    type: 'custom',
    name: 'drive_read_export',
    description: 'Read or export text content from a Google Drive file.',
    input_schema: {
      type: 'object',
      required: ['file_id'],
      properties: {
        file_id: stringProp('Google Drive file id.'),
        format: stringProp("'text', 'markdown', or 'html'."),
        max_chars: { type: 'integer', description: 'Maximum characters to return.' },
      },
    },
  },
  {
    type: 'custom',
    name: 'drive_create_file',
    description: 'Create a Google Drive text file.',
    input_schema: {
      type: 'object',
      required: ['name', 'content'],
      properties: {
        name: stringProp('File name.'),
        content: stringProp('File content.'),
        mime_type: stringProp('MIME type. Defaults to text/plain.'),
        parents: arrayProp('Optional parent folder ids.'),
      },
    },
  },
  {
    type: 'custom',
    name: 'sheets_create',
    description: 'Create a Google Sheets spreadsheet.',
    input_schema: {
      type: 'object',
      required: ['title'],
      properties: { title: stringProp('Spreadsheet title.') },
    },
  },
  {
    type: 'custom',
    name: 'sheets_read',
    description: 'Read a range from a Google Sheets spreadsheet.',
    input_schema: {
      type: 'object',
      required: ['spreadsheet_id', 'range'],
      properties: {
        spreadsheet_id: stringProp('Spreadsheet id.'),
        range: stringProp('A1 notation range.'),
      },
    },
  },
  {
    type: 'custom',
    name: 'sheets_update',
    description: 'Overwrite a range in a Google Sheets spreadsheet.',
    input_schema: {
      type: 'object',
      required: ['spreadsheet_id', 'range', 'values'],
      properties: {
        spreadsheet_id: stringProp('Spreadsheet id.'),
        range: stringProp('A1 notation range.'),
        values: arrayProp('2D array of row values.'),
      },
    },
  },
  {
    type: 'custom',
    name: 'sheets_append',
    description: 'Append rows to the end of a Google Sheets table.',
    input_schema: {
      type: 'object',
      required: ['spreadsheet_id', 'range', 'values'],
      properties: {
        spreadsheet_id: stringProp('Spreadsheet id.'),
        range: stringProp('A1 notation anchor range.'),
        values: arrayProp('2D array of row values.'),
      },
    },
  },
  {
    type: 'custom',
    name: 'calendar_list_events',
    description: 'List Google Calendar events in a bounded time window.',
    input_schema: {
      type: 'object',
      required: ['time_min', 'time_max'],
      properties: {
        calendar_id: stringProp('Calendar id. Defaults to primary.'),
        time_min: stringProp('RFC3339 window start.'),
        time_max: stringProp('RFC3339 window end.'),
        max_results: { type: 'integer', description: 'Maximum events.' },
        query: stringProp('Optional free-text query.'),
      },
    },
  },
  {
    type: 'custom',
    name: 'calendar_get_event',
    description: 'Get one Google Calendar event by id.',
    input_schema: {
      type: 'object',
      required: ['event_id'],
      properties: {
        calendar_id: stringProp('Calendar id. Defaults to primary.'),
        event_id: stringProp('Calendar event id.'),
      },
    },
  },
  {
    type: 'custom',
    name: 'calendar_create_event',
    description: 'Create a Google Calendar event. Use Asia/Tokyo RFC3339 dateTime for Japanese requests.',
    input_schema: {
      type: 'object',
      required: ['summary', 'start', 'end'],
      properties: {
        calendar_id: stringProp('Calendar id. Defaults to primary.'),
        summary: stringProp('Event title.'),
        start: objectProp('Start object, e.g. {dateTime: "2026-06-02T10:00:00+09:00"}.'),
        end: objectProp('End object, e.g. {dateTime: "2026-06-02T11:30:00+09:00"}.'),
        location: stringProp('Optional event location.'),
        description: stringProp('Optional event description.'),
        attendees: arrayProp('Optional attendee email list.'),
        send_updates: stringProp("'all', 'externalOnly', or 'none'."),
      },
    },
  },
  {
    type: 'custom',
    name: 'calendar_update_event',
    description: 'Update a Google Calendar event by replacing summary, start, and end.',
    input_schema: {
      type: 'object',
      required: ['event_id', 'summary', 'start', 'end'],
      properties: {
        calendar_id: stringProp('Calendar id. Defaults to primary.'),
        event_id: stringProp('Calendar event id.'),
        summary: stringProp('Event title.'),
        start: objectProp('Start object.'),
        end: objectProp('End object.'),
        location: stringProp('Optional event location.'),
        description: stringProp('Optional event description.'),
        attendees: arrayProp('Optional attendee email list.'),
        send_updates: stringProp("'all', 'externalOnly', or 'none'."),
      },
    },
  },
  {
    type: 'custom',
    name: 'docs_create',
    description: 'Create a Google Docs document.',
    input_schema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: stringProp('Document title.'),
        initial_text: stringProp('Optional initial text.'),
      },
    },
  },
  {
    type: 'custom',
    name: 'docs_get',
    description: 'Read a Google Docs document body text and revision id.',
    input_schema: {
      type: 'object',
      required: ['document_id'],
      properties: {
        document_id: stringProp('Google Docs document id.'),
        max_chars: { type: 'integer', description: 'Maximum characters to return.' },
      },
    },
  },
  {
    type: 'custom',
    name: 'docs_batch_update',
    description: 'Apply Google Docs API batchUpdate requests.',
    input_schema: {
      type: 'object',
      required: ['document_id', 'requests'],
      properties: {
        document_id: stringProp('Google Docs document id.'),
        requests: arrayProp('Docs API batchUpdate request objects.'),
        write_control: objectProp('Optional Docs API writeControl.'),
      },
    },
  },
];

const DEPRECATED_MAKOTO_AGENT_TOOL_NAMES = new Set([
  'drive_delete',
  'calendar_delete_event',
]);

export function ensureMakotoAgentCustomTools(
  existingTools: unknown,
): { tools: unknown[]; added: string[]; present: string[]; removed: string[] } {
  const removed: string[] = [];
  const tools = (Array.isArray(existingTools) ? existingTools : []).filter((tool) => {
    const name =
      tool && typeof tool === 'object' ? (tool as { name?: unknown }).name : undefined;
    if (typeof name === 'string' && DEPRECATED_MAKOTO_AGENT_TOOL_NAMES.has(name)) {
      removed.push(name);
      return false;
    }
    return true;
  });
  const names = new Set(
    tools
      .map((tool) =>
        tool && typeof tool === 'object' ? (tool as { name?: unknown }).name : undefined,
      )
      .filter((name): name is string => typeof name === 'string'),
  );
  const added: string[] = [];
  const present: string[] = [];
  for (const tool of MAKOTO_AGENT_CUSTOM_TOOLS) {
    if (names.has(tool.name)) {
      present.push(tool.name);
      continue;
    }
    tools.push(tool);
    added.push(tool.name);
  }
  return { tools, added, present, removed };
}
