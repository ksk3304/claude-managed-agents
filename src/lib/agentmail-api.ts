/**
 * AgentMail REST client — TS port of the outbound side of
 * `scripts/cma_lib.py:send_mail` / `_send_agentmail` and the inbound
 * fetch helpers (`get_message`, `list_messages`,
 * `fetch_sent_rfc822_msgid`). Uses native `fetch` — no AgentMail SDK
 * dependency (parent #177 §設計判断 13 — outbound HTTPS direct call).
 *
 * The bridge calls AgentMail in three places:
 *   1. After parsing an EMAIL_SEND marker, to actually deliver the
 *      reply or new message.
 *   2. From the webhook path, to fetch the full message body when the
 *      webhook delivers only a pointer (some AgentMail events do this).
 *   3. From the cron / list path, to reconcile state if a webhook is
 *      lost (not in scope for #186, kept here as a future hook).
 *
 * TODO(phase6-layer5): confirm endpoint URLs and payload shapes
 * against https://docs.agentmail.to/ at webhook handler implementation
 * time. The URL prefix is overrideable via the `agentMailBaseUrl`
 * client option so we don't have to ship a release to update it.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 4 — 層 2)
 * Spec: plan-draft.md §3 AgentMail REST + A26
 */

import type {
  AgentMailMessage,
  EmailSendAttachment,
} from '../types/agentmail';
import { assertBridgeEgressAllowed } from './egress-guard';

const DEFAULT_BASE_URL = 'https://api.agentmail.to/v0';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;

/**
 * Lightweight error wrapper. `status` is the HTTP status (or 0 for
 * network errors); `transient` is true for 408 / 425 / 429 / 5xx — the
 * client retries those automatically.
 */
export class AgentMailError extends Error {
  readonly status: number;
  readonly transient: boolean;
  readonly body: string | undefined;

  constructor(message: string, status: number, transient: boolean, body?: string) {
    super(message);
    this.name = 'AgentMailError';
    this.status = status;
    this.transient = transient;
    this.body = body;
  }
}

export interface AgentMailClientOptions {
  /** REST base URL. Defaults to `https://api.agentmail.to/v0`. */
  baseUrl?: string;
  /** Per-request timeout in ms. Defaults to 30 s. */
  timeoutMs?: number;
  /** Max retries for transient errors (5xx / 429). Defaults to 3. */
  maxRetries?: number;
  /** Override fetch (for tests / instrumentation). */
  fetchImpl?: typeof fetch;
}

export interface SendMessageInput {
  inboxId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Plain-text body. The bridge does not synthesize HTML. */
  body: string;
  /** Optional inline attachments. */
  attachments?: EmailSendAttachment[];
  /**
   * Echoed in our outbound `Message-ID:` header so we can match
   * counterparty replies. Caller is responsible for ensuring
   * uniqueness; the bridge derives it from session_id + nonce.
   */
  rfc822MessageId?: string;
}

export interface ReplyMessageInput extends SendMessageInput {
  /** AgentMail-opaque parent message id. */
  parentMessageId: string;
}

export interface SendMessageResult {
  /** AgentMail-opaque message id. Empty string if 2xx but no id returned. */
  message_id: string;
  /**
   * RFC 822 Message-ID AgentMail actually committed (may differ from
   * `rfc822MessageId` input if AgentMail rewrites it). Empty string
   * if unavailable in the response.
   */
  rfc822_message_id: string;
}

export interface AgentMailThread {
  thread_id?: string;
  messages?: AgentMailMessage[];
  [extra: string]: unknown;
}

export class AgentMailClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, options: AgentMailClientOptions = {}) {
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * `POST /inboxes/{inboxId}/messages/send` — fresh outbound message.
   * Returns the AgentMail message_id (opaque) and the RFC 822
   * Message-ID that ended up on the wire.
   */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const path = `/inboxes/${encodeURIComponent(input.inboxId)}/messages/send`;
    return this.postSend(path, input);
  }

  /**
   * `POST /inboxes/{inboxId}/messages/{parentMessageId}/reply` —
   * threaded reply. AgentMail handles References / In-Reply-To header
   * injection based on the parent.
   */
  async replyMessage(input: ReplyMessageInput): Promise<SendMessageResult> {
    const path = `/inboxes/${encodeURIComponent(input.inboxId)}/messages/${encodeURIComponent(
      input.parentMessageId,
    )}/reply`;
    return this.postReply(path, input.body);
  }

  /**
   * `GET /inboxes/{inboxId}/messages/{messageId}` — fetch one message.
   * Webhook handlers call this when the webhook payload omits body
   * fields (some AgentMail event types only carry pointers).
   */
  async getMessage(inboxId: string, messageId: string): Promise<AgentMailMessage> {
    const path = `/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`;
    const r = await this.request<AgentMailMessage>('GET', path);
    return r;
  }

  /**
   * `GET /inboxes/{inboxId}/threads/{threadId}` — fetch a thread and
   * its messages. Used as the safe fallback when message list results
   * carry `thread_id` but no directly retrievable message id.
   */
  async getThread(inboxId: string, threadId: string): Promise<AgentMailThread> {
    const path = `/inboxes/${encodeURIComponent(inboxId)}/threads/${encodeURIComponent(threadId)}`;
    return await this.request<AgentMailThread>('GET', path);
  }

  /**
   * `GET /inboxes/{inboxId}/messages?limit=…` — listing (paginated).
   * Not used on the hot inbound path; provided so cron / heartbeat
   * handlers can reconcile lost-webhook drift later. Spam is included
   * by default so polling-style readers do not silently miss replies
   * that AgentMail classified as spam.
   */
  async listMessages(
    inboxId: string,
    options: {
      limit?: number;
      pageToken?: string;
      labels?: string[];
      before?: string;
      after?: string;
      includeSpam?: boolean;
      includeBlocked?: boolean;
      includeUnauthenticated?: boolean;
    } = {},
  ): Promise<{ messages: AgentMailMessage[]; next_page_token?: string }> {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    if (options.pageToken) params.set('page_token', options.pageToken);
    for (const label of options.labels ?? []) {
      if (label) params.append('labels', label);
    }
    if (options.before) params.set('before', options.before);
    if (options.after) params.set('after', options.after);
    if (options.includeSpam ?? true) params.set('include_spam', 'true');
    if (options.includeBlocked) params.set('include_blocked', 'true');
    if (options.includeUnauthenticated) params.set('include_unauthenticated', 'true');
    const path = `/inboxes/${encodeURIComponent(inboxId)}/messages${
      params.toString() ? `?${params.toString()}` : ''
    }`;
    return this.request('GET', path);
  }

  // ----------------------------------------------------------------

  private async postSend(
    path: string,
    input: SendMessageInput,
  ): Promise<SendMessageResult> {
    const body: Record<string, unknown> = {
      to: input.to,
      subject: input.subject,
      text: input.body,
    };
    if (input.cc && input.cc.length > 0) body.cc = input.cc;
    if (input.bcc && input.bcc.length > 0) body.bcc = input.bcc;
    if (input.attachments && input.attachments.length > 0) {
      body.attachments = input.attachments;
    }
    if (input.rfc822MessageId) {
      // AgentMail accepts a custom outbound Message-ID via an
      // explicit field; if it doesn't, downstream code must fall back
      // to `fetch_sent_rfc822_msgid` (Python cma_lib.py:13-17).
      body.message_id = input.rfc822MessageId;
    }
    const r = await this.request<{
      message_id?: string;
      id?: string;
      rfc822_message_id?: string;
    }>('POST', path, body);
    return {
      message_id: r.message_id ?? r.id ?? '',
      rfc822_message_id: r.rfc822_message_id ?? '',
    };
  }

  private async postReply(path: string, text: string): Promise<SendMessageResult> {
    const r = await this.request<{
      message_id?: string;
      id?: string;
      rfc822_message_id?: string;
    }>('POST', path, { text });
    return {
      message_id: r.message_id ?? r.id ?? '',
      rfc822_message_id: r.rfc822_message_id ?? '',
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    // Egress hard-allowlist (層 8). Caught + re-thrown as-is — the
    // outer dispatcher logs and skips the marker if AgentMail's host
    // somehow drifts off the allowlist.
    assertBridgeEgressAllowed(url, 'agentmail-api:request');
    let attempt = 0;
    while (true) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const resp = await this.fetchImpl(url, {
          method,
          headers: {
            'authorization': `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            'accept': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await resp.text();
        if (resp.ok) {
          if (text.length === 0) return undefined as unknown as T;
          return JSON.parse(text) as T;
        }
        const transient = resp.status === 408 || resp.status === 425 || resp.status === 429 || resp.status >= 500;
        if (transient && attempt < this.maxRetries) {
          const backoffMs = Math.min(2_000 * attempt, 10_000);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        throw new AgentMailError(
          `AgentMail ${method} ${path} failed: ${resp.status}`,
          resp.status,
          transient,
          text.slice(0, 2048),
        );
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof AgentMailError) throw err;
        if (attempt < this.maxRetries) {
          const backoffMs = Math.min(2_000 * attempt, 10_000);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new AgentMailError(`AgentMail ${method} ${path} network error: ${message}`, 0, true);
      }
    }
  }
}
