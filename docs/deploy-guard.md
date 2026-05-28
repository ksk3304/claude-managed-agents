# Production deploy guard

## Purpose

Git worktrees isolate local branches and files. They do not isolate the
Cloudflare Worker production target. Every `wrangler deploy` for this repo can
update the same Worker:

```text
claude-managed-agents-control-plane
```

`npm run deploy` therefore runs `scripts/deploy-guard.mjs` before build or
Wrangler deployment. The guard fails closed when it cannot prove the worktree is
fresh enough or when known required fix markers are missing.

## What It Reports

The guard prints:

- Worker name from `wrangler.jsonc`
- package name and version from `package.json`
- current worktree path
- current branch and HEAD commit
- upstream ref and commit
- clean/dirty working tree count
- required marker checks

Dirty working trees are reported but not blocked, because the existing prebuild
flow can patch `wrangler.jsonc` with account-local resource IDs.

## Blocking Rules

Production deploy is blocked when:

- the guard cannot refresh or resolve the upstream ref
- `HEAD` does not contain the upstream ref, usually `origin/main`
- required markers are absent

Current required markers:

- `pdf_preflight_result`
- `pendingPdfPreflightApprovalKey`

These Issue #214 PDF preflight markers stay required until the fix is merged
into every branch that may deploy production.

## Normal Deploy

```sh
npm run deploy
```

Do not call `wrangler deploy` directly for production. Direct Wrangler deploys
bypass this guard and can overwrite production from a stale worktree.

## Dry Run

For local guard-only checks:

```sh
npm run predeploy -- --no-fetch
```

`--no-fetch` skips network refresh and uses local refs only. Do not use it as a
production deploy substitute.
