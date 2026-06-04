/**
 * Anthropic Managed-Agents session helpers — wraps
 * `client.beta.sessions.create` / `events.send` / `events.stream` for
 * the AgentMail bridge.
 *
 * Two entry points the bridge uses:
 *   - `createSessionWithResources` — fresh session for first-contact
 *     mail (or any time we couldn't resolve an existing session id).
 *   - `sendAndStream` — send a single `user.message` event into an
 *     existing session and drain the event stream until terminal,
 *     collecting any EMAIL_SEND markers along the way.
 *
 * Event handling defers to the SDK's `events.stream` async iterator;
 * we don't reinvent the SSE plumbing. Terminal events
 * (`session.status_idle`, `session.status_terminated`) end the loop.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 5 — 層 3)
 * Spec: plan-draft.md §4 session + A24 (agent: vs agent_id: SDK shape)
 */

import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_BETA, resolveAnthropicApiKey } from '../anthropic';
import type { MemoryStoreResourceParam } from '../types/memory';
import type { EmailSendMarker } from '../types/agentmail';
import { parseEmailSendMarkers } from './email-send-marker';
import {
  saveUserMessagePayloadAudit,
  type PayloadAuditConfig,
} from './payload-audit';

/**
 * Build an Anthropic SDK client. Mirrors `email-handler.ts:emailClient`
 * so the bridge keeps one client-construction pattern across handlers.
 * Returns null when no API key is configured — callers decide whether
 * that is fatal.
 */
export function buildAnthropicClient(env: Env): Anthropic | null {
  const apiKey = resolveAnthropicApiKey(env);
  if (!apiKey) return null;
  const baseURL = env.ANTHROPIC_BASE_URL || undefined;
  return new Anthropic({
    apiKey,
    baseURL,
  });
}

export interface CreateSessionInput {
  agentId: string;
  environmentId: string;
  /** Memory Stores to attach. Empty array is permitted (rare). */
  resources: MemoryStoreResourceParam[];
  /** Vault ids to pass through to sessions.create for MCP credentials. */
  vaultIds?: string[];
  /**
   * Per-user system-prompt addendum. Surfaced as an `instructions`
   * resource if present — the SDK's `sessions.create` accepts a
   * free-form addendum via the `instructions` field on each resource.
   * For now we leave system_prompt_addendum out of the on-wire
   * payload (the agent's persona is already defined Console-side);
   * if/when we surface it, attach it as a `memory_store` with
   * `access: 'read_only'`.
   */
  systemPromptAddendum?: string;
}

/**
 * Create a fresh session and attach the supplied resources. Returns
 * the new session id. Throws on SDK error — callers wrap with
 * audit-logged try/catch as needed.
 */
export async function createSessionWithResources(
  client: Anthropic,
  input: CreateSessionInput,
): Promise<string> {
  // SDK key is `agent:` not `agent_id:` — confirmed against
  // node_modules/@anthropic-ai/sdk and cma_lib.py:2820-2838 +
  // email-handler.ts:453-456 (plan-draft A24).
  const created = await client.beta.sessions.create({
    agent: input.agentId,
    environment_id: input.environmentId,
    resources: input.resources,
    ...(input.vaultIds && input.vaultIds.length > 0 ? { vault_ids: input.vaultIds } : {}),
    betas: [ANTHROPIC_BETA],
  } as Parameters<typeof client.beta.sessions.create>[0]);
  if (typeof created.id !== 'string' || created.id.length === 0) {
    throw new Error('sessions.create returned no id');
  }
  return created.id;
}

export interface ManagedSessionUsageSnapshot {
  usage: Record<string, unknown> | null;
  model?: string | null;
}

export async function retrieveSessionUsageSnapshot(
  client: Anthropic,
  sessionId: string,
): Promise<ManagedSessionUsageSnapshot | null> {
  try {
    const sessions = client.beta.sessions as unknown as {
      retrieve: (
        id: string,
        params?: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };
    if (typeof sessions.retrieve !== 'function') return null;
    const session = await sessions.retrieve(sessionId, {
      betas: [ANTHROPIC_BETA],
    });
    const usage =
      session.usage && typeof session.usage === 'object'
        ? (session.usage as Record<string, unknown>)
        : null;
    const model =
      typeof session.model === 'string'
        ? session.model
        : typeof (session.agent as Record<string, unknown> | undefined)?.model === 'string'
          ? ((session.agent as Record<string, unknown>).model as string)
          : null;
    return { usage, model };
  } catch (err) {
    console.warn(
      `[session] sessions.retrieve usage failed sessionId=${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * User message content block — the SDK accepts an array of typed blocks
 * (`text` / `image` / `document` / etc) on `user.message`. The bridge
 * doesn't model every block variant exhaustively; consumers (e.g. the
 * attachment-processing helper) pass already-typed blocks and the
 * caller can prepend / append extra blocks alongside the main text.
 *
 * Issue: ksk3304/makoto-prime#186 既知 #1 + O (image / PDF / Office 添付).
 */
export type UserMessageContentBlock = Record<string, unknown> & { type: string };

export interface SendAndStreamInput {
  sessionId: string;
  /**
   * User message to inject. `string` (plain text) は単一 text block に
   * wrap される。content block 配列を直接渡すと (画像 / 文書 / 追加 text を
   * 含む) そのまま `user.message.content` に乗る。
   */
  userMessage: string | UserMessageContentBlock[];
  /** Hard cap on wall time the event loop is willing to wait. */
  timeoutMs?: number;
  /** Optional short-lived audit of the exact user.message payload. */
  payloadAudit?: PayloadAuditConfig;
}

export interface SendAndStreamResult {
  /** Combined text the agent emitted across all `*.text*` events. */
  assistantText: string;
  /**
   * EMAIL_SEND markers extracted from the assistant text — each
   * becomes one outbound AgentMail call.
   */
  emailSendMarkers: EmailSendMarker[];
  /** Last terminal event type observed (`session.status_idle`/`session.status_terminated`). */
  terminalEventType?: string;
  /**
   * Reason the loop ended, mirroring Python `cma_lib.py:_stream_until_settled`'s
   * `stop_reason` return value. Values:
   *   - `end_turn` / `requires_action` / `max_tokens` … from
   *     `session.status_idle` events.
   *   - `tool_call_cap` … built-in tool call cap was hit and the bridge
   *     sent `user.interrupt` to ask the agent to wind down.
   *   - `session_watchdog` … wall-clock cap was hit and the bridge
   *     sent `user.interrupt`.
   *   - `custom_tool_timeout` … external timeout fired while a custom
   *     tool result was pending; the bridge sent an error
   *     `user.custom_tool_result` so the session does not remain blocked.
   *   - `stream_terminated` … `session.status_terminated` was seen.
   *   - undefined … loop exited without observing a stop signal (e.g.
   *     external `timeoutMs` AbortError thrown by `Promise.race`).
   */
  stopReason?: string;
  /** Number of tool-use events observed while draining the stream. */
  toolUseCount: number;
  /** Tool names observed in tool-use events, de-duplicated in encounter order. */
  toolUseNames: string[];
  /** True when live stream timed out but final text was recovered via events.list. */
  recoveredFromStreamTimeout?: boolean;
}

const DEFAULT_STREAM_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_RECOVERY_POLL_MS = 0;
const TIMEOUT_RECOVERY_POLL_INTERVAL_MS = 2_000;
const DEFAULT_REQUIRES_ACTION_RESUME_POLL_MS = 0;

/**
 * Inject `userMessage` into the session, drain the event stream
 * until a terminal event or timeout, and return the assistant text
 * plus any EMAIL_SEND markers parsed from it.
 *
 * Stream contract (SDK `events.stream`):
 *   - SDK exposes an async iterator over server-sent events
 *   - relevant event types: `*.text_delta`, `*.text`, `*.message`,
 *     `session.status_idle`, `session.status_terminated`
 *   - we accumulate any string content from text-bearing events
 *     into `assistantText` then run `parseEmailSendMarkers` once at
 *     the end (cheaper than per-delta parsing)
 *
 * `timeoutMs` is enforced via `Promise.race`. On timeout the stream
 * is abandoned (the Queue consumer's own lease will eventually
 * expire if we don't commit).
 */
export async function sendAndStream(
  client: Anthropic,
  input: SendAndStreamInput,
): Promise<SendAndStreamResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;

  // Push the user message first. The bridge always uses `user.message`
  // events for inbound mail — matches the Python contract.
  // SDK requires content as an array of typed blocks (text / image /
  // document) rather than a raw string; we wrap into a single text
  // block here. Verified against
  // @anthropic-ai/sdk BetaManagedAgentsTextBlock shape.
  const userMessageEvents = [
    {
      type: 'user.message',
      content: toUserMessageContent(input.userMessage),
    },
  ];
  await saveUserMessagePayloadAudit(input.sessionId, userMessageEvents, input.payloadAudit);
  await client.beta.sessions.events.send(input.sessionId, {
    events: userMessageEvents,
    betas: [ANTHROPIC_BETA],
  } as unknown as Parameters<typeof client.beta.sessions.events.send>[1]);

  // Now drain. We type the iterator loosely because the SDK's event
  // union covers many shapes the bridge does not need to model
  // exhaustively — narrow to text-bearing variants by duck-typing.
  const stream = await client.beta.sessions.events.stream(input.sessionId, {
    betas: [ANTHROPIC_BETA],
  } as Parameters<typeof client.beta.sessions.events.stream>[1]);

  let assistantText = '';
  let terminalEventType: string | undefined;
  let toolUseCount = 0;
  const toolUseNames: string[] = [];

  const drain = (async () => {
    for await (const ev of stream as unknown as AsyncIterable<Record<string, unknown>>) {
      const evType = typeof ev.type === 'string' ? ev.type : '';
      if (isToolUseEventType(evType)) {
        toolUseCount += 1;
        const name = toolNameFromSessionEvent(ev);
        if (name && !toolUseNames.includes(name)) toolUseNames.push(name);
      }
      // Accumulate text-bearing events. The Managed Agents stream often
      // emits final assistant text as `agent.message` with `content[]`
      // blocks rather than top-level `text` / `delta`.
      const text = textFromSessionEvent(ev);
      if (text) assistantText += text;

      if (evType === 'session.status_idle' || evType === 'session.status_terminated') {
        terminalEventType = evType;
        break;
      }
    }
  })();

  await Promise.race([
    drain,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`sendAndStream timeout after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);

  return {
    assistantText,
    emailSendMarkers: parseEmailSendMarkers(assistantText),
    terminalEventType,
    toolUseCount,
    toolUseNames,
  };
}

/**
 * Normalise the `userMessage` field into the typed-block array shape
 * the SDK expects on `user.message.content`. Plain strings get wrapped
 * into a single `{type:'text', text:...}` block; pre-built arrays are
 * passed through unchanged (= attachment-processing builds image /
 * document blocks ahead of time).
 */
function toUserMessageContent(
  userMessage: string | UserMessageContentBlock[],
): UserMessageContentBlock[] {
  if (typeof userMessage === 'string') {
    return [{ type: 'text', text: userMessage }];
  }
  return userMessage;
}

function pickString(ev: Record<string, unknown>, key: string): string | undefined {
  const v = ev[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function textFromSessionEvent(ev: Record<string, unknown>): string | undefined {
  const evType = typeof ev.type === 'string' ? ev.type : '';
  if (evType === 'agent.message') {
    const content = (ev as { content?: Array<Record<string, unknown>> }).content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        const t = pickString(block, 'text');
        if (t) parts.push(t);
      }
      if (parts.length > 0) return parts.join('');
    }
  }
  return pickString(ev, 'text') ?? pickString(ev, 'delta');
}

function isToolUseEventType(evType: string): boolean {
  return evType === 'agent.tool_use' || evType === 'agent.custom_tool_use';
}

function toolNameFromSessionEvent(ev: Record<string, unknown>): string | undefined {
  const direct = pickString(ev, 'name');
  if (direct) return direct;
  const toolUse = ev.tool_use;
  if (toolUse && typeof toolUse === 'object') {
    const name = pickString(toolUse as Record<string, unknown>, 'name');
    if (name) return name;
  }
  return undefined;
}

function userMessageContentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const text = pickString(block as Record<string, unknown>, 'text');
    if (text) parts.push(text);
  }
  return parts.join('');
}

async function sendUserMessageEvents(
  client: Anthropic,
  sessionId: string,
  userMessageEvents: Array<Record<string, unknown>>,
  unblockPendingAction: () => Promise<void>,
): Promise<void> {
  try {
    await client.beta.sessions.events.send(sessionId, {
      events: userMessageEvents,
      betas: [ANTHROPIC_BETA],
    } as unknown as Parameters<typeof client.beta.sessions.events.send>[1]);
    return;
  } catch (err) {
    if (!isWaitingOnToolResultError(err)) throw err;
    console.warn(
      `[session] user.message blocked by pending tool action sessionId=${sessionId}; sending interrupt without replaying user.message`,
    );
    await unblockPendingAction();
    throw err;
  }
}

function isWaitingOnToolResultError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('waiting on responses to events') &&
    message.includes('user.custom_tool_result') &&
    message.includes('user.interrupt')
  );
}

// ============================================================================
// sendAndStreamWithToolDispatch — agent.custom_tool_use event loop
// ============================================================================

/**
 * Tool result envelope returned by `MakotoToolDispatchContext`-style
 * dispatchers. Mirrors `MakotoToolResult` in
 * `dispatch/makoto-tool-dispatcher.ts` but kept structural so unit
 * tests can inject a fake dispatcher without importing the MAKOTO-side
 * module.
 */
export interface ToolDispatchResult {
  ok: boolean;
  /** Serializable payload — `JSON.stringify`-able. */
  payload: unknown;
}

/**
 * Async function the bridge calls when an `agent.custom_tool_use`
 * event lands on the stream. The dispatcher resolves the tool name,
 * runs the tool, and returns the result (success or error envelope).
 * It MUST NOT throw — all failures should be encoded into
 * `{ok:false, payload:{...}}` so the event loop can forward them to
 * the agent as `is_error: true` and continue.
 */
export type ToolDispatcher = (
  toolName: string,
  input: unknown,
) => Promise<ToolDispatchResult>;

export interface SendAndStreamWithToolDispatchInput {
  sessionId: string;
  /**
   * Same shape as `SendAndStreamInput.userMessage` — plain text or a
   * typed content-block array. See `UserMessageContentBlock` for the
   * looser block shape.
   */
  userMessage: string | UserMessageContentBlock[];
  toolDispatcher: ToolDispatcher;
  /** Optional short-lived audit of the exact user.message payload. */
  payloadAudit?: PayloadAuditConfig;
  /** Hard cap on wall time the event loop is willing to wait. */
  timeoutMs?: number;
  /**
   * After the live stream timeout fires, poll session history for a final
   * assistant answer before surfacing `stream_failed`. Zero disables this.
   */
  timeoutRecoveryMs?: number;
  /**
   * Soft cap on the number of `agent.custom_tool_use` events the loop
   * will service before returning. Defaults to 32. Mirrors Python's
   * implicit guard (the per-session SDK caps loop turns server-side
   * anyway, but a TS-side cap means a misbehaving agent can't pin a
   * Queue consumer worker until the lease expires).
   */
  maxToolCalls?: number;
  /**
   * Soft cap on built-in tool calls (`agent.tool_use` — bash /
   * web_search / code_execution / etc that the Anthropic runtime
   * executes server-side). Mirrors Python's `max_tool_calls`
   * (`cma_lib.py:2599-2601`). When exceeded the bridge sends
   * `user.interrupt` and returns with `stopReason='tool_call_cap'`,
   * so a runaway built-in tool can't pin the Worker invocation.
   * Defaults to 15 (Python `_MAX_TOOL_CALLS_DEFAULT`).
   */
  maxBuiltinToolCalls?: number;
  /**
   * Wall-clock cap measured from the moment the stream starts draining
   * (= `events.stream` opened). On expiry the bridge sends
   * `user.interrupt` and returns with `stopReason='session_watchdog'`.
   * Mirrors Python `session_watchdog_sec` (`cma_lib.py:2602`,
   * default 600). Pass `0` to disable. Defaults to 600 (10 min).
   *
   * Distinct from `timeoutMs`: `timeoutMs` aborts the entire
   * `Promise.race` with a throw, leaving the SDK stream half-open and
   * the agent thinking. `sessionWatchdogSec` sends a proper
   * interrupt so the agent can wind down gracefully and the loop
   * returns partial results instead of throwing.
   */
  sessionWatchdogSec?: number;
  /**
   * Ignore replayed historical session events until the stream echoes the
   * exact user.message we just sent. Use for follow-up turns such as cap
   * recovery where Managed Agents can replay the previous turn before the
   * newly-sent prompt starts.
   */
  startAfterUserMessageEcho?: boolean;
}

const DEFAULT_MAX_TOOL_CALLS = 32;
const DEFAULT_MAX_BUILTIN_TOOL_CALLS = 15;
const DEFAULT_SESSION_WATCHDOG_SEC = 600;

/**
 * Same shape as `sendAndStream` but with self-dispatch of
 * `agent.custom_tool_use` events. Mirrors the Python event loop in
 * `scripts/cma_lib.py:2563-2729` (events.stream for-loop + per-event
 * branch on `agent.custom_tool_use` → tool call →
 * `events.send([user.custom_tool_result])`).
 *
 * The loop:
 *   1. Send the inbound user message as a `user.message` event.
 *   2. Drain events.stream:
 *      - `*.text_delta` / `*.text` → accumulate into `assistantText`
 *      - `agent.custom_tool_use` → dispatch + post `user.custom_tool_result`
 *      - `session.status_idle` / `session.status_terminated` → break
 *   3. After break (or timeout), return assistant text + EMAIL_SEND markers.
 *
 * Note: `agent.tool_use` (built-in tools like bash) is observed but
 * NOT dispatched here — only `agent.custom_tool_use` (= MAKOTOくん's
 * MAKOTO custom tools) routes through `toolDispatcher`. Built-in
 * tool execution happens server-side in Anthropic's runtime; the bridge
 * just watches the result come back as part of the stream.
 */
export async function sendAndStreamWithToolDispatch(
  client: Anthropic,
  input: SendAndStreamWithToolDispatchInput,
): Promise<SendAndStreamResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
  const maxToolCalls = input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const maxBuiltinToolCalls =
    input.maxBuiltinToolCalls ?? DEFAULT_MAX_BUILTIN_TOOL_CALLS;
  const sessionWatchdogSec =
    input.sessionWatchdogSec ?? DEFAULT_SESSION_WATCHDOG_SEC;

  /**
   * Fire `user.interrupt` so the agent stops generating. Mirrors the
   * Python `_stream_until_settled` interrupt paths
   * (`cma_lib.py:2717-2725` / `2744-2749` / `2891-2897`). Swallow any
   * send error — by the time we're interrupting we've already decided
   * to abandon the turn; logging is enough.
   */
  const sendInterrupt = async (reason: string): Promise<void> => {
    try {
      await client.beta.sessions.events.send(input.sessionId, {
        events: [{ type: 'user.interrupt' }],
        betas: [ANTHROPIC_BETA],
      } as unknown as Parameters<typeof client.beta.sessions.events.send>[1]);
    } catch (err) {
      console.warn(
        `[session] user.interrupt send failed (reason=${reason}) sessionId=${input.sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  // Push the inbound user.message first. Identical wrapping to
  // `sendAndStream`: wrap a string into a single text block, otherwise
  // pass the typed content array straight through (= image / document
  // attachments are pre-built by the caller, see attachment-processing.ts).
  const userMessageEvents = [
    {
      type: 'user.message',
      content: toUserMessageContent(input.userMessage),
    },
  ];
  await saveUserMessagePayloadAudit(input.sessionId, userMessageEvents, input.payloadAudit);
  await sendUserMessageEvents(client, input.sessionId, userMessageEvents, async () => {
    await sendInterrupt('pending_custom_tool_before_user_message');
  });

  const stream = await client.beta.sessions.events.stream(input.sessionId, {
    betas: [ANTHROPIC_BETA],
  } as Parameters<typeof client.beta.sessions.events.stream>[1]);

  let assistantText = '';
  let terminalEventType: string | undefined;
  let stopReason: string | undefined;
  let toolCalls = 0;
  const toolUseNames: string[] = [];
  let requiresActionIters = 0;
  const pendingCustomToolUses = new Map<
    string,
    { name: string; input: unknown }
  >();
  const inFlightCustomToolUses = new Map<
    string,
    { name: string; input: unknown }
  >();
  let builtinToolCalls = 0;
  const startedAtMs = Date.now();
  let timedOut = false;
  let currentTurnStarted = false;
  let seenUserMessageEcho = input.startAfterUserMessageEcho !== true;
  const sentUserMessageText = input.startAfterUserMessageEcho
    ? userMessageContentText(userMessageEvents[0]!.content)
    : '';
  const currentUserMessageText = userMessageContentText(userMessageEvents[0]!.content);
  let recoveredFromStreamTimeout = false;
  let sentCustomToolResult = false;
  let recoveredToolUseCount: number | undefined;
  let recoveredToolUseNames: string[] | undefined;

  const sendPendingCustomToolTimeoutResults = async (): Promise<boolean> => {
    const unresolved = new Map([
      ...pendingCustomToolUses.entries(),
      ...inFlightCustomToolUses.entries(),
    ]);
    if (unresolved.size === 0) return false;
    const events = [...unresolved.entries()].map(([eventId, pending]) => ({
      type: 'user.custom_tool_result',
      custom_tool_use_id: eventId,
      content: [
        {
          type: 'text',
          text: safeJsonStringify({
            error: 'custom_tool_timeout',
            tool: pending.name,
            message: `custom tool did not finish before stream timeout (${timeoutMs}ms)`,
          }),
        },
      ],
      is_error: true,
    }));
    try {
      await client.beta.sessions.events.send(input.sessionId, {
        events,
        betas: [ANTHROPIC_BETA],
      } as unknown as Parameters<typeof client.beta.sessions.events.send>[1]);
      pendingCustomToolUses.clear();
      inFlightCustomToolUses.clear();
      stopReason = 'custom_tool_timeout';
      terminalEventType = 'error.custom_tool_timeout';
      return true;
    } catch (err) {
      console.error(
        `[session] custom tool timeout cleanup failed sessionId=${input.sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      stopReason = 'events_send_failed';
      terminalEventType = 'error.events_send';
      return false;
    }
  };

  const drain = (async () => {
    for await (const ev of stream as unknown as AsyncIterable<Record<string, unknown>>) {
      // ---- session watchdog (時間 cap) ----
      // Per-event check mirrors Python `cma_lib.py:2708-2728`. The SDK
      // stream won't preempt mid-event, so a fully deadlocked stream
      // (no event ever arrives) isn't covered here — `timeoutMs`
      // (Promise.race) is the second line of defense for that case.
      if (sessionWatchdogSec > 0) {
        const elapsedSec = (Date.now() - startedAtMs) / 1000;
        if (elapsedSec > sessionWatchdogSec) {
          console.warn(
            `[session] session_watchdog reached (elapsed=${elapsedSec.toFixed(1)}s, max=${sessionWatchdogSec}s); sending interrupt`,
          );
          await sendInterrupt('session_watchdog');
          stopReason = 'session_watchdog';
          terminalEventType = 'limit.session_watchdog';
          break;
        }
      }

      const evType = typeof ev.type === 'string' ? ev.type : '';
      if (!seenUserMessageEcho) {
        if (
          evType === 'user.message' &&
          userMessageContentText((ev as { content?: unknown }).content) === sentUserMessageText
        ) {
          seenUserMessageEcho = true;
          currentTurnStarted = true;
        }
        continue;
      }
      if (
        evType === 'session.status_running' ||
        evType === 'session.thread_status_running' ||
        evType === 'user.message' ||
        evType === 'span.model_request_start' ||
        evType.startsWith('agent.')
      ) {
        currentTurnStarted = true;
      }

      // 1. text-bearing events — accumulate into assistantText.
      // Anthropic Managed Agents の実 event shape (Python `cma_lib.py:2730-2734`
      // を一次ソースに):
      //   { type: 'agent.message', content: [{ type: 'text', text: '...' }, ...] }
      // top-level の `ev.text` / `ev.delta` ではなく **content[] 配列内の各
      // block の text field** を集計する必要がある (= 2026-05-26 reactive
      // bot 実機検証で発覚、空 assistantText → empty clean text → 投稿
      // skip の根本原因)。
      const text = textFromSessionEvent(ev);
      if (text) assistantText += text;

      // 2a. built-in tool use — bash / web_search / code_execution. The
      // Anthropic runtime executes these server-side; we only count and
      // interrupt on cap (Python `cma_lib.py:2735-2752`). A runaway
      // built-in tool (e.g. web_search infinite chain) is the
      // motivating case for this guard.
      if (evType === 'agent.tool_use') {
        builtinToolCalls += 1;
        const name = toolNameFromSessionEvent(ev);
        if (name && !toolUseNames.includes(name)) toolUseNames.push(name);
        if (builtinToolCalls > maxBuiltinToolCalls) {
          console.warn(
            `[session] tool_call_cap reached (count=${builtinToolCalls}, max=${maxBuiltinToolCalls}); sending interrupt`,
          );
          await sendInterrupt('tool_call_cap');
          stopReason = 'tool_call_cap';
          terminalEventType = 'limit.builtin_tool_calls';
          break;
        }
        continue;
      }

      // 2b. custom tool dispatch — MAKOTOくん の 10 tool が呼ばれた時。
      // Managed Agents contract: collect `agent.custom_tool_use` here, then
      // execute/send `user.custom_tool_result` only after the session pauses
      // with `session.status_idle(stop_reason=requires_action)`. Sending the
      // result while the session is still running can break the stream.
      if (evType === 'agent.custom_tool_use') {
        toolCalls += 1;
        if (toolCalls > maxToolCalls) {
          console.warn(
            `[session] custom_tool_use cap reached (${maxToolCalls}); breaking event loop`,
          );
          // Custom tool cap also interrupts so the agent doesn't keep
          // streaming text we'd just discard.
          await sendInterrupt('custom_tool_call_cap');
          stopReason = 'custom_tool_call_cap';
          terminalEventType = 'limit.custom_tool_calls';
          break;
        }
        const toolUseId = pickString(ev, 'id') ?? '';
        const toolName = pickString(ev, 'name') ?? 'unknown';
        if (toolName && !toolUseNames.includes(toolName)) toolUseNames.push(toolName);
        const toolInput = (ev as { input?: unknown }).input;
        if (toolUseId) {
          pendingCustomToolUses.set(toolUseId, { name: toolName, input: toolInput });
        }
        continue;
      }

      // 3. terminal events.
      if (evType === 'session.status_idle') {
        terminalEventType = evType;
        if (!currentTurnStarted && assistantText.length === 0 && pendingCustomToolUses.size === 0) {
          // A new stream can replay the previous turn's idle boundary just
          // before the run triggered by our freshly-sent user.message starts.
          // Ignore that stale boundary; otherwise cap recovery can return
          // empty even though the recovery turn later produces text.
          continue;
        }
        // Python `_stop_reason_type(event)` reads `event.stop_reason.type`.
        // The SDK exposes it on the event as either a nested object
        // ({type:'end_turn'}) or a bare string depending on shape.
        const sr = (ev as { stop_reason?: unknown }).stop_reason;
        let requiredEventIds: string[] = [];
        if (typeof sr === 'string' && sr.length > 0) {
          stopReason = sr;
        } else if (sr && typeof sr === 'object') {
          const srObj = sr as Record<string, unknown>;
          const t = pickString(srObj, 'type');
          if (t) stopReason = t;
          requiredEventIds = extractRequiresActionEventIds(srObj);
        }
        if (
          stopReason === 'requires_action' &&
          pendingCustomToolUses.size > 0
        ) {
          requiresActionIters += 1;
          if (requiresActionIters > maxToolCalls) {
            console.warn(
              `[session] custom_tool_use requires_action cap reached (${maxToolCalls}); sending errors`,
            );
          }
          const eventIds =
            requiredEventIds.length > 0
              ? requiredEventIds
              : [...pendingCustomToolUses.keys()];
          const resultEvents: Record<string, unknown>[] = [];
          for (const eventId of eventIds) {
            const pending = pendingCustomToolUses.get(eventId);
            if (!pending) {
              resultEvents.push(makeCustomToolErrorResult(eventId, 'pending_lost'));
              continue;
            }
            pendingCustomToolUses.delete(eventId);
            inFlightCustomToolUses.set(eventId, pending);
            let result: ToolDispatchResult;
            if (requiresActionIters > maxToolCalls) {
              result = {
                ok: false,
                payload: {
                  error: 'custom_tool_call_cap',
                  message: `custom tool iteration cap reached (max=${maxToolCalls})`,
                },
              };
            } else {
              try {
                result = await input.toolDispatcher(pending.name, pending.input);
              } catch (err) {
                // Defensive — dispatcher contract says "never throw" but
                // surface unexpected throws as is_error rather than killing
                // the loop. The agent then sees the failure and can recover.
                result = {
                  ok: false,
                  payload: {
                    error: 'dispatcher_threw',
                    tool: pending.name,
                    message: err instanceof Error ? err.message : String(err),
                  },
                };
              }
            }
            inFlightCustomToolUses.delete(eventId);
            if (timedOut) break;
            const resultEvent: Record<string, unknown> = {
              type: 'user.custom_tool_result',
              custom_tool_use_id: eventId,
              content: [{ type: 'text', text: safeJsonStringify(result.payload) }],
            };
            if (!result.ok) resultEvent.is_error = true;
            resultEvents.push(resultEvent);
          }
          try {
            if (timedOut) break;
            await client.beta.sessions.events.send(input.sessionId, {
              events: resultEvents,
              betas: [ANTHROPIC_BETA],
            } as unknown as Parameters<typeof client.beta.sessions.events.send>[1]);
            sentCustomToolResult = true;
          } catch (err) {
            console.error(
              `[session] events.send for tool_result failed sessionId=${input.sessionId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            stopReason = 'events_send_failed';
            terminalEventType = 'error.events_send';
            break;
          }
          terminalEventType = undefined;
          stopReason = undefined;
          continue;
        }
        // Managed Agents can emit an idle boundary before later tool/final
        // events arrive. Treat explicit final reasons as terminal; otherwise
        // keep draining the stream. If the stream actually ends here, the
        // async iterator exits and we return the text collected so far.
        if (
          stopReason === 'end_turn' ||
          stopReason === 'stop_sequence' ||
          stopReason === 'max_tokens'
        ) {
          break;
        }
        continue;
      }
      if (evType === 'session.status_terminated') {
        terminalEventType = evType;
        stopReason = 'stream_terminated';
        break;
      }
    }
  })();

  const drainPromise = drain.catch((err) => {
    if (timedOut) {
      console.warn(
        `[session] drain ended after timeout sessionId=${input.sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    throw err;
  });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      void sendPendingCustomToolTimeoutResults().then(async (handled) => {
        const recovered = await recoverCompletedTurnAfterStreamTimeout(client, {
          sessionId: input.sessionId,
          userMessageText: currentUserMessageText,
          pollMs: input.timeoutRecoveryMs ?? DEFAULT_TIMEOUT_RECOVERY_POLL_MS,
        });
        if (recovered) {
          assistantText = recovered.assistantText;
          terminalEventType = recovered.terminalEventType;
          stopReason = recovered.stopReason;
          recoveredFromStreamTimeout = true;
          resolve();
          return;
        }
        if (handled) {
          resolve();
          return;
        }
        reject(
          new Error(`sendAndStreamWithToolDispatch timeout after ${timeoutMs}ms`),
        );
      });
    }, timeoutMs);
  });
  try {
    await Promise.race([drainPromise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  const hasFinalStopReason =
    stopReason === 'end_turn' ||
    stopReason === 'stop_sequence' ||
    stopReason === 'max_tokens' ||
    stopReason === 'stream_terminated';
  if (
    !timedOut &&
    (stopReason === 'requires_action' ||
      (sentCustomToolResult && !hasFinalStopReason && assistantText.trim().length === 0))
  ) {
    const resumed = await resumeTurnFromSessionEvents(client, {
      sessionId: input.sessionId,
      toolDispatcher: input.toolDispatcher,
      userMessageText: currentUserMessageText,
      userMessageMatch: 'exact',
      pollMs: input.timeoutRecoveryMs ?? DEFAULT_REQUIRES_ACTION_RESUME_POLL_MS,
      maxToolCalls,
    });
    if (resumed) {
      assistantText = resumed.assistantText;
      terminalEventType = resumed.terminalEventType;
      stopReason = resumed.stopReason;
      recoveredToolUseCount = resumed.toolUseCount;
      recoveredToolUseNames = resumed.toolUseNames;
    }
  }

  return {
    assistantText,
    emailSendMarkers: parseEmailSendMarkers(assistantText),
    terminalEventType,
    stopReason,
    toolUseCount: Math.max(builtinToolCalls + toolCalls, recoveredToolUseCount ?? 0),
    toolUseNames: recoveredToolUseNames ?? toolUseNames,
    ...(recoveredFromStreamTimeout ? { recoveredFromStreamTimeout } : {}),
  };
}

interface TimeoutRecoveryInput {
  sessionId: string;
  userMessageText: string;
  pollMs: number;
}

export interface TimeoutRecoveryResult {
  assistantText: string;
  terminalEventType: string;
  stopReason: string;
}

export interface ResumeTurnFromSessionEventsInput {
  sessionId: string;
  toolDispatcher: ToolDispatcher;
  userMessageText?: string;
  userMessageMatch?: 'exact' | 'contains';
  pollMs?: number;
  pollIntervalMs?: number;
  maxToolCalls?: number;
}

interface SessionTurnAnalysis {
  assistantText: string;
  terminalEventType?: string;
  stopReason?: string;
  toolUseCount: number;
  toolUseNames: string[];
  pendingCustomToolUses: Array<{ id: string; name: string; input: unknown }>;
}

async function recoverCompletedTurnAfterStreamTimeout(
  client: Anthropic,
  input: TimeoutRecoveryInput,
): Promise<TimeoutRecoveryResult | null> {
  const pollMs = Math.max(0, input.pollMs);
  if (pollMs <= 0) return null;
  const deadline = Date.now() + pollMs;
  let lastError: string | null = null;
  do {
    try {
      const recovered = await readCompletedTurnFromSessionEvents(
        client,
        input.sessionId,
        input.userMessageText,
      );
      if (recovered) {
        console.warn(
          `[session] recovered final assistant text after stream timeout sessionId=${input.sessionId} chars=${recovered.assistantText.length}`,
        );
        return recovered;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) break;
    await sleep(TIMEOUT_RECOVERY_POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  if (lastError) {
    console.warn(
      `[session] timeout recovery poll failed sessionId=${input.sessionId}: ${lastError}`,
    );
  }
  return null;
}

export async function readCompletedTurnFromSessionEvents(
  client: Anthropic,
  sessionId: string,
  userMessageText?: string,
  userMessageMatch: 'exact' | 'contains' = 'exact',
): Promise<TimeoutRecoveryResult | null> {
  const eventsApi = client.beta.sessions.events as unknown as {
    list?: (
      sessionId: string,
      params?: Record<string, unknown>,
    ) => AsyncIterable<Record<string, unknown>>;
  };
  if (typeof eventsApi.list !== 'function') return null;

  const events: Record<string, unknown>[] = [];
  for await (const ev of eventsApi.list(sessionId, {
    limit: 1000,
    betas: [ANTHROPIC_BETA],
  })) {
    events.push(ev);
  }

  let turnStart = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    if (typeof ev.type !== 'string' || ev.type !== 'user.message') continue;
    const contentText = userMessageContentText((ev as { content?: unknown }).content);
    const matched =
      userMessageText === undefined
        ? true
        : userMessageMatch === 'contains'
          ? contentText.includes(userMessageText)
          : contentText === userMessageText;
    if (matched) {
      turnStart = i;
      break;
    }
  }
  if (turnStart < 0) return null;

  let assistantText = '';
  let terminalEventType = '';
  let stopReason = '';
  for (const ev of events.slice(turnStart + 1)) {
    const text = textFromSessionEvent(ev);
    if (text) assistantText += text;
    const evType = typeof ev.type === 'string' ? ev.type : '';
    if (evType !== 'session.status_idle') continue;
    const reason = stopReasonFromSessionEvent(ev);
    if (reason === 'end_turn' || reason === 'stop_sequence' || reason === 'max_tokens') {
      terminalEventType = evType;
      stopReason = reason;
      break;
    }
  }
  if (!assistantText || !terminalEventType || !stopReason) return null;
  return { assistantText, terminalEventType, stopReason };
}

export async function resumeTurnFromSessionEvents(
  client: Anthropic,
  input: ResumeTurnFromSessionEventsInput,
): Promise<SendAndStreamResult | null> {
  const pollMs = Math.max(0, input.pollMs ?? 0);
  const pollIntervalMs = Math.max(250, input.pollIntervalMs ?? TIMEOUT_RECOVERY_POLL_INTERVAL_MS);
  const maxToolCalls = input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const deadline = Date.now() + pollMs;
  const dispatchedIds = new Set<string>();
  let dispatchedCount = 0;
  let lastError: string | null = null;

  do {
    let events: Record<string, unknown>[];
    try {
      events = await listSessionEvents(client, input.sessionId);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      events = [];
    }

    const analysis = analyzeLatestTurnFromSessionEvents(events, {
      userMessageText: input.userMessageText,
      userMessageMatch: input.userMessageMatch ?? 'exact',
    });
    if (analysis) {
      if (
        analysis.terminalEventType &&
        (analysis.stopReason === 'end_turn' ||
          analysis.stopReason === 'stop_sequence' ||
          analysis.stopReason === 'max_tokens' ||
          (!analysis.stopReason &&
            analysis.pendingCustomToolUses.length === 0 &&
            analysis.assistantText.length > 0))
      ) {
        return {
          assistantText: analysis.assistantText,
          emailSendMarkers: parseEmailSendMarkers(analysis.assistantText),
          terminalEventType: analysis.terminalEventType,
          stopReason: analysis.stopReason,
          toolUseCount: analysis.toolUseCount,
          toolUseNames: analysis.toolUseNames,
        };
      }

      const pending = analysis.pendingCustomToolUses.filter(
        (toolUse) => !dispatchedIds.has(toolUse.id),
      );
      if (pending.length > 0) {
        const resultEvents: Record<string, unknown>[] = [];
        for (const toolUse of pending) {
          dispatchedIds.add(toolUse.id);
          dispatchedCount += 1;
          let result: ToolDispatchResult;
          if (dispatchedCount > maxToolCalls) {
            result = {
              ok: false,
              payload: {
                error: 'custom_tool_call_cap',
                message: `custom tool iteration cap reached (max=${maxToolCalls})`,
              },
            };
          } else {
            try {
              result = await input.toolDispatcher(toolUse.name, toolUse.input);
            } catch (err) {
              result = {
                ok: false,
                payload: {
                  error: 'dispatcher_threw',
                  tool: toolUse.name,
                  message: err instanceof Error ? err.message : String(err),
                },
              };
            }
          }
          const resultEvent: Record<string, unknown> = {
            type: 'user.custom_tool_result',
            custom_tool_use_id: toolUse.id,
            content: [{ type: 'text', text: safeJsonStringify(result.payload) }],
          };
          if (!result.ok) resultEvent.is_error = true;
          resultEvents.push(resultEvent);
        }
        try {
          await client.beta.sessions.events.send(input.sessionId, {
            events: resultEvents,
            betas: [ANTHROPIC_BETA],
          } as unknown as Parameters<typeof client.beta.sessions.events.send>[1]);
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
        continue;
      }
    }

    if (Date.now() >= deadline) break;
    await sleep(pollIntervalMs);
  } while (Date.now() < deadline);

  if (lastError) {
    console.warn(
      `[session] resumeTurnFromSessionEvents failed sessionId=${input.sessionId}: ${lastError}`,
    );
  }
  return null;
}

async function listSessionEvents(
  client: Anthropic,
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  const eventsApi = client.beta.sessions.events as unknown as {
    list?: (
      sessionId: string,
      params?: Record<string, unknown>,
    ) => AsyncIterable<Record<string, unknown>>;
  };
  if (typeof eventsApi.list !== 'function') return [];

  const events: Record<string, unknown>[] = [];
  for await (const ev of eventsApi.list(sessionId, {
    limit: 1000,
    betas: [ANTHROPIC_BETA],
  })) {
    events.push(ev);
  }
  return events;
}

function analyzeLatestTurnFromSessionEvents(
  events: Record<string, unknown>[],
  input: {
    userMessageText?: string;
    userMessageMatch: 'exact' | 'contains';
  },
): SessionTurnAnalysis | null {
  let turnStart = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    if (typeof ev.type !== 'string' || ev.type !== 'user.message') continue;
    const contentText = userMessageContentText((ev as { content?: unknown }).content);
    const matched =
      input.userMessageText === undefined
        ? true
        : input.userMessageMatch === 'contains'
          ? contentText.includes(input.userMessageText)
          : contentText === input.userMessageText;
    if (matched) {
      turnStart = i;
      break;
    }
  }
  if (turnStart < 0) return null;

  let assistantText = '';
  let terminalEventType: string | undefined;
  let stopReason: string | undefined;
  let latestRequiredIds: string[] = [];
  const customToolUses = new Map<string, { id: string; name: string; input: unknown }>();
  const answeredCustomToolUseIds = new Set<string>();
  let toolUseCount = 0;
  const toolUseNames: string[] = [];

  for (const ev of events.slice(turnStart + 1)) {
    const evType = typeof ev.type === 'string' ? ev.type : '';
    const text = textFromSessionEvent(ev);
    if (text) assistantText += text;

    if (isToolUseEventType(evType)) {
      toolUseCount += 1;
      const name = toolNameFromSessionEvent(ev);
      if (name && !toolUseNames.includes(name)) toolUseNames.push(name);
    }

    if (evType === 'agent.custom_tool_use') {
      const id = pickString(ev, 'id') ?? '';
      if (id) {
        customToolUses.set(id, {
          id,
          name: pickString(ev, 'name') ?? 'unknown',
          input: (ev as { input?: unknown }).input,
        });
      }
      continue;
    }

    if (evType === 'user.custom_tool_result') {
      const id = pickString(ev, 'custom_tool_use_id') ?? '';
      if (id) answeredCustomToolUseIds.add(id);
      continue;
    }

    if (evType === 'session.status_idle') {
      terminalEventType = evType;
      stopReason = stopReasonFromSessionEvent(ev);
      latestRequiredIds =
        stopReason === 'requires_action'
          ? extractRequiresActionEventIds((ev as { stop_reason?: Record<string, unknown> }).stop_reason ?? {})
          : [];
      continue;
    }

    if (evType === 'session.status_terminated') {
      terminalEventType = evType;
      stopReason = 'stream_terminated';
    }
  }

  const pendingCustomToolUses =
    stopReason === 'requires_action'
      ? latestRequiredIds
          .filter((id) => !answeredCustomToolUseIds.has(id))
          .map((id) => customToolUses.get(id))
          .filter((toolUse): toolUse is { id: string; name: string; input: unknown } =>
            Boolean(toolUse),
          )
      : [];

  return {
    assistantText,
    ...(terminalEventType !== undefined ? { terminalEventType } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    toolUseCount,
    toolUseNames,
    pendingCustomToolUses,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopReasonFromSessionEvent(ev: Record<string, unknown>): string {
  const sr = ev.stop_reason;
  if (typeof sr === 'string') return sr;
  if (sr && typeof sr === 'object') {
    return pickString(sr as Record<string, unknown>, 'type') ?? '';
  }
  return '';
}

/**
 * JSON.stringify with a circular / non-serializable fallback so a
 * pathological tool payload never crashes the dispatch loop.
 */
function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return JSON.stringify({
      error: 'json_stringify_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function extractRequiresActionEventIds(stopReason: Record<string, unknown>): string[] {
  const direct = stopReason.event_ids;
  if (Array.isArray(direct)) {
    return direct.filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  const requiresAction = stopReason.requires_action;
  if (requiresAction && typeof requiresAction === 'object') {
    const nested = (requiresAction as Record<string, unknown>).event_ids;
    if (Array.isArray(nested)) {
      return nested.filter((v): v is string => typeof v === 'string' && v.length > 0);
    }
  }
  return [];
}

function makeCustomToolErrorResult(eventId: string, message: string): Record<string, unknown> {
  return {
    type: 'user.custom_tool_result',
    custom_tool_use_id: eventId,
    content: [{ type: 'text', text: message }],
    is_error: true,
  };
}
