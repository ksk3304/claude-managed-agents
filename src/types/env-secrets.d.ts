// Secret-shaped Env fields that `wrangler types` cannot infer from
// `wrangler.jsonc` (because they're provisioned via `wrangler secret put`
// or `.dev.vars`, not declared as `vars`). Declaration-merge them into
// the auto-generated `Cloudflare.Env` so the bridge code can reference
// `env.ANTHROPIC_API_KEY` etc. without `any` casts.
//
// Provisioning:
//   - production: `wrangler secret put <NAME>` (per environment)
//   - local dev: `.dev.vars` (already in .gitignore)
//
// Keep this list in sync with what the source actually reads. New
// secrets must be added here AND set via `wrangler secret put` before
// the next deploy.

declare namespace Cloudflare {
  interface Env {
    ANTHROPIC_API_KEY: string;
    ANTHROPIC_BASE_URL?: string;
    ENVIRONMENT_ID: string;
    OAUTH_VAULT_KEY: string;
    /**
     * Anthropic model name used by the daily-report cron summarizer.
     * Defaults to `claude-haiku-4-5` when unset.
     */
    DAILY_REPORT_MODEL?: string;
    /**
     * Optional override for the daily-report target date (`YYYY-MM-DD`).
     * When unset the runner computes "yesterday in JST" from the cron tick.
     */
    DAILY_REPORT_DATE?: string;
    /**
     * `"1"` = dry-run mode (do not write the `/<date>.md` memory back).
     */
    DAILY_REPORT_DRY_RUN?: string;
    /**
     * Google Chat Service Account JSON. Same SA the Cloud Run runtime
     * uses for `chat.bot` scope. Provisioned via `wrangler secret put
     * CHAT_SA_KEY_JSON` once per environment.
     *
     * Used by `src/lib/chat-api.ts:postChatMessage` and inbound
     * notification senders (#186 #2 + #4).
     */
    CHAT_SA_KEY_JSON?: string;
    /**
     * Resource name of the Chat space the AgentMail inbound notifier
     * posts to (`spaces/...`). Used by #186 #2 (cold inbound 📨) and
     * #4 (continuation 📤). Leave unset to silence inbound
     * notifications without redeploying.
     */
    MAKOTO_NOTIFY_SPACE?: string;
    /**
     * Initial Chat User OAuth refresh_token (for `chat.messages.readonly`
     * scope, #186 #7). Copied into the KV vault on first use; subsequent
     * Google rotations are persisted to KV. Provisioned via
     * `wrangler secret put GCHAT_OAUTH_REFRESH_TOKEN_SEED`.
     */
    GCHAT_OAUTH_REFRESH_TOKEN_SEED?: string;
    /** Chat User OAuth client_id (Cloud Run side equivalent of `gchat-oauth-token-cma`). */
    GCHAT_OAUTH_CLIENT_ID?: string;
    /** Chat User OAuth client_secret. */
    GCHAT_OAUTH_CLIENT_SECRET?: string;
  }
}
