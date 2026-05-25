/**
 * MAKOTO 専用 tool dispatcher — bridges the bridge layer's
 * `sendAndStreamWithToolDispatch` event loop to the 10 Google Workspace
 * custom tools (drive / sheets / calendar) ported in layer 6.
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
 *   - `boundMessageId` is the inbound RFC 822 Message-ID. Only
 *     `drive_delete` consumes it (Issue #126 same-message-block
 *     enforcement); other tools accept it as a no-op so the dispatcher
 *     doesn't have to branch per-tool.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 — 層 7-4)
 * Spec: plan-draft.md §6 custom tools + impl-mid-2 R15 dispatcher wrap
 */

import {
  driveCreateDoc,
  driveDelete,
  driveGetFileMetadata,
  driveReadExport,
  driveSearch,
  type DriveToolDeps,
} from '../tools/drive';
import {
  sheetsAppend,
  sheetsClear,
  sheetsGet,
  sheetsUpdate,
  type SheetsToolDeps,
} from '../tools/sheets';
import {
  calendarListEvents,
  type CalendarToolDeps,
} from '../tools/calendar';
import {
  GoogleApiToolError,
  ToolSchemaError,
  createKvConfirmTokenStore,
} from '../tools/tool-common';
import { getAccessToken } from '../lib/workspace-oauth';
import { getOAuthLease } from '../durable-objects/oauth-lease';

/** Names of the 10 tools the MAKOTO bridge exposes to its agent. */
export type MakotoToolName =
  | 'drive_search'
  | 'drive_get_file_metadata'
  | 'drive_read_export'
  | 'drive_create_doc'
  | 'drive_delete'
  | 'sheets_get'
  | 'sheets_append'
  | 'sheets_update'
  | 'sheets_clear'
  | 'calendar_list_events';

export const MAKOTO_TOOL_NAMES: readonly MakotoToolName[] = [
  'drive_search',
  'drive_get_file_metadata',
  'drive_read_export',
  'drive_create_doc',
  'drive_delete',
  'sheets_get',
  'sheets_append',
  'sheets_update',
  'sheets_clear',
  'calendar_list_events',
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
  /** Inbound RFC 822 Message-ID — only meaningful for `drive_delete`. */
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
          await driveSearch(args, driveDeps(ctx, initialAccessToken, refreshAccessToken, false)),
        );
      case 'drive_get_file_metadata':
        return ok(
          await driveGetFileMetadata(
            args,
            driveDeps(ctx, initialAccessToken, refreshAccessToken, false),
          ),
        );
      case 'drive_read_export':
        return ok(
          await driveReadExport(args, driveDeps(ctx, initialAccessToken, refreshAccessToken, false)),
        );
      case 'drive_create_doc':
        return ok(
          await driveCreateDoc(args, driveDeps(ctx, initialAccessToken, refreshAccessToken, false)),
        );
      case 'drive_delete':
        // drive_delete requires the confirm token store + bound message id.
        return ok(
          await driveDelete(args, driveDeps(ctx, initialAccessToken, refreshAccessToken, true)),
        );
      case 'sheets_get':
        return ok(
          await sheetsGet(args, sheetsDeps(ctx, initialAccessToken, refreshAccessToken)),
        );
      case 'sheets_append':
        return ok(
          await sheetsAppend(args, sheetsDeps(ctx, initialAccessToken, refreshAccessToken)),
        );
      case 'sheets_update':
        return ok(
          await sheetsUpdate(args, sheetsDeps(ctx, initialAccessToken, refreshAccessToken)),
        );
      case 'sheets_clear':
        return ok(
          await sheetsClear(args, sheetsDeps(ctx, initialAccessToken, refreshAccessToken)),
        );
      case 'calendar_list_events':
        return ok(
          await calendarListEvents(args, calendarDeps(ctx, initialAccessToken, refreshAccessToken)),
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

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
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
  withConfirmStore: boolean,
): DriveToolDeps {
  const deps: DriveToolDeps = { accessToken, refreshAccessToken };
  if (ctx.fetchImpl) deps.fetcher = ctx.fetchImpl;
  if (withConfirmStore) {
    deps.confirmTokenStore = createKvConfirmTokenStore(ctx.env.MAKOTO_KV);
    if (ctx.boundMessageId) deps.boundMessageId = ctx.boundMessageId;
  }
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
