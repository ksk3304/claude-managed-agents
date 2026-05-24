/**
 * AgentMail webhook + REST types — TS port of relevant pieces of
 * `scripts/cma_agentmail_inbound.py` and `scripts/cma_lib.py`.
 *
 * AgentMail signs inbound webhooks with the svix protocol
 * (`svix-id` / `svix-timestamp` / `svix-signature` headers; HMAC-SHA256
 * over `${id}.${timestamp}.${rawBody}`). The payload itself follows the
 * Standard Webhooks JSON envelope: `{ id, type, timestamp, data }`.
 *
 * The shapes here are the minimum set the bridge layer needs to route
 * inbound mail back to the correct session. Fields the bridge does not
 * read are intentionally omitted; webhook handler code should treat the
 * raw body as `Record<string, unknown>` first and narrow into these
 * types after svix verification.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 2 — 層 0 要石 B)
 * Source-of-truth references:
 *   - `scripts/cma_agentmail_inbound.py:777-813` (extract_body /
 *      extract_thread_refs / re_chain_depth)
 *   - `scripts/cma_agentmail_inbound.py:2165-2201` (verify_webhook)
 *   - `scripts/cma_agentmail_inbound.py:876-878` (outbound dedupe sets)
 */

// ----------------------------------------------------------------------------
// svix transport
// ----------------------------------------------------------------------------

/**
 * Headers the svix client puts on every inbound webhook. The bridge
 * verifies all three before parsing the body.
 *
 * Note: Cloudflare's official `verifyStandardWebhook` reads
 * `webhook-id` / `webhook-timestamp` / `webhook-signature` (Standard
 * Webhooks naming). AgentMail / svix use `svix-*` names. We re-implement
 * the verifier (`src/webhooks/agentmail.ts`) rather than reuse the
 * Standard Webhooks one — same HMAC, different header names.
 */
export interface SvixHeaders {
  'svix-id': string;
  'svix-timestamp': string;
  /**
   * Space-separated list of `v1,<base64-hmac>` entries (svix supports
   * multiple active secrets during rotation).
   */
  'svix-signature': string;
}

/**
 * The Standard-Webhooks JSON envelope sent by AgentMail.
 */
export interface AgentMailWebhookEvent<T = unknown> {
  /** svix event id — matches the `svix-id` header. */
  id: string;
  /** e.g. `message.received`. Extend the union as new events ship. */
  type: AgentMailEventType;
  /** ISO 8601 timestamp the event was emitted. */
  timestamp: string;
  data: T;
}

/**
 * Event types AgentMail emits. Source: live observation of incoming
 * traffic (see `scripts/cma_agentmail_inbound.py` `webhook_event_type`
 * branching). Confirm against `https://docs.agentmail.to/` at Phase 6
 * implementation time — placeholder set wide enough to start with.
 */
export type AgentMailEventType =
  | 'message.received'
  | 'message.sent'
  | 'message.delivered'
  | 'message.bounced'
  | string;

// ----------------------------------------------------------------------------
// AgentMail message shape (subset the bridge consumes)
// ----------------------------------------------------------------------------

/**
 * One AgentMail message as returned by webhook payloads and REST
 * `get_message`. Field names mirror the live Python consumer; optional
 * fields reflect what `cma_agentmail_inbound.py` defensively handles.
 *
 * Two id spaces exist and the bridge **must keep them separate**:
 *   - `id`: AgentMail's opaque message id (used for REST lookups)
 *   - `rfc822_message_id`: the actual RFC 822 `Message-ID:` header,
 *     used for In-Reply-To / References thread matching. The Python
 *     `outbound_rfc822_set` (SignalA) tracks this; `outbound_set`
 *     (Tertiary) tracks the opaque id.
 */
export interface AgentMailMessage {
  /** AgentMail-opaque message id. */
  id: string;
  /**
   * Normalized RFC 822 Message-ID (angle brackets stripped). May be
   * absent on very old outbound rows (backwards-compat per
   * `cma_agentmail_inbound.py:13-17`).
   */
  rfc822_message_id?: string;

  // ---- addresses ----
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string[];

  // ---- subject + body ----
  subject?: string;
  /** Preferred plain-text body (fallback order: extracted_text → text). */
  extracted_text?: string;
  text?: string;
  /** HTML body fallback (fallback order: extracted_html → html). */
  extracted_html?: string;
  html?: string;

  // ---- thread refs ----
  /** RFC 822 `In-Reply-To` (raw value, may include angle brackets). */
  in_reply_to?: string;
  /**
   * RFC 822 `References` — AgentMail sometimes serializes this as a
   * single space-delimited string and sometimes as an array. The Python
   * helper `extract_thread_refs` normalizes both forms; do the same in TS.
   */
  references?: string[] | string;

  /** ISO 8601 receive timestamp. */
  received_at?: string;

  /** Original headers map (case-insensitive in practice). */
  headers?: Record<string, string | string[]>;

  /** Arbitrary fields not covered above — keep raw for forward-compat. */
  [extra: string]: unknown;
}

/**
 * Shorthand: `message.received` webhook payload.
 */
export type AgentMailMessageReceivedEvent = AgentMailWebhookEvent<{
  message: AgentMailMessage;
  /** AgentMail inbox the message was routed to. */
  inbox_id?: string;
}>;

// ----------------------------------------------------------------------------
// EMAIL_SEND marker (agent → bridge contract)
// ----------------------------------------------------------------------------

/**
 * Parsed `EMAIL_SEND` marker the agent writes inside its model output.
 * The bridge extracts these (per parent #177 §設計判断 7) and turns each
 * one into an AgentMail `send_message` / `reply_message` REST call.
 *
 * Field surface mirrors `scripts/cma_lib.py:_handle_email_send_marker`
 * (line ~3776) plus continuation thread heads (`in_reply_to_message_id`).
 */
export interface EmailSendMarker {
  /**
   * Single recipient email address. The Python parser at
   * `cma_gchat_bot.py:_handle_email_send_marker` (Round 3 O3) enforces
   * single-string `to` and rejects arrays — the bridge follows that
   * contract so on-the-wire behaviour is identical.
   */
  to: string;
  /** Already-normalized to string[]; the JSON may carry string or list. */
  cc?: string[];
  /** Already-normalized to string[]; the JSON may carry string or list. */
  bcc?: string[];
  subject: string;
  /** Plain-text body. The bridge does not synthesize HTML. */
  body: string;
  /**
   * If set, this send is a reply — the bridge issues
   * `reply_message(parent=in_reply_to_message_id, …)` instead of a
   * fresh `send_message`. Value is the AgentMail-opaque parent id.
   */
  in_reply_to_message_id?: string;
  attachments?: EmailSendAttachment[];
}

/**
 * Inline-encoded attachment on an EMAIL_SEND marker.
 * `content_base64` is `btoa(binary)` — Cloudflare Workers expose
 * `atob` / `btoa` natively.
 */
export interface EmailSendAttachment {
  filename: string;
  mime_type: string;
  content_base64: string;
}
