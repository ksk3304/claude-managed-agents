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

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/workers-ai/` · `/agents/` · `/sandbox/` · `/containers/`
