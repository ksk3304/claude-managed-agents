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
  }
}
