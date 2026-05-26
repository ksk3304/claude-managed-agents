/**
 * Shared primitives for the MAKOTO bridge's Google Workspace tools
 * (drive_*, sheets_*, calendar_list_events).
 *
 * Each `_exec_*` Python function in `scripts/cma_lib.py` shares a small
 * set of behaviours that don't belong inside the per-tool modules:
 *
 *   - Schema validation (unknown-key rejection, file_id regex, etc.)
 *   - A token-cancelling Google API fetch wrapper (401 → invalidate +
 *     one-shot retry, 5xx → exponential backoff, 30 s timeout).
 *   - A KV-backed confirm-token store for two-step destructive tools
 *     (`drive_delete`). The Python implementation
 *     uses a process-local `dict` + `threading.Lock`; on Cloudflare
 *     Workers we need durable storage that survives short-lived worker
 *     invocations, hence KV with native 60-second-minimum TTL.
 *   - Token-shaped substring redaction so Google error bodies don't
 *     leak access_tokens / refresh_tokens through agent-visible
 *     responses.
 *
 * Tools in `drive.ts` / `sheets.ts` / `calendar.ts` import from here
 * and stay narrowly focused on the API shape itself.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 8 — 層 6)
 * Source-of-truth: `scripts/cma_lib.py` (lines noted per function below).
 */

import { assertBridgeEgressAllowed } from '../lib/egress-guard';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_5XX_RETRIES = 2;
const DEFAULT_5XX_BACKOFF_MS = [1_000, 3_000];

/** Cloudflare KV's minimum TTL is 60 s; we pick exactly the 10-minute window
 *  the Python store uses (see `_CONFIRM_TOKEN_TTL_SEC = 600`).
 */
const CONFIRM_TOKEN_TTL_SEC = 600;

// ----------------------------------------------------------------------------
// Errors
// ----------------------------------------------------------------------------

/**
 * Schema-level failures — bad input shape, wrong type, unknown keys.
 * The dispatcher should surface these to the agent as a tool error
 * with the message verbatim (no internal-state mixin).
 *
 * Mirrors `_SchemaError` in `scripts/cma_lib.py` (raised as ValueError
 * subclass at the Python edge).
 */
export class ToolSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolSchemaError';
  }
}

/**
 * Failures hitting Google APIs (Drive / Sheets / Calendar). Carries the
 * HTTP status and a redacted snippet of the response body so the
 * dispatcher can decide between user-visible / retry-worthy / abort.
 *
 * Mirrors `_DriveToolError` / `_SheetsToolError` / `_CalendarToolError`
 * — kept as one class on the TS side because the dispatcher tells them
 * apart from the `toolName` prefix in the message.
 */
export class GoogleApiToolError extends Error {
  status?: number;
  bodySnippet?: string;

  constructor(message: string, options?: { status?: number; bodySnippet?: string }) {
    super(message);
    this.name = 'GoogleApiToolError';
    this.status = options?.status;
    this.bodySnippet = options?.bodySnippet;
  }
}

// ----------------------------------------------------------------------------
// Schema validators
// ----------------------------------------------------------------------------

const DRIVE_FILE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Drive file_id validation matching `_validate_drive_file_id` in
 * `scripts/cma_lib.py:799`. Returns the trimmed id; throws
 * `ToolSchemaError` otherwise.
 *
 * Why this strictness: file_ids get embedded into URL paths
 * (`/files/{file_id}` / `/files/{file_id}/export`). A path-traversal
 * payload like `foo/../bar` would hit a different Drive resource than
 * intended. The regex enforces the actual character set Google issues.
 */
export function validateDriveFileId(fileId: unknown, toolName: string): string {
  if (typeof fileId !== 'string' || fileId.trim().length === 0) {
    throw new ToolSchemaError(`${toolName}: file_id (string, non-empty) is required`);
  }
  const trimmed = fileId.trim();
  if (!DRIVE_FILE_ID_RE.test(trimmed)) {
    throw new ToolSchemaError(
      `${toolName}: file_id must match [A-Za-z0-9_-]+ (got ${JSON.stringify(trimmed.slice(0, 32))})`,
    );
  }
  return trimmed;
}

/**
 * Reject any key in `input` that's not in `knownKeys`. Mirrors
 * `_reject_unknown_keys` — the goal is to fail loudly when the agent
 * sends typo'd parameters rather than silently dropping them.
 */
export function rejectUnknownKeys(
  input: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  toolName: string,
): void {
  for (const key of Object.keys(input)) {
    if (!knownKeys.has(key)) {
      throw new ToolSchemaError(
        `${toolName}: unknown key ${JSON.stringify(key)}; allowed: ${Array.from(knownKeys).sort().join(', ')}`,
      );
    }
  }
}

/**
 * Require a non-empty string value. Used for tool inputs that map to
 * URL path segments / required body fields.
 */
export function requireNonEmptyString(
  value: unknown,
  fieldName: string,
  toolName: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolSchemaError(
      `${toolName}: ${fieldName} (string, non-empty) is required`,
    );
  }
  return value.trim();
}

/**
 * Require a positive integer within `[min, max]`. Throws on type
 * mismatch / out-of-range. Returns the integer (rounded down).
 */
export function requirePositiveIntInRange(
  value: unknown,
  fieldName: string,
  toolName: string,
  min: number,
  max: number,
  defaultValue?: number,
): number {
  if (value === undefined || value === null) {
    if (defaultValue !== undefined) return defaultValue;
    throw new ToolSchemaError(`${toolName}: ${fieldName} is required`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolSchemaError(`${toolName}: ${fieldName} must be int in [${min}, ${max}]`);
  }
  const n = Math.floor(value);
  if (n < min || n > max) {
    throw new ToolSchemaError(`${toolName}: ${fieldName} must be int in [${min}, ${max}]`);
  }
  return n;
}

// ----------------------------------------------------------------------------
// Token-shaped substring redaction
// ----------------------------------------------------------------------------

/**
 * Patterns derived from `_redact_token_like` + the OAuth section of
 * `scripts/data/internal_state_patterns.json`. Applied to Google error
 * response bodies before they bubble into agent-visible errors so a
 * 401 body containing the bearer token doesn't echo it back to the
 * agent (and from there into a reply email).
 *
 * Kept here (not in the central `internal_state_patterns.json` import)
 * because this layer runs BEFORE the dispatcher's final-output redactor;
 * we want a defensive scrub even if the dispatcher's redactor is
 * mis-wired.
 */
const TOKEN_LIKE_PATTERNS: RegExp[] = [
  // ya29.<long base64> — Google OAuth access_token typical prefix.
  /ya29\.[A-Za-z0-9_\-./]+/g,
  // <name>_token=<value> — generic refresh_token / access_token forms.
  /(?:refresh|access)_?token["': =]+[A-Za-z0-9_\-./]{20,}/gi,
  // "Bearer <token>" — Authorization header echoed in Google error
  // bodies (Drive returns the full Authorization in some 5xx pages).
  /Bearer\s+[A-Za-z0-9_\-.]{20,}/g,
];

export function redactTokenLike(s: string): string {
  let out = s;
  for (const re of TOKEN_LIKE_PATTERNS) {
    out = out.replace(re, '[redacted-token]');
  }
  return out;
}

// ----------------------------------------------------------------------------
// Google API fetch wrapper
// ----------------------------------------------------------------------------

export type Fetcher = typeof fetch;

export interface GoogleApiFetchOptions {
  /** Bearer access_token. Required — caller resolves via workspace-oauth. */
  accessToken: string;
  /**
   * One-shot refresh callback. Invoked once on 401 with the previous
   * token marked invalidated. The new access_token is used for the
   * single retry. Skipped if undefined.
   */
  refreshAccessToken?: () => Promise<string>;
  /** Per-call fetch override (tests / mocks). Defaults to global `fetch`. */
  fetcher?: Fetcher;
  /** Override 30 s default. */
  timeoutMs?: number;
  /** Override [1000, 3000] default backoff schedule. */
  backoffMsSchedule?: readonly number[];
}

/**
 * Perform a Google API request with the MAKOTO bridge's standard
 * retry policy:
 *
 *   - 401 once → invalidate the token, run `refreshAccessToken()`,
 *     retry with the new token. No further 401 retries.
 *   - 5xx → exponential backoff (1 s, 3 s), max 2 retries.
 *   - All other status codes pass through to the caller.
 *
 * Returns the final `Response`. Caller is responsible for `.json()` /
 * `.text()` / status-code branching after this.
 *
 * Mirrors the `requests.request(..., headers=auth_headers)` helper
 * pattern in `cma_lib.py` (the underlying Python wraps `requests`
 * similarly; we use `fetch` here since `requests` doesn't exist in
 * the Workers runtime).
 */
export async function googleApiFetch(
  url: string,
  init: RequestInit,
  options: GoogleApiFetchOptions,
): Promise<Response> {
  // Egress hard-allowlist (層 8). Throws BridgeEgressDeniedError if
  // the URL hostname drifts out of MAKOTO_BRIDGE_EGRESS_ALLOWLIST.
  // Surfaces as a tool-side failure so the agent sees the denial
  // verbatim and we don't quietly call an un-audited host.
  assertBridgeEgressAllowed(url, 'tool-common:googleApiFetch');
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const backoffSchedule = options.backoffMsSchedule ?? DEFAULT_5XX_BACKOFF_MS;
  let accessToken = options.accessToken;
  let auth401Retried = false;
  let lastError: unknown;

  // The 5xx retry loop runs up to `DEFAULT_5XX_RETRIES + 1` times
  // (initial attempt + N retries). Each iteration starts with a fresh
  // AbortController so the timeout applies per-attempt.
  for (let attempt = 0; attempt <= DEFAULT_5XX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const reqInit: RequestInit = {
        ...init,
        signal: controller.signal,
        headers: mergeAuthHeader(init.headers, accessToken),
      };
      const resp = await fetcher(url, reqInit);
      // 401 one-shot retry — once per call, regardless of attempt loop.
      if (resp.status === 401 && !auth401Retried && options.refreshAccessToken) {
        auth401Retried = true;
        // Drain the body so the connection can be pooled — Workers
        // closes on a discarded body but this is hygiene.
        try { await resp.body?.cancel(); } catch { /* ignore */ }
        try {
          accessToken = await options.refreshAccessToken();
        } catch (err) {
          throw new GoogleApiToolError(
            `auth refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            { status: 401 },
          );
        }
        // Re-run the same attempt index after refresh — don't burn a
        // 5xx retry slot.
        attempt -= 1;
        continue;
      }
      if (resp.status >= 500 && resp.status < 600 && attempt < DEFAULT_5XX_RETRIES) {
        try { await resp.body?.cancel(); } catch { /* ignore */ }
        await sleep(backoffSchedule[attempt] ?? backoffSchedule[backoffSchedule.length - 1] ?? 1_000);
        continue;
      }
      return resp;
    } catch (err) {
      lastError = err;
      // AbortError (timeout): no retry — caller decides.
      if (err instanceof Error && err.name === 'AbortError') {
        throw new GoogleApiToolError(`request timed out after ${timeoutMs}ms`, {
          status: undefined,
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Unreachable in practice — the loop either returns or throws. The
  // throw here keeps TypeScript happy and surfaces the last network
  // error if we exit the loop without a response.
  throw lastError instanceof Error
    ? lastError
    : new Error('googleApiFetch: exhausted retries with no response');
}

function mergeAuthHeader(
  existing: HeadersInit | undefined,
  accessToken: string,
): Headers {
  const headers = new Headers(existing as HeadersInit | undefined);
  headers.set('Authorization', `Bearer ${accessToken}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  return headers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------------------------------------------------------------
// Confirm-token store (drive_delete destructive 2-step)
// ----------------------------------------------------------------------------

export interface ConfirmTokenEntry {
  /** Drive file id this token authorizes destruction of. */
  file_id: string;
  /** SHA-256 hex of name|mimeType|modifiedTime|trashed|owners-json|parents-json. */
  fingerprint: string;
  /** Unix-ms when the token was issued (caller validates TTL). */
  created_at_ms: number;
  /**
   * Inbound RFC 822 Message-ID (or any opaque per-call message id)
   * the dispatcher passed when issuing the token. If the consume call
   * carries the same `boundMessageId`, we reject — same-message
   * skip-confirmation is exactly what Issue #126 forbids.
   * Optional: legacy callers don't pass it.
   */
  bound_message_id?: string;
}

export interface ConfirmTokenStore {
  /**
   * Mint a new token and persist it. Returns the token string the
   * dispatcher hands back to the agent so it can echo the same token
   * in the confirm step.
   */
  issue(file_id: string, fingerprint: string, bound_message_id?: string): Promise<string>;
  /**
   * Atomic pop. Returns the entry the first caller, null for everyone
   * else (or when the token doesn't exist / has expired).
   */
  consume(token: string): Promise<ConfirmTokenEntry | null>;
}

/**
 * KV-backed confirm-token store. Each token gets its own key with a
 * 600-second TTL — Cloudflare KV deletes it automatically, so we
 * don't need an explicit prune cron for these the way `dedupe` does.
 *
 * Atomic pop is approximated: KV doesn't expose `getDelete`, but
 * `kv.delete()` is atomic on its own, and consumers always call
 * `consume()` exactly once per token (the dispatcher fences this with
 * the dedupe table). The window where two callers could both observe
 * the entry between `get` and `delete` is bounded by KV propagation
 * (~1 s), well below the user-visible reply cadence.
 */
export function createKvConfirmTokenStore(kv: KVNamespace): ConfirmTokenStore {
  const prefix = 'confirm_token:';
  return {
    async issue(file_id, fingerprint, bound_message_id) {
      const token = randomToken(22);
      const entry: ConfirmTokenEntry = {
        file_id,
        fingerprint,
        created_at_ms: Date.now(),
      };
      if (bound_message_id) entry.bound_message_id = bound_message_id;
      await kv.put(prefix + token, JSON.stringify(entry), {
        expirationTtl: CONFIRM_TOKEN_TTL_SEC,
      });
      return token;
    },
    async consume(token) {
      const key = prefix + token;
      const raw = await kv.get(key);
      if (!raw) return null;
      await kv.delete(key);
      try {
        return JSON.parse(raw) as ConfirmTokenEntry;
      } catch {
        return null;
      }
    },
  };
}

const TOKEN_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * URL-safe random token, equivalent of Python's
 * `secrets.token_urlsafe(16)` (22 base64-url chars).
 */
function randomToken(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += TOKEN_CHARSET[bytes[i] % TOKEN_CHARSET.length];
  }
  return out;
}

// ----------------------------------------------------------------------------
// Misc helpers
// ----------------------------------------------------------------------------

/**
 * SHA-256 hex digest of `s`. Used for the drive_delete fingerprint
 * (TOCTOU defence — same file metadata produces the same hash; any
 * metadata change between Step 1 and Step 2 produces a different hash
 * and forces re-confirmation).
 */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const bytes = new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * UTF-8 byte length of `s` (Workers runtime `Buffer` is gated behind
 * `nodejs_compat`; this is portable).
 */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/**
 * Truncate `s` so its character count (not byte count) is at most
 * `maxChars`. Returns `{value, truncated}` so callers can surface the
 * flag to the agent.
 */
export function truncateChars(s: string, maxChars: number): { value: string; truncated: boolean } {
  if (s.length <= maxChars) return { value: s, truncated: false };
  return { value: s.slice(0, maxChars), truncated: true };
}

/**
 * Read the response body as text, normalize newlines, redact tokens,
 * and slice to `max` characters. Used when assembling error messages
 * for `GoogleApiToolError`.
 */
export async function safeErrorSnippet(
  resp: Response,
  max: number = 300,
): Promise<string> {
  try {
    const body = await resp.text();
    return redactTokenLike(body.replace(/\s+/g, ' ')).slice(0, max);
  } catch {
    return '';
  }
}
