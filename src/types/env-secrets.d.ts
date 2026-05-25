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
  }
}
