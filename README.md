# Claude Managed Agents on Cloudflare

Run Claude Managed Agents (CMA) on Cloudflare.

This repo provides a customizable control plane that allows you to:
- Run CMA sandboxes on both full containers and light-weight isolates
- Customize the container size and image your agents use
- Get better observability into agent sandboxes
- Apply custom egress controls for [zero-trust credential injection](https://blog.cloudflare.com/sandbox-auth/) and connectivity to private services over [Workers VPC](https://developers.cloudflare.com/workers-vpc/)
- Extend your Agents with [Browser Run](https://developers.cloudflare.com/browser-run), [Email](https://developers.cloudflare.com/email-service/), and any other custom tools using the [Cloudflare Developer Platform](https://workers.cloudflare.com/products#all)
 your needs.

Follow the [Onboarding Guide](#onboarding-guide) to get started.

> **You need a Paid or Enterprise Cloudflare account to run Managed Agents.**
> [Cloudflare Containers](https://developers.cloudflare.com/containers/)
> (used by the MicroVM sandbox) and Worker Loader bindings (used by the
> Isolate sandbox's code-execution and egress proxy tools) are **Workers
> Paid plan and above**.

## Overview

This repository deploys a Workers-based control plane for running Claude Managed Agents on Cloudflare.

Claude Managed Agents will send a webhook to your Worker when an agent session begin or ends. The
control plan spins up a sandbox for each session, syncs state across session sleeps, and shuts down
the sandbox when the session ends. Sandboxes can be [Cloudflare Containers](https://developers.cloudflare.com/containers/) or [Isolate](https://developers.cloudflare.com/dynamic-workers/) sandboxes.

The control plane includes egress control for securing your agent's runtime. You can configure policies to
restrict access to specific domains, inject credentials in outgoing requests without the agent ever
seeing the credentials, or write arbitrary proxy code to modify, reroute, or log egress traffic.

Additionally, you can connect [Workers VPC](https://developers.cloudflare.com/workers-vpc/) and [Mesh](https://developers.cloudflare.com/workers-vpc/examples/connect-to-cloudflare-mesh/) resources to your sandboxes. This allows you
to easily access private resources, on any cloud or on-prem, without them ever being exposed to the public internet.

Lastly, this codebase can be easily extended to add custom tools to your agent's sandbox. Tools are picked up
automatically by both backends' Durable Object dispatchers and run with direct access to Worker bindings.
They can take advantage of all of Cloudflare Developer Platform.

The repo provides built-in tools for:
- Email Sending
- Private Service Access
- Browser Automation
- Image Generation

All of this is accessible via UI and API that is deployed to your Cloudflare account.

## Onboarding guide

Note: order matters — several steps depends on the previous ones.

**1. Create an Anthropic environment.** Create a "Self-managed" environment in 
the [Claude Platform Console](https://platform.claude.com/workspaces/default/environments).
Copy the environment secret key after you create it.

You will need the following values:

- `ENVIRONMENT_ID` — the ID of your new self-managed environment
- `ANTHROPIC_ENVIRONMENT_KEY` — environment secret key used by the control plane to
  authenticate calls from the specified Claude agent environment
- `ANTHROPIC_API_KEY` — used by the Worker to make calls to Anthropic

After you deploy your Worker, you will need to come back to the Claude Platform Console
to create a webhook that points to your Worker, and get a Webhook signing secret.

- `WEBHOOK_SECRET` — Standard Webhooks signing secret. Anthropic posts
  events to your Worker; we verify the signature before doing anything
  with them.

**2. Set the secrets.**

Locally:

```sh
cp .dev.vars.example .dev.vars
# fill in the values above
```

In production:

```sh
npx wrangler secret put ANTHROPIC_ENVIRONMENT_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ENVIRONMENT_ID
# note that we will set WEBHOOK_SECRET later
```

**3. Provision the D1 database and KV namespaces.**

For production, apply the migrations remotely:

```sh
npm run db:migrate:remote   # production
```

For local dev, run locally:

```sh
npm run db:migrate          # local
```

**4. Provision the R2 snapshot bucket.**

This is required unless you're exclusively using Isolate sandboxes
or running stateless agent sessions. Isolate sessions
persist through Durable Object SQLite storage and don't need R2 — if
you're certain you'll never run a MicroVM agent, you can skip this
step (and drop the `r2_buckets` block from `wrangler.jsonc`).

Anyone running the MicroVM backend should treat this as core onboarding.

```sh
# Create the bucket — name must match `bucket_name` in wrangler.jsonc
npx wrangler r2 bucket create claude-managed-agents-snapshots
```

Then [mint an R2 access key](https://dash.cloudflare.com/r2/api-tokens/create?type=user)
with read+write on this bucket (Cloudflare dashboard → R2 → Manage R2 API Tokens → Create token),
copy the Access Key ID and Secret Access Key, then push the following secrets:

```sh
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put BACKUP_BUCKET_NAME # same as bucket_name above (IE: claude-managed-agents-snapshots)
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID # found in your dashboard URL
```

These secrets back the presigned-URL path used in production.

See [Snapshots & state persistence](./docs/snapshots-and-state-persistence.md)
for more information.

**5. Initial Deploy.**

```sh
npm run deploy
```

This will give you a URL to set as the webhook in the next step.

**6. Set up Webhooks**

In the [Anthropic Console](https://platform.claude.com/settings/workspaces/default/webhooks),
set the webhook URL to `https://<YOUR-WORKER>.workers.dev/webhooks`.

Save the Webhook Secret that is generated as part of this step, and set it as an environment variable:

```sh
npx wrangler secret put WEBHOOK_SECRET
```

**7. (Optional) Turn on the extras.** Each is opt-in; skip what you don't need.

| Capability | Bindings to add | Secrets to add | Setup steps |
|---|---|---|---|
| Browser Rendering tools | uncomment `browser` in `wrangler.jsonc` | `CLOUDFLARE_API_TOKEN` (for REST tools) | none |
| Workers AI image gen | uncomment `ai` in `wrangler.jsonc` | none | None |
| Email send + inbox | uncomment `send_email` in `wrangler.jsonc`; set `EMAIL_DOMAIN` + `EMAIL_FROM` (Deploy to Cloudflare prompts for these, or `vars` in `wrangler.jsonc` locally) | none | [Email docs](./docs/agent-email.md) |
| VPC private services | add `vpc_services` blocks in `wrangler.jsonc` | none | [Workers VPC docs](./docs/connecting-to-private-services.md) |

**8. Visit the dashboard.** `https://<your-worker>.workers.dev/`. Create an
agent (the form lets you pick MicroVM or Isolate backend), kick off a
session, watch the logs.

**9. Secure the Dashboard** Once you have set things up,
you will want to secure the dashboard by setting up Cloudflare Access.

See [Cloudflare Access docs](./docs/securing-access.md) for more information.

**10. Customize the control plane (optional)** Fork this repo
and customize it to suit your needs or add custom tools.

## Going deeper

Once the control plane is up and a first session has gone end-to-end, the
[`docs/`](./docs) pages cover the rest:

- [Architecture](./docs/architecture.md) walks the request lifecycle
  from webhook ingress through dispatch to either sandbox backend, and
  inventories every Worker binding the control plane uses.
- [Isolate vs VM-based Sandboxes](./docs/isolate-vs-vm-sandboxes.md)
  compares the two backends side-by-side and explains how to pick one
  per agent. Both share the same egress + VPC pipeline.
- [Customizing Sandboxes](./docs/customizing-sandboxes.md) covers the
  `Dockerfile` and `instance_type` knobs for the MicroVM backend.
- [Adding Custom Tools](./docs/adding-custom-tools.md) walks through
  extending the agent with your own tools. New tools go in a single
  file — [`src/tools/custom-tools.ts`](./src/tools/custom-tools.ts) — and are
  picked up automatically by both sandbox backends, the Anthropic
  agent payload, and the dashboard's toggle list.
- [Browser Rendering Tools](./docs/browser-rendering-tools.md)
  covers the `cf_*` browser family — `cf_web_fetch`, `cf_screenshot`,
  CDP control — and explains why you should prefer them over the
  built-in `web_fetch`.
- [Agent Email](./docs/agent-email.md) shows how to give each
  session its own inbox and let the agent send and read mail through
  Email Routing.
- [Snapshots & state persistence](./docs/snapshots-and-state-persistence.md)
  explains how MicroVM sessions back `/workspace` up to R2 on
  hibernation and restore it on the next dispatch. Isolate sessions
  use DO storage and are handled transparently.
- [Applying Egress Policies](./docs/applying-egress-policies.md)
  documents the allow/deny, header-injection, Dynamic Worker proxy,
  and VPC routing rule types, plus the matcher format that scopes a
  policy to specific sessions or agents.
- [Connecting to Private Services](./docs/connecting-to-private-services.md)
  walks through Workers VPC bindings and the two ways an agent can
  reach a private service, plus a tested laptop-tunnel walkthrough.
- [Securing Access](./docs/securing-access.md) covers Cloudflare Access
  in front of the dashboard, the paths to bypass, and what's already
  authenticated server-side.

## Configuration reference

Required secrets:

| Name | Description |
|---|---|
| `ANTHROPIC_ENVIRONMENT_KEY` | Anthropic environment key (sk-ant-oat01-...). The single credential the control plane uses for poll, ack, heartbeat, force-stop, and the session event stream. Renamed from `ANTHROPIC_ENV_KEY` in the 0.96 SDK / ant 1.8 CLI. |
| `ANTHROPIC_API_KEY` | Anthropic API key (`sk-ant-...`) |
| `WEBHOOK_SECRET` | HMAC secret for verifying webhook signatures |
| `CLOUDFLARE_ACCOUNT_ID` | R2 snapshots (presigned URL mode); also used by Browser Rendering REST tools |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 snapshots (presigned URL mode) |
| `BACKUP_BUCKET_NAME` | R2 snapshots (presigned URL mode) |

The four snapshot secrets are required for production deploys that run
MicroVM sandboxes. `wrangler dev` can run without them by falling back
to the BACKUP_BUCKET binding directly, but the R2 bucket itself must
exist — see Step 4 above. Deployments that exclusively use Isolate
sandboxes can drop the snapshot secrets and the `r2_buckets` block
entirely.

Required vars (`wrangler.jsonc`):

| Name | Description |
|---|---|
| `ENVIRONMENT_ID` | Environment to poll for work |

Optional secrets:

| Name | Used for |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Browser Rendering REST tools |
| `ANTHROPIC_BASE_URL` | Override (defaults to `https://api.anthropic.com`) |

Optional vars:

| Name | Used for |
|---|---|
| `EMAIL_DOMAIN` | Suffix for per-session inbox addresses |
| `EMAIL_FROM` | Default sender for `cf_email_send` |
| `EMAIL_FORWARD` | Fallback inbox for stray (non-session) email |

Optional bindings (declare in `wrangler.jsonc`):

| Binding | Used for |
|---|---|
| `BROWSER` | Isolate CDP browser tools |
| `AI` | `cf_image_generate` |
| `BACKUP_BUCKET` | Sandbox snapshots |
| `SEND_EMAIL` | `cf_email_send` |
| `vpc_services[]` | Private VPC service routing + `cf_call_service` |

## Tests

```sh
npm test
```

Vitest covers the egress proxy, storage layer, and API surface. VPC and
Mesh test stubs are included but commented out — see the `describe.skip(...)`
blocks at the bottom of `tests/egress.test.ts` for the planned shape.

## License

[MIT](./LICENSE)
