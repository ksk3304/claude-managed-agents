// Optional secrets / vars not included in the Wrangler-generated types.
// `wrangler types` emits everything declared under `vars` / `kv_namespaces`
// / `d1_databases` / etc., but secrets pushed via `wrangler secret put`
// and optional fall-throughs (e.g. R2 access keys, Browser Rendering REST
// credentials) only show up here.
//
// Keep this list in sync with .dev.vars.example and the README so the
// type system catches typos at compile time instead of at runtime.
//
// NB: do NOT add top-level `import` / `export` statements here — this
// file is consumed as an ambient declaration (no module). Use
// `import(...)` type expressions inline when referring to types from
// runtime modules (see `MAKOTO_QUEUE` / `MAKOTO_THREAD_LOCK` below).

declare namespace Cloudflare {
  interface Env {
    // Anthropic — required secret (also declared in package.json `bindings`).
    WEBHOOK_SECRET: string;

    // Override the Anthropic API host. Defaults to https://api.anthropic.com
    // when unset; see `resolveAnthropicBaseURL` in src/anthropic.ts.
    ANTHROPIC_BASE_URL?: string;

    // Browser Rendering REST credentials. Either both are present (REST
    // path, faster, supports /markdown natively) or both are absent and
    // we fall back to the BROWSER binding via @cloudflare/puppeteer.
    CLOUDFLARE_API_TOKEN?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;

    // R2 access keys for the BACKUP_BUCKET snapshot path. In production
    // the Sandbox SDK uses these to presign URLs. In dev the same
    // BACKUP_BUCKET R2 binding works without them (localBucket: true).
    // We accept either the R2_ or AWS_ prefix — both are valid Sandbox
    // SDK conventions.
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
    AWS_ACCESS_KEY_ID?: string;
    AWS_SECRET_ACCESS_KEY?: string;
    // Name of the bucket the SDK should target when minting presigned
    // URLs. Matches `r2_buckets[].bucket_name` in wrangler.jsonc.
    BACKUP_BUCKET_NAME?: string;

    // Fallback inbox for stray (non-session) email arriving on the
    // catch-all route. When unset, unroutable mail is dropped after
    // logging.
    EMAIL_FORWARD?: string;

    // ------------------------------------------------------------------
    // AgentMail bridge (Issue #186)
    //
    // Secrets are pushed via `wrangler secret put` (so they don't appear
    // in the wrangler-generated types); KV / Queue / DO bindings live in
    // `wrangler.jsonc` and are declared here for the layer-5 commit so
    // TypeScript can compile the handler before the bindings have been
    // attached. Once attached, `wrangler types` will regenerate
    // `worker-configuration.d.ts` with matching declarations and these
    // overrides merge via declaration merging.
    // ------------------------------------------------------------------

    /** Primary svix signing secret for AgentMail inbound webhooks. */
    WEBHOOK_SECRET_AGENTMAIL_PRIMARY?: string;
    /** Secondary (rotation) svix signing secret. */
    WEBHOOK_SECRET_AGENTMAIL_SECONDARY?: string;
    /** API key for outbound AgentMail REST (send / reply). */
    AGENTMAIL_API_KEY?: string;
    /** Override for AgentMail REST base URL (production default lives in code). */
    AGENTMAIL_API_BASE_URL?: string;
    /**
     * AES-GCM-256 key (base64) for the envelope-encrypted OAuth refresh
     * tokens stored in `MAKOTO_KV` under `vault:oauth:<user_slug>:*`.
     * AAD = user_slug (cross-user decrypt fails closed).
     */
    OAUTH_VAULT_KEY?: string;
    /** Google OAuth client id for `oauth2.googleapis.com/token` refreshes. */
    OAUTH_CLIENT_ID?: string;
    /** Google OAuth client secret. */
    OAUTH_CLIENT_SECRET?: string;
    /**
     * Stable identifier for this Worker instance, used to disambiguate
     * `claim_owner` values across deployments / regions. Optional —
     * `newClaimOwner('')` falls back to a UUID-only owner.
     */
    WORKER_INSTANCE_ID?: string;

    /** Incident/debug-only payload audit switch. Normal operation leaves this unset/off. */
    CMA_AUDIT_USER_MESSAGE_PAYLOADS?: string;
    /** Reactive Chat session watchdog override in seconds. Unset = 600. */
    CMA_REACTIVE_SESSION_WATCHDOG_SEC?: string;
    /** Secret-gated debug endpoint token. Unset means debug endpoints return 404. */
    MAKOTO_DEBUG_TOKEN?: string;

    /**
     * Optional default user_slug for the Chat reactive path. When set,
     * `chat-event-handler.ts` step 5 falls back to
     * `user_mapping:<DEFAULT_USER_SLUG>` if the sender email has no
     * dedicated mapping (TS port of `cma_session_resolver.py`'s
     * `default` entry, Issue #186 follow-up #8). Unset → original
     * `unknown_sender` skip is preserved.
     *
     * NB: chat-path only. Mail-path keeps fail-close semantics
     * (`memory-attach.ts:resolveSenderToResources` comment).
     */
    DEFAULT_USER_SLUG?: string;

    /**
     * KV namespace for the MAKOTO bridge: sender→user_slug→agent_id
     * mapping (`user_mapping:<email>`), per-user OAuth vault entries
     * (`vault:oauth:<user_slug>:*`), and other bridge-side caches.
     */
    MAKOTO_KV: KVNamespace;

    /**
     * Cloudflare Queue carrying verified AgentMail webhook deliveries
     * from the webhook handler to the long-running consumer.
     */
    MAKOTO_QUEUE: Queue<
      import("./webhooks/agentmail").AgentMailQueueMessage
    >;

    /**
     * Per-RFC-822-message exclusion Durable Object. One instance per
     * `eventKeyForRfc822(rfc822_msgid)` via `idFromName`.
     */
    MAKOTO_THREAD_LOCK: DurableObjectNamespace<
      import("./durable-objects/thread-lock").ThreadLock
    >;
  }
}
