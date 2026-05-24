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
 * (`session.completed`, `session.failed`) end the loop.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 5 — 層 3)
 * Spec: plan-draft.md §4 session + A24 (agent: vs agent_id: SDK shape)
 */

import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_BETA } from '../anthropic';
import type { MemoryStoreResourceParam } from '../types/memory';
import type { EmailSendMarker } from '../types/agentmail';
import { parseEmailSendMarkers } from './email-send-marker';

/**
 * Build an Anthropic SDK client. Mirrors `email-handler.ts:emailClient`
 * so the bridge keeps one client-construction pattern across handlers.
 * Returns null when no API key is configured — callers decide whether
 * that is fatal.
 */
export function buildAnthropicClient(env: Env): Anthropic | null {
  const apiKey = env.ANTHROPIC_API_KEY;
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
    betas: [ANTHROPIC_BETA],
  } as Parameters<typeof client.beta.sessions.create>[0]);
  if (typeof created.id !== 'string' || created.id.length === 0) {
    throw new Error('sessions.create returned no id');
  }
  return created.id;
}

export interface SendAndStreamInput {
  sessionId: string;
  /** Plain-text user message to inject into the session. */
  userMessage: string;
  /** Hard cap on wall time the event loop is willing to wait. */
  timeoutMs?: number;
}

export interface SendAndStreamResult {
  /** Combined text the agent emitted across all `*.text*` events. */
  assistantText: string;
  /**
   * EMAIL_SEND markers extracted from the assistant text — each
   * becomes one outbound AgentMail call.
   */
  emailSendMarkers: EmailSendMarker[];
  /** Last terminal event type observed (`session.completed`/`failed`). */
  terminalEventType?: string;
}

const DEFAULT_STREAM_TIMEOUT_MS = 120_000;

/**
 * Inject `userMessage` into the session, drain the event stream
 * until a terminal event or timeout, and return the assistant text
 * plus any EMAIL_SEND markers parsed from it.
 *
 * Stream contract (SDK `events.stream`):
 *   - SDK exposes an async iterator over server-sent events
 *   - relevant event types: `*.text_delta`, `*.text`, `*.message`,
 *     `session.completed`, `session.failed`
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
  await client.beta.sessions.events.send(input.sessionId, {
    events: [
      {
        type: 'user.message',
        content: [
          { type: 'text', text: input.userMessage },
        ],
      },
    ],
    betas: [ANTHROPIC_BETA],
  } as Parameters<typeof client.beta.sessions.events.send>[1]);

  // Now drain. We type the iterator loosely because the SDK's event
  // union covers many shapes the bridge does not need to model
  // exhaustively — narrow to text-bearing variants by duck-typing.
  const stream = await client.beta.sessions.events.stream(input.sessionId, {
    betas: [ANTHROPIC_BETA],
  } as Parameters<typeof client.beta.sessions.events.stream>[1]);

  let assistantText = '';
  let terminalEventType: string | undefined;

  const drain = (async () => {
    for await (const ev of stream as unknown as AsyncIterable<Record<string, unknown>>) {
      const evType = typeof ev.type === 'string' ? ev.type : '';
      // Accumulate any string-typed `text` or `delta` field. SDK
      // gives us `*.text_delta` per token and `*.text` for the final
      // assembled block — accept either.
      const text = pickString(ev, 'text') ?? pickString(ev, 'delta');
      if (text) assistantText += text;

      if (evType === 'session.completed' || evType === 'session.failed') {
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
  };
}

function pickString(ev: Record<string, unknown>, key: string): string | undefined {
  const v = ev[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
