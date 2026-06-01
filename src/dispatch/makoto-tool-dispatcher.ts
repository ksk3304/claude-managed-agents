/**
 * MAKOTO 専用 tool dispatcher — bridges the bridge layer's
 * `sendAndStreamWithToolDispatch` event loop to the Google Workspace
 * custom tools (drive / sheets / calendar / docs) ported in layer 6.
 *
 * Why this layer exists (vs. wiring tools into `custom-tools-runtime`):
 *   The Cloudflare fork's `defineTool` / `CustomToolContext` exposes
 *   only `env` to the tool function; MAKOTOくん needs per-user OAuth
 *   credentials resolved from `sender_email → user_slug` at dispatch
 *   time. Rather than bend the upstream `CustomToolContext` (which is
 *   shared with the unrelated `cma-on-cf` agent loop), we keep the
 *   custom-tools-runtime untouched and route MAKOTO tool calls through
 *   this purpose-built dispatcher.
 *
 * Contract:
 *   - The layer-7 dispatcher (`agentmail-dispatch.ts`) calls
 *     `dispatchMakotoTool(name, input, ctx)` once per
 *     `agent.custom_tool_use` event observed on the SDK event stream.
 *   - We resolve the per-user access token via `workspace-oauth`
 *     (cached in KV for ~55 min). On 401 inside `googleApiFetch`, the
 *     wrapper calls `refreshAccessToken()` which busts the cache and
 *     re-fetches once.
 *   - `boundMessageId` is carried for audit compatibility with older
 *     destructive tools. No currently exposed MAKOTO workspace tool
 *     performs deletion.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 — 層 7-4)
 * Spec: plan-draft.md §6 custom tools + impl-mid-2 R15 dispatcher wrap
 */

import {
  driveCreateFile,
  driveGetFileMetadata,
  driveReadExport,
  driveSearch,
  driveUpdateFileContent,
  driveUpdateFileMetadata,
  type DriveToolDeps,
} from '../tools/drive';
import {
  sheetsAppend,
  sheetsCreate,
  sheetsRead,
  sheetsUpdate,
  type SheetsToolDeps,
} from '../tools/sheets';
import {
  calendarCreateEvent,
  calendarGetEvent,
  calendarListEvents,
  calendarUpdateEvent,
  type CalendarToolDeps,
} from '../tools/calendar';
import {
  docsBatchUpdate,
  docsCreate,
  docsGet,
  type DocsToolDeps,
} from '../tools/docs';
import {
  GoogleApiToolError,
  ToolSchemaError,
} from '../tools/tool-common';
import { getAccessToken } from '../lib/workspace-oauth';
import { getOAuthLease } from '../durable-objects/oauth-lease';

/** Names of the tools the MAKOTO bridge exposes to its agent. */
export type MakotoToolName =
  | 'drive_search'
  | 'drive_get_file_metadata'
  | 'drive_read_export'
  | 'drive_create_file'
  | 'drive_update_file_content'
  | 'drive_update_file_metadata'
  | 'sheets_create'
  | 'sheets_read'
  | 'sheets_update'
  | 'sheets_append'
  | 'calendar_list_events'
  | 'calendar_get_event'
  | 'calendar_create_event'
  | 'calendar_update_event'
  | 'docs_create'
  | 'docs_get'
  | 'docs_batch_update';

export const MAKOTO_TOOL_NAMES: readonly MakotoToolName[] = [
  'drive_search',
  'drive_get_file_metadata',
  'drive_read_export',
  'drive_create_file',
  'drive_update_file_content',
  'drive_update_file_metadata',
  'sheets_create',
  'sheets_read',
  'sheets_update',
  'sheets_append',
  'calendar_list_events',
  'calendar_get_event',
  'calendar_create_event',
  'calendar_update_event',
  'docs_create',
  'docs_get',
  'docs_batch_update',
];

const MAKOTO_TOOL_NAME_SET: ReadonlySet<string> = new Set(MAKOTO_TOOL_NAMES);

export function isMakotoToolName(name: string): name is MakotoToolName {
  return MAKOTO_TOOL_NAME_SET.has(name);
}

/**
 * Per-call context the dispatcher needs. `userSlug` is resolved by
 * layer 7 from `sender_email`; `boundMessageId` is the inbound RFC 822
 * Message-ID; `callerSessionId` is the Anthropic session id so the
 * OAuth audit row attributes Google API hits to the right session.
 */
export interface MakotoToolDispatchContext {
  env: Env;
  userSlug: string;
  /** Inbound RFC 822 Message-ID. Kept for audit/backward compatibility. */
  boundMessageId: string;
  /** Optional — passed to oauth_audit row. */
  callerSessionId?: string;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Result envelope the event-loop returns to the agent as the
 * `user.custom_tool_result` payload. `ok=false` sets `is_error: true`
 * on the SDK side (mirrors Python `_build_custom_tool_result` /
 * `_build_custom_tool_error` at cma_lib.py:2424-2440).
 */
export interface MakotoToolResult {
  ok: boolean;
  /** Serializable payload — JSON.stringify-able. */
  payload: unknown;
}

/**
 * Dispatch one custom tool call. Never throws — failure is always
 * encoded into `{ok: false, payload: {...}}` so the event loop can
 * forward it to the agent and continue.
 */
export async function dispatchMakotoTool(
  name: string,
  input: unknown,
  ctx: MakotoToolDispatchContext,
): Promise<MakotoToolResult> {
  if (!isMakotoToolName(name)) {
    return {
      ok: false,
      payload: {
        error: 'unknown_tool',
        message: `unknown tool: ${name}`,
        known_tools: MAKOTO_TOOL_NAMES,
      },
    };
  }

  // All MAKOTO tools take `Record<string, unknown>` input; coerce
  // unknown into that shape and reject non-objects loudly.
  if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      payload: {
        error: 'schema',
        tool: name,
        message: `${name}: input must be a JSON object (got ${describeType(input)})`,
      },
    };
  }
  const args = input as Record<string, unknown>;

  // Resolve per-user access token. Fail-close if the vault has no
  // entry — the agent must surface a clear "Workspace not connected"
  // error rather than silently degrading to no-results.
  const tokenResult = await resolveAccessToken(ctx);
  if (tokenResult.kind === 'fail') {
    return {
      ok: false,
      payload: {
        error: tokenResult.error,
        tool: name,
        message: tokenResult.message,
      },
    };
  }
  const initialAccessToken = tokenResult.access_token;

  // One-shot refresh callback: invalidate the KV access-token cache and
  // re-resolve. Triggered by `googleApiFetch` on the single 401 retry
  // per call (mirrors Python `cma_lib.py` `auth401Retried` flag).
  const refreshAccessToken = async (): Promise<string> => {
    await ctx.env.MAKOTO_KV.delete(`oauth:access:${ctx.userSlug}`);
    const refreshed = await resolveAccessToken(ctx);
    if (refreshed.kind === 'fail') {
      throw new GoogleApiToolError(
        `workspace_oauth refresh failed for ${ctx.userSlug}: ${refreshed.message}`,
        { status: 401 },
      );
    }
    return refreshed.access_token;
  };

  try {
    switch (name) {
      case 'drive_search':
        return ok(
          await driveSearch(args, driveDeps(ctx, initialAccessToken, refreshAccessToken)),
        );
      case 'drive_get_file_metadata':
        return ok(
          await driveGetFileMetadata(
            args,
            driveDeps(ctx, initialAccessToken, refreshAccessToken),
          ),
        );
      case 'drive_read_export':
        return ok(
          await driveReadExport(args, driveDeps(ctx, initialAccessToken, refreshAccessToken)),
        );
      case 'drive_create_file':
        return await verifiedDriveCreate(
          args,
          driveDeps(ctx, initialAccessToken, refreshAccessToken),
        );
      case 'drive_update_file_content':
        return await verifiedDriveUpdateContent(
          args,
          driveDeps(ctx, initialAccessToken, refreshAccessToken),
        );
      case 'drive_update_file_metadata':
        return await verifiedDriveUpdateMetadata(
          args,
          driveDeps(ctx, initialAccessToken, refreshAccessToken),
        );
      case 'sheets_create':
        return await verifiedSheetsCreate(
          args,
          sheetsDeps(ctx, initialAccessToken, refreshAccessToken),
        );
      case 'sheets_read':
        return ok(
          await sheetsRead(args, sheetsDeps(ctx, initialAccessToken, refreshAccessToken)),
        );
      case 'sheets_update':
        return await verifiedSheetsUpdate(
          args,
          sheetsDeps(ctx, initialAccessToken, refreshAccessToken),
        );
      case 'sheets_append':
        return await verifiedSheetsAppend(
          args,
          sheetsDeps(ctx, initialAccessToken, refreshAccessToken),
        );
      case 'calendar_list_events':
        return ok(
          await calendarListEvents(args, calendarDeps(ctx, initialAccessToken, refreshAccessToken)),
        );
      case 'calendar_get_event':
        return ok(
          await calendarGetEvent(args, calendarDeps(ctx, initialAccessToken, refreshAccessToken)),
        );
      case 'calendar_create_event':
        return await verifiedCalendarCreate(
          args,
          calendarDeps(ctx, initialAccessToken, refreshAccessToken),
        );
      case 'calendar_update_event':
        return await verifiedCalendarUpdate(
          args,
          calendarDeps(ctx, initialAccessToken, refreshAccessToken),
        );
      case 'docs_create':
        return await verifiedDocsCreate(
          args,
          docsDeps(ctx, initialAccessToken, refreshAccessToken),
        );
      case 'docs_get':
        return ok(
          await docsGet(args, docsDeps(ctx, initialAccessToken, refreshAccessToken)),
        );
      case 'docs_batch_update':
        return await verifiedDocsBatchUpdate(
          args,
          docsDeps(ctx, initialAccessToken, refreshAccessToken),
        );
    }
  } catch (err) {
    if (err instanceof ToolSchemaError) {
      return {
        ok: false,
        payload: { error: 'schema', tool: name, message: err.message },
      };
    }
    if (err instanceof GoogleApiToolError) {
      const payload: Record<string, unknown> = {
        error: 'google_api',
        tool: name,
        message: err.message,
      };
      if (err.status !== undefined) payload.status = err.status;
      if (err.bodySnippet !== undefined) payload.body_snippet = err.bodySnippet;
      return { ok: false, payload };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      payload: { error: 'unexpected', tool: name, message },
    };
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function ok(payload: unknown): MakotoToolResult {
  return { ok: true, payload };
}

function verificationOk(
  tool: MakotoToolName,
  result: unknown,
  readback: unknown,
  checked: string[],
): MakotoToolResult {
  return {
    ok: true,
    payload: {
      verified: true,
      tool,
      result,
      readback,
      verification: { checked, mismatches: [] },
    },
  };
}

function verificationFail(
  tool: MakotoToolName,
  result: unknown,
  readback: unknown,
  checked: string[],
  mismatches: string[],
): MakotoToolResult {
  return {
    ok: false,
    payload: {
      error: 'verification_failed',
      tool,
      message: `${tool}: write succeeded but readback did not match`,
      result,
      readback,
      verification: { checked, mismatches },
    },
  };
}

function verificationMissing(
  tool: MakotoToolName,
  result: unknown,
  message: string,
): MakotoToolResult {
  return {
    ok: false,
    payload: {
      error: 'verification_failed',
      tool,
      message,
      result,
      verification: { checked: [], mismatches: ['readback_target_missing'] },
    },
  };
}

async function verifiedDriveCreate(
  args: Record<string, unknown>,
  deps: DriveToolDeps,
): Promise<MakotoToolResult> {
  const result = await driveCreateFile(args, deps);
  if (typeof result.id !== 'string' || !result.id) {
    return verificationMissing('drive_create_file', result, 'drive_create_file: created file id missing');
  }
  const readback = await driveGetFileMetadata({
    file_id: result.id,
    fields: 'id,name,mimeType,modifiedTime,description,starred,webViewLink,parents',
  }, deps);
  const mismatches: string[] = [];
  if (typeof args.name === 'string' && prop(readback, 'name') !== args.name) {
    mismatches.push('name');
  }
  if (typeof args.mime_type === 'string' && prop(readback, 'mimeType') !== args.mime_type) {
    mismatches.push('mimeType');
  }
  const checked = ['id', 'name', 'mimeType'];
  return mismatches.length === 0
    ? verificationOk('drive_create_file', result, readback, checked)
    : verificationFail('drive_create_file', result, readback, checked, mismatches);
}

async function verifiedDriveUpdateContent(
  args: Record<string, unknown>,
  deps: DriveToolDeps,
): Promise<MakotoToolResult> {
  const result = await driveUpdateFileContent(args, deps);
  const fileId = typeof result.id === 'string' && result.id ? result.id : args.file_id;
  if (typeof fileId !== 'string' || !fileId) {
    return verificationMissing('drive_update_file_content', result, 'drive_update_file_content: file id missing');
  }
  const readback = await driveReadExport({ file_id: fileId, format: 'text', max_chars: 200000 }, deps);
  const mismatches =
    typeof args.content === 'string' && readback.content === args.content ? [] : ['content'];
  const checked = ['content'];
  return mismatches.length === 0
    ? verificationOk('drive_update_file_content', result, readback, checked)
    : verificationFail('drive_update_file_content', result, readback, checked, mismatches);
}

async function verifiedDriveUpdateMetadata(
  args: Record<string, unknown>,
  deps: DriveToolDeps,
): Promise<MakotoToolResult> {
  const result = await driveUpdateFileMetadata(args, deps);
  const fileId = typeof result.id === 'string' && result.id ? result.id : args.file_id;
  if (typeof fileId !== 'string' || !fileId) {
    return verificationMissing('drive_update_file_metadata', result, 'drive_update_file_metadata: file id missing');
  }
  const readback = await driveGetFileMetadata({
    file_id: fileId,
    fields: 'id,name,mimeType,modifiedTime,description,starred,webViewLink,parents',
  }, deps);
  const mismatches = compareObjectFields(args, readback, ['name', 'description', 'starred']);
  const checked = ['id', ...Object.keys(args).filter((key) => ['name', 'description', 'starred'].includes(key))];
  return mismatches.length === 0
    ? verificationOk('drive_update_file_metadata', result, readback, checked)
    : verificationFail('drive_update_file_metadata', result, readback, checked, mismatches);
}

async function verifiedSheetsCreate(
  args: Record<string, unknown>,
  deps: SheetsToolDeps,
): Promise<MakotoToolResult> {
  const result = await sheetsCreate(args, deps);
  if (typeof result.spreadsheet_id !== 'string' || !result.spreadsheet_id) {
    return verificationMissing('sheets_create', result, 'sheets_create: spreadsheet id missing');
  }
  const readback = await sheetsRead({ spreadsheet_id: result.spreadsheet_id, range: 'A1' }, deps);
  return verificationOk('sheets_create', result, readback, ['spreadsheet_id_readable']);
}

async function verifiedSheetsUpdate(
  args: Record<string, unknown>,
  deps: SheetsToolDeps,
): Promise<MakotoToolResult> {
  const result = await sheetsUpdate(args, deps);
  const readback = await sheetsRead({
    spreadsheet_id: args.spreadsheet_id,
    range: args.range,
  }, deps);
  const mismatches = valuesEqual((readback as { values?: unknown }).values, args.values)
    ? []
    : ['values'];
  const checked = ['values'];
  return mismatches.length === 0
    ? verificationOk('sheets_update', result, readback, checked)
    : verificationFail('sheets_update', result, readback, checked, mismatches);
}

async function verifiedSheetsAppend(
  args: Record<string, unknown>,
  deps: SheetsToolDeps,
): Promise<MakotoToolResult> {
  const result = await sheetsAppend(args, deps);
  const updatedRange =
    typeof result.updated_range === 'string' && result.updated_range
      ? result.updated_range
      : args.range;
  const readback = await sheetsRead({
    spreadsheet_id: args.spreadsheet_id,
    range: updatedRange,
  }, deps);
  const mismatches = valuesEqual((readback as { values?: unknown }).values, args.values)
    ? []
    : ['values'];
  const checked = ['updated_range', 'values'];
  return mismatches.length === 0
    ? verificationOk('sheets_append', result, readback, checked)
    : verificationFail('sheets_append', result, readback, checked, mismatches);
}

async function verifiedCalendarCreate(
  args: Record<string, unknown>,
  deps: CalendarToolDeps,
): Promise<MakotoToolResult> {
  const result = await calendarCreateEvent(args, deps);
  if (!result.id) {
    return verificationMissing('calendar_create_event', result, 'calendar_create_event: event id missing');
  }
  const readback = await calendarGetEvent(calendarGetInput(args, result.id), deps);
  const { checked, mismatches } = compareCalendarMutation(args, readback);
  return mismatches.length === 0
    ? verificationOk('calendar_create_event', result, readback, checked)
    : verificationFail('calendar_create_event', result, readback, checked, mismatches);
}

async function verifiedCalendarUpdate(
  args: Record<string, unknown>,
  deps: CalendarToolDeps,
): Promise<MakotoToolResult> {
  const result = await calendarUpdateEvent(args, deps);
  const eventId = typeof args.event_id === 'string' && args.event_id ? args.event_id : result.id;
  if (!eventId) {
    return verificationMissing('calendar_update_event', result, 'calendar_update_event: event id missing');
  }
  const readback = await calendarGetEvent(calendarGetInput(args, eventId), deps);
  const { checked, mismatches } = compareCalendarMutation(args, readback);
  return mismatches.length === 0
    ? verificationOk('calendar_update_event', result, readback, checked)
    : verificationFail('calendar_update_event', result, readback, checked, mismatches);
}

async function verifiedDocsCreate(
  args: Record<string, unknown>,
  deps: DocsToolDeps,
): Promise<MakotoToolResult> {
  const result = await docsCreate(args, deps);
  if (typeof result.document_id !== 'string' || !result.document_id) {
    return verificationMissing('docs_create', result, 'docs_create: document id missing');
  }
  const readback = await docsGet({ document_id: result.document_id, max_chars: 200000 }, deps);
  const mismatches: string[] = [];
  if (typeof args.title === 'string' && (readback as { title?: unknown }).title !== args.title) {
    mismatches.push('title');
  }
  if (
    typeof args.initial_text === 'string' &&
    args.initial_text.length > 0 &&
    !(readback as { body_text?: unknown }).body_text?.toString().includes(args.initial_text)
  ) {
    mismatches.push('initial_text');
  }
  const checked = ['document_id', 'title'];
  if (typeof args.initial_text === 'string' && args.initial_text.length > 0) checked.push('initial_text');
  return mismatches.length === 0
    ? verificationOk('docs_create', result, readback, checked)
    : verificationFail('docs_create', result, readback, checked, mismatches);
}

async function verifiedDocsBatchUpdate(
  args: Record<string, unknown>,
  deps: DocsToolDeps,
): Promise<MakotoToolResult> {
  const result = await docsBatchUpdate(args, deps);
  const documentId = typeof args.document_id === 'string' ? args.document_id : result.document_id;
  if (!documentId) {
    return verificationMissing('docs_batch_update', result, 'docs_batch_update: document id missing');
  }
  const readback = await docsGet({ document_id: documentId, max_chars: 200000 }, deps);
  const expectedText = collectInsertedDocsText(args.requests);
  const bodyText = String((readback as { body_text?: unknown }).body_text ?? '');
  const mismatches = expectedText.filter((text) => !bodyText.includes(text)).map((_, i) => `insertText[${i}]`);
  const checked = expectedText.length > 0 ? ['insertText'] : ['document_readback'];
  return mismatches.length === 0
    ? verificationOk('docs_batch_update', result, readback, checked)
    : verificationFail('docs_batch_update', result, readback, checked, mismatches);
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function calendarGetInput(args: Record<string, unknown>, eventId: string): Record<string, unknown> {
  const input: Record<string, unknown> = { event_id: eventId };
  if (typeof args.calendar_id === 'string' && args.calendar_id) input.calendar_id = args.calendar_id;
  return input;
}

function compareCalendarMutation(
  args: Record<string, unknown>,
  readback: unknown,
): { checked: string[]; mismatches: string[] } {
  const checked: string[] = [];
  const mismatches: string[] = [];
  if (typeof args.summary === 'string') {
    checked.push('summary');
    if (prop(readback, 'summary') !== args.summary) mismatches.push('summary');
  }
  if (args.start !== undefined) {
    checked.push('start');
    if (!calendarDateEqual(args.start, prop(readback, 'start'))) mismatches.push('start');
  }
  if (args.end !== undefined) {
    checked.push('end');
    if (!calendarDateEqual(args.end, prop(readback, 'end'))) mismatches.push('end');
  }
  if (typeof args.location === 'string') {
    checked.push('location');
    if (prop(readback, 'location') !== args.location) mismatches.push('location');
  }
  if (typeof args.description === 'string') {
    checked.push('description');
    if (prop(readback, 'description') !== args.description) mismatches.push('description');
  }
  return { checked, mismatches };
}

function calendarDateEqual(expected: unknown, actual: unknown): boolean {
  if (!isRecord(expected) || !isRecord(actual)) return false;
  if (typeof expected.dateTime === 'string') return actual.dateTime === expected.dateTime;
  if (typeof expected.date === 'string') return actual.date === expected.date;
  return false;
}

function compareObjectFields(
  expected: Record<string, unknown>,
  actual: unknown,
  fields: string[],
): string[] {
  if (!isRecord(actual)) return fields.filter((field) => expected[field] !== undefined);
  return fields.filter((field) => expected[field] !== undefined && actual[field] !== expected[field]);
}

function collectInsertedDocsText(requests: unknown): string[] {
  if (!Array.isArray(requests)) return [];
  const texts: string[] = [];
  for (const request of requests) {
    if (!isRecord(request) || !isRecord(request.insertText)) continue;
    const text = request.insertText.text;
    if (typeof text === 'string' && text.length > 0) texts.push(text);
  }
  return texts;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function prop(obj: unknown, key: string): unknown {
  return isRecord(obj) ? obj[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type AccessTokenResolution =
  | { kind: 'ok'; access_token: string }
  | { kind: 'fail'; error: string; message: string };

async function resolveAccessToken(
  ctx: MakotoToolDispatchContext,
): Promise<AccessTokenResolution> {
  const env = ctx.env;
  if (!env.OAUTH_VAULT_KEY) {
    return {
      kind: 'fail',
      error: 'oauth_misconfigured',
      message: 'OAUTH_VAULT_KEY secret not set on this Worker',
    };
  }
  if (!env.OAUTH_CLIENT_ID || !env.OAUTH_CLIENT_SECRET) {
    return {
      kind: 'fail',
      error: 'oauth_misconfigured',
      message: 'OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET secret not set on this Worker',
    };
  }
  let token;
  try {
    const deps = {
      db: env.DB,
      kv: env.MAKOTO_KV,
      vaultKeyB64: env.OAUTH_VAULT_KEY,
      clientId: env.OAUTH_CLIENT_ID,
      clientSecret: env.OAUTH_CLIENT_SECRET,
      // OAuth lease DO: serialises in-flight refreshes + audit log
      // writes per user_slug (plan v4 §5.4.3). Wired here so every
      // custom-tool dispatch goes through the same lease.
      oauthLease: getOAuthLease(env, ctx.userSlug),
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    };
    const opts = ctx.callerSessionId ? { callerSessionId: ctx.callerSessionId } : {};
    token = await getAccessToken(deps, ctx.userSlug, opts);
  } catch (err) {
    return {
      kind: 'fail',
      error: 'oauth_vault_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (token === null) {
    return {
      kind: 'fail',
      error: 'oauth_missing',
      message: `no refresh_token in vault for user_slug=${ctx.userSlug} (bootstrap required)`,
    };
  }
  return { kind: 'ok', access_token: token.access_token };
}

function driveDeps(
  ctx: MakotoToolDispatchContext,
  accessToken: string,
  refreshAccessToken: () => Promise<string>,
): DriveToolDeps {
  const deps: DriveToolDeps = { accessToken, refreshAccessToken };
  if (ctx.fetchImpl) deps.fetcher = ctx.fetchImpl;
  return deps;
}

function sheetsDeps(
  ctx: MakotoToolDispatchContext,
  accessToken: string,
  refreshAccessToken: () => Promise<string>,
): SheetsToolDeps {
  const deps: SheetsToolDeps = { accessToken, refreshAccessToken };
  if (ctx.fetchImpl) deps.fetcher = ctx.fetchImpl;
  return deps;
}

function calendarDeps(
  ctx: MakotoToolDispatchContext,
  accessToken: string,
  refreshAccessToken: () => Promise<string>,
): CalendarToolDeps {
  const deps: CalendarToolDeps = { accessToken, refreshAccessToken };
  if (ctx.fetchImpl) deps.fetcher = ctx.fetchImpl;
  return deps;
}

function docsDeps(
  ctx: MakotoToolDispatchContext,
  accessToken: string,
  refreshAccessToken: () => Promise<string>,
): DocsToolDeps {
  const deps: DocsToolDeps = { accessToken, refreshAccessToken };
  if (ctx.fetchImpl) deps.fetcher = ctx.fetchImpl;
  return deps;
}
