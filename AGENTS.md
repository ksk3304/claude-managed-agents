# Claude Managed Agents

For all design and implementation work on Claude Managed Agents, refer to Anthropic's official documentation first.

# MAKOTO Prime Cloudflare Runtime

For MAKOTOくん Cloudflare-version work, Google Chat is the frontend. This repository is the Cloudflare Worker runtime and deploy target.

- Use `npm run deploy` for the full deploy path (build, `wrangler deploy`, remote D1 migrations).
- Use `npx wrangler deploy` only when you intentionally want the Worker deploy step without the package scripts.
- Do not use MAKOTO Prime Cloud Run deploy scripts for this runtime. Cloud Run docs in `../makoto-prime/products/makoto-kun/` describe the existing Cloud Run path, not this Worker deploy path.
- Before runtime/debug fixes, collect the four observability points named in `../makoto-prime/AGENTS.md`: Cloudflare D1 session bind, Cloudflare payload audit, Cloudflare D1 runtime events, and CMA `sessions.events`.

# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command | Purpose |
|---------|---------|
| `npx wrangler dev` | Local development |
| `npx wrangler deploy` | Deploy to Cloudflare |
| `npx wrangler types` | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

## Production Change Safety

For production Cloudflare Worker changes, use the same safety pattern a real
production team would use:

- Start from the current deployed/recovery base in a dedicated clean worktree and branch. Do not deploy from an old dirty branch or a branch that contains unrelated issue commits.
- Before editing, classify the touched path as isolated or hot path. Treat Google Chat, AgentMail, scheduled jobs, queues, D1/KV access, tool dispatch, and `src/queue/chat-event-handler.ts` as hot paths.
- For hot path behavior changes, prefer a feature flag or kill switch with the current production behavior as the default. If a flag is not practical, state why and get explicit approval before deploy.
- Preserve neighboring behavior with regression tests. A chat handler change must cover normal reply, `EMAIL_SEND`, `CHAT_POST`, schedule action, unknown sender/default fallback, and any touched queue/cron path.
- Separate code deploy from state changes. Do not combine Worker code deploy with D1 migrations, KV writes/deletes, secrets changes, binding changes, or rollback unless each state change is listed and approved separately.
- Before deploy, show `git log <base>..HEAD`, changed files, test results, deploy command, expected side effects, and rollback target/version.
- After deploy, read back the active Worker version and relevant logs/events. Do not claim "no side effects" until production readback or smoke coverage supports it; say what remains unverified.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/workers-ai/` · `/agents/` · `/sandbox/` · `/containers/`
